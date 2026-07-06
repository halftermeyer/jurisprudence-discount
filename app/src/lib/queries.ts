import { runQuery, withGroup } from "./neo4j";

// ── Domain types ───────────────────────────────────────────────

export interface Customer {
  id: string;
  name: string;
  tier: "Standard" | "Gold" | "VIP";
}

export interface OrderRec {
  id: string;
  sku: string;
  product_name: string;
  amount: number;
  date: string;
}

export interface Incident {
  id: string;
  type: string;
  description: string;
  status: string;
  reported_at: string;
  resolution_type?: string | null;
  resolution_ref?: string | null;
  resolution_action?: string | null;
  resolution_discount_pct?: number | null;
  resolved_at?: string | null;
}

export interface Policy {
  id: string;
  name: string;
  incident_type: string;
  min_tier: string;
  max_recency_days: number | null;
  action: string;
  discount_pct: number | null;
  description: string;
  source?: string;
}

export interface Precedent {
  id: string;
  incident_type: string;
  min_tier: string;
  action: string;
  discount_pct: number;
  rationale: string;
  established_at: string;
}

export interface Human {
  id: string;
  name: string;
  role: string;
}

// Tier comparison — Standard < Gold < VIP (kept as one Cypher CASE expression
// so the whole policy/precedent match stays a single explainable WHERE clause)
const TIER_RANK = (expr: string) =>
  `CASE ${expr} WHEN 'Standard' THEN 1 WHEN 'Gold' THEN 2 WHEN 'VIP' THEN 3 END`;

const CUSTOMER_PROJ = `c {.id, .name, .tier}`;
const ORDER_PROJ = `o {.id, .sku, .product_name, .amount, date: toString(o.date)}`;
const INCIDENT_PROJ = `i {.id, .type, .description, .status,
  reported_at: toString(i.reported_at), .resolution_type, .resolution_ref,
  .resolution_action, .resolution_discount_pct,
  resolved_at: toString(i.resolved_at)}`;
const POLICY_PROJ = `p {.id, .name, .incident_type, .min_tier, .max_recency_days,
  .action, .discount_pct, .description, .source}`;
const PRECEDENT_PROJ = `pr {.id, .incident_type, .min_tier, .action, .discount_pct,
  .rationale, established_at: toString(pr.established_at)}`;

// ── Explore ────────────────────────────────────────────────────

export async function getCustomers(): Promise<
  (Customer & { orderCount: number; incidentCount: number; openCount: number })[]
> {
  return runQuery(`
    MATCH (c:Customer)
    OPTIONAL MATCH (c)-[:HAD]->(o:Order)
    OPTIONAL MATCH (o)-[:AFFECTED_BY]->(i:Incident)
    RETURN c.id AS id, c.name AS name, c.tier AS tier,
           count(DISTINCT o) AS orderCount,
           count(DISTINCT i) AS incidentCount,
           count(DISTINCT CASE WHEN i.status = 'open' THEN i END) AS openCount
    ORDER BY c.id
  `);
}

export interface JourneyEntry {
  order: OrderRec;
  incidents: Incident[];
}

export async function getCustomerJourney(customerId: string): Promise<JourneyEntry[]> {
  const rows = await runQuery<{ order: OrderRec; incident: Incident | null }>(
    `
    MATCH (c:Customer {id: $customerId})-[:HAD]->(o:Order)
    OPTIONAL MATCH (o)-[:AFFECTED_BY]->(i:Incident)
    RETURN ${ORDER_PROJ} AS order,
           CASE WHEN i IS NULL THEN null ELSE ${INCIDENT_PROJ} END AS incident
    ORDER BY o.date DESC
    `,
    { customerId }
  );
  const byOrder: Record<string, JourneyEntry> = {};
  const result: JourneyEntry[] = [];
  for (const r of rows) {
    if (!byOrder[r.order.id]) {
      byOrder[r.order.id] = { order: r.order, incidents: [] };
      result.push(byOrder[r.order.id]);
    }
    if (r.incident) byOrder[r.order.id].incidents.push(r.incident);
  }
  return result;
}

export async function getPolicies(): Promise<Policy[]> {
  return runQuery<{ policy: Policy }>(`
    MATCH (p:Policy)
    RETURN ${POLICY_PROJ} AS policy
    ORDER BY p.id
  `).then((rows) => rows.map((r) => r.policy));
}

export interface PrecedentRow {
  precedent: Precedent;
  established_by: Human;
  citedCount: number;
}

export async function getPrecedents(): Promise<PrecedentRow[]> {
  return runQuery(`
    MATCH (h:Human)-[:ESTABLISHES]->(pr:Precedent)
    OPTIONAL MATCH (pr)-[:CITED_BY]->(cs:Case)
    RETURN ${PRECEDENT_PROJ} AS precedent,
           h {.id, .name, .role} AS established_by,
           count(cs) AS citedCount
    ORDER BY precedent.established_at DESC
  `);
}

export async function getOpenIncidents(): Promise<
  { incident: Incident; customer: Customer; order: OrderRec }[]
> {
  return runQuery(`
    MATCH (c:Customer)-[:HAD]->(o:Order)-[:AFFECTED_BY]->(i:Incident {status: 'open'})
    RETURN ${INCIDENT_PROJ} AS incident, ${CUSTOMER_PROJ} AS customer, ${ORDER_PROJ} AS order
    ORDER BY i.reported_at DESC
  `);
}

export async function getHumans(): Promise<Human[]> {
  return runQuery(`
    MATCH (h:Human) RETURN h.id AS id, h.name AS name, h.role AS role ORDER BY h.id
  `);
}

// ── The decision flow ──────────────────────────────────────────

export interface MatchPolicyResult {
  customer: Customer;
  order: OrderRec;
  incident: Incident;
  candidates: Policy[];
  matched: Policy | null;
}

/** Step 1 — deterministic policy match: same incident_type, customer tier at
 *  or above the policy's min_tier, reported within the recency window. */
export async function matchPolicy(incidentId: string): Promise<MatchPolicyResult | null> {
  const rows = await runQuery<MatchPolicyResult>(
    `
    MATCH (c:Customer)-[:HAD]->(o:Order)-[:AFFECTED_BY]->(i:Incident {id: $incidentId})
    WITH c, o, i, ${TIER_RANK("c.tier")} AS tierRank
    OPTIONAL MATCH (p:Policy)
    WHERE p.incident_type = i.type
      AND ${TIER_RANK("p.min_tier")} <= tierRank
      AND (p.max_recency_days IS NULL
           OR i.reported_at >= date() - duration({days: p.max_recency_days}))
    WITH c, o, i, p
    ORDER BY ${TIER_RANK("p.min_tier")} DESC, p.discount_pct DESC
    WITH c, o, i, [pol IN collect(p) | pol {.id, .name, .incident_type, .min_tier,
         .max_recency_days, .action, .discount_pct, .description}] AS candidates
    RETURN ${CUSTOMER_PROJ} AS customer, ${ORDER_PROJ} AS order,
           ${INCIDENT_PROJ} AS incident, candidates,
           CASE WHEN size(candidates) > 0 THEN candidates[0] ELSE null END AS matched
    `,
    { incidentId }
  );
  return rows[0] ?? null;
}

async function resolveIncident(
  incidentId: string,
  resType: string,
  ref: string,
  action: string,
  pct: number | null
): Promise<Incident> {
  const rows = await runQuery<{ incident: Incident }>(
    `
    MATCH (i:Incident {id: $incidentId})
    SET i.status = 'resolved',
        i.resolution_type = $resType,
        i.resolution_ref = $ref,
        i.resolution_action = $action,
        i.resolution_discount_pct = $pct,
        i.resolved_at = date()
    RETURN ${INCIDENT_PROJ} AS incident
    `,
    { incidentId, resType, ref, action, pct }
  );
  return rows[0].incident;
}

/** Step 1b — a policy matched: auto-approve on the spot. */
export async function applyPolicy(incidentId: string, policy: Policy): Promise<Incident> {
  return resolveIncident(incidentId, "policy", policy.id, policy.action, policy.discount_pct);
}

/** Convenience: match + auto-approve in one grouped call (used by scenarios & chat). */
export async function matchAndApplyPolicy(incidentId: string): Promise<MatchPolicyResult | null> {
  return withGroup(`match_policy(${incidentId})`, async () => {
    const match = await matchPolicy(incidentId);
    if (match?.matched && match.incident.status === "open") {
      match.incident = await applyPolicy(incidentId, match.matched);
    }
    return match;
  });
}

export interface PrecedentCandidate {
  precedent: Precedent;
  established_by: Human;
  same_type: boolean;
  tier_ok: boolean;
  applicable: boolean;
}

export interface PrecedentSearch {
  incident: Incident;
  customer: Customer;
  applicable: PrecedentCandidate[];
  rejected: PrecedentCandidate[];
}

/** Step 2 — reusable jurisprudence: same incident_type, tier at or above the
 *  precedent's min_tier, ranked by recency. Returns rejected candidates too,
 *  so the UI can show "considered N precedents, none close enough". */
export async function findPrecedents(incidentId: string): Promise<PrecedentSearch | null> {
  return withGroup(`find_precedents(${incidentId})`, async () => {
    const ctx = await runQuery<{ incident: Incident; customer: Customer }>(
      `
      MATCH (c:Customer)-[:HAD]->(o:Order)-[:AFFECTED_BY]->(i:Incident {id: $incidentId})
      RETURN ${INCIDENT_PROJ} AS incident, ${CUSTOMER_PROJ} AS customer
      `,
      { incidentId }
    );
    if (!ctx[0]) return null;
    const rows = await runQuery<PrecedentCandidate>(
      `
      MATCH (c:Customer)-[:HAD]->(o:Order)-[:AFFECTED_BY]->(i:Incident {id: $incidentId})
      WITH c, i, ${TIER_RANK("c.tier")} AS tierRank
      MATCH (h:Human)-[:ESTABLISHES]->(pr:Precedent)
      WITH i, tierRank, h, pr,
           pr.incident_type = i.type AS same_type,
           ${TIER_RANK("pr.min_tier")} <= tierRank AS tier_ok
      RETURN ${PRECEDENT_PROJ} AS precedent,
             h {.id, .name, .role} AS established_by,
             same_type, tier_ok, (same_type AND tier_ok) AS applicable
      ORDER BY applicable DESC, pr.established_at DESC
      `,
      { incidentId }
    );
    return {
      incident: ctx[0].incident,
      customer: ctx[0].customer,
      applicable: rows.filter((r) => r.applicable),
      rejected: rows.filter((r) => !r.applicable),
    };
  });
}

export interface ApplyPrecedentResult {
  incident: Incident;
  caseId: string;
  precedent: Precedent;
  established_by: Human;
  statement: string;
}

/** Step 3 — resolve citing a precedent: opens a Case, writes CITED_BY. */
export async function applyPrecedent(
  incidentId: string,
  precedentId: string
): Promise<ApplyPrecedentResult> {
  return withGroup(`apply_precedent(${incidentId}, ${precedentId})`, async () => {
    const rows = await runQuery<{
      precedent: Precedent;
      established_by: Human;
      caseId: string;
    }>(
      `
      MATCH (i:Incident {id: $incidentId})
      MATCH (h:Human)-[:ESTABLISHES]->(pr:Precedent {id: $precedentId})
      OPTIONAL MATCH (existing:Case)
      WITH i, h, pr, coalesce(max(toInteger(substring(existing.id, 5))), 0) + 1 AS next
      CREATE (cs:Case {id: 'CASE-' + toString(next), opened_at: date(),
                       status: 'resolved_by_precedent'})
      MERGE (cs)-[:CONCERNS]->(i)
      MERGE (pr)-[:CITED_BY]->(cs)
      RETURN ${PRECEDENT_PROJ} AS precedent, h {.id, .name, .role} AS established_by,
             cs.id AS caseId
      `,
      { incidentId, precedentId }
    );
    const { precedent, established_by, caseId } = rows[0];
    const incident = await resolveIncident(
      incidentId, "precedent", precedentId, precedent.action, precedent.discount_pct
    );
    return {
      incident,
      caseId,
      precedent,
      established_by,
      statement:
        `Resolved per precedent ${precedent.id}, established by ${established_by.name} ` +
        `(${established_by.role}) on ${precedent.established_at} for an equivalent case.`,
    };
  });
}

export interface RecordDecisionResult {
  incident: Incident;
  caseId: string;
  human: Human;
  precedent: Precedent;
}

/** Step 4 — a human decides; the decision becomes a new Precedent that
 *  REFINES the POL-GAP placeholder ("precedents fill policy gaps"). */
export async function recordDecision(
  incidentId: string,
  humanName: string,
  action: string,
  discountPct: number,
  rationale: string
): Promise<RecordDecisionResult> {
  return withGroup(`record_decision(${incidentId}, ${humanName})`, async () => {
    const rows = await runQuery<{ caseId: string; human: Human; precedent: Precedent }>(
      `
      MATCH (c:Customer)-[:HAD]->(o:Order)-[:AFFECTED_BY]->(i:Incident {id: $incidentId})
      MATCH (gap:Policy {id: 'POL-GAP'})
      OPTIONAL MATCH (existing_h:Human {name: $humanName})
      OPTIONAL MATCH (any_h:Human)
      WITH c, i, gap, existing_h,
           coalesce(max(toInteger(substring(any_h.id, 4))), 0) + 1 AS next_h
      CALL (existing_h, next_h) {
        WITH existing_h, next_h
        WITH * WHERE existing_h IS NULL
        CREATE (nh:Human {id: 'HUM-' + right('00' + toString(next_h), 3),
                          name: $humanName, role: 'Customer Care Lead'})
        RETURN nh
        UNION
        WITH existing_h, next_h
        WITH * WHERE existing_h IS NOT NULL
        RETURN existing_h AS nh
      }
      WITH c, i, gap, nh AS h
      OPTIONAL MATCH (existing_cs:Case)
      WITH c, i, gap, h,
           coalesce(max(toInteger(substring(existing_cs.id, 5))), 0) + 1 AS next_cs
      OPTIONAL MATCH (existing_pr:Precedent)
      WITH c, i, gap, h, next_cs,
           coalesce(max(toInteger(substring(existing_pr.id, 3))), 0) + 1 AS next_pr
      CREATE (cs:Case {id: 'CASE-' + toString(next_cs), opened_at: date(),
                       status: 'resolved_by_human'})
      CREATE (pr:Precedent {id: 'PR-' + right('00' + toString(next_pr), 3),
                            established_at: date(),
                            incident_type: i.type,
                            min_tier: c.tier,
                            action: $action,
                            discount_pct: $discountPct,
                            rationale: $rationale})
      MERGE (cs)-[:CONCERNS]->(i)
      MERGE (cs)-[:DECIDED_BY]->(h)
      MERGE (h)-[:ESTABLISHES]->(pr)
      MERGE (pr)-[:REFINES]->(gap)
      RETURN cs.id AS caseId, h {.id, .name, .role} AS human,
             ${PRECEDENT_PROJ} AS precedent
      `,
      { incidentId, humanName, action, discountPct, rationale }
    );
    const { caseId, human, precedent } = rows[0];
    const incident = await resolveIncident(
      incidentId, "human", precedent.id, action, discountPct
    );
    return { incident, caseId, human, precedent };
  });
}

// ── Decision graph (for DecisionGraph.tsx) ─────────────────────

export interface DecisionGraphNode {
  id: string;
  label: string;
  type: "Customer" | "Order" | "Incident" | "Policy" | "Precedent" | "Human" | "Case";
}

export interface DecisionGraphRel {
  source: string;
  target: string;
  type: string;
}

export interface DecisionGraphData {
  nodes: DecisionGraphNode[];
  rels: DecisionGraphRel[];
}

export async function getDecisionGraph(incidentId: string): Promise<DecisionGraphData> {
  return withGroup(`decision_graph(${incidentId})`, async () => {
    const nodes: DecisionGraphNode[] = [];
    const rels: DecisionGraphRel[] = [];
    const seen = new Set<string>();
    const addNode = (n: DecisionGraphNode) => {
      if (!seen.has(n.id)) {
        seen.add(n.id);
        nodes.push(n);
      }
    };

    const ctx = await runQuery<{
      customer: Customer;
      order: OrderRec;
      incident: Incident;
    }>(
      `
      MATCH (c:Customer)-[:HAD]->(o:Order)-[:AFFECTED_BY]->(i:Incident {id: $incidentId})
      RETURN ${CUSTOMER_PROJ} AS customer, ${ORDER_PROJ} AS order, ${INCIDENT_PROJ} AS incident
      `,
      { incidentId }
    );
    if (!ctx[0]) return { nodes, rels };
    const { customer, order, incident } = ctx[0];
    addNode({ id: customer.id, label: `${customer.name} (${customer.tier})`, type: "Customer" });
    addNode({ id: order.id, label: order.product_name, type: "Order" });
    addNode({ id: incident.id, label: `${incident.id}: ${incident.type}`, type: "Incident" });
    rels.push({ source: customer.id, target: order.id, type: "HAD" });
    rels.push({ source: order.id, target: incident.id, type: "AFFECTED_BY" });

    if (incident.resolution_type === "policy" && incident.resolution_ref) {
      const pol = await runQuery<{ policy: Policy }>(
        `MATCH (p:Policy {id: $ref}) RETURN ${POLICY_PROJ} AS policy`,
        { ref: incident.resolution_ref }
      );
      if (pol[0]) {
        addNode({ id: pol[0].policy.id, label: pol[0].policy.name, type: "Policy" });
        rels.push({ source: incident.id, target: pol[0].policy.id, type: "RESOLVED_BY" });
      }
    }

    const caseRows = await runQuery<{
      caseId: string;
      caseStatus: string;
      human: Human | null;
      precedent: Precedent | null;
      prHuman: Human | null;
      gapId: string | null;
      gapName: string | null;
    }>(
      `
      MATCH (cs:Case)-[:CONCERNS]->(i:Incident {id: $incidentId})
      OPTIONAL MATCH (cs)-[:DECIDED_BY]->(h:Human)
      OPTIONAL MATCH (pr:Precedent)-[:CITED_BY]->(cs)
      OPTIONAL MATCH (h2:Human)-[:ESTABLISHES]->(pr3:Precedent {id: i.resolution_ref})
      OPTIONAL MATCH (pr3)-[:REFINES]->(gap:Policy)
      RETURN cs.id AS caseId, cs.status AS caseStatus,
             CASE WHEN h IS NULL THEN null ELSE h {.id, .name, .role} END AS human,
             CASE WHEN pr3 IS NULL THEN null ELSE pr3 {.id, .incident_type, .min_tier,
               .action, .discount_pct, .rationale,
               established_at: toString(pr3.established_at)} END AS precedent,
             CASE WHEN h2 IS NULL THEN null ELSE h2 {.id, .name, .role} END AS prHuman,
             gap.id AS gapId, gap.name AS gapName
      `,
      { incidentId }
    );
    for (const row of caseRows) {
      addNode({ id: row.caseId, label: `${row.caseId} (${row.caseStatus})`, type: "Case" });
      rels.push({ source: row.caseId, target: incident.id, type: "CONCERNS" });
      if (row.human) {
        addNode({ id: row.human.id, label: `${row.human.name} — ${row.human.role}`, type: "Human" });
        rels.push({ source: row.caseId, target: row.human.id, type: "DECIDED_BY" });
      }
      if (row.precedent) {
        addNode({ id: row.precedent.id, label: `${row.precedent.id}: ${row.precedent.action}`, type: "Precedent" });
        if (incident.resolution_type === "precedent") {
          rels.push({ source: row.precedent.id, target: row.caseId, type: "CITED_BY" });
        }
        if (row.prHuman) {
          addNode({ id: row.prHuman.id, label: `${row.prHuman.name} — ${row.prHuman.role}`, type: "Human" });
          rels.push({ source: row.prHuman.id, target: row.precedent.id, type: "ESTABLISHES" });
        }
        if (row.gapId) {
          addNode({ id: row.gapId, label: row.gapName ?? row.gapId, type: "Policy" });
          rels.push({ source: row.precedent.id, target: row.gapId, type: "REFINES" });
        }
      }
    }
    return { nodes, rels };
  });
}

// ── Explanation (Explore / chat) ───────────────────────────────

export interface Explanation {
  resolution: string;
  summary: string;
  policy?: Policy;
  precedent?: Precedent;
  established_by?: Human;
  rationale?: string;
  decision_path: string[];
}

export async function explainDecision(incidentId: string): Promise<Explanation | null> {
  return withGroup(`explain_decision(${incidentId})`, async () => {
    const ctx = await runQuery<{
      customer: Customer;
      order: OrderRec;
      incident: Incident;
    }>(
      `
      MATCH (c:Customer)-[:HAD]->(o:Order)-[:AFFECTED_BY]->(i:Incident {id: $incidentId})
      RETURN ${CUSTOMER_PROJ} AS customer, ${ORDER_PROJ} AS order, ${INCIDENT_PROJ} AS incident
      `,
      { incidentId }
    );
    if (!ctx[0]) return null;
    const { customer, order, incident } = ctx[0];
    if (incident.status !== "resolved") {
      return {
        resolution: "open",
        summary: `Incident ${incidentId} is still open — no decision to explain yet.`,
        decision_path: [],
      };
    }
    const path = [
      `(:Customer {${customer.name}, tier: ${customer.tier}})`,
      `-[:HAD]->(:Order {${order.id}: ${order.product_name}})`,
      `-[:AFFECTED_BY]->(:Incident {${incident.id}: ${incident.type}})`,
    ];
    if (incident.resolution_type === "policy") {
      const pol = await runQuery<{ policy: Policy }>(
        `MATCH (p:Policy {id: $ref}) RETURN ${POLICY_PROJ} AS policy`,
        { ref: incident.resolution_ref }
      );
      const policy = pol[0]?.policy;
      return {
        resolution: "auto_approved_by_policy",
        summary: `Auto-approved under ${policy.id} (${policy.name}): ${policy.action} with a ${policy.discount_pct}% discount.`,
        policy,
        decision_path: [...path, ` matched (:Policy {${policy.id}: ${policy.name}})`],
      };
    }
    const prRows = await runQuery<{ precedent: Precedent; established_by: Human }>(
      `
      MATCH (h:Human)-[:ESTABLISHES]->(pr:Precedent {id: $ref})
      RETURN ${PRECEDENT_PROJ} AS precedent, h {.id, .name, .role} AS established_by
      `,
      { ref: incident.resolution_ref }
    );
    const { precedent, established_by } = prRows[0];
    return {
      resolution:
        incident.resolution_type === "human"
          ? "human_decision_became_precedent"
          : "auto_resolved_citing_precedent",
      summary:
        `Resolved per precedent ${precedent.id}, established by ${established_by.name} ` +
        `(${established_by.role}) on ${precedent.established_at}: ${precedent.action} ` +
        `with a ${precedent.discount_pct}% discount.`,
      precedent,
      established_by,
      rationale: precedent.rationale,
      decision_path: [
        ...path,
        ` resolved by (:Precedent {${precedent.id}})<-[:ESTABLISHES]-(:Human {${established_by.name}})`,
      ],
    };
  });
}
