// ══════════════════════════════════════════════════════════════
// Jurisprudence Demo — Standalone Cypher (Neo4j Browser / cypher-shell)
//
// The 3-act decision flow as plain queries: policy match, precedent
// search, human decision write-back, precedent citation, explanation.
// Every decision is a deterministic traversal — no embeddings, no scores.
// ══════════════════════════════════════════════════════════════


// ── 0.1: Portfolio overview ────────────────────────────────────

MATCH (n)
RETURN labels(n)[0] AS label, count(*) AS count
ORDER BY label;


// ── 0.2: A customer's journey ─────────────────────────────────

MATCH (c:Customer {id: 'CUST-001'})-[:HAD]->(o:Order)
OPTIONAL MATCH (o)-[:AFFECTED_BY]->(i:Incident)
RETURN c.name AS customer, c.tier AS tier, o.product_name AS product,
       toString(o.date) AS ordered, i.type AS incident, i.status AS status
ORDER BY o.date DESC;


// ══════════════════════════════════════════════════════════════
// ACT 1 — INC-001: Gold customer, damaged in transit
// ══════════════════════════════════════════════════════════════

// ── 1.1: The policy match — ONE deterministic WHERE clause ────
// Conditions: same incident_type, customer tier >= policy min_tier,
// reported within the policy's recency window. Rank: most specific
// tier first, then discount.

MATCH (c:Customer)-[:HAD]->(o:Order)-[:AFFECTED_BY]->(i:Incident {id: 'INC-001'})
WITH c, o, i,
     CASE c.tier WHEN 'Standard' THEN 1 WHEN 'Gold' THEN 2 WHEN 'VIP' THEN 3 END AS tierRank
MATCH (p:Policy)
WHERE p.incident_type = i.type
  AND CASE p.min_tier WHEN 'Standard' THEN 1 WHEN 'Gold' THEN 2 WHEN 'VIP' THEN 3 END <= tierRank
  AND (p.max_recency_days IS NULL
       OR i.reported_at >= date() - duration({days: p.max_recency_days}))
RETURN c.name AS customer, c.tier AS tier, i.type AS incident,
       p.id AS policy, p.name AS policyName, p.action AS action,
       p.discount_pct AS discountPct
ORDER BY CASE p.min_tier WHEN 'Standard' THEN 1 WHEN 'Gold' THEN 2 WHEN 'VIP' THEN 3 END DESC,
         p.discount_pct DESC;


// ══════════════════════════════════════════════════════════════
// ACT 2 — INC-101: packaging damaged, product usable — a coverage gap
// ══════════════════════════════════════════════════════════════

// ── 2.1: No policy matches (same query, empty result) ─────────

MATCH (c:Customer)-[:HAD]->(o:Order)-[:AFFECTED_BY]->(i:Incident {id: 'INC-101'})
WITH c, i,
     CASE c.tier WHEN 'Standard' THEN 1 WHEN 'Gold' THEN 2 WHEN 'VIP' THEN 3 END AS tierRank
MATCH (p:Policy)
WHERE p.incident_type = i.type
  AND CASE p.min_tier WHEN 'Standard' THEN 1 WHEN 'Gold' THEN 2 WHEN 'VIP' THEN 3 END <= tierRank
RETURN p;
// → no rows: nothing in the handbook covers this incident type.


// ── 2.2: Precedent search — considered, but why not applicable ─

MATCH (c:Customer)-[:HAD]->(o:Order)-[:AFFECTED_BY]->(i:Incident {id: 'INC-101'})
WITH c, i,
     CASE c.tier WHEN 'Standard' THEN 1 WHEN 'Gold' THEN 2 WHEN 'VIP' THEN 3 END AS tierRank
MATCH (h:Human)-[:ESTABLISHES]->(pr:Precedent)
RETURN pr.id AS precedent, pr.incident_type AS type, h.name AS establishedBy,
       pr.incident_type = i.type AS sameType,
       CASE pr.min_tier WHEN 'Standard' THEN 1 WHEN 'Gold' THEN 2 WHEN 'VIP' THEN 3 END <= tierRank AS tierOk
ORDER BY pr.established_at DESC;
// → precedents exist, but none with this incident type: escalate to a human.


// ── 2.3: The human decision becomes a Precedent (write-back) ──
// (The app/MCP tool computes the next PR-/CASE- ids; fixed here for clarity.)

MATCH (c:Customer)-[:HAD]->(o:Order)-[:AFFECTED_BY]->(i:Incident {id: 'INC-101'})
MATCH (h:Human {name: 'Sophie Marchand'})
MATCH (gap:Policy {id: 'POL-GAP'})
MERGE (cs:Case {id: 'CASE-DEMO-101'})
  ON CREATE SET cs.opened_at = date(), cs.status = 'resolved_by_human'
MERGE (pr:Precedent {id: 'PR-DEMO'})
  ON CREATE SET pr.established_at = date(),
                pr.incident_type = i.type,
                pr.min_tier = c.tier,
                pr.action = 'goodwill_discount_no_replacement',
                pr.discount_pct = 10,
                pr.rationale = 'Product intact and usable; packaging damage only. 10% goodwill discount, no replacement shipment.'
MERGE (cs)-[:CONCERNS]->(i)
MERGE (cs)-[:DECIDED_BY]->(h)
MERGE (h)-[:ESTABLISHES]->(pr)
MERGE (pr)-[:REFINES]->(gap)
SET i.status = 'resolved', i.resolution_type = 'human', i.resolution_ref = pr.id,
    i.resolution_action = pr.action, i.resolution_discount_pct = pr.discount_pct,
    i.resolved_at = date()
RETURN pr.id AS newPrecedent, h.name AS decidedBy;


// ══════════════════════════════════════════════════════════════
// ACT 3 — INC-102: same incident type → the precedent now matches
// ══════════════════════════════════════════════════════════════

// ── 3.1: Precedent search again — this time it hits ────────────

MATCH (c:Customer)-[:HAD]->(o:Order)-[:AFFECTED_BY]->(i:Incident {id: 'INC-102'})
WITH c, i,
     CASE c.tier WHEN 'Standard' THEN 1 WHEN 'Gold' THEN 2 WHEN 'VIP' THEN 3 END AS tierRank
MATCH (h:Human)-[:ESTABLISHES]->(pr:Precedent)
WHERE pr.incident_type = i.type
  AND CASE pr.min_tier WHEN 'Standard' THEN 1 WHEN 'Gold' THEN 2 WHEN 'VIP' THEN 3 END <= tierRank
RETURN pr.id AS precedent, pr.action AS action, pr.discount_pct AS discountPct,
       pr.rationale AS rationale, h.name AS establishedBy,
       toString(pr.established_at) AS establishedOn
ORDER BY pr.established_at DESC;


// ── 3.2: Apply it — open a Case that CITES the precedent ──────

MATCH (i:Incident {id: 'INC-102'})
MATCH (pr:Precedent {id: 'PR-DEMO'})
MERGE (cs:Case {id: 'CASE-DEMO-102'})
  ON CREATE SET cs.opened_at = date(), cs.status = 'resolved_by_precedent'
MERGE (cs)-[:CONCERNS]->(i)
MERGE (pr)-[:CITED_BY]->(cs)
SET i.status = 'resolved', i.resolution_type = 'precedent', i.resolution_ref = pr.id,
    i.resolution_action = pr.action, i.resolution_discount_pct = pr.discount_pct,
    i.resolved_at = date()
RETURN i.id AS incident, pr.id AS citedPrecedent, cs.id AS caseId;


// ── 3.3: Explain the decision — the full chain of responsibility ─

MATCH (c:Customer)-[:HAD]->(o:Order)-[:AFFECTED_BY]->(i:Incident {id: 'INC-102'})
MATCH (h:Human)-[:ESTABLISHES]->(pr:Precedent {id: i.resolution_ref})
OPTIONAL MATCH (pr)-[:REFINES]->(gap:Policy)
RETURN c.name AS customer, i.type AS incident,
       'Resolved per precedent ' + pr.id + ', established by ' + h.name +
       ' (' + h.role + ') on ' + toString(pr.established_at) +
       ' for an equivalent case.' AS explanation,
       pr.rationale AS originalRationale, gap.name AS refinesPolicy;


// ── 3.4: The whole jurisprudence path, as a graph ──────────────
// (Best viewed in Neo4j Browser / Bloom)

MATCH path = (c:Customer)-[:HAD]->(:Order)-[:AFFECTED_BY]->(i:Incident {id: 'INC-102'})
MATCH cite = (h:Human)-[:ESTABLISHES]->(pr:Precedent {id: i.resolution_ref})-[:CITED_BY]->(cs:Case)-[:CONCERNS]->(i)
OPTIONAL MATCH refine = (pr)-[:REFINES]->(:Policy)
RETURN path, cite, refine;


// ── Cleanup for the standalone demo writes (2.3 / 3.2) ─────────

MATCH (cs:Case) WHERE cs.id STARTS WITH 'CASE-DEMO' DETACH DELETE cs;
MATCH (pr:Precedent {id: 'PR-DEMO'}) DETACH DELETE pr;
MATCH (i:Incident) WHERE i.id IN ['INC-101', 'INC-102']
SET i.status = 'open'
REMOVE i.resolution_type, i.resolution_ref, i.resolution_action,
       i.resolution_discount_pct, i.resolved_at;
