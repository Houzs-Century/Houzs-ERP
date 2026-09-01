/* SOFA LINES NEVER MET THE BOUND RULE THE OWNER NAMED THEM INTO.
 *
 * Owner 2026-08-10, quoted at BOUND_GROUPS: "SOFA 和 BEDFRAME…要走 Convert to
 * PO 的那个模式" — a bedframe or sofa line whose OWN converted PO has received
 * is READY, whatever the pooled buckets or dye lots say. Re-ruled in full on
 * 2026-08-29 (hard binding: per line, exclusive, partial receipt = partial
 * READY, until the migrated stock washes out).
 *
 * The allocator diverts every sofa line into the batch-matching pass BEFORE
 * `needs` is built, and bound mode reads only `needs` — so sofa lines never
 * reached it. A sofa set whose own PO stood fully received, with no single dye
 * lot covering the set (every migrated set, since balance-imported stock rarely
 * forms an exact multiset), stayed PENDING forever. Found on the 2026-08-28
 * re-import round: 11 sofa piece lines, recv complete, undelivered, dark
 * (docs/ac-reimport-2026-08-28-ledger.md, run 33233660301).
 *
 * The first test FAILS on the pre-fix code (the piece stays PENDING) and passes
 * once the sofa pass consults the dedication. The others pin what the fix must
 * NOT break: no dedication + no batch stays PENDING; partial receipt lights
 * PARTIAL with the received count; a covering batch still wins and stamps
 * allocated_batch_no.
 */
import { describe, expect, test } from 'vitest';
import { recomputeSoStockAllocation } from './so-stock-allocation';

type Row = Record<string, any>;

/* The gate test's purpose-built fake, extended with the two operators the
   bound read and the sofa lot load issue: `.gt('po_items.received_qty', 0)`
   (an embedded-path filter — the parent row passes when any embedded row
   does) and `.not('batch_no', 'is', null)`. Everything unimplemented throws,
   so a green test cannot come from a filter the fake ignored. */
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
        if (c.includes('.')) {
          const [head, tail] = c.split('.') as [string, string];
          filters.push((r) => Array.isArray(r[head]) && r[head].some((e: Row) => Number(e[tail] ?? 0) > Number(v)));
        } else {
          filters.push((r) => Number(r[c] ?? 0) > Number(v));
        }
        return builder;
      },
      not: (c: string, op: string, v: string | null) => {
        if (op === 'is' && v === null) {
          filters.push((r) => r[c] !== null && r[c] !== undefined);
          return builder;
        }
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
const PIECE = '9058-1S';

/* A migrated sofa piece: CONFIRMED order, Processing Date set (the gate is not
   what these tests are about), one piece line, its converted PO line embedded
   the way the bound read's `po_items:purchase_order_items!inner` returns it.
   No open lot carries a batch, so findCoveringBatch has nothing — the exact
   state every balance-imported sofa set is in. */
const world = (line: Row, poItems: Row[]) => fakeSb({
  stock_allocation_recompute_lock: [{ lock_key: 'GLOBAL', locked_by: null, locked_until: null }],
  mfg_sales_orders: [{
    doc_no: 'TEST-SO-0001',
    status: 'CONFIRMED',
    created_at: '2026-08-01T00:00:00Z',
    customer_delivery_date: '2026-09-01',
    company_id: 1,
    processing_date: '2026-08-15',
    proceeded_at: null,
  }],
  mfg_sales_order_items: [{
    id: 'line-1',
    doc_no: 'TEST-SO-0001',
    item_code: PIECE,
    item_group: 'sofa',
    variants: null,
    qty: 1,
    warehouse_id: WH,
    stock_status: 'PENDING',
    stock_qty_ready: 0,
    cancelled: false,
    allocated_batch_no: null,
    po_items: poItems,
    ...line,
  }],
  mfg_products: [{ code: PIECE, category: 'SOFA' }],
  inventory_balances: [],
  v_inventory_lots_open: [],
  delivery_orders: [],
  delivery_order_items: [],
  delivery_returns: [],
  delivery_return_items: [],
  purchase_order_items: [],
  mfg_so_audit_log: [],
  mfg_so_status_changes: [],
});

const lineOf = (sb: any) => sb.tables['mfg_sales_order_items'][0];

describe('sofa lines under hard binding', () => {
  test('a sofa piece whose own PO has received its whole quantity is READY with no covering batch', async () => {
    const sb = world({}, [{ qty: 1, received_qty: 1 }]);

    const res = await recomputeSoStockAllocation(sb);

    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(lineOf(sb).stock_status).toBe('READY');
    expect(lineOf(sb).stock_qty_ready).toBe(1);
    expect(lineOf(sb).allocated_batch_no ?? null).toBe(null);
  });

  test('partial receipt lights PARTIAL with the received count, never the full need', async () => {
    /* The owner's 2026-08-29 clause verbatim: a PO with three bedframes where
       one arrived must not mark all three READY. Same per-line arithmetic
       here: ordered 2, received 1 -> PARTIAL(1). */
    const sb = world({ qty: 2 }, [{ qty: 2, received_qty: 1 }]);

    const res = await recomputeSoStockAllocation(sb);

    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(lineOf(sb).stock_status).toBe('PARTIAL');
    expect(lineOf(sb).stock_qty_ready).toBe(1);
  });

  test('no dedication and no covering batch stays PENDING — hard binding, not pooled', async () => {
    const sb = world({ po_items: [] }, []);

    const res = await recomputeSoStockAllocation(sb);

    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(lineOf(sb).stock_status).toBe('PENDING');
    expect(lineOf(sb).stock_qty_ready).toBe(0);
  });

  test('a covering batch still wins and stamps allocated_batch_no', async () => {
    const sb = world({ po_items: [] }, []);
    sb.tables['v_inventory_lots_open'].push({
      warehouse_id: WH, item_code: PIECE, variant_key: '', batch_no: 'PO-777',
      qty_remaining: 1, received_at: '2026-08-10T00:00:00Z',
    });

    const res = await recomputeSoStockAllocation(sb);

    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(lineOf(sb).stock_status).toBe('READY');
    expect(lineOf(sb).stock_qty_ready).toBe(1);
    expect(lineOf(sb).allocated_batch_no).toBe('PO-777');
  });
});
