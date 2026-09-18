/* THE ALLOCATOR MUST SKIP NON-SELLING WAREHOUSES (owner ruling, 2026-09-08
 * 09:30 +08: 「分配时跳过这九个仓」, shown the measurement in
 * docs/showroom-stock-sellable-options.md — he picked option A).
 *
 * Until this shipped, `so-stock-allocation` read `inventory_balances` with no
 * warehouse predicate of any kind and bucketed strictly on the SO LINE's own
 * `warehouse_id`, so a line pointing at KL DISPLAY drew display stock and read
 * READY. Measured the same day (read-only run 34177208009): 9 non-selling
 * warehouses holding 1,897 units, 1,642 of them pooled — and 0 lines pointing
 * at any of them yet.
 *
 * Test 1 FAILS pre-fix: a pooled mattress at a display warehouse with matching
 * on-hand read READY. The rest pin the four ways the rule could ship
 * half-applied — a SELLING warehouse must be untouched, a SERVICE warehouse
 * must bite too, the BOUND path (a line's own received PO) must not walk past
 * the gate, and neither must the SOFA dye-lot path.
 */
import { describe, expect, test } from 'vitest';
import { recomputeSoStockAllocation } from './so-stock-allocation';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a PostgREST row is an open bag of columns; the four sibling allocator suites declare it identically.
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake mimics supabase-js, whose builder is a self-returning chain no honest type describes here.
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
      maybeSingle: async () => { const s = settle(); return { data: (s.data as Row[])[0] ?? null, error: null }; },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
    };
    return builder;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- handed to recomputeSoStockAllocation, whose own sb parameter is any (see its signature).
  return { from, tables } as any;
}

/* Codes and names are the production ones the probe named, so a reader can put
   this test next to run 34177208009 without a translation step. */
const SELLING = 'wh-hq';
const DISPLAY = 'wh-kl-display';
const SERVICE = 'wh-kl-service';

const WAREHOUSES = [
  { id: SELLING, code: 'HQ', name: 'HEAD QUARTER', type: 'others' },
  { id: DISPLAY, code: 'KL DISPLAY', name: 'BALAKONG DISPLAY', type: 'display' },
  { id: SERVICE, code: 'KL SERVICE', name: 'BALAKONG RETURNED TO SUPPLIER FOR SERVICE', type: 'service' },
];

const world = (opts: {
  warehouse: string; company?: number; group?: string; code?: string;
  poItems?: Row[]; pooledQty?: number; category?: string; lots?: Row[];
}) => fakeSb({
  warehouses: WAREHOUSES.map((w) => ({ ...w })),
  stock_allocation_recompute_lock: [{ lock_key: 'GLOBAL', locked_by: null, locked_until: null }],
  mfg_sales_orders: [{
    doc_no: 'TEST-SO-0001', status: 'CONFIRMED', created_at: '2026-09-01T00:00:00Z',
    customer_delivery_date: '2026-09-20', company_id: opts.company ?? 1,
    processing_date: '2026-09-05', proceeded_at: null,
  }],
  mfg_sales_order_items: [{
    id: 'line-1', doc_no: 'TEST-SO-0001',
    item_code: opts.code ?? 'AKEMI BULWARK MATT (K)', item_group: opts.group ?? 'mattress',
    variants: null, qty: 1, warehouse_id: opts.warehouse, stock_status: 'PENDING',
    stock_qty_ready: 0, cancelled: false, allocated_batch_no: null, po_items: opts.poItems ?? [],
  }],
  mfg_products: [{
    code: opts.code ?? 'AKEMI BULWARK MATT (K)',
    category: opts.category ?? (opts.group ?? 'mattress').toUpperCase(),
  }],
  inventory_balances: opts.pooledQty
    ? [{ warehouse_id: opts.warehouse, item_code: opts.code ?? 'AKEMI BULWARK MATT (K)', variant_key: '', qty: opts.pooledQty }]
    : [],
  v_inventory_lots_open: opts.lots ?? [],
  delivery_orders: [], delivery_order_items: [], delivery_returns: [], delivery_return_items: [],
  purchase_order_items: [], mfg_so_audit_log: [], mfg_so_status_changes: [],
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reaches into the fake's own table store, which has no exported type.
const lineOf = (sb: any) => sb.tables['mfg_sales_order_items'][0] as Row;

describe('display / showroom / service warehouses are never promised to a customer', () => {
  test('RED pre-fix: a pooled mattress at KL DISPLAY with matching on-hand read READY', async () => {
    const sb = world({ warehouse: DISPLAY, pooledQty: 5 });
    const res = await recomputeSoStockAllocation(sb);
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(lineOf(sb).stock_status).toBe('PENDING');
    expect(lineOf(sb).stock_qty_ready).toBe(0);
  });

  test('the SAME line at a selling warehouse still lights — the rule bites on the type, not on stock', async () => {
    const sb = world({ warehouse: SELLING, pooledQty: 5 });
    const res = await recomputeSoStockAllocation(sb);
    expect(res.ok).toBe(true);
    expect(lineOf(sb).stock_status).toBe('READY');
    expect(lineOf(sb).stock_qty_ready).toBe(1);
  });

  test('KL SERVICE bites too — those goods are away at the supplier, not on any floor', async () => {
    const sb = world({ warehouse: SERVICE, pooledQty: 5 });
    const res = await recomputeSoStockAllocation(sb);
    expect(res.ok).toBe(true);
    expect(lineOf(sb).stock_status).toBe('PENDING');
  });

  test('BOUND MODE does not walk past the gate: a C1 bedframe with its OWN received PO at a display warehouse stays PENDING', async () => {
    /* The bound pass lights off `purchase_order_items.received_qty` and never
       consults `inventory_balances`, so filtering the pool alone would leave
       this path wide open — the exact half-applied shape this repo keeps
       shipping. */
    const sb = world({
      warehouse: DISPLAY, group: 'bedframe', code: 'JAGER-(Q)',
      category: 'BEDFRAME', poItems: [{ qty: 1, received_qty: 1 }],
    });
    const res = await recomputeSoStockAllocation(sb);
    expect(res.ok).toBe(true);
    expect(lineOf(sb).stock_status).toBe('PENDING');
    expect(lineOf(sb).stock_qty_ready).toBe(0);
  });

  test('the same bound bedframe at a selling warehouse still lights', async () => {
    const sb = world({
      warehouse: SELLING, group: 'bedframe', code: 'JAGER-(Q)',
      category: 'BEDFRAME', poItems: [{ qty: 1, received_qty: 1 }],
    });
    const res = await recomputeSoStockAllocation(sb);
    expect(res.ok).toBe(true);
    expect(lineOf(sb).stock_status).toBe('READY');
  });

  test('SOFA dye-lot coverage does not walk past the gate either', async () => {
    const sb = world({
      warehouse: DISPLAY, group: 'sofa', code: 'BOOQIT-1A(LHF)', category: 'SOFA',
      lots: [{
        warehouse_id: DISPLAY, item_code: 'BOOQIT-1A(LHF)', variant_key: '',
        batch_no: 'PO-2026-001', qty_remaining: 4, received_at: '2026-08-01T00:00:00Z',
      }],
    });
    const res = await recomputeSoStockAllocation(sb);
    expect(res.ok).toBe(true);
    expect(lineOf(sb).stock_status).toBe('PENDING');
    expect(lineOf(sb).allocated_batch_no).toBeNull();
  });

  test('the same sofa set at a selling warehouse still claims its dye lot', async () => {
    const sb = world({
      warehouse: SELLING, group: 'sofa', code: 'BOOQIT-1A(LHF)', category: 'SOFA',
      lots: [{
        warehouse_id: SELLING, item_code: 'BOOQIT-1A(LHF)', variant_key: '',
        batch_no: 'PO-2026-001', qty_remaining: 4, received_at: '2026-08-01T00:00:00Z',
      }],
    });
    const res = await recomputeSoStockAllocation(sb);
    expect(res.ok).toBe(true);
    expect(lineOf(sb).stock_status).toBe('READY');
    expect(lineOf(sb).allocated_batch_no).toBe('PO-2026-001');
  });

  test('company 2 is gated as well — the rule is about the warehouse, not the company', async () => {
    const sb = world({ warehouse: DISPLAY, company: 2, pooledQty: 5 });
    const res = await recomputeSoStockAllocation(sb);
    expect(res.ok).toBe(true);
    expect(lineOf(sb).stock_status).toBe('PENDING');
  });
});
