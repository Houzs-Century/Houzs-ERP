import { describe, expect, it } from 'vitest';
import { computeDoLifecycle } from '../routes/delivery-orders-mfg';
import { buildDoListRows } from './do-list-rows';
import { fakeSb, type Row } from './fake-postgrest';

/* HC-0002: the list builder derives the lifecycle badge from the SI / DR rows it
   already reads for has_children, instead of calling computeDoLifecycle (which
   read both tables again). Both run over the same rows and must agree. */

function tables(): Record<string, Row[]> {
  return {
    sales_invoices: [
      { id: 'si-1', delivery_order_id: 'do-inv', invoice_number: 'SI-1', invoice_date: '2026-10-02', created_at: '2026-10-02T03:00:00Z', status: 'POSTED' },
      { id: 'si-2', delivery_order_id: 'do-ret', invoice_number: 'SI-2', invoice_date: '2026-10-01', created_at: '2026-10-01T03:00:00Z', status: 'POSTED' },
      { id: 'si-3', delivery_order_id: 'do-cx', invoice_number: 'SI-3', invoice_date: '2026-10-05', created_at: '2026-10-05T03:00:00Z', status: 'CANCELLED' },
      { id: 'si-4', delivery_order_id: 'do-tie', invoice_number: 'SI-4', invoice_date: '2026-10-03', created_at: '2026-10-03T01:00:00Z', status: 'POSTED' },
      { id: 'si-5', delivery_order_id: 'do-mixed', invoice_number: null, invoice_date: null, created_at: '2026-10-04T08:00:00Z', status: 'DRAFT' },
    ],
    delivery_returns: [
      { id: 'dr-1', delivery_order_id: 'do-ret', return_number: 'DR-1', return_date: '2026-10-03', created_at: '2026-10-03T03:00:00Z', status: 'RECEIVED' },
      { id: 'dr-2', delivery_order_id: 'do-inv', return_number: 'DR-2', return_date: '2026-10-01', created_at: '2026-10-01T02:00:00Z', status: 'CANCELLED' },
      { id: 'dr-3', delivery_order_id: 'do-tie', return_number: 'DR-3', return_date: '2026-10-03', created_at: '2026-10-03T01:00:00Z', status: 'RECEIVED' },
      { id: 'dr-4', delivery_order_id: 'do-mixed', return_number: 'DR-4', return_date: '2026-10-04T00:00:00+08:00', created_at: '2026-10-04T07:00:00Z', status: 'RECEIVED' },
      { id: 'dr-5', delivery_order_id: 'do-cx', return_number: 'DR-5', return_date: '2026-10-05', created_at: '2026-10-05T03:00:00Z', status: 'CANCELLED' },
    ],
    mfg_sales_orders: [],
    delivery_order_items: [],
  };
}

const ids = ['do-none', 'do-inv', 'do-ret', 'do-cx', 'do-tie', 'do-mixed'];
type Args = Parameters<typeof buildDoListRows>;
const ctx = { get: () => undefined } as unknown as Args[1];
const sbOf = (t: Record<string, Row[]>) => fakeSb(t) as unknown as Args[0];

describe('buildDoListRows lifecycle', () => {
  it('derives the same badge computeDoLifecycle reads', async () => {
    const old = await computeDoLifecycle(fakeSb(tables()), ids);
    const rows = await buildDoListRows(sbOf(tables()), ctx, ids.map((id) => ({ id })), { financeKeys: [] });
    expect(Object.fromEntries(rows.map((r) => [r.id, r.lifecycle_state]))).toEqual(Object.fromEntries(old));
    expect(Object.fromEntries(old)).toEqual({
      'do-none': 'shipped', 'do-inv': 'invoiced', 'do-ret': 'returned', 'do-cx': 'shipped', 'do-tie': 'returned', 'do-mixed': 'invoiced',
    });
  });

  it('keeps has_children and the transfer-to numbers from the same reads', async () => {
    const rows = await buildDoListRows(sbOf(tables()), ctx, ids.map((id) => ({ id })), { financeKeys: [] });
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by['do-inv']).toMatchObject({ has_children: true, invoiced_si_nos: ['SI-1'], return_nos: [] });
    expect(by['do-ret']).toMatchObject({ has_children: true, invoiced_si_nos: ['SI-2'], return_nos: ['DR-1'] });
    expect(by['do-cx']).toMatchObject({ has_children: false, invoiced_si_nos: [], return_nos: [] });
  });
});
