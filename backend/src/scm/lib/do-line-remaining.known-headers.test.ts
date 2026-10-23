import { describe, expect, it } from 'vitest';
import { doLineRemaining, type DoRemainingHeader } from './do-line-remaining';
import { fakeSb, type Row } from './fake-postgrest';

/* HC-0002: the DO list hands doLineRemaining the headers it has just read, so the
   ledger skips its own read of delivery_orders. Same ledger either way. */

const headers: DoRemainingHeader[] = [
  { id: 'do-a', do_number: 'HC-DO-1', status: 'DELIVERED', debtor_code: '300-A', debtor_name: 'ALICE' },
  { id: 'do-b', do_number: 'HC-DO-2', status: 'LOADED', debtor_code: null, debtor_name: 'BOB' },
  { id: 'do-c', do_number: 'HC-DO-3', status: 'CANCELLED', debtor_code: null, debtor_name: 'CAROL' },
  { id: 'do-d', do_number: 'HC-DO-4', status: 'DRAFT', debtor_code: null, debtor_name: 'DAN' },
];

function tables(): Record<string, Row[]> {
  return {
    delivery_orders: headers.map((h) => ({ ...h })),
    delivery_order_items: [
      { id: 'a1', delivery_order_id: 'do-a', item_code: 'X', qty: 3, line_no: 1, created_at: '2026-10-01T00:00:00Z' },
      { id: 'a2', delivery_order_id: 'do-a', item_code: 'Y', qty: 2, line_no: 2, created_at: '2026-10-01T00:00:00Z' },
      { id: 'b1', delivery_order_id: 'do-b', item_code: 'X', qty: 1, line_no: 1, created_at: '2026-10-01T00:00:00Z' },
      { id: 'c1', delivery_order_id: 'do-c', item_code: 'X', qty: 5, line_no: 1, created_at: '2026-10-01T00:00:00Z' },
      { id: 'd1', delivery_order_id: 'do-d', item_code: 'X', qty: 4, line_no: 1, created_at: '2026-10-01T00:00:00Z' },
    ],
    sales_invoice_items: [{ do_item_id: 'a1', qty: 1, sales_invoice_id: 'si-1' }],
    sales_invoices: [{ id: 'si-1', status: 'POSTED' }],
    delivery_return_items: [{ do_item_id: 'a2', qty_returned: 1, delivery_return_id: 'dr-1' }],
    delivery_returns: [{ id: 'dr-1', status: 'RECEIVED' }],
  };
}

const ids = ['do-a', 'do-b', 'do-c', 'do-d'];

describe('doLineRemaining with headers already read', () => {
  it('builds the same ledger without reading delivery_orders', async () => {
    const read = await doLineRemaining(fakeSb(tables()), ids, 'invoiceable');
    const sb = fakeSb(tables());
    const seen: string[] = [];
    const spied = { from: (t: string) => { seen.push(t); return sb.from(t); } };
    const known = await doLineRemaining(spied, ids, 'invoiceable', headers);
    expect(read.ok && known.ok).toBe(true);
    if (!read.ok || !known.ok) return;
    expect([...known.lines.entries()]).toEqual([...read.lines.entries()]);
    expect([...known.lines.keys()].sort()).toEqual(['a1', 'a2', 'b1']);
    expect(seen).not.toContain('delivery_orders');
  });

  it('ignores headers for DOs it was not asked about', async () => {
    const known = await doLineRemaining(fakeSb(tables()), ['do-b'], 'invoiceable', headers);
    expect(known.ok && [...known.lines.keys()]).toEqual(['b1']);
  });
});
