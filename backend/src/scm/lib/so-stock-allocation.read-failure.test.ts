/* READY audit F3 (2026-10-16): the allocator read the SO-line -> PO-receipt
 * links without checking the error. A failed read looked like "nothing has
 * been received", so a hard-bound READY line was written PENDING and its
 * READY_TO_SHIP order regressed, under { ok: true } with no retry. The read
 * now throws before anything is written, and the wrapper queues the retry.
 *
 * Fails pre-fix: the line went READY -> PENDING and the order to IN_PRODUCTION.
 */
import { describe, expect, test } from 'vitest';
import { recomputeSoStockAllocation } from './so-stock-allocation';

type Row = Record<string, unknown>;
type Result = { data: Row[] | null; error: { message: string } | null };
type Query = {
  select(cols?: string): Query; insert(p: Row | Row[]): Query; upsert(p: Row | Row[]): Query;
  update(p: Row): Query; eq(c: string, v: unknown): Query; in(c: string, vs: unknown[]): Query;
  gt(c: string, v: unknown): Query; not(c: string, op: string, v: string | null): Query;
  or(): Query; order(): Query; range(): Query; limit(): Query;
  maybeSingle(): Promise<{ data: Row | null; error: Result['error'] }>;
  then<T>(resolve: (v: Result) => T): Promise<T>;
};
type FakeSb = { from(table: string): Query; tables: Record<string, Row[]> };

/** A PostgREST stand-in. `failSelect` makes any read whose column list
 *  contains that text answer with an error, as a timed-out query would. */
function fakeSb(tables: Record<string, Row[]>, failSelect?: string): FakeSb {
  const from = (table: string): Query => {
    const filters: Array<(r: Row) => boolean> = [];
    let pendingUpdate: Row | null = null;
    let pendingInsert: Row[] | null = null;
    let failing = false;
    const src = (): Row[] => (tables[table] ??= []);
    const rows = () => src().filter((r) => filters.every((f) => f(r)));
    const settle = (): Result => {
      if (failing) return { data: null, error: { message: 'canceling statement due to statement timeout' } };
      if (pendingInsert) { src().push(...pendingInsert); return { data: pendingInsert, error: null }; }
      if (pendingUpdate) {
        const hit = rows();
        for (const r of hit) Object.assign(r, pendingUpdate);
        return { data: hit, error: null };
      }
      return { data: rows(), error: null };
    };
    const field = (r: Row, c: string): unknown => r[c.includes('.') ? c.split('.').pop() ?? c : c];
    const q: Query = {
      select: (cols) => { if (failSelect && cols?.includes(failSelect)) failing = true; return q; },
      insert: (p) => { pendingInsert = Array.isArray(p) ? p : [p]; return q; },
      upsert: (p) => { pendingInsert = Array.isArray(p) ? p : [p]; return q; },
      update: (p) => { pendingUpdate = p; return q; },
      eq: (c, v) => { filters.push((r) => String(r[c]) === String(v)); return q; },
      in: (c, vs) => { const set = new Set(vs.map(String)); filters.push((r) => set.has(String(r[c]))); return q; },
      gt: (c, v) => {
        if (c.includes('.')) {
          const [head, tail] = c.split('.') as [string, string];
          filters.push((r) => Array.isArray(r[head]) && (r[head] as Row[]).some((e) => Number(e[tail] ?? 0) > Number(v)));
        } else filters.push((r) => Number(r[c] ?? 0) > Number(v));
        return q;
      },
      not: (c, op, v) => {
        if (op === 'is' && v === null) { filters.push((r) => r[c] != null); return q; }
        const set = new Set(String(v).replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, '')));
        filters.push((r) => !set.has(String(field(r, c))));
        return q;
      },
      or: () => q, order: () => q, range: () => q, limit: () => q,
      maybeSingle: () => { const s = settle(); return Promise.resolve({ data: s.data?.[0] ?? null, error: s.error }); },
      then: (resolve) => Promise.resolve(settle()).then(resolve),
    };
    return q;
  };
  return { from, tables };
}

const world = (failSelect?: string) => fakeSb({
  stock_allocation_recompute_lock: [{ lock_key: 'GLOBAL', locked_by: null, locked_until: null }],
  stock_allocation_recompute_queue: [],
  mfg_sales_orders: [{
    doc_no: 'TEST-SO-0001', status: 'READY_TO_SHIP', created_at: '2026-08-01T00:00:00Z',
    customer_delivery_date: '2026-09-01', amended_delivery_date: null, company_id: 1,
    processing_date: '2026-08-15', proceeded_at: null, version: 1,
    edit_lease_token: null, edit_lease_expires_at: null,
  }],
  mfg_sales_order_items: [{
    id: 'line-1', doc_no: 'TEST-SO-0001', item_code: 'JAGER-(Q)', item_group: 'bedframe',
    variants: null, qty: 1, warehouse_id: 'WH-MAIN', stock_status: 'READY', stock_qty_ready: 1,
    cancelled: false, allocated_batch_no: null, po_items: [{ qty: 1, received_qty: 1 }], do_items: [],
  }],
  mfg_products: [{ code: 'JAGER-(Q)', category: 'BEDFRAME' }],
  inventory_balances: [], v_inventory_lots_open: [], warehouses: [],
  delivery_orders: [], delivery_order_items: [], delivery_returns: [], delivery_return_items: [],
  purchase_order_items: [], mfg_so_audit_log: [], mfg_so_status_changes: [],
}, failSelect);

describe('a failed PO-receipt read stops the allocation', () => {
  test('the READY bound line and its READY_TO_SHIP order are left alone, and a retry is queued', async () => {
    const sb = world('po_items:');
    const res = await recomputeSoStockAllocation(sb);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/PO-receipt load failed/);
    expect(res.queuedForRetry).toBe(true);
    expect(sb.tables.stock_allocation_recompute_queue).toHaveLength(1);
    const line = sb.tables.mfg_sales_order_items[0]!;
    expect(line.stock_status).toBe('READY');
    expect(line.stock_qty_ready).toBe(1);
    expect(sb.tables.mfg_sales_orders[0]!.status).toBe('READY_TO_SHIP');
    expect(sb.tables.mfg_so_status_changes).toHaveLength(0);
  });

  test('the same world with a working read keeps the line READY (the fixture is sound)', async () => {
    const sb = world();
    const res = await recomputeSoStockAllocation(sb);
    expect(res.ok).toBe(true);
    expect(sb.tables.mfg_sales_order_items[0]!.stock_status).toBe('READY');
    expect(sb.tables.mfg_sales_orders[0]!.status).toBe('READY_TO_SHIP');
  });
});
