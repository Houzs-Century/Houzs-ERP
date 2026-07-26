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
  addMonths,
  planNextDueKm,
  planNextDueDate,
  derivePlanDue,
  anyPlanDue,
  assessMileageReading,
  // Phase 3
  isCaseGrounding,
  isBreakdownActive,
  breakdownDowntimeHours,
  canTransitionWorkOrder,
  isWorkOrderOpen,
  workOrderSeam,
  workOrderTotalCenti,
  WORK_ORDER_STATES,
  WORK_ORDER_TRANSITIONS,
  deriveComponentLife,
  type ComplianceDocInput,
  type StatusInput,
  type MaintenancePlanInput,
  type WorkOrderState,
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

// ── Phase 2: preventive-maintenance plans ────────────────────────────────────

describe("addMonths — day-clamped month arithmetic", () => {
  test("adds whole months", () => {
    expect(addMonths("2026-01-15", 6)).toBe("2026-07-15");
    expect(addMonths("2026-07-15", 12)).toBe("2027-07-15");
  });
  test("clamps to the shorter target month (Jan 31 + 1mo => Feb 28)", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29"); // leap year
  });
  test("null for a blank/bad date or a non-positive month count", () => {
    expect(addMonths(null, 6)).toBeNull();
    expect(addMonths("2026-01-15", 0)).toBeNull();
    expect(addMonths("2026-01-15", null)).toBeNull();
    expect(addMonths("not-a-date", 6)).toBeNull();
  });
});

describe("planNextDueKm / planNextDueDate", () => {
  test("next-due km is last-done km + interval km", () => {
    expect(planNextDueKm({ component: "ENGINE_OIL", intervalKm: 10_000, lastDoneKm: 90_000 })).toBe(100_000);
  });
  test("null when no km interval or no last-done odometer", () => {
    expect(planNextDueKm({ component: "ENGINE_OIL", intervalKm: null, lastDoneKm: 90_000 })).toBeNull();
    expect(planNextDueKm({ component: "ENGINE_OIL", intervalKm: 10_000, lastDoneKm: null })).toBeNull();
  });
  test("next-due date is last-done date + interval months", () => {
    expect(planNextDueDate({ component: "ENGINE_OIL", intervalMonths: 6, lastDoneDate: "2026-01-15" })).toBe("2026-07-15");
  });
  test("null when no month interval or no last-done date", () => {
    expect(planNextDueDate({ component: "ENGINE_OIL", intervalMonths: null, lastDoneDate: "2026-01-15" })).toBeNull();
    expect(planNextDueDate({ component: "ENGINE_OIL", intervalMonths: 6, lastDoneDate: null })).toBeNull();
  });
});

describe("derivePlanDue — whichever comes first (km OR months)", () => {
  test("due soon on KM alone while the date is comfortably far out", () => {
    const plan: MaintenancePlanInput = { component: "ENGINE_OIL", intervalKm: 10_000, intervalMonths: 12, lastDoneKm: 90_000, lastDoneDate: "2026-07-01" };
    const due = derivePlanDue(plan, 99_500, TODAY); // 500km left (<=1000), ~11mo left
    expect(due.dueSoon).toBe(true);
    expect(due.overdue).toBe(false);
    expect(due.kmRemaining).toBe(500);
    expect(due.tone).toBe("warn");
  });
  test("due soon on MONTHS alone while the km is comfortably far out", () => {
    const plan: MaintenancePlanInput = { component: "PUSPAKOM_PREP", intervalMonths: 6, intervalKm: 50_000, lastDoneDate: "2026-01-20", lastDoneKm: 10_000 };
    // next-due date 2026-07-20 => 25d out? TODAY=2026-07-25 so it is overdue by 5d
    const due = derivePlanDue(plan, 12_000, TODAY);
    expect(due.dueSoon).toBe(true);
    expect(due.overdue).toBe(true); // date passed
    expect(due.tone).toBe("crit");
  });
  test("overdue on KM (odometer already past next-due) is crit", () => {
    const plan: MaintenancePlanInput = { component: "ENGINE_OIL", intervalKm: 10_000, lastDoneKm: 90_000 };
    const due = derivePlanDue(plan, 101_000, TODAY);
    expect(due.overdue).toBe(true);
    expect(due.dueSoon).toBe(true);
    expect(due.kmRemaining).toBe(-1_000);
  });
  test("not due when both axes are far out", () => {
    const plan: MaintenancePlanInput = { component: "GEARBOX_OIL", intervalKm: 40_000, intervalMonths: 24, lastDoneKm: 90_000, lastDoneDate: "2026-07-01" };
    const due = derivePlanDue(plan, 92_000, TODAY);
    expect(due.dueSoon).toBe(false);
    expect(due.overdue).toBe(false);
    expect(due.tone).toBe("ok");
  });
  test("a plan never serviced (no last-done) has no due picture", () => {
    const plan: MaintenancePlanInput = { component: "TYRES", intervalKm: 60_000, intervalMonths: 36 };
    const due = derivePlanDue(plan, 50_000, TODAY);
    expect(due.nextDueKm).toBeNull();
    expect(due.nextDueDate).toBeNull();
    expect(due.dueSoon).toBe(false);
  });
});

describe("anyPlanDue + deriveVehicleStatus consumes plans", () => {
  const okDocs: ComplianceDocInput[] = [{ docType: "ROAD_TAX", expiryDate: "2026-12-01" }];
  test("anyPlanDue skips inactive plans", () => {
    const plans: MaintenancePlanInput[] = [
      { component: "ENGINE_OIL", intervalKm: 10_000, lastDoneKm: 90_000, active: false }, // would be due but inactive
    ];
    expect(anyPlanDue(plans, 99_800, TODAY)).toBe(false);
  });
  test("an active due plan makes the vehicle SERVICE_DUE", () => {
    const status = deriveVehicleStatus({
      today: TODAY,
      currentDocs: okDocs,
      currentMileageKm: 99_500,
      plans: [{ component: "ENGINE_OIL", intervalKm: 10_000, lastDoneKm: 90_000 }],
    });
    expect(status).toBe("SERVICE_DUE");
  });
  test("compliance block still outranks a due plan", () => {
    const status = deriveVehicleStatus({
      today: TODAY,
      currentDocs: [{ docType: "ROAD_TAX", expiryDate: "2026-07-01" }],
      currentMileageKm: 99_500,
      plans: [{ component: "ENGINE_OIL", intervalKm: 10_000, lastDoneKm: 90_000 }],
    });
    expect(status).toBe("COMPLIANCE_BLOCKED");
  });
  test("plans far from due leave the vehicle AVAILABLE", () => {
    const status = deriveVehicleStatus({
      today: TODAY,
      currentDocs: okDocs,
      currentMileageKm: 92_000,
      plans: [{ component: "GEARBOX_OIL", intervalKm: 40_000, lastDoneKm: 90_000 }],
    });
    expect(status).toBe("AVAILABLE");
  });
});

// ── Phase 2: daily mileage capture guards ────────────────────────────────────

describe("assessMileageReading — no-rollback + abnormal-jump guards", () => {
  test("first-ever reading is accepted (no previous to compare)", () => {
    const a = assessMileageReading({ previousKm: null, newKm: 100_000, newDate: "2026-07-25" });
    expect(a.verdict).toBe("OK");
    expect(a.accepted).toBe(true);
    expect(a.flagged).toBe(false);
    expect(a.deltaKm).toBeNull();
  });
  test("a reading BELOW the previous odometer is a rollback — rejected", () => {
    const a = assessMileageReading({ previousKm: 100_000, previousDate: "2026-07-24", newKm: 99_000, newDate: "2026-07-25" });
    expect(a.verdict).toBe("ROLLBACK");
    expect(a.accepted).toBe(false);
    expect(a.flagged).toBe(true);
    expect(a.deltaKm).toBe(-1_000);
  });
  test("a normal daily delta is accepted, unflagged", () => {
    const a = assessMileageReading({ previousKm: 100_000, previousDate: "2026-07-24", newKm: 100_350, newDate: "2026-07-25" });
    expect(a.verdict).toBe("OK");
    expect(a.flagged).toBe(false);
    expect(a.deltaKm).toBe(350);
  });
  test("an abnormal one-day jump is accepted but FLAGGED for review", () => {
    const a = assessMileageReading({ previousKm: 100_000, previousDate: "2026-07-24", newKm: 105_000, newDate: "2026-07-25" });
    expect(a.verdict).toBe("ABNORMAL_JUMP");
    expect(a.accepted).toBe(true);
    expect(a.flagged).toBe(true);
    expect(a.deltaKm).toBe(5_000);
  });
  test("the abnormal-jump allowance scales with the day gap", () => {
    // 3000km over 3 days = 1000/day, under the 1500/day allowance => OK.
    const a = assessMileageReading({ previousKm: 100_000, previousDate: "2026-07-22", newKm: 103_000, newDate: "2026-07-25" });
    expect(a.verdict).toBe("OK");
    expect(a.days).toBe(3);
  });
  test("a custom per-day threshold is honoured", () => {
    const a = assessMileageReading({ previousKm: 100_000, previousDate: "2026-07-24", newKm: 100_600, newDate: "2026-07-25", abnormalJumpKmPerDay: 500 });
    expect(a.verdict).toBe("ABNORMAL_JUMP");
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

// ── Phase 3: breakdown cases → status effect ─────────────────────────────────

describe("isCaseGrounding / isBreakdownActive", () => {
  test("a CRITICAL unresolved case grounds the lorry", () => {
    expect(isCaseGrounding({ severity: "CRITICAL", status: "OPEN" })).toBe(true);
    expect(isCaseGrounding({ severity: "CRITICAL", status: "TOWING" })).toBe(true);
    expect(isCaseGrounding({ severity: "CRITICAL", status: "IN_WORKSHOP" })).toBe(true);
  });
  test("a resolved critical case no longer grounds", () => {
    expect(isCaseGrounding({ severity: "CRITICAL", status: "RESOLVED" })).toBe(false);
  });
  test("MINOR / MAJOR cases do not, on their own, ground the lorry", () => {
    expect(isCaseGrounding({ severity: "MINOR", status: "OPEN" })).toBe(false);
    expect(isCaseGrounding({ severity: "MAJOR", status: "OPEN" })).toBe(false);
  });
  test("isBreakdownActive is true when ANY case grounds", () => {
    expect(isBreakdownActive([{ severity: "MINOR", status: "OPEN" }, { severity: "CRITICAL", status: "OPEN" }])).toBe(true);
    expect(isBreakdownActive([{ severity: "MAJOR", status: "OPEN" }])).toBe(false);
    expect(isBreakdownActive([])).toBe(false);
    expect(isBreakdownActive(undefined)).toBe(false);
  });
});

describe("deriveVehicleStatus consumes a critical breakdown", () => {
  const okDocs: ComplianceDocInput[] = [{ docType: "ROAD_TAX", expiryDate: "2026-12-01" }];
  test("an active critical breakdown makes the vehicle BREAKDOWN and non-dispatchable", () => {
    const status = deriveVehicleStatus({
      today: TODAY,
      currentDocs: okDocs,
      breakdownActive: isBreakdownActive([{ severity: "CRITICAL", status: "OPEN" }]),
    });
    expect(status).toBe("BREAKDOWN");
    expect(canDispatch(status)).toBe(false);
  });
  test("a resolved critical breakdown leaves the vehicle AVAILABLE", () => {
    const status = deriveVehicleStatus({
      today: TODAY,
      currentDocs: okDocs,
      breakdownActive: isBreakdownActive([{ severity: "CRITICAL", status: "RESOLVED" }]),
    });
    expect(status).toBe("AVAILABLE");
  });
  test("compliance block still outranks a breakdown, out-of-service outranks both", () => {
    const expired: ComplianceDocInput[] = [{ docType: "ROAD_TAX", expiryDate: "2026-07-01" }];
    expect(deriveVehicleStatus({ today: TODAY, currentDocs: expired, breakdownActive: true })).toBe("COMPLIANCE_BLOCKED");
    expect(deriveVehicleStatus({ today: TODAY, outOfService: true, currentDocs: expired, breakdownActive: true })).toBe("OUT_OF_SERVICE");
  });
  test("a breakdown outranks an open work order and a service-due plan", () => {
    const status = deriveVehicleStatus({
      today: TODAY,
      currentDocs: okDocs,
      breakdownActive: true,
      openWorkOrder: "WAITING_PARTS",
      currentMileageKm: 99_900,
      nextServiceKm: 100_000,
    });
    expect(status).toBe("BREAKDOWN");
  });
});

describe("breakdownDowntimeHours", () => {
  test("recovered case measures start → recovery", () => {
    const h = breakdownDowntimeHours({ breakdownStart: "2026-07-25T08:00:00Z", recoveryTime: "2026-07-25T14:00:00Z" }, "2026-07-25T20:00:00Z");
    expect(h).toBe(6);
  });
  test("still-down case measures start → now", () => {
    const h = breakdownDowntimeHours({ occurredAt: "2026-07-25T08:00:00Z", recoveryTime: null }, "2026-07-25T12:00:00Z");
    expect(h).toBe(4);
  });
  test("no start anchor yields null", () => {
    expect(breakdownDowntimeHours({ breakdownStart: null, occurredAt: null }, "2026-07-25T12:00:00Z")).toBeNull();
  });
});

// ── Phase 3: work-order state machine ────────────────────────────────────────

describe("work-order state machine — canTransitionWorkOrder", () => {
  test("the canonical forward path is legal", () => {
    expect(canTransitionWorkOrder("REPORTED", "DIAGNOSED")).toBe(true);
    expect(canTransitionWorkOrder("DIAGNOSED", "APPROVED")).toBe(true);
    expect(canTransitionWorkOrder("APPROVED", "IN_REPAIR")).toBe(true);
    expect(canTransitionWorkOrder("IN_REPAIR", "COMPLETED")).toBe(true);
    expect(canTransitionWorkOrder("COMPLETED", "VERIFIED")).toBe(true);
  });
  test("the In Repair ⇄ Waiting Parts loop is legal both ways", () => {
    expect(canTransitionWorkOrder("IN_REPAIR", "WAITING_PARTS")).toBe(true);
    expect(canTransitionWorkOrder("WAITING_PARTS", "IN_REPAIR")).toBe(true);
    expect(canTransitionWorkOrder("WAITING_PARTS", "COMPLETED")).toBe(true);
  });
  test("skipping states is illegal (Reported → Verified, Reported → Approved)", () => {
    expect(canTransitionWorkOrder("REPORTED", "VERIFIED")).toBe(false);
    expect(canTransitionWorkOrder("REPORTED", "APPROVED")).toBe(false);
    expect(canTransitionWorkOrder("APPROVED", "COMPLETED")).toBe(false);
  });
  test("VERIFIED is terminal and a self-transition is not allowed", () => {
    expect(WORK_ORDER_TRANSITIONS.VERIFIED).toEqual([]);
    for (const s of WORK_ORDER_STATES) expect(canTransitionWorkOrder(s, s)).toBe(false);
  });
  test("no state can jump backwards past the loop (Completed → In Repair)", () => {
    expect(canTransitionWorkOrder("COMPLETED", "IN_REPAIR")).toBe(false);
    expect(canTransitionWorkOrder("VERIFIED", "COMPLETED")).toBe(false);
  });
});

describe("isWorkOrderOpen + workOrderSeam", () => {
  test("open until COMPLETED/VERIFIED", () => {
    for (const s of ["REPORTED", "DIAGNOSED", "APPROVED", "IN_REPAIR", "WAITING_PARTS"] as WorkOrderState[]) {
      expect(isWorkOrderOpen(s)).toBe(true);
    }
    expect(isWorkOrderOpen("COMPLETED")).toBe(false);
    expect(isWorkOrderOpen("VERIFIED")).toBe(false);
  });
  test("IN_REPAIR feeds PLANNED, WAITING_PARTS feeds WAITING_PARTS", () => {
    expect(workOrderSeam([{ status: "IN_REPAIR" }])).toBe("PLANNED");
    expect(workOrderSeam([{ status: "WAITING_PARTS" }])).toBe("WAITING_PARTS");
  });
  test("WAITING_PARTS wins over IN_REPAIR across multiple work orders", () => {
    expect(workOrderSeam([{ status: "IN_REPAIR" }, { status: "WAITING_PARTS" }])).toBe("WAITING_PARTS");
  });
  test("not-yet-in-shop states (Reported/Approved) do not move the needle", () => {
    expect(workOrderSeam([{ status: "REPORTED" }, { status: "APPROVED" }])).toBeNull();
  });
  test("closed work orders are ignored", () => {
    expect(workOrderSeam([{ status: "COMPLETED" }, { status: "VERIFIED" }])).toBeNull();
  });
  test("the seam drives deriveVehicleStatus into the maintenance states", () => {
    const okDocs: ComplianceDocInput[] = [{ docType: "ROAD_TAX", expiryDate: "2026-12-01" }];
    expect(deriveVehicleStatus({ today: TODAY, currentDocs: okDocs, openWorkOrder: workOrderSeam([{ status: "IN_REPAIR" }]) })).toBe("PLANNED_MAINTENANCE");
    expect(deriveVehicleStatus({ today: TODAY, currentDocs: okDocs, openWorkOrder: workOrderSeam([{ status: "WAITING_PARTS" }]) })).toBe("WAITING_PARTS");
  });
});

describe("workOrderTotalCenti — labour + parts + outside + towing + tax", () => {
  test("sums all legs and part lines (qty × unit price)", () => {
    const total = workOrderTotalCenti({
      labourCenti: 15_000,
      outsideServiceCenti: 5_000,
      towingCenti: 8_000,
      taxCenti: 2_000,
      parts: [
        { qty: 2, unitPriceCenti: 3_000 }, // 6000
        { qty: 1, unitPriceCenti: 4_500 }, // 4500
      ],
    });
    expect(total).toBe(15_000 + 5_000 + 8_000 + 2_000 + 6_000 + 4_500);
  });
  test("missing legs default to zero; empty parts is fine", () => {
    expect(workOrderTotalCenti({ labourCenti: 1_000 })).toBe(1_000);
    expect(workOrderTotalCenti({})).toBe(0);
  });
  test("fractional part quantities round to whole cents", () => {
    expect(workOrderTotalCenti({ parts: [{ qty: 1.5, unitPriceCenti: 333 }] })).toBe(500); // 499.5 → 500
  });
});

// ── Phase 3: component lifecycle ─────────────────────────────────────────────

describe("deriveComponentLife — km_used / cost_per_km / warranty", () => {
  test("a removed component measures removed_km − fitted_km", () => {
    const life = deriveComponentLife(
      { status: "REMOVED", fittedKm: 100_000, removedKm: 160_000, purchasePriceCenti: 60_000, warrantyUntil: "2025-01-01" },
      null,
      TODAY,
    );
    expect(life.kmUsed).toBe(60_000);
    expect(life.costPerKmCenti).toBe(1); // 60000 / 60000 = 1 cent/km
    expect(life.underWarranty).toBe(false); // warranty in the past
  });
  test("an active component measures current odometer − fitted_km", () => {
    const life = deriveComponentLife(
      { status: "ACTIVE", fittedKm: 100_000, purchasePriceCenti: 90_000, warrantyUntil: "2027-01-01" },
      130_000,
      TODAY,
    );
    expect(life.kmUsed).toBe(30_000);
    expect(life.costPerKmCenti).toBe(3); // 90000 / 30000
    expect(life.underWarranty).toBe(true); // warranty in the future
  });
  test("zero / unknown km_used gives no cost-per-km (never divide by zero)", () => {
    const noKm = deriveComponentLife({ status: "ACTIVE", fittedKm: 100_000, purchasePriceCenti: 90_000 }, 100_000, TODAY);
    expect(noKm.kmUsed).toBe(0);
    expect(noKm.costPerKmCenti).toBeNull();
    const noBasis = deriveComponentLife({ status: "ACTIVE", fittedKm: null, purchasePriceCenti: 90_000 }, 130_000, TODAY);
    expect(noBasis.kmUsed).toBeNull();
    expect(noBasis.costPerKmCenti).toBeNull();
  });
  test("an odometer below the fitted km (bad data) yields no km_used, not a negative", () => {
    const life = deriveComponentLife({ status: "ACTIVE", fittedKm: 130_000 }, 100_000, TODAY);
    expect(life.kmUsed).toBeNull();
  });
  test("no warranty date on file is unknown (null), not 'expired'", () => {
    const life = deriveComponentLife({ status: "ACTIVE", fittedKm: 10, warrantyUntil: null }, 20, TODAY);
    expect(life.underWarranty).toBeNull();
  });
});
