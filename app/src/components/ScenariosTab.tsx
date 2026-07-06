import { useState, useEffect, useCallback } from "react";
import { FilledButton, OutlinedButton, Banner } from "@neo4j-ndl/react";
import UseCaseExplainer, { SCENARIOS_SLIDES } from "./UseCaseExplainer";
import DecisionGraph from "./DecisionGraph";
import {
  matchAndApplyPolicy,
  findPrecedents,
  applyPrecedent,
  recordDecision,
  getDecisionGraph,
  type MatchPolicyResult,
  type PrecedentSearch,
  type ApplyPrecedentResult,
  type RecordDecisionResult,
  type DecisionGraphData,
} from "../lib/queries";
import {
  CASE_1_INCIDENT,
  CASE_2_INCIDENT,
  CASE_3_INCIDENT,
  CASE_2_DEFAULTS,
  getScenarioState,
  resetScenarios,
  type ScenarioState,
} from "../lib/scenarioQueries";

// ─── Maximizable scenario wrapper (same pattern as cosmo-rd) ──

function ScenarioCard({ children }: { children: React.ReactNode }) {
  const [maximized, setMaximized] = useState(false);

  return (
    <>
      {maximized && (
        <div
          className="scenario-backdrop"
          onClick={() => setMaximized(false)}
        />
      )}
      <div className={`scenario-card ${maximized ? "maximized" : ""}`}>
        <button
          className="scenario-maximize-btn"
          onClick={() => setMaximized(!maximized)}
          title={maximized ? "Restore" : "Maximize"}
        >
          {maximized ? "✖" : "⛶"}
        </button>
        {children}
      </div>
    </>
  );
}

// ─── Act 1: Covered by policy → auto-approved ─────────────────

function Case1Scenario({ onAdvance }: { onAdvance: () => void }) {
  const [result, setResult] = useState<MatchPolicyResult | null>(null);
  const [graph, setGraph] = useState<DecisionGraphData>({ nodes: [], rels: [] });
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const match = await matchAndApplyPolicy(CASE_1_INCIDENT);
      setResult(match);
      setGraph(await getDecisionGraph(CASE_1_INCIDENT));
      onAdvance();
    } finally {
      setLoading(false);
    }
  }, [onAdvance]);

  return (
    <ScenarioCard>
      <div className="scenario-header">
        <div className="scenario-number">1</div>
        <div>
          <h3>Covered by Policy — Auto-Approved</h3>
          <p className="scenario-desc">
            Camille Laurent (<strong>Gold</strong>) reports her fragrance arrived{" "}
            <strong>damaged in transit</strong>. A known incident type: the policy engine
            traverses <code>Customer &rarr; Order &rarr; Incident</code>, checks every{" "}
            <code>Policy</code> in one deterministic <code>WHERE</code> clause, and
            auto-approves — returning the exact conditions that matched. No human involved.
          </p>
        </div>
      </div>

      <div className="scenario-controls">
        <FilledButton size="small" onClick={run} isLoading={loading} isDisabled={loading}>
          Run Decision Flow (INC-001)
        </FilledButton>
      </div>

      {result?.matched && (
        <div className="scenario-results">
          <Banner variant="success">
            Auto-approved under <strong>{result.matched.id} — {result.matched.name}</strong>:{" "}
            {result.matched.action} with a <strong>{result.matched.discount_pct}% discount</strong>.
          </Banner>
          <div className="scenario-summary" style={{ marginTop: 12 }}>
            <div className="scenario-stat safe">
              <div className="stat-number">{result.matched.discount_pct}%</div>
              <div className="stat-label">Discount Applied</div>
            </div>
            <div className="scenario-stat">
              <div className="stat-number">{result.candidates.length}</div>
              <div className="stat-label">Policies Matched</div>
            </div>
            <div className="scenario-stat safe">
              <div className="stat-number">0</div>
              <div className="stat-label">Humans Involved</div>
            </div>
          </div>
          <table className="data-table" style={{ marginTop: 12 }}>
            <tbody>
              <tr>
                <td style={{ fontWeight: 600 }}>Incident type</td>
                <td><code>damaged_in_transit</code> = policy's incident type</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600 }}>Tier</td>
                <td>Gold &ge; policy minimum Gold — the Premium Care policy beats Standard Care ({result.candidates.length} candidates, highest tier requirement wins)</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600 }}>Recency</td>
                <td>reported {result.incident.reported_at}, within {result.matched.max_recency_days} days</td>
              </tr>
            </tbody>
          </table>
          {graph.nodes.length > 0 && <DecisionGraph nodes={graph.nodes} rels={graph.rels} />}
        </div>
      )}
    </ScenarioCard>
  );
}

// ─── Act 2: Policy gap → human decision → precedent ───────────

function Case2Scenario({ onAdvance }: { onAdvance: () => void }) {
  const [policyResult, setPolicyResult] = useState<MatchPolicyResult | null>(null);
  const [search, setSearch] = useState<PrecedentSearch | null>(null);
  const [decision, setDecision] = useState<RecordDecisionResult | null>(null);
  const [graph, setGraph] = useState<DecisionGraphData>({ nodes: [], rels: [] });
  const [loading, setLoading] = useState(false);
  const [discountPct, setDiscountPct] = useState(CASE_2_DEFAULTS.discountPct);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      setPolicyResult(await matchAndApplyPolicy(CASE_2_INCIDENT));
      setSearch(await findPrecedents(CASE_2_INCIDENT));
    } finally {
      setLoading(false);
    }
  }, []);

  const decide = useCallback(async () => {
    setLoading(true);
    try {
      const result = await recordDecision(
        CASE_2_INCIDENT,
        CASE_2_DEFAULTS.humanName,
        CASE_2_DEFAULTS.action,
        discountPct,
        CASE_2_DEFAULTS.rationale
      );
      setDecision(result);
      setGraph(await getDecisionGraph(CASE_2_INCIDENT));
      onAdvance();
    } finally {
      setLoading(false);
    }
  }, [discountPct, onAdvance]);

  return (
    <ScenarioCard>
      <div className="scenario-header">
        <div className="scenario-number">2</div>
        <div>
          <h3>Policy Gap — Escalate, and the Decision Becomes Precedent</h3>
          <p className="scenario-desc">
            Léa Moreau (<strong>Standard</strong>) reports{" "}
            <strong>damaged packaging — but the serum inside is intact and usable</strong>.
            Policies were written for damaged <em>products</em>, not damaged{" "}
            <em>packaging</em>: nothing matches. The system checks past jurisprudence,
            finds nothing close enough, and proposes options to a human instead of
            guessing. The human's decision is written back as a{" "}
            <code>Precedent</code>.
          </p>
        </div>
      </div>

      <div className="scenario-controls">
        <FilledButton size="small" onClick={run} isLoading={loading && !search} isDisabled={loading || !!search}>
          Run Decision Flow (INC-101)
        </FilledButton>
      </div>

      {policyResult && !policyResult.matched && (
        <div className="scenario-results">
          <Banner variant="warning">
            <strong>Step 1 — Policy engine:</strong> no policy covers{" "}
            <code>packaging_damaged_product_usable</code>. This is a coverage gap.
          </Banner>

          {search && (
            <>
              <Banner variant="warning">
                <strong>Step 2 — Precedent search:</strong> {search.rejected.length} precedents
                examined, none applicable ({search.rejected.map((r) => r.precedent.incident_type).join(", ")} —
                all different incident types). Escalating.
              </Banner>

              {!decision ? (
                <div className="card" style={{ marginTop: 12, borderColor: "#ffcc80", background: "#fffdf7" }}>
                  <h4>Step 3 — {CASE_2_DEFAULTS.humanName}, Customer Care Lead, decides:</h4>
                  <div style={{ fontSize: 14, marginBottom: 8 }}>
                    <em>"{CASE_2_DEFAULTS.rationale}"</em>
                  </div>
                  <div className="scenario-controls">
                    <label>
                      Goodwill discount:
                      <input
                        type="range"
                        min={0}
                        max={30}
                        step={5}
                        value={discountPct}
                        onChange={(e) => setDiscountPct(parseInt(e.target.value))}
                      />
                      <span className="scenario-value">{discountPct}%</span>
                    </label>
                    <FilledButton size="small" onClick={decide} isLoading={loading} isDisabled={loading}>
                      Record Decision &amp; Create Precedent
                    </FilledButton>
                  </div>
                </div>
              ) : (
                <>
                  <Banner variant="success">
                    Decision recorded — and it is now{" "}
                    <strong style={{ fontFamily: "monospace" }}>{decision.precedent.id}</strong>:
                    reusable jurisprudence, established by {decision.human.name}, refining the
                    policy gap. The next equivalent case will cite it automatically.
                  </Banner>
                  {graph.nodes.length > 0 && <DecisionGraph nodes={graph.nodes} rels={graph.rels} />}
                </>
              )}
            </>
          )}
        </div>
      )}
    </ScenarioCard>
  );
}

// ─── Act 3: Precedent reused automatically ────────────────────

function Case3Scenario({ enabled }: { enabled: boolean }) {
  const [policyResult, setPolicyResult] = useState<MatchPolicyResult | null>(null);
  const [search, setSearch] = useState<PrecedentSearch | null>(null);
  const [applied, setApplied] = useState<ApplyPrecedentResult | null>(null);
  const [graph, setGraph] = useState<DecisionGraphData>({ nodes: [], rels: [] });
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      setPolicyResult(await matchAndApplyPolicy(CASE_3_INCIDENT));
      const s = await findPrecedents(CASE_3_INCIDENT);
      setSearch(s);
      if (s && s.applicable.length > 0) {
        const result = await applyPrecedent(CASE_3_INCIDENT, s.applicable[0].precedent.id);
        setApplied(result);
        setGraph(await getDecisionGraph(CASE_3_INCIDENT));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <ScenarioCard>
      <div className="scenario-header">
        <div className="scenario-number">3</div>
        <div>
          <h3>Same Case Again — Auto-Resolved, Citing the Precedent</h3>
          <p className="scenario-desc">
            Nina Rousseau (<strong>Standard</strong>) reports the exact same situation:{" "}
            <strong>packaging damaged, product usable</strong>. Still no policy — but this
            time the precedent search finds the decision from Act 2 and resolves
            automatically, citing it: same incident type, same-or-higher tier, most
            recent first. The loop closes.
          </p>
        </div>
      </div>

      <div className="scenario-controls">
        <FilledButton size="small" onClick={run} isLoading={loading} isDisabled={loading || !enabled || !!applied}>
          Run Decision Flow (INC-102)
        </FilledButton>
        {!enabled && (
          <span style={{ fontSize: 13, color: "#999" }}>
            Run Act 2 first — the precedent doesn't exist yet.
          </span>
        )}
      </div>

      {policyResult && (
        <div className="scenario-results">
          <Banner variant="warning">
            <strong>Step 1 — Policy engine:</strong> still no policy for{" "}
            <code>packaging_damaged_product_usable</code>.
          </Banner>
          {search && search.applicable.length > 0 && (
            <Banner variant="info">
              <strong>Step 2 — Precedent search:</strong> found{" "}
              <strong style={{ fontFamily: "monospace" }}>{search.applicable[0].precedent.id}</strong>{" "}
              — same incident type, tier OK, established{" "}
              {search.applicable[0].precedent.established_at}.
            </Banner>
          )}
          {applied && (
            <>
              <Banner variant="success">
                <strong>{applied.statement}</strong> Action: {applied.precedent.action},{" "}
                {applied.precedent.discount_pct}% discount — identical treatment, zero
                re-escalation.
              </Banner>
              <div style={{ marginTop: 8, fontSize: 13, color: "#666" }}>
                Citation written to the graph:{" "}
                <code>({applied.precedent.id})-[:CITED_BY]-&gt;({applied.caseId})</code> — the
                precedent's reuse is itself auditable.
              </div>
              {graph.nodes.length > 0 && <DecisionGraph nodes={graph.nodes} rels={graph.rels} />}
            </>
          )}
        </div>
      )}
    </ScenarioCard>
  );
}

// ─── Main Scenarios Tab ────────────────────────────────────────

export default function ScenariosTab() {
  const [state, setState] = useState<ScenarioState | null>(null);
  const [resetting, setResetting] = useState(false);
  const [epoch, setEpoch] = useState(0); // bump to remount cards after reset

  const refresh = useCallback(() => {
    getScenarioState().then(setState);
  }, []);

  useEffect(refresh, [refresh]);

  const doReset = useCallback(async () => {
    setResetting(true);
    try {
      await resetScenarios();
      setEpoch((e) => e + 1);
      refresh();
    } finally {
      setResetting(false);
    }
  }, [refresh]);

  const precedentExists = (state?.livePrecedents.length ?? 0) > 0 || (state?.inc101Resolved ?? false);

  return (
    <div>
      <div style={{ marginBottom: 24, display: "flex", alignItems: "flex-start", gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, color: "#0b297d", display: "flex", alignItems: "center", gap: 8 }}>
            <span>The Jurisprudence Loop — 3 Acts</span>
            <UseCaseExplainer slides={SCENARIOS_SLIDES} />
          </h2>
          <p style={{ color: "#666", fontSize: 14, marginTop: 4 }}>
            Act 1: a policy covers it. Act 2: nothing covers it — a human decides, and the
            decision becomes a precedent. Act 3: the precedent is cited automatically.
            Every step is one deterministic Cypher traversal, visible in the audit drawer.
          </p>
        </div>
        <OutlinedButton size="small" onClick={doReset} isLoading={resetting} isDisabled={resetting}>
          Reset Demo State
        </OutlinedButton>
      </div>

      <div key={epoch}>
        <Case1Scenario onAdvance={refresh} />
        <Case2Scenario onAdvance={refresh} />
        <Case3Scenario enabled={precedentExists} />
      </div>
    </div>
  );
}
