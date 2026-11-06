import { describe, expect, it } from "vitest";
import { docChip } from "./LorryCompliance";
import type { DocView } from "../FleetHealth";

const doc = (over: Partial<DocView>): DocView => ({ id: "d", docType: "ROAD_TAX", documentRef: null, issueDate: null, expiryDate: "2027-10-05", costSen: null, owner: null, result: null, reinspectionDeadline: null, notes: null, daysRemaining: 335, reminderLevel: "OK", tone: "ok", ...over });

describe("docChip", () => {
  it("counts down a document with an expiry, in its own tone", () => {
    expect(docChip(doc({ daysRemaining: 10, tone: "crit" }), null)).toMatchObject({ tone: "crit" });
    expect(docChip(doc({}), null).label).toContain("335");
  });
  it("says On file for one with no expiry, never OK", () => {
    expect(docChip(doc({ docType: "GERAN", expiryDate: null, daysRemaining: null }), null)).toEqual({ label: "On file", tone: "ok" });
  });
  it("a failed inspection reads Failed however long it has left", () => {
    expect(docChip(doc({ result: "FAIL" }), null)).toEqual({ label: "Failed", tone: "crit" });
  });
  it("an expiry typed on the lorry with no document is not read as filed", () => {
    expect(docChip(null, "2027-01-01")).toEqual({ label: "No document yet", tone: "warn" });
    expect(docChip(null, null)).toEqual({ label: "Nothing on file", tone: "warn" });
  });
});
