#!/usr/bin/env python3
"""Rehearsal harness: run Case 1 -> Case 2 -> Case 3 end to end against a
freshly reloaded database, via the same tool functions the MCP server exposes.

Usage: python rehearse.py [--quiet]
Exits non-zero if any act does not produce the expected decision.
"""

import json
import sys

import mcp_server as srv

QUIET = "--quiet" in sys.argv


def call(fn, **kwargs):
    raw = fn(**kwargs)
    data = json.loads(raw)
    if not QUIET:
        label = next(k for k in data if k != "cypher_audit_trail")
        print(f"\n=== {fn.__name__}({kwargs}) -> {label} ===")
        print(json.dumps(data[label], indent=2, default=str)[:1500])
    return data


def expect(cond, msg):
    if not cond:
        print(f"\nFAILED: {msg}")
        sys.exit(1)
    print(f"OK: {msg}")


# Fresh reload
data = call(srv.load_demo.fn if hasattr(srv.load_demo, "fn") else srv.load_demo)
expect(data["load_result"]["statements_failed"] == 0, "demo reloaded with 0 failed statements")


def tool(name):
    t = getattr(srv, name)
    return t.fn if hasattr(t, "fn") else t


# ── Act 1: Gold customer, damaged in transit -> auto-approved by policy ──
r1 = call(tool("match_policy"), incident_id="INC-001")["match_result"]
expect(r1["decision"] == "auto_approved_by_policy", "Case 1 auto-approved by policy")
expect(r1["matched_policy"]["id"] == "POL-002", "Case 1 matched POL-002 (Premium Care, Gold)")
e1 = call(tool("explain_decision"), incident_id="INC-001")["explanation"]
expect(e1["resolution"] == "auto_approved_by_policy", "Case 1 explanation cites the policy")

# ── Act 2: packaging damaged, product usable -> no policy, escalate ──
r2 = call(tool("match_policy"), incident_id="INC-101")["match_result"]
expect(r2["decision"] == "no_policy_match", "Case 2 matches no policy")
p2 = call(tool("find_precedents"), incident_id="INC-101")["precedent_search"]
expect(len(p2["applicable_precedents"]) == 0, "Case 2 finds no applicable precedent")
expect(len(p2["considered_but_rejected"]) >= 2, "Case 2 considered (and rejected) the seeded precedents")
d2 = call(
    tool("record_decision"),
    incident_id="INC-101",
    human_name="Sophie Marchand",
    action="goodwill_discount_no_replacement",
    discount_pct=10,
    rationale="Product intact and usable; packaging damage only. 10% goodwill discount, no replacement shipment.",
)["decision_result"]
expect(d2["decision"] == "resolved_by_human_decision", "Case 2 resolved by human decision")
new_pr = d2["new_precedent"]["id"]
expect(new_pr.startswith("PR-"), f"Case 2 decision became precedent {new_pr}")
expect(d2["decided_by"]["id"] == "HUM-001", "decision attributed to existing Sophie Marchand node (no duplicate)")

# ── Act 3: same incident type -> auto-resolved citing the precedent ──
r3 = call(tool("match_policy"), incident_id="INC-102")["match_result"]
expect(r3["decision"] == "no_policy_match", "Case 3 matches no policy")
p3 = call(tool("find_precedents"), incident_id="INC-102")["precedent_search"]
expect(
    len(p3["applicable_precedents"]) == 1
    and p3["applicable_precedents"][0]["precedent"]["id"] == new_pr,
    f"Case 3 finds exactly the new precedent {new_pr}",
)
a3 = call(tool("apply_precedent"), incident_id="INC-102", precedent_id=new_pr)["apply_result"]
expect(a3["decision"] == "auto_resolved_by_precedent", "Case 3 auto-resolved citing the precedent")
expect("Sophie Marchand" in a3["statement"], "Case 3 statement credits the human who set the precedent")
e3 = call(tool("explain_decision"), incident_id="INC-102")["explanation"]
expect(e3["resolution"] == "auto_resolved_citing_precedent", "Case 3 explanation cites the precedent")
expect(len(e3["also_cited_by"]) >= 1, "CITED_BY edge written")

# ── journey sanity ──
j = call(tool("get_customer_journey"), customer_id="CUST-003")["journey"]
expect(j["orders"][0]["incidents"][0]["resolution_ref"] == new_pr, "journey shows precedent-based resolution")

print("\nALL ACTS PASSED")
