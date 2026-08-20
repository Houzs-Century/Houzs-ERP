/* THE ALLOCATION GATE READS THE COLUMN THAT IS WRITTEN.
 *
 * The gate exists because of the owner's rule (2026-08-10): an order with no
 * Processing Date must not claim stock nor show READY TO SHIP — "有 processing
 * date 才来分配". The rule is right. The COLUMN it was keyed on was not.
 *
 * Every path that sets a Processing Date writes `processing_date`:
 *   - CREATE  mfg-sales-orders.ts:5081  `processing_date: dateOrNull(body.processingDate)`
 *   - PATCH   mfg-sales-orders.ts        the header save, via the camel->snake map
 * while the gate filtered on `proceeded_at`, a column that is stamped ONLY when
 * an order additionally clears the proceed gate at CREATE
 * (mfg-sales-orders.ts:4978, `autoProceed`) or transitions to IN_PRODUCTION
 * (:5831). An order given a Processing Date on the detail screen therefore
 * carried the date, locked, appeared on the delivery board, pushed to AutoCount
 * as PDate — and was silently refused stock forever, with the goods physically
 * in the warehouse. No error, no log, nothing on screen.
 *
 * These tests drive the REAL recompute through a fake PostgREST. The first is
 * the regression: a Processing Date, no proceed stamp, stock on the shelf. It
 * FAILS on the pre-fix code (the line stays PENDING with qty_ready 0) and
 * passes once the gate reads `processing_date`.
 *
 * The second is the rule the fix must NOT break: no Processing Date at all is
 * still refused. A "fix" that simply deleted the gate would pass the first test
 * and fail this one.
 */
import { describe, expect, test } from 'vitest';
import { recomputeSoStockAllocation } from './so-stock-allocation';

type Row = Record<string, any>;

/* A minimal PostgREST fake, purpose-built for this module rather than extending
   the shared `fake-postgrest` — the allocator needs `.not()`, `.or()` and
   `.gt()`, and several sibling worktrees are editing that shared file today.
   Only the operators this module actually issues are implemented; anything else
   throws rather than silently returning every row, because a fake that answers
   a filter it does not understand makes a green test meaningless. */
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
      eq: (c: string, v: unknown) => {
        filters.push((r) => String(r[c]) === String(v)); return builder;
      },
      in: (c: string, vs: unknown[]) => {
        const set = new Set(vs.map(String));
        filters.push((r) => set.has(String(r[c]))); return builder;
      },
      gt: (c: string, v: unknown) => {
        filters.push((r) => Number(r[c] ?? 0) > Number(v)); return builder;
      },
      /* `.not(col, 'in', '(A,B,C)')` — the PostgREST spelling the live-SO lens
         uses. Embedded paths (`so.status`) are only issued on reads this test
         serves as empty, so they are matched against the row's own column and
         an absent column simply does not match the exclusion list. */
      not: (c: string, op: string, v: string) => {
        if (op !== 'in') throw new Error(`fake: unsupported not(${op})`);
        const set = new Set(String(v).replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, '')));
        filters.push((r) => !set.has(String(r[c.includes('.') ? c.split('.').pop()! : c])));
        return builder;
      },
      /* Only the lock row's availability predicate is issued through `.or()`.
         The fake grants the lease unconditionally: single-flight is not what
         these tests are about, and a contended lock would make them flaky. */
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

/* The line is a MATTRESS: no variants, and not one of the bound groups
   (bedframe/sofa), so it walks the plain pooled path and needs neither a PO link
   nor a dye lot to become READY.

   `lock_key` MUST be the allocator's own ALLOCATION_LOCK_ROW ('GLOBAL'). With
   any other value the lease claim matches no row, the recompute returns early
   with reason 'another_recompute_in_progress' and ok:true, and a test asserting
   "the line stayed PENDING" passes without the allocator ever running. Both
   negative tests below did exactly that until this was corrected, which is why
   every test here also asserts `reason` is undefined. */
const world = (header: Row) => fakeSb({
  stock_allocation_recompute_lock: [{ lock_key: 'GLOBAL', locked_by: null, locked_until: null }],
  mfg_sales_orders: [{
    doc_no: 'TEST-SO-0001',
    status: 'CONFIRMED',
    created_at: '2026-08-01T00:00:00Z',
    customer_delivery_date: '2026-09-01',
    company_id: 1,
    ...header,
  }],
  mfg_sales_order_items: [{
    id: 'line-1',
    doc_no: 'TEST-SO-0001',
    item_code: CODE,
    item_group: 'mattress',
    variants: null,
    qty: 1,
    warehouse_id: WH,
    stock_status: 'PENDING',
    stock_qty_ready: 0,
    cancelled: false,
    allocated_batch_no: null,
  }],
  mfg_products: [{ code: CODE, category: 'MATTRESS' }],
  inventory_balances: [{ warehouse_id: WH, item_code: CODE, variant_key: '', qty: 5 }],
  delivery_orders: [],
  delivery_order_items: [],
  delivery_returns: [],
  delivery_return_items: [],
  purchase_order_items: [],
  mfg_so_audit_log: [],
  mfg_so_status_changes: [],
});

const lineOf = (sb: any) => sb.tables['mfg_sales_order_items'][0];

describe('stock allocation gate — Processing Date', () => {
  test('an order with a Processing Date and no proceed stamp gets its stock', async () => {
    /* The exact shape the detail screen produces: the operator picked a
       Processing Date, so the order is released for purchasing. Nothing stamped
       proceeded_at, because no shipped client ever writes it. Five units are on
       the shelf in the line's own warehouse. */
    const sb = world({ processing_date: '2026-08-15', proceeded_at: null });

    const res = await recomputeSoStockAllocation(sb);

    expect(res.ok).toBe(true);
    /* Non-vacuity: proves the recompute actually walked, rather than returning
       early on a lock it could not claim. */
    expect(res.reason).toBeUndefined();
    expect(lineOf(sb).stock_status).toBe('READY');
    expect(lineOf(sb).stock_qty_ready).toBe(1);
  });

  test('an order with NO Processing Date is still refused stock', async () => {
    /* The owner's rule, which the fix must preserve: nothing is prepared before
       the order is released, so an SO with no Processing Date must not claim a
       bucket however much stock is standing there. */
    const sb = world({ processing_date: null, proceeded_at: null });

    const res = await recomputeSoStockAllocation(sb);

    expect(res.ok).toBe(true);
    /* Non-vacuity: proves the recompute actually walked, rather than returning
       early on a lock it could not claim. */
    expect(res.reason).toBeUndefined();
    expect(lineOf(sb).stock_status).toBe('PENDING');
    expect(lineOf(sb).stock_qty_ready).toBe(0);
  });

  /* The regression direction the gate flip creates, pinned so it is a decision
     and not an accident: a bare proceed stamp with no Processing Date is NOT a
     Processing Date. Owner, 2026-08-13: "没有 processing date 就代表没有
     proceed". These rows can no longer be produced by any live path — CREATE's
     `autoProceed` requires a date, and the IN_PRODUCTION transition refuses
     without one — so this pins historical data only. */
  test('a bare proceed stamp with no Processing Date does not allocate', async () => {
    const sb = world({ processing_date: null, proceeded_at: '2026-08-15T02:00:00Z' });

    const res = await recomputeSoStockAllocation(sb);

    expect(res.ok).toBe(true);
    /* Non-vacuity: proves the recompute actually walked, rather than returning
       early on a lock it could not claim. */
    expect(res.reason).toBeUndefined();
    expect(lineOf(sb).stock_status).toBe('PENDING');
    expect(lineOf(sb).stock_qty_ready).toBe(0);
  });
});
