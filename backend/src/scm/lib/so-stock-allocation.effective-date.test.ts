/* THE ALLOCATOR RANKS ON THE DATE THE CUSTOMER IS ACTUALLY WAITING FOR.
 *
 * The allocator hands scarce stock out greedily, earliest delivery first. It
 * ranked on `customer_delivery_date` — the customer's ORIGINAL promise, a column
 * that is deliberately never overwritten — while the delivery board, PO coverage
 * and the reservations screen had always ranked on
 * `amended_delivery_date ?? customer_delivery_date`. So a customer who
 * rescheduled moved on the board and did NOT move in the queue that decides who
 * gets the goods. Two screens, two answers, and nobody was told.
 *
 * Owner, 2026-08-18: "我们都没有排产的,我们都不是 Production,我们应该只是送货的
 * 日期而已." There is no production to schedule. There is one date — when the
 * goods must land — and everything plans on it.
 *
 * These pin BOTH directions of the flip, because a fix that simply preferred the
 * amended date in one direction and lost it in the other would look green:
 *   - an order rescheduled EARLIER must overtake one whose original was earlier;
 *   - an order rescheduled LATER must fall behind one whose original was later.
 * Both FAIL on the pre-fix code, and both fail with the SAME winner (the order
 * whose original date is earliest), which is exactly the old behaviour.
 *
 * The third test is the control: with no amendment anywhere, the earlier
 * original still wins. A "fix" that read the wrong column, or inverted the sort,
 * passes the first two and fails this one.
 *
 * Own fake, not the shared one — for the reason its sibling
 * so-stock-allocation.gate.test.ts gives: only the operators this module issues
 * are implemented, so a filter the fake does not understand throws instead of
 * silently returning every row and making a green test meaningless.
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
      in: (c: string, vs: unknown[]) => {
        const set = new Set(vs.map(String));
        filters.push((r) => set.has(String(r[c]))); return builder;
      },
      gt: (c: string, v: unknown) => { filters.push((r) => Number(r[c] ?? 0) > Number(v)); return builder; },
      not: (c: string, op: string, v: string) => {
        if (op !== 'in') throw new Error(`fake: unsupported not(${op})`);
        const set = new Set(String(v).replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, '')));
        filters.push((r) => !set.has(String(r[c.includes('.') ? c.split('.').pop()! : c])));
        return builder;
      },
      or: () => builder,
      order: () => builder,
      range: () => builder,
      limit: () => builder,
      maybeSingle: async () => {
        const s = settle();
        return { data: (s.data as Row[])?.[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
    };
    return builder;
  };
  return { from, tables } as any;
}

const WH = 'WH-MAIN';
const CODE = 'MATTRESS-TEST-SKU';

const order = (docNo: string, dates: Row): Row => ({
  doc_no: docNo,
  status: 'CONFIRMED',
  created_at: '2026-08-01T00:00:00Z',
  processing_date: '2026-08-15',
  company_id: 1,
  amended_delivery_date: null,
  ...dates,
});

const line = (docNo: string): Row => ({
  id: `line-${docNo}`,
  doc_no: docNo,
  item_code: CODE,
  item_group: 'mattress',
  variants: null,
  qty: 1,
  warehouse_id: WH,
  stock_status: 'PENDING',
  stock_qty_ready: 0,
  cancelled: false,
  allocated_batch_no: null,
});

const world = (a: Row, b: Row) => fakeSb({
  stock_allocation_recompute_lock: [{ lock_key: 'GLOBAL', locked_by: null, locked_until: null }],
  mfg_sales_orders: [a, b],
  mfg_sales_order_items: [line(String(a['doc_no'])), line(String(b['doc_no']))],
  mfg_products: [{ code: CODE, category: 'MATTRESS' }],
  inventory_balances: [{ warehouse_id: WH, item_code: CODE, variant_key: '', qty: 1 }],
  delivery_orders: [],
  delivery_order_items: [],
  delivery_returns: [],
  delivery_return_items: [],
  purchase_order_items: [],
  mfg_so_audit_log: [],
  mfg_so_status_changes: [],
});

const statusOf = (sb: any, docNo: string) =>
  sb.tables['mfg_sales_order_items'].find((r: Row) => r['doc_no'] === docNo)?.['stock_status'];

describe('stock allocation priority — the EFFECTIVE delivery date', () => {
  test('an order rescheduled EARLIER overtakes one whose original date was earlier', async () => {
    const sb = world(
      order('TEST-SO-A', { customer_delivery_date: '2026-11-01' }),
      order('TEST-SO-B', { customer_delivery_date: '2026-12-01', amended_delivery_date: '2026-10-01' }),
    );

    const res = await recomputeSoStockAllocation(sb);

    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(statusOf(sb, 'TEST-SO-B')).toBe('READY');
    expect(statusOf(sb, 'TEST-SO-A')).toBe('PENDING');
  });

  test('an order rescheduled LATER falls behind one whose original date was later', async () => {
    const sb = world(
      order('TEST-SO-A', { customer_delivery_date: '2026-11-01', amended_delivery_date: '2027-01-01' }),
      order('TEST-SO-B', { customer_delivery_date: '2026-12-01' }),
    );

    const res = await recomputeSoStockAllocation(sb);

    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(statusOf(sb, 'TEST-SO-B')).toBe('READY');
    expect(statusOf(sb, 'TEST-SO-A')).toBe('PENDING');
  });

  test('CONTROL — with no amendment the earlier original still wins', async () => {
    const sb = world(
      order('TEST-SO-A', { customer_delivery_date: '2026-11-01' }),
      order('TEST-SO-B', { customer_delivery_date: '2026-12-01' }),
    );

    const res = await recomputeSoStockAllocation(sb);

    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(statusOf(sb, 'TEST-SO-A')).toBe('READY');
    expect(statusOf(sb, 'TEST-SO-B')).toBe('PENDING');
  });
});
