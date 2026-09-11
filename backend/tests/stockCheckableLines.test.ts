import { describe, expect, test } from "vitest";
import { stockCheckableLines, checkStockAvailability } from "../src/scm/lib/check-stock-availability";

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
    expect(stockCheckableLines([goods], new Set())).toEqual([goods]);
  });

  test("a SERVICE line is dropped by its SVC- code even when item_group says otherwise", () => {
    // The exact pair that blocked 2606-034: one carries item_group 'others'.
    const dispose = { itemCode: "SVC-DISPOSE-SOFA", itemGroup: "others", qty: 1 };
    const delivery = { itemCode: "SVC-DELIVERY-CROSS", itemGroup: "service", qty: 1 };
    expect(stockCheckableLines([goods, dispose, delivery], new Set())).toEqual([goods]);
  });

  test("a SERVICE line is dropped by its item_group even when the code is not SVC-", () => {
    const line = { itemCode: "LEGACY-FEE", itemGroup: "service", qty: 2 };
    expect(stockCheckableLines([line], new Set())).toEqual([]);
  });

  test("zero-qty lines are dropped — nothing ships, nothing moves", () => {
    expect(stockCheckableLines([{ ...goods, qty: 0 }], new Set())).toEqual([]);
  });

  test("negative qty is dropped too (never a shortage to waive)", () => {
    expect(stockCheckableLines([{ ...goods, qty: -1 }], new Set())).toEqual([]);
  });

  test("a missing item_group does not smuggle a service SKU through", () => {
    const line = { itemCode: "SVC-LIFT-CARRY-F3", qty: 1 };
    expect(stockCheckableLines([line], new Set())).toEqual([]);
  });

  test("an all-service pick yields nothing to check, not a shortage", () => {
    const lines = [
      { itemCode: "SVC-DELIVERY", itemGroup: "service", qty: 1 },
      { itemCode: "SVC-DISPOSE-MATTRESS", itemGroup: "service", qty: 1 },
    ];
    expect(stockCheckableLines(lines, new Set())).toEqual([]);
  });
});

/* The cross-warehouse "alternatives" hint and the warehouse-name lookup must be
   scoped to the ACTIVE company: in the merged Houzs/2990 DB an unscoped scan
   advertises the OTHER company's warehouse (and its stock) to this operator.
   No Postgres here — a chainable fake records the predicates each query built. */
describe("checkStockAvailability company scope", () => {
  type FakeCall = { table: string; chain: Array<[string, unknown[]]> };

  function makeSb() {
    const calls: FakeCall[] = [];
    const from = (table: string) => {
      const call: FakeCall = { table, chain: [] };
      calls.push(call);
      const rows = () => {
        if (table === "warehouses") {
          return [
            { id: "WH-A", code: "A", name: "KL" },
            { id: "WH-B", code: "B", name: "2990 GUANGZHOU" },
          ];
        }
        // inventory_balances: the alternatives scan carries a neq; the target
        // on-hand read does not. Target returns nothing (short), alternatives
        // offer WH-B so the short bucket gets a hint.
        const isAlt = call.chain.some(([m]) => m === "neq");
        return isAlt
          ? [{ warehouse_id: "WH-B", item_code: "AKEMI", variant_key: "", qty: 3 }]
          : [];
      };
      const builder: any = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (resolve: (v: { data: unknown[] }) => void) =>
                resolve({ data: rows() });
            }
            return (...args: unknown[]) => {
              call.chain.push([String(prop), args]);
              return builder;
            };
          },
        },
      );
      return builder;
    };
    return { sb: { from }, calls };
  }

  const line = { itemCode: "AKEMI", productName: "Akemi Mattress", variantKey: "", qty: 5 };

  test("scopes the warehouse-name lookup and the alternatives scan to the company", async () => {
    const { sb, calls } = makeSb();
    const out = await checkStockAvailability(sb as any, "WH-A", [line], 1);

    expect(out).toHaveLength(1);
    expect(out[0].alternatives).toHaveLength(1);

    const wh = calls.find((c) => c.table === "warehouses")!;
    expect(wh.chain).toContainEqual(["eq", ["company_id", 1]]);

    const alt = calls.find(
      (c) => c.table === "inventory_balances" && c.chain.some(([m]) => m === "neq"),
    )!;
    expect(alt.chain).toContainEqual(["eq", ["company_id", 1]]);
  });

  test("degrades to NO company predicate when the company is unresolved (single-company Houzs)", async () => {
    const { sb, calls } = makeSb();
    await checkStockAvailability(sb as any, "WH-A", [line], undefined);

    const scopedAny = calls.some((c) =>
      c.chain.some(([m, a]) => m === "eq" && a[0] === "company_id"),
    );
    expect(scopedAny).toBe(false);
  });
  /* Owner 2026-09-11: 「哪一张 Sales Order 出货，它就会拿哪一张 PO，它们之间的
     relationship 都是 hard binding，不是吗?」 — readiness already honoured that
     and this guard did not, so an order could read READY while its own delivery
     read "need 1, available 0". Worked case HC-SO-013065 JAGER-(Q): own PO
     received 1/1 with the full variant, line READY, and the PG bucket at -1
     because other shipments had drained it. */
  test('a line whose own purchase order covers it is not a pool question', () => {
    const bound = { itemCode: 'JAGER-(Q)', itemGroup: 'bedframe', qty: 1, soItemId: 'so-line-1' };
    expect(stockCheckableLines([bound], new Set(['so-line-1']))).toEqual([]);
  });

  test('an uncovered line beside a covered one is still checked', () => {
    const covered = { itemCode: 'JAGER-(Q)', itemGroup: 'bedframe', qty: 1, soItemId: 'so-line-1' };
    const uncovered = { itemCode: 'JAGER-(K)', itemGroup: 'bedframe', qty: 1, soItemId: 'so-line-2' };
    expect(stockCheckableLines([covered, uncovered], new Set(['so-line-1']))).toEqual([uncovered]);
  });

  test('an EMPTY set means every line stays a pool question — what company 2 sends', () => {
    const bound = { itemCode: 'JAGER-(Q)', itemGroup: 'bedframe', qty: 1, soItemId: 'so-line-1' };
    expect(stockCheckableLines([bound], new Set())).toEqual([bound]);
  });

  test('a line with no source SO line can never be covered, whatever the set holds', () => {
    const orphan = { itemCode: 'JAGER-(Q)', itemGroup: 'bedframe', qty: 1, soItemId: null };
    expect(stockCheckableLines([orphan], new Set(['so-line-1']))).toEqual([orphan]);
  });

  test('covered does not rescue a SERVICE line — it never moved stock to begin with', () => {
    const svc = { itemCode: 'SVC-DELIVERY', itemGroup: 'service', qty: 1, soItemId: 'so-line-1' };
    expect(stockCheckableLines([svc], new Set(['so-line-1']))).toEqual([]);
  });
});
