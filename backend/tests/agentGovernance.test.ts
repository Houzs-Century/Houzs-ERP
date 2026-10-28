import { describe, expect, test } from "vitest";
import {
  AUTHORITY,
  FAMILY_TO_SPEC,
  UNIMPLEMENTED_SPEC_AGENTS,
  SPEC_AGENT_STATUS,
  authorityFor,
  isNeverAutonomous,
  dataQualityGate,
  canSelfApprove,
  canSelfTuneConfig,
  PROMOTION_GATES,
  RUNTIME_STATES,
  type SpecAgentId,
} from "../src/services/agents/governance";

/* This module is the Agent Operating Spec made executable (docs/agents/
   operating-spec.md §11: "converted into a machine-readable Agent configuration
   rather than copied as one unstructured prompt"). These tests are what make
   that claim true — they pin the policy to the spec's own wording and prove the
   gate refuses the cases the spec marks "never autonomous", so that turning a
   family's auto-approve on can never become the blanket the spec forbids (§1.2). */

const ALL_AGENTS: SpecAgentId[] = [
  "HZS-OF-001", "HZS-DLV-002", "HZS-COM-003", "HZS-REP-004",
  "HZS-AR-005", "HZS-SI-006", "GROUP-GCOA-001",
];

describe("the matrix covers all seven spec agents", () => {
  test("every spec agent has an authority matrix with classes", () => {
    for (const a of ALL_AGENTS) {
      expect(AUTHORITY[a], a).toBeDefined();
      expect(Object.keys(AUTHORITY[a]).length, a).toBeGreaterThan(0);
    }
  });

  test("every decision row has all four columns filled (no silent gap)", () => {
    for (const a of ALL_AGENTS) {
      for (const [cls, row] of Object.entries(AUTHORITY[a])) {
        for (const col of ["stage1", "stage2", "stage3", "neverAutonomous"] as const) {
          expect(row[col].trim(), `${a}.${cls}.${col}`).not.toBe("");
        }
      }
    }
  });

  test("the family→spec map only points at agents that exist in the matrix", () => {
    for (const spec of Object.values(FAMILY_TO_SPEC)) {
      expect(AUTHORITY[spec!], spec).toBeDefined();
    }
  });

  test("the unimplemented list names exactly the agents with no code family", () => {
    // Honesty check: a NONE agent must not also claim a code family.
    const mapped = new Set(Object.values(FAMILY_TO_SPEC));
    for (const gap of UNIMPLEMENTED_SPEC_AGENTS) {
      expect(mapped.has(gap), `${gap} should not be mapped to a family yet`).toBe(false);
    }
  });

  /* The status map replaced a binary flag that went half-wrong in a day: #753
     shipped the GCOA's routing limb while the flag still said GCOA did not exist.
     These tests make the map self-policing so it cannot drift back into a
     confident-sounding lie about coverage. */
  test("every spec agent has a status entry — no silent omissions", () => {
    for (const spec of Object.values(FAMILY_TO_SPEC)) {
      expect(SPEC_AGENT_STATUS[spec!], `${spec} missing from SPEC_AGENT_STATUS`).toBeDefined();
    }
    for (const s of Object.values(SPEC_AGENT_STATUS)) {
      expect(["FULL", "PARTIAL", "NONE"]).toContain(s.status);
    }
  });

  test("PARTIAL must carry BOTH receipts — what runs and what does not", () => {
    // A PARTIAL with an empty `missing` is just FULL wearing a hedge; a PARTIAL
    // with an empty `implemented` is just NONE. Either way the reader is misled.
    for (const [id, s] of Object.entries(SPEC_AGENT_STATUS)) {
      if (s.status !== "PARTIAL") continue;
      expect(s.implemented.length, `${id}: PARTIAL with nothing implemented`).toBeGreaterThan(0);
      expect(s.missing.length, `${id}: PARTIAL with nothing missing`).toBeGreaterThan(0);
    }
  });

  test("FULL claims nothing is missing, NONE claims nothing runs", () => {
    for (const [id, s] of Object.entries(SPEC_AGENT_STATUS)) {
      if (s.status === "FULL") expect(s.missing, `${id}`).toEqual([]);
      if (s.status === "NONE") expect(s.implemented, `${id}`).toEqual([]);
    }
  });

  test("UNIMPLEMENTED_SPEC_AGENTS is DERIVED, so it cannot drift from the map", () => {
    const none = Object.entries(SPEC_AGENT_STATUS)
      .filter(([, s]) => s.status === "NONE")
      .map(([id]) => id);
    expect([...UNIMPLEMENTED_SPEC_AGENTS].sort()).toEqual(none.sort());
  });
});

describe("authorityFor", () => {
  test("returns the spec row verbatim", () => {
    // Spec §6.8, EXTERNAL_PO row — the one the procurement agent self-approves.
    const r = authorityFor("HZS-REP-004", "EXTERNAL_PO");
    expect(r).toEqual({
      stage1: "Approval",
      stage2: "Low-value catalogue within limit",
      stage3: "Automatic certified repeat",
      neverAutonomous: "New/high-value supplier",
    });
  });

  test("returns null for a class the agent does not own — not a false 'allowed'", () => {
    expect(authorityFor("HZS-REP-004", "SEND_SMS")).toBeNull();
  });
});

describe("isNeverAutonomous — the both-stages-refuse classes", () => {
  test("COM complaint resolution never self-executes", () => {
    expect(isNeverAutonomous(authorityFor("HZS-COM-003", "COMPLAINT_RESOLUTION")!)).toBe(true);
  });
  test("SI discount exception never self-executes", () => {
    expect(isNeverAutonomous(authorityFor("HZS-SI-006", "DISCOUNT_EXCEPTION")!)).toBe(true);
  });
  test("a normal class (procurement external PO) is NOT never-autonomous", () => {
    expect(isNeverAutonomous(authorityFor("HZS-REP-004", "EXTERNAL_PO")!)).toBe(false);
  });
});

describe("dataQualityGate — §10.2", () => {
  test("GREEN when complete/current/reconciled", () => {
    const v = dataQualityGate({});
    expect(v.status).toBe("GREEN");
    expect(v.mayExecuteIrreversible).toBe(true);
    expect(v.mustStop).toBe(false);
  });

  test("any RED signal stops material action and escalates", () => {
    for (const sig of [
      { missingSource: true }, { reconciliationFailed: true }, { duplicate: true },
      { companyMismatch: true }, { integrityAlert: true },
    ]) {
      const v = dataQualityGate(sig);
      expect(v.status, JSON.stringify(sig)).toBe("RED");
      expect(v.mustStop).toBe(true);
      expect(v.mayExecuteIrreversible).toBe(false);
    }
  });

  test("stale/minor is AMBER — analyse, disclose, no irreversible execution", () => {
    const v = dataQualityGate({ staleSnapshot: true });
    expect(v.status).toBe("AMBER");
    expect(v.mustDisclose).toBe(true);
    expect(v.mayExecuteIrreversible).toBe(false);
  });

  test("RED wins over AMBER when both are present", () => {
    expect(dataQualityGate({ staleSnapshot: true, duplicate: true }).status).toBe("RED");
  });
});

describe("canSelfApprove — 'auto-approve' is no longer a blanket (§1.2)", () => {
  const GREEN = "GREEN" as const;

  test("a normal low-value reorder at Stage 2 on green data self-approves", () => {
    const v = canSelfApprove({
      agent: "HZS-REP-004", decisionClass: "EXTERNAL_PO", stage: 2,
      dataQuality: GREEN, valueProxy: 40, limit: 200, counterpartyKnown: true,
    });
    expect(v.ok).toBe(true);
  });

  test("Stage 1 never self-approves — approval is the human role", () => {
    const v = canSelfApprove({ agent: "HZS-REP-004", decisionClass: "EXTERNAL_PO", stage: 1, dataQuality: GREEN });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/Stage 1/);
  });

  test("a NEVER-autonomous class is refused even at Stage 3 with perfect data", () => {
    // The whole point of encoding the matrix: Stage 3 is not "anything goes".
    const v = canSelfApprove({ agent: "HZS-COM-003", decisionClass: "COMPLAINT_RESOLUTION", stage: 3, dataQuality: GREEN });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/never autonomous/i);
  });

  test("RED data blocks self-approval at every stage", () => {
    const v = canSelfApprove({ agent: "HZS-REP-004", decisionClass: "EXTERNAL_PO", stage: 3, dataQuality: "RED", valueProxy: 1, limit: 999 });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/RED/);
  });

  test("AMBER data blocks self-approval of an irreversible action", () => {
    const v = canSelfApprove({ agent: "HZS-REP-004", decisionClass: "EXTERNAL_PO", stage: 2, dataQuality: "AMBER", valueProxy: 1, limit: 999 });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/AMBER/);
  });

  test("a new counterparty is never autonomous for external PO", () => {
    const v = canSelfApprove({
      agent: "HZS-REP-004", decisionClass: "EXTERNAL_PO", stage: 2,
      dataQuality: GREEN, valueProxy: 10, limit: 200, counterpartyKnown: false,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/new/i);
  });

  test("over the Stage-2 size limit hands back to a human", () => {
    const v = canSelfApprove({
      agent: "HZS-REP-004", decisionClass: "EXTERNAL_PO", stage: 2,
      dataQuality: GREEN, valueProxy: 5000, limit: 200, counterpartyKnown: true,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/exceeds/);
  });

  test("an unknown decision class is refused, not defaulted to allowed", () => {
    const v = canSelfApprove({ agent: "HZS-REP-004", decisionClass: "WIRE_MONEY", stage: 3, dataQuality: GREEN });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/no decision class/);
  });

  test("the hardest stop wins: an unknown class on RED data cites the class, not the data", () => {
    // Order of refusal is deliberate — an unknown action is a worse problem than
    // stale data, so it is named first.
    const v = canSelfApprove({ agent: "HZS-REP-004", decisionClass: "WIRE_MONEY", stage: 3, dataQuality: "RED" });
    expect(v.reason).toMatch(/no decision class/);
  });
});

describe("CONFIG_TUNING — the owner-authorised shared class (decision B)", () => {
  test("every agent owns CONFIG_TUNING via the SHARED fallback", () => {
    for (const a of ALL_AGENTS) {
      expect(authorityFor(a, "CONFIG_TUNING"), a).not.toBeNull();
    }
  });

  test("CONFIG_TUNING is NOT never-autonomous (it self-approves at Stage 2)", () => {
    expect(isNeverAutonomous(authorityFor("HZS-DLV-002", "CONFIG_TUNING")!)).toBe(false);
  });

  test("canSelfTuneConfig: green Stage-2 tunes (behaviour-preserving)", () => {
    expect(canSelfTuneConfig({ stage: 2, dataQuality: "GREEN" }).ok).toBe(true);
  });

  test("canSelfTuneConfig: Stage 1 is refused — a param change is the human's", () => {
    const v = canSelfTuneConfig({ stage: 1, dataQuality: "GREEN" });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/Stage 1/);
  });

  test("canSelfTuneConfig: RED data never self-tunes", () => {
    const v = canSelfTuneConfig({ stage: 2, dataQuality: "RED" });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/RED/);
  });
});

describe("promotion gates + runtime states are the spec's numbers", () => {
  test("S1→S2 needs 95% over 100 cases; S2→S3 needs 99% over 500 (§10.4)", () => {
    expect(PROMOTION_GATES.s1ToS2.minAcceptanceOrAccuracy).toBe(0.95);
    expect(PROMOTION_GATES.s1ToS2.minCases).toBe(100);
    expect(PROMOTION_GATES.s2ToS3.minAcceptanceOrAccuracy).toBe(0.99);
    expect(PROMOTION_GATES.s2ToS3.minCases).toBe(500);
  });

  test("the 12 runtime states from §10.5 are present and unique", () => {
    expect(RUNTIME_STATES.length).toBe(12);
    expect(new Set(RUNTIME_STATES).size).toBe(12);
    expect(RUNTIME_STATES).toContain("WAITING_FOR_APPROVAL");
    expect(RUNTIME_STATES).toContain("ESCALATED");
  });
});
