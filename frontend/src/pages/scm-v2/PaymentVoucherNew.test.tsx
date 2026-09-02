/* The two-document split (owner 2026-08-30, AutoCount in hand: 正常 auto count
   是可以选payment voucher / AP Payment). What is pinned:
     • ?type=ap — supplier required, NO hand-written lines, tick a PI to pay it
       in full, and the save composes ONE GL line debiting the AP control;
     • plain /new — expense lines, no supplier, no PI section;
     • Paid From offers ONLY money accounts, pre-filled from BANK_DEFAULT.
   The server-side halves (money-account refusal, the roles window) are
   backend/src/scm/routes/accountRoles.test.ts. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

const mutateAsync = vi.fn(async (_body: Record<string, unknown>) => ({ id: 'pv-1', pvNumber: 'PV-2609-001' }));

vi.mock('../../vendor/scm/lib/payment-voucher-queries', () => ({
  useCreatePaymentVoucher: () => ({ mutateAsync, isPending: false }),
}));
vi.mock('../../lib/idempotency', () => ({ useIdempotencyKey: () => 'idem-1' }));
vi.mock('../../vendor/scm/lib/accounting-queries', () => ({
  useAccounts: () => ({ data: { accounts: [
    { account_code: '330-0000', account_name: 'Bank — Maybank', account_type: 'ASSET', is_active: true, acc_money: true },
    { account_code: '320-1000', account_name: 'Cash in hand', account_type: 'ASSET', is_active: true, acc_money: true },
    { account_code: '900-A002', account_name: 'Advertisement', account_type: 'EXPENSE', is_active: true, acc_money: false },
    { account_code: '400-0000', account_name: 'Account Payable', account_type: 'LIABILITY', is_active: true, acc_money: false },
  ] }, isLoading: false }),
  useAccountRoles: () => ({ data: { roles: { BANK_DEFAULT: '330-0000', AP: '400-0000' }, overridden: {} }, isLoading: false }),
  useSaveBankDefault: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../vendor/scm/lib/purchase-invoice-queries', () => ({
  usePurchaseInvoices: () => ({ data: { purchaseInvoices: [
    { id: 'pi-1', invoice_number: '2990-PI-2609-001', supplier_invoice_ref: 'INV-77', supplier_id: 'sup-1', status: 'POSTED', total_sen: 255000, paid_sen: 0 },
    { id: 'pi-2', invoice_number: '2990-PI-2609-002', supplier_invoice_ref: null, supplier_id: 'sup-1', status: 'POSTED', total_sen: 100000, paid_sen: 40000 },
  ] }, isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({
  useSuppliers: () => ({ data: [{ id: 'sup-1', code: 'S001', name: 'Foshan Chairs', currency: 'MYR' }], isLoading: false }),
  useSupplierDetail: () => ({ data: { supplier: { id: 'sup-1', currency: 'MYR' } } }),
}));
vi.mock('../../vendor/scm/lib/currencies-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useActiveCurrencies: () => ({ data: [] }),
  rateFor: () => 1,
}));

import { PaymentVoucherNew } from './PaymentVoucherNew';

const draw = (url: string) => render(
  <MemoryRouter initialEntries={[url]}><PaymentVoucherNew /></MemoryRouter>,
);

describe('the AP Payment (?type=ap)', () => {
  test('supplier required, no hand-written lines, tick pays in full, and the save debits AP', async () => {
    draw('/scm/payment-vouchers/new?type=ap');
    expect(screen.getByText('New AP Payment')).toBeTruthy();
    /* No expense-lines card — the GL line is composed, not typed. */
    expect(screen.queryByText('Lines')).toBeNull();

    fireEvent.change(screen.getByLabelText(/Supplier \*/), { target: { value: 'sup-1' } });
    /* Tick the first invoice — the amount becomes its full outstanding, and
       the footer spells out the entry it will book. */
    fireEvent.click(screen.getByLabelText('Pay 2990-PI-2609-001 in full'));
    expect(screen.getByText(/Applying MYR 2,550\.00/)).toBeTruthy();
    expect(screen.getByText(/Books: Dr 400-0000 Account Payable MYR 2,550\.00/)).toBeTruthy();

    fireEvent.click(screen.getByText('Create AP Payment'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    const payload = mutateAsync.mock.calls[0]![0];
    expect(payload.purpose).toBe('SUPPLIER_PAYMENT');
    expect(payload.supplierId).toBe('sup-1');
    expect(payload.lines).toEqual([
      expect.objectContaining({ debitAccountCode: '400-0000', amountSen: 255000 }),
    ]);
    expect(payload.allocations).toEqual([{ piId: 'pi-1', amountSen: 255000 }]);
  });

  test('unticking takes the invoice back out — nothing applied, save refused with a sentence', () => {
    mutateAsync.mockClear();
    draw('/scm/payment-vouchers/new?type=ap');
    fireEvent.change(screen.getByLabelText(/Supplier \*/), { target: { value: 'sup-1' } });
    const tick = screen.getByLabelText('Pay 2990-PI-2609-002 in full');
    fireEvent.click(tick);
    /* Partial outstanding: 1,000.00 − 400.00 already paid = 600.00 */
    expect(screen.getByText(/Applying MYR 600\.00/)).toBeTruthy();
    fireEvent.click(tick);
    expect(screen.getByText(/Applying MYR 0\.00/)).toBeTruthy();
    /* Nothing applied -> the save is not even offered. */
    expect((screen.getByText('Create AP Payment').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});

describe('the plain Payment Voucher (/new)', () => {
  test('expense lines only — no supplier, no PI section, and Paid From offers only money', () => {
    draw('/scm/payment-vouchers/new');
    expect(screen.getByText('New Payment Voucher')).toBeTruthy();
    expect(screen.getByText('Lines')).toBeTruthy();
    expect(screen.queryByLabelText(/Supplier/)).toBeNull();
    expect(screen.queryByText('Apply to PI')).toBeNull();

    /* The Paid From select: money accounts in, expense and AP out, and the
       company's default bank already chosen. */
    const paidFrom = screen.getByLabelText(/Paid From/) as HTMLSelectElement;
    const codes = [...paidFrom.querySelectorAll('option')].map((o) => o.value).filter(Boolean);
    expect(codes).toContain('330-0000');
    expect(codes).toContain('320-1000');
    expect(codes).not.toContain('900-A002');
    expect(codes).not.toContain('400-0000');
    expect(paidFrom.value).toBe('330-0000');
  });
});
