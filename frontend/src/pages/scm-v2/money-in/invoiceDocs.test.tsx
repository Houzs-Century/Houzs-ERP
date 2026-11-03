// Money in's invoice documents as pages (the owner's Claude Design, batch 5
// step 1): a deposit invoice, an other debtor's bill and a sales invoice, each
// at its own address with Back, Add task, Print, its facts, the Books line read
// from its journal, its sections and its trail. The steps the pop-outs had
// (Post to ledger, Cancel with a reason; Copy, Edit, Cancel bill) are here,
// asked about inline. The writes are the same hooks as before — the server half
// is backend/tests/depositInvoices.test.ts and otherDebtors.test.ts.

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DepositInvoice } from '../../../vendor/scm/lib/deposit-invoice-queries';

/* ── The ledger: what each document booked ─────────────────────────────── */
type Je = { id: string; je_no: string; entry_date: string; source_type: string; reversed: boolean; created_at: string; lines: unknown[] };
const JOURNALS: Record<string, Je[]> = {
  'DI|2990-DI-2609-003': [{
    id: 'je-13', je_no: '2990-JE-2609-0013', entry_date: '2026-09-08', source_type: 'DI', reversed: false, created_at: '2026-09-08T03:00:00Z',
    lines: [
      { line_no: 1, account_code: '300-0000', debit_sen: 100000, credit_sen: 0, party_name: 'Ah Seng', notes: null },
      { line_no: 2, account_code: '509-0000', debit_sen: 0, credit_sen: 100000, party_name: null, notes: null },
    ],
  }],
  'ODB|HC-ODB-2609-001': [{
    id: 'je-31', je_no: 'HC-JE-2609-031', entry_date: '2026-09-05', source_type: 'ODB', reversed: false, created_at: '2026-09-05T02:00:00Z',
    lines: [
      { line_no: 1, account_code: '305-0000', debit_sen: 50000, credit_sen: 0, party_name: 'AHMAD BIN ALI', notes: null },
      { line_no: 2, account_code: '700-0000', debit_sen: 0, credit_sen: 50000, party_name: null, notes: null },
    ],
  }],
};
vi.mock('../../../vendor/scm/lib/authed-fetch', () => ({
  authedFetch: vi.fn(async (path: string) => {
    const q = new URLSearchParams(path.split('?')[1] ?? '');
    return { journalEntries: JOURNALS[`${q.get('sourceType')}|${q.get('sourceDocNo')}`] ?? [] };
  }),
}));

/* ── Deposit invoices ───────────────────────────────────────────────────── */
const DI_ROWS: DepositInvoice[] = [
  {
    id: 'd1', company_id: 2, di_number: '2990-DI-2609-001', payment_source: 'SOPAY', payment_id: 'p-1', so_doc_no: '2990-SO-2609-001',
    party_code: 'cust-larding', party_name: 'Larding Chen', invoice_date: '2026-09-05', amount_sen: 100000, method: 'cash',
    status: 'ISSUED', je_no: '2990-JE-2609-0011', credit_note_id: null, cancel_reason: null,
    created_at: '2026-09-05T00:00:00Z', created_by: 'u-1', cancelled_at: null, cancelled_by: null,
    refunded_sen: 40000,
    refund_notes: [{ note_number: '2990-CN-2609-009', total_sen: 40000, status: 'POSTED', note_date: '2026-09-12', pv_number: '2990-CRF-2609-001' }],
  },
  {
    id: 'd2', company_id: 2, di_number: '2990-DI-2609-002', payment_source: 'SOPAY', payment_id: 'p-2', so_doc_no: '2990-SO-2609-002',
    party_code: 'cust-mei', party_name: 'Mei Ling', invoice_date: '2026-09-06', amount_sen: 50000, method: 'merchant',
    status: 'CANCELLED', je_no: '2990-JE-2609-0012', credit_note_id: null, cancel_reason: 'payment on 2990-SO-2609-002 edited — re-issued',
    created_at: '2026-09-06T00:00:00Z', created_by: 'u-1', cancelled_at: '2026-09-07T00:00:00Z', cancelled_by: 'Chew',
  },
  {
    id: 'd3', company_id: 2, di_number: '2990-DI-2609-003', payment_source: 'SOPAY', payment_id: 'p-3', so_doc_no: '2990-SO-2609-003',
    party_code: 'cust-seng', party_name: 'Ah Seng', invoice_date: '2026-09-08', amount_sen: 100000, method: 'cash',
    status: 'ISSUED', je_no: '2990-JE-2609-0013', credit_note_id: null, cancel_reason: null,
    created_at: '2026-09-08T00:00:00Z', created_by: 'u-1', cancelled_at: null, cancelled_by: null,
  },
  /* Its journal was refused at birth: Post to ledger. */
  {
    id: 'd4', company_id: 2, di_number: '2990-DI-2609-004', payment_source: 'SOPAY', payment_id: 'p-4', so_doc_no: '2990-SO-2609-004',
    party_code: 'cust-wong', party_name: 'Wong', invoice_date: '2026-09-09', amount_sen: 30000, method: 'transfer',
    status: 'ISSUED', je_no: null, credit_note_id: null, cancel_reason: null,
    created_at: '2026-09-09T00:00:00Z', created_by: 'u-1', cancelled_at: null, cancelled_by: null,
  },
];
const ORDER = { address1: '12 Jalan Satu', phone: '0123456789', email: null, total_sen: 336500, paid_to_date_sen: 100000 };
const cancelMutate = vi.fn();
const postMutate = vi.fn();
const pdfSingle = vi.fn(async (..._args: unknown[]) => {});
const pdfBlob = vi.fn(async (..._args: unknown[]) => new Blob(['%PDF-1.4'], { type: 'application/pdf' }));
vi.mock('../../../vendor/scm/lib/deposit-invoice-pdf', () => ({ generateDepositInvoicePdf: pdfSingle, generateDepositInvoicesPdf: vi.fn(), depositInvoicePdfBlob: pdfBlob }));
vi.mock('../../../vendor/scm/lib/deposit-invoice-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useDepositInvoiceDetail: (id: string | null) => ({
    data: id ? { invoice: DI_ROWS.find((r) => r.id === id)!, payment: { id: 'p-1', paid_at: '2026-09-05', method: 'cash', merchant_provider: null, online_type: null, amount_sen: 100000, is_deposit: true, collected_by: null } } : undefined,
    isLoading: false, isError: false, error: null,
  }),
  useDepositInvoiceSheet: (id: string | null) => ({ data: id ? { ...DI_ROWS.find((r) => r.id === id)!, order: ORDER } : undefined, isError: false, error: null }),
  useCancelDepositInvoice: () => ({ mutate: cancelMutate, isPending: false }),
  usePostDepositInvoice: () => ({ mutate: postMutate, isPending: false }),
}));

/* ── Debtor bills ───────────────────────────────────────────────────────── */
const BILLS: Record<string, unknown> = {
  b1: {
    bill: { id: 'b1', bill_number: 'HC-ODB-2609-001', bill_date: '2026-09-05', total_sen: 50000, received_sen: 20000, status: 'POSTED', notes: '转租九月', created_at: '2026-09-05T02:00:00Z',
      lines: [{ id: 'l1', line_no: 1, description: '转租', credit_account_code: '700-0000', amount_sen: 50000 }] },
    debtor: { id: 'd1', name: 'AHMAD BIN ALI', phone: '012-345', notes: null, is_active: true, outstanding_sen: 30000, address1: '12 Jalan Satu' },
    /* What came in on it (read c8): a receipt, and an other debtor's credit note. */
    receipts: [{ id: 'r1', number: 'HC-ODR-2609-004', date: '2026-09-28', status: 'POSTED', submittedAt: '2026-09-28T01:00:00Z', checkedAt: '2026-09-28T02:00:00Z', approvedAt: '2026-09-28T03:00:00Z', amountSen: 20000 }],
    creditNotes: [{ id: 'n1', number: 'HC-OCN-2610-001', date: '2026-10-10', status: 'POSTED', reason: 'Rental discount', amountSen: 3000, appliedSen: 3000 }],
  },
  b2: {
    bill: { id: 'b2', bill_number: 'HC-ODB-2608-003', bill_date: '2026-08-20', total_sen: 10000, received_sen: 0, status: 'POSTED', notes: null,
      lines: [{ id: 'l2', line_no: 1, description: null, credit_account_code: '700-0000', amount_sen: 10000, project_id: 348 }] },
    debtor: { id: 'd2', name: 'OLD DEBTOR', phone: null, notes: null, is_active: true, outstanding_sen: 10000 },
  },
  /* The copy, once posted. */
  b9: {
    bill: { id: 'b9', bill_number: 'HC-ODB-2611-001', bill_date: '2026-11-03', total_sen: 50000, received_sen: 0, status: 'POSTED', notes: '转租九月',
      lines: [{ id: 'l9', line_no: 1, description: '转租', credit_account_code: '700-0000', amount_sen: 50000 }] },
    debtor: { id: 'd1', name: 'AHMAD BIN ALI', phone: '012-345', notes: null, is_active: true, outstanding_sen: 80000 },
  },
};
vi.mock('../../../vendor/scm/lib/ar-invoice-queries', () => ({
  useArBillDetail: (id: string | null) => ({ data: id ? BILLS[id] : undefined, isLoading: false, error: null }),
}));
const billPdf = vi.fn(async (_d: unknown, _o: unknown) => {});
vi.mock('../../../vendor/scm/lib/debtor-bill-pdf', () => ({ generateDebtorBillPdf: (d: unknown, o: unknown) => billPdf(d, o) }));
const createBillAsync = vi.fn(async (_b: unknown) => ({ ok: true, bill: { id: 'b9', billNumber: 'HC-ODB-2611-001', totalSen: 50000 } }));
const updateBillAsync = vi.fn(async (_b: unknown) => ({ ok: true, bill: { id: 'b1', billNumber: 'HC-ODB-2609-001', totalSen: 65000 }, reposted: true, jeNo: 'HC-JE-2609-031' }));
const cancelBillMutate = vi.fn();
vi.mock('../../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/lib/accounting-queries')>()),
  useAccounts: () => ({ data: { accounts: [
    { account_code: '700-0000', account_name: 'Other Income', account_type: 'INCOME', parent_code: null, is_active: true, acc_money: false },
    { account_code: '300-0000', account_name: 'Trade Debtors', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false, special_type: 'SDC' },
    { account_code: '305-0000', account_name: 'Other Debtors', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false, special_type: 'SDC' },
    { account_code: '509-0000', account_name: 'Deposit pay by customer', account_type: 'INCOME', parent_code: null, is_active: true, acc_money: false },
  ] }, isLoading: false }),
  useAccountRoles: () => ({ data: { roles: { AR: '300-0000', DEPOSIT_INCOME: '509-0000' }, overridden: {} } }),
  useOtherDebtors: () => ({ data: { debtors: [
    { id: 'd1', name: 'AHMAD BIN ALI', phone: '012-345', notes: null, is_active: true, outstanding_sen: 30000 },
    { id: 'd2', name: 'OLD DEBTOR', phone: null, notes: null, is_active: true, outstanding_sen: 10000 },
  ] }, isLoading: false }),
  useCreateDebtorBill: () => ({ mutateAsync: createBillAsync, isPending: false }),
  useUpdateDebtorBill: () => ({ mutateAsync: updateBillAsync, isPending: false }),
  useCancelDebtorBill: () => ({ mutate: cancelBillMutate, isPending: false }),
}));
vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const EVENT_OPTIONS = [
  { id: 348, code: 'E-348', name: 'Pulau Pinang [AKEMI] MLE @ PWCC', startDate: '2026-09-25', endDate: '2026-09-27', status: 'confirmed', archived: false, venue: null, brand: 'AKEMI', organizer: 'MLE', boothNo: 'F1' },
];
vi.mock('../../../vendor/scm/lib/event-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/lib/event-queries')>()),
  useEventOptions: () => ({ data: EVENT_OPTIONS, isLoading: false }),
  useEventLabels: () => ({ data: new Map(EVENT_OPTIONS.map((e) => [e.id, e])) }),
}));

/* ── Sales invoices ─────────────────────────────────────────────────────── */
const SI_DETAIL = {
  salesInvoice: {
    id: 'si-1', invoice_number: 'HC-SI-2609-001', debtor_name: 'TAN AH KOW', debtor_code: '300-C001', status: 'SENT', currency: 'MYR',
    invoice_date: '2026-09-03', due_date: '2026-09-30', so_doc_no: 'HC-SO-2609-004', total_sen: 440000, paid_sen: 40000, so_deposit_applied_sen: 20000,
    subtotal_sen: 440000, discount_sen: 0, tax_sen: 0, notes: null, address1: '8 Jalan Dua',
  },
  items: [{ item_code: 'BED-1', description: 'Bedroom set', qty: 1, unit_price_sen: 440000, line_total_sen: 440000 }],
};
vi.mock('../../../vendor/scm/lib/sales-invoice-queries', () => ({
  useSalesInvoiceDetail: (id: string | null) => ({ data: id === 'si-1' ? SI_DETAIL : undefined, isLoading: false, isError: false, error: null }),
}));
const siPdf = vi.fn(async (_h: unknown, _i: unknown, _o: unknown) => {});
const siBlob = vi.fn(async (_h: unknown, _i: unknown) => new Blob(['%PDF-1.4'], { type: 'application/pdf' }));
vi.mock('../../../vendor/scm/lib/sales-invoice-pdf', () => ({
  generateSalesInvoicePdf: (h: unknown, i: unknown, o: unknown) => siPdf(h, i, o),
  salesInvoicePdfBlob: (h: unknown, i: unknown) => siBlob(h, i),
}));

/* Add task opens To do's drawer with this document linked. */
vi.mock('../PvDocParts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../PvDocParts')>()),
  VoucherTaskDrawer: ({ link }: { link: { type: string; no: string; to: string } }) => <div role="dialog" aria-label="Add task">{`${link.type} ${link.no} → ${link.to}`}</div>,
}));

beforeAll(() => {
  /* jsdom has no object URLs; the page as it prints is a blob in an iframe. */
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:paper'), revokeObjectURL: vi.fn() });
});
beforeEach(() => { vi.clearAllMocks(); });

const { DepositInvoiceDoc } = await import('./DepositInvoiceDoc');
const { DebtorBillDoc } = await import('./DebtorBillDoc');
const { SalesInvoiceDoc } = await import('./SalesInvoiceDoc');
const { ToastProvider } = await import('../../../hooks/useToast');

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
}
const open = (path: string, route: string, page: ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={page} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  </QueryClientProvider>,
);
const openDi = (id: string) => open(`/scm/ar-invoices/deposit/${id}`, '/scm/ar-invoices/deposit/:id', <DepositInvoiceDoc />);
const openBill = (id: string, form = '') => open(`/scm/ar-invoices/bills/${id}${form}`, '/scm/ar-invoices/bills/:id', <DebtorBillDoc />);
const fact = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement;
const setAmount = (scope: HTMLElement, label: string, rm: string) => {
  const box = within(scope).getByLabelText(label);
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: rm } });
  fireEvent.blur(box);
};

describe('a deposit invoice, as a page', () => {
  test('its customer, order, payment and journal; the Books line is the journal\'s own accounts; Print prints the sheet', async () => {
    openDi('d3');
    const title = screen.getByRole('heading', { level: 1, name: '2990-DI-2609-003' });
    expect(within(title.parentElement!).getByText('Issued')).toBeTruthy();
    expect(screen.getByText('Back to Deposit invoices')).toBeTruthy();
    expect(screen.getAllByText('Ah Seng').length).toBeGreaterThan(0);
    expect(screen.getByText('12 Jalan Satu')).toBeTruthy();
    expect(fact('Sales order').querySelector('a')!.getAttribute('href')).toBe('/scm/sales-orders/2990-SO-2609-003');
    expect(fact('Payment').textContent).toBe('Cash · 2026/09/05 · RM 1,000.00');
    expect(fact('Journal').textContent).toBe('2990-JE-2609-0013');
    expect(fact('Closed by').textContent).toBe('Open until the final invoice');
    await waitFor(() => expect(screen.getByText(/Dr 300-0000 Trade Debtors \(Ah Seng\) · Cr 509-0000 Deposit pay by customer · RM 1,000\.00 · 2990-JE-2609-0013/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Post to ledger' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Print/ }));
    await waitFor(() => expect(pdfSingle).toHaveBeenCalled());
    expect(pdfSingle.mock.calls[0]?.[0]).toMatchObject({ di_number: '2990-DI-2609-003', order: ORDER });
    expect(pdfSingle.mock.calls[0]?.[1]).toEqual({ action: 'print' });
  });

  test('Cancel asks inline: the reason first, then it is sent; Keep it leaves', () => {
    openDi('d3');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel…' }));
    const ask = screen.getByRole('region', { name: 'Cancel 2990-DI-2609-003?' });
    expect(ask.textContent).toContain('Its journal 2990-JE-2609-0013 is reversed by a contra dated today. It stays on file as cancelled and prints as void with your reason.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel invoice' }));
    expect(cancelMutate).not.toHaveBeenCalled();
    fireEvent.change(within(ask).getByPlaceholderText('Why? e.g. payment keyed twice'), { target: { value: 'Customer changed order' } });
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel invoice' }));
    expect(cancelMutate.mock.calls[0]?.[0]).toEqual({ id: 'd3', reason: 'Customer changed order' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByRole('region', { name: 'Cancel 2990-DI-2609-003?' })).toBeNull();
  });

  test('a credit note against it greys Cancel with the reason; the refund is its own section (docs/bugs/0860)', () => {
    openDi('d1');
    const cancel = screen.getByRole('button', { name: 'Cancel…' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    expect(cancel.title).toBe('A credit note stands against this invoice, so it can’t be cancelled or re-issued.');
    expect(screen.getByText(/Cancelling the final invoice or the refund voucher takes the note back first/)).toBeTruthy();
    const refunds = screen.getByRole('region', { name: 'Refunds' });
    expect(within(refunds).getByText(/Refunded RM 400\.00 — the sale this invoice booked is taken back by credit note/)).toBeTruthy();
    expect(within(refunds).getByText('2990-CN-2609-009')).toBeTruthy();
    expect(within(refunds).getByText('2990-CRF-2609-001')).toBeTruthy();
  });

  test('a cancelled invoice reads void with its reason and offers neither Post nor Cancel', () => {
    openDi('d2');
    expect(screen.getByText('void · payment on 2990-SO-2609-002 edited — re-issued')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Post to ledger' })).toBeNull();
    expect(fact('Cancelled').textContent).toBe('Chew · 2026/09/07');
    const trail = screen.getByRole('complementary', { name: 'Trail' });
    expect(within(trail).getByText('Cancelled')).toBeTruthy();
    expect(within(trail).getByText('payment on 2990-SO-2609-002 edited — re-issued')).toBeTruthy();
  });

  test('an invoice whose journal was refused offers Post to ledger and previews what it books', async () => {
    openDi('d4');
    expect(fact('Journal').textContent).toBe('Not posted');
    await waitFor(() => expect(screen.getByText(/Dr 300-0000 Trade Debtors \(Wong\) · Cr 509-0000 Deposit pay by customer · RM 300\.00/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Post to ledger' }));
    expect(postMutate.mock.calls[0]?.[0]).toBe('d4');
  });

  test('the page as it prints sits below, with Save PDF; Add task links the invoice', async () => {
    openDi('d3');
    await waitFor(() => expect(screen.getByTitle('Deposit invoice 2990-DI-2609-003 as printed').getAttribute('src')).toBe('blob:paper'));
    expect(pdfBlob.mock.calls[0]?.[0]).toMatchObject({ di_number: '2990-DI-2609-003', order: ORDER });
    fireEvent.click(screen.getByRole('button', { name: 'Save PDF' }));
    await waitFor(() => expect(pdfSingle.mock.calls[0]?.[1]).toEqual({ action: 'save' }));
    fireEvent.click(screen.getByRole('button', { name: /Add task/ }));
    expect(screen.getByRole('dialog', { name: 'Add task' }).textContent).toBe('Deposit invoice 2990-DI-2609-003 → /scm/ar-invoices/deposit/d3');
  });
});

describe('an other debtor\'s bill, as a page', () => {
  test('its lines, description, money received and still owed; Print hands the bill, its debtor and the account names to the PDF; money on it greys Cancel', async () => {
    openBill('b1');
    expect(screen.getByRole('heading', { level: 1, name: 'HC-ODB-2609-001' })).toBeTruthy();
    expect(screen.getByText('Partly paid')).toBeTruthy();
    expect(screen.getByText('Back to AR invoices')).toBeTruthy();
    expect(fact('Description').textContent).toBe('转租九月');
    expect(fact('Received').textContent).toBe('RM 200.00');
    expect(fact('Outstanding').textContent).toBe('RM 300.00');
    expect(fact('Debtor').querySelector('a')!.getAttribute('href')).toBe('/scm/other-debtors/d1');
    const lines = screen.getByRole('region', { name: 'Lines' });
    expect(within(lines).getByText('转租')).toBeTruthy();
    expect(within(lines).getByText('Other Income')).toBeTruthy();
    await waitFor(() => expect(fact('Journal').textContent).toBe('HC-JE-2609-031'));
    fireEvent.click(screen.getByRole('button', { name: /Print/ }));
    const [data, opts] = billPdf.mock.calls[0]!;
    expect((data as { bill: { bill_number: string } }).bill.bill_number).toBe('HC-ODB-2609-001');
    expect((data as { debtor: { name: string } }).debtor.name).toBe('AHMAD BIN ALI');
    expect((data as { accountName: (c: string) => string | null }).accountName('700-0000')).toBe('Other Income');
    expect(opts).toEqual({ action: 'print' });
    const cancel = screen.getByRole('button', { name: 'Cancel bill…' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    expect(cancel.title).toBe('This bill has money received on it, so it can’t be cancelled.');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  test('the receipts on it and the credit notes allocated to it, each opening its own page; a bill nothing came in on says so', async () => {
    const view = openBill('b1');
    const receipts = screen.getByRole('region', { name: 'Receipts' });
    expect(within(receipts).getByText('HC-ODR-2609-004').closest('a')!.getAttribute('href')).toBe('/scm/receipts/debtor/r1');
    expect(within(receipts).getByText('Approved')).toBeTruthy();
    expect(within(receipts).getByText('RM 200.00')).toBeTruthy();
    const notes = screen.getByRole('region', { name: 'Credit notes' });
    expect(within(notes).getByText('HC-OCN-2610-001').closest('a')!.getAttribute('href')).toBe('/scm/credit-notes/n1');
    expect(within(notes).getByText('Rental discount')).toBeTruthy();
    expect(within(screen.getByRole('complementary', { name: 'Trail' })).getByText('Received · HC-ODR-2609-004')).toBeTruthy();
    view.unmount();
    openBill('b2');
    expect(within(screen.getByRole('region', { name: 'Receipts' })).getByText('No receipt yet.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Credit notes' })).toBeNull();
  });

  test('Cancel bill — while nothing was received — asks inline, then sends the bill id', () => {
    openBill('b2');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel bill…' }));
    const ask = screen.getByRole('region', { name: 'Cancel HC-ODB-2608-003?' });
    expect(ask.textContent).toContain('It stays on file as cancelled.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel bill' }));
    expect(cancelBillMutate.mock.calls[0]?.[0]).toBe('b2');
  });

  test('Edit opens the bill form in place of the page, says it re-posts, caps the total at the money received, and sends everything', async () => {
    openBill('b1');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('heading', { name: 'Edit HC-ODB-2609-001' })).toBeTruthy();
    expect(screen.getByText(/saving re-posts it/)).toBeTruthy();
    expect(screen.queryByLabelText('Bill debtor')).toBeNull();
    expect((screen.getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('500.00');
    setAmount(document.body, 'line 1 amount', '100');
    await waitFor(() => expect((screen.getByText('Save & re-post') as HTMLButtonElement).disabled).toBe(true));
    setAmount(document.body, 'line 1 amount', '650');
    await waitFor(() => expect((screen.getByText('Save & re-post') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText('Save & re-post'));
    await waitFor(() => expect(updateBillAsync).toHaveBeenCalledWith({
      billId: 'b1',
      body: { billDate: '2026-09-05', notes: '转租九月', lines: [{ description: '转租', creditAccountCode: '700-0000', amountSen: 65000 }] },
    }));
    /* Saved: back to the bill. */
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'HC-ODB-2609-001' })).toBeTruthy());
  });

  test('Copy starts a NEW bill from it for the same debtor — lines and description ride over, the date is today — and opens it once posted', async () => {
    openBill('b1', '?form=copy');
    expect(screen.getByRole('heading', { name: 'New debtor bill · copy of HC-ODB-2609-001' })).toBeTruthy();
    expect((screen.getByLabelText('Bill debtor') as HTMLInputElement).value).toBe('AHMAD BIN ALI');
    expect((screen.getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('500.00');
    fireEvent.click(screen.getByText('Post bill'));
    await waitFor(() => expect(createBillAsync).toHaveBeenCalledTimes(1));
    const sent = createBillAsync.mock.calls[0]![0] as { debtorId: string; billDate: string; notes?: string; lines: unknown[] };
    expect(sent.debtorId).toBe('d1');
    expect(sent.billDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sent.billDate).not.toBe('2026-09-05');
    expect(sent.notes).toBe('转租九月');
    expect(sent.lines).toEqual([{ description: '转租', creditAccountCode: '700-0000', amountSen: 50000 }]);
    /* Posted: the new bill's own page opens. */
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'HC-ODB-2611-001' })).toBeTruthy());
  });

  test("Edit keeps a line's event", async () => {
    openBill('b2', '?form=edit');
    expect((screen.getByLabelText('line 1 event') as HTMLInputElement).value).toMatch(/MLE @ PWCC/);
    fireEvent.click(screen.getByText('Save & re-post'));
    await waitFor(() => expect(updateBillAsync).toHaveBeenCalledWith({
      billId: 'b2', body: { billDate: '2026-08-20', lines: [{ creditAccountCode: '700-0000', amountSen: 10000, projectId: 348 }] },
    }));
  });
});

describe('a sales invoice, read from Sales', () => {
  test('who it bills, its dates and order, the deposit applied, paid and outstanding; its lines; the page as it prints; Open in Sales', async () => {
    open('/scm/ar-invoices/sales/si-1', '/scm/ar-invoices/sales/:id', <SalesInvoiceDoc />);
    expect(screen.getByRole('heading', { level: 1, name: 'HC-SI-2609-001' })).toBeTruthy();
    expect(screen.getByText('raised in Sales · edit or cancel it there')).toBeTruthy();
    expect(screen.getByText(/^Overdue \d+d$/)).toBeTruthy();
    expect(screen.getByText('8 Jalan Dua')).toBeTruthy();
    expect(fact('Sales order').querySelector('a')!.getAttribute('href')).toBe('/scm/sales-orders/HC-SO-2609-004');
    expect(fact('Deposit applied').textContent).toBe('RM 200.00');
    expect(fact('Paid').textContent).toBe('RM 400.00');
    expect(fact('Outstanding').textContent).toBe('RM 3,800.00');
    expect(within(screen.getByRole('region', { name: 'Lines' })).getByText('Bedroom set')).toBeTruthy();
    await waitFor(() => expect(screen.getByTitle('Sales invoice HC-SI-2609-001 as printed').getAttribute('src')).toBe('blob:paper'));
    expect(siBlob.mock.calls[0]).toEqual([SI_DETAIL.salesInvoice, SI_DETAIL.items]);
    fireEvent.click(screen.getByRole('button', { name: /Print/ }));
    await waitFor(() => expect(siPdf).toHaveBeenCalledWith(SI_DETAIL.salesInvoice, SI_DETAIL.items, { action: 'print' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save PDF' }));
    await waitFor(() => expect(siPdf).toHaveBeenCalledWith(SI_DETAIL.salesInvoice, SI_DETAIL.items, { action: 'save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open in Sales' }));
    expect(screen.getByTestId('where').textContent).toBe('/scm/sales-invoices/si-1');
  });
});
