/* Invoices — the money owed to the company on one page (owner 2026-09-29: 可以
   把 sales invoice 和 other debtor bill 做一个类似 ap invoice 这样让我 finance 这边
   看两个一起吗; the owner's Claude Design, batch 5 step 5): the sales invoices
   (read from Sales), the deposit invoices folded in from their own page, and
   the other debtors' bills raised here; kind segments and status chips with
   counts, the party filter (`?debtor=`), a sand tint on what is still owed,
   the switch's backlogs at the head, Post to ledger one by one or as a batch,
   Cancel asked inline with its reason, Print, and the bill form in place of
   the list. The server halves are backend/tests/arInvoices.test.ts,
   depositInvoices.test.ts and otherDebtors.test.ts. */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { OtherDebtor } from '../../vendor/scm/lib/accounting-queries';

const TODAY = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/* ── What the server answers (ONE stable object per read, as react-query hands back) ── */
const AR_ROWS = [
  { kind: 'ODB', docKind: 'INV', id: 'b1', invoiceNumber: 'HC-ODB-2609-001', partyKey: 'D:d1', partyCode: null, partyName: 'AHMAD BIN ALI', debtorId: 'd1', ref: null, description: '转租九月', invoiceDate: '2026-09-05', dueDate: null, currency: 'MYR', totalSen: 50_000, paidSen: 20_000, depositAppliedSen: 0, outstandingSen: 30_000, status: 'POSTED' },
  { kind: 'SI', docKind: 'INV', id: 'si-1', invoiceNumber: 'HC-SI-2609-001', partyKey: 'C:300-C001', partyCode: '300-C001', partyName: 'TAN AH KOW', debtorId: null, ref: 'HC-SO-2609-004', description: 'Bedroom set', invoiceDate: '2026-09-03', dueDate: '2026-09-30', currency: 'MYR', totalSen: 440_000, paidSen: 60_000, depositAppliedSen: 20_000, creditNotesSen: 30_000, outstandingSen: 350_000, status: 'SENT' },
  { kind: 'ODB', docKind: 'DN', id: 'b3', invoiceNumber: 'HC-ODN-2610-001', partyKey: 'D:d2', partyCode: null, partyName: 'OLD DEBTOR', debtorId: 'd2', ref: null, description: 'Damaged booth', invoiceDate: '2026-10-02', dueDate: null, currency: 'MYR', totalSen: 10_000, paidSen: 10_000, depositAppliedSen: 0, outstandingSen: 0, status: 'POSTED' },
];
const DI_ROWS = [
  { id: 'di-1', company_id: 1, di_number: 'HC-DI-2610-001', payment_source: 'SOPAY', payment_id: 'p1', so_doc_no: 'HC-SO-2610-011', party_code: '300-C002', party_name: 'LIM', invoice_date: '2026-10-05', amount_sen: 100_000, method: 'transfer', status: 'ISSUED', je_no: null, credit_note_id: null, cancel_reason: null, created_at: '2026-10-05', created_by: null, cancelled_at: null, cancelled_by: null },
  { id: 'di-2', company_id: 1, di_number: 'HC-DI-2610-002', payment_source: 'SOPAY', payment_id: 'p2', so_doc_no: 'HC-SO-2610-012', party_code: '300-C003', party_name: 'ONG', invoice_date: '2026-10-06', amount_sen: 50_000, method: 'cash', status: 'ISSUED', je_no: 'HC-JE-2610-0100', credit_note_id: null, cancel_reason: null, created_at: '2026-10-06', created_by: null, cancelled_at: null, cancelled_by: null },
  { id: 'di-3', company_id: 1, di_number: 'HC-DI-2610-003', payment_source: 'SOPAY', payment_id: 'p3', so_doc_no: 'HC-SO-2610-013', party_code: '300-C004', party_name: 'WONG', invoice_date: '2026-10-07', amount_sen: 30_000, method: 'cash', status: 'ISSUED', je_no: 'HC-JE-2610-0101', credit_note_id: 'cn-9', credit_note_number: 'HC-CN-2610-009', refunded_sen: 5_000, cancel_reason: null, created_at: '2026-10-07', created_by: null, cancelled_at: null, cancelled_by: null },
];
const AR = { data: { rows: AR_ROWS }, isLoading: false, isError: false, error: null };
const DI = { data: { rows: DI_ROWS }, isLoading: false, isError: false, error: null };
const SETTINGS = { data: { settings: { enabled: true, fromDate: '2026-09-15' }, missingCount: 2, deliveredUninvoicedCount: 3 }, isLoading: false, isError: false, error: null };
const BILL_B1 = {
  bill: { id: 'b1', bill_number: 'HC-ODB-2609-001', bill_date: '2026-09-05', total_sen: 50_000, received_sen: 20_000, status: 'POSTED', notes: '转租九月', doc_kind: 'INV',
    lines: [{ id: 'l1', line_no: 1, description: '转租', credit_account_code: '700-0000', amount_sen: 50_000, project_id: null }] },
  debtor: { id: 'd1', name: 'AHMAD BIN ALI', phone: '012-345', notes: null, is_active: true, outstanding_sen: 30_000 },
};
const arAsked: string[] = [];
vi.mock('../../vendor/scm/lib/ar-invoice-queries', () => ({
  useArInvoices: (kind?: string, docKind?: string) => { arAsked.push(`${kind ?? ''}|${docKind ?? ''}`); return AR; },
  useArBillDetail: (id: string | null) => ({ data: id === 'b1' ? BILL_B1 : undefined, isLoading: false, isError: false }),
}));
const issueMutate = vi.fn();
const deliveredMutate = vi.fn();
const cancelDiMutate = vi.fn();
vi.mock('../../vendor/scm/lib/deposit-invoice-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/deposit-invoice-queries')>()),
  useDepositInvoices: () => DI,
  useDepositInvoiceSettings: () => SETTINGS,
  useIssueMissingDepositInvoices: () => ({ mutate: issueMutate, isPending: false }),
  useInvoiceDeliveredOrders: () => ({ mutate: deliveredMutate, isPending: false }),
  useCancelDepositInvoice: () => ({ mutate: cancelDiMutate, isPending: false }),
  fetchDepositInvoiceSheets: vi.fn(async (ids: string[]) => ids.map((id) => ({ id }))),
}));
const posts: string[] = [];
let refusePost: string | null = null;
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({
  authedFetch: vi.fn(async (path: string) => {
    if (path.startsWith('/accounting/journal-entries')) return { journalEntries: [] };
    const post = /^\/deposit-invoices\/([^/]+)\/post$/.exec(path);
    if (post) {
      posts.push(post[1]!);
      if (refusePost === post[1]) throw new Error('The deposit account is not set for this company.');
      return { ok: true, jeNo: `HC-JE-2610-09${posts.length}` };
    }
    throw new Error(`unexpected ${path}`);
  }),
}));
const listingPdf = vi.fn(async (_rows: unknown, _filter: unknown) => undefined);
vi.mock('../../vendor/scm/lib/ar-invoice-listing-pdf', () => ({ generateArListingPdf: (r: unknown, f: unknown) => listingPdf(r, f) }));
const arBlob = vi.fn(async (_rows: unknown, _names: unknown) => new Blob(['%PDF-1.4'], { type: 'application/pdf' }));
vi.mock('../../vendor/scm/lib/ar-invoice-print', () => ({ arInvoicesPdfBlob: (rows: unknown, names: unknown) => arBlob(rows, names) }));
const diPdf = vi.fn(async (_s: unknown, _o: unknown) => {});
vi.mock('../../vendor/scm/lib/deposit-invoice-pdf', () => ({ generateDepositInvoicesPdf: (s: unknown, o: unknown) => diPdf(s, o) }));
const deliverBlob = vi.fn();
vi.mock('../../vendor/scm/lib/pdf-common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/pdf-common')>()),
  deliverPdfBlob: (...args: unknown[]) => deliverBlob(...args),
}));

const ACCOUNTS = { data: { accounts: [
  { account_code: '700-0000', account_name: 'Other Income', account_type: 'INCOME', parent_code: null, is_active: true, acc_money: false },
  { account_code: '305-0000', account_name: 'Other Debtors', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false, special_type: 'SDC' },
] }, isLoading: false };
const DEBTORS: { data: { debtors: OtherDebtor[] }; isLoading: boolean } = { data: { debtors: [
  { id: 'd1', name: 'AHMAD BIN ALI', phone: '012-345', notes: null, is_active: true, outstanding_sen: 30_000 },
  { id: 'd2', name: 'OLD DEBTOR', phone: null, notes: null, is_active: true, outstanding_sen: 0 },
  { id: 'd3', name: 'GONE DEBTOR', phone: null, notes: null, is_active: false, outstanding_sen: 0 },
] }, isLoading: false };
const ROLES = { data: { roles: { AR_OTHER: '305-0000' }, overridden: {} } };
const createBill = vi.fn();
const updateBill = vi.fn();
const cancelBill = vi.fn();
vi.mock('../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/accounting-queries')>()),
  useAccounts: () => ACCOUNTS,
  useAccountRoles: () => ROLES,
  useOtherDebtors: () => DEBTORS,
  useCreateDebtorBill: () => ({ mutate: createBill, isPending: false }),
  useUpdateDebtorBill: () => ({ mutate: updateBill, isPending: false }),
  useCancelDebtorBill: () => ({ mutate: cancelBill, isPending: false }),
}));
const EVENTS = { data: [], isLoading: false };
vi.mock('../../vendor/scm/lib/event-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/event-queries')>()),
  useEventOptions: () => EVENTS,
  useEventLabels: () => ({ data: new Map() }),
}));
const PERMS = { value: new Set<string>(['*']) };
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { scm_l2_configured: false },
    can: (p: string) => PERMS.value.has('*') || PERMS.value.has(p),
    pageAccess: () => (PERMS.value.has('*') ? 'full' : 'none'),
  }),
}));

const { ArInvoices } = await import('./ArInvoices');
const { ToastProvider } = await import('../../hooks/useToast');

function Where() { const l = useLocation(); return <output data-testid="where">{`${l.pathname}${l.search}`}</output>; }
const draw = (search = '') => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>
      <MemoryRouter initialEntries={[`/scm/ar-invoices${search}`]}>
        <Routes><Route path="*" element={<><ArInvoices /><Where /></>} /></Routes>
      </MemoryRouter>
    </ToastProvider>
  </QueryClientProvider>,
);
const row = (no: string) => screen.getByText(no, { selector: 'a' }).closest('tr') as HTMLElement;
const segment = (name: RegExp) => within(screen.getByRole('group', { name: 'Kind of invoice' })).getByRole('button', { name });
const chipBtn = (name: RegExp) => within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name });

beforeEach(() => {
  vi.clearAllMocks();
  posts.length = 0; arAsked.length = 0; refusePost = null;
  PERMS.value = new Set(['*']);
});

describe('one list: sales invoices, deposit invoices and debtor bills', () => {
  test('each kind in its segment with counts; the status in the design words; sand on what is still owed', () => {
    draw();
    expect(arAsked[0]).toBe('ALL|');
    expect(segment(/^All/).textContent).toBe('All6');
    expect(segment(/^Sales invoices/).textContent).toBe('Sales invoices1');
    expect(segment(/^Deposit invoices/).textContent).toBe('Deposit invoices3');
    expect(segment(/^Debtor bills/).textContent).toBe('Debtor bills2');
    /* The SI: overdue, its order linked, the order's deposit applied said under its outstanding. */
    const si = row('HC-SI-2609-001');
    expect(si.textContent).toContain('Sales invoice');
    expect(si.textContent).toMatch(/Overdue \d+d/);
    expect(within(si).getByText('HC-SO-2609-004').getAttribute('href')).toBe('/scm/sales-orders/HC-SO-2609-004');
    expect(si.textContent).toContain('deposit applied');
    /* What a customer's credit notes knocked off it (owner 2026-11-03), apart from what was paid. */
    expect(within(si).getByText('RM 300.00')).toBeTruthy();
    expect(within(si).getByText('RM 3,500.00')).toBeTruthy();
    expect(si.getAttribute('style') ?? '').toMatch(/#fcf7ec|252, 247, 236/);
    /* A bill part paid; a debit note paid, its own tag. */
    expect(row('HC-ODB-2609-001').textContent).toContain('Partly paid');
    expect(row('HC-ODN-2610-001').textContent).toContain('Debit note');
    expect(row('HC-ODN-2610-001').textContent).toContain('Paid');
    /* Deposit invoices: not posted, issued, closed — no outstanding of their own. */
    expect(row('HC-DI-2610-001').textContent).toContain('Not posted');
    expect(row('HC-DI-2610-002').textContent).toContain('Issued');
    expect(row('HC-DI-2610-003').textContent).toContain('Closed');
    expect(screen.getByText('HC-DI-2610-001', { selector: 'a' }).getAttribute('href')).toBe('/scm/ar-invoices/deposit/di-1');
    expect(screen.getByText('HC-ODB-2609-001', { selector: 'a' }).getAttribute('href')).toBe('/scm/ar-invoices/bills/b1');
    expect(screen.getByText('HC-SI-2609-001', { selector: 'a' }).getAttribute('href')).toBe('/scm/ar-invoices/sales/si-1');
  });

  test('the chips narrow every kind by its state, and the kind counts follow the chip', () => {
    draw();
    fireEvent.click(chipBtn(/^Not posted/));
    expect(screen.getByText('HC-DI-2610-001', { selector: 'a' })).toBeTruthy();
    expect(screen.queryByText('HC-DI-2610-002', { selector: 'a' })).toBeNull();
    expect(segment(/^All/).textContent).toBe('All1');
    fireEvent.click(chipBtn(/^Settled/));
    expect(screen.getByText('HC-DI-2610-003', { selector: 'a' })).toBeTruthy();
    expect(screen.getByText('HC-ODN-2610-001', { selector: 'a' })).toBeTruthy();
    expect(screen.queryByText('HC-SI-2609-001', { selector: 'a' })).toBeNull();
  });

  test("the old Deposit invoices page's address opens its kind, and its `so` seeds the search", () => {
    draw('?kind=deposit&so=HC-SO-2610-012');
    expect(screen.getByText('HC-DI-2610-002', { selector: 'a' })).toBeTruthy();
    expect(screen.queryByText('HC-DI-2610-001', { selector: 'a' })).toBeNull();
    expect(screen.queryByText('HC-SI-2609-001', { selector: 'a' })).toBeNull();
  });

  test('the party filter names a debtor with its account code, as it does a customer', () => {
    /* A debtor with no bill on the list yet: only the registry names them. */
    DEBTORS.data.debtors.push({ id: 'd4', name: 'FRESH DEBTOR', code: '305-F001', phone: null, notes: null, is_active: true, outstanding_sen: 0 });
    try {
      draw('?debtor=d4');
      expect((screen.getByRole('combobox', { name: 'Filter by customer or debtor' }) as HTMLInputElement).value).toBe('305-F001 · FRESH DEBTOR');
    } finally {
      DEBTORS.data.debtors.pop();
    }
  });

  test('?debtor= opens on that debtor alone', () => {
    draw('?debtor=d1');
    expect(screen.getByText('HC-ODB-2609-001', { selector: 'a' })).toBeTruthy();
    expect(screen.queryByText('HC-SI-2609-001', { selector: 'a' })).toBeNull();
    expect(screen.queryByText('HC-ODN-2610-001', { selector: 'a' })).toBeNull();
  });

  test('deposit invoices show only to whoever saw their old entry', () => {
    PERMS.value = new Set(['scm.payment_voucher.create']);
    draw();
    expect(within(screen.getByRole('group', { name: 'Kind of invoice' })).queryByRole('button', { name: /^Deposit invoices/ })).toBeNull();
    expect(screen.queryByText('HC-DI-2610-001', { selector: 'a' })).toBeNull();
    expect(screen.queryByText(/still without a deposit invoice/)).toBeNull();
  });
});

describe('the backlogs and the steps', () => {
  test("the switch's backlogs sit at the head: Issue them now; Invoice them now waits for the deposit invoices", async () => {
    draw();
    expect(screen.getByText('2 payments dated from 2026/09/15 still without a deposit invoice.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Issue them now/ }));
    expect(issueMutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/3 delivered orders still without a final invoice/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Invoice them now' }));
    expect(deliveredMutate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('Issue the deposit invoices first')).toBeTruthy());
  });

  test('Post to ledger on an unposted deposit invoice: its own route; the batch posts the ticked one by one', async () => {
    draw();
    fireEvent.click(within(row('HC-DI-2610-001')).getByRole('button', { name: 'Post to ledger' }));
    await waitFor(() => expect(posts).toEqual(['di-1']));
    await waitFor(() => expect(screen.getByText('HC-DI-2610-001 posted · HC-JE-2610-091')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Tick HC-DI-2610-001'));
    fireEvent.click(screen.getByLabelText('Tick HC-SI-2609-001'));
    const bar = screen.getByRole('region', { name: 'Ticked' });
    expect(bar.textContent).toContain('2 ticked');
    expect(bar.textContent).toContain('RM 5,400.00');
    refusePost = 'di-1';
    fireEvent.click(within(bar).getByRole('button', { name: 'Post to ledger · 1' }));
    await waitFor(() => expect(screen.getByText('The deposit account is not set for this company.')).toBeTruthy());
    fireEvent.click(within(bar).getByRole('button', { name: /Print 2/ }));
    const preview = screen.getByRole('dialog', { name: 'Print preview' });
    expect(preview.textContent).toContain('A4 portrait · same letterhead as the payment voucher · one per page');
    fireEvent.click(within(preview).getByText('Print now'));
    await waitFor(() => expect(diPdf).toHaveBeenCalledTimes(1));
    expect(arBlob.mock.calls[0]![0]).toEqual([expect.objectContaining({ id: 'si-1' })]);
  });

  test('Cancel a deposit invoice asks inline for the reason, then sends it', () => {
    draw();
    fireEvent.click(within(row('HC-DI-2610-002')).getByRole('button', { name: 'HC-DI-2610-002 menu' }));
    const menu = screen.getByRole('menu', { name: 'HC-DI-2610-002 menu' });
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Open', 'Open HC-SO-2610-012', 'Print', 'Cancel…']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Cancel…' }));
    const ask = screen.getByRole('region', { name: 'Cancel HC-DI-2610-002?' });
    expect(ask.textContent).toContain('Its journal HC-JE-2610-0100 is reversed by a contra dated today. It stays on file as cancelled and prints as void with your reason.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel invoice' }));
    expect(cancelDiMutate).not.toHaveBeenCalled();
    fireEvent.change(within(ask).getByPlaceholderText('Why? e.g. payment keyed twice'), { target: { value: 'payment keyed twice' } });
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel invoice' }));
    expect(cancelDiMutate.mock.calls[0]![0]).toEqual({ id: 'di-2', reason: 'payment keyed twice' });
  });

  test("a bill's menu: Edit, Copy as new, Print; no Cancel once money came in", () => {
    draw();
    fireEvent.click(within(row('HC-ODB-2609-001')).getByRole('button', { name: 'HC-ODB-2609-001 menu' }));
    expect(within(screen.getByRole('menu', { name: 'HC-ODB-2609-001 menu' })).getAllByRole('menuitem').map((b) => b.textContent))
      .toEqual(['Open', 'Edit', 'Copy as new', 'Print']);
  });

  test('Print listing prints exactly the sales invoices and bills on screen', async () => {
    draw('?kind=bill');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Print listing' }));
    await waitFor(() => expect(listingPdf).toHaveBeenCalledTimes(1));
    expect((listingPdf.mock.calls[0]![0] as Array<{ id: string }>).map((r) => r.id).sort()).toEqual(['b1', 'b3']);
    expect(listingPdf.mock.calls[0]![1]).toEqual({ kind: 'ODB', partyName: null });
  });
});

describe('the bill form, in place of the list', () => {
  test('New debtor bill picks the debtor, a line on its account, and posts through its route', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: /New debtor bill/ }));
    expect(screen.getByRole('heading', { name: 'New debtor bill' })).toBeTruthy();
    expect(screen.getByText('Back to Invoices')).toBeTruthy();
    expect(screen.getByText('Pick the debtor.')).toBeTruthy();
    const debtor = screen.getByLabelText('Bill debtor') as HTMLSelectElement;
    expect([...debtor.options].map((o) => o.textContent)).toEqual(['— Pick the debtor —', 'AHMAD BIN ALI', 'OLD DEBTOR']);
    fireEvent.change(debtor, { target: { value: 'd1' } });
    fireEvent.change(screen.getByLabelText('Bill description'), { target: { value: 'Booth rental' } });
    fireEvent.focus(screen.getByPlaceholderText('— Pick an account —'));
    fireEvent.mouseDown(screen.getByText('700-0000 · Other Income'));
    const amount = screen.getByLabelText('line 1 amount');
    fireEvent.focus(amount);
    fireEvent.change(amount, { target: { value: '450' } });
    fireEvent.blur(amount);
    expect(screen.getByText(/Books: Dr 305-0000 Other Debtors \(AHMAD BIN ALI\) · Cr 700-0000 Other Income · RM 450\.00 · posts now/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save & post' }));
    expect(createBill.mock.calls[0]![0]).toMatchObject({
      debtorId: 'd1', notes: 'Booth rental', billDate: TODAY,
      lines: [{ creditAccountCode: '700-0000', amountSen: 45_000 }],
    });
  });

  test('Edit keeps the debtor, says it re-posts, and refuses a total below the money received', () => {
    draw('?form=edit&id=b1');
    expect(screen.getByRole('heading', { name: 'Edit HC-ODB-2609-001' })).toBeTruthy();
    expect(screen.getByText('Saving re-posts the bill: the old journal gets a contra and a fresh one books what you save.')).toBeTruthy();
    expect((screen.getByLabelText('Bill debtor') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText('This bill has money received on it, so the debtor can’t change.')).toBeTruthy();
    const amount = screen.getByLabelText('line 1 amount');
    fireEvent.focus(amount);
    fireEvent.change(amount, { target: { value: '100' } });
    fireEvent.blur(amount);
    expect(screen.getByText('RM 200.00 has been received on this bill, so the total can’t go below it.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save & re-post' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.focus(amount);
    fireEvent.change(amount, { target: { value: '650' } });
    fireEvent.blur(amount);
    fireEvent.click(screen.getByRole('button', { name: 'Save & re-post' }));
    expect(updateBill.mock.calls[0]![0]).toMatchObject({ billId: 'b1', body: { billDate: '2026-09-05', notes: '转租九月', lines: [{ description: '转租', creditAccountCode: '700-0000', amountSen: 65_000 }] } });
  });
});
