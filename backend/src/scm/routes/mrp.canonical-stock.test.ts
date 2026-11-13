// 2990-0059 (Farra, 2026-11-13): 2990-SO-2608-073's BF-01 bedframe was received
// and read READY on the sales order, yet MRP still listed it as short. Its unit
// sat under `...|legheight=2"` while the line asked `...|legheight=2"|totalheight=22"`.
// The SO allocator compares keys canonically for company 2 since #5617; MRP
// compared the exact string.
import { describe, expect, test } from 'vitest';
import { computeMrp } from './mrp';
import { NO_BUFFERS } from '../lib/lead-time';
import { parsePgrestInList } from '../lib/pgrest-in-list';

type Row = Record<string, unknown>;

function fakeSb(tables: Record<string, Row[]>) {
  class Q {
    rows: Row[];
    private window: [number, number] | null = null;
    constructor(rows: Row[]) { this.rows = [...rows]; }
    select() { return this; }
    eq(col: string, val: unknown) { this.rows = this.rows.filter((r) => r[col] === val); return this; }
    in(col: string, vals: unknown[]) { this.rows = this.rows.filter((r) => vals.includes(r[col])); return this; }
    filter(col: string, _op: string, val: string) { return this.in(col, parsePgrestInList(val)); }
    not() { return this; }
    is(col: string, val: unknown) { this.rows = this.rows.filter((r) => (r[col] ?? null) === val); return this; }
    gt(col: string, val: number) { this.rows = this.rows.filter((r) => Number(r[col] ?? 0) > val); return this; }
    order() { return this; }
    range(from: number, to: number) { this.window = [from, to]; return this; }
    then<T>(onF: (v: { data: Row[]; error: null }) => T, onR?: (e: unknown) => T) {
      const data = this.window ? this.rows.slice(this.window[0], this.window[1] + 1) : this.rows;
      return Promise.resolve({ data, error: null as null }).then(onF, onR);
    }
  }
  return { from: (table: string) => new Q(tables[table] ?? []) };
}

const line: Row = {
  id: 'si-bf01', doc_no: '2990-SO-2608-073', item_code: 'CODY-(K)', description: 'CODY BEDFRAME 6FT',
  item_group: 'bedframe', qty: 1,
  variants: { fabricCode: 'BF-01', gap: '12"', divanHeight: '8"', legHeight: '2"', totalHeight: '22"' },
  warehouse_id: 'KL', line_delivery_date: '2026-11-16', line_no: 3, created_at: '2026-08-31T00:00:00Z',
  cancelled: false, allocated_batch_no: null,
  so: { debtor_name: 'x', status: 'READY_TO_SHIP', so_date: '2026-08-31', customer_delivery_date: '2026-11-16', processing_date: '2026-09-13', customer_state: null },
};

const run = (companyId: number | null) => computeMrp(fakeSb(Object.fromEntries(Object.entries({
  mfg_sales_order_items: [line],
  warehouses: [{ id: 'KL', code: 'KL WAREHOUSE', name: 'KL', is_active: true }],
  mfg_products: [{ id: 'p1', code: 'CODY-(K)', name: 'CODY BEDFRAME 6FT', category: 'BEDFRAME' }],
  inventory_balances: [{ item_code: 'CODY-(K)', warehouse_id: 'KL', variant_key: 'fabriccode=bf-01|gap=12"|divanheight=8"|legheight=2"', qty: 1 }],
}).map(([t, rows]) => [t, rows.map((r) => ({ company_id: companyId, ...r }))]))) as unknown as Parameters<typeof computeMrp>[0],
{ catFilter: null, whFilter: null, includeUndated: true, companyId, leadBuffers: NO_BUFFERS });

describe('computeMrp — company 2 matches stock by the canonical variant key (2990-0059)', () => {
  test('stock stored without the derived total height covers the line', async () => {
    const res = await run(2);

    expect(res.skus).toHaveLength(1);
    expect(res.skus[0]!.variantKey).toContain('totalheight=22');   // the line's own key is still shown
    expect(res.skus[0]!.stock).toBe(1);
    expect(res.skus[0]!.shortage).toBe(0);
  });

  test('an unresolved company keeps the exact match', async () => {
    const res = await run(null);

    expect(res.skus[0]!.stock).toBe(0);
    expect(res.skus[0]!.shortage).toBe(1);
  });
});
