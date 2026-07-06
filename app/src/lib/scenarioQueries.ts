import { runQuery, withGroup } from "./neo4j";

// The three scripted incidents (fixed ids in data/load_data.cypher)
export const CASE_1_INCIDENT = "INC-001"; // Gold, damaged_in_transit -> POL-002
export const CASE_2_INCIDENT = "INC-101"; // Standard, packaging damaged -> escalate
export const CASE_3_INCIDENT = "INC-102"; // Standard, same type -> cites precedent

export const CASE_2_DEFAULTS = {
  humanName: "Sophie Marchand",
  action: "goodwill_discount_no_replacement",
  discountPct: 10,
  rationale:
    "Product intact and usable; packaging damage only. 10% goodwill discount, no replacement shipment.",
};

export interface ScenarioState {
  inc1Resolved: boolean;
  inc101Resolved: boolean;
  inc102Resolved: boolean;
  livePrecedents: { id: string; established_at: string }[];
}

/** Where are we in the 3-act script? (drives card enable/disable states) */
export async function getScenarioState(): Promise<ScenarioState> {
  const rows = await runQuery<{ id: string; status: string }>(`
    MATCH (i:Incident) WHERE i.id IN ['INC-001', 'INC-101', 'INC-102']
    RETURN i.id AS id, i.status AS status
  `);
  const status = (id: string) => rows.find((r) => r.id === id)?.status === "resolved";
  const prs = await runQuery<{ id: string; established_at: string }>(`
    MATCH (pr:Precedent {incident_type: 'packaging_damaged_product_usable'})
    RETURN pr.id AS id, toString(pr.established_at) AS established_at
  `);
  return {
    inc1Resolved: status("INC-001"),
    inc101Resolved: status("INC-101"),
    inc102Resolved: status("INC-102"),
    livePrecedents: prs,
  };
}

/** Rehearsal reset: reopen the 3 scripted incidents and delete everything the
 *  live run created (cases concerning them + the packaging-damage precedent).
 *  Pre-seeded data (PR-001/PR-002, CASE-201/202) is untouched. */
export async function resetScenarios(): Promise<void> {
  await withGroup("reset_scenarios()", async () => {
    await runQuery(`
      MATCH (cs:Case)-[:CONCERNS]->(i:Incident)
      WHERE i.id IN ['INC-001', 'INC-101', 'INC-102']
      DETACH DELETE cs
    `);
    await runQuery(`
      MATCH (pr:Precedent {incident_type: 'packaging_damaged_product_usable'})
      DETACH DELETE pr
    `);
    await runQuery(`
      MATCH (i:Incident) WHERE i.id IN ['INC-001', 'INC-101', 'INC-102']
      SET i.status = 'open'
      REMOVE i.resolution_type, i.resolution_ref, i.resolution_action,
             i.resolution_discount_pct, i.resolved_at
    `);
  });
}
