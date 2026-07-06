# CONTEXT.md — Jurisprudence Demo (living documentation)

Context for agents and developers working on this repo. What the demo is, the
decisions already made, and the contracts that must not drift.

## What this is

A Neo4j demo called **"Jurisprudence"**: an agentic discount-decision system for a
retail/cosmetics customer-service team. Policy-covered cases are auto-approved with a
traceable explanation; uncovered cases are escalated to a human whose decision becomes
a **Precedent** — reusable jurisprudence cited automatically for equivalent future
cases.

Built as one of two demos shown back-to-back (8 July 2026, ~120 people, L'Oréal, mixed
audience). The sibling is [n20s-cosmo-rd](https://github.com/halftermeyer/n20s-cosmo-rd)
— this repo intentionally mirrors its look, structure, and scaffolding (header
gradient, tabs, `App.css`, `lib/neo4j.ts` audit log, `QueryAuditDrawer`,
`UseCaseExplainer`, `ScenarioCard`, MCP `cypher_audit_trail` convention).

## Deliberately out of scope

- **No n20s / RDF / RDFS / SHACL** — this is a plain property graph with a
  rule-matching layer. Semantic reasoning is the *other* demo's message.
- **No vector embeddings / similarity search** — precedent matching is deterministic,
  attribute-based. It must be 100% reliable live with zero external API dependency in
  the critical path.
- **No background simulator** — everything advances on presenter clicks or chat turns.
- **No generic process-ingestion tooling** — the tool surface is small and purpose-built.

## Data model (LPG)

```
(:Customer {id, name, tier})                       // Standard | Gold | VIP
    -[:HAD]->(:Order {id, sku, product_name, amount, date})
        -[:AFFECTED_BY]->(:Incident {id, type, description, reported_at, status})

(:Policy {id, name, incident_type, min_tier, max_recency_days,
          action, discount_pct, description, source})

(:Case {id, opened_at, status})
    -[:CONCERNS]->(:Incident)
    -[:DECIDED_BY]->(:Human {id, name, role})
(:Human)-[:ESTABLISHES]->(:Precedent {id, established_at, incident_type,
                                      min_tier, action, discount_pct, rationale})
(:Precedent)-[:REFINES]->(:Policy)
(:Precedent)-[:CITED_BY]->(:Case)
```

Resolved incidents carry denormalized resolution props (`resolution_type`:
`policy|precedent|human`, `resolution_ref`, `resolution_action`,
`resolution_discount_pct`, `resolved_at`) so `explain_decision` is one lookup.

Unique constraints on `id` for all seven labels; indexes on `Incident.type`,
`Policy.incident_type`, `Precedent.incident_type`.

### Decisions already made (do not re-litigate casually)

1. **Policy conditions are properties, not Condition nodes.** One predictable Cypher
   `WHERE` clause instead of a variable-depth AND/OR traversal — reliability over
   cleverness for a live demo. A Condition-node version is a stretch goal only.
2. **`Precedent -[:REFINES]-> Policy` targets the seeded `POL-GAP` placeholder**
   ("Policy Gap — uncovered incident types"), not a nearest-neighbour policy.
   Deterministic, one `MERGE`, and narratively right: precedents fill gaps.
3. **Matching rule** (one sentence, audience-explainable): *same incident type,
   customer tier at or above the minimum (Standard < Gold < VIP), recent enough* —
   policies rank by highest min_tier then discount; precedents rank by recency.
4. **`match_policy` applies on match** (sets the incident resolved). Rationale: the
   demo story is "auto-approved, no human involved" — read-then-write in one tool call.
5. **The decision graph is hand-rolled SVG, not `@neo4j-nvl`.** NVL 1.2's canvas
   renderer gates node captions on node-screen-area (labels invisible at fit zoom for a
   5-node path). A deterministic tiered SVG is more legible on a projector and has zero
   rendering surprises. The NVL deps remain in package.json for parity/future use.
6. **Tool count is 7, not the spec's 4-5** — the original tool list had no write-path
   for Act 3 (citing a precedent), hence `apply_precedent`, plus `get_customer_journey`
   as the walkthrough convenience.

## Tool contract (mcp_server.py ⇄ app/src/lib/queries.ts — keep in sync)

Every MCP response is `{ <label>: ..., cypher_audit_trail }`.

- `load_demo()` — (re)load `data/load_data.cypher`. Splitter strips comment lines
  *inside* chunks (a chunk may be a comment header + statement).
- `match_policy(incident_id)` — deterministic match; **auto-applies** on match.
- `find_precedents(incident_id)` — applicable precedents ranked by recency, PLUS
  `considered_but_rejected` with the reason (different type / tier too low).
- `apply_precedent(incident_id, precedent_id)` — opens Case, writes
  `(:Precedent)-[:CITED_BY]->(:Case)`, applies action+discount.
- `record_decision(incident_id, human_name, action, discount_pct, rationale)` — opens
  Case, find-or-creates Human by name, creates Precedent (next sequential `PR-0xx`),
  `REFINES` POL-GAP. Returns the precedent id.
- `explain_decision(incident_id)` — presenter-readable: which policy/precedent, the
  path, who established it and when.
- `get_customer_journey(customer_id)`.

Sequential ids are computed as `max(numeric suffix) + 1` over existing Case/Precedent/
Human nodes (`CASE-n`, `PR-00n`, `HUM-00n`).

## The 3 scripted acts (fixed ids — the seed data's spine)

| Act | Incident | Customer | Expected outcome |
|---|---|---|---|
| 1 | `INC-001` damaged_in_transit | CUST-001 Camille Laurent (Gold) | POL-002 Premium Care, 20%, 2 candidate policies, 0 humans |
| 2 | `INC-101` packaging_damaged_product_usable | CUST-002 Léa Moreau (Standard) | no policy → 2 precedents rejected (wrong type) → Sophie Marchand: 10% goodwill, no replacement → precedent `PR-003` |
| 3 | `INC-102` packaging_damaged_product_usable | CUST-003 Nina Rousseau (Standard) | cites PR-003, credits Sophie Marchand by name |

Invariants the seed data must keep:
- `packaging_damaged_product_usable` exists ONLY on INC-101 and INC-102.
- No policy covers that type; POL-GAP has `incident_type: 'uncovered'` so it never matches.
- Pre-seeded precedents (PR-001 `gift_missing_from_set`, PR-002
  `fragrance_leaked_half_empty`) use types with no policy AND no overlap with the
  scripted cases — they exist to make Act 2's "considered but rejected" non-empty.
- Dates are generated relative to run date (`generate_data.py`) so recency windows
  keep working; regenerate + reload if the DB is older than ~3 weeks.

## Rehearsal & reset

- `python3 rehearse.py` — reloads the DB and asserts all 3 acts end to end (17 checks).
- The Scenarios tab's **Reset Demo State** button (and
  `scenarioQueries.resetScenarios()`) reopens INC-001/101/102 and deletes the
  live-created cases + the packaging-damage precedent. Pre-seeded data untouched.
- `load_demo()` is the full reset (wipes everything, reloads).

## Known constraints

- The app embeds Neo4j credentials and the Gemini key in the client bundle (Vite env)
  — demo-only, same caveat as cosmo-rd.
- The original L'Oréal brief said "Claude Desktop/Cowork, avoid custom UI complexity";
  building the Needle-branded web app was a deliberate pivot for consistency with the
  sibling demo (flagged, not drifted into). The MCP server keeps the
  Claude-Desktop-only path fully functional.
