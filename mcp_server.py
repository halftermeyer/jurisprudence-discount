"""
MCP Server: Jurisprudence — Precedent-Based Discount Decisions with Neo4j

A Model Context Protocol server that lets an LLM run the discount-decision
flow for a retail/cosmetics customer-service team:

  1. match_policy      — does a written policy cover this incident? If yes,
                         auto-approve and record the resolution.
  2. find_precedents   — no policy? Look for reusable past human decisions.
  3. apply_precedent   — a precedent matches: resolve the case citing it.
  4. record_decision   — nothing matches: a human decides, and the decision
                         becomes a new Precedent (reusable jurisprudence).
  5. explain_decision  — narrate WHY an incident was resolved the way it was.

Every tool returns a `cypher_audit_trail` section with the exact Cypher
statements that were executed.

Usage:
    python mcp_server.py          # stdio mode (for Claude Code / Claude Desktop)
    python mcp_server.py --sse    # SSE mode (for web clients)
"""

import json
import os
import sys
import textwrap
from pathlib import Path
from threading import local

from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP
from neo4j import GraphDatabase

load_dotenv(Path(__file__).parent / ".env")

NEO4J_URI = os.getenv("NEO4J_URI", "bolt://127.0.0.1:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "")
NEO4J_DATABASE = os.getenv("NEO4J_DATABASE", "neo4j")

mcp = FastMCP(
    "Jurisprudence Discount Decisions",
    instructions="""You are connected to a Neo4j graph database running the
Jurisprudence demo: an agentic discount-decision system for a cosmetics
customer-service team.

The graph: (:Customer)-[:HAD]->(:Order)-[:AFFECTED_BY]->(:Incident), written
(:Policy) rules whose conditions are plain properties (incident_type, min_tier,
max_recency_days), and (:Precedent) nodes — past human decisions that the
system reuses automatically for equivalent future cases:
(:Case)-[:CONCERNS]->(:Incident), (:Case)-[:DECIDED_BY]->(:Human),
(:Human)-[:ESTABLISHES]->(:Precedent)-[:REFINES]->(:Policy),
(:Precedent)-[:CITED_BY]->(:Case).

The decision flow for an open incident is ALWAYS:
1. match_policy(incident_id)   — a written policy covers it? Auto-approved.
2. find_precedents(incident_id) — otherwise, is there reusable jurisprudence?
3. apply_precedent(...)         — yes: resolve citing the precedent.
4. record_decision(...)         — no: escalate; the human decision becomes a
                                  new Precedent for next time.
Never invent a discount yourself: only policies, precedents, or an explicit
human decision can set one.

IMPORTANT: Every tool response includes a `cypher_audit_trail` section with the
exact Cypher that was executed. When presenting results, ALWAYS show this audit
trail in a fenced cypher code block so the audience can reproduce the
computation in Neo4j Browser or cypher-shell.""",
)

driver = GraphDatabase.driver(
    NEO4J_URI,
    auth=(NEO4J_USER, NEO4J_PASSWORD),
    notifications_min_severity="WARNING",
)

# ─── Query tracker ────────────────────────────────────────────

_thread_local = local()

TIER_RANK = "CASE {} WHEN 'Standard' THEN 1 WHEN 'Gold' THEN 2 WHEN 'VIP' THEN 3 END"


def _get_trail() -> list[str]:
    if not hasattr(_thread_local, "trail"):
        _thread_local.trail = []
    return _thread_local.trail


def _reset_trail():
    _thread_local.trail = []


def _fmt_query(query: str, params: dict | None = None) -> str:
    q = textwrap.dedent(query).strip()
    if params:
        comment_params = ", ".join(
            f"{k}: {json.dumps(v, default=str)[:200]}" for k, v in params.items()
        )
        if comment_params:
            q = f"// Parameters: {comment_params}\n{q}"
    return q


def run_cypher(query: str, params: dict | None = None) -> list[dict]:
    _get_trail().append(_fmt_query(query, params))
    with driver.session(database=NEO4J_DATABASE) as session:
        result = session.run(query, params or {})
        return [dict(r) for r in result]


def _build_response(results, label: str = "results") -> str:
    trail = _get_trail()
    audit = "\n\n".join(f"// Step {i + 1}\n{q}" for i, q in enumerate(trail))
    response = {
        label: results,
        "cypher_audit_trail": audit,
    }
    return json.dumps(response, indent=2, default=str)


# ─── Shared decision queries (mirrored in app/src/lib/queries.ts) ──

CONTEXT_QUERY = """
    MATCH (c:Customer)-[:HAD]->(o:Order)-[:AFFECTED_BY]->(i:Incident {id: $incident_id})
    RETURN c {.id, .name, .tier} AS customer,
           o {.id, .sku, .product_name, .amount, date: toString(o.date)} AS order,
           i {.id, .type, .description, .status, reported_at: toString(i.reported_at),
              .resolution_type, .resolution_ref, .resolution_action,
              .resolution_discount_pct} AS incident
"""

MATCH_POLICY_QUERY = f"""
    MATCH (c:Customer)-[:HAD]->(o:Order)-[:AFFECTED_BY]->(i:Incident {{id: $incident_id}})
    WITH c, o, i, {TIER_RANK.format('c.tier')} AS tierRank
    OPTIONAL MATCH (p:Policy)
    WHERE p.incident_type = i.type
      AND {TIER_RANK.format('p.min_tier')} <= tierRank
      AND (p.max_recency_days IS NULL
           OR i.reported_at >= date() - duration({{days: p.max_recency_days}}))
    WITH c, o, i, p
    ORDER BY {TIER_RANK.format('p.min_tier')} DESC, p.discount_pct DESC
    WITH c, o, i, [pol IN collect(p) | pol {{.id, .name, .incident_type, .min_tier,
         .max_recency_days, .action, .discount_pct, .description}}] AS candidates
    RETURN c {{.id, .name, .tier}} AS customer,
           o {{.id, .sku, .product_name, .amount, date: toString(o.date)}} AS order,
           i {{.id, .type, .description, .status, reported_at: toString(i.reported_at)}} AS incident,
           candidates,
           CASE WHEN size(candidates) > 0 THEN candidates[0] ELSE null END AS matched_policy
"""

FIND_PRECEDENTS_QUERY = f"""
    MATCH (c:Customer)-[:HAD]->(o:Order)-[:AFFECTED_BY]->(i:Incident {{id: $incident_id}})
    WITH c, i, {TIER_RANK.format('c.tier')} AS tierRank
    MATCH (h:Human)-[:ESTABLISHES]->(pr:Precedent)
    WITH c, i, tierRank, h, pr,
         pr.incident_type = i.type AS same_type,
         {TIER_RANK.format('pr.min_tier')} <= tierRank AS tier_ok
    RETURN pr {{.id, .incident_type, .min_tier, .action, .discount_pct, .rationale,
               established_at: toString(pr.established_at)}} AS precedent,
           h {{.id, .name, .role}} AS established_by,
           same_type, tier_ok,
           (same_type AND tier_ok) AS applicable
    ORDER BY applicable DESC, pr.established_at DESC
"""


def _resolve_incident(incident_id: str, res_type: str, ref: str, action: str, pct):
    return run_cypher(
        """
        MATCH (i:Incident {id: $incident_id})
        SET i.status = 'resolved',
            i.resolution_type = $res_type,
            i.resolution_ref = $ref,
            i.resolution_action = $action,
            i.resolution_discount_pct = $pct,
            i.resolved_at = date()
        RETURN i {.id, .status, .resolution_type, .resolution_ref,
                  .resolution_action, .resolution_discount_pct,
                  resolved_at: toString(i.resolved_at)} AS incident
        """,
        {"incident_id": incident_id, "res_type": res_type, "ref": ref,
         "action": action, "pct": pct},
    )


# ─── Tools ────────────────────────────────────────────────────


@mcp.tool()
def load_demo() -> str:
    """Load (or reload) the Jurisprudence demo data into Neo4j.
    Creates customers, orders, incidents, policies (including the POL-GAP
    placeholder), humans, and pre-seeded precedents. Resets any live
    decisions recorded in previous runs."""
    _reset_trail()
    cypher_file = Path(__file__).parent / "data" / "load_data.cypher"
    content = cypher_file.read_text()

    _get_trail().append("// [Loading data/load_data.cypher]")
    # Strip comment lines INSIDE each chunk (a chunk may be a comment header
    # followed by a real statement — dropping the whole chunk would skip it).
    statements = []
    for chunk in content.split(";\n"):
        stmt = "\n".join(
            line for line in chunk.splitlines()
            if not line.strip().startswith("//")
        ).strip()
        if stmt:
            statements.append(stmt)
    run_count = 0
    fail_count = 0
    errors = []
    with driver.session(database=NEO4J_DATABASE) as session:
        for stmt in statements:
            try:
                session.run(stmt).consume()
                run_count += 1
            except Exception as e:
                fail_count += 1
                errors.append(str(e)[:200])

    counts = run_cypher(
        "MATCH (n) RETURN labels(n)[0] AS label, count(*) AS count ORDER BY label"
    )
    summary = ", ".join(f"{r['count']} {r['label']}" for r in counts)
    result = {
        "status": f"Demo loaded: {summary}",
        "statements_run": run_count,
        "statements_failed": fail_count,
    }
    if errors:
        result["errors"] = errors[:5]
    return _build_response(result, "load_result")


@mcp.tool()
def match_policy(incident_id: str) -> str:
    """Check an incident against all written policies (same incident_type,
    customer tier at or above the policy's min_tier, reported within the
    policy's recency window). If a policy matches, the incident is
    AUTO-APPROVED on the spot: the resolution is written to the graph and the
    full traversal path (Customer -> Order -> Incident -> Policy) is returned
    as the explanation. If nothing matches, the incident stays open — call
    find_precedents next."""
    _reset_trail()
    rows = run_cypher(MATCH_POLICY_QUERY, {"incident_id": incident_id})
    if not rows:
        return _build_response(f"Incident '{incident_id}' not found.", "error")
    row = rows[0]
    matched = row["matched_policy"]

    if matched is None:
        result = {
            "decision": "no_policy_match",
            "customer": row["customer"],
            "order": row["order"],
            "incident": row["incident"],
            "policies_evaluated": "all policies checked — none cover this incident type / tier / recency",
            "next_step": "call find_precedents to look for reusable jurisprudence",
        }
        return _build_response(result, "match_result")

    if row["incident"]["status"] == "resolved":
        result = {
            "decision": "already_resolved",
            "incident": row["incident"],
            "note": "Incident already resolved — call explain_decision for the full story.",
        }
        return _build_response(result, "match_result")

    resolved = _resolve_incident(
        incident_id, "policy", matched["id"], matched["action"], matched["discount_pct"]
    )
    result = {
        "decision": "auto_approved_by_policy",
        "customer": row["customer"],
        "order": row["order"],
        "incident": resolved[0]["incident"] if resolved else row["incident"],
        "matched_policy": matched,
        "candidate_policies": row["candidates"],
        "traversal_path": (
            f"(:Customer {{{row['customer']['name']}, tier: {row['customer']['tier']}}})"
            f"-[:HAD]->(:Order {{{row['order']['id']}: {row['order']['product_name']}}})"
            f"-[:AFFECTED_BY]->(:Incident {{{incident_id}: {row['incident']['type']}}})"
            f" matched (:Policy {{{matched['id']}: {matched['name']}}})"
        ),
        "conditions_matched": {
            "incident_type": f"{row['incident']['type']} == {matched['incident_type']}",
            "tier": f"customer {row['customer']['tier']} >= policy min_tier {matched['min_tier']}",
            "recency": f"reported {row['incident']['reported_at']} within last {matched['max_recency_days']} days",
        },
    }
    return _build_response(result, "match_result")


@mcp.tool()
def find_precedents(incident_id: str) -> str:
    """Look for reusable jurisprudence: past human decisions (Precedent nodes)
    matching this incident by attribute overlap — same incident_type, customer
    tier at or above the precedent's min_tier. Returns applicable precedents
    ranked by recency (most recent first), plus the precedents that were
    considered and why they do NOT apply. Only meaningful after match_policy
    returned no match."""
    _reset_trail()
    rows = run_cypher(FIND_PRECEDENTS_QUERY, {"incident_id": incident_id})
    context = run_cypher(CONTEXT_QUERY, {"incident_id": incident_id})
    if not context:
        return _build_response(f"Incident '{incident_id}' not found.", "error")

    applicable = [r for r in rows if r["applicable"]]
    rejected = [
        {
            "precedent": r["precedent"],
            "established_by": r["established_by"],
            "why_not": (
                "different incident type"
                if not r["same_type"]
                else "customer tier below precedent's min_tier"
            ),
        }
        for r in rows
        if not r["applicable"]
    ]
    result = {
        "incident": context[0]["incident"],
        "customer": context[0]["customer"],
        "applicable_precedents": [
            {"precedent": r["precedent"], "established_by": r["established_by"]}
            for r in applicable
        ],
        "considered_but_rejected": rejected,
        "next_step": (
            f"apply_precedent(incident_id='{incident_id}', precedent_id='{applicable[0]['precedent']['id']}')"
            if applicable
            else "no applicable precedent — escalate to a human with record_decision"
        ),
    }
    return _build_response(result, "precedent_search")


@mcp.tool()
def apply_precedent(incident_id: str, precedent_id: str) -> str:
    """Resolve an open incident by citing an applicable precedent: opens a
    Case, links (:Precedent)-[:CITED_BY]->(:Case), and applies the precedent's
    action and discount to the incident. Use after find_precedents returned an
    applicable precedent."""
    _reset_trail()
    rows = run_cypher(
        f"""
        MATCH (c:Customer)-[:HAD]->(o:Order)-[:AFFECTED_BY]->(i:Incident {{id: $incident_id}})
        MATCH (h:Human)-[:ESTABLISHES]->(pr:Precedent {{id: $precedent_id}})
        WITH c, o, i, h, pr, {TIER_RANK.format('c.tier')} AS tierRank
        WHERE pr.incident_type = i.type AND {TIER_RANK.format('pr.min_tier')} <= tierRank
        RETURN c {{.id, .name, .tier}} AS customer, i.status AS status,
               pr {{.id, .action, .discount_pct, .rationale, .incident_type,
                   established_at: toString(pr.established_at)}} AS precedent,
               h {{.id, .name, .role}} AS established_by
        """,
        {"incident_id": incident_id, "precedent_id": precedent_id},
    )
    if not rows:
        return _build_response(
            f"Precedent '{precedent_id}' is not applicable to incident '{incident_id}' "
            "(wrong type or tier), or ids not found.",
            "error",
        )
    row = rows[0]
    if row["status"] == "resolved":
        return _build_response(f"Incident '{incident_id}' is already resolved.", "error")

    case_rows = run_cypher(
        """
        MATCH (i:Incident {id: $incident_id}), (pr:Precedent {id: $precedent_id})
        OPTIONAL MATCH (existing:Case)
        WITH i, pr, coalesce(max(toInteger(substring(existing.id, 5))), 0) + 1 AS next
        CREATE (cs:Case {id: 'CASE-' + toString(next), opened_at: date(),
                         status: 'resolved_by_precedent'})
        MERGE (cs)-[:CONCERNS]->(i)
        MERGE (pr)-[:CITED_BY]->(cs)
        RETURN cs {.id, .status, opened_at: toString(cs.opened_at)} AS case
        """,
        {"incident_id": incident_id, "precedent_id": precedent_id},
    )
    pr = row["precedent"]
    resolved = _resolve_incident(
        incident_id, "precedent", precedent_id, pr["action"], pr["discount_pct"]
    )
    result = {
        "decision": "auto_resolved_by_precedent",
        "statement": (
            f"Resolved per precedent {precedent_id}, established by "
            f"{row['established_by']['name']} ({row['established_by']['role']}) on "
            f"{pr['established_at']} for an equivalent case."
        ),
        "customer": row["customer"],
        "incident": resolved[0]["incident"] if resolved else None,
        "case": case_rows[0]["case"],
        "precedent": pr,
        "established_by": row["established_by"],
    }
    return _build_response(result, "apply_result")


@mcp.tool()
def record_decision(
    incident_id: str,
    human_name: str,
    action: str,
    discount_pct: float,
    rationale: str,
) -> str:
    """Record a human decision for an escalated incident. Opens a Case decided
    by the named Human, resolves the incident, AND writes the decision back to
    the graph as a new Precedent (linked to the human who made it and refining
    the POL-GAP placeholder policy). The returned precedent id is reusable
    jurisprudence: the next equivalent incident will cite it automatically."""
    _reset_trail()
    context = run_cypher(CONTEXT_QUERY, {"incident_id": incident_id})
    if not context:
        return _build_response(f"Incident '{incident_id}' not found.", "error")
    if context[0]["incident"]["status"] == "resolved":
        return _build_response(f"Incident '{incident_id}' is already resolved.", "error")

    rows = run_cypher(
        """
        MATCH (c:Customer)-[:HAD]->(o:Order)-[:AFFECTED_BY]->(i:Incident {id: $incident_id})
        MATCH (gap:Policy {id: 'POL-GAP'})
        // find-or-create the deciding human
        OPTIONAL MATCH (existing_h:Human {name: $human_name})
        OPTIONAL MATCH (any_h:Human)
        WITH c, i, gap, existing_h, coalesce(max(toInteger(substring(any_h.id, 4))), 0) + 1 AS next_h
        CALL (existing_h, next_h, gap) {
          WITH existing_h, next_h
          WITH * WHERE existing_h IS NULL
          CREATE (nh:Human {id: 'HUM-' + right('00' + toString(next_h), 3),
                            name: $human_name, role: 'Customer Care Lead'})
          RETURN nh
          UNION
          WITH existing_h, next_h
          WITH * WHERE existing_h IS NOT NULL
          RETURN existing_h AS nh
        }
        WITH c, i, gap, nh AS h
        // sequential ids for the new Case and Precedent
        OPTIONAL MATCH (existing_cs:Case)
        WITH c, i, gap, h, coalesce(max(toInteger(substring(existing_cs.id, 5))), 0) + 1 AS next_cs
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
                              discount_pct: $discount_pct,
                              rationale: $rationale})
        MERGE (cs)-[:CONCERNS]->(i)
        MERGE (cs)-[:DECIDED_BY]->(h)
        MERGE (h)-[:ESTABLISHES]->(pr)
        MERGE (pr)-[:REFINES]->(gap)
        RETURN cs {.id, .status, opened_at: toString(cs.opened_at)} AS case,
               h {.id, .name, .role} AS human,
               pr {.id, .incident_type, .min_tier, .action, .discount_pct, .rationale,
                   established_at: toString(pr.established_at)} AS precedent
        """,
        {
            "incident_id": incident_id,
            "human_name": human_name,
            "action": action,
            "discount_pct": discount_pct,
            "rationale": rationale,
        },
    )
    row = rows[0]
    resolved = _resolve_incident(
        incident_id, "human", row["precedent"]["id"], action, discount_pct
    )
    result = {
        "decision": "resolved_by_human_decision",
        "statement": (
            f"{row['human']['name']} decided: {action}"
            f" ({discount_pct}% discount). This decision is now precedent "
            f"{row['precedent']['id']} — the next equivalent case will cite it automatically."
        ),
        "incident": resolved[0]["incident"] if resolved else None,
        "case": row["case"],
        "decided_by": row["human"],
        "new_precedent": row["precedent"],
        "refines": "POL-GAP (Policy Gap — uncovered incident types)",
    }
    return _build_response(result, "decision_result")


@mcp.tool()
def explain_decision(incident_id: str) -> str:
    """Explain WHY a resolved incident was decided the way it was: which
    policy or precedent applied, every node and relationship on the decision
    path, and — for precedent-based decisions — who established the precedent,
    when, and for which original case. Presenter-readable output."""
    _reset_trail()
    context = run_cypher(CONTEXT_QUERY, {"incident_id": incident_id})
    if not context:
        return _build_response(f"Incident '{incident_id}' not found.", "error")
    row = context[0]
    inc = row["incident"]
    if inc["status"] != "resolved":
        return _build_response(
            {"incident": inc, "status": "still open — no decision to explain yet"},
            "explanation",
        )

    res_type = inc["resolution_type"]
    path = [
        f"(:Customer {{id: {row['customer']['id']}, name: {row['customer']['name']}, tier: {row['customer']['tier']}}})",
        f"-[:HAD]->(:Order {{id: {row['order']['id']}, product: {row['order']['product_name']}, amount: {row['order']['amount']}}})",
        f"-[:AFFECTED_BY]->(:Incident {{id: {inc['id']}, type: {inc['type']}}})",
    ]

    if res_type == "policy":
        pol = run_cypher(
            """
            MATCH (p:Policy {id: $ref})
            RETURN p {.id, .name, .incident_type, .min_tier, .max_recency_days,
                      .action, .discount_pct, .description, .source} AS policy
            """,
            {"ref": inc["resolution_ref"]},
        )
        policy = pol[0]["policy"] if pol else None
        path.append(f" matched (:Policy {{id: {policy['id']}, name: {policy['name']}}})")
        result = {
            "resolution": "auto_approved_by_policy",
            "summary": (
                f"Incident {incident_id} was auto-approved under policy {policy['id']} "
                f"({policy['name']}): {policy['action']} with a {policy['discount_pct']}% discount."
            ),
            "policy": policy,
            "decision_path": path,
            "conditions_matched": {
                "incident_type": f"{inc['type']} == {policy['incident_type']}",
                "tier": f"customer {row['customer']['tier']} >= policy min_tier {policy['min_tier']}",
                "recency": f"reported {inc['reported_at']} within last {policy['max_recency_days']} days",
            },
        }
    else:  # precedent or human
        pr_rows = run_cypher(
            """
            MATCH (h:Human)-[:ESTABLISHES]->(pr:Precedent {id: $ref})
            OPTIONAL MATCH (orig:Case)-[:DECIDED_BY]->(h)
            WHERE (orig)-[:CONCERNS]->(:Incident {type: pr.incident_type})
            OPTIONAL MATCH (pr)-[:CITED_BY]->(cited:Case)-[:CONCERNS]->(ci:Incident)
            OPTIONAL MATCH (pr)-[:REFINES]->(pol:Policy)
            RETURN pr {.id, .incident_type, .min_tier, .action, .discount_pct, .rationale,
                       established_at: toString(pr.established_at)} AS precedent,
                   h {.id, .name, .role} AS established_by,
                   pol {.id, .name} AS refines,
                   collect(DISTINCT {case: cited.id, incident: ci.id}) AS cited_by
            """,
            {"ref": inc["resolution_ref"]},
        )
        pr_row = pr_rows[0] if pr_rows else None
        pr = pr_row["precedent"] if pr_row else None
        who = pr_row["established_by"] if pr_row else None
        verb = "established live for this case" if res_type == "human" else "cited as jurisprudence"
        path.append(
            f" resolved by (:Precedent {{id: {pr['id']}}})<-[:ESTABLISHES]-"
            f"(:Human {{name: {who['name']}, role: {who['role']}}})"
        )
        result = {
            "resolution": "human_decision_became_precedent" if res_type == "human"
                          else "auto_resolved_citing_precedent",
            "summary": (
                f"Resolved per precedent {pr['id']}, established by {who['name']} "
                f"({who['role']}) on {pr['established_at']} for an equivalent case "
                f"({pr['incident_type']}): {pr['action']} with a "
                f"{pr['discount_pct']}% discount. Precedent {verb}."
            ),
            "precedent": pr,
            "established_by": who,
            "rationale": pr["rationale"],
            "refines_policy": pr_row["refines"],
            "also_cited_by": [c for c in pr_row["cited_by"] if c["case"]],
            "decision_path": path,
        }
    return _build_response(result, "explanation")


@mcp.tool()
def get_customer_journey(customer_id: str) -> str:
    """List a customer's orders, incidents, and how each incident was (or was
    not yet) resolved. Convenience tool for walkthroughs without the UI."""
    _reset_trail()
    rows = run_cypher(
        """
        MATCH (c:Customer {id: $customer_id})
        OPTIONAL MATCH (c)-[:HAD]->(o:Order)
        OPTIONAL MATCH (o)-[:AFFECTED_BY]->(i:Incident)
        RETURN c {.id, .name, .tier} AS customer,
               o {.id, .sku, .product_name, .amount, date: toString(o.date)} AS order,
               i {.id, .type, .description, .status, reported_at: toString(i.reported_at),
                  .resolution_type, .resolution_ref, .resolution_action,
                  .resolution_discount_pct} AS incident
        ORDER BY o.date DESC
        """,
        {"customer_id": customer_id},
    )
    if not rows:
        return _build_response(f"Customer '{customer_id}' not found.", "error")
    customer = rows[0]["customer"]
    orders = {}
    for r in rows:
        if r["order"] is None:
            continue
        oid = r["order"]["id"]
        orders.setdefault(oid, {**r["order"], "incidents": []})
        if r["incident"]:
            orders[oid]["incidents"].append(r["incident"])
    return _build_response(
        {"customer": customer, "orders": list(orders.values())}, "journey"
    )


if __name__ == "__main__":
    if "--sse" in sys.argv:
        mcp.settings.port = int(os.getenv("MCP_PORT", "8765"))
        mcp.run(transport="sse")
    else:
        mcp.run()
