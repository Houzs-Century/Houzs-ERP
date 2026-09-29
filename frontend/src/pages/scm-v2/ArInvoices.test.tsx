/* AR Invoices — the Finance list shows BOTH kinds (owner 2026-09-29: 可以把
   sales invoice 和 other debtor bill 做一个类似 ap invoice 这样让我 finance 这边
   看两个一起吗): sales invoices as a read-only mirror linking to their own
   page, other-debtor bills raised HERE (我希望 other debtor 那边只是 maintain
   other debtor 就好, 开 other debtor 的 bill 就直接在 ar invoice 页面) — the
   debtor picked first, then the bill form; a bill opens in a pop-out over the
   list with Print / Edit / Copy / Cancel; the party filter narrows and Print
   listing prints what is shown; `?debtor=` opens on one debtor. The server
   half is backend/tests/arInvoices.test.ts (+ otherDebtors.test.ts for the
   bill's writes). */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

const createBillAsync = vi.fn(async (_b: unknown) => ({ ok: true, bill: { billNumber: 'HC-ODB-2609-002', totalSen: 45000 } }));
const updateBillAsync = vi.fn(async (_b: unknown) => ({ ok: true, bill: { id: 'b1', billNumber: 'HC-ODB-2609-001', totalSen: 65000 }, reposted: true, jeNo: 'HC-JE-2609-031' }));
const cancelBillAsync = vi.fn(async (_b: unknown) => ({ ok: true }));
const listingAsync = vi.fn(async (_rows: unknown, _filter: unknown) => undefined);
const pdfMock = vi.fn(async (_d: unknown, _o: unknown) => {});

const ROWS = [
  { kind: 'ODB', id: 'b1', invoiceNumber: 'HC-ODB-2609-001', partyKey: 'D:d1', partyCode: null, partyName: 'AHMAD BIN ALI', debtorId: 'd1', ref: null, description: '转租九月', invoiceDate: '2026-09-05', dueDate: null, currency: 'MYR', totalSen: 50000, paidSen: 20000, depositAppliedSen: 0, outstandingSen: 30000, status: 'POSTED' },
  { kind: 'SI', id: 'si-1', invoiceNumber: 'HC-SI-2609-001', partyKey: 'C:300-C001', partyCode: '300-C001', partyName: 'TAN AH KOW', debtorId: null, ref: 'HC-SO-2609-004', description: 'Bedroom set', invoiceDate: '2026-09-03', dueDate: '2026-09-30', currency: 'MYR', totalSen: 440000, paidSen: 60000, depositAppliedSen: 20000, outstandingSen: 380000, status: 'SENT' },
  { kind: 'ODB', id: 'b2', invoiceNumber: 'HC-ODB-2608-003', partyKey: 'D:d2', partyCode: null, partyName: 'OLD DEBTOR', debtorId: 'd2', ref: null, description: null, invoiceDate: '2026-08-20', dueDate: null, currency: 'MYR', totalSen: 10000, paidSen: 0, depositAppliedSen: 0, outstandingSen: 10000, status: 'POSTED' },
];
const DETAILS: Record<string, unknown> = {
  b1: {
    bill: { id: 'b1', bill_number: 'HC-ODB-2609-001', bill_date: '2026-09-05', total_sen: 50000, received_sen: 20000, status: 'POSTED', notes: '转租九月',
      lines: [{ id: 'l1', line_no: 1, description: '转租', credit_account_code: '700-0000', amount_sen: 50000 }] },
    debtor: { id: 'd1', name: 'AHMAD BIN ALI', phone: '012-345', notes: null, is_active: true, outstanding_sen: 30000, address1: '12 Jalan Satu' },
  },
  b2: {
    bill: { id: 'b2', bill_number: 'HC-ODB-2608-003', bill_date: '2026-08-20', total_sen: 10000, received_sen: 0, status: 'POSTED', notes: null,
      lines: [{ id: 'l2', line_no: 1, description: null, credit_account_code: '700-0000', amount_sen: 10000 }] },
    debtor: { id: 'd2', name: 'OLD DEBTOR', phone: null, notes: null, is_active: true, outstanding_sen: 10000 },
  },
};

vi.mock('../../vendor/scm/lib/ar-invoice-queries', () => ({
  useArInvoices: () => ({ data: { rows: ROWS }, isLoading: false, isError: false, error: null }),
  useArBillDetail: (id: string | null) => ({ data: id ? DETAILS[id] : undefined, isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/ar-invoice-listing-pdf', () => ({
  generateArListingPdf: (rows: unknown, filter: unknown) => listingAsync(rows, filter),
}));
vi.mock('../../vendor/scm/lib/debtor-bill-pdf', () => ({ generateDebtorBillPdf: (d: unknown, o: unknown) => pdfMock(d, o) }));
vi.mock('../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  /* The real pure helpers stay (postableAccounts — docs/bugs/0693); only the hooks are stubbed. */
  ...(await importOriginal<typeof import('../../vendor/scm/lib/accounting-queries')>()),
  isControlSpecial: (s: string | null | undefined) => s === 'SDC' || s === 'SCC' || s === 'SBS',
  useAccounts: () => ({ data: { accounts: [
    { account_code: '700-0000', account_name: 'Other Income', account_type: 'INCOME', parent_code: null, is_active: true, acc_money: false },
    { account_code: '305-0000', account_name: 'OTHER DEBTOR', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false, special_type: 'SDC' },
  ] }, isLoading: false }),
  useOtherDebtors: () => ({ data: { debtors: [
    { id: 'd1', name: 'AHMAD BIN ALI', phone: '012-345', notes: null, is_active: true, outstanding_sen: 30000 },
    { id: 'd2', name: 'OLD DEBTOR', phone: null, notes: null, is_active: true, outstanding_sen: 10000 },
    { id: 'd3', name: 'GONE DEBTOR', phone: null, notes: null, is_active: false, outstanding_sen: 0 },
  ] }, isLoading: false }),
  useCreateDebtorBill: () => ({ mutateAsync: createBillAsync, isPending: false }),
  useUpdateDebtorBill: () => ({ mutateAsync: updateBillAsync, isPending: false }),
  useCancelDebtorBill: () => ({ mutateAsync: cancelBillAsync, isPending: false }),
}));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const confirmFn = vi.fn(async (_a: unknown) => true);
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmFn }));
const notifyFn = vi.fn();
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => notifyFn }));

import { ArInvoices } from './ArInvoices';

const draw = (entry = '/scm/ar-invoices') => render(<MemoryRouter initialEntries={[entry]}><ArInvoices /></MemoryRouter>);
const dialog = () => screen.getByRole('dialog');
/* MoneyInput commits on blur and re-dresses at rest (1,800.00). */
const setAmount = (scope: HTMLElement, label: string, rm: string) => {
  const box = within(scope).getByLabelText(label);
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: rm } });
  fireEvent.blur(box);
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

describe('both kinds on one list', () => {
  test('a sales invoice mirrors with a link to its own page and the SI list\'s outstanding; a bill shows its debtor', () => {
    draw();
    expect(screen.getByText('Sales Invoice')).toBeTruthy();
    expect(screen.getAllByText('Debtor Bill')).toHaveLength(2);
    expect(screen.getByText('HC-SI-2609-001').closest('a')!.getAttribute('href')).toBe('/scm/sales-invoices/si-1');
    const siRow = screen.getByText('HC-SI-2609-001').closest('tr')!;
    expect(siRow.textContent).toContain('TAN AH KOW');
    expect(siRow.textContent).toContain('300-C001');
    expect(siRow.textContent).toContain('HC-SO-2609-004');
    expect(siRow.textContent).toContain('3,800.00');
    /* The order's deposit settles part of it — the cell says so, the SI list's own marker. */
    expect(within(siRow).getByText('dep')).toBeTruthy();
    const billRow = screen.getByText('HC-ODB-2609-001').closest('tr')!;
    expect(billRow.textContent).toContain('AHMAD BIN ALI');
    expect(billRow.textContent).toContain('转租九月');
    expect(billRow.textContent).toContain('300.00');
  });

  test('the party filter narrows the list, and Print listing prints exactly what is shown', () => {
    listingAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('Print listing'));
    expect((listingAsync.mock.calls[0]![0] as unknown[]).length).toBe(3);
    expect(listingAsync.mock.calls[0]![1]).toEqual({ kind: 'ALL', partyName: null });
    fireEvent.focus(screen.getByLabelText('Filter by customer or debtor'));
    fireEvent.mouseDown(screen.getByText('300-C001 · TAN AH KOW'));
    expect(screen.queryByText('HC-ODB-2609-001')).toBeNull();
    expect(screen.getByText('HC-SI-2609-001')).toBeTruthy();
    fireEvent.click(screen.getByText('Print listing'));
    expect((listingAsync.mock.calls[1]![0] as unknown[]).length).toBe(1);
    expect(listingAsync.mock.calls[1]![1]).toEqual({ kind: 'ALL', partyName: 'TAN AH KOW' });
  });

  test('?debtor= opens the page on that debtor alone — the registry and the Receipts page link here that way', () => {
    draw('/scm/ar-invoices?debtor=d2');
    expect(screen.getByText('HC-ODB-2608-003')).toBeTruthy();
    expect(screen.queryByText('HC-ODB-2609-001')).toBeNull();
    expect(screen.queryByText('HC-SI-2609-001')).toBeNull();
  });
});

describe('a debtor bill, popped out over the list', () => {
  test('opens with its lines, description and received; Print hands the bill, its debtor and the account names to the PDF; a bill with money on it offers Edit and Copy but no Cancel', () => {
    pdfMock.mockClear();
    draw();
    fireEvent.click(screen.getByText('HC-ODB-2609-001'));
    const d = dialog();
    expect(within(d).getByText('转租')).toBeTruthy();
    expect(within(d).getByText(/Other Income/)).toBeTruthy();
    expect(within(d).getByText('RM 200.00')).toBeTruthy();
    /* The list is still there behind it — nothing was pushed in above it. */
    expect(screen.getByText('HC-SI-2609-001')).toBeTruthy();
    fireEvent.click(within(d).getByText('Print'));
    expect(pdfMock).toHaveBeenCalledTimes(1);
    const [data, opts] = pdfMock.mock.calls[0]!;
    expect((data as { bill: { bill_number: string } }).bill.bill_number).toBe('HC-ODB-2609-001');
    expect((data as { debtor: { name: string } }).debtor.name).toBe('AHMAD BIN ALI');
    expect((data as { accountName: (c: string) => string | null }).accountName('700-0000')).toBe('Other Income');
    expect(opts).toEqual({ action: 'print' });
    expect(within(d).getByText('Edit')).toBeTruthy();
    expect(within(d).getByText('Copy')).toBeTruthy();
    expect(within(d).queryByText('Cancel bill')).toBeNull();
  });

  test('Cancel bill — offered while nothing was received — confirms, then sends the bill id', async () => {
    cancelBillAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('HC-ODB-2608-003'));
    fireEvent.click(within(dialog()).getByText('Cancel bill'));
    await waitFor(() => expect(cancelBillAsync).toHaveBeenCalledWith('b2'));
  });

  test('Edit opens the bill with its lines, says it will re-post, caps the total at the money received, and sends everything on Save & re-post', async () => {
    updateBillAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('HC-ODB-2609-001'));
    fireEvent.click(within(dialog()).getByText('Edit'));
    const d = screen.getAllByRole('dialog').at(-1)!;
    expect(within(d).getByText(/Edit HC-ODB-2609-001 — AHMAD BIN ALI/)).toBeTruthy();
    expect(within(d).getByText(/saving re-posts it/)).toBeTruthy();
    /* The debtor is fixed on an edit — a bill belongs to its debtor. */
    expect(within(d).queryByLabelText('Bill debtor')).toBeNull();
    expect((within(d).getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('500.00');
    setAmount(d, 'line 1 amount', '100');
    await waitFor(() => expect((within(d).getByText('Save & re-post') as HTMLButtonElement).disabled).toBe(true));
    setAmount(d, 'line 1 amount', '650');
    await waitFor(() => expect((within(d).getByText('Save & re-post') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(d).getByText('Save & re-post'));
    await waitFor(() => expect(updateBillAsync).toHaveBeenCalledWith({
      billId: 'b1',
      body: { billDate: '2026-09-05', notes: '转租九月', lines: [{ description: '转租', creditAccountCode: '700-0000', amountSen: 65000 }] },
    }));
  });

  test('Copy starts a NEW bill from the old one for the same debtor — lines and description ride over, the date is today', async () => {
    createBillAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('HC-ODB-2609-001'));
    fireEvent.click(within(dialog()).getByText('Copy'));
    const d = screen.getAllByRole('dialog').at(-1)!;
    expect(within(d).getByText(/copied from HC-ODB-2609-001/)).toBeTruthy();
    expect((within(d).getByLabelText('Bill debtor') as HTMLInputElement).value).toBe('AHMAD BIN ALI');
    expect((within(d).getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('500.00');
    fireEvent.click(within(d).getByText('Post bill'));
    await waitFor(() => expect(createBillAsync).toHaveBeenCalledTimes(1));
    const sent = createBillAsync.mock.calls[0]![0] as { debtorId: string; billDate: string; notes?: string; lines: unknown[] };
    expect(sent.debtorId).toBe('d1');
    expect(sent.billDate).toMatch(ISO_DATE);
    expect(sent.billDate).not.toBe('2026-09-05');
    expect(sent.notes).toBe('转租九月');
    expect(sent.lines).toEqual([{ description: '转租', creditAccountCode: '700-0000', amountSen: 50000 }]);
  });
});

describe('raising a debtor bill here', () => {
  test('New debtor bill picks the debtor (active ones only), then a line on a picked account; Post sends the debtor id, the date and integer sen', async () => {
    createBillAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('New debtor bill'));
    const d = dialog();
    expect(within(d).getByText(/New debtor bill/)).toBeTruthy();
    fireEvent.focus(within(d).getByLabelText('Bill debtor'));
    /* Active debtors only; the name also sits on a list row behind the dialog, so the OPTION is picked. */
    expect(screen.queryByRole('option', { name: 'GONE DEBTOR' })).toBeNull();
    fireEvent.mouseDown(screen.getByRole('option', { name: 'AHMAD BIN ALI' }));
    fireEvent.change(within(d).getByPlaceholderText('Description'), { target: { value: '转租十月' } });
    const accountBox = within(d).getAllByRole('combobox').find((el) => (el as HTMLInputElement).placeholder.includes('account this line'))!;
    fireEvent.focus(accountBox);
    fireEvent.mouseDown(screen.getByText('700-0000 · Other Income'));
    setAmount(d, 'line 1 amount', '450');
    await waitFor(() => expect((within(d).getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('450.00'));
    fireEvent.click(within(d).getByText('Post bill'));
    await waitFor(() => expect(createBillAsync).toHaveBeenCalledTimes(1));
    const sent = createBillAsync.mock.calls[0]![0] as { debtorId: string; billDate: string; lines: unknown[] };
    expect(sent.debtorId).toBe('d1');
    expect(sent.billDate).toMatch(ISO_DATE);
    expect(sent.lines).toEqual([{ description: '转租十月', creditAccountCode: '700-0000', amountSen: 45000 }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test('without a debtor the bill is refused on the spot, nothing sent', async () => {
    createBillAsync.mockClear(); notifyFn.mockClear();
    draw();
    fireEvent.click(screen.getByText('New debtor bill'));
    const d = dialog();
    const accountBox = within(d).getAllByRole('combobox').find((el) => (el as HTMLInputElement).placeholder.includes('account this line'))!;
    fireEvent.focus(accountBox);
    fireEvent.mouseDown(screen.getByText('700-0000 · Other Income'));
    setAmount(d, 'line 1 amount', '450');
    await waitFor(() => expect((within(d).getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('450.00'));
    fireEvent.click(within(d).getByText('Post bill'));
    await waitFor(() => expect(notifyFn).toHaveBeenCalled());
    expect(JSON.stringify(notifyFn.mock.calls.at(-1)![0])).toMatch(/Pick the debtor/);
    expect(createBillAsync).not.toHaveBeenCalled();
  });
});
