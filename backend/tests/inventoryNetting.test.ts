import { describe, expect, it } from 'vitest';
import { deliveredReturnedBySoItem, nettingFromEmbedded, type EmbeddedDemandLine } from '../src/scm/lib/inventory-netting';
import { makeFakePostgrest, type Row } from './fakePostgrest';

/* HC-0002: the Inventory page now nets each open SO line from DO lines and
   returns EMBEDDED in its demand read, instead of four serial chunked reads.
   This builds both from one set of rows — the old reads against a fake
   PostgREST, the new one from the same rows shaped as PostgREST embeds them —
   and pins that they give the same delivered / returned maps. */

const tables: Record<string, Row[]> = {
  delivery_orders: [
    { id: 'do-shipped', status: 'DELIVERED' },
    { id: 'do-draft', status: 'DRAFT' },
    { id: 'do-loaded', status: 'LOADED' },
    { id: 'do-cancelled', status: 'CANCELLED' },
    { id: 'do-null-status', status: null },
    { id: 'do-lower', status: 'delivered' },
  ],
  delivery_order_items: [
    { id: 'dl-1', so_item_id: 'L1', qty: 2, delivery_order_id: 'do-shipped' },
    { id: 'dl-2a', so_item_id: 'L2', qty: 1, delivery_order_id: 'do-draft' },
    { id: 'dl-2b', so_item_id: 'L2', qty: 4, delivery_order_id: 'do-loaded' },
    { id: 'dl-2c', so_item_id: 'L2', qty: 3, delivery_order_id: 'do-cancelled' },
    { id: 'dl-3a', so_item_id: 'L3', qty: 5, delivery_order_id: 'do-shipped' },
    { id: 'dl-3b', so_item_id: 'L3', qty: null, delivery_order_id: 'do-shipped' },
    { id: 'dl-4', so_item_id: 'L4', qty: 1, delivery_order_id: 'do-missing' },
    { id: 'dl-5', so_item_id: 'L5', qty: 2, delivery_order_id: 'do-draft' },
    { id: 'dl-6', so_item_id: 'L6', qty: 7, delivery_order_id: 'do-null-status' },
    { id: 'dl-7', so_item_id: 'L7', qty: 1, delivery_order_id: 'do-lower' },
    { id: 'dl-other', so_item_id: 'NOT-ASKED', qty: 9, delivery_order_id: 'do-shipped' },
  ],
  delivery_returns: [
    { id: 'dr-open', status: 'RECEIVED' },
    { id: 'dr-cancelled', status: 'cancelled' },
    { id: 'dr-null', status: null },
  ],
  delivery_return_items: [
    { do_item_id: 'dl-3a', qty_returned: 2, delivery_return_id: 'dr-open' },
    { do_item_id: 'dl-3a', qty_returned: 1, delivery_return_id: 'dr-cancelled' },
    { do_item_id: 'dl-3a', qty_returned: 1, delivery_return_id: 'dr-null' },
    { do_item_id: 'dl-3a', qty_returned: 8, delivery_return_id: 'dr-missing' },
    { do_item_id: 'dl-3b', qty_returned: null, delivery_return_id: 'dr-open' },
    { do_item_id: 'dl-5', qty_returned: 2, delivery_return_id: 'dr-open' },
  ],
};

const asked = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8-none'];

/** The rows as PostgREST returns them for NETTING_EMBED: to-one embeds as an object (or null), to-many as an array. */
function embedded(): EmbeddedDemandLine[] {
  const byId = (t: string) => new Map(tables[t]!.map((r) => [String(r.id), r]));
  const dos = byId('delivery_orders');
  const drs = byId('delivery_returns');
  return asked.map((id) => ({
    id,
    do_lines: tables.delivery_order_items!.filter((l) => l.so_item_id === id).map((l) => ({
      id: String(l.id),
      qty: l.qty as number | null,
      delivery_order: (dos.get(String(l.delivery_order_id)) as { status: string | null } | undefined) ?? null,
      returns: tables.delivery_return_items!.filter((r) => r.do_item_id === l.id).map((r) => ({
        qty_returned: r.qty_returned as number | null,
        delivery_return: (drs.get(String(r.delivery_return_id)) as { status: string | null } | undefined) ?? null,
      })),
    })),
  }));
}

describe('inventory netting', () => {
  it('the embedded read nets exactly as the four serial reads did', async () => {
    const db = makeFakePostgrest(tables, []);
    const old = await deliveredReturnedBySoItem(db, asked);
    const now = nettingFromEmbedded(embedded());
    expect(Object.fromEntries(now.deliveredBySoItem)).toEqual(Object.fromEntries(old.deliveredBySoItem));
    expect(Object.fromEntries(now.returnedBySoItem)).toEqual(Object.fromEntries(old.returnedBySoItem));
  });

  it('counts DOs past the pre-ship states (doCountsAsDelivered) and returns traced through them', () => {
    const { deliveredBySoItem, returnedBySoItem } = nettingFromEmbedded(embedded());
    // L2: DRAFT and CANCELLED are left out; LOADED counts under the current rule.
    expect(Object.fromEntries(deliveredBySoItem)).toEqual({ L1: 2, L2: 4, L3: 5, L6: 7, L7: 1 });
    expect(Object.fromEntries(returnedBySoItem)).toEqual({ L3: 3 });
  });

  it('an embed that comes back as a one-element array reads like an object', () => {
    const lines: EmbeddedDemandLine[] = [{ id: 'X', do_lines: [{ id: 'a', qty: 3, delivery_order: [{ status: 'DELIVERED' }], returns: [{ qty_returned: 1, delivery_return: [{ status: 'RECEIVED' }] }] }] }];
    const n = nettingFromEmbedded(lines);
    expect(n.deliveredBySoItem.get('X')).toBe(3);
    expect(n.returnedBySoItem.get('X')).toBe(1);
  });

  it('the fallback reads fail loudly instead of netting nothing', async () => {
    const failing = { from: () => ({ select: () => ({ in: () => ({ range: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) };
    await expect(deliveredReturnedBySoItem(failing, ['L1'])).rejects.toThrow('delivery order lines: boom');
  });
});
