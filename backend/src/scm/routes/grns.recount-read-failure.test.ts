/* READY audit F2 (2026-10-16): recomputePoReceived did not check its reads.
 * A failed grn_items read looked like "no receipts" and wrote received_qty 0
 * over a real receipt (PO back to SUBMITTED, bound SO lines PENDING); a failed
 * grns read counted a CANCELLED GRN as received (the HC-0106 shape). Both
 * returned { ok: true }, so no RECOUNT_FAILED row was left. A failed read now
 * stops the recount before any write and returns the failure.
 *
 * The first three tests fail pre-fix: received_qty went 1 -> 0 and 0 -> 1,
 * and a failed header read re-stamped received_at.
 */
import { describe, expect, test } from 'vitest';
import { recomputePoReceived } from './grns';

type Row = Record<string, unknown>;
type Result = { data: Row[] | null; error: { message: string } | null };
type Query = {
  select(): Query; update(p: Row): Query; eq(c: string, v: unknown): Query;
  in(c: string, vs: unknown[]): Query; not(): Query;
  maybeSingle(): Promise<{ data: Row | null; error: Result['error'] }>;
  then<T>(resolve: (v: Result) => T): Promise<T>;
};

/** A PostgREST stand-in; reads of `failRead` answer with an error. */
function fakeSb(tables: Record<string, Row[]>, failRead?: string) {
  const from = (table: string): Query => {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    const rows = () => (tables[table] ??= []).filter((r) => filters.every((f) => f(r)));
    const settle = (): Result => {
      if (!patch && table === failRead) {
        return { data: null, error: { message: 'canceling statement due to statement timeout' } };
      }
      if (patch) {
        const hit = rows();
        for (const r of hit) Object.assign(r, patch);
        return { data: hit, error: null };
      }
      return { data: rows(), error: null };
    };
    const q: Query = {
      select: () => q,
      update: (p) => { patch = p; return q; },
      eq: (c, v) => { filters.push((r) => String(r[c]) === String(v)); return q; },
      in: (c, vs) => { const s = new Set(vs.map(String)); filters.push((r) => s.has(String(r[c]))); return q; },
      not: () => q,
      maybeSingle: () => { const s = settle(); return Promise.resolve({ data: s.data?.[0] ?? null, error: s.error }); },
      then: (resolve) => Promise.resolve(settle()).then(resolve),
    };
    return q;
  };
  return { from, tables };
}

const world = (received: number, grnStatus: string) => ({
  purchase_order_items: [{ id: 'poi-1', purchase_order_id: 'po-1', qty: 1, received_qty: received }],
  purchase_orders: [{
    id: 'po-1', status: received > 0 ? 'RECEIVED' : 'SUBMITTED',
    received_at: received > 0 ? '2026-10-01T00:00:00Z' : null,
  }],
  grn_items: [{ purchase_order_item_id: 'poi-1', qty_accepted: 1, returned_qty: 0, grn_id: 'g-1' }],
  grns: [{ id: 'g-1', status: grnStatus }],
});

describe('recomputePoReceived stops on a failed read', () => {
  test('GRN line read fails: a received PO line keeps its count and the PO stays RECEIVED', async () => {
    const sb = fakeSb(world(1, 'POSTED'), 'grn_items');
    const res = await recomputePoReceived(sb, ['poi-1']);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/GRN line read failed/);
    expect(sb.tables.purchase_order_items[0]!.received_qty).toBe(1);
    expect(sb.tables.purchase_orders[0]!.status).toBe('RECEIVED');
  });

  test('GRN status read fails: a cancelled GRN is not counted as received', async () => {
    const sb = fakeSb(world(0, 'CANCELLED'), 'grns');
    const res = await recomputePoReceived(sb, ['poi-1']);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/GRN status read failed/);
    expect(sb.tables.purchase_order_items[0]!.received_qty).toBe(0);
    expect(sb.tables.purchase_orders[0]!.status).toBe('SUBMITTED');
  });

  test('PO header read fails: the first-receipt date is not re-stamped', async () => {
    const sb = fakeSb(world(1, 'POSTED'), 'purchase_orders');
    const res = await recomputePoReceived(sb, ['poi-1']);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/PO header read failed/);
    expect(sb.tables.purchase_orders[0]!.received_at).toBe('2026-10-01T00:00:00Z');
  });

  test('with working reads the recount still converges (cancelled GRN releases the line)', async () => {
    const sb = fakeSb(world(1, 'CANCELLED'));
    const res = await recomputePoReceived(sb, ['poi-1']);
    expect(res.ok).toBe(true);
    expect(sb.tables.purchase_order_items[0]!.received_qty).toBe(0);
    expect(sb.tables.purchase_orders[0]!.status).toBe('SUBMITTED');
  });
});
