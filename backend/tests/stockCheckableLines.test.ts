import { describe, expect, test } from "vitest";
import { stockCheckableLines, dedicatedlyCoveredSoItemIds, uncoveredStockCheckLines, checkStockAvailability } from "../src/scm/lib/check-stock-availability";

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

/* The RESOLVER, and specifically its second half. `dedicatedlyCoveredSoItemIds`
   answers two questions and the answer is the AND of them: did this line's own
   purchase order receive what we are shipping, AND does the warehouse actually
   hold the goods. The first half alone would have waved through 30 of 462 live
   lines whose warehouse holds nothing at all — trading a false "no stock" for a
   silent over-ship, the worse of the two errors. That measurement is the reason
   the second half exists, so it is pinned here rather than trusted. */
describe('dedicatedlyCoveredSoItemIds — receipt AND on-hand, never one of them', () => {
  const LINE = {
    soItemId: 'so-1', itemCode: 'JAGER-(Q)', itemGroup: 'bedframe', qty: 1, warehouseId: 'wh-pg',
  };
  /** Minimal PostgREST-shaped stub: one canned answer per table. */
  const sbWith = (received: number, onHand: number | null) => ({
    from(table: string) {
      const rows = table === 'purchase_order_items'
        ? [{ so_item_id: 'so-1', received_qty: received, po: { status: 'RECEIVED' } }]
        : onHand === null ? [] : [{ item_code: 'JAGER-(Q)', warehouse_id: 'wh-pg', qty: onHand }];
      return { select: () => ({ in: async () => ({ data: rows, error: null }) }) };
    },
  });

  test('covered when the PO received it AND the warehouse holds it', async () => {
    expect([...await dedicatedlyCoveredSoItemIds(sbWith(1, 3), [LINE], 1)]).toEqual(['so-1']);
  });

  test('NOT covered when the warehouse holds nothing — the old warning was right', async () => {
    expect([...await dedicatedlyCoveredSoItemIds(sbWith(1, 0), [LINE], 1)]).toEqual([]);
  });

  test('NOT covered when the line’s own PO received less than this delivery ships', async () => {
    expect([...await dedicatedlyCoveredSoItemIds(sbWith(0, 5), [LINE], 1)]).toEqual([]);
  });

  test('company 2 is never covered — 2990 pools, and that is the whole gate', async () => {
    expect([...await dedicatedlyCoveredSoItemIds(sbWith(1, 3), [LINE], 2)]).toEqual([]);
  });

  test('a pooled group is never covered, whatever its PO did', async () => {
    const mattress = { ...LINE, itemGroup: 'mattress', itemCode: 'AKEMI ULTIMATE MATT (Q)' };
    expect([...await dedicatedlyCoveredSoItemIds(sbWith(1, 3), [mattress], 1)]).toEqual([]);
  });
});

/* THE ORDERING BUG, PINNED. The cover test asks about THIS line's warehouse, so
   an empty warehouse map means "we do not know where this ships from" and the
   line stays a pool question — which is what the first cut of the fix did to
   EVERY line, silently, by computing cover before the warehouses were resolved. */
describe('uncoveredStockCheckLines — the warehouse map is what decides', () => {
  const LINE = {
    lineRef: 'l-1', soItemId: 'so-1', itemCode: 'JAGER-(Q)', itemGroup: 'bedframe', qty: 1,
  };
  const sb = {
    from(table: string) {
      const rows = table === 'purchase_order_items'
        ? [{ so_item_id: 'so-1', received_qty: 1, po: { status: 'RECEIVED' } }]
        : [{ item_code: 'JAGER-(Q)', warehouse_id: 'wh-pg', qty: 3 }];
      return { select: () => ({ in: async () => ({ data: rows, error: null }) }) };
    },
  };

  test('dropped when the map puts the line at the warehouse that holds the goods', async () => {
    const wh = new Map<string, string | null>([['l-1', 'wh-pg']]);
    expect(await uncoveredStockCheckLines(sb, [LINE], wh, 1)).toEqual([]);
  });

  test('kept when the map is empty — the warehouse is unknown, so it stays a pool question', async () => {
    expect(await uncoveredStockCheckLines(sb, [LINE], new Map(), 1)).toEqual([LINE]);
  });
});
