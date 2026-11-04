import { describe, expect, it, vi } from "vitest";
vi.mock("../vendor/scm/lib/lorries-queries", () => ({ useLorries: () => ({ data: [], isLoading: false }) }));
import { needsAttention, nextRenewal } from "./LorryRecord";
import type { DocView, VehicleDetailPayload } from "./FleetHealth";

const doc = (id: string, docType: DocView["docType"], days: number | null, tone: DocView["tone"]): DocView => ({ id, docType, documentRef: null, issueDate: null, expiryDate: days == null ? null : "2027-01-01", costSen: null, owner: null, result: null, reinspectionDeadline: null, notes: null, daysRemaining: days, reminderLevel: "OK", tone });
const vault = (docs: DocView[]) => Object.fromEntries(docs.map((d) => [d.docType, { currentId: d.id, flatExpiry: null, history: [d] }])) as VehicleDetailPayload["compliance"];

describe("nextRenewal", () => {
  it("takes the document that runs out first, ignoring one with no expiry", () => {
    expect(nextRenewal(vault([doc("a", "ROAD_TAX", 335, "ok"), doc("b", "INSURANCE", 12, "crit"), doc("c", "GERAN", null, "ok")]))?.type).toBe("INSURANCE");
  });
  it("is null with nothing on file", () => {
    expect(nextRenewal(undefined)).toBeNull();
  });
});

describe("needsAttention", () => {
  it("puts a lorry that cannot be driven first, then what is due", () => {
    const list = needsAttention(
      { mileageKm: 1442 }, 0,
      [{ caseNo: "BD-0002", faultType: "Engine Off", stillDrivable: false, status: "IN_WORKSHOP" }],
      [],
      vault([doc("a", "ROAD_TAX", 20, "warn")]),
    );
    expect(list.map((a) => [a.text, a.tag])).toEqual([["BD-0002 Engine Off", "Not drivable"], ["Road Tax / LKM", expect.any(String)], ["No service plan on this lorry", "Add one"]]);
    expect(list[0].tab).toBe("repairs");
  });
  it("says nothing about a healthy lorry", () => {
    expect(needsAttention({ mileageKm: 1 }, 2, [], [], vault([doc("a", "ROAD_TAX", 300, "ok")]))).toEqual([]);
  });
});
