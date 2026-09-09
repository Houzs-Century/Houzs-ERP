/* PaymentVoucherDetail — Edit on a DRAFT AP Payment (owner 2026-09-08, on a
   rejected voucher whose bill was an AP invoice: 当我 reject ap payment 后, 他的
   edit 不是退回去 knock pi? 而是这样? → 做). The Edit used to show the plain
   voucher's line editor (a "Settle 1 invoice(s)" line demanding a debit
   account) and a picker of purchase invoices only, so the AP invoice the
   voucher paid was "no outstanding purchase invoices" and could not be
   re-knocked. Now the Edit IS the AP form PV New shows: no typed lines, both
   invoice kinds with the knock-off prefilled, a prepay box, the total
   following ticks + prepay, and the one AP-control line written on save. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

/* Hoisted with the mocks that read them (vi.mock factories run before the
   file's own consts exist). */
const { updateAsync, idle, DETAIL } = vi.hoisted(() => {
  const updateAsync = vi.fn(async (_b: Record<string, unknown>) => ({ ok: true }));
  const idle = () => ({ mutateAsync: vi.fn(async () => ({ ok: true })), isPending: false });
  /* The rejected voucher as prod holds it: its formal number kept, every mark
     cleared, ONE stored line on the Other Creditor control, one AP-invoice
     allocation. */
  const DETAIL = {
    paymentVoucher: {
      id: 'pv-9', pv_number: '2990-HPV-2609-009', status: 'DRAFT', purpose: 'SUPPLIER_PAYMENT',
      supplier_id: 'sup-meta', payee_name: 'META PLATFORM IRELAND LIMITED', credit_account_code: '310-0020',
      voucher_date: '2026-09-08', total_sen: 1007742, currency: 'MYR', exchange_rate: 1, notes: null,
      submitted_at: null, checked_at: null, approved_at: null, company_id: 2,
    },
    lines: [{ id: 'l1', line_no: 1, description: 'Settle 1 invoice(s) — META PLATFORM IRELAND LIMITED', debit_account_code: '405-0000', amount_sen: 1007742 }],
    allocations: [{ id: 'a1', kind: 'API', apInvoiceId: 'api-meta', invoiceNumber: '2990-API-2609-004', supplierInvoiceRef: 'META-SEP', invoiceDate: '2026-09-01', amountSen: 1007742, status: 'POSTED' }],
  };
  return { updateAsync, idle, DETAIL };
});
vi.mock('../../vendor/scm/lib/payment-voucher-queries', async (importOriginal) => ({
  /* The real constants stay (PV_FILE_ACCEPT for the files card); only the hooks are stubbed. */
  ...(await importOriginal<typeof import('../../vendor/scm/lib/payment-voucher-queries')>()),
  usePaymentVoucherDetail: () => ({ data: DETAIL, isLoading: false }),
  useUpdatePaymentVoucher: () => ({ mutateAsync: updateAsync, isPending: false }),
  useCancelPaymentVoucher: idle, useSubmitPaymentVoucher: idle, useWithdrawPaymentVoucher: idle,
  useCheckPaymentVoucher: idle, useApprovePaymentVoucher: idle, useRejectPaymentVoucher: idle,
  useApplyAdvance: idle, useUploadPvFile: idle, useDeletePvFile: idle,
  useSupplierAdvances: () => ({ data: { advances: [], totalRemainingSen: 0 }, isLoading: false }),
  usePvFiles: () => ({ data: { files: [] }, isLoading: false, refetch: async () => ({ data: { files: [] } }) }),
  fetchPvFileBlobUrl: async () => ({ url: '', contentType: '' }),
  usePvReservations: () => ({ data: { byPi: {}, byApInvoice: {}, holders: {} }, isLoading: false }),
  NO_RESERVATIONS: { byPi: {}, byApInvoice: {}, holders: {} },
}));
/* The AP invoices (non-stock bills): META's, and another supplier's that must
   stay off this voucher's picker. */
vi.mock('../../vendor/scm/lib/ap-invoice-queries', () => ({
  useApInvoices: () => ({ data: { rows: [
    { kind: 'API', id: 'api-meta', invoiceNumber: '2990-API-2609-004', supplierId: 'sup-meta', supplierCode: '405-M001', supplierName: 'META PLATFORM IRELAND LIMITED', supplierInvoiceRef: 'META-SEP', invoiceDate: '2026-09-01', dueDate: null, currency: 'MYR', totalSen: 1007742, paidSen: 0, outstandingSen: 1007742, status: 'POSTED' },
    { kind: 'API', id: 'api-other', invoiceNumber: '2990-API-2609-777', supplierId: 'sup-x', supplierCode: '405-X001', supplierName: 'SOMEONE ELSE', supplierInvoiceRef: null, invoiceDate: '2026-09-02', dueDate: null, currency: 'MYR', totalSen: 5000, paidSen: 0, outstandingSen: 5000, status: 'POSTED' },
  ] }, isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/purchase-invoice-queries', () => ({
  usePurchaseInvoices: () => ({ data: { purchaseInvoices: [] }, isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({
  useSuppliers: () => ({ data: [{ id: 'sup-meta', code: '405-M001', name: 'META PLATFORM IRELAND LIMITED', currency: 'MYR' }], isLoading: false }),
  useSupplierDetail: () => ({ data: { supplier: { id: 'sup-meta', currency: 'MYR' } } }),
}));
vi.mock('../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/accounting-queries')>()),
  useAccounts: () => ({ data: { accounts: [
    { account_code: '310-0020', account_name: 'CASH AT BANK - HLBB', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true },
    { account_code: '400-0000', account_name: 'ACCOUNT PAYABLE', account_type: 'LIABILITY', parent_code: null, is_active: true, acc_money: false },
    { account_code: '405-0000', account_name: 'OTHER CREDITOS', account_type: 'LIABILITY', parent_code: null, is_active: true, acc_money: false },
    { account_code: '900-A002', account_name: 'Advertisement', account_type: 'EXPENSE', parent_code: null, is_active: true, acc_money: false },
  ] }, isLoading: false }),
  useAccountRoles: () => ({ data: { roles: { AP: '400-0000', AP_OTHER: '405-0000', AR: '300-0000', BANK_DEFAULT: '310-0020' }, overridden: {} }, isLoading: false }),
}));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => vi.fn() }));
vi.mock('./EntityHistoryPanel', () => ({ EntityHistoryPanel: () => null }));
vi.mock('../../components/scm-v2/PrintPreviewModal', () => ({
  PrintPreviewModal: () => null,
  usePrintPreview: () => ({ open: false, close: () => {}, openPreview: () => {} }),
  useOpenPrintPreviewFromUrl: () => {},
}));

import { PaymentVoucherDetail } from './PaymentVoucherDetail';

const draw = () => render(
  <MemoryRouter initialEntries={['/scm/payment-vouchers/pv-9?edit=1']}>
    <Routes><Route path="/scm/payment-vouchers/:id" element={<PaymentVoucherDetail />} /></Routes>
  </MemoryRouter>,
);

describe('Edit on a DRAFT AP Payment is the AP form, not the plain voucher\'s', () => {
  test('no line editor; the supplier\'s AP invoice is on the picker with its knock-off prefilled; a prepay adds to the total; Save writes the one AP-control line and the allocation', async () => {
    updateAsync.mockClear();
    draw();
    await waitFor(() => expect(screen.getByText(/One line, written by the system on save/)).toBeTruthy());
    /* The plain voucher's editor is gone — no debit account to pick, no line to add. */
    expect(screen.queryByText('Add another line')).toBeNull();
    expect(screen.queryByText('Account (Debit) *')).toBeNull();
    expect(screen.getByText('Lines (1)')).toBeTruthy();

    /* The AP invoice (not a purchase invoice) is listed, marked, prefilled at
       what the voucher already applies; another supplier's stays off. */
    expect(screen.getByText('2990-API-2609-004')).toBeTruthy();
    expect(screen.queryByText('2990-API-2609-777')).toBeNull();
    expect(screen.queryByText(/no outstanding purchase invoices/)).toBeNull();
    expect((screen.getByLabelText('Pay 2990-API-2609-004 in full') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Apply to 2990-API-2609-004') as HTMLInputElement).value).toBe('10,077.42');
    expect(screen.getByText('Applying MYR 10,077.42 = MYR 10,077.42')).toBeTruthy();

    /* A prepay rides the same voucher; the total follows ticks + prepay. */
    const prepay = screen.getByLabelText('Prepay amount') as HTMLInputElement;
    fireEvent.focus(prepay);
    fireEvent.change(prepay, { target: { value: '100' } });
    fireEvent.blur(prepay);
    expect(screen.getByText('Applying MYR 10,077.42 + prepay MYR 100.00 = MYR 10,177.42')).toBeTruthy();
    expect(screen.getByText(/Books: Dr 405-0000 Account Payable MYR 10,177\.42 \(incl\. prepay MYR 100\.00\)/)).toBeTruthy();

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updateAsync).toHaveBeenCalledTimes(1));
    expect(updateAsync.mock.calls[0]![0]).toMatchObject({
      id: 'pv-9', purpose: 'SUPPLIER_PAYMENT', supplierId: 'sup-meta', creditAccountCode: '310-0020',
      lines: [{ debitAccountCode: '405-0000', amountSen: 1017742, description: 'Settle 1 invoice(s) + prepay 100.00 — META PLATFORM IRELAND LIMITED' }],
      allocations: [{ apInvoiceId: 'api-meta', amountSen: 1007742 }],
    });
  });

  test('unticking the invoice leaves only the prepay — nothing is knocked off, the line is the prepay alone', async () => {
    updateAsync.mockClear();
    draw();
    await waitFor(() => expect(screen.getByLabelText('Pay 2990-API-2609-004 in full')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Pay 2990-API-2609-004 in full'));
    expect(screen.getByText('Applying MYR 0.00 = MYR 0.00')).toBeTruthy();
    const prepay = screen.getByLabelText('Prepay amount') as HTMLInputElement;
    fireEvent.focus(prepay);
    fireEvent.change(prepay, { target: { value: '2500' } });
    fireEvent.blur(prepay);
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updateAsync).toHaveBeenCalledTimes(1));
    expect(updateAsync.mock.calls[0]![0]).toMatchObject({
      lines: [{ debitAccountCode: '405-0000', amountSen: 250000, description: 'prepay 2500.00 — META PLATFORM IRELAND LIMITED' }],
      allocations: [],
    });
  });
});
