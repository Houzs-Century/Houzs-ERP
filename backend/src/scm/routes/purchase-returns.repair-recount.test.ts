/* B1 (Hookka-session audit, 16 Oct 2026): a REPAIR purchase return re-opened its
 * PO. 2990-PRT-2610-001 sent one XAMMAR-2A(RHF) back to HOOKKA for corner
 * cushioning; the goods moved into KL SERVICE (still owned), but the recount
 * counted the line as returned, so 2990-PO-2607-018 dropped to received 0 and
 * listed the same unit as incoming again. Only a CREDIT return consumes the
 * receipt. The REPAIR case fails pre-fix: returned_qty went 0 -> 1.
 */
import { describe, expect, test } from 'vitest';
import { adjustGrnReturnedQty } from './purchase-returns';

type Row = Record<string, unknown>;
type Result = { data: Row[] | null; error: null };
type Query = {
  select(): Query; update(p: Row): Query; eq(c: string, v: unknown): Query;
  in(c: string, vs: unknown[]): Query; not(): Query; is(): Query; order(): Query; range(): Query;
  maybeSingle(): Promise<{ data: Row | null; error: null }>;
  then<T>(resolve: (v: Result) => T): Promise<T>;
};

function fakeSb(tables: Record<string, Row[]>) {
  const from = (table: string): Query => {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    const rows = () => (tables[table] ??= []).filter((r) => filters.every((f) => f(r)));
    const settle = (): Result => {
      const hit = rows();
      if (patch) for (const r of hit) Object.assign(r, patch);
      return { data: hit, error: null };
    };
    const q: Query = {
      select: () => q,
      update: (p) => { patch = p; return q; },
      eq: (c, v) => { filters.push((r) => String(r[c]) === String(v)); return q; },
      in: (c, vs) => { const s = new Set(vs.map(String)); filters.push((r) => s.has(String(r[c]))); return q; },
      not: () => q, is: () => q, order: () => q, range: () => q,
      maybeSingle: () => { const s = settle(); return Promise.resolve({ data: s.data?.[0] ?? null, error: null }); },
      then: (resolve) => Promise.resolve(settle()).then(resolve),
    };
    return q;
  };
  return { from, tables };
}

const world = (kind: 'CREDIT' | 'REPAIR') => ({
  purchase_returns: [{ id: 'pr-1', status: 'POSTED', kind }],
  purchase_return_items: [{ grn_item_id: 'gi-1', purchase_return_id: 'pr-1', qty_returned: 1 }],
  grn_items: [{ id: 'gi-1', grn_id: 'g-1', purchase_order_item_id: 'poi-1', qty_accepted: 1, returned_qty: 0 }],
  grns: [{ id: 'g-1', status: 'POSTED' }],
  purchase_order_items: [{ id: 'poi-1', purchase_order_id: 'po-1', qty: 1, received_qty: 1 }],
  purchase_orders: [{ id: 'po-1', status: 'RECEIVED', received_at: '2026-10-01T00:00:00Z' }],
});

describe('adjustGrnReturnedQty counts CREDIT returns only', () => {
  test('a REPAIR return leaves the receipt and the PO received', async () => {
    const sb = fakeSb(world('REPAIR'));
    await adjustGrnReturnedQty(sb, 'gi-1');
    expect(sb.tables.grn_items[0].returned_qty).toBe(0);
    expect(sb.tables.purchase_order_items[0].received_qty).toBe(1);
  });

  test('a CREDIT return consumes the receipt line', async () => {
    const sb = fakeSb(world('CREDIT'));
    await adjustGrnReturnedQty(sb, 'gi-1');
    expect(sb.tables.grn_items[0].returned_qty).toBe(1);
  });
});
