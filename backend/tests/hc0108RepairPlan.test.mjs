// HC-0108 repair decisions, on the production rows read 2026-10-16
// (diag-ready-audit-2026-10-16.mjs PART=4, run 38848359747).
import { describe, expect, it } from "vitest";

import { planDoubled, planPiece, planPieceDelivery } from "../scripts/lib/hc0108-repair-plan.mjs";

const line = (id, itemCode, receivedQty, extra = {}) =>
  ({ id, itemCode, qty: 1, receivedQty, unitPriceSen: 0, dtlkey: "875610", soItemId: null, ...extra });
const grn = (id, poItemId, grnNumber, extra = {}) => ({
  id, grnId: grnNumber, grnNumber, poItemId, status: "POSTED", migratedNoStock: true,
  linkedAcGrDocno: null, createdOn: "2026-08-28", qtyAccepted: 1, returnedQty: 0, invoicedQty: 0,
  lineTotalSen: 0, refs: 0, ...extra,
});

describe("planPiece — HC-PO-009630", () => {
  const e = { po: "HC-PO-009630", piece: "5535-L(RHF)", source: "5535-1A(LHF)" };
  const lines = [
    line("d889", "5535-1A(LHF)", 1, { soItemId: "0fbe" }),
    line("f51d", "5535-1NA", 1, { soItemId: "1717" }),
    line("0def", "SQUARE PILLOW", 2, { qty: 2, unitPriceSen: 2500, dtlkey: "875612" }),
    line("3ee9", "5535-L(RHF)", 0),
  ];
  const grns = [
    grn("81ba", "d889", "HC-GR-005257-PO-009630", { invoicedQty: 1 }),
    grn("55f6", "f51d", "HC-GR-005257-PO-009630", { invoicedQty: 1, lineTotalSen: 255000 }),
  ];

  it("clones the source's receipt line onto the added piece", () => {
    const p = planPiece(e, lines, grns);
    expect(p.refused).toBeUndefined();
    expect(p.mode).toBe("clone");
    expect(p.piece.id).toBe("3ee9");
    expect(p.grnLine.id).toBe("81ba");
  });

  it("is inert once the piece has its receipt", () => {
    const done = lines.map((l) => (l.id === "3ee9" ? { ...l, receivedQty: 1 } : l));
    expect(planPiece(e, done, grns).refused).toMatch(/already reads received 1/);
  });

  it("refuses a source receipt that moved stock", () => {
    const moved = grns.map((g) => (g.id === "81ba" ? { ...g, migratedNoStock: false } : g));
    expect(planPiece(e, lines, moved).refused).toMatch(/not migrated paperwork/);
  });

  it("refuses a priced piece", () => {
    const priced = lines.map((l) => (l.id === "3ee9" ? { ...l, unitPriceSen: 100 } : l));
    expect(planPiece(e, priced, grns).refused).toMatch(/is priced/);
  });
});

describe("planPiece — HC-PO-009718 (received in AutoCount only)", () => {
  const e = { po: "HC-PO-009718", piece: "9028-1A(RHF)", source: "9028-1A(LHF)", acOnly: true, so: "HC-SO-012913" };
  const lines = [
    line("e19a", "9028-1A(LHF)", 1, { dtlkey: "884621", soItemId: "7de4" }),
    line("5518", "9028-1A(RHF)", 0, { dtlkey: "884621", soItemId: "a6fe" }),
  ];

  it("copies the source's stored count, with no receipt line to clone", () => {
    const p = planPiece(e, lines, []);
    expect(p.refused).toBeUndefined();
    expect(p.mode).toBe("ac-only");
  });

  it("refuses when the source turns out to have an ERP receipt", () => {
    expect(planPiece(e, lines, [grn("x", "e19a", "HC-GR-1")]).refused).toMatch(/expected none/);
  });

  it("puts the piece on the source's migrated, delivered DO", () => {
    const plan = planPiece(e, lines, []);
    const so = [
      { id: "7de4", docNo: "HC-SO-012913", itemCode: "9028-1A(LHF)", qty: 1, cancelled: false },
      { id: "a6fe", docNo: "HC-SO-012913", itemCode: "9028-1A(RHF)", qty: 1, cancelled: false },
    ];
    const dos = [{ id: "5bc6", doId: "d1", doNumber: "HC-DO-011550", soItemId: "7de4", qty: 1, status: "DELIVERED", migratedNoStock: true }];
    const d = planPieceDelivery(e, plan, so, dos);
    expect(d.refused).toBeUndefined();
    expect(d.doLine.id).toBe("5bc6");
    expect(planPieceDelivery(e, plan, so, [{ ...dos[0], migratedNoStock: false }]).refused).toMatch(/moved stock/);
    expect(planPieceDelivery(e, plan, so, [...dos, { ...dos[0], id: "z", soItemId: "a6fe" }]).refused).toMatch(/already has a delivery-order line/);
  });
});

describe("planDoubled — HC-PO-009431 CASUAL-(SS)", () => {
  const e = { po: "HC-PO-009431", item: "CASUAL-(SS)", dup: "HC-GR-005033-PO-009431", keep: "HC-GR-005039-PO-009431" };
  const poLine = { id: "p1", itemCode: "CASUAL-(SS)", qty: 1, receivedQty: 1 };
  const grns = [
    grn("5389", "p1", "HC-GR-005033-PO-009431"),
    grn("416e", "p2", "HC-GR-005033-PO-009431"),
    grn("fad1", "p1", "HC-GR-005039-PO-009431", { linkedAcGrDocno: "GR-005039", createdOn: "2026-09-20", lineTotalSen: 33750 }),
  ];

  it("removes the unlinked 08-28 line and keeps the linked receipt and the other line", () => {
    const d = planDoubled(e, poLine, grns);
    expect(d.refused).toBeUndefined();
    expect(d.remove.id).toBe("5389");
    expect(d.keep.id).toBe("fad1");
  });

  it("is inert once the duplicate is gone", () => {
    expect(planDoubled(e, poLine, grns.filter((g) => g.id !== "5389")).refused).toMatch(/expected one line/);
  });

  it("refuses an invoiced or referenced duplicate", () => {
    const inv = grns.map((g) => (g.id === "5389" ? { ...g, invoicedQty: 1 } : g));
    expect(planDoubled(e, poLine, inv).refused).toMatch(/invoiced 1/);
    const ref = grns.map((g) => (g.id === "5389" ? { ...g, refs: 1 } : g));
    expect(planDoubled(e, poLine, ref).refused).toMatch(/referenced/);
  });

  it("refuses when the duplicate is the only line on its receipt", () => {
    expect(planDoubled(e, poLine, grns.filter((g) => g.id !== "416e")).refused).toMatch(/empty it/);
  });

  it("refuses when the kept receipt is not linked to AutoCount", () => {
    const unlinked = grns.map((g) => (g.id === "fad1" ? { ...g, linkedAcGrDocno: null } : g));
    expect(planDoubled(e, poLine, unlinked).refused).toMatch(/not linked to AutoCount/);
  });
});
