/* SPECIAL-ORDER MATTRESSES FOLLOW HARD BINDING (owner, 2026-08-29):
 * "如果是specialorder的话 也是像bedframe这样指定的 hard binding的". The book
 * marks them with an (SP) suffix; a made-to-size mattress cannot be served
 * from the standard pool. Standard mattresses stay pooled — the 2026-08-10
 * ruling that mattresses walk the normal MRP path is unchanged for them.
 *
 * The first test FAILS pre-fix (an (SP) mattress with its own received PO and
 * no pooled stock stayed PENDING); the second pins that a STANDARD mattress
 * did not silently join bound mode.
 */
import { describe, expect, test } from 'vitest';
import { recomputeSoStockAllocation } from './so-stock-allocation';

type Row = Record<string, any>;

function fakeSb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let pendingUpdate: Row | null = null;
    let pendingInsert: Row | Row[] | null = null;
    const src = () => (tables[table] ??= []);
    const rows = () => src().filter((r) => filters.every((f) => f(r)));
    const settle = () => {
      if (pendingInsert) {
        const add = Array.isArray(pendingInsert) ? pendingInsert : [pendingInsert];
        src().push(...add);
        return { data: add, error: null };
      }
      if (pendingUpdate) {
        const hit = rows();
        for (const r of hit) Object.assign(r, pendingUpdate);
        return { data: hit, error: null };
      }
      return { data: rows(), error: null };
    };
    const builder: any = {
      select: () => builder,
      insert: (p: Row | Row[]) => { pendingInsert = p; return builder; },
      upsert: (p: Row | Row[]) => { pendingInsert = p; return builder; },
      update: (p: Row) => { pendingUpdate = p; return builder; },
      eq: (c: string, v: unknown) => { filters.push((r) => String(r[c]) === String(v)); return builder; },
      in: (c: string, vs: unknown[]) => { const set = new Set(vs.map(String)); filters.push((r) => set.has(String(r[c]))); return builder; },
      gt: (c: string, v: unknown) => {
        if (c.includes('.')) {
          const [head, tail] = c.split('.') as [string, string];
          filters.push((r) => Array.isArray(r[head]) && r[head].some((e: Row) => Number(e[tail] ?? 0) > Number(v)));
        } else filters.push((r) => Number(r[c] ?? 0) > Number(v));
        return builder;
      },
      not: (c: string, op: string, v: string | null) => {
        if (op === 'is' && v === null) { filters.push((r) => r[c] !== null && r[c] !== undefined); return builder; }
        if (op !== 'in') throw new Error(`fake: unsupported not(${op})`);
        const set = new Set(String(v).replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, '')));
        filters.push((r) => !set.has(String(r[c.includes('.') ? c.split('.').pop()! : c])));
        return builder;
      },
      or: () => builder,
      order: () => builder,
      range: () => builder,
      limit: () => builder,
      maybeSingle: async () => { const s = settle(); return { data: (s.data as Row[])?.[0] ?? null, error: null }; },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
    };
    return builder;
  };
  return { from, tables } as any;
}

const WH = 'WH-MAIN';

const world = (code: string, poItems: Row[]) => fakeSb({
  stock_allocation_recompute_lock: [{ lock_key: 'GLOBAL', locked_by: null, locked_until: null }],
  mfg_sales_orders: [{
    doc_no: 'TEST-SO-0001', status: 'CONFIRMED', created_at: '2026-08-01T00:00:00Z',
    customer_delivery_date: '2026-09-01', company_id: 1, processing_date: '2026-08-15', proceeded_at: null,
  }],
  mfg_sales_order_items: [{
    id: 'line-1', doc_no: 'TEST-SO-0001', item_code: code, item_group: 'mattress',
    variants: null, qty: 1, warehouse_id: WH, stock_status: 'PENDING', stock_qty_ready: 0,
    cancelled: false, allocated_batch_no: null, po_items: poItems,
  }],
  mfg_products: [{ code, category: 'MATTRESS' }],
  inventory_balances: [],
  v_inventory_lots_open: [],
  delivery_orders: [], delivery_order_items: [], delivery_returns: [], delivery_return_items: [],
  purchase_order_items: [], mfg_so_audit_log: [], mfg_so_status_changes: [],
});

const lineOf = (sb: any) => sb.tables['mfg_sales_order_items'][0];

describe('special-order mattresses under hard binding', () => {
  test('an (SP) mattress with its own received PO is READY with no pooled stock at all', async () => {
    const sb = world('AKEMI BULWARK MATT (SP)', [{ qty: 1, received_qty: 1 }]);
    const res = await recomputeSoStockAllocation(sb);
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(lineOf(sb).stock_status).toBe('READY');
    expect(lineOf(sb).stock_qty_ready).toBe(1);
  });

  test('a STANDARD mattress did not join bound mode — no stock means PENDING even with a received PO', async () => {
    /* The 2026-08-10 ruling stands for standard sizes: mattresses pool. A
       received dedication without pooled stock must NOT light a standard
       mattress, or common stock stops being common. */
    const sb = world('AKEMI BULWARK MATT (K)', [{ qty: 1, received_qty: 1 }]);
    const res = await recomputeSoStockAllocation(sb);
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(lineOf(sb).stock_status).toBe('PENDING');
    expect(lineOf(sb).stock_qty_ready).toBe(0);
  });
});
