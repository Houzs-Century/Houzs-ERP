/* The advance on a voucher, knocked off the way every other knock-off is (owner
   2026-11-06: 「和平常 knock off 一样，可以 tick」): tick = in full, as far as the
   advance reaches; untick = back; a typed figure = part of it. The server half is
   backend's apply-advance route, which posts nothing. */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { AdvanceKnockOff } from './AdvanceKnockOff';

const h = vi.hoisted(() => ({
  remainingSen: 1_021_100 as number | null,
  mutate: vi.fn(),
  piRows: [] as unknown[],
  apRows: [] as unknown[],
}));

vi.mock('../../vendor/scm/lib/payment-voucher-queries', () => ({
  useSupplierAdvances: () => ({
    data: { advances: h.remainingSen == null ? [] : [{ pv_id: 'pv-1', pv_number: 'HC-HPV-2610-001', remaining_sen: h.remainingSen }] },
  }),
  useApplyAdvance: () => ({ mutate: h.mutate, isPending: false }),
}));
vi.mock('../../vendor/scm/lib/purchase-invoice-queries', () => ({
  usePurchaseInvoices: () => ({ data: { purchaseInvoices: h.piRows }, isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/ap-invoice-queries', () => ({
  useApInvoices: () => ({ data: { rows: h.apRows }, isLoading: false }),
}));

const pi = (id: string, number: string, date: string, total: number, paid: number, extra: Record<string, unknown> = {}) => ({
  id, invoice_number: number, supplier_id: 'sup-1', status: 'POSTED', total_sen: total, paid_sen: paid, invoice_date: date, supplier_invoice_ref: `REF-${id}`, ...extra,
});
const api = (id: string, number: string, date: string, total: number, out: number, extra: Record<string, unknown> = {}) => ({
  id, invoiceNumber: number, supplierId: 'sup-1', supplierInvoiceRef: null, status: 'POSTED', totalSen: total, outstandingSen: out, invoiceDate: date, ...extra,
});

const show = () => render(<AdvanceKnockOff pvId="pv-1" supplierId="sup-1" />);
const box = (no: string) => screen.getByLabelText(`Knock off ${no}`) as HTMLInputElement;
const amount = (no: string) => screen.getByLabelText(`Amount off ${no}`) as HTMLInputElement;
const type = (no: string, value: string) => {
  fireEvent.change(amount(no), { target: { value } });
  fireEvent.blur(amount(no));
};

beforeEach(() => {
  h.remainingSen = 1_021_100;
  h.mutate.mockReset();
  h.piRows = [
    pi('pi-1', 'HC-PI-2609-021', '2026-09-05', 68_000, 0),
    pi('pi-2', 'HC-PI-2610-131', '2026-10-03', 447_500, 0),
    /* None of these can take the advance: another supplier's, a draft, one paid in full. */
    pi('pi-x', 'HC-PI-OTHER', '2026-09-01', 10_000, 0, { supplier_id: 'sup-2' }),
    pi('pi-d', 'HC-PI-DRAFT', '2026-09-01', 10_000, 0, { status: 'DRAFT' }),
    pi('pi-p', 'HC-PI-PAID', '2026-09-01', 10_000, 10_000),
  ];
  h.apRows = [
    api('api-1', 'HC-API-2608-009', '2026-08-03', 477_000, 477_000),
    api('api-x', 'HC-API-OTHER', '2026-08-03', 10_000, 10_000, { supplierId: 'sup-2' }),
  ];
});

describe('Advance on this voucher', () => {
  test('lists the supplier\'s open invoices of both kinds, oldest first, each with a tick', () => {
    show();
    const table = screen.getByLabelText("Knock off the supplier's invoices");
    expect(within(table).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual([
      'Knock off HC-API-2608-009', 'Knock off HC-PI-2609-021', 'Knock off HC-PI-2610-131',
    ]);
    /* The same columns as an AP Payment's bills. */
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['', 'Invoice', 'Date', 'Supplier Ref', 'Amount', 'Outstanding', 'Knock off']);
    expect(within(table).getByText('REF-pi-1')).toBeTruthy();
    expect(screen.queryByText('HC-PI-OTHER')).toBeNull();
    expect(screen.queryByText('HC-PI-DRAFT')).toBeNull();
    expect(screen.queryByText('HC-PI-PAID')).toBeNull();
    expect(screen.queryByText('HC-API-OTHER')).toBeNull();
  });

  test('a tick knocks the invoice off in full, an untick gives it back', () => {
    show();
    fireEvent.click(box('HC-PI-2609-021'));
    expect(box('HC-PI-2609-021').checked).toBe(true);
    expect(amount('HC-PI-2609-021').value).toBe('680.00');
    expect(screen.getByText(/RM 10,211\.00 unspent · applying RM 680\.00/)).toBeTruthy();
    fireEvent.click(box('HC-PI-2609-021'));
    expect(box('HC-PI-2609-021').checked).toBe(false);
    expect(amount('HC-PI-2609-021').value).toBe('0.00');
    expect(screen.getByText(/RM 10,211\.00 unspent$/)).toBeTruthy();
  });

  test('a tick takes only what the advance still has, and then nothing more can be ticked', () => {
    h.remainingSen = 500_000;
    show();
    fireEvent.click(box('HC-API-2608-009'));
    expect(amount('HC-API-2608-009').value).toBe('4,770.00');
    fireEvent.click(box('HC-PI-2610-131'));
    expect(amount('HC-PI-2610-131').value).toBe('230.00');
    expect(box('HC-PI-2609-021').disabled).toBe(true);
  });

  test('a typed figure is part of it, pulled back to what the row can take', () => {
    show();
    type('HC-PI-2610-131', '100');
    expect(box('HC-PI-2610-131').checked).toBe(true);
    expect(amount('HC-PI-2610-131').value).toBe('100.00');
    type('HC-PI-2609-021', '9000');
    expect(amount('HC-PI-2609-021').value).toBe('680.00');
  });

  test('Apply advance names each invoice by its kind and clears the ticks', () => {
    show();
    const apply = screen.getByRole('button', { name: 'Apply advance' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(box('HC-PI-2609-021'));
    fireEvent.click(box('HC-API-2608-009'));
    fireEvent.click(apply);
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.mutate.mock.calls[0]![0]).toEqual({
      pvId: 'pv-1',
      allocations: [{ apInvoiceId: 'api-1', amountSen: 477_000 }, { piId: 'pi-1', amountSen: 68_000 }],
    });
    act(() => { h.mutate.mock.calls[0]![1].onSuccess({ appliedSen: 545_000, remainingSen: 476_100 }); });
    expect(box('HC-PI-2609-021').checked).toBe(false);
    expect(screen.getByText('Knocked off RM 5,450.00 — RM 4,761.00 of the advance remains.')).toBeTruthy();
  });

  test('what the server refuses is said on the card', () => {
    show();
    fireEvent.click(box('HC-PI-2609-021'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply advance' }));
    act(() => { h.mutate.mock.calls[0]![1].onError(new Error('That applies more than remains.')); });
    expect(screen.getByText('That applies more than remains.')).toBeTruthy();
    expect(box('HC-PI-2609-021').checked).toBe(true);
  });

  test('no invoice open: the advance waits; no advance on this voucher: no card', () => {
    h.piRows = [];
    h.apRows = [];
    const { unmount } = show();
    expect(screen.getByText('No outstanding invoice from this supplier yet — the advance waits.')).toBeTruthy();
    unmount();
    h.remainingSen = null;
    const { container } = show();
    expect(container.textContent).toBe('');
  });
});
