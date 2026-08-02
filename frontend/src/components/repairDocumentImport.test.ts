import { describe, expect, it } from "vitest";
import { applyRowEdit, type RowState } from "./RepairDocumentImport";

/**
 * The printed-amount override rule.
 *
 * The document's own line total wins by default — the vendor's rounding is
 * theirs, and a stored record that quietly disagrees with the paper is worse
 * than one that repeats it. The trap is what happens when the operator CORRECTS
 * one of that total's inputs: without clearing the printed amount, they fix a
 * misread unit price and the line sits frozen at the number they just
 * disagreed with, and the reconciliation banner goes on agreeing with it.
 */

/* WJO00403 line 3: TURBOCHARGER, 1 x RM5,600 at 15%, printed RM4,760.00. */
const turbo: RowState = {
  section: "PART",
  lineNo: 3,
  name: "TURBOCHARGER ( USED ORI )",
  partNo: null,
  uom: "UNIT",
  qty: 1,
  unitPriceCenti: 560_000,
  discountPct: 15,
  amountCenti: 476_000,
  lineCenti: 476_000,
  drop: false,
};

describe("applyRowEdit", () => {
  it("keeps the printed amount when nothing that prices the line changed", () => {
    const renamed = applyRowEdit(turbo, { name: "TURBOCHARGER (RECON)" });
    expect(renamed.amountCenti).toBe(476_000);
    expect(renamed.lineCenti).toBe(476_000);
  });

  it("dropping a line does not override its printed amount", () => {
    expect(applyRowEdit(turbo, { drop: true }).amountCenti).toBe(476_000);
  });

  it("moving a line between sections does not override it either", () => {
    expect(applyRowEdit(turbo, { section: "LABOUR" }).amountCenti).toBe(476_000);
  });

  it("correcting the unit price clears the printed amount and RECOMPUTES", () => {
    const fixed = applyRowEdit(turbo, { unitPriceCenti: 650_000 });
    expect(fixed.amountCenti).toBeNull();
    expect(fixed.lineCenti).toBe(552_500); // 6500 x 0.85
  });

  it("correcting the quantity recomputes too", () => {
    const fixed = applyRowEdit(turbo, { qty: 2 });
    expect(fixed.lineCenti).toBe(952_000); // 2 x 5600 x 0.85
  });

  it("correcting the discount recomputes", () => {
    expect(applyRowEdit(turbo, { discountPct: 0 }).lineCenti).toBe(560_000);
    expect(applyRowEdit(turbo, { discountPct: null }).lineCenti).toBe(560_000);
  });

  it("a cleared quantity or price prices the line at zero, never NaN", () => {
    expect(applyRowEdit(turbo, { qty: null }).lineCenti).toBe(0);
    expect(applyRowEdit(turbo, { unitPriceCenti: null }).lineCenti).toBe(0);
  });

  it("a line with no printed amount prices from its inputs from the start", () => {
    const noPrint: RowState = { ...turbo, amountCenti: null, lineCenti: 476_000 };
    expect(applyRowEdit(noPrint, { qty: 4 }).lineCenti).toBe(1_904_000); // 4 x 5600 x 0.85
  });

  it("never yields a negative line", () => {
    expect(applyRowEdit(turbo, { unitPriceCenti: -100 }).lineCenti).toBe(0);
  });
});
