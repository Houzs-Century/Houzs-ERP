// Delivery Planning stops as trip rows: what each kind of stop the board
// writes becomes, and where its amount and state come from.
import { describe, expect, test } from "vitest";
import { planningRowOf, type PlanningStop } from "./hr-trip-store";

const base: PlanningStop = {
  stop_id: "s1",
  stop_type: "DELIVERY",
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
  dp_state: null,
  dp_no: null,
  assr_case_id: null,
  assr_no: null,
  case_addr3: null,
  case_addr4: null,
  case_so_state: null,
  d1: "drv",
  d2: null,
  h1: "hlp1",
  h2: "hlp2",
};
const who = (id: string | null) => (id ? { name: id.toUpperCase(), employeeId: id === "drv" ? 7 : null } : { name: "", employeeId: null });

describe("planningRowOf", () => {
  test("a DO stop: the DO's Local Total and state, the DP number as the reference", () => {
    const r = planningRowOf({ ...base, do_number: "HC-DO-2611-001", so_doc_no: "SO-013131", local_total_sen: "570000", revenue_sen: 500000, do_state: "Johor" }, who);
    expect(r).toMatchObject({ kind: "DO", doc_no: "SO-013131", transfer_to: "HC-DO-2611-001", ref_no: "DP-261102-VPC01", local_total_sen: 570000, state: "Johor" });
    expect(r).toMatchObject({ driver_1_name: "DRV", driver_1_employee_id: 7, helper_1_name: "HLP1", helper_2_name: "HLP2" });
  });

  test("an SO scheduled before its DO: the amount is the stop's own snapshot and the state is left for HR", () => {
    const r = planningRowOf({ ...base, revenue_sen: 388000 }, who);
    expect(r).toMatchObject({ kind: "DO", doc_no: "DP-261102-VPC01", local_total_sen: 388000, state: "" });
  });

  test("a service case's delivery leg is a DELIVERY stop but a service, not a DO", () => {
    const r = planningRowOf({ ...base, assr_case_id: 51, assr_no: "ASSR/2610-051", revenue_sen: 0, case_addr4: "Johor" }, who);
    expect(r).toMatchObject({ kind: "SERVICE_DELIVERY", doc_no: "ASSR/2610-051", local_total_sen: 0, state: "Johor" });
    expect(planningRowOf({ ...base, stop_type: "PICKUP", assr_case_id: 52 }, who).kind).toBe("SERVICE_PICKUP");
    expect(planningRowOf({ ...base, stop_type: "INSPECTION", assr_case_id: 53 }, who).kind).toBe("SERVICE_INSPECTION");
    expect(planningRowOf({ ...base, stop_type: "SERVICE", assr_case_id: 55 }, who).kind).toBe("SERVICE_DELIVERY");
  });

  test("a service case with no state in its address takes its order's state", () => {
    expect(planningRowOf({ ...base, assr_case_id: 54, case_addr4: "", case_so_state: "Melaka" }, who).state).toBe("Melaka");
  });

  test("manual jobs keep their kind and the job's state; a lorry service pays nothing", () => {
    expect(planningRowOf({ ...base, stop_type: "SUPPLIER_PICKUP", dp_no: "DP-1", dp_state: "Selangor" }, who)).toMatchObject({ kind: "SUPPLIER", doc_no: "DP-1", state: "Selangor" });
    expect(planningRowOf({ ...base, stop_type: "SETUP", dp_state: "Melaka" }, who)).toMatchObject({ kind: "FAIR", state: "Melaka" });
    expect(planningRowOf({ ...base, stop_type: "LORRY_SERVICE" }, who).kind).toBe("NONE");
  });
});
