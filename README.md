# Jurisprudence — Precedent-Based Discount Decisions

A Neo4j demo of an **agentic discount-decision system** for a retail/cosmetics
customer-service team. Cases covered by a written policy are **auto-approved with a
traceable explanation**. Cases nothing covers are **escalated to a human — whose
decision is written back to the graph as a Precedent**: reusable jurisprudence the
system cites automatically the next time an equivalent case comes in.

Sibling demo of [n20s-cosmo-rd](https://github.com/halftermeyer/n20s-cosmo-rd)
(same look and feel, same scaffolding patterns).

## What It Demonstrates

- **Deterministic, attribute-based decisioning** — policy and precedent matching is one
  explainable Cypher `WHERE` clause: *same incident type, same-or-higher customer tier,
  recent enough*. No embeddings, no similarity scores: 100% reproducible live.
- **Human-in-the-loop that compounds** — every escalation produces a `Precedent` node
  linked to the human who decided, its rationale, and the policy gap it refines.
- **Explainability as a traversal** — "why did this customer get 10%?" is answered by
  the shape of the graph: `Customer → Order → Incident → Precedent ← Human`, with the
  exact Cypher shown in a global audit drawer.
- **Grounded agentic AI** — a Gemini-powered Assistant (and an MCP server for Claude
  Desktop/Code) that can only decide through the graph tools: a discount can come from
  a policy, a precedent, or a named human — never from the LLM.

## Architecture

```
┌────────────────┐     Bolt      ┌──────────────┐
│  React App     │──────────────▶│    Neo4j     │
│  (Needle UI)   │               │   (Cypher)   │
│  + Gemini chat │               └──────────────┘
└────────────────┘                      ▲
                                        │ Bolt
┌────────────────┐    stdio/SSE  ┌──────────────┐
│ Claude Desktop │──────────────▶│ mcp_server.py │
│ / Claude Code  │               │  (FastMCP)   │
└────────────────┘               └──────────────┘
```

Both clients run the **same decision flow** off the same data:
`match_policy → find_precedents → apply_precedent | record_decision → explain_decision`.
Every tool response carries a `cypher_audit_trail` with the exact statements executed.

## Quick Start

```bash
# 0. Python deps (MCP server + loader)
pip install -r requirements.txt

# 1. Generate and load the data
python3 generate_data.py
cat data/load_data.cypher | cypher-shell -u neo4j -p '<password>' -d '<database>'
#    (or: python3 -c "import mcp_server; mcp_server.load_demo()" — honours NEO4J_DATABASE)

# 2. Start the React app
cd app
cp .env.example .env   # edit with your credentials
npm install
npm run dev            # http://localhost:5173

# 3. (optional) MCP server for Claude Desktop / Claude Code
python3 mcp_server.py          # stdio
python3 mcp_server.py --sse    # SSE on :8765
```

### Environment variables

Root `.env` (MCP server):
```
NEO4J_URI=bolt://127.0.0.1:7687
NEO4J_DATABASE=neo4j           # target database (created if missing: CREATE DATABASE <name>)
NEO4J_USER=neo4j
NEO4J_PASSWORD=<password>
```

`app/.env` (React app):
```
VITE_NEO4J_URI=bolt://127.0.0.1:7687
VITE_NEO4J_DATABASE=neo4j      # must match the MCP server's NEO4J_DATABASE
VITE_NEO4J_USER=neo4j
VITE_NEO4J_PASSWORD=<password>
VITE_GEMINI_API_KEY=<key>      # Assistant tab only
```

## Prerequisites

- **Neo4j** 5.x / 2025.x / 2026.x (no plugins required)
- **Python 3.10+** — data generation + MCP server
- **Node.js 18+** — React app

## Structure

```
generate_data.py          — deterministic seed data (Case 1/2/3 have fixed ids)
data/load_data.cypher     — generated, idempotent load file
data/demo_queries.cypher  — the 3 acts as standalone Cypher for Neo4j Browser
mcp_server.py             — FastMCP server: 7 decision tools, audit trail on every response
demo-script.md            — 15-minute walkthrough with talking points
rehearse.py               — automated rehearsal: runs the 3 acts end to end, asserts outcomes
app/                      — React app (Vite + TypeScript + @neo4j-ndl/react)
  src/lib/neo4j.ts        — Neo4j driver + query audit log
  src/lib/queries.ts      — the decision-flow Cypher (mirrors mcp_server.py)
  src/lib/scenarioQueries.ts — scripted 3-act helpers + reset
  src/components/          — Explore, Decide, Scenarios, Assistant tabs
                             + DecisionGraph + QueryAuditDrawer
```

## Data Model

```
(:Customer {id, name, tier})                       // Standard | Gold | VIP
    -[:HAD]->(:Order {id, sku, product_name, amount, date})
        -[:AFFECTED_BY]->(:Incident {id, type, description, reported_at, status,
                                     resolution_type, resolution_ref, ...})

(:Policy {id, name, incident_type, min_tier, max_recency_days,
          action, discount_pct, description, source})
    // conditions are PROPERTIES, not Condition nodes — one predictable,
    // explainable WHERE clause (reliability over cleverness)

(:Case {id, opened_at, status})                    // exists only when no policy
    -[:CONCERNS]->(:Incident)                       // matched outright
    -[:DECIDED_BY]->(:Human {id, name, role})
(:Human)-[:ESTABLISHES]->(:Precedent {id, established_at, incident_type,
                                      min_tier, action, discount_pct, rationale})
(:Precedent)-[:REFINES]->(:Policy)                 // → the POL-GAP placeholder
(:Precedent)-[:CITED_BY]->(:Case)                  // written when a later case reuses it
```

**Matching rule** (policies and precedents alike): same `incident_type`, customer tier
at or above `min_tier` (Standard < Gold < VIP), incident reported within
`max_recency_days` (policies). Multiple precedent candidates rank by recency.

**Design note:** every live precedent `REFINES` the seeded `POL-GAP` placeholder policy
("Policy Gap — uncovered incident types") rather than a nearest-neighbour policy —
deterministic, one `MERGE`, and it tells the right story: precedents fill gaps until
the handbook catches up.

## The 3 Scripted Acts (Scenarios tab)

| | Incident | Customer | Outcome |
|---|---|---|---|
| 1 | `INC-001` damaged_in_transit | Camille Laurent (Gold) | Auto-approved under POL-002 (Premium Care, 20%) |
| 2 | `INC-101` packaging_damaged_product_usable | Léa Moreau (Standard) | No policy, no precedent → Sophie Marchand decides 10% goodwill → becomes **PR-003** |
| 3 | `INC-102` packaging_damaged_product_usable | Nina Rousseau (Standard) | Auto-resolved **citing PR-003**, crediting Sophie Marchand by name |

The Scenarios tab has a **Reset Demo State** button that reopens the three incidents and
deletes the live-created case/precedent — rehearse as many times as you like.

Automated check: `python3 rehearse.py` reloads the DB and asserts all three acts.

## Security Warning

The React app embeds `VITE_NEO4J_PASSWORD` and `VITE_GEMINI_API_KEY` into the client
bundle via Vite env vars. **This is for local development and demos only.** For any
shared or production deployment, put a backend service in front of both Neo4j and the
LLM API.

## License

Apache 2.0
