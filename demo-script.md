# Jurisprudence Demo — Walkthrough Script (~15 minutes)

## Prerequisites

```bash
# 1. Load the data (fresh — do this before every run)
python3 generate_data.py
cat data/load_data.cypher | cypher-shell -u neo4j -p '<password>' -a bolt://127.0.0.1:7687

# 2. Start the React app
cd app
cp .env.example .env    # edit with your credentials
npm install
npm run dev             # http://localhost:5173

# 3. Sanity check (30 seconds, runs the 3 acts end to end and resets nothing):
python3 rehearse.py --quiet   # must end with ALL ACTS PASSED
# then reload fresh:
python3 -c "import mcp_server; mcp_server.load_demo()"
```

Before going on stage: open the app, go to **Scenarios**, click **Reset Demo State**
once. All three act buttons should be enabled and show no results.

---

## The Story

You run customer care for a cosmetics brand. Discount decisions today are either a
policy PDF nobody reads consistently, or tribal knowledge in a team channel. The result:
the same edge case gets decided five different ways by five different agents.

This demo shows a third way: **policies and precedents live in the same graph as the
customers they apply to** — so every decision is a traversal, every explanation is a
path, and every human decision the system couldn't make becomes reusable knowledge.

One sentence for the whole matching engine — say it early, repeat it often:

> *"Same kind of problem, same or higher-tier customer, recent enough — that's a match."*

---

## Act 0: Explore — What the System Knows (2 min)

> **Tab: Explore**

1. **Customers list** — 20 customers, tier chips (Standard/Gold/VIP). Click
   **Camille Laurent (Gold)**: her orders, one open incident (the crushed fragrance).

   **Talking point:** *"A boring, familiar graph: customers, orders, incidents. The
   interesting part is what else lives in the same graph."*

2. **Written Policies table** — 6 policies. Point at the columns: incident type,
   min tier, recency window, action, discount.

   **Talking point:** *"Policy conditions are plain properties — one WHERE clause. We
   deliberately did NOT build a clever rule engine. For decisions with money attached,
   predictable beats clever."*

3. **Precedents table** — 2 precedents. Point at **who established them, when, and the
   rationale**. Note the red POL-GAP chip under the policies table.

   **Talking point:** *"And this is the part that doesn't exist in most systems: past
   human decisions, stored with the same matchable attributes as policies. Jurisprudence.
   Watch how one gets born, live, in a few minutes."*

4. Open the **audit drawer** (right edge, "Cypher"). *"Every query the UI runs is
   logged here — nothing up my sleeve. This stays available the whole demo."*

---

## Act 1: Covered by Policy — Auto-Approved (3 min)

> **Tab: Scenarios → Card 1**

Setup line: *"Camille, Gold tier, her €89 fragrance arrived crushed. Damaged in
transit — the most boring incident type we have. Let's see the agent handle it."*

1. Click **Run Decision Flow (INC-001)**.
2. Read the result out loud: auto-approved under **POL-002 Premium Care**, express
   replacement + **20% discount**, **0 humans involved**.
3. Point at the conditions table: type matched, Gold ≥ Gold, reported 2 days ago
   within 60. **Note the "2 policies matched"** stat: *"Standard Care matched too —
   the engine picked the more specific Gold policy. Deterministic ranking, not vibes."*
4. Point at the **decision path graph**: Customer → Order → Incident → Policy.

   **Talking point:** *"The explanation is not generated after the fact by an LLM —
   the explanation IS the query. Open the audit drawer and you can replay it in
   Neo4j Browser."*

---

## Act 2: The Gap — a Human Decides, a Precedent Is Born (5 min)

> **Tab: Scenarios → Card 2**

Setup line: *"Now the case your policy handbook has never heard of. Léa, Standard
tier. Her serum arrived with a crushed box and a dented pump cap — but the serum
itself is perfectly fine. Is that 'damaged in transit'? The product isn't damaged.
Is it nothing? She's annoyed and she's right to be."*

1. Click **Run Decision Flow (INC-101)**.
2. Read the two banners:
   - Step 1: **no policy covers** `packaging_damaged_product_usable`. *"Coverage gap."*
   - Step 2: **2 precedents examined, none applicable** — different incident types.

   **Talking point:** *"This is the moment most 'AI agents' hallucinate a discount.
   Ours refuses: no policy, no precedent → it proposes options to a human. Guessing
   with money is not a feature."*

3. The escalation card shows **Sophie Marchand, Customer Care Lead** and her rationale.
   Wiggle the discount slider if you want, land on **10%**.
4. Click **Record Decision & Create Precedent**.
5. Read the green banner: the decision is now **PR-003**, established by Sophie,
   refining the policy gap.
6. Point at the graph: Case → DECIDED_BY → Sophie → ESTABLISHES → PR-003 → REFINES →
   Policy Gap.

   **Talking point:** *"Sophie didn't just close a ticket. She wrote case law. The
   graph remembers who decided, when, why — and crucially, the decision is now
   MATCHABLE: it carries the same attributes as a policy."*

---

## Act 3: The Loop Closes — the Precedent Is Cited (3 min)

> **Tab: Scenarios → Card 3**

Setup line: *"Two days later. Different customer — Nina, Standard tier, day cream this
time. Same story: box crushed in the mail, product sealed and fine. Last week this
would have been another escalation, another coin flip."*

1. Click **Run Decision Flow (INC-102)**.
2. Read the banners in order:
   - Still no policy.
   - Precedent search **finds PR-003** — same incident type, tier OK, most recent.
   - **"Resolved per precedent PR-003, established by Sophie Marchand (Customer Care
     Lead) on \<date\> for an equivalent case."**

   **Talking point — the money quote, slow down here:** *"What needed a human two
   minutes ago is now automatic — and it doesn't say 'the AI decided'. It cites Sophie,
   by name, with a date, like a court citing case law. That's the difference between
   automation you can audit and automation you have to trust."*

3. Point at the graph: PR-003 now has a **CITED_BY** edge to Nina's case. *"Even the
   reuse is recorded. Ask this graph 'which precedents earn their keep?' — it's a
   one-line query."*

Optional close on **Explore**: the Precedents table now shows 3 precedents, PR-003
cited 1×.

---

## Act 4 (optional, 2 min): The Assistant — Same Brain, Natural Language

> **Tab: Assistant**

1. Click suggestion **"Which incidents still need a decision?"** → the model calls
   `list_open_incidents`, tool calls visible in the timeline.
2. Click **"Why did INC-102 get 10%? Who decided that, originally?"** → it calls
   `explain_decision` and answers citing PR-003 / Sophie.

   **Talking point:** *"The LLM has no authority to set a discount. It can only call
   the same graph tools you just watched — a policy, a precedent, or a named human.
   Grounded agency: the LLM narrates, the graph decides."*

If the room is Claude-flavoured, mention: the same tools run as an MCP server
(`python3 mcp_server.py`) in Claude Desktop / Claude Code, every response carrying its
own `cypher_audit_trail`.

---

## Reset Between Runs

Scenarios tab → **Reset Demo State** (reopens the 3 incidents, deletes the live
precedent). Full reset: `python3 -c "import mcp_server; mcp_server.load_demo()"`.

## If Something Goes Wrong Live

- **Act 3 button disabled / no precedent found** → Act 2 wasn't recorded. Re-run Act 2.
- **Weird state / double precedents** → Reset Demo State, or full `load_demo()` (5 s).
- **Assistant slow or Gemini down** → the Scenarios tab is the demo; the Assistant is
  a bonus. Nothing in Acts 1–3 touches any external API.
- **Recency window expired** (data older than ~3 weeks): `python3 generate_data.py`
  + reload — dates are generated relative to today.

## Key Messages (leave the room with these)

1. **Deterministic beats fuzzy for money decisions** — the whole matcher is one
   sentence, one WHERE clause, reproducible in front of 120 people.
2. **Escalations are an asset** — each human decision becomes graph knowledge; the
   system handles each genuinely new situation exactly once.
3. **Explainability is structural** — who decided, when, why, and who reused it is
   the shape of the graph, not a log file. Multi-hop reasoning is the thing a graph
   does that a vector store cannot.
