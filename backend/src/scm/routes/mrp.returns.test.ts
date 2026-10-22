// 2990-0011 (Sim, 2026-10-20): a customer-rejected Delivery Return is not
// demand again. 2990-DR-2610-001 brought back the XAMMAR set of
// 2990-SO-2606-001; the returned set stays in stock for the next matching
// order, and a customer who still wants the item gets a new SO.
import { describe, expect, test, vi } from 'vitest';

const deliverable = new Map<string, { delivered: number; returned: number }>();
vi.mock('./delivery-orders-mfg', () => ({
  soDeliverableRemaining: async (_sb: unknown, docNos: string[]) =>
    new Map([...deliverable].filter(([id]) => docNos.some((d) => id.startsWith(d)))),
}));

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

const sofaLine = (docNo: string, delivery: string): Row => ({
  id: `${docNo}:1`, doc_no: docNo, item_code: 'XAMMAR-2A(LHF)', description: 'XAMMAR 2A(LHF)',
  item_group: 'sofa', variants: { fabricCode: 'EZ-003', seatHeight: '28', legHeight: '6"' }, qty: 1,
  warehouse_id: 'KL', line_delivery_date: delivery, line_no: 1, created_at: '2026-06-11T00:00:00Z',
  cancelled: false, allocated_batch_no: null,
  so: { debtor_name: 'x', status: 'READY_TO_SHIP', so_date: '2026-06-11', customer_delivery_date: delivery, processing_date: '2026-06-17', customer_state: null },
});

const run = () => computeMrp(fakeSb({
  mfg_sales_order_items: [sofaLine('2990-SO-2606-001', '2026-07-19'), sofaLine('2990-SO-2611-001', '2026-12-01')],
  v_inventory_lots_open: [{
    warehouse_id: 'KL', item_code: 'XAMMAR-2A(LHF)', variant_key: 'fabriccode=ez-003|seatheight=28|legheight=6"',
    batch_no: '2990-PO-2606-010', qty_remaining: 1, received_at: '2026-10-19T08:50:58Z',
  }],
}) as never, { catFilter: null, whFilter: null, includeUndated: true, companyId: null, leadBuffers: NO_BUFFERS });

describe('computeMrp — a returned unit is not demand again (2990-0011)', () => {
  test('the returned order drops off MRP and its set is ready stock for the next matching order', async () => {
    deliverable.set('2990-SO-2606-001:1', { delivered: 1, returned: 1 });

    const res = await run();

    expect(res.sofaSets.map((s) => s.soDocNo)).toEqual(['2990-SO-2611-001']);
    const next = res.sofaSets[0]!;
    expect(next.stockQty).toBe(1);
    expect(next.shortageQty).toBe(0);
    expect(next.batchNo).toBe('2990-PO-2606-010');
  });

  test('an order still out with the customer stays off MRP as before', async () => {
    deliverable.set('2990-SO-2606-001:1', { delivered: 1, returned: 0 });

    const res = await run();

    expect(res.sofaSets.map((s) => s.soDocNo)).toEqual(['2990-SO-2611-001']);
  });
});
