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
  unitPriceSen: 560_000,
  discountPct: 15,
  amountSen: 476_000,
  lineSen: 476_000,
  drop: false,
};

describe("applyRowEdit", () => {
  it("keeps the printed amount when nothing that prices the line changed", () => {
    const renamed = applyRowEdit(turbo, { name: "TURBOCHARGER (RECON)" });
    expect(renamed.amountSen).toBe(476_000);
    expect(renamed.lineSen).toBe(476_000);
  });

  it("dropping a line does not override its printed amount", () => {
    expect(applyRowEdit(turbo, { drop: true }).amountSen).toBe(476_000);
  });

  it("moving a line between sections does not override it either", () => {
    expect(applyRowEdit(turbo, { section: "LABOUR" }).amountSen).toBe(476_000);
  });

  it("correcting the unit price clears the printed amount and RECOMPUTES", () => {
    const fixed = applyRowEdit(turbo, { unitPriceSen: 650_000 });
    expect(fixed.amountSen).toBeNull();
    expect(fixed.lineSen).toBe(552_500); // 6500 x 0.85
  });

  it("correcting the quantity recomputes too", () => {
    const fixed = applyRowEdit(turbo, { qty: 2 });
    expect(fixed.lineSen).toBe(952_000); // 2 x 5600 x 0.85
  });

  it("correcting the discount recomputes", () => {
    expect(applyRowEdit(turbo, { discountPct: 0 }).lineSen).toBe(560_000);
    expect(applyRowEdit(turbo, { discountPct: null }).lineSen).toBe(560_000);
  });

  it("a cleared quantity or price prices the line at zero, never NaN", () => {
    expect(applyRowEdit(turbo, { qty: null }).lineSen).toBe(0);
    expect(applyRowEdit(turbo, { unitPriceSen: null }).lineSen).toBe(0);
  });

  it("a line with no printed amount prices from its inputs from the start", () => {
    const noPrint: RowState = { ...turbo, amountSen: null, lineSen: 476_000 };
    expect(applyRowEdit(noPrint, { qty: 4 }).lineSen).toBe(1_904_000); // 4 x 5600 x 0.85
  });

  it("never yields a negative line", () => {
    expect(applyRowEdit(turbo, { unitPriceSen: -100 }).lineSen).toBe(0);
  });
});
