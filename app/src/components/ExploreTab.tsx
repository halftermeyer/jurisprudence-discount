import { useState, useEffect, useCallback } from "react";
import { LoadingSpinner, Banner } from "@neo4j-ndl/react";
import UseCaseExplainer, { EXPLORE_SLIDES } from "./UseCaseExplainer";
import {
  getCustomers,
  getCustomerJourney,
  getPolicies,
  getPrecedents,
  type Policy,
  type PrecedentRow,
  type JourneyEntry,
} from "../lib/queries";

type CustomerRow = Awaited<ReturnType<typeof getCustomers>>[number];

const TIER_STYLE: Record<string, React.CSSProperties> = {
  Standard: { background: "#eceff1", color: "#455a64" },
  Gold: { background: "#fff8e1", color: "#b58105" },
  VIP: { background: "#f3e5f5", color: "#8e24aa" },
};

function StatusChip({ incident }: { incident: { status: string; resolution_type?: string | null; resolution_ref?: string | null } }) {
  if (incident.status === "open") {
    return <span className="status-warn">OPEN</span>;
  }
  const by =
    incident.resolution_type === "policy"
      ? `policy ${incident.resolution_ref}`
      : incident.resolution_type === "precedent"
        ? `precedent ${incident.resolution_ref}`
        : `human → ${incident.resolution_ref}`;
  return <span className="status-pass">RESOLVED ({by})</span>;
}

export default function ExploreTab() {
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [precedents, setPrecedents] = useState<PrecedentRow[]>([]);
  const [selected, setSelected] = useState<CustomerRow | null>(null);
  const [journey, setJourney] = useState<JourneyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getCustomers(), getPolicies(), getPrecedents()])
      .then(([cs, ps, prs]) => {
        setCustomers(cs);
        setPolicies(ps);
        setPrecedents(prs);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const inspect = useCallback(async (c: CustomerRow) => {
    setSelected(c);
    try {
      setJourney(await getCustomerJourney(c.id));
    } catch {
      setJourney([]);
    }
  }, []);

  if (loading) {
    return (
      <div className="loading-container">
        <LoadingSpinner size="large" />
        Connecting to Neo4j...
      </div>
    );
  }

  if (error) {
    return <Banner variant="danger">{error}</Banner>;
  }

  const writtenPolicies = policies.filter((p) => p.id !== "POL-GAP");
  const gapPolicy = policies.find((p) => p.id === "POL-GAP");

  return (
    <div>
      <div className="card-row">
        {/* Customer portfolio */}
        <div className="card" style={{ flex: 1 }}>
          <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>Customers ({customers.length})</span>
            <UseCaseExplainer slides={EXPLORE_SLIDES} />
          </h3>
          <div style={{ maxHeight: 460, overflow: "auto" }}>
            {customers.map((c) => (
              <div
                key={c.id}
                style={{
                  padding: "6px 10px",
                  cursor: "pointer",
                  borderRadius: 4,
                  background: selected?.id === c.id ? "#e3f2fd" : "transparent",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                }}
                onClick={() => inspect(c)}
              >
                <strong style={{ flex: 1 }}>{c.name}</strong>
                <span className="chip" style={TIER_STYLE[c.tier]}>{c.tier}</span>
                <span style={{ color: "#999", fontSize: 12 }}>
                  {c.orderCount} orders
                </span>
                {c.openCount > 0 && (
                  <span className="status-warn">{c.openCount} open</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Journey panel */}
        <div className="card" style={{ flex: 1.4 }}>
          {selected ? (
            <div>
              <h3>
                {selected.name}{" "}
                <span className="chip" style={TIER_STYLE[selected.tier]}>
                  {selected.tier}
                </span>
              </h3>
              <div style={{ maxHeight: 440, overflow: "auto" }}>
                {journey.map((j) => (
                  <div key={j.order.id} className="card" style={{ marginBottom: 8, padding: 12 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                      <strong>{j.order.product_name}</strong>
                      <span style={{ color: "#999", fontSize: 12 }}>
                        {j.order.id} · {j.order.date} · €{j.order.amount.toFixed(2)}
                      </span>
                    </div>
                    {j.incidents.map((i) => (
                      <div key={i.id} style={{ marginTop: 6, fontSize: 13 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <span className="chip">{i.type}</span>
                          <StatusChip incident={i} />
                        </div>
                        <div style={{ color: "#666", marginTop: 4 }}>{i.description}</div>
                        {i.resolution_action && (
                          <div style={{ color: "#2e7d32", marginTop: 2, fontSize: 12 }}>
                            → {i.resolution_action}
                            {i.resolution_discount_pct != null &&
                              i.resolution_discount_pct > 0 &&
                              ` (${i.resolution_discount_pct}% discount)`}
                          </div>
                        )}
                      </div>
                    ))}
                    {j.incidents.length === 0 && (
                      <div style={{ color: "#999", fontSize: 12, marginTop: 4 }}>
                        Delivered without incident
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <h3>Select a customer</h3>
              <p>Click a customer to see their orders and incident history</p>
            </div>
          )}
        </div>
      </div>

      {/* Policies */}
      <div className="card">
        <h3>Written Policies ({writtenPolicies.length})</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>Id</th>
              <th>Name</th>
              <th>Incident type</th>
              <th>Min tier</th>
              <th>Recency</th>
              <th>Action</th>
              <th>Discount</th>
            </tr>
          </thead>
          <tbody>
            {writtenPolicies.map((p) => (
              <tr key={p.id}>
                <td style={{ fontFamily: "monospace" }}>{p.id}</td>
                <td style={{ fontWeight: 600 }}>{p.name}</td>
                <td><span className="chip">{p.incident_type}</span></td>
                <td><span className="chip" style={TIER_STYLE[p.min_tier]}>{p.min_tier}+</span></td>
                <td>{p.max_recency_days ? `${p.max_recency_days} days` : "—"}</td>
                <td style={{ fontSize: 12 }}>{p.action}</td>
                <td style={{ fontFamily: "monospace", fontWeight: 600 }}>
                  {p.discount_pct != null ? `${p.discount_pct}%` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {gapPolicy && (
          <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>
            <span className="chip" style={{ background: "#ffebee", color: "#c62828" }}>
              {gapPolicy.id}
            </span>{" "}
            {gapPolicy.description}
          </div>
        )}
      </div>

      {/* Precedents */}
      <div className="card">
        <h3>Precedents — Reusable Jurisprudence ({precedents.length})</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>Id</th>
              <th>Incident type</th>
              <th>Min tier</th>
              <th>Action</th>
              <th>Discount</th>
              <th>Established by</th>
              <th>Date</th>
              <th>Cited</th>
            </tr>
          </thead>
          <tbody>
            {precedents.map(({ precedent: pr, established_by, citedCount }) => (
              <tr key={pr.id}>
                <td style={{ fontFamily: "monospace", fontWeight: 600, color: "#8e24aa" }}>{pr.id}</td>
                <td><span className="chip">{pr.incident_type}</span></td>
                <td><span className="chip" style={TIER_STYLE[pr.min_tier]}>{pr.min_tier}+</span></td>
                <td style={{ fontSize: 12 }}>{pr.action}</td>
                <td style={{ fontFamily: "monospace", fontWeight: 600 }}>{pr.discount_pct}%</td>
                <td>
                  <strong>{established_by.name}</strong>{" "}
                  <span style={{ color: "#999", fontSize: 12 }}>({established_by.role})</span>
                </td>
                <td>{pr.established_at}</td>
                <td>
                  {citedCount > 0 ? (
                    <span className="status-pass">{citedCount}×</span>
                  ) : (
                    <span style={{ color: "#999" }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>
          Each precedent was established by a human for a case no policy covered. It is
          matched exactly like a policy — same incident type, tier at or above its
          minimum — and cited automatically.
        </div>
      </div>
    </div>
  );
}
