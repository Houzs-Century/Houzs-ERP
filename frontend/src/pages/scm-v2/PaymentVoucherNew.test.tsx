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

const extractAsync = vi.fn(async () => ({ bills: [] }));
const uploadPvAsync = vi.fn(async (_v: { pvId: string; file: { name: string } }) => ({ ok: true, file: { id: 'f1' } }));
/* Set by the copy-as-new test; undefined everywhere else (no ?copyFrom → the
   detail hook is disabled and the page never sees it). */
let copySourceDetail: { paymentVoucher: Record<string, unknown>; lines: Array<Record<string, unknown>>; allocations: unknown[] } | undefined;
vi.mock('../../vendor/scm/lib/payment-voucher-queries', () => ({
  useCreatePaymentVoucher: () => ({ mutateAsync, isPending: false }),
  usePaymentVoucherDetail: (id: string | null) => ({ data: id ? copySourceDetail : undefined, isLoading: false }),
  useExtractBills: () => ({ mutateAsync: extractAsync, isPending: false }),
  useUploadPvFile: () => ({ mutateAsync: uploadPvAsync, isPending: false }),
  fileToBase64: async (f: File) => `b64:${f.name}`,
  useSupplierAdvances: () => ({ data: { advances: [
    { id: 1, supplier_id: 'sup-1', pv_id: 'pv-old', pv_number: 'PV-2608-777', amount_sen: 80000, applied_sen: 30000, remaining_sen: 50000, created_at: '2026-08-20' },
  ], totalRemainingSen: 50000 }, isLoading: false }),
}));
vi.mock('../../lib/idempotency', () => ({ useIdempotencyKey: () => 'idem-1' }));
/* The AP invoices (non-stock bills) the picker lists BESIDE the PIs. */
vi.mock('../../vendor/scm/lib/ap-invoice-queries', () => ({
  useApInvoices: () => ({ data: { rows: [
    { kind: 'API', id: 'api-1', invoiceNumber: '2990-API-2609-001', supplierId: 'sup-1', supplierCode: 'S001', supplierName: 'Foshan Chairs', supplierInvoiceRef: 'RENT-9', invoiceDate: '2026-09-03', dueDate: null, currency: 'MYR', totalSen: 42000, paidSen: 0, outstandingSen: 42000, status: 'POSTED' },
  ] }, isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/accounting-queries', () => ({
  isControlSpecial: (s: string | null | undefined) => s === 'SDC' || s === 'SCC' || s === 'SBS',
  useAccounts: () => ({ data: { accounts: [
    { account_code: '310-0010', account_name: 'Bank — Maybank', account_type: 'ASSET', is_active: true, acc_money: true },
    { account_code: '320-1000', account_name: 'Cash in hand', account_type: 'ASSET', is_active: true, acc_money: true },
    { account_code: '900-A002', account_name: 'Advertisement', account_type: 'EXPENSE', is_active: true, acc_money: false },
    { account_code: '400-0000', account_name: 'Account Payable', account_type: 'LIABILITY', is_active: true, acc_money: false },
    { account_code: '405-0000', account_name: 'Other Creditos', account_type: 'LIABILITY', is_active: true, acc_money: false },
  ] }, isLoading: false }),
  useAccountRoles: () => ({ data: { roles: { BANK_DEFAULT: '310-0010', AP: '400-0000', AP_OTHER: '405-0000' }, overridden: {} }, isLoading: false }),
  useSaveBankDefault: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../vendor/scm/lib/purchase-invoice-queries', () => ({
  usePurchaseInvoices: () => ({ data: { purchaseInvoices: [
    { id: 'pi-1', invoice_number: '2990-PI-2609-001', supplier_invoice_ref: 'INV-77', supplier_id: 'sup-1', status: 'POSTED', total_sen: 255000, paid_sen: 0, invoice_date: '2026-09-01' },
    { id: 'pi-2', invoice_number: '2990-PI-2609-002', supplier_invoice_ref: null, supplier_id: 'sup-1', status: 'POSTED', total_sen: 100000, paid_sen: 40000, invoice_date: '2026-08-15' },
    { id: 'pi-9', invoice_number: '2990-PI-2608-018', supplier_invoice_ref: null, supplier_id: 'sup-405', status: 'POSTED', total_sen: 1644000, paid_sen: 0, invoice_date: '2026-08-20' },
  ] }, isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({
  useSuppliers: () => ({ data: [
    { id: 'sup-1', code: 'S001', name: 'Foshan Chairs', currency: 'MYR' },
    { id: 'sup-405', code: '405-Z002', name: 'Zhejiang Ju Miao', currency: 'MYR' },
    /* No invoice anywhere — the prepay-only case. */
    { id: 'sup-2', code: 'S002', name: 'Empty Hands Sdn Bhd', currency: 'MYR' },
  ], isLoading: false }),
  useSupplierDetail: () => ({ data: { supplier: { id: 'sup-1', currency: 'MYR' } } }),
}));
vi.mock('../../vendor/scm/lib/currencies-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useActiveCurrencies: () => ({ data: [] }),
  rateFor: () => 1,
}));

import { PaymentVoucherNew } from './PaymentVoucherNew';
import { stashPvFiles, takePvFiles } from '../../vendor/scm/lib/pv-file-handoff';

const draw = (url: string) => render(
  <MemoryRouter initialEntries={[url]}><PaymentVoucherNew /></MemoryRouter>,
);

describe('the AP Payment (?type=ap)', () => {
  test('supplier required, no hand-written lines, tick pays in full, and the save debits AP', async () => {
    draw('/scm/payment-vouchers/new?type=ap');
    expect(screen.getByText('New AP Payment')).toBeTruthy();
    /* No expense-lines card — the GL line is composed, not typed. */
    expect(screen.queryByText('Lines')).toBeNull();

    /* The supplier picker is a type-to-search combobox now — open and pick. */
    fireEvent.focus(screen.getByLabelText(/Supplier \*/));
    fireEvent.mouseDown(screen.getByText('S001 · Foshan Chairs'));
    /* The list shows each invoice's DATE, oldest first — the order you settle
       a supplier in (owner: 我也要看invoice 的日期). */
    const numbers = screen.getAllByText(/2990-PI-26/).map((el) => el.textContent);
    expect(numbers).toEqual(['2990-PI-2609-002', '2990-PI-2609-001']);
    expect(screen.getByText('15/08/2026')).toBeTruthy();

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

  test('a 405-x supplier debits AP_OTHER — the split follows the code, not the screen', async () => {
    mutateAsync.mockClear();
    draw('/scm/payment-vouchers/new?type=ap');
    fireEvent.focus(screen.getByLabelText(/Supplier \*/));
    fireEvent.mouseDown(screen.getByText('405-Z002 · Zhejiang Ju Miao'));
    fireEvent.click(screen.getByLabelText('Pay 2990-PI-2608-018 in full'));
    const books = String(screen.getByText(/Books:/).textContent);
    expect(books).toContain('Dr 405-0000');
    expect(books).toContain('16,440.00');
    fireEvent.click(screen.getByText('Create AP Payment'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    const payload = mutateAsync.mock.calls[0]![0];
    expect(payload.supplierId).toBe('sup-405');
    expect(payload.lines).toEqual([
      expect.objectContaining({ debitAccountCode: '405-0000', amountSen: 1644000 }),
    ]);
  });

  test('unticking takes the invoice back out — nothing applied, save refused with a sentence', () => {
    mutateAsync.mockClear();
    draw('/scm/payment-vouchers/new?type=ap');
    fireEvent.focus(screen.getByLabelText(/Supplier \*/));
    fireEvent.mouseDown(screen.getByText('S001 · Foshan Chairs'));
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

describe('an AP invoice beside the purchase invoices (owner 2026-09-06)', () => {
  test('the supplier\'s open AP invoice lists with an AP tag, ticks like a PI, and the payload names apInvoiceId', async () => {
    mutateAsync.mockClear();
    draw('/scm/payment-vouchers/new?type=ap');
    fireEvent.focus(screen.getByLabelText(/Supplier \*/));
    fireEvent.mouseDown(screen.getByText('S001 · Foshan Chairs'));
    expect(screen.getByText('2990-API-2609-001')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Pay 2990-API-2609-001 in full'));
    expect(screen.getByText(/Applying MYR 420\.00/)).toBeTruthy();
    fireEvent.click(screen.getByText('Create AP Payment'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    const payload = mutateAsync.mock.calls[0]![0];
    expect(payload.allocations).toEqual([{ apInvoiceId: 'api-1', amountSen: 42000 }]);
    expect(payload.lines).toEqual([expect.objectContaining({ debitAccountCode: '400-0000', amountSen: 42000 })]);
  });
});

describe('paying ahead (预付) on the AP Payment', () => {
  test('a prepay figure joins the total, the payload, and the Books line; the old advance is pointed at', async () => {
    mutateAsync.mockClear();
    draw('/scm/payment-vouchers/new?type=ap');
    fireEvent.focus(screen.getByLabelText(/Supplier \*/));
    fireEvent.mouseDown(screen.getByText('S001 · Foshan Chairs'));

    /* The banner names the supplier's UNSPENT advance and its holding voucher. */
    expect(screen.getByText(/already holds MYR 500\.00 of unspent advance/)).toBeTruthy();
    expect(screen.getByText('PV-2608-777')).toBeTruthy();

    /* Tick one invoice + type a prepay — the composed AP line carries BOTH. */
    fireEvent.click(screen.getByLabelText('Pay 2990-PI-2609-002 in full'));
    const prepay = screen.getByLabelText('Prepay amount') as HTMLInputElement;
    fireEvent.focus(prepay);
    fireEvent.change(prepay, { target: { value: '1000.00' } });
    fireEvent.blur(prepay);
    expect(screen.getByText(/incl\. prepay MYR 1,000\.00/)).toBeTruthy();

    fireEvent.click(screen.getByText('Create AP Payment'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    const payload = mutateAsync.mock.calls[0]![0];
    expect(payload.lines).toEqual([
      expect.objectContaining({ debitAccountCode: '400-0000', amountSen: 60000 + 100000 }),
    ]);
    expect(payload.allocations).toEqual([{ piId: 'pi-2', amountSen: 60000 }]);
  });

  test('a supplier with NO outstanding invoice still gets the prepay box — the advance is the whole voucher (owner 2026-09-06)', async () => {
    mutateAsync.mockClear();
    draw('/scm/payment-vouchers/new?type=ap');
    fireEvent.focus(screen.getByLabelText(/Supplier \*/));
    fireEvent.mouseDown(screen.getByText('S002 · Empty Hands Sdn Bhd'));
    /* The empty-list sentence no longer swallows the box. */
    expect(screen.getByText(/no outstanding invoices — a prepay below/)).toBeTruthy();
    const prepay = screen.getByLabelText('Prepay amount') as HTMLInputElement;
    fireEvent.focus(prepay);
    fireEvent.change(prepay, { target: { value: '500.00' } });
    fireEvent.blur(prepay);
    const save = screen.getByText('Create AP Payment').closest('button') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    const payload = mutateAsync.mock.calls[0]![0];
    expect(payload.lines).toEqual([expect.objectContaining({ debitAccountCode: '400-0000', amountSen: 50000 })]);
    /* Nothing to knock off — the payload carries no allocation at all. */
    expect(payload.allocations ?? []).toEqual([]);
  });
});

describe('copy as new (?copyFrom=…)', () => {
  test('content rides over — payee, Paid From, lines — while date stays today and nothing is applied', async () => {
    copySourceDetail = {
      paymentVoucher: {
        id: 'pv-9', pv_number: 'PV-2608-009', payee_name: 'TNB', voucher_date: '2026-08-01',
        credit_account_code: '320-1000', notes: 'august bill', currency: 'MYR', exchange_rate: 1, purpose: 'OTHER',
      },
      lines: [
        { description: 'Electricity Aug', debit_account_code: '900-A002', amount_sen: 45000 },
        { description: 'Deposit topup', debit_account_code: '900-A002', amount_sen: 5000 },
      ],
      allocations: [],
    };
    try {
      draw('/scm/payment-vouchers/new?copyFrom=pv-9');
      await waitFor(() => expect(screen.getByDisplayValue('TNB')).toBeTruthy());
      expect(screen.getByText(/Copied from PV-2608-009/)).toBeTruthy();
      expect(screen.getByDisplayValue('Electricity Aug')).toBeTruthy();
      expect(screen.getByDisplayValue('Deposit topup')).toBeTruthy();
      /* Identity is NOT copied: the source's August date never appears. */
      expect(screen.queryByDisplayValue('2026-08-01')).toBeNull();
    } finally {
      copySourceDetail = undefined;
    }
  });
});

describe('the plain Payment Voucher (/new)', () => {
  test('expense lines only — no supplier, no PI section, and Paid From offers only money', () => {
    draw('/scm/payment-vouchers/new');
    expect(screen.getByText('New Payment Voucher')).toBeTruthy();
    expect(screen.getByText('Lines')).toBeTruthy();
    expect(screen.queryByLabelText(/Supplier/)).toBeNull();
    expect(screen.queryByText('Apply to PI')).toBeNull();

    /* The Paid From combobox: pre-filled with the default bank's label, and
       its open list offers money accounts only — expense and AP are gone. */
    const paidFrom = screen.getByLabelText(/Paid From/) as HTMLInputElement;
    expect(paidFrom.value).toBe('310-0010 · Bank — Maybank');
    fireEvent.focus(paidFrom);
    expect(screen.getByText('320-1000 · Cash in hand')).toBeTruthy();
    expect(screen.queryByText(/900-A002/)).toBeNull();
    expect(screen.queryByText(/400-0000/)).toBeNull();
  });

  test('a scanned bill with vendor memory pre-fills payee AND account — 记忆自动帮我填', () => {
    render(
      <MemoryRouter initialEntries={[{
        pathname: '/scm/payment-vouchers/new',
        state: { billPrefill: {
          extraction: {
            vendorName: 'TENAGA NASIONAL BERHAD', vendorRegNo: null, documentKind: 'bill' as const,
            invoiceNumber: 'INV-77', invoiceDate: '2026-09-01', dueDate: null,
            currency: 'MYR', totalSen: 15000, sstSen: null, lines: [],
          },
          memory: { payeeName: 'TNB', debitAccountCode: '900-A002', purpose: 'OTHER', timesSeen: 3 },
        } },
      }]}><PaymentVoucherNew /></MemoryRouter>,
    );
    /* The operator's own casing beats the print, and the account is what THEY
       saved last time — shown resolved, still editable. */
    expect((screen.getByLabelText(/Payee/) as HTMLInputElement).value).toBe('TNB');
    expect((screen.getByLabelText('Account (Debit) *') as HTMLInputElement).value).toBe('900-A002 · Advertisement');
  });

  test('a scanned bill\'s FILES ride the stash and attach right after the save (print pv include ocr 的文件一起)', async () => {
    mutateAsync.mockClear();
    uploadPvAsync.mockClear();
    stashPvFiles([
      { name: 'tnb-page-1.pdf', mime: 'application/pdf', dataBase64: 'b64:tnb-page-1.pdf' },
      { name: 'tnb-page-2.jpg', mime: 'image/jpeg', dataBase64: 'b64:tnb-page-2.jpg' },
    ]);
    render(
      <MemoryRouter initialEntries={[{
        pathname: '/scm/payment-vouchers/new',
        state: { billPrefill: {
          extraction: {
            vendorName: 'TENAGA NASIONAL BERHAD', vendorRegNo: null, documentKind: 'bill' as const,
            invoiceNumber: 'INV-77', invoiceDate: '2026-09-01', dueDate: null,
            currency: 'MYR', totalSen: 15000, sstSen: null, lines: [],
          },
          memory: { payeeName: 'TNB', debitAccountCode: '900-A002', purpose: 'OTHER', timesSeen: 3 },
        } },
      }]}><PaymentVoucherNew /></MemoryRouter>,
    );
    /* The page took the stash (cleared for the next voucher) and says so. */
    expect(takePvFiles()).toEqual([]);
    expect(screen.getByText(/2 scanned file\(s\) will be attached/)).toBeTruthy();
    expect(screen.getByText(/tnb-page-1\.pdf, tnb-page-2\.jpg/)).toBeTruthy();

    fireEvent.click(screen.getByText('Create Voucher'));
    await waitFor(() => expect(uploadPvAsync).toHaveBeenCalledTimes(2));
    /* AFTER the create, onto ITS id, in scan order — sort_no is print order. */
    expect(uploadPvAsync.mock.calls.map((c) => [c[0].pvId, c[0].file.name])).toEqual([
      ['pv-1', 'tnb-page-1.pdf'],
      ['pv-1', 'tnb-page-2.jpg'],
    ]);
    await waitFor(() => expect(screen.getByText(/2 scanned file\(s\) attached/)).toBeTruthy());
  });

  test('Insert adds a line and lands on its account; Enter on an amount moves down, adding a line at the end (owner 2026-09-06)', () => {
    draw('/scm/payment-vouchers/new');
    expect(screen.queryByLabelText('line 2 amount')).toBeNull();
    fireEvent.keyDown(screen.getByLabelText('line 1 amount'), { key: 'Insert' });
    const second = screen.getByLabelText('line 2 amount');
    const landed = document.activeElement as HTMLElement | null;
    expect(landed?.getAttribute('role')).toBe('combobox');
    expect(landed?.closest('[data-line]')?.contains(second)).toBe(true);

    fireEvent.keyDown(second, { key: 'Enter' });
    const third = screen.getByLabelText('line 3 amount');
    expect((document.activeElement as HTMLElement | null)?.closest('[data-line]')?.contains(third)).toBe(true);
  });

  test('the account search actually narrows — 打关键字眼 finds the account', () => {
    draw('/scm/payment-vouchers/new');
    const paidFrom = screen.getByLabelText(/Paid From/) as HTMLInputElement;
    fireEvent.focus(paidFrom);
    fireEvent.change(paidFrom, { target: { value: 'cash' } });
    expect(screen.getByText('320-1000 · Cash in hand')).toBeTruthy();
    expect(screen.queryByText(/Bank — Maybank/)).toBeNull();
    /* Picking writes the VALUE and restores the full label. */
    fireEvent.mouseDown(screen.getByText('320-1000 · Cash in hand'));
    expect(paidFrom.value).toBe('320-1000 · Cash in hand');
  });
});
