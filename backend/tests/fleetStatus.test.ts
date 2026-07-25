import { describe, expect, test } from "vitest";
import {
  daysUntil,
  reminderLevel,
  reminderTone,
  isActionableReminder,
  isComplianceBlocking,
  currentDocsByType,
  isServiceDue,
  deriveVehicleStatus,
  canDispatch,
  type ComplianceDocInput,
  type StatusInput,
} from "../src/services/fleet-status";

const TODAY = "2026-07-25";

describe("daysUntil", () => {
  test("future / today / past", () => {
    expect(daysUntil("2026-07-26", TODAY)).toBe(1);
    expect(daysUntil("2026-07-25", TODAY)).toBe(0);
    expect(daysUntil("2026-07-24", TODAY)).toBe(-1);
    expect(daysUntil("2026-08-24", TODAY)).toBe(30);
  });
  test("null / blank / malformed dates return null", () => {
    expect(daysUntil(null, TODAY)).toBeNull();
    expect(daysUntil("", TODAY)).toBeNull();
    expect(daysUntil("not-a-date", TODAY)).toBeNull();
    expect(daysUntil(undefined, TODAY)).toBeNull();
  });
  test("accepts timestamptz-ish strings by taking the date head", () => {
    expect(daysUntil("2026-07-30T12:00:00Z", TODAY)).toBe(5);
  });
});

describe("reminderLevel — the escalating ladder", () => {
  test("expired", () => {
    expect(reminderLevel(-1)).toBe("EXPIRED");
    expect(reminderLevel(-100)).toBe("EXPIRED");
  });
  test("escalate tail owns 7/3/1 and everything <=7", () => {
    for (const d of [0, 1, 3, 5, 7]) expect(reminderLevel(d)).toBe("ESCALATE");
  });
  test("boundary crossings are exact", () => {
    expect(reminderLevel(8)).toBe("RED");
    expect(reminderLevel(14)).toBe("RED");
    expect(reminderLevel(15)).toBe("NOTIFY");
    expect(reminderLevel(30)).toBe("NOTIFY");
    expect(reminderLevel(31)).toBe("AMBER");
    expect(reminderLevel(45)).toBe("AMBER");
    expect(reminderLevel(46)).toBe("PREPARE");
    expect(reminderLevel(60)).toBe("PREPARE");
    expect(reminderLevel(61)).toBe("OK");
  });
  test("null (no date on file) is OK, not an alarm", () => {
    expect(reminderLevel(null)).toBe("OK");
  });
});

describe("reminderTone / isActionableReminder", () => {
  test("tone buckets", () => {
    expect(reminderTone("EXPIRED")).toBe("crit");
    expect(reminderTone("ESCALATE")).toBe("crit");
    expect(reminderTone("RED")).toBe("crit");
    expect(reminderTone("NOTIFY")).toBe("warn");
    expect(reminderTone("AMBER")).toBe("warn");
    expect(reminderTone("PREPARE")).toBe("warn");
    expect(reminderTone("OK")).toBe("ok");
  });
  test("only OK is non-actionable", () => {
    expect(isActionableReminder("OK")).toBe(false);
    expect(isActionableReminder("PREPARE")).toBe(true);
    expect(isActionableReminder("EXPIRED")).toBe(true);
  });
});

describe("isComplianceBlocking", () => {
  test("expired document blocks", () => {
    const doc: ComplianceDocInput = { docType: "ROAD_TAX", expiryDate: "2026-07-24" };
    expect(isComplianceBlocking(doc, TODAY)).toBe(true);
  });
  test("valid document does not block", () => {
    const doc: ComplianceDocInput = { docType: "ROAD_TAX", expiryDate: "2026-12-24" };
    expect(isComplianceBlocking(doc, TODAY)).toBe(false);
  });
  test("PUSPAKOM FAIL blocks even when the printed expiry is in the future", () => {
    const doc: ComplianceDocInput = { docType: "PUSPAKOM", expiryDate: "2026-12-24", result: "FAIL" };
    expect(isComplianceBlocking(doc, TODAY)).toBe(true);
  });
  test("PUSPAKOM PASS with a future expiry does not block", () => {
    const doc: ComplianceDocInput = { docType: "PUSPAKOM", expiryDate: "2026-12-24", result: "PASS" };
    expect(isComplianceBlocking(doc, TODAY)).toBe(false);
  });
  test("a document with no expiry on file does not block", () => {
    const doc: ComplianceDocInput = { docType: "APAD", expiryDate: null };
    expect(isComplianceBlocking(doc, TODAY)).toBe(false);
  });
});

describe("currentDocsByType — append-only history collapses to the current row", () => {
  test("latest expiry wins per type (renewal is a new row, not an overwrite)", () => {
    const history = [
      { docType: "ROAD_TAX" as const, expiryDate: "2025-07-01", issueDate: "2024-07-01" },
      { docType: "ROAD_TAX" as const, expiryDate: "2026-07-01", issueDate: "2025-07-01" },
      { docType: "INSURANCE" as const, expiryDate: "2026-09-01", issueDate: "2025-09-01" },
    ];
    const current = currentDocsByType(history);
    expect(current.get("ROAD_TAX")?.expiryDate).toBe("2026-07-01");
    expect(current.get("INSURANCE")?.expiryDate).toBe("2026-09-01");
    expect(current.size).toBe(2);
  });
  test("a dated renewal beats a blank placeholder row", () => {
    const history = [
      { docType: "APAD" as const, expiryDate: null, issueDate: null },
      { docType: "APAD" as const, expiryDate: "2026-10-01", issueDate: "2025-10-01" },
    ];
    expect(currentDocsByType(history).get("APAD")?.expiryDate).toBe("2026-10-01");
  });
});

describe("isServiceDue", () => {
  const base: StatusInput = { today: TODAY };
  test("due when mileage is within the km threshold of next service", () => {
    expect(isServiceDue({ ...base, currentMileageKm: 99_200, nextServiceKm: 100_000 })).toBe(true);
  });
  test("overdue on mileage is also due", () => {
    expect(isServiceDue({ ...base, currentMileageKm: 101_000, nextServiceKm: 100_000 })).toBe(true);
  });
  test("not due when comfortably below threshold", () => {
    expect(isServiceDue({ ...base, currentMileageKm: 90_000, nextServiceKm: 100_000 })).toBe(false);
  });
  test("due when next service date is within the day threshold", () => {
    expect(isServiceDue({ ...base, nextServiceDate: "2026-08-01" })).toBe(true);
  });
  test("not due when next service date is far out", () => {
    expect(isServiceDue({ ...base, nextServiceDate: "2026-12-01" })).toBe(false);
  });
  test("missing mileage + date inputs means not due", () => {
    expect(isServiceDue(base)).toBe(false);
  });
});

describe("deriveVehicleStatus — precedence", () => {
  const okDocs: ComplianceDocInput[] = [
    { docType: "ROAD_TAX", expiryDate: "2026-12-01" },
    { docType: "PUSPAKOM", expiryDate: "2026-12-01", result: "PASS" },
  ];

  test("AVAILABLE when nothing is wrong", () => {
    expect(deriveVehicleStatus({ today: TODAY, currentDocs: okDocs, currentMileageKm: 50_000, nextServiceKm: 100_000 })).toBe("AVAILABLE");
  });
  test("out-of-service flag overrides everything, including expired docs", () => {
    expect(
      deriveVehicleStatus({ today: TODAY, outOfService: true, currentDocs: [{ docType: "ROAD_TAX", expiryDate: "2020-01-01" }] }),
    ).toBe("OUT_OF_SERVICE");
  });
  test("expired document => COMPLIANCE_BLOCKED (the owner's hard rule)", () => {
    expect(deriveVehicleStatus({ today: TODAY, currentDocs: [{ docType: "ROAD_TAX", expiryDate: "2026-07-01" }] })).toBe("COMPLIANCE_BLOCKED");
  });
  test("failed PUSPAKOM => COMPLIANCE_BLOCKED even with a future expiry", () => {
    expect(deriveVehicleStatus({ today: TODAY, currentDocs: [{ docType: "PUSPAKOM", expiryDate: "2026-12-01", result: "FAIL" }] })).toBe(
      "COMPLIANCE_BLOCKED",
    );
  });
  test("compliance block outranks a service-due condition", () => {
    expect(
      deriveVehicleStatus({
        today: TODAY,
        currentDocs: [{ docType: "ROAD_TAX", expiryDate: "2026-07-01" }],
        currentMileageKm: 99_900,
        nextServiceKm: 100_000,
      }),
    ).toBe("COMPLIANCE_BLOCKED");
  });
  test("SERVICE_DUE when only the mileage threshold trips", () => {
    expect(deriveVehicleStatus({ today: TODAY, currentDocs: okDocs, currentMileageKm: 99_500, nextServiceKm: 100_000 })).toBe("SERVICE_DUE");
  });

  // ── seam states: unreachable in Phase 1 unless the later-phase input is fed ──
  test("seam: breakdownActive => BREAKDOWN (Phase 2 input)", () => {
    expect(deriveVehicleStatus({ today: TODAY, currentDocs: okDocs, breakdownActive: true })).toBe("BREAKDOWN");
  });
  test("seam: openWorkOrder WAITING_PARTS => WAITING_PARTS", () => {
    expect(deriveVehicleStatus({ today: TODAY, currentDocs: okDocs, openWorkOrder: "WAITING_PARTS" })).toBe("WAITING_PARTS");
  });
  test("seam: openWorkOrder PLANNED => PLANNED_MAINTENANCE", () => {
    expect(deriveVehicleStatus({ today: TODAY, currentDocs: okDocs, openWorkOrder: "PLANNED" })).toBe("PLANNED_MAINTENANCE");
  });
  test("seam: compliance block still outranks a breakdown", () => {
    expect(
      deriveVehicleStatus({ today: TODAY, currentDocs: [{ docType: "ROAD_TAX", expiryDate: "2026-07-01" }], breakdownActive: true }),
    ).toBe("COMPLIANCE_BLOCKED");
  });
});

describe("canDispatch", () => {
  test("only AVAILABLE and SERVICE_DUE can dispatch", () => {
    expect(canDispatch("AVAILABLE")).toBe(true);
    expect(canDispatch("SERVICE_DUE")).toBe(true);
    expect(canDispatch("COMPLIANCE_BLOCKED")).toBe(false);
    expect(canDispatch("OUT_OF_SERVICE")).toBe(false);
    expect(canDispatch("BREAKDOWN")).toBe(false);
    expect(canDispatch("WAITING_PARTS")).toBe(false);
    expect(canDispatch("PLANNED_MAINTENANCE")).toBe(false);
  });
});
