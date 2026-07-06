import { useState } from "react";
import { Dialog } from "@neo4j-ndl/react";

interface ExplainerSlide {
  title: string;
  subtitle?: string;
  content: React.ReactNode;
}

interface UseCaseExplainerProps {
  slides: ExplainerSlide[];
}

export default function UseCaseExplainer({ slides }: UseCaseExplainerProps) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);

  const slide = slides[page];

  return (
    <>
      <button
        className="explainer-trigger"
        onClick={() => { setOpen(true); setPage(0); }}
        title="What is this?"
      >
        ?
      </button>

      <Dialog
        isOpen={open}
        onClose={() => setOpen(false)}
        size="large"
      >
        <Dialog.Header>{slide.title}</Dialog.Header>
        {slide.subtitle && <Dialog.Subtitle>{slide.subtitle}</Dialog.Subtitle>}
        <Dialog.Content>
          <div className="explainer-body">
            {slide.content}
          </div>
        </Dialog.Content>
        {slides.length > 1 && (
          <Dialog.Actions>
            <div className="explainer-nav">
              <div className="explainer-dots">
                {slides.map((_, i) => (
                  <span
                    key={i}
                    className={`explainer-dot ${i === page ? "active" : ""}`}
                    onClick={() => setPage(i)}
                  />
                ))}
              </div>
              <div className="explainer-buttons">
                <button
                  className="explainer-btn"
                  onClick={() => setPage(page - 1)}
                  disabled={page === 0}
                >
                  Previous
                </button>
                <button
                  className="explainer-btn primary"
                  onClick={() => {
                    if (page < slides.length - 1) setPage(page + 1);
                    else setOpen(false);
                  }}
                >
                  {page < slides.length - 1 ? "Next" : "Got it"}
                </button>
              </div>
            </div>
          </Dialog.Actions>
        )}
      </Dialog>
    </>
  );
}

// ── Explainer content per section ─────────────────────────────

export const EXPLORE_SLIDES: ExplainerSlide[] = [
  {
    title: "Explore: Customers, Policies & Precedents",
    subtitle: "The three kinds of knowledge the decision system runs on",
    content: (
      <>
        <p>
          The <strong>Explore</strong> tab shows the whole decision graph: customers
          with their orders and incidents, the written <strong>policies</strong> from
          the customer-care handbook, and the <strong>precedents</strong> — past human
          decisions that became reusable jurisprudence.
        </p>
        <div className="explainer-highlight">
          <div className="explainer-label">The data model</div>
          <p>
            <code>(:Customer)-[:HAD]-&gt;(:Order)-[:AFFECTED_BY]-&gt;(:Incident)</code> is
            the case context. A <code>(:Policy)</code> node carries its conditions as plain
            properties (<code>incident_type</code>, <code>min_tier</code>,{" "}
            <code>max_recency_days</code>) — one predictable <code>WHERE</code> clause,
            fully explainable. A <code>(:Precedent)</code> is linked to the{" "}
            <code>(:Human)</code> who established it and to the policy gap it refines.
          </p>
        </div>
        <p className="explainer-takeaway">
          <strong>Why it matters:</strong> policies and precedents live in the same graph
          as the customers they apply to — so a decision is a <em>traversal</em>, not a
          black-box score.
        </p>
      </>
    ),
  },
  {
    title: "Precedents Are First-Class Citizens",
    subtitle: "Human decisions become reusable graph knowledge",
    content: (
      <>
        <p>
          When no policy covers a case, a human decides — and that decision is written
          back to the graph:
        </p>
        <div className="explainer-flow">
          <span className="flow-step">Case</span>
          <span className="flow-arrow">&rarr;</span>
          <span className="flow-step">DECIDED_BY Human</span>
          <span className="flow-arrow">&rarr;</span>
          <span className="flow-step">ESTABLISHES Precedent</span>
          <span className="flow-arrow">&rarr;</span>
          <span className="flow-step">REFINES Policy gap</span>
        </div>
        <p>
          The precedent carries the same matchable attributes as a policy
          (<code>incident_type</code>, <code>min_tier</code>) plus the human's{" "}
          <code>rationale</code>. The next equivalent case cites it automatically —
          and the citation is recorded as{" "}
          <code>(:Precedent)-[:CITED_BY]-&gt;(:Case)</code>.
        </p>
        <p className="explainer-takeaway">
          <strong>Why it matters:</strong> the system learns from every escalation.
          Humans handle each genuinely new situation exactly once.
        </p>
      </>
    ),
  },
];

export const DECIDE_SLIDES: ExplainerSlide[] = [
  {
    title: "Decide: The Live Decision Flow",
    subtitle: "Policy match → precedent search → human escalation",
    content: (
      <>
        <p>
          Pick any open incident and run the decision flow. The agent tries, in order:
        </p>
        <div className="explainer-highlight">
          <div className="explainer-label">The three-step waterfall</div>
          <ol>
            <li>
              <strong>match_policy</strong> — same incident type, customer tier at or
              above the policy's minimum, reported within the recency window. Match →
              auto-approved, with the traversal path as the explanation.
            </li>
            <li>
              <strong>find_precedents</strong> — no policy? Look for reusable
              jurisprudence with the same attribute overlap, ranked by recency.
              Match → resolved <em>citing the precedent and the human who set it</em>.
            </li>
            <li>
              <strong>record_decision</strong> — nothing matches? Escalate. The human's
              decision is applied AND becomes a new precedent for next time.
            </li>
          </ol>
        </div>
        <p className="explainer-takeaway">
          <strong>Why it matters:</strong> matching is deterministic attribute overlap —
          <em> "same kind of problem, same or higher-tier customer, recent enough."</em>{" "}
          No embeddings, no similarity scores: every decision is reproducible and
          auditable in one Cypher query.
        </p>
      </>
    ),
  },
];

export const SCENARIOS_SLIDES: ExplainerSlide[] = [
  {
    title: "Scenarios: The Jurisprudence Loop in 3 Acts",
    subtitle: "Policy → gap → precedent → automatic reuse",
    content: (
      <>
        <p>
          Three scripted cases show the full life cycle of a discount decision:
        </p>
        <div className="explainer-grid">
          <div className="explainer-card">
            <div className="explainer-card-num">1</div>
            <div>
              <strong>Covered by policy</strong><br />
              <span>
                A Gold customer's order is damaged in transit. A written policy matches —
                auto-approved, with the graph path as justification. No human involved.
              </span>
            </div>
          </div>
          <div className="explainer-card">
            <div className="explainer-card-num">2</div>
            <div>
              <strong>Policy gap → human precedent</strong><br />
              <span>
                Packaging damaged but the product is fine. No policy covers it. The system
                escalates; the human's decision becomes precedent PR-0xx.
              </span>
            </div>
          </div>
          <div className="explainer-card">
            <div className="explainer-card-num">3</div>
            <div>
              <strong>Precedent reused</strong><br />
              <span>
                Same incident type again. The system finds the precedent from Act 2 and
                resolves automatically — citing the human who established it, by name.
              </span>
            </div>
          </div>
        </div>
        <p className="explainer-takeaway">
          <strong>The loop closes live:</strong> what required a human in Act 2 is
          automatic in Act 3 — with full attribution.
        </p>
      </>
    ),
  },
  {
    title: "Why a Graph (and Not a Vector Store)?",
    subtitle: "Deterministic multi-hop reasoning, not fuzzy similarity",
    content: (
      <>
        <p>Every decision here is a graph traversal over shared attributes:</p>
        <div className="explainer-flow">
          <span className="flow-step">Customer</span>
          <span className="flow-arrow">&rarr;</span>
          <span className="flow-step">Order</span>
          <span className="flow-arrow">&rarr;</span>
          <span className="flow-step">Incident</span>
          <span className="flow-arrow">&rarr;</span>
          <span className="flow-step">Policy / Precedent</span>
          <span className="flow-arrow">&rarr;</span>
          <span className="flow-step">Human</span>
        </div>
        <p>
          "Similar case" means <em>same incident type, same-or-higher tier, recent
          enough</em> — a one-sentence rule anyone in the room can verify, running as one
          Cypher <code>WHERE</code> clause. The explanation isn't generated after the
          fact; it <em>is</em> the query.
        </p>
        <p className="explainer-takeaway">
          <strong>Why it matters:</strong> for decisions with money attached, you want
          100% reproducible matching and a citable chain of responsibility — who decided,
          when, and why. That chain is literally the shape of the graph.
        </p>
      </>
    ),
  },
];

export const ASSISTANT_SLIDES: ExplainerSlide[] = [
  {
    title: "Assistant: AI-Powered Case Handling",
    subtitle: "Natural language in, grounded graph decisions out",
    content: (
      <>
        <p>
          The <strong>Assistant</strong> tab is a Gemini-powered chatbot with{" "}
          <strong>function calling</strong>. It doesn't invent discounts — it runs the
          same decision tools as the Decide tab (<code>match_policy</code>,{" "}
          <code>find_precedents</code>, <code>apply_precedent</code>,{" "}
          <code>record_decision</code>, <code>explain_decision</code>) against the live
          graph, then narrates the result.
        </p>
        <div className="explainer-highlight">
          <div className="explainer-label">Grounded by construction</div>
          <p>
            Only a policy, a precedent, or an explicit human decision can set a discount.
            The LLM orchestrates and explains; the graph decides. Every tool call is
            visible in the timeline and the full Cypher audit trail is in the side
            drawer.
          </p>
        </div>
        <p className="explainer-takeaway">
          <strong>Why it matters:</strong> this is agentic AI with a governance story —
          every answer traces back to a named policy or a named human, through queries
          you can replay.
        </p>
      </>
    ),
  },
];
