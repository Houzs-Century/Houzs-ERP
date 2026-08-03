import { describe, expect, test } from "vitest";
import { stockCheckableLines } from "../src/scm/lib/check-stock-availability";

/* The pre-flight short-stock guard must measure EXACTLY the lines the inventory
   OUT will touch. Every failure of this guard has been the same asymmetry: the
   dialog asked the operator to waive a shortage the movement could never have
   produced, so "Ship anyway" became the only way past a line that never moves
   stock (Nico, 2026-08-03 — a DO for 2990-SO-2606-034 blocked on SVC-DISPOSE-SOFA
   and SVC-DELIVERY-CROSS being "short 1" at BALAKONG).

   Only the pure line-selection invariant is unit-tested here; that the guard
   actually runs against a real inventory_balances read is a staging check (this
   suite binds no Postgres), the same honest limit as doOverDelivery. */
describe("stockCheckableLines", () => {
  const goods = { itemCode: "XAMMAR-L(LHF)", itemGroup: "sofa", qty: 1 };

  test("goods lines are measured", () => {
    expect(stockCheckableLines([goods])).toEqual([goods]);
  });

  test("a SERVICE line is dropped by its SVC- code even when item_group says otherwise", () => {
    // The exact pair that blocked 2606-034: one carries item_group 'others'.
    const dispose = { itemCode: "SVC-DISPOSE-SOFA", itemGroup: "others", qty: 1 };
    const delivery = { itemCode: "SVC-DELIVERY-CROSS", itemGroup: "service", qty: 1 };
    expect(stockCheckableLines([goods, dispose, delivery])).toEqual([goods]);
  });

  test("a SERVICE line is dropped by its item_group even when the code is not SVC-", () => {
    const line = { itemCode: "LEGACY-FEE", itemGroup: "service", qty: 2 };
    expect(stockCheckableLines([line])).toEqual([]);
  });

  test("zero-qty lines are dropped — nothing ships, nothing moves", () => {
    expect(stockCheckableLines([{ ...goods, qty: 0 }])).toEqual([]);
  });

  test("negative qty is dropped too (never a shortage to waive)", () => {
    expect(stockCheckableLines([{ ...goods, qty: -1 }])).toEqual([]);
  });

  test("a missing item_group does not smuggle a service SKU through", () => {
    const line = { itemCode: "SVC-LIFT-CARRY-F3", qty: 1 };
    expect(stockCheckableLines([line])).toEqual([]);
  });

  test("an all-service pick yields nothing to check, not a shortage", () => {
    const lines = [
      { itemCode: "SVC-DELIVERY", itemGroup: "service", qty: 1 },
      { itemCode: "SVC-DISPOSE-MATTRESS", itemGroup: "service", qty: 1 },
    ];
    expect(stockCheckableLines(lines)).toEqual([]);
  });
});
