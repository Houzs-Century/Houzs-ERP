/* AR Invoices — the Finance list shows BOTH kinds (owner 2026-09-29: 可以把
   sales invoice 和 other debtor bill 做一个类似 ap invoice 这样让我 finance 这边
   看两个一起吗): sales invoices as a read-only mirror linking to their own
   page, other-debtor bills raised HERE (我希望 other debtor 那边只是 maintain
   other debtor 就好, 开 other debtor 的 bill 就直接在 ar invoice 页面) — the
   debtor picked first, then the bill form; a bill opens in a pop-out over the
   list with Print / Edit / Copy / Cancel; the party filter narrows and Print
   listing prints what is shown; `?debtor=` opens on one debtor. Since
   2026-10-06 (owner: ar invoice 点不开、没有办法 print) a click anywhere on a
   row opens it — since the redesign (batch 5 step 1) as the document's own
   page in its own tab (money-in/invoiceDocs.test.tsx holds the pages: Print,
   Edit, Copy, Cancel) — and ticked rows print as ONE document. The server
   half is backend/tests/arInvoices.test.ts (+ otherDebtors.test.ts for the
   bill's writes). */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, test, vi } from 'vitest';

/* What the list was asked for — kind and docKind (the other debtors' debit notes, 2026-10-28). */
const lastArList = { value: '' };
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
      lines: [{ id: 'l2', line_no: 1, description: null, credit_account_code: '700-0000', amount_sen: 10000, project_id: 348 }] },
    debtor: { id: 'd2', name: 'OLD DEBTOR', phone: null, notes: null, is_active: true, outstanding_sen: 10000 },
  },
};

vi.mock('../../vendor/scm/lib/ar-invoice-queries', () => ({
  useArInvoices: (kind?: string, docKind?: string) => { lastArList.value = `${kind ?? ''}|${docKind ?? ''}`; return { data: { rows: ROWS }, isLoading: false, isError: false, error: null }; },
  useArBillDetail: (id: string | null) => ({ data: id ? DETAILS[id] : undefined, isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/ar-invoice-listing-pdf', () => ({
  generateArListingPdf: (rows: unknown, filter: unknown) => listingAsync(rows, filter),
}));
vi.mock('../../vendor/scm/lib/debtor-bill-pdf', () => ({ generateDebtorBillPdf: (d: unknown, o: unknown) => pdfMock(d, o) }));
/* A sales invoice opened over the list: its detail, the page it prints, Print / Save PDF. */
const SI_DETAIL = {
  salesInvoice: { id: 'si-1', invoice_number: 'HC-SI-2609-001', debtor_name: 'TAN AH KOW', status: 'SENT', total_sen: 440000 },
  items: [{ item_code: 'BED-1', description: 'Bedroom set', qty: 1, unit_price_sen: 440000, line_total_sen: 440000 }],
};
vi.mock('../../vendor/scm/lib/sales-invoice-queries', () => ({
  useSalesInvoiceDetail: (id: string | null) => ({ data: id === 'si-1' ? SI_DETAIL : undefined, isLoading: false, isError: false, error: null }),
}));
const siPdf = vi.fn(async (_h: unknown, _i: unknown, _o: unknown) => {});
const siBlob = vi.fn(async (_h: unknown, _i: unknown) => new Blob(['%PDF-1.4'], { type: 'application/pdf' }));
vi.mock('../../vendor/scm/lib/sales-invoice-pdf', () => ({
  generateSalesInvoicePdf: (h: unknown, i: unknown, o: unknown) => siPdf(h, i, o),
  salesInvoicePdfBlob: (h: unknown, i: unknown) => siBlob(h, i),
}));
/* Ticked rows: one document, delivered through the shared exit. */
const arBlob = vi.fn(async (_rows: unknown, _names: unknown) => new Blob(['%PDF-1.4'], { type: 'application/pdf' }));
vi.mock('../../vendor/scm/lib/ar-invoice-print', () => ({ arInvoicesPdfBlob: (rows: unknown, names: unknown) => arBlob(rows, names) }));
const deliverBlob = vi.fn();
vi.mock('../../vendor/scm/lib/pdf-common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/pdf-common')>()),
  deliverPdfBlob: (...args: unknown[]) => deliverBlob(...args),
}));
beforeAll(() => {
  /* jsdom has no object URLs; the pop-out's page is a blob in an iframe. */
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:si-1'), revokeObjectURL: vi.fn() });
});
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
/* A row opens its document's page in its own tab. */
const openInTabFn = vi.fn();
vi.mock('../../lib/openDocInTab', () => ({ useOpenDocInTab: () => openInTabFn }));
/* Events (owner 2026-10-01, payment-request item 6) — the picker's list and labels, stubbed; the real eventLabel stays. */
const EVENT_OPTIONS = [
  { id: 348, code: 'E-348', name: 'Pulau Pinang [AKEMI] MLE @ PWCC', startDate: '2026-09-25', endDate: '2026-09-27', status: 'confirmed', archived: false, venue: null, brand: 'AKEMI', organizer: 'MLE', boothNo: 'F1' },
];
vi.mock('../../vendor/scm/lib/event-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/event-queries')>()),
  useEventOptions: () => ({ data: EVENT_OPTIONS, isLoading: false }),
  useEventLabels: () => ({ data: new Map(EVENT_OPTIONS.map((e) => [e.id, e])) }),
}));
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
  test('a sales invoice mirrors with its number as the link to its page and the SI list\'s outstanding; a bill shows its debtor', () => {
    draw();
    expect(screen.getByText('Sales Invoice')).toBeTruthy();
    expect(screen.getAllByText('Debtor Bill')).toHaveLength(2);
    /* The number is the document's link: it opens the invoice's own page. */
    expect(screen.getByText('HC-SI-2609-001').closest('a')!.getAttribute('href')).toBe('/scm/ar-invoices/sales/si-1');
    expect(screen.getByText('HC-ODB-2609-001').closest('a')!.getAttribute('href')).toBe('/scm/ar-invoices/bills/b1');
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

/* 点不开、没有办法 print (owner 2026-10-06). */
describe('every row opens, and prints', () => {
  test('a click anywhere on a row opens its document\'s page in its own tab — a sales invoice\'s, a debtor bill\'s', () => {
    openInTabFn.mockClear();
    draw();
    fireEvent.click(within(screen.getByText('HC-SI-2609-001').closest('tr')!).getByText('Bedroom set'));
    expect(openInTabFn).toHaveBeenLastCalledWith('/scm/ar-invoices/sales/si-1');
    fireEvent.click(within(screen.getByText('HC-ODB-2609-001').closest('tr')!).getByText('转租九月'));
    expect(openInTabFn).toHaveBeenLastCalledWith('/scm/ar-invoices/bills/b1');
    /* No pop-out over the list any more. */
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('ticked rows print as ONE document in the order the table shows them', async () => {
    arBlob.mockClear(); deliverBlob.mockClear();
    draw();
    fireEvent.click(screen.getByLabelText('Tick HC-SI-2609-001'));
    fireEvent.click(screen.getByLabelText('Tick HC-ODB-2609-001'));
    expect(screen.getByText('2 ticked')).toBeTruthy();
    fireEvent.click(screen.getByText('Print 2'));
    await waitFor(() => expect(deliverBlob).toHaveBeenCalled());
    const [rows, names] = arBlob.mock.calls[0]!;
    expect((rows as Array<{ invoiceNumber: string }>).map((r) => r.invoiceNumber)).toEqual(['HC-ODB-2609-001', 'HC-SI-2609-001']);
    expect((names as (c: string) => string | null)('700-0000')).toBe('Other Income');
    expect(deliverBlob.mock.calls[0]![1]).toMatch(/^ar-invoices-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(deliverBlob.mock.calls[0]![2]).toBe('print');
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

/* An event on a bill line (owner 2026-10-01, payment-request item 6: other debtor 单也要，但不是一定要选) —
   optional: the picker above the lines sets every line, the posted credit leg carries it (backend/tests/otherDebtors.test.ts). */
describe('an event on a bill line — optional', () => {
  test('the event picked for all lines rides on each money line', async () => {
    createBillAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('New debtor bill'));
    const d = dialog();
    fireEvent.focus(within(d).getByLabelText('Bill debtor'));
    fireEvent.mouseDown(screen.getByRole('option', { name: 'AHMAD BIN ALI' }));
    const accountBox = within(d).getAllByRole('combobox').find((el) => (el as HTMLInputElement).placeholder.includes('account this line'))!;
    fireEvent.focus(accountBox);
    fireEvent.mouseDown(screen.getByText('700-0000 · Other Income'));
    setAmount(d, 'line 1 amount', '1500');
    expect((within(d).getByLabelText('line 1 event') as HTMLInputElement).value).toBe('— No event —');
    fireEvent.focus(within(d).getByLabelText('Event for all lines'));
    fireEvent.mouseDown(screen.getByText(/MLE @ PWCC/));
    expect((within(d).getByLabelText('line 1 event') as HTMLInputElement).value).toMatch(/MLE @ PWCC/);
    fireEvent.click(within(d).getByText('Post bill'));
    await waitFor(() => expect(createBillAsync).toHaveBeenCalledTimes(1));
    expect((createBillAsync.mock.calls[0]![0] as { lines: unknown[] }).lines).toEqual([{ creditAccountCode: '700-0000', amountSen: 150000, projectId: 348 }]);
  });

});

/* Debit notes to other debtors (owner 2026-10-28: Customer & Other Debtor CN / DN): this
   page narrowed to them, shown inside the CN / DN page's Other debtor DN tab. */
describe('the debit notes to other debtors', () => {
  test('docKind="DN" asks for the debit notes alone, has no page header, and New debit note raises one as a DN', async () => {
    createBillAsync.mockClear();
    render(<MemoryRouter initialEntries={['/scm/credit-notes']}><ArInvoices docKind="DN" /></MemoryRouter>);
    expect(lastArList.value).toBe('ODB|DN');
    expect(screen.queryByText('New debtor bill')).toBeNull();
    expect(screen.getByText('Debit notes to other debtors — they owe more')).toBeTruthy();
    fireEvent.click(screen.getByText('New debit note'));
    const d = dialog();
    expect(within(d).getAllByText(/New debit note to an other debtor/).length).toBeGreaterThan(0);
    fireEvent.focus(within(d).getByLabelText('Bill debtor'));
    fireEvent.mouseDown(screen.getByRole('option', { name: 'AHMAD BIN ALI' }));
    const accountBox = within(d).getAllByRole('combobox').find((el) => (el as HTMLInputElement).placeholder.includes('account this line'))!;
    fireEvent.focus(accountBox);
    fireEvent.mouseDown(screen.getByText('700-0000 · Other Income'));
    setAmount(d, 'line 1 amount', '120');
    fireEvent.click(within(d).getByText('Post bill'));
    await waitFor(() => expect(createBillAsync).toHaveBeenCalledTimes(1));
    expect(createBillAsync.mock.calls[0]![0]).toMatchObject({ debtorId: 'd1', docKind: 'DN', lines: [{ creditAccountCode: '700-0000', amountSen: 12000 }] });
  });
});
