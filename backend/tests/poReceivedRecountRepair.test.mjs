// HC-0106: which PO lines the cancelled-GRN repair may correct, on the real
// production rows of 2026-10-15 (four cancelled GRNs, one of them stale).
import { describe, expect, it } from "vitest";

import { planStaleReceived, poStatusFromLines } from "../scripts/lib/po-received-recount.mjs";

const elephantK = {
  poItemId: "570e72d1", poId: "fafadae8", poNumber: "HC-PO-2609-263", poStatus: "PARTIALLY_RECEIVED",
  linkedAcDocno: null, itemCode: "ELEPHANE-(K)", qty: 1, receivedQty: 1,
  soDocNo: "HC-SO-2609-164", soStockStatus: "READY",
};
const cutoverLine = {
  poItemId: "3856e070", poId: "po010080", poNumber: "HC-PO-010080", poStatus: "RECEIVED",
  linkedAcDocno: "PO-010080", itemCode: "9058-2S", qty: 1, receivedQty: 1,
  soDocNo: "HC-SO-011717", soStockStatus: "READY",
};
const grn = (poItemId, grnNumber, grnStatus, qtyAccepted = 1, returnedQty = 0) =>
  ({ poItemId, grnNumber, grnStatus, qtyAccepted, returnedQty });

describe("planStaleReceived", () => {
  it("HC-GRN-2610-002 cancelled from DRAFT: ELEPHANE-(K) comes back to 0", () => {
    const fixes = planStaleReceived([elephantK], [grn("570e72d1", "HC-GRN-2610-002", "CANCELLED")]);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({ poNumber: "HC-PO-2609-263", receivedQty: 1, newReceivedQty: 0 });
    expect(fixes[0].deadGrns).toEqual(["HC-GRN-2610-002 CANCELLED"]);
  });

  it("an AutoCount cutover PO is never recounted from GRNs, even with three cancelled ones", () => {
    const lines = ["HC-GRN-2610-046", "HC-GRN-2610-047", "HC-GRN-2610-048"].map((n) => grn("3856e070", n, "CANCELLED"));
    expect(planStaleReceived([cutoverLine], lines)).toEqual([]);
  });

  it("a replacement GRN already posted keeps the line received", () => {
    const fixes = planStaleReceived([elephantK], [
      grn("570e72d1", "HC-GRN-2610-002", "CANCELLED"),
      grn("570e72d1", "HC-GRN-2610-130", "POSTED"),
    ]);
    expect(fixes).toEqual([]);
  });

  it("a returned qty does not count as received", () => {
    const fixes = planStaleReceived([{ ...elephantK, qty: 2, receivedQty: 2 }], [
      grn("570e72d1", "HC-GRN-2610-002", "CANCELLED"),
      grn("570e72d1", "HC-GRN-2610-130", "POSTED", 2, 1),
    ]);
    expect(fixes.map((f) => f.newReceivedQty)).toEqual([1]);
  });

  it("a DRAFT GRN line counts as voided, like CANCELLED", () => {
    const fixes = planStaleReceived([elephantK], [grn("570e72d1", "HC-GRN-2610-002", "DRAFT")]);
    expect(fixes.map((f) => f.newReceivedQty)).toEqual([0]);
  });

  it("an under-reporting line is a different fault and is left alone", () => {
    const fixes = planStaleReceived([{ ...elephantK, receivedQty: 0 }], [
      grn("570e72d1", "HC-GRN-2610-002", "CANCELLED"),
      grn("570e72d1", "HC-GRN-2610-130", "POSTED"),
    ]);
    expect(fixes).toEqual([]);
  });

  it("a line with no voided GRN is not this repair's business", () => {
    const fixes = planStaleReceived([{ ...elephantK, receivedQty: 3 }], [grn("570e72d1", "HC-GRN-2610-130", "POSTED")]);
    expect(fixes).toEqual([]);
  });

  it("a cancelled PO is left alone", () => {
    const fixes = planStaleReceived([{ ...elephantK, poStatus: "CANCELLED" }], [grn("570e72d1", "HC-GRN-2610-002", "CANCELLED")]);
    expect(fixes).toEqual([]);
  });
});

describe("poStatusFromLines", () => {
  it("HC-PO-2609-263 after the repair: nothing received, back to SUBMITTED", () => {
    expect(poStatusFromLines("PARTIALLY_RECEIVED", [
      { qty: 1, receivedQty: 0 }, { qty: 2, receivedQty: 0 },
    ])).toBe("SUBMITTED");
  });

  it("some received is PARTIALLY_RECEIVED, all received is RECEIVED", () => {
    expect(poStatusFromLines("SUBMITTED", [{ qty: 1, receivedQty: 1 }, { qty: 2, receivedQty: 0 }])).toBe("PARTIALLY_RECEIVED");
    expect(poStatusFromLines("SUBMITTED", [{ qty: 1, receivedQty: 1 }, { qty: 2, receivedQty: 2 }])).toBe("RECEIVED");
  });

  it("CANCELLED and ON_HOLD are never re-derived", () => {
    expect(poStatusFromLines("CANCELLED", [{ qty: 1, receivedQty: 0 }])).toBeNull();
    expect(poStatusFromLines("ON_HOLD", [{ qty: 1, receivedQty: 0 }])).toBeNull();
  });
});
