import { describe, expect, test } from "vitest";
import { HELD_REASONS, planBookOnlyLines } from "../scripts/lib/book-only-line-plan.mjs";

/* HC-DO-2609-044 as measured on 2026-09-14: nine book lines, eight ERP rows,
   the bolster moved to HC-DO-2609-102 and still on this document in the book. */
const do044Book = [929086, 929088, 929090, 929092, 929094, 929096, 929098, 929100, 929102].map((k) => ({
  toDtlKey: k, itemCode: k === 929094 ? "AK- ESSENTIAL BOLSTER" : "OTHER", qty: k === 929094 ? 2 : 1, transferredOn: 0, cancelled: false,
}));
const do044Erp = { exists: true, cancelled: false, rowKeys: [929086, 929088, 929090, 929092, 929096, 929098, 929100, 929102] };

describe("planBookOnlyLines", () => {
  test("a book line no ERP row claims, on a fully keyed document, is retired", () => {
    const plan = planBookOnlyLines(do044Book, do044Erp);
    expect(plan.retire).toEqual([{ dtlKey: 929094, itemCode: "AK- ESSENTIAL BOLSTER", qty: 2 }]);
    expect(plan.held).toEqual([]);
  });

  test("a keyless ERP row holds every unclaimed line: it may be that line", () => {
    const plan = planBookOnlyLines(do044Book, { ...do044Erp, rowKeys: [...do044Erp.rowKeys, null] });
    expect(plan.retire).toEqual([]);
    expect(plan.held.map((h) => [h.dtlKey, h.reason])).toEqual([[929094, HELD_REASONS.erpRowKeyless]]);
  });

  test("a line an invoice was transferred from is held", () => {
    const book = do044Book.map((b) => (b.toDtlKey === 929094 ? { ...b, transferredOn: 1 } : b));
    expect(planBookOnlyLines(book, do044Erp).held.map((h) => h.reason)).toEqual([HELD_REASONS.downstream]);
  });

  test("a line already at quantity zero is neither retired again nor held", () => {
    const book = do044Book.map((b) => (b.toDtlKey === 929094 ? { ...b, qty: 0 } : b));
    const plan = planBookOnlyLines(book, do044Erp);
    expect(plan).toEqual({ retire: [], held: [], alreadyZero: 1 });
  });

  test("a document missing from the ERP, or cancelled on either side, is held", () => {
    expect(planBookOnlyLines(do044Book, { exists: false, cancelled: false, rowKeys: [] }).held)
      .toHaveLength(9);
    expect(planBookOnlyLines(do044Book, { ...do044Erp, cancelled: true }).held.map((h) => h.reason))
      .toEqual([HELD_REASONS.erpCancelled]);
    const cancelledBook = do044Book.map((b) => ({ ...b, cancelled: true }));
    expect(planBookOnlyLines(cancelledBook, do044Erp).held.map((h) => h.reason))
      .toEqual([HELD_REASONS.bookCancelled]);
  });

  test("a document whose every book line is claimed plans nothing", () => {
    const book = do044Book.filter((b) => b.toDtlKey !== 929094);
    expect(planBookOnlyLines(book, do044Erp)).toEqual({ retire: [], held: [], alreadyZero: 0 });
  });
});
