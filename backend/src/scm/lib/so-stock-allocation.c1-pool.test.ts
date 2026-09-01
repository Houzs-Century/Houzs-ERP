/* COMPANY-1 BOUND GROUPS NEVER LIGHT FROM THE POOL (owner, ruled three times:
 * 2026-08-10 "Houzs 的 BEDFRAME 可以用 Convert To…代表这个 PO 是 assign 给这个
 * SalesOrder 的"; 2026-08-29 the (SP) extension; 2026-08-30 "他明明都没有 PO,
 * 怎么会 ready 呢…它一定是根据 PO…Company 1 跟 Company 2 机制是不一样的").
 *
 * The engine's bound pass lit dedicated receipts first but let an un-receipted
 * bound line FALL THROUGH to the pooled walk — dormant while variant buckets
 * mismatched, and FIRING the moment both sides are blank: production census
 * 2026-08-30 (run 33287776781) caught HC-SO-013253 JAGER-(Q), blank variant,
 * READY with no PO at all, matched against blank-variant migrated stock.
 *
 * The first test FAILS pre-fix (that exact shape read READY); the guards pin
 * that the fix touches nothing else: a received dedication still lights C1,
 * company 2 still pools, and a C1 STANDARD mattress still pools.
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

const world = (opts: {
  company: number; group: string; code: string;
  variants?: Row | null; poItems?: Row[]; pooledQty?: number; category?: string;
}) => fakeSb({
  stock_allocation_recompute_lock: [{ lock_key: 'GLOBAL', locked_by: null, locked_until: null }],
  mfg_sales_orders: [{
    doc_no: 'TEST-SO-0001', status: 'CONFIRMED', created_at: '2026-08-01T00:00:00Z',
    customer_delivery_date: '2026-09-01', company_id: opts.company,
    processing_date: '2026-08-15', proceeded_at: null,
  }],
  mfg_sales_order_items: [{
    id: 'line-1', doc_no: 'TEST-SO-0001', item_code: opts.code, item_group: opts.group,
    variants: opts.variants ?? null, qty: 1, warehouse_id: WH, stock_status: 'PENDING',
    stock_qty_ready: 0, cancelled: false, allocated_batch_no: null, po_items: opts.poItems ?? [],
  }],
  mfg_products: [{ code: opts.code, category: opts.category ?? opts.group.toUpperCase() }],
  inventory_balances: opts.pooledQty
    ? [{ warehouse_id: WH, item_code: opts.code, variant_key: '', qty: opts.pooledQty }]
    : [],
  v_inventory_lots_open: [],
  delivery_orders: [], delivery_order_items: [], delivery_returns: [], delivery_return_items: [],
  purchase_order_items: [], mfg_so_audit_log: [], mfg_so_status_changes: [],
});

const lineOf = (sb: any) => sb.tables['mfg_sales_order_items'][0];

describe('company-1 hard binding: the pool is never a bound line\'s evidence', () => {
  test('a C1 bedframe with NO PO stays PENDING even with matching pooled stock (HC-SO-013253)', async () => {
    /* Blank variants on BOTH sides — the exact production shape the census
       caught: the line's blank key met the migrated stock's blank key and the
       pooled walk lit it with no purchase order anywhere. */
    const sb = world({ company: 1, group: 'bedframe', code: 'JAGER-(Q)', pooledQty: 5 });
    const res = await recomputeSoStockAllocation(sb);
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(lineOf(sb).stock_status).toBe('PENDING');
    expect(lineOf(sb).stock_qty_ready).toBe(0);
  });

  test('a C1 bedframe WITH its own received PO still lights — the bound pass is untouched', async () => {
    const sb = world({ company: 1, group: 'bedframe', code: 'JAGER-(Q)', poItems: [{ qty: 1, received_qty: 1 }] });
    const res = await recomputeSoStockAllocation(sb);
    expect(res.ok).toBe(true);
    expect(lineOf(sb).stock_status).toBe('READY');
    expect(lineOf(sb).stock_qty_ready).toBe(1);
  });

  test('a company-2 bedframe still POOLS — 2990 keeps its soft model', async () => {
    const sb = world({ company: 2, group: 'bedframe', code: 'LYRA-(K)', pooledQty: 3 });
    const res = await recomputeSoStockAllocation(sb);
    expect(res.ok).toBe(true);
    expect(lineOf(sb).stock_status).toBe('READY');
  });

  test('a C1 STANDARD mattress still pools — only the bound groups bind', async () => {
    const sb = world({ company: 1, group: 'mattress', code: 'AKEMI BULWARK MATT (K)', category: 'MATTRESS', pooledQty: 2 });
    const res = await recomputeSoStockAllocation(sb);
    expect(res.ok).toBe(true);
    expect(lineOf(sb).stock_status).toBe('READY');
  });
});
