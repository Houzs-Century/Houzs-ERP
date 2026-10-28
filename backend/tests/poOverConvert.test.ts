import { describe, expect, test } from "vitest";
import { findOverConvertOffender } from "../src/scm/lib/po-over-convert";

/* findOverConvertOffender is the remaining-qty cap for SO-sourced lines on the
   generic PO-create path (POST /mfg-purchase-orders). The desktop "create new PO
   from SO" flow routes picks through this generic create, which — unlike
   /from-sos — had no server-side cap, so a New-PO-form line could order more than
   the source SO still needs. See BUG-HISTORY 2026-07-24. */

const so = (id: string, qty: number, picked: number) => ({ id, qty, po_qty_picked: picked });

describe("findOverConvertOffender", () => {
  test("passes when every SO-sourced line is within its remaining", () => {
    const offender = findOverConvertOffender(
      [{ soItemId: "A", qty: 3 }, { soItemId: "B", qty: 5 }],
      [so("A", 10, 4) /* remaining 6 */, so("B", 5, 0) /* remaining 5, exact fit */],
    );
    expect(offender).toBeNull();
  });

  test("rejects the first line whose request exceeds remaining", () => {
    const offender = findOverConvertOffender(
      [{ soItemId: "A", qty: 7 }],
      [so("A", 10, 4)], // remaining 6, requested 7
    );
    expect(offender).toEqual({ soItemId: "A", requested: 7, remaining: 6 });
  });

  test("one SO line split across two PO lines is summed once, in full", () => {
    // 4 + 3 = 7 against remaining 6 -> over. Reading only one line would miss it.
    const offender = findOverConvertOffender(
      [{ soItemId: "A", qty: 4 }, { soItemId: "A", qty: 3 }],
      [so("A", 10, 4)],
    );
    expect(offender).toEqual({ soItemId: "A", requested: 7, remaining: 6 });
  });

  test("a fully-picked SO line rejects any further convert", () => {
    const offender = findOverConvertOffender(
      [{ soItemId: "A", qty: 1 }],
      [so("A", 10, 10)], // remaining 0
    );
    expect(offender).toEqual({ soItemId: "A", requested: 1, remaining: 0 });
  });

  test("manual lines (no soItemId) never trip the cap", () => {
    const offender = findOverConvertOffender(
      [{ qty: 999 }, { soItemId: null, qty: 999 }],
      [so("A", 1, 0)],
    );
    expect(offender).toBeNull();
  });

  test("an SO row with no matching pick is ignored", () => {
    // Picks reference B only; A is loaded but not requested here.
    const offender = findOverConvertOffender(
      [{ soItemId: "B", qty: 2 }],
      [so("A", 1, 0), so("B", 5, 0)],
    );
    expect(offender).toBeNull();
  });
});
