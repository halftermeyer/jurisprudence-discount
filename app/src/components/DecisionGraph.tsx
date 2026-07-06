import type { DecisionGraphNode, DecisionGraphRel } from "../lib/queries";

// Hand-rolled SVG rendering (instead of NVL) — deliberately: the decision
// path is a small, fixed-shape graph, and the demo needs labels that are
// always readable on a projector at any size. Deterministic tiered layout,
// zero rendering surprises.

const TYPE_COLORS: Record<string, string> = {
  Customer: "#0b297d",
  Order: "#006fd6",
  Incident: "#e65100",
  Policy: "#00b4d8",
  Precedent: "#8e24aa",
  Human: "#2e7d32",
  Case: "#607d8b",
};

const TYPE_RADIUS: Record<string, number> = {
  Customer: 26,
  Order: 20,
  Incident: 24,
  Policy: 22,
  Precedent: 24,
  Human: 20,
  Case: 18,
};

// Vertical tiers: the story reads top to bottom.
const TIER_ORDER = ["Customer", "Order", "Incident", "Case", "Precedent", "Policy", "Human"];
const TIER_Y: Record<string, number> = {
  Customer: 60,
  Order: 160,
  Incident: 260,
  Case: 360,
  Precedent: 460,
  Policy: 460,
  Human: 560,
};

const WIDTH = 1000;
const HEIGHT = 620;

interface Props {
  nodes: DecisionGraphNode[];
  rels: DecisionGraphRel[];
}

export default function DecisionGraph({ nodes, rels }: Props) {
  if (nodes.length === 0) {
    return (
      <div
        className="graph-container"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#999",
        }}
      >
        Run a decision to see its justification path
      </div>
    );
  }

  // Assign coordinates: nodes of the same type spread horizontally per tier.
  // Policy and Precedent share a tier — spread them together.
  const tierMembers: Record<number, DecisionGraphNode[]> = {};
  nodes.forEach((n) => {
    const y = TIER_Y[n.type] ?? 360;
    if (!tierMembers[y]) tierMembers[y] = [];
    tierMembers[y].push(n);
  });
  Object.values(tierMembers).forEach((members) =>
    members.sort(
      (a, b) => TIER_ORDER.indexOf(a.type) - TIER_ORDER.indexOf(b.type)
    )
  );

  const pos: Record<string, { x: number; y: number }> = {};
  Object.entries(tierMembers).forEach(([y, members]) => {
    members.forEach((n, idx) => {
      const x = (WIDTH * (idx + 1)) / (members.length + 1);
      pos[n.id] = { x, y: Number(y) };
    });
  });

  return (
    <div className="graph-container" style={{ height: "auto" }}>
      <div
        style={{
          padding: "8px 12px",
          background: "#f5f5f5",
          borderBottom: "1px solid #e0e0e0",
          display: "flex",
          gap: 16,
          fontSize: 12,
          flexWrap: "wrap",
        }}
      >
        {Object.entries(TYPE_COLORS)
          .filter(([type]) => nodes.some((n) => n.type === type))
          .map(([type, color]) => (
            <span key={type} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: color,
                  display: "inline-block",
                }}
              />
              {type}
            </span>
          ))}
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        style={{ width: "100%", height: "auto", display: "block", background: "#fcfdfe" }}
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#90a4ae" />
          </marker>
        </defs>

        {rels.map((r, i) => {
          const from = pos[r.source];
          const to = pos[r.target];
          if (!from || !to) return null;
          // shorten the line so the arrowhead stops at the node edge
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const rFrom = TYPE_RADIUS[nodes.find((n) => n.id === r.source)?.type ?? ""] ?? 20;
          const rTo = TYPE_RADIUS[nodes.find((n) => n.id === r.target)?.type ?? ""] ?? 20;
          const x1 = from.x + (dx / len) * (rFrom + 2);
          const y1 = from.y + (dy / len) * (rFrom + 2);
          const x2 = to.x - (dx / len) * (rTo + 6);
          const y2 = to.y - (dy / len) * (rTo + 6);
          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2;
          return (
            <g key={i}>
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="#90a4ae"
                strokeWidth={1.5}
                markerEnd="url(#arrow)"
              />
              <rect
                x={midX - r.type.length * 3.6 - 4}
                y={midY - 9}
                width={r.type.length * 7.2 + 8}
                height={16}
                rx={8}
                fill="#ffffff"
                stroke="#cfd8dc"
                strokeWidth={0.75}
              />
              <text
                x={midX}
                y={midY + 3.5}
                textAnchor="middle"
                fontSize={10.5}
                fontFamily="ui-monospace, monospace"
                fill="#546e7a"
              >
                {r.type}
              </text>
            </g>
          );
        })}

        {nodes.map((n) => {
          const p = pos[n.id];
          if (!p) return null;
          const r = TYPE_RADIUS[n.type] ?? 20;
          return (
            <g key={n.id}>
              <circle cx={p.x} cy={p.y} r={r} fill={TYPE_COLORS[n.type] ?? "#999"} />
              <text
                x={p.x}
                y={p.y + 4}
                textAnchor="middle"
                fontSize={10}
                fontWeight={700}
                fill="#ffffff"
              >
                {n.type === "Customer" ? "C" : n.type[0] + n.type[1].toLowerCase()}
              </text>
              <text
                x={p.x}
                y={p.y + r + 18}
                textAnchor="middle"
                fontSize={13}
                fontWeight={600}
                fill="#37474f"
              >
                {n.label.length > 46 ? n.label.slice(0, 43) + "…" : n.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
