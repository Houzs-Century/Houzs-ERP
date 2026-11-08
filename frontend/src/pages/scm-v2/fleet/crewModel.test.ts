import { describe, expect, it } from "vitest";
import { fmtDate } from "../../../vendor/shared/format";
import type { DriverRow } from "../../../vendor/scm/lib/drivers-queries";
import type { HelperRow } from "../../../vendor/scm/lib/helpers-queries";
import type { LorryRow } from "../../../vendor/scm/lib/lorries-queries";
import {
  crewFormOf, crewFormProblem, crewMatches, crewPatch, driverAsCrew, employerLabel, helperAsCrew, initials,
  leaveDays, leaveOf, leaveState, leaveSummary, lorriesOf,
} from "./crewModel";

const DRIVER: DriverRow = {
  id: "drv-1", driver_code: "DRV-016", name: "Shamsul fiqri bin samsuddin", phone: "+60111234567",
  ic_number: null, vehicle: null, in_house: true, active: true, created_at: "2026-01-01T00:00:00Z",
};
const d = driverAsCrew(DRIVER);
const leave = (o: { id: string; driverId?: string; helperId?: string; startDate: string; endDate: string }) =>
  ({ driverId: null, helperId: null, reason: null, createdAt: null, ...o });

describe("crewPatch, editing", () => {
  it("an untouched form sends nothing", () => {
    expect(crewPatch("driver", d, crewFormOf(d))).toEqual({});
  });
  it("sends only the fields that changed, trimmed", () => {
    expect(crewPatch("driver", d, { ...crewFormOf(d), name: "  Shamsul Fiqri  " })).toEqual({ name: "Shamsul Fiqri" });
    expect(crewPatch("driver", d, { ...crewFormOf(d), vehicle: "Hilux WMN1234" })).toEqual({ vehicle: "Hilux WMN1234" });
    expect(crewPatch("driver", d, { ...crewFormOf(d), warehouseId: "wh-1" })).toEqual({ warehouseId: "wh-1" });
  });
  it("a helper's phone goes as contact", () => {
    const h = helperAsCrew({ id: "h1", helper_code: "HLP-1", name: "Ali", contact: null, ic_number: null, active: true, created_at: "" } as HelperRow);
    expect(crewPatch("helper", h, { ...crewFormOf(h), phone: "+60129999999" })).toEqual({ contact: "+60129999999" });
  });
  it("inHouse stays out unless the employer moved", () => {
    const out = driverAsCrew({ ...DRIVER, in_house: false });
    expect(crewPatch("driver", out, { ...crewFormOf(out), name: "Jan" })).toEqual({ name: "Jan" });
    expect(crewPatch("driver", d, { ...crewFormOf(d), employer: "out" })).toEqual({ inHouse: false });
  });
  it("picking a 3PL company attaches it; leaving one detaches it explicitly", () => {
    expect(crewPatch("driver", d, { ...crewFormOf(d), employer: "c-1" })).toEqual({ threeplCompanyId: "c-1" });
    const linked = driverAsCrew({ ...DRIVER, in_house: false, threepl_company_id: "c-1" });
    expect(crewFormOf(linked).employer).toBe("c-1");
    expect(crewPatch("driver", linked, { ...crewFormOf(linked), employer: "in" })).toEqual({ threeplCompanyId: null, inHouse: true });
  });
});

describe("crewPatch, a new person", () => {
  it("sends what was filled in and the employer", () => {
    expect(crewPatch("driver", null, { name: " Ali ", phone: "0123", ic: "", vehicle: "", employer: "in", warehouseId: "" }))
      .toEqual({ name: "Ali", phone: "0123", warehouseId: null, inHouse: true });
    expect(crewPatch("helper", null, { name: "Abu", phone: "", ic: "", vehicle: "x", employer: "c-2", warehouseId: "w" }))
      .toEqual({ name: "Abu", warehouseId: "w", threeplCompanyId: "c-2" });
  });
  it("a driver needs a phone, a helper does not", () => {
    const f = { name: "Ali", phone: "", ic: "", vehicle: "", employer: "in", warehouseId: "" };
    expect(crewFormProblem("driver", f)).toBe("Enter the phone number.");
    expect(crewFormProblem("helper", f)).toBeNull();
    expect(crewFormProblem("helper", { ...f, name: " " })).toBe("Enter the name.");
  });
});

describe("crew list rules", () => {
  it("labels the employer", () => {
    expect(employerLabel(d, () => null)).toBe("In-house");
    expect(employerLabel({ inHouse: false, carrierId: "c" }, () => "MSJ Transport")).toBe("Outsource · MSJ Transport");
    expect(employerLabel({ inHouse: false, carrierId: null }, () => null)).toBe("Outsource");
  });
  it("finds the lorries a person usually crews", () => {
    const ls = [{ id: "a", plate: "VQE1", usual_driver_id: "drv-1" }, { id: "b", plate: "VQE2", usual_helper_id: "drv-1" }] as LorryRow[];
    expect(lorriesOf(ls, "driver", "drv-1").map((l) => l.plate)).toEqual(["VQE1"]);
    expect(lorriesOf(ls, "helper", "drv-1").map((l) => l.plate)).toEqual(["VQE2"]);
  });
  it("searches name, code, phone and extra words", () => {
    expect(crewMatches(d, "drv-016", [])).toBe(true);
    expect(crewMatches(d, "vqe", ["VQE9058"])).toBe(true);
    expect(crewMatches(d, "penang", [])).toBe(false);
    expect(crewMatches(d, "  ", [])).toBe(true);
  });
  it("makes initials", () => {
    expect(initials("shamsul fiqri bin")).toBe("SF");
    expect(initials("")).toBe("?");
  });
});

describe("leave", () => {
  it("is past, now or upcoming against today", () => {
    expect(leaveState("2026-11-01", "2026-11-03", "2026-11-07")).toBe("past");
    expect(leaveState("2026-11-07", "2026-11-07", "2026-11-07")).toBe("now");
    expect(leaveState("2026-11-08", "2026-11-09", "2026-11-07")).toBe("upcoming");
  });
  it("counts days inclusive", () => {
    expect(leaveDays("2026-11-07", "2026-11-07")).toBe(1);
    expect(leaveDays("2026-10-30", "2026-11-02")).toBe(4);
  });
  it("picks one person's rows and the line the list shows", () => {
    const rows = [
      leave({ id: "1", driverId: "drv-1", startDate: "2026-11-20", endDate: "2026-11-21" }),
      leave({ id: "2", driverId: "drv-1", startDate: "2026-11-10", endDate: "2026-11-12" }),
      leave({ id: "3", helperId: "drv-1", startDate: "2026-11-06", endDate: "2026-11-08" }),
    ];
    const mine = leaveOf(rows, "driver", "drv-1");
    expect(mine.map((r) => r.id)).toEqual(["1", "2"]);
    expect(leaveSummary(mine, "2026-11-07")).toEqual({ text: `Leave from ${fmtDate("2026-11-10")}`, now: false });
    expect(leaveSummary(leaveOf(rows, "helper", "drv-1"), "2026-11-07")!.now).toBe(true);
    expect(leaveSummary([], "2026-11-07")).toBeNull();
  });
});
