# Build Prompt for Claude Code — "Jurisprudence" Discount Decision Demo

> Paste this whole file to Claude Code as the opening prompt in a fresh repo.
> It is written so it can also live in the repo afterwards as `CONTEXT.md`,
> exactly like `n20s-cosmo-rd/CONTEXT.md` does for the sibling demo.

---

## 0. What you are building

A Neo4j-powered demo called **"Jurisprudence"** (working title — rename freely):
an agentic discount-decision system for a retail/cosmetics customer-service
team. Some cases match an existing discount policy and get auto-approved
with a traceable explanation. Cases that match nothing get escalated to a
human, whose decision becomes a **precedent** — a reusable piece of
jurisprudence the agent cites automatically the next time a similar case
comes in.

This is one of two demos being shown back-to-back on **8 July** to ~120
people (L'Oréal, mixed audience — R&D/architects/marketing/ops). The other
demo is **`n20s-cosmo-rd`** (cosmetics ingredient screening with Neo4j + GDS
+ n20s semantic reasoning): https://github.com/halftermeyer/n20s-cosmo-rd

**Hard requirement: visual and structural consistency with `n20s-cosmo-rd`.**
Clone or fetch that repo first and read it end to end — `README.md`,
`CONTEXT.md`, `app/src/App.tsx`, `app/src/App.css`, `app/src/lib/neo4j.ts`,
`app/src/components/QueryAuditDrawer.tsx`, `app/src/components/
UseCaseExplainer.tsx`, `app/src/components/ScenariosTab.tsx`,
`mcp_server.py`. Copy its scaffolding patterns near-verbatim (see §5) and
adapt only the domain-specific parts. Do not reinvent conventions it already
solved.

**Explicitly out of scope for this demo** (do not build these, even if they
seem tempting):
- No n20s / RDF / RDFS / SHACL. This domain is a plain property graph with
  a rule-matching layer — semantic reasoning adds nothing here and would
  blur the message of the *other* demo, which exists specifically to sell
  n20s.
- No vector embeddings / similarity search. Precedent matching is
  **deterministic, attribute-based** (see §3). It must be 100% reliable
  live, in front of 120 people, with zero external API dependency in the
  critical path.
- No background simulator / autonomous tick loop. Everything advances
  because the presenter clicks a button or asks Claude something. Live
  randomness is a liability, not a feature, in a 15-minute slot.
- No generic "ingest any process description" tool. The tool surface is
  small and purpose-built (§6).

**Timeline note:** this is being built with ~3 days of runway before the
live session. Get the 3 scripted scenarios (§4) rock-solid and rehearsed
before spending time on anything cosmetic. If something has to be cut,
cut polish, not reliability.

---

## 1. The narrative

Three acts, run live inside the **Scenarios** tab (or via Claude
Desktop/Code against the MCP server — both should work off the same data):

**Case 1 — matches a policy → auto-approved.**
A Gold-tier customer's order arrives damaged in transit. This is a known,
well-understood incident type. The system matches an existing `Policy`
node, applies it, and returns the decision *with the traversal path* that
justifies it (Customer → Order → Incident → Policy, with the exact
conditions that matched). No human involved.

**Case 2 — matches nothing → escalate → decision becomes a precedent.**
A Standard-tier customer's order arrives with **damaged packaging but the
product itself is intact and usable**. This is deliberately *not* covered
by any existing policy (policies are written for "damaged product", not
"cosmetic packaging damage, product fine"). The system looks for similar
past cases, finds none close enough, and proposes options to a human
(e.g. a Customer Care Lead) instead of guessing. The human decides — say,
a 10% goodwill discount, no replacement. That decision is written back to
the graph as a `Precedent`, linked to the human who made it and to the
policy it refines.

**Case 3 — a similar new case → auto-resolved, citing the precedent.**
Another Standard-tier customer, same incident type ("packaging damaged,
product usable"). This time the system finds the precedent created in
Case 2, applies the same resolution, and says so explicitly: *"Resolved
per precedent PR-0xx, established by \<human\> on \<date\> for an
equivalent case."* The loop closes live, in front of the audience.

Use this exact scenario (or a close variant) as the seed data's spine —
see §7 for the concrete records to generate. Everything else in the
dataset exists to make the graph feel populated and to give Case 2 a
plausible "no good match" outcome (i.e. the other policies/precedents in
the dataset must clearly *not* apply to the Case 2 incident).

---

## 2. Data model (LPG, no RDF)

```
(:Customer {id, name, tier})                       // tier: Standard | Gold | VIP
    -[:HAD]->(:Order {id, sku, product_name, amount, date})
        -[:AFFECTED_BY]->(:Incident {id, type, description, reported_at, status})

(:Policy {id, name, incident_type, min_tier, max_recency_days,
          action, discount_pct, description, source})
    // conditions live as PROPERTIES on the Policy node, not as separate
    // Condition nodes — this keeps match_policy a single, fast, explainable
    // Cypher query instead of a graph of ANDed condition nodes. See §3.

(:Case {id, opened_at, status})                     // only exists when no
    -[:CONCERNS]->(:Incident)                        // policy matched outright
    -[:DECIDED_BY]->(:Human {id, name, role})
(:Human)-[:ESTABLISHES]->(:Precedent {id, established_at,
                                       incident_type, min_tier,
                                       action, discount_pct, rationale})
(:Precedent)-[:REFINES]->(:Policy)                  // may point to the
                                                     // nearest existing
                                                     // policy, or to a
                                                     // placeholder "policy
                                                     // gap" node — your call,
                                                     // pick the simpler one
                                                     // and document it
(:Precedent)-[:CITED_BY]->(:Case)                   // written when a later
                                                     // case reuses it (Case 3)
```

Constraints to create: unique `id` on Customer, Order, Incident, Policy,
Case, Human, Precedent. Indexes on `Incident.type`, `Policy.incident_type`,
`Precedent.incident_type`.

**Decision explicitly made for you:** policy conditions are plain
properties (`incident_type`, `min_tier`, `max_recency_days`), not a graph
of `Condition` nodes. It is less "graph-y" to look at in Bloom, but it is
one predictable Cypher `WHERE` clause instead of a variable-depth AND/OR
traversal — reliability over cleverness, given the timeline. If there is
spare time after the 3 scenarios are bulletproof, a `Condition`-node
version can be added as a stretch goal; do not start with it.

---

## 3. Precedent matching (deterministic, no embeddings)

`find_precedents(incident)` and the "does any policy match" check both use
plain attribute overlap:

- same `incident_type`
- customer tier is at or above the policy's/precedent's `min_tier`
  (Standard < Gold < VIP)
- incident `reported_at` within the policy's/precedent's recency window
  (if any)

Rank multiple candidate precedents by recency (most recent wins) — this
is enough for a 3-case scripted demo and keeps the whole thing explainable
in one sentence to a non-technical audience: *"same kind of problem, same
or higher-tier customer, recent enough — that's a match."*

This is a deliberate choice, not a shortcut you should feel bad about:
Neo4j's own positioning (see the internal Knowledge Layer glossary) leans
on *multi-hop graph reasoning* as the differentiator against vector-only
RAG systems. Doing precedent-matching as a graph traversal over shared
attributes is the on-message version of this demo, not the cheap one.

---

## 4. Look-and-feel parity with `n20s-cosmo-rd`

Reuse, near-verbatim, adapting only labels/content:

| From `n20s-cosmo-rd` | Reused as |
|---|---|
| `app/src/App.tsx` shell (header, `Tabs` from `@neo4j-ndl/react`) | Same header gradient (`linear-gradient(135deg, #0b297d 0%, #006fd6 50%, #00b4d8 100%)`), same tab-bar pattern. Change the emoji/icon and title/subtitle only. |
| `app/src/App.css` | Copy wholesale, keep the `.card`, `.status-pass/fail/warn`, `.scenario-*`, `.audit-*`, `.explainer-*` classes as-is. Add only what a new component strictly needs. |
| `app/src/lib/neo4j.ts` | Copy verbatim — the driver singleton + query audit log (`runQuery`, `getQueryLog`, `getGroupedLog`, `onQueryLogChange`, `beginGroup`/`endGroup`) is exactly the mechanism this demo needs for "show me why," with zero new code. |
| `app/src/components/QueryAuditDrawer.tsx` | Copy verbatim. This *is* the answer to "show the traversal path" — every `match_policy` / `find_precedents` / `record_decision` call already logs its Cypher; the drawer already renders it grouped and copyable. Don't build a separate graph-path visualizer for this — the drawer already solves it. |
| `app/src/components/UseCaseExplainer.tsx` | Copy verbatim. Write new slide content (see §8) for a "?" button on the Scenarios tab and one on the Assistant tab, same as cosmo-rd does with `SCENARIOS_SLIDES` / `ASSISTANT_SLIDES`. |
| `app/src/components/ScenariosTab.tsx` (`ScenarioCard` wrapper + maximize/backdrop pattern) | Reuse the wrapper component as-is. Build 3 scenario components inside it — Case 1, Case 2, Case 3 — each with the same numbered-badge header style. |
| `app/src/components/BOMGraph.tsx` (`@neo4j-nvl/react`, tiered layout, per-type color map) | New component, same pattern: a small force-directed graph scoped to the current case (Customer → Order → Incident → Policy/Precedent → Human), colored by node type. Suggested palette, same family as cosmo-rd's blue/cyan/green: Customer `#0b297d`, Order `#006fd6`, Incident `#e65100`, Policy `#00b4d8`, Precedent `#8e24aa`, Human `#2e7d32`. |
| `app/src/components/ChatTab.tsx` (`@google/genai` function-calling against Neo4j, system prompt that hides the audit trail from its own prose because the UI shows it separately) | Same pattern, new tool list (§6) and new system prompt for this domain. |
| `mcp_server.py` (FastMCP, `run_cypher` wrapper, per-call `cypher_audit_trail` in every JSON response, `load_demo()` tool) | Same pattern, new tools (§6). Keep the "every response carries its own audit trail" convention — it's the single most reusable idea in that file. |

Tabs for this app (mirrors Explore / Formulate / Scenarios / Assistant):

- **Explore** — browse customers, their orders and incidents, existing
  policies and precedents.
- **Decide** — pick or type up a new incident and run the live
  match-or-escalate flow against it (the "Formulate" analogue).
- **Scenarios** — the 3 scripted acts from §1, one `ScenarioCard` each.
- **Assistant** — Gemini-powered chat, same tool-calling pattern as
  `ChatTab.tsx`.

The `QueryAuditDrawer` is global (rendered once in `App.tsx`, outside the
tabs), exactly as in cosmo-rd.

**One thing to flag back to Pierre, not silently decide:** the original
L'Oréal brief said "Claude Desktop/Cowork, avoid custom UI complexity."
Matching `n20s-cosmo-rd`'s look and feel means building a custom
Needle-branded web app instead. That's a deliberate, reasonable pivot for
consistency with the sibling demo — just make sure it's a conscious choice
and not a drift nobody decided on.

---

## 5. Repo structure

```
jurisprudence-demo/                  (rename as you like — kept generic on
                                       purpose so it can be reused for a
                                       future customer the way
                                       demo-context-process was)
├── README.md
├── CONTEXT.md                       (this file, trimmed to what a future
                                       agent/dev needs — same role as
                                       cosmo-rd's CONTEXT.md)
├── demo-script.md                   (walkthrough + talking points, English)
├── generate_data.py                 (produces data/load_data.cypher)
├── mcp_server.py
├── requirements.txt                 (mcp[cli], neo4j, python-dotenv — no
                                       google-genai/anthropic needed
                                       server-side; Gemini lives in the
                                       browser app only, same split as
                                       cosmo-rd)
├── .env.example
├── data/
│   ├── load_data.cypher
│   └── demo_queries.cypher          (standalone Cypher for Neo4j Browser)
└── app/
    ├── package.json                 (same deps as cosmo-rd's app/package.json:
    │                                  @neo4j-ndl/react, @neo4j-nvl/base,
    │                                  @neo4j-nvl/react, neo4j-driver, react,
    │                                  react-dom, + @google/genai for the
    │                                  chat tab — double check cosmo-rd's
    │                                  app actually has @google/genai in its
    │                                  package.json; add it if missing)
    ├── .env.example
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx / App.css / index.css
        ├── components/
        │   ├── ExploreTab.tsx
        │   ├── DecideTab.tsx
        │   ├── ScenariosTab.tsx
        │   ├── ChatTab.tsx
        │   ├── QueryAuditDrawer.tsx
        │   ├── DecisionGraph.tsx
        │   └── UseCaseExplainer.tsx
        └── lib/
            ├── neo4j.ts
            ├── queries.ts
            └── scenarioQueries.ts
```

---

## 6. MCP tools (server + app chat share the same underlying queries)

Every tool returns `{ ...result, cypher_audit_trail }`, same convention as
`n20s-cosmo-rd/mcp_server.py`.

- **`load_demo()`** — (re)loads `data/load_data.cypher` into Neo4j.
- **`match_policy(incident_id)`** — traverses
  `Customer -[:HAD]-> Order -[:AFFECTED_BY]-> Incident`, checks it against
  all `Policy` nodes using the rule in §3, returns the matched policy (or
  `null`) plus the full traversal path for the explanation.
- **`find_precedents(incident_id)`** — only meaningful when
  `match_policy` returned nothing; returns ranked candidate precedents
  (§3) or an empty list.
- **`record_decision(incident_id, human_name, action, discount_pct, rationale)`**
  — writes `Case -[:DECIDED_BY]-> Human -[:ESTABLISHES]-> Precedent
  -[:REFINES]-> Policy`. Returns the created precedent's id so a later
  `find_precedents` / `explain_decision` call can reference it.
- **`explain_decision(incident_id)`** — given an incident already resolved
  (by policy or by precedent), returns a structured, presenter-readable
  explanation: which policy or precedent applied, every node/relationship
  on the path, and (if a precedent) who established it and when. This is
  the tool called at the end of Case 1 and Case 3 to narrate "why."
- Optional convenience tool: **`get_customer_journey(customer_id)`** —
  lists a customer's orders/incidents, for the Explore tab and for
  Claude-Desktop-only walkthroughs where there's no UI to click through.

Keep the tool count at 4-5. Do not add a generic `run_cypher` tool to the
*server* the way cosmo-rd's *app* chat has one client-side — that one is
fine because it's scoped to the browser app talking to Gemini, not to
Claude Desktop/Code, where an unscoped `run_cypher` tool is an easy way to
end up executing something unrehearsed live.

---

## 7. Seed dataset (`generate_data.py`)

Roughly matching BNP's KYC demo scale (kept intentionally small — this is
a 15-minute slot, not an analytics showcase):

- **15-20 `Customer`** — mix of Standard/Gold/VIP tiers, cosmetics-plausible
  names, a couple of order/incident history each.
- **30-40 `Order`** — realistic cosmetics SKUs (serums, creams, lipsticks,
  fragrances), amounts, dates spread over the last ~6 months.
- **20-25 `Incident`** — variety of types: `damaged_in_transit`,
  `wrong_item_shipped`, `late_delivery`, `quality_complaint`,
  `packaging_damaged_product_usable` (the Case 2/3 type — make sure this
  one exists only on the two incidents used in Cases 2 and 3, nowhere
  else, so "no policy matches" is actually true for Case 2 and "a
  precedent matches" is actually true for Case 3).
- **5-8 `Policy`** — one per common incident type (e.g. damaged in
  transit → refund + discount; late delivery → shipping credit; wrong
  item → replacement + apology discount). None of them should cover
  `packaging_damaged_product_usable` — that gap is the point.
- **2-3 pre-seeded `Precedent`** nodes (dated in the past, unrelated
  incident types) so the Explore tab doesn't look empty on a graph that
  has never had a live decision recorded yet, and so `find_precedents`
  has a chance to show "found some, but not close enough" behaviour on
  request, not just on Case 2.
- The specific Case 1 / Case 2 / Case 3 customers, orders and incidents
  from §1, generated deterministically (fixed ids, not randomised) so the
  demo is repeatable across rehearsals.

Output a single `data/load_data.cypher` (idempotent `MERGE`s, semicolon
separated, same convention as cosmo-rd and as `demo-context-process`).

---

## 8. Deliverables checklist for Claude Code

1. `data/load_data.cypher` (via `generate_data.py`) + `data/demo_queries.cypher`
2. `mcp_server.py` — 4-5 tools per §6, `cypher_audit_trail` on every response
3. `app/` — Vite + React 19 + TypeScript, `@neo4j-ndl/react` + `@neo4j-nvl/react`,
   4 tabs + global audit drawer + use-case explainer, per §4-5
4. `demo-script.md` — English, ~15 minutes, 3 acts matching §1, with exact
   prompts/clicks and presenter talking points (same format as cosmo-rd's
   `demo-script.md`)
5. `README.md` — quick start (`generate_data.py` → load Cypher → `npm run dev`
   → `python mcp_server.py` for the Claude Desktop/Code side), architecture
   diagram, data model, same sections as cosmo-rd's README
6. `CONTEXT.md` — trim this file down to what's still true once the repo
   exists (drop the "build this" framing, keep the data model / tool
   contract / scenario spec as living documentation)
7. Rehearsal pass: run Case 1 → Case 2 → Case 3 end to end at least twice
   from a freshly reloaded database before calling it done.

---

## 9. Open questions to resolve with Pierre before/while building

- Final name for the repo and for the app header (placeholder:
  "Jurisprudence").
- Whether `Precedent -[:REFINES]-> Policy` should target the nearest
  existing policy or a dedicated "coverage gap" placeholder policy node —
  pick whichever is faster to implement cleanly; both are defensible.
- Whether the Assistant tab's Gemini key and the MCP server are expected
  to run against the *same* Aura instance as `n20s-cosmo-rd` or a
  separate one (separate is recommended — see the accompanying "enrich
  vs. separate repo" discussion).