import { useState, useRef, useEffect, useCallback } from "react";
import { FilledButton, LoadingSpinner } from "@neo4j-ndl/react";
import { GoogleGenAI, Type, type FunctionDeclaration } from "@google/genai";
import {
  getCustomers,
  getCustomerJourney,
  getPolicies,
  getPrecedents,
  getOpenIncidents,
  matchAndApplyPolicy,
  findPrecedents,
  applyPrecedent,
  recordDecision,
  explainDecision,
} from "../lib/queries";
import { runQuery, getQueryLog } from "../lib/neo4j";
import UseCaseExplainer, { ASSISTANT_SLIDES } from "./UseCaseExplainer";

interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
}

const SYSTEM_PROMPT = `You are a customer-care decision assistant connected to a Neo4j
graph database. The graph holds customers (Standard/Gold/VIP tiers) with orders and
incidents, written discount policies (conditions as plain properties: incident_type,
min_tier, max_recency_days), and precedents — past human decisions that are reusable
jurisprudence, each linked to the human who established it.

For any open incident, ALWAYS follow the decision waterfall, in this order:
1. match_policy — a written policy covers it? It is auto-approved on the spot.
2. find_precedents — otherwise, look for applicable jurisprudence.
3. apply_precedent — an applicable precedent exists: resolve citing it, and name the
   human who established it and the date.
4. record_decision — nothing matches: ask the user (acting as Customer Care Lead) what
   to decide, then record it. Tell them their decision just became a reusable precedent.

NEVER invent a discount or resolution yourself: only a policy, a precedent, or an
explicit human decision can set one. When you resolve by precedent, always cite it
explicitly: "Resolved per precedent PR-0xx, established by <name> on <date> for an
equivalent case."

Be concise but informative. Use tables or bullet points for structured data.

Do NOT include the cypher_audit_trail in your response — the UI shows it separately in
a dedicated audit panel. Focus on interpreting the results for the user.`;

const TOOLS: FunctionDeclaration[] = [
  {
    name: "run_cypher",
    description:
      "Run a Cypher query against the Neo4j decision graph. Use for custom exploration. Nodes: Customer {id, name, tier}, Order {id, sku, product_name, amount, date}, Incident {id, type, description, reported_at, status, resolution_*}, Policy {id, name, incident_type, min_tier, max_recency_days, action, discount_pct}, Case, Human {id, name, role}, Precedent {id, incident_type, min_tier, action, discount_pct, rationale, established_at}. Relationships: HAD, AFFECTED_BY, CONCERNS, DECIDED_BY, ESTABLISHES, REFINES, CITED_BY.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        cypher: { type: Type.STRING, description: "The Cypher query to execute" },
      },
      required: ["cypher"],
    },
  },
  {
    name: "list_customers",
    description: "List all customers with tier, order count and open incident count.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_customer_journey",
    description: "Get a customer's orders, incidents, and how each was resolved.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        customer_id: { type: Type.STRING, description: "Customer id, e.g. CUST-001" },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "list_policies",
    description: "List all written discount policies with their matching conditions.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "list_precedents",
    description:
      "List all precedents (reusable jurisprudence) with who established them and citation counts.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "list_open_incidents",
    description: "List incidents that still need a decision.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "match_policy",
    description:
      "Step 1 of the decision flow. Check an open incident against all written policies (same incident_type, tier >= min_tier, within recency window). If a policy matches, the incident is AUTO-APPROVED immediately and the matched conditions are returned. If not, call find_precedents next.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        incident_id: { type: Type.STRING, description: "Incident id, e.g. INC-101" },
      },
      required: ["incident_id"],
    },
  },
  {
    name: "find_precedents",
    description:
      "Step 2. Search reusable jurisprudence for an incident: same incident_type, customer tier >= the precedent's min_tier, ranked by recency. Returns applicable precedents AND the ones considered but rejected (with the reason).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        incident_id: { type: Type.STRING, description: "Incident id" },
      },
      required: ["incident_id"],
    },
  },
  {
    name: "apply_precedent",
    description:
      "Step 3. Resolve an open incident citing an applicable precedent: opens a Case, writes the CITED_BY link, applies the precedent's action and discount.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        incident_id: { type: Type.STRING },
        precedent_id: { type: Type.STRING, description: "e.g. PR-003" },
      },
      required: ["incident_id", "precedent_id"],
    },
  },
  {
    name: "record_decision",
    description:
      "Step 4. Record a human decision for an incident nothing covers. Resolves the incident AND creates a new Precedent (reusable jurisprudence) established by the named human. Only call after the user has explicitly stated the decision.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        incident_id: { type: Type.STRING },
        human_name: { type: Type.STRING, description: "Who decided, e.g. Sophie Marchand" },
        action: { type: Type.STRING, description: "snake_case action, e.g. goodwill_discount_no_replacement" },
        discount_pct: { type: Type.NUMBER, description: "Discount percentage, e.g. 10" },
        rationale: { type: Type.STRING, description: "Why — stored on the precedent" },
      },
      required: ["incident_id", "human_name", "action", "discount_pct", "rationale"],
    },
  },
  {
    name: "explain_decision",
    description:
      "Explain WHY a resolved incident was decided the way it was: the policy or precedent that applied, the traversal path, and (for precedents) who established it and when.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        incident_id: { type: Type.STRING },
      },
      required: ["incident_id"],
    },
  },
];

async function executeToolInner(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case "run_cypher": {
      const results = await runQuery(args.cypher as string);
      return results.slice(0, 50);
    }
    case "list_customers":
      return await getCustomers();
    case "get_customer_journey":
      return await getCustomerJourney(args.customer_id as string);
    case "list_policies":
      return await getPolicies();
    case "list_precedents":
      return await getPrecedents();
    case "list_open_incidents":
      return await getOpenIncidents();
    case "match_policy": {
      const result = await matchAndApplyPolicy(args.incident_id as string);
      if (!result) return { error: `Incident '${args.incident_id}' not found` };
      return {
        decision: result.matched ? "auto_approved_by_policy" : "no_policy_match",
        ...result,
        next_step: result.matched ? "done — call explain_decision to narrate" : "call find_precedents",
      };
    }
    case "find_precedents": {
      const result = await findPrecedents(args.incident_id as string);
      if (!result) return { error: `Incident '${args.incident_id}' not found` };
      return {
        ...result,
        next_step:
          result.applicable.length > 0
            ? `call apply_precedent with precedent_id='${result.applicable[0].precedent.id}'`
            : "no applicable precedent — ask the human for a decision, then record_decision",
      };
    }
    case "apply_precedent":
      return await applyPrecedent(args.incident_id as string, args.precedent_id as string);
    case "record_decision":
      return await recordDecision(
        args.incident_id as string,
        args.human_name as string,
        args.action as string,
        args.discount_pct as number,
        args.rationale as string
      );
    case "explain_decision": {
      const result = await explainDecision(args.incident_id as string);
      return result ?? { error: `Incident '${args.incident_id}' not found` };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  // Snapshot log length before execution
  const logBefore = getQueryLog().length;

  const result = await executeToolInner(name, args);

  // Capture queries that ran during this tool call
  const logAfter = getQueryLog();
  const newEntries = logAfter.slice(logBefore);
  const auditTrail = newEntries
    .map((e, i) => {
      let trail = `// Step ${i + 1} (${e.durationMs}ms, ${e.rowCount} rows)\n`;
      if (Object.keys(e.params).length > 0) {
        const paramStr = Object.entries(e.params)
          .map(([k, v]) => {
            const val = typeof v === "string" && v.length > 100 ? v.substring(0, 100) + "..." : JSON.stringify(v);
            return `:param ${k} => ${val}`;
          })
          .join("\n");
        trail += paramStr + "\n";
      }
      trail += e.cypher;
      return trail;
    })
    .join("\n\n");

  const response = {
    results: result,
    cypher_audit_trail: auditTrail || "// No queries executed",
  };

  return JSON.stringify(response, null, 2);
}

export default function ChatTab() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || loading) return;

    const userMsg = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setLoading(true);

    try {
      const ai = new GoogleGenAI({ apiKey });

      const chatHistory = messages
        .filter((m) => m.role !== "tool")
        .map((m) => ({
          role: m.role === "user" ? ("user" as const) : ("model" as const),
          parts: [{ text: m.content }],
        }));

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          ...chatHistory,
          { role: "user", parts: [{ text: userMsg }] },
        ],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          tools: [{ functionDeclarations: TOOLS }],
        },
      });

      // Handle tool calls in a loop
      let currentResponse = response;
      const maxIterations = 6;

      for (let iter = 0; iter < maxIterations; iter++) {
        const candidate = currentResponse.candidates?.[0];
        if (!candidate) break;

        const parts = candidate.content?.parts || [];
        const functionCalls = parts.filter((p) => p.functionCall);

        if (functionCalls.length === 0) {
          // No more tool calls — extract text
          const text = parts
            .filter((p) => p.text)
            .map((p) => p.text)
            .join("");
          if (text) {
            setMessages((prev) => [...prev, { role: "assistant", content: text }]);
          }
          break;
        }

        // Execute tool calls and show them in the chat
        const toolResults = [];
        for (const part of functionCalls) {
          const fc = part.functionCall!;
          const argsPreview = Object.entries(fc.args as Record<string, unknown>)
            .map(([k, v]) => {
              const s = JSON.stringify(v);
              return `${k}: ${s.length > 60 ? s.substring(0, 60) + "..." : s}`;
            })
            .join(", ");
          setMessages((prev) => [
            ...prev,
            { role: "tool", content: argsPreview, toolName: fc.name! },
          ]);
          const result = await executeTool(fc.name!, fc.args as Record<string, unknown>);
          toolResults.push({
            functionResponse: {
              name: fc.name!,
              response: { result },
            },
          });
        }

        // Send tool results back
        currentResponse = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [
            ...chatHistory,
            { role: "user", parts: [{ text: userMsg }] },
            { role: "model", parts: parts },
            { role: "user", parts: toolResults },
          ],
          config: {
            systemInstruction: SYSTEM_PROMPT,
            tools: [{ functionDeclarations: TOOLS }],
          },
        });
      }
    } catch (e: unknown) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${(e as Error).message}` },
      ]);
    }

    setLoading(false);
  }, [input, loading, messages, apiKey]);

  if (!apiKey) {
    return (
      <div className="empty-state">
        <h3>Gemini API Key Required</h3>
        <p>Set <code>VITE_GEMINI_API_KEY</code> in <code>app/.env</code></p>
      </div>
    );
  }

  return (
    <div className="chat-container">
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-welcome">
            <h3 style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <span>Jurisprudence Assistant</span>
              <UseCaseExplainer slides={ASSISTANT_SLIDES} />
            </h3>
            <p>Ask me to handle open incidents, explain past decisions, or explore policies and precedents.</p>
          </div>
        )}

        <div className="chat-suggestions">
          {[
            "Which incidents still need a decision?",
            "Handle INC-001 — what does the customer get, and why?",
            "Handle INC-101. If nothing covers it, I'm Sophie Marchand: 10% goodwill discount, no replacement — the product is usable.",
            "Now handle INC-102.",
            "Why did INC-102 get 10%? Who decided that, originally?",
            "Show me all precedents and how often each has been cited.",
            "What's Camille Laurent's history with us?",
            "Which policy would apply if a VIP customer had a quality complaint?",
          ].map((s) => (
            <button
              key={s}
              className="chat-suggestion"
              onClick={() => {
                setInput(s);
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {messages.map((msg, i) => (
          <div key={i} className={`chat-message ${msg.role}`}>
            {msg.role === "tool" ? (
              <div className="chat-tool-call">
                <span className="chat-tool-icon">&#9881;</span>
                <span className="chat-tool-name">{msg.toolName}</span>
                <span className="chat-tool-args">{msg.content}</span>
              </div>
            ) : (
              <div className="chat-message-content">
                {msg.role === "assistant" ? (
                  <div
                    dangerouslySetInnerHTML={{
                      __html: formatMarkdown(msg.content),
                    }}
                  />
                ) : (
                  msg.content
                )}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="chat-message assistant">
            <div className="chat-message-content">
              <LoadingSpinner size="small" /> Thinking...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-bar">
        <input
          type="text"
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          placeholder="Handle an incident, explain a decision, explore precedents..."
          disabled={loading}
        />
        <FilledButton size="medium" onClick={sendMessage} isDisabled={loading || !input.trim()}>
          Send
        </FilledButton>
      </div>
    </div>
  );
}

function formatMarkdown(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="chat-code"><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br>");
}
