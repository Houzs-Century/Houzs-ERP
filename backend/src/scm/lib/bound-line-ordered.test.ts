/* A hard-bound sales-order line may be ordered once — per LINE, whichever screen
   raises the purchase order (owner 2026-09-14, the custom pillow ruling).

   The convert let an MRP-origin line through with NO cap at all ("reference-only,
   infinitely convertible — the pooled picker decides"), and the ordinary cap
   (`qty - po_qty_picked`) does not count MRP-origin lines. For a pooled SKU that
   is the design. For a bound line it is how production got five custom pillow
   lines ordered twice: HC-SO-013236 line 5 on HC-PO-009945 AND HC-PO-2609-058,
   HC-SO-013322 line 2 on HC-PO-010161 AND HC-PO-2609-060, and HC-SO-013503 line 2
   on HC-PO-2609-091 then HC-PO-2609-101 (since cancelled). */
import { describe, expect, test } from 'vitest';
import { loadBoundOrderedQty, boundAwarePicked } from './bound-line-ordered';

type Row = Record<string, unknown>;

function fakeSb(tables: Record<string, Row[]>) {
  const calls: string[] = [];
  class Q {
    rows: Row[];
    constructor(t: string, rows: Row[]) { calls.push(t); this.rows = [...rows]; }
    select() { return this; }
    eq(col: string, val: unknown) { this.rows = this.rows.filter((r) => r[col] === val); return this; }
    in(col: string, vals: unknown[]) { this.rows = this.rows.filter((r) => vals.includes(r[col])); return this; }
    order() { return this; }
    range(from: number, to: number) { this.rows = this.rows.slice(from, to + 1); return this; }
    then<T>(onF: (v: { data: Row[]; error: null }) => T) { return Promise.resolve({ data: this.rows, error: null }).then(onF); }
  }
  return { from: (t: string) => new Q(t, tables[t] ?? []), calls };
}

const poLine = (soItemId: string, qty: number, status: string, company = 1): Row => ({
  so_item_id: soItemId, qty, company_id: company, po: { status },
});

describe('loadBoundOrderedQty', () => {
  const pillow = { id: 'l-013503', item_group: 'fabric_accessory', item_code: 'LONG PILLOW' };

  test('counts every LIVE purchase-order line on a bound line, MRP-origin included', async () => {
    const sb = fakeSb({ purchase_order_items: [poLine('l-013503', 3, 'SUBMITTED'), poLine('l-013503', 2, 'CANCELLED'), poLine('l-013503', 1, 'DRAFT')] });
    const got = await loadBoundOrderedQty(sb, 1, [pillow]);
    expect(got.get('l-013503')).toBe(3);
  });

  test('a pooled line is not read at all — its cap stays po_qty_picked', async () => {
    const sb = fakeSb({ purchase_order_items: [poLine('l-plain', 3, 'SUBMITTED')] });
    const got = await loadBoundOrderedQty(sb, 1, [{ id: 'l-plain', item_group: 'accessory', item_code: 'AK- ESSENTIAL BOLSTER' }]);
    expect(got.size).toBe(0);
    expect(sb.calls).toHaveLength(0);
  });

  test('company 2 pools: nothing is bound there', async () => {
    const sb = fakeSb({ purchase_order_items: [poLine('l-013503', 3, 'SUBMITTED', 2)] });
    const got = await loadBoundOrderedQty(sb, 2, [pillow]);
    expect(got.size).toBe(0);
  });

  test('a null company binds nothing — the stricter reading belongs to the caller that knows its company', async () => {
    const sb = fakeSb({ purchase_order_items: [poLine('l-013503', 3, 'SUBMITTED')] });
    expect((await loadBoundOrderedQty(sb, null, [pillow])).size).toBe(0);
  });
});

describe('boundAwarePicked', () => {
  test('HC-SO-013503 line 2: qty 3, picked 0 (the PO was MRP-origin), ordered 3 -> no headroom left', () => {
    const row = { id: 'l-013503', qty: 3, po_qty_picked: 0 };
    const picked = boundAwarePicked(row, new Map([['l-013503', 3]]));
    expect(row.qty - picked).toBe(0);
  });

  test('HC-SO-013496: a bound line with no purchase order keeps its full quantity', () => {
    const row = { id: 'l-013496', qty: 3, po_qty_picked: 0 };
    expect(row.qty - boundAwarePicked(row, new Map())).toBe(3);
  });

  test('never LOWERS the recorded pick count', () => {
    const row = { id: 'x', qty: 5, po_qty_picked: 4 };
    expect(boundAwarePicked(row, new Map([['x', 2]]))).toBe(4);
  });
});
