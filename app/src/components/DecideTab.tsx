import { useState, useEffect, useCallback } from "react";
import { FilledButton, OutlinedButton, Banner } from "@neo4j-ndl/react";
import UseCaseExplainer, { DECIDE_SLIDES } from "./UseCaseExplainer";
import DecisionGraph from "./DecisionGraph";
import {
  getOpenIncidents,
  getHumans,
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
  type Human,
} from "../lib/queries";

type OpenIncident = Awaited<ReturnType<typeof getOpenIncidents>>[number];

export default function DecideTab() {
  const [openIncidents, setOpenIncidents] = useState<OpenIncident[]>([]);
  const [humans, setHumans] = useState<Human[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [running, setRunning] = useState(false);

  const [policyResult, setPolicyResult] = useState<MatchPolicyResult | null>(null);
  const [precedentSearch, setPrecedentSearch] = useState<PrecedentSearch | null>(null);
  const [applied, setApplied] = useState<ApplyPrecedentResult | null>(null);
  const [decision, setDecision] = useState<RecordDecisionResult | null>(null);
  const [graph, setGraph] = useState<DecisionGraphData>({ nodes: [], rels: [] });

  // escalation form
  const [humanName, setHumanName] = useState("");
  const [action, setAction] = useState("goodwill_discount_no_replacement");
  const [discountPct, setDiscountPct] = useState(10);
  const [rationale, setRationale] = useState("");

  const refresh = useCallback(() => {
    getOpenIncidents().then((rows) => {
      setOpenIncidents(rows);
      setSelectedId((prev) =>
        rows.some((r) => r.incident.id === prev) ? prev : (rows[0]?.incident.id ?? "")
      );
    });
    getHumans().then((hs) => {
      setHumans(hs);
      setHumanName((prev) => prev || hs[0]?.name || "");
    });
  }, []);

  useEffect(refresh, [refresh]);

  const reset = () => {
    setPolicyResult(null);
    setPrecedentSearch(null);
    setApplied(null);
    setDecision(null);
    setGraph({ nodes: [], rels: [] });
  };

  const run = useCallback(async () => {
    if (!selectedId) return;
    setRunning(true);
    reset();
    try {
      // Step 1 — policy engine
      const match = await matchAndApplyPolicy(selectedId);
      setPolicyResult(match);
      if (match?.matched) {
        setGraph(await getDecisionGraph(selectedId));
      } else {
        // Step 2 — jurisprudence
        const search = await findPrecedents(selectedId);
        setPrecedentSearch(search);
      }
    } finally {
      setRunning(false);
    }
  }, [selectedId]);

  const doApplyPrecedent = useCallback(
    async (precedentId: string) => {
      setRunning(true);
      try {
        const result = await applyPrecedent(selectedId, precedentId);
        setApplied(result);
        setGraph(await getDecisionGraph(selectedId));
        refresh();
      } finally {
        setRunning(false);
      }
    },
    [selectedId, refresh]
  );

  const doRecordDecision = useCallback(async () => {
    setRunning(true);
    try {
      const result = await recordDecision(selectedId, humanName, action, discountPct, rationale);
      setDecision(result);
      setGraph(await getDecisionGraph(selectedId));
      refresh();
    } finally {
      setRunning(false);
    }
  }, [selectedId, humanName, action, discountPct, rationale, refresh]);

  const selected = openIncidents.find((r) => r.incident.id === selectedId);
  const escalationNeeded =
    precedentSearch && precedentSearch.applicable.length === 0 && !decision;

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: "#0b297d", display: "flex", alignItems: "center", gap: 8 }}>
          <span>Live Decision Flow</span>
          <UseCaseExplainer slides={DECIDE_SLIDES} />
        </h2>
        <p style={{ color: "#666", fontSize: 14, marginTop: 4 }}>
          Policy match &rarr; precedent search &rarr; human escalation. Deterministic,
          explainable, and every human decision becomes reusable jurisprudence.
        </p>
      </div>

      <div className="card">
        <div className="scenario-controls" style={{ marginBottom: 0 }}>
          <select
            value={selectedId}
            onChange={(e) => { setSelectedId(e.target.value); reset(); }}
            style={{ padding: "6px 12px", borderRadius: 4, border: "1px solid #ccc", fontSize: 14, maxWidth: 520 }}
          >
            {openIncidents.length === 0 && <option value="">No open incidents</option>}
            {openIncidents.map((r) => (
              <option key={r.incident.id} value={r.incident.id}>
                {r.incident.id} — {r.incident.type} — {r.customer.name} ({r.customer.tier}) — {r.order.product_name}
              </option>
            ))}
          </select>
          <FilledButton size="small" onClick={run} isLoading={running} isDisabled={running || !selectedId}>
            Run Decision Flow
          </FilledButton>
        </div>
        {selected && (
          <div style={{ marginTop: 10, fontSize: 13, color: "#666" }}>
            {selected.incident.description}
          </div>
        )}
      </div>

      {/* Step 1 result */}
      {policyResult && (
        <div className="card">
          <h3>Step 1 — Policy Engine</h3>
          {policyResult.matched ? (
            <>
              <Banner variant="success">
                Auto-approved under <strong>{policyResult.matched.id} — {policyResult.matched.name}</strong>:{" "}
                {policyResult.matched.action}
                {policyResult.matched.discount_pct != null && policyResult.matched.discount_pct > 0 &&
                  ` with a ${policyResult.matched.discount_pct}% discount`}. No human involved.
              </Banner>
              <table className="data-table" style={{ marginTop: 12 }}>
                <tbody>
                  <tr>
                    <td style={{ fontWeight: 600 }}>Incident type</td>
                    <td>
                      <code>{policyResult.incident.type}</code> = policy's <code>{policyResult.matched.incident_type}</code>
                    </td>
                  </tr>
                  <tr>
                    <td style={{ fontWeight: 600 }}>Customer tier</td>
                    <td>
                      {policyResult.customer.tier} &ge; policy minimum {policyResult.matched.min_tier}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ fontWeight: 600 }}>Recency</td>
                    <td>
                      reported {policyResult.incident.reported_at}, within {policyResult.matched.max_recency_days} days
                    </td>
                  </tr>
                  {policyResult.candidates.length > 1 && (
                    <tr>
                      <td style={{ fontWeight: 600 }}>Also matched</td>
                      <td>
                        {policyResult.candidates.slice(1).map((p) => (
                          <span key={p.id} className="chip">{p.id} ({p.discount_pct}%)</span>
                        ))}{" "}
                        <span style={{ color: "#999", fontSize: 12 }}>
                          — highest tier requirement wins
                        </span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          ) : (
            <Banner variant="warning">
              No written policy covers <code>{policyResult.incident.type}</code> for this
              customer — checking jurisprudence next.
            </Banner>
          )}
        </div>
      )}

      {/* Step 2 result */}
      {precedentSearch && !applied && (
        <div className="card">
          <h3>Step 2 — Precedent Search</h3>
          {precedentSearch.applicable.length > 0 ? (
            <>
              <Banner variant="info">
                {precedentSearch.applicable.length} applicable precedent
                {precedentSearch.applicable.length > 1 ? "s" : ""} found — most recent first.
              </Banner>
              {precedentSearch.applicable.map(({ precedent: pr, established_by }) => (
                <div key={pr.id} className="card" style={{ marginTop: 8, background: "#faf5fc", borderColor: "#e1bee7" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong style={{ color: "#8e24aa", fontFamily: "monospace" }}>{pr.id}</strong>
                    <span className="chip">{pr.incident_type}</span>
                    <span className="chip">{pr.min_tier}+</span>
                    <span style={{ fontSize: 13 }}>
                      {pr.action} · <strong>{pr.discount_pct}%</strong>
                    </span>
                    <span style={{ color: "#666", fontSize: 12 }}>
                      established by {established_by.name} on {pr.established_at}
                    </span>
                    <OutlinedButton
                      size="small"
                      onClick={() => doApplyPrecedent(pr.id)}
                      isDisabled={running}
                    >
                      Apply Precedent
                    </OutlinedButton>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 13, color: "#555", fontStyle: "italic" }}>
                    "{pr.rationale}"
                  </div>
                </div>
              ))}
            </>
          ) : (
            <Banner variant="warning">
              {precedentSearch.rejected.length} precedent
              {precedentSearch.rejected.length !== 1 ? "s" : ""} examined — none close enough.
              Escalating to a human.
            </Banner>
          )}
          {precedentSearch.rejected.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#999", textTransform: "uppercase", letterSpacing: 0.5 }}>
                Considered but rejected
              </div>
              {precedentSearch.rejected.map(({ precedent: pr, same_type }) => (
                <div key={pr.id} style={{ fontSize: 13, marginTop: 4 }}>
                  <span style={{ fontFamily: "monospace" }}>{pr.id}</span>{" "}
                  <span className="chip">{pr.incident_type}</span>{" "}
                  <span className="status-fail">
                    {same_type ? "customer tier below minimum" : "different incident type"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Step 3 — escalation form */}
      {escalationNeeded && (
        <div className="card" style={{ borderColor: "#ffcc80", background: "#fffdf7" }}>
          <h3>Step 3 — Human Decision (this will become a precedent)</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 640 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
              Decided by
              <select
                value={humanName}
                onChange={(e) => setHumanName(e.target.value)}
                style={{ padding: "6px 12px", borderRadius: 4, border: "1px solid #ccc", fontSize: 14 }}
              >
                {humans.map((h) => (
                  <option key={h.id} value={h.name}>{h.name} — {h.role}</option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
              Action
              <input
                type="text"
                value={action}
                onChange={(e) => setAction(e.target.value)}
                style={{ flex: 1, padding: "6px 12px", borderRadius: 4, border: "1px solid #ccc", fontSize: 14 }}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
              Discount
              <input
                type="range"
                min={0}
                max={50}
                step={5}
                value={discountPct}
                onChange={(e) => setDiscountPct(parseInt(e.target.value))}
              />
              <span className="scenario-value">{discountPct}%</span>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 14 }}>
              Rationale (stored on the precedent)
              <textarea
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                rows={2}
                style={{ padding: "6px 12px", borderRadius: 4, border: "1px solid #ccc", fontSize: 14, fontFamily: "inherit" }}
              />
            </label>
            <div>
              <FilledButton
                size="small"
                onClick={doRecordDecision}
                isLoading={running}
                isDisabled={running || !humanName || !action || !rationale}
              >
                Record Decision &amp; Create Precedent
              </FilledButton>
            </div>
          </div>
        </div>
      )}

      {/* Outcomes */}
      {applied && (
        <div className="card">
          <Banner variant="success">{applied.statement}</Banner>
          <div style={{ marginTop: 8, fontSize: 13 }}>
            Case <strong>{applied.caseId}</strong> opened and resolved:{" "}
            {applied.precedent.action} with a {applied.precedent.discount_pct}% discount.
            Citation written: <code>({applied.precedent.id})-[:CITED_BY]-&gt;({applied.caseId})</code>
          </div>
        </div>
      )}
      {decision && (
        <div className="card">
          <Banner variant="success">
            {decision.human.name} decided: {decision.precedent.action} ({decision.precedent.discount_pct}%
            discount). This decision is now precedent{" "}
            <strong style={{ fontFamily: "monospace" }}>{decision.precedent.id}</strong> — the next
            equivalent case will cite it automatically.
          </Banner>
        </div>
      )}

      {graph.nodes.length > 0 && (
        <div className="card">
          <h3>Decision Path</h3>
          <DecisionGraph nodes={graph.nodes} rels={graph.rels} />
        </div>
      )}
    </div>
  );
}
