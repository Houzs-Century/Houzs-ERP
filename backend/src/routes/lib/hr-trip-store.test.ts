import { describe, expect, test } from "vitest";
import { computeTripMonth, DEFAULT_TRIP_RATES } from "../../scm/shared/hr-trip-pay";
import { deliveryOrderRows, doRunDate, planningRowOf, projectCrewLorries, projectLegRows, rowHrEdited, tripRowOf, type PlanningDo, type PlanningStop, type ProjectLeg } from "./hr-trip-store";

const base: PlanningStop = {
  stop_id: "s1",
  do_id: null,
  stop_type: "DELIVERY",
  trip_id: "t1",
  trip_date: "2026-11-02",
  trip_no: "TRIP-0001",
  plate: "VPC 9058",
  revenue_sen: null,
  customer_name: "AHMAD",
  stop_dp_no: "DP-261102-VPC01",
  do_number: null,
  so_doc_no: null,
  do_status: null,
  local_total_sen: null,
  do_state: null,
  do_postcode: null,
  dp_state: null,
  dp_postcode: null,
  dp_no: null,
  project_id: null,
  event_slug: null,
  event_name: null,
  assr_case_id: null,
  assr_no: null,
  case_addr3: null,
  case_addr4: null,
  case_own_postcode: null,
  case_own_state: null,
  case_so_state: null,
  case_so_postcode: null,
  d1: "drv",
  d2: null,
  h1: "hlp1",
  h2: "hlp2",
};
const who = (id: string | null) => (id ? { name: id.toUpperCase(), employeeId: id === "drv" ? 7 : null } : { name: "", employeeId: null });

describe("planningRowOf", () => {
  test("a DO stop: Delivery order, the DO's Local Total, state and postcode, the run as trip_ref", () => {
    const r = planningRowOf({ ...base, do_number: "HC-DO-2611-001", so_doc_no: "SO-013131", local_total_sen: "570000", revenue_sen: 500000, do_state: "Johor", do_postcode: "81300" }, who);
    expect(r).toMatchObject({ job_type: "DELIVERY_ORDER", kind: "DO", doc_no: "SO-013131", transfer_to: "HC-DO-2611-001", ref_no: "DP-261102-VPC01", local_total_sen: 570000, state: "Johor", postcode: "81300", trip_ref: "t1" });
    expect(r).toMatchObject({ driver_1_name: "DRV", driver_1_employee_id: 7, helper_1_name: "HLP1", helper_2_name: "HLP2" });
  });

  test("an SO scheduled before its DO: the amount is the stop's own snapshot and the state is left for HR", () => {
    const r = planningRowOf({ ...base, revenue_sen: 388000 }, who);
    expect(r).toMatchObject({ job_type: "DELIVERY_ORDER", doc_no: "DP-261102-VPC01", local_total_sen: 388000, state: "" });
  });

  test("a delivery with no SO pays commission on the amount typed on its DP job (owner 2026-11-20)", () => {
    const r = planningRowOf({ ...base, revenue_sen: 0, dp_sales_sen: "350000" }, who);
    expect(r.local_total_sen).toBe(350000);
    const withDo = planningRowOf({ ...base, local_total_sen: "570000", revenue_sen: 0, dp_sales_sen: 350000 }, who);
    expect(withDo.local_total_sen).toBe(570000);
  });

  test("a service case's legs are the ASSR job types, never a Delivery order", () => {
    const r = planningRowOf({ ...base, assr_case_id: 51, assr_no: "ASSR/2610-051", revenue_sen: 0, case_addr3: "81300 Skudai", case_addr4: "Johor" }, who);
    expect(r).toMatchObject({ job_type: "ASSR_SERVICE", kind: "SERVICE_DELIVERY", doc_no: "ASSR/2610-051", local_total_sen: 0, state: "Johor", postcode: "81300" });
    expect(planningRowOf({ ...base, stop_type: "PICKUP", assr_case_id: 52 }, who).job_type).toBe("ASSR_PICKUP");
    expect(planningRowOf({ ...base, stop_type: "INSPECTION", assr_case_id: 53 }, who).job_type).toBe("ASSR_INSPECTION");
    expect(planningRowOf({ ...base, stop_type: "SERVICE", assr_case_id: 55 }, who).job_type).toBe("ASSR_SERVICE");
  });

  test("a service case with no state in its address takes its order's state", () => {
    expect(planningRowOf({ ...base, assr_case_id: 54, case_addr4: "", case_so_state: "Melaka" }, who).state).toBe("Melaka");
  });

  test("a service case's own State outranks its address lines and its order", () => {
    expect(planningRowOf({ ...base, assr_case_id: 56, case_addr4: "Johor", case_so_state: "Melaka", case_own_state: "Penang" }, who).state).toBe("Pulau Pinang");
  });

  test("manual jobs keep their job type; a Setup carries its project and event type", () => {
    expect(planningRowOf({ ...base, stop_type: "SUPPLIER_PICKUP", dp_no: "DP-1", dp_state: "Selangor" }, who)).toMatchObject({ job_type: "SUPPLIER", doc_no: "DP-1", state: "Selangor" });
    expect(planningRowOf({ ...base, stop_type: "SETUP", dp_state: "Melaka", project_id: "88", event_slug: "solo" }, who)).toMatchObject({ job_type: "SETUP", kind: "FAIR", event_type: "ROADSHOW", venue_key: "P88", state: "Melaka" });
    expect(planningRowOf({ ...base, stop_type: "DISMANTLE", project_id: "89", event_slug: "exhibition" }, who).event_type).toBe("EXHIBITION");
    expect(planningRowOf({ ...base, stop_type: "LORRY_SERVICE" }, who)).toMatchObject({ job_type: "LORRY_SERVICE", kind: "NONE" });
  });

  test("a delivery to Singapore is a Transfer item, never a commissioned delivery", () => {
    expect(planningRowOf({ ...base, do_number: "HC-DO-1", do_state: "West" }, who).job_type).toBe("TRANSFER");
    expect(planningRowOf({ ...base, do_number: "HC-DO-1", do_state: "", dp_state: "Central" }, who).job_type).toBe("TRANSFER");
    expect(planningRowOf({ ...base, do_number: "HC-DO-1", do_state: "Johor" }, who).job_type).toBe("DELIVERY_ORDER");
  });
});

describe("project Setup / Dismantle from the Projects module", () => {
  const project: ProjectLeg = {
    id: "42",
    code: "PRJ-042",
    name: "JOHOR [AKEMI] MEGA @ MID VALLEY SB",
    venue: "Mid Valley Southkey",
    state: "JOHOR",
    setup_start_at: "2026-11-05T09:00",
    dismantle_start_at: "2026-11-30T22:00",
    setup_crew: JSON.stringify({
      lorry_crew: [
        { plate: "VPC 9058", drivers: [{ name: "Amir" }], helpers: [{ name: "Wan" }, { name: "Naem" }] },
        { plate: "VQE 9058", drivers: [{ name: "Ali" }], helpers: [] },
      ],
    }),
    dismantle_crew: null,
    event_slug: "exhibition",
    event_name: "Exhibition",
    setup_driver_name: null,
    dismantle_driver_name: null,
  };
  const byName = (n: string) => ({ AMIR: 1, WAN: 2, ALI: 3 })[n.toUpperCase()] ?? null;

  test("one row per lorry of the phase, inside the trip month, crew matched by name", () => {
    const rows = projectLegRows(project, "2026-10-23", "2026-11-22", new Set(), byName);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source_ref: "project:42:SETUP:1",
      trip_date: "2026-11-05",
      job_type: "SETUP",
      event_type: "EXHIBITION",
      lorry_plate: "VPC 9058",
      venue_key: "P42",
      state: "JOHOR",
      driver_1_name: "Amir",
      driver_1_employee_id: 1,
      helper_2_name: "Naem",
      helper_2_employee_id: null,
    });
    expect(rows[1]).toMatchObject({ lorry_plate: "VQE 9058", driver_1_employee_id: 3, trip_ref: "project:42:SETUP:2" });
  });

  test("a phase Delivery Planning already carries is left to its stop; no crew falls back to the legacy driver", () => {
    expect(projectLegRows(project, "2026-10-23", "2026-11-22", new Set(["42|SETUP|2026-11-05"]), byName)).toEqual([]);
    const legacy = projectLegRows({ ...project, setup_crew: null, setup_driver_name: "Amir" }, "2026-10-23", "2026-11-22", new Set(), byName);
    expect(legacy).toMatchObject([{ driver_1_name: "Amir", lorry_plate: "" }]);
  });

  test("the flattened crew shape is one lorry; bad JSON is none", () => {
    expect(projectCrewLorries(JSON.stringify({ drivers: [{ name: "Amir" }], helpers: [{ name: "Wan" }], lorries: ["VPC 1"] }))).toEqual([{ plate: "VPC 1", drivers: ["Amir"], helpers: ["Wan"] }]);
    expect(projectCrewLorries("{oops")).toEqual([]);
  });
});

describe("rowHrEdited", () => {
  const r = { hr_edited: false, source: "PLANNING", job_type: null as string | null, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" };
  test("the flag, or a Planning row from before the redesign touched after it was written", () => {
    expect(rowHrEdited(r)).toBe(false);
    expect(rowHrEdited({ ...r, hr_edited: true })).toBe(true);
    expect(rowHrEdited({ ...r, updated_at: "2026-11-02T00:00:00Z" })).toBe(true);
    expect(rowHrEdited({ ...r, job_type: "SETUP", updated_at: "2026-11-02T00:00:00Z" })).toBe(false);
  });
});

describe("delivery orders our lorries ran (Last Mile reaches them through the DO crew, not trip stops)", () => {
  const doBase: PlanningDo = {
    do_id: "do-1",
    do_number: "HC-DO-2611-219",
    so_doc_no: "HC-SO-2610-500",
    debtor_name: "TAN",
    do_status: "DELIVERED",
    so_due_date: "2026-11-17",
    is_latest_live: true,
    delivered_day: "2026-11-17",
    do_date: "2026-11-18",
    local_total_sen: "1200000",
    do_state: "Selangor",
    do_postcode: "47500",
    is_dropship: false,
    has_3pl: false,
    on_live_trip: false,
    crew_plate: "VNB 9058",
    lorry_plate: "VNB9058",
    lorry_internal: true,
    d1: "drv",
    d2: null,
    h1: "hlp1",
    h2: "hlp2",
    d1_name: "ALI",
    d2_name: null,
    h1_name: "ABU",
    h2_name: "AHMAD",
  };
  const ids: Record<string, number> = { drv: 11, hlp1: 21, hlp2: 22 };
  const who = (id: string | null, name: string | null) => ({ name: id ? `N-${id}` : (name ?? ""), employeeId: id ? (ids[id] ?? null) : null });
  const rowsOf = (dos: PlanningDo[], stops: Set<string>) => deliveryOrderRows(dos, "2026-10-23", "2026-11-22", stops, who);

  test("the run date is the day Last Mile shows it on the lorry: the SO's due date for its newest live DO", () => {
    expect(doRunDate(doBase)).toBe("2026-11-17");
    expect(doRunDate({ ...doBase, is_latest_live: false, delivered_day: "2026-11-05" })).toBe("2026-11-05");
    expect(doRunDate({ ...doBase, is_latest_live: false, delivered_day: null })).toBe("2026-11-18");
    expect(doRunDate({ ...doBase, so_due_date: null, delivered_day: null })).toBe("2026-11-18");
    expect(doRunDate({ ...doBase, so_due_date: null, delivered_day: null, do_date: null })).toBeNull();
  });

  test("a DO whose run date falls outside the trip month is not in it", () => {
    expect(rowsOf([{ ...doBase, so_due_date: "2026-11-23" }], new Set())).toEqual([]);
    expect(rowsOf([{ ...doBase, so_due_date: "2026-10-23" }], new Set())[0]?.trip_date).toBe("2026-10-23");
  });

  test("one Delivery order row: the DO's date, Local Total, state, postcode, plate and crew", () => {
    const [r] = rowsOf([doBase], new Set());
    expect(r).toMatchObject({
      source: "PLANNING",
      source_ref: "do:do-1",
      trip_date: "2026-11-17",
      doc_no: "HC-SO-2610-500",
      transfer_to: "HC-DO-2611-219",
      job_type: "DELIVERY_ORDER",
      local_total_sen: 1200000,
      state: "Selangor",
      postcode: "47500",
      lorry_plate: "VNB9058",
      trip_ref: "do-run:VNB9058:2026-11-17",
      driver_1_employee_id: 11,
      helper_1_employee_id: 21,
      helper_2_employee_id: 22,
    });
  });

  test("a DO a live trip stop already carries is read once, from the stop", () => {
    expect(rowsOf([doBase], new Set(["do-1"]))).toEqual([]);
    expect(rowsOf([{ ...doBase, on_live_trip: true }], new Set())).toEqual([]);
  });

  test("cancelled, draft, drop-shipped, 3PL, outsourced-lorry and lorry-less DOs earn no row", () => {
    const out = (p: Partial<PlanningDo>) => rowsOf([{ ...doBase, ...p }], new Set());
    expect(out({ do_status: "CANCELLED" })).toEqual([]);
    expect(out({ do_status: "DRAFT" })).toEqual([]);
    expect(out({ is_dropship: true })).toEqual([]);
    expect(out({ has_3pl: true })).toEqual([]);
    expect(out({ lorry_internal: false })).toEqual([]);
    expect(out({ crew_plate: null, lorry_plate: null, lorry_internal: null })).toEqual([]);
    expect(out({ so_due_date: null, delivered_day: null, do_date: null })).toEqual([]);
    expect(out({ do_status: "IN_TRANSIT" })).toHaveLength(1);
    expect(out({ lorry_plate: null, lorry_internal: null })[0]?.lorry_plate).toBe("VNB 9058");
  });

  test("a seat with no master id keeps the name typed on the crew record", () => {
    const [r] = rowsOf([{ ...doBase, d1: null, d1_name: "ALI" }], new Set());
    expect(r.driver_1_name).toBe("ALI");
  });

  test("the DO crew count sets the commission rate: 3 people = crew of 3, 2 people = crew of 2", () => {
    const pay = (p: Partial<PlanningDo>) => {
      const rows = rowsOf([{ ...doBase, ...p }], new Set()).map((r) => tripRowOf({ ...r, id: 1, hr_edited: false } as unknown as Parameters<typeof tripRowOf>[0]));
      const out = computeTripMonth({ rows, rates: DEFAULT_TRIP_RATES, employeeOf: (x) => x.employeeId, missedDaysOf: () => 0, punches: new Map() });
      return out.pay.get(11)?.commission.lines.map((l) => [l.crew, l.baseSen]);
    };
    expect(pay({})).toEqual([[3, 1200000]]);
    expect(pay({ h2: null, h2_name: null })).toEqual([[2, 1200000]]);
  });

  test("a Singapore delivery is a Transfer item (RM15, no commission), not a commissioned delivery", () => {
    const jt = (p: Partial<PlanningDo>) => rowsOf([{ ...doBase, ...p }], new Set())[0]?.job_type;
    expect(jt({ do_state: "West", do_postcode: "642682" })).toBe("TRANSFER");
    expect(jt({ do_state: "Singapore" })).toBe("TRANSFER");
    expect(jt({ do_state: "", do_postcode: "138632" })).toBe("TRANSFER");
    expect(jt({})).toBe("DELIVERY_ORDER");
    const rows = rowsOf([{ ...doBase, do_state: "West" }], new Set()).map((r) => tripRowOf({ ...r, id: 1, hr_edited: false } as unknown as Parameters<typeof tripRowOf>[0]));
    const out = computeTripMonth({ rows, rates: DEFAULT_TRIP_RATES, employeeOf: (x) => x.employeeId, missedDaysOf: () => 0, punches: new Map() });
    expect(out.pay.get(11)?.commission.baseSen).toBe(0);
    expect(out.pay.get(11)?.jobAllowanceSen).toBe(1500);
  });
});
