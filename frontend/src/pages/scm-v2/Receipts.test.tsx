/* Receipts — every ringgit in, one page (owner 2026-09-03; the owner's Claude
   Design, batch 5 step 4): the official receipts folded in from their own page
   beside sundry income, other debtors' receipts and the customer payments
   mirror; kind segments with counts, status chips per kind, the month nav
   (this month first), the month's check of payments against receipts, the
   row's next step, batch Confirm money in payment-date order, Void asked
   inline, and the receipt form in place of the list. The server halves are
   backend/tests/receipts.test.ts and backend/tests/receiptsCheck.test.ts. */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const NOW = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);

/* ── What the server answers ────────────────────────────────────────────── */
const official = (over: Record<string, unknown>) => ({
  id: 5, or_number: 'HCDraftOR-2611-002', status: 'DRAFT', payment_source: 'SOPAY', payment_id: 'p2', doc_no: 'HC-SO-013400',
  customer_name: 'TAN MEI LING', method: 'transfer', amount_sen: 150_000, paid_at: `${NOW}-04`, channel_account_code: null,
  issued_at: null, issued_by: null, created_at: `${NOW}-04`, cancelled_at: null, cancelled_by: null, cancel_reason: null, ...over,
});
const OFFICIAL_ROWS = [
  official({}),
  official({ id: 6, or_number: 'HCDraftOR-2611-001', payment_id: 'p1', doc_no: 'HC-SO-013402', paid_at: `${NOW}-02`, amount_sen: 20_000, customer_name: 'EARLY BIRD' }),
  official({ id: 4, or_number: 'HCCOR-2611-001', status: 'FORMAL', method: 'cash', payment_id: 'p0', doc_no: 'HC-SO-013399', amount_sen: 50_000, paid_at: `${NOW}-03`, issued_at: `${NOW}-03`, issued_by: 'Chew', customer_name: 'AHMAD' }),
  official({ id: 3, or_number: 'HCHOR-2611-007', status: 'CANCELLED', method: 'merchant', payment_id: 'p9', doc_no: 'HC-SO-013398', amount_sen: 111_500, paid_at: `${NOW}-01`, cancel_reason: 'Payment on HC-SO-013398 deleted', customer_name: 'LIM' }),
];
const CHECK = {
  month: NOW, payments: { count: 4, totalSen: 270_000 }, receipts: { count: 3, totalSen: 220_000 }, diffSen: 50_000,
  missing: [{ source: 'SOPAY', paymentId: 'p7', docNo: 'HC-SO-013401', paidAt: `${NOW}-07`, method: 'transfer', amountSen: 50_000 }],
  mismatched: [{ orNumber: 'HCCOR-2611-001', source: 'SOPAY', paymentId: 'p0', docNo: 'HC-SO-013399', paidAt: `${NOW}-03`, receiptSen: 50_000, paymentSen: 55_000 }],
  orphans: [],
};
const calls: string[] = [];
let failFormaliseOn: string | null = null;
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({
  authedFetch: vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    calls.push(`${init?.method ?? 'GET'} ${path}${init?.body && init.body !== '{}' ? ` ${init.body}` : ''}`);
    if (path.startsWith('/accounting/journal-entries')) {
      const q = new URLSearchParams(path.split('?')[1] ?? '');
      return { journalEntries: q.get('sourceType') === 'RCT' && q.get('sourceDocNo') === 'HC-RCT-2611-001'
        ? [{ id: 'je1', je_no: 'HC-JE-2611-0042', entry_date: `${NOW}-05`, source_type: 'RCT', reversed: false, created_at: `${NOW}-05T02:00:00Z`, lines: [] }]
        : [] };
    }
    if (path.startsWith('/accounting/receipts/check')) return CHECK;
    const formal = /^\/accounting\/receipts\/(\d+)\/formalise$/.exec(path);
    if (formal) {
      if (failFormaliseOn === formal[1]) throw new Error('HC has no series letter yet — set one on the Voucher numbering card (Reconciliation setup), then confirm again.');
      return { ok: true, orNumber: `HCTOR-2611-00${formal[1]}` };
    }
    if (path === '/accounting/receipts/ensure') return { receipt: official({ id: 11, or_number: 'HCDraftOR-2611-009', payment_id: 'p7', doc_no: 'HC-SO-013401' }) };
    if (path === '/other-debtors/receipts/dr1') return DR1_DETAIL;
    if (path.startsWith('/accounting/receipts')) return { receipts: OFFICIAL_ROWS };
    throw new Error(`unexpected read ${path}`);
  }),
}));

const RECEIPTS = { month: NOW, receipts: [
  { kind: 'GENERAL', id: 'g1', number: 'HC-RCT-2611-001', date: `${NOW}-05`, payer: 'ALLIANZ INSURANCE', moneyAccount: '310-0010', totalSen: 88_800, status: 'POSTED', firstLine: '车险赔偿' },
  { kind: 'DEBTOR', id: 'dr1', number: 'HC-ODR-2611-001', date: `${NOW}-06`, payer: 'AHMAD BIN ALI', moneyAccount: '310-0010', totalSen: 20_000, status: 'DRAFT', debtorId: 'd1',
    submittedAt: null, checkedAt: null, approvedAt: null, bills: [{ billId: 'b1', no: 'HC-ODB-2611-001', amountSen: 20_000 }] },
  { kind: 'DEBTOR', id: 'dr2', number: 'HC-ODR-2611-002', date: `${NOW}-06`, payer: 'AHMAD BIN ALI', moneyAccount: '310-0010', totalSen: 30_000, status: 'DRAFT', debtorId: 'd1',
    submittedAt: 'x', checkedAt: 'y', approvedAt: null, bills: [{ billId: 'b1', no: 'HC-ODB-2611-001', amountSen: 30_000 }] },
  { kind: 'CUSTOMER', id: 'p1', number: 'HC-SO-013400', date: `${NOW}-04`, payer: 'Customer deposit', moneyAccount: 'transfer', totalSen: 150_000, status: 'RECEIVED' },
] };
/* The draft's own read, for Edit (GET /other-debtors/receipts/:id). */
const DR1_DETAIL = {
  receipt: { id: 'dr1', receipt_number: 'HC-ODR-2611-001', debtor_id: 'd1', receipt_date: `${NOW}-06`, bank_account_code: '310-0010', total_sen: 20_000, status: 'DRAFT',
    submitted_at: null, submitted_by: null, checked_at: null, checked_by: null, approved_at: null, approved_by: null, posted_at: null, notes: null },
  debtor: { id: 'd1', name: 'AHMAD BIN ALI', phone: null, notes: null, is_active: true, outstanding_sen: 30_000 },
  allocations: [{ billId: 'b1', amountSen: 20_000, billNumber: 'HC-ODB-2611-001', billDate: `${NOW}-01`, description: 'Booth rental', totalSen: 50_000, receivedSen: 20_000, status: 'POSTED', docKind: 'INV' }],
};
const receiptsAsked: Array<string | undefined> = [];
const updateDebtorReceipt = vi.fn();
const createReceipt = vi.fn();
const updateReceipt = vi.fn();
const voidReceipt = vi.fn();
const createDebtorReceipt = vi.fn();
const stepMutate = vi.fn();
const DETAIL_G1 = {
  receipt: { id: 'g1', receipt_number: 'HC-RCT-2611-001', payer_name: 'ALLIANZ INSURANCE', receipt_date: `${NOW}-05`, bank_account_code: '310-0010', total_sen: 88_800, status: 'POSTED', notes: null },
  lines: [{ id: 'l1', line_no: 1, description: '车险赔偿', credit_account_code: '700-0000', amount_sen: 88_800 }],
};
const DEBTOR_D1 = {
  debtor: { id: 'd1', name: 'AHMAD BIN ALI', phone: null, notes: null, is_active: true, outstanding_sen: 30_000 },
  bills: [
    { id: 'b1', bill_number: 'HC-ODB-2611-001', bill_date: `${NOW}-01`, total_sen: 50_000, received_sen: 20_000, status: 'POSTED', notes: 'Booth rental' },
    { id: 'b0', bill_number: 'HC-ODB-2610-009', bill_date: '2026-10-20', total_sen: 10_000, received_sen: 10_000, status: 'POSTED', notes: null },
  ],
  receipts: [],
};
/* ONE stable object per read, as react-query hands back — a fresh literal per
   render would re-derive the rows and re-report them forever. */
const ACCOUNTS = { data: { accounts: [
  { account_code: '310-0010', account_name: 'MAYBANK', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true },
  { account_code: '700-0000', account_name: 'Other Income', account_type: 'INCOME', parent_code: null, is_active: true, acc_money: false },
  { account_code: '305-0000', account_name: 'Other Debtors', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false },
] }, isLoading: false };
const ROLES = { data: { roles: { AR_OTHER: '305-0000' }, overridden: {} } };
const DEBTORS = { data: { debtors: [
  { id: 'd1', name: 'AHMAD BIN ALI', phone: null, notes: null, is_active: true, outstanding_sen: 30_000 },
  { id: 'd2', name: 'OLD DEBTOR', phone: null, notes: null, is_active: false, outstanding_sen: 0 },
] }, isLoading: false };
const LIST = { data: RECEIPTS, isLoading: false, isError: false };
vi.mock('../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/accounting-queries')>()),
  useAccounts: () => ACCOUNTS,
  useAccountRoles: () => ROLES,
  useReceipts: (month?: string) => { receiptsAsked.push(month); return LIST; },
  useReceiptDetail: (id: string | null) => ({ data: id === 'g1' ? DETAIL_G1 : undefined, isLoading: false, isError: false }),
  useCreateReceipt: () => ({ mutate: createReceipt, isPending: false }),
  useUpdateReceipt: () => ({ mutate: updateReceipt, isPending: false }),
  useVoidReceipt: () => ({ mutate: voidReceipt, isPending: false }),
  useOtherDebtors: () => DEBTORS,
  useDebtorDetail: (id: string | null) => ({ data: id === 'd1' ? DEBTOR_D1 : undefined, isLoading: false, isError: false }),
  useCreateDebtorReceipt: () => ({ mutate: createDebtorReceipt, isPending: false }),
  useUpdateDebtorReceipt: () => ({ mutate: updateDebtorReceipt, isPending: false }),
  useDebtorReceiptAction: () => ({ mutate: stepMutate, isPending: false }),
  useVoidDebtorReceipt: () => ({ mutate: vi.fn(), isPending: false }),
}));
const pdfMock = vi.fn(async (_list: unknown, _opts: unknown) => {});
vi.mock('../../vendor/scm/lib/receipt-pdf', () => ({ generateReceiptsPdf: (l: unknown, o: unknown) => pdfMock(l, o) }));

/* Who is looking: by default everything; a test narrows it. */
const PERMS = { value: new Set<string>(['*']) };
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { scm_l2_configured: false },
    can: (p: string) => PERMS.value.has('*') || PERMS.value.has(p),
    pageAccess: () => (PERMS.value.has('*') ? 'full' : 'none'),
  }),
}));

const { Receipts } = await import('./Receipts');
const { ToastProvider } = await import('../../hooks/useToast');

function Where() { const l = useLocation(); return <output data-testid="where">{`${l.pathname}${l.search}`}</output>; }
const draw = (search = '') => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>
      <MemoryRouter initialEntries={[`/scm/receipts${search}`]}>
        <Routes><Route path="*" element={<><Receipts /><Where /></>} /></Routes>
      </MemoryRouter>
    </ToastProvider>
  </QueryClientProvider>,
);
const row = (no: string) => screen.getByText(no, { selector: 'a' }).closest('tr') as HTMLElement;
const segment = (name: RegExp) => within(screen.getByRole('group', { name: 'Kind of receipt' })).getByRole('button', { name });

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0; receiptsAsked.length = 0; failFormaliseOn = null;
  PERMS.value = new Set(['*']);
});

describe('one list: the official receipts beside the money-in list', () => {
  test('opens on this month: every kind in its segment with counts, the customer payments apart and not in All', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('HCDraftOR-2611-002', { selector: 'a' })).toBeTruthy());
    expect(receiptsAsked[0]).toBe(NOW);
    expect(calls).toContain(`GET /accounting/receipts?month=${NOW}`);
    /* 4 official + 1 sundry + 2 debtor in All; the customer payment only in its own segment. */
    expect(segment(/^All/).textContent).toBe('All7');
    expect(segment(/^Official receipts/).textContent).toBe('Official receipts4');
    expect(segment(/^Sundry income/).textContent).toBe('Sundry income1');
    expect(segment(/^Other debtor/).textContent).toBe('Other debtor2');
    expect(segment(/^Customer payments/).textContent).toBe('Customer payments1');
    expect(screen.queryByText('HC-SO-013400', { selector: 'a' })?.closest('tr')?.textContent ?? '').not.toContain('Customer deposit');
    /* Each kind says what it was for and how it came. */
    expect(within(row('HC-RCT-2611-001')).getByText('车险赔偿')).toBeTruthy();
    expect(within(row('HC-RCT-2611-001')).getByText('MAYBANK')).toBeTruthy();
    expect(within(row('HC-ODR-2611-001')).getByText('HC-ODB-2611-001').getAttribute('href')).toBe('/scm/ar-invoices/bills/b1');
    expect(within(row('HCDraftOR-2611-002')).getByText('HC-SO-013400').getAttribute('href')).toBe('/scm/sales-orders/HC-SO-013400');
    expect(row('HCDraftOR-2611-002').textContent).toContain('Bank transfer / DuitNow');
    /* Numbers open their own pages. */
    expect(screen.getByText('HCDraftOR-2611-002', { selector: 'a' }).getAttribute('href')).toBe('/scm/receipts/official/5');
    expect(screen.getByText('HC-RCT-2611-001', { selector: 'a' }).getAttribute('href')).toBe('/scm/receipts/sundry/g1');
    expect(screen.getByText('HC-ODR-2611-001', { selector: 'a' }).getAttribute('href')).toBe('/scm/receipts/debtor/dr1');
    /* A cancelled receipt: struck, its amount a dash, its reason under its tag, not counted. */
    const cancelled = row('HCHOR-2611-007');
    expect(screen.getByText('HCHOR-2611-007', { selector: 'a' }).className).toContain('dt-cancel-strike');
    expect(cancelled.textContent).toContain('Payment on HC-SO-013398 deleted');
    expect(screen.getByText('1 cancelled, not counted')).toBeTruthy();
    fireEvent.click(segment(/^Customer payments/));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toContain('kind=customer'));
    expect(row('HC-SO-013400').textContent).toContain('Customer deposit');
  });

  test("the month's check: payments minus receipts, the difference, each row behind it with its step", async () => {
    draw();
    const card = await screen.findByRole('region', { name: 'Receipts check' });
    await waitFor(() => expect(card.textContent).toContain('Customer payments · 4'));
    expect(card.textContent).toContain('RM 2,700.00');
    expect(card.textContent).toContain('Official receipts · 3');
    expect(card.textContent).toContain('Difference');
    expect(card.textContent).toContain('2 to fix');
    expect(card.textContent).toContain('Payments without a receipt (1)');
    expect(card.textContent).toContain('HC-SO-013401 · Bank transfer / DuitNow · RM 500.00');
    expect(card.textContent).toContain('Receipts whose amount is not the payment’s (1)');
    expect(card.textContent).toContain('HCCOR-2611-001 · HC-SO-013399 · receipt RM 500.00 · payment RM 550.00');
    fireEvent.click(within(card).getByRole('button', { name: 'Issue receipt ›' }));
    await waitFor(() => expect(calls).toContain('POST /accounting/receipts/ensure {"source":"SOPAY","paymentId":"p7"}'));
    await waitFor(() => expect(screen.getByText('HCDraftOR-2611-009 issued for HC-SO-013401 · RM 500.00')).toBeTruthy());
  });

  test('Any month reads the whole book; the URL keeps kind, status and month (To do opens the drafts of every month)', async () => {
    draw('?kind=official&status=draft&month=all');
    await waitFor(() => expect(screen.getByText('HCDraftOR-2611-002', { selector: 'a' })).toBeTruthy());
    expect(calls).toContain('GET /accounting/receipts?all=1');
    expect(receiptsAsked.at(-1)).toBeUndefined();
    expect(screen.queryByRole('region', { name: 'Receipts check' })).toBeNull();
    expect(screen.queryByText('HCCOR-2611-001', { selector: 'a' })).toBeNull();
    expect(screen.queryByText('HC-RCT-2611-001', { selector: 'a' })).toBeNull();
    const chips = screen.getByRole('group', { name: 'Status' });
    expect(within(chips).getByRole('button', { name: /^Draft · money not confirmed/ }).getAttribute('aria-pressed')).toBe('true');
    expect(within(chips).getByRole('button', { name: /^Cancelled/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'This month' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toContain(`month=${NOW}`));
  });

  test("each kind shows only to whoever saw its old entry: the voucher's create key alone sees no official receipts", async () => {
    PERMS.value = new Set(['scm.payment_voucher.create']);
    draw();
    await waitFor(() => expect(screen.getByText('HC-RCT-2611-001', { selector: 'a' })).toBeTruthy());
    expect(within(screen.getByRole('group', { name: 'Kind of receipt' })).queryByRole('button', { name: /^Official receipts/ })).toBeNull();
    expect(screen.queryByText('HCDraftOR-2611-002', { selector: 'a' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Receipts check' })).toBeNull();
    expect(calls.some((c) => c.startsWith('GET /accounting/receipts'))).toBe(false);
  });
});

describe('the steps', () => {
  test('Confirm money on a draft: the formalise door, the toast names the new number', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('HCDraftOR-2611-002', { selector: 'a' })).toBeTruthy());
    expect(within(row('HCCOR-2611-001')).queryByRole('button', { name: 'Confirm money' })).toBeNull();
    fireEvent.click(within(row('HCDraftOR-2611-002')).getByRole('button', { name: 'Confirm money' }));
    await waitFor(() => expect(calls).toContain('POST /accounting/receipts/5/formalise'));
    await waitFor(() => expect(screen.getByText('HCDraftOR-2611-002 is formal · HCTOR-2611-005')).toBeTruthy());
  });

  test('the batch confirms the ticked drafts in payment-date order and stops at the first refusal, verbatim', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('HCDraftOR-2611-002', { selector: 'a' })).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Tick HCDraftOR-2611-002'));
    fireEvent.click(screen.getByLabelText('Tick HCDraftOR-2611-001'));
    fireEvent.click(screen.getByLabelText('Tick HCCOR-2611-001'));
    const bar = screen.getByRole('region', { name: 'Ticked' });
    expect(bar.textContent).toContain('3 ticked');
    expect(bar.textContent).toContain('RM 2,200.00');
    expect(bar.textContent).toContain('Confirming turns each draft formal and gives it its official number, in payment-date order.');
    fireEvent.click(within(bar).getByRole('button', { name: /Print 3/ }));
    await waitFor(() => expect(pdfMock).toHaveBeenCalledTimes(1));
    failFormaliseOn = '5';
    fireEvent.click(within(bar).getByRole('button', { name: 'Confirm money · 2' }));
    /* The 2nd paid first, so it is numbered first; the 4th refused stops the run. */
    await waitFor(() => expect(calls.filter((c) => c.endsWith('/formalise'))).toEqual(['POST /accounting/receipts/6/formalise', 'POST /accounting/receipts/5/formalise']));
    await waitFor(() => expect(screen.getByText(/has no series letter yet/)).toBeTruthy());
    expect(screen.getByText('HCDraftOR-2611-001 is formal · HCTOR-2611-006')).toBeTruthy();
  });

  test('Void a sundry receipt is asked inline with its journal, then reverses through its route', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('HC-RCT-2611-001', { selector: 'a' })).toBeTruthy());
    fireEvent.click(within(row('HC-RCT-2611-001')).getByRole('button', { name: 'HC-RCT-2611-001 menu' }));
    const menu = screen.getByRole('menu', { name: 'HC-RCT-2611-001 menu' });
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Open', 'Edit', 'Copy as new', 'Void…']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Void…' }));
    const ask = screen.getByRole('region', { name: 'Void HC-RCT-2611-001?' });
    await waitFor(() => expect(ask.textContent).toContain('Its journal HC-JE-2611-0042 is reversed by a contra dated today. The receipt stays on file as voided.'));
    fireEvent.click(within(ask).getByRole('button', { name: 'Void receipt' }));
    expect(voidReceipt.mock.calls[0]![0]).toBe('g1');
  });

  test("an other debtor's receipt shows its stage and offers the next one: Prepare a draft; a checked one waits for whoever approves", async () => {
    PERMS.value = new Set(['scm.access', 'scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.check']);
    draw();
    await waitFor(() => expect(screen.getByText('HC-ODR-2611-001', { selector: 'a' })).toBeTruthy());
    expect(row('HC-ODR-2611-001').textContent).toContain('Draft');
    expect(row('HC-ODR-2611-002').textContent).toContain('Checked');
    expect(within(row('HC-ODR-2611-002')).getByText('Waiting for approval')).toBeTruthy();
    fireEvent.click(within(row('HC-ODR-2611-001')).getByRole('button', { name: 'Prepare' }));
    expect(stepMutate.mock.calls[0]![0]).toEqual({ receiptId: 'dr1', action: 'submit' });
    fireEvent.click(within(row('HC-ODR-2611-002')).getByRole('button', { name: 'HC-ODR-2611-002 menu' }));
    expect(within(screen.getByRole('menu', { name: 'HC-ODR-2611-002 menu' })).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Open', 'Reject…']);
  });

  /* Batch 5 step 6 (c5): a Draft or a Prepared one changes in place — Debtor
     maintenance's form, which keeps the stage and posts nothing. */
  test("an other debtor's Draft changes in place from its ⋯ — Edit keeps its stage; a checked one has no Edit", async () => {
    draw('?kind=debtor');
    await waitFor(() => expect(screen.getByText('HC-ODR-2611-001', { selector: 'a' })).toBeTruthy());
    fireEvent.click(within(row('HC-ODR-2611-001')).getByRole('button', { name: 'HC-ODR-2611-001 menu' }));
    const menu = screen.getByRole('menu', { name: 'HC-ODR-2611-001 menu' });
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Open', 'Edit', 'Prepare']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Edit' }));
    expect(screen.getByTestId('where').textContent).toContain('form=edit&id=dr1&type=debtor');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Edit HC-ODR-2611-001' })).toBeTruthy());
    expect(screen.getByText('Back to Receipts')).toBeTruthy();
    expect(screen.getByText('Saving keeps it a Draft — nothing posts until it is approved.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(updateDebtorReceipt.mock.calls[0]![0]).toEqual({
      receiptId: 'dr1', receiptDate: `${NOW}-06`, bankAccountCode: '310-0010', allocations: [{ billId: 'b1', amountSen: 20_000 }],
    });
  });

  test('the approver approves a checked receipt after an inline ask naming the money and the bills', async () => {
    draw('?kind=debtor&status=checked');
    await waitFor(() => expect(screen.getByText('HC-ODR-2611-002', { selector: 'a' })).toBeTruthy());
    expect(screen.queryByText('HC-ODR-2611-001', { selector: 'a' })).toBeNull();
    fireEvent.click(within(row('HC-ODR-2611-002')).getByRole('button', { name: 'Approve & post' }));
    const ask = screen.getByRole('region', { name: 'Approve HC-ODR-2611-002?' });
    expect(ask.textContent).toContain('RM 300.00 books into MAYBANK (310-0010) and HC-ODB-2611-001 is knocked off.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Approve & post' }));
    expect(stepMutate.mock.calls[0]![0]).toEqual({ receiptId: 'dr2', action: 'approve' });
  });
});

describe('the receipt form, in place of the list', () => {
  test('New receipt › Sundry income posts the typed payer, the money account and each line', async () => {
    draw();
    fireEvent.click(await screen.findByRole('button', { name: 'New receipt' }));
    expect(screen.getByRole('heading', { name: 'New receipt' })).toBeTruthy();
    expect(screen.getByText('Back to Receipts')).toBeTruthy();
    expect(screen.getByText('Type who paid.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Received from'), { target: { value: 'ALLIANZ INSURANCE' } });
    const combos = screen.getAllByRole('combobox');
    fireEvent.focus(combos[0]!);
    fireEvent.mouseDown(screen.getByText('310-0010 · MAYBANK'));
    fireEvent.focus(screen.getAllByRole('combobox')[1]!);
    fireEvent.mouseDown(screen.getByText('700-0000 · Other Income'));
    fireEvent.change(screen.getByLabelText('line 1 description'), { target: { value: '车险赔偿' } });
    const amount = screen.getByLabelText('line 1 amount') as HTMLInputElement;
    fireEvent.focus(amount);
    fireEvent.change(amount, { target: { value: '888' } });
    fireEvent.blur(amount);
    expect(screen.getByText(/Books: Dr 310-0010 MAYBANK · Cr 700-0000 Other Income · RM 888\.00 · posts now/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save & post' }));
    expect(createReceipt.mock.calls[0]![0]).toMatchObject({
      payerName: 'ALLIANZ INSURANCE', bankAccountCode: '310-0010',
      lines: [{ description: '车险赔偿', creditAccountCode: '700-0000', amountSen: 88_800 }],
    });
  });

  test("New receipt › Other debtor lists what the debtor still owes and posts at once, knocking the bills off", async () => {
    draw('?form=new&type=sundry');
    fireEvent.click(within(screen.getByRole('group', { name: 'Kind of receipt' })).getByRole('button', { name: 'Other debtor' }));
    expect(screen.getByRole('heading', { name: 'New receipt · Other debtor' })).toBeTruthy();
    expect(screen.getByText('Pick the debtor to list what they still owe.')).toBeTruthy();
    const debtor = screen.getByLabelText('Debtor') as HTMLSelectElement;
    expect([...debtor.options].map((o) => o.textContent)).toEqual(['— Pick the debtor —', 'AHMAD BIN ALI · owes RM 300.00']);
    fireEvent.change(debtor, { target: { value: 'd1' } });
    expect(screen.getByText('What AHMAD BIN ALI still owes')).toBeTruthy();
    expect(screen.queryByText('HC-ODB-2610-009')).toBeNull();
    fireEvent.click(screen.getByLabelText('Collect HC-ODB-2611-001 in full'));
    fireEvent.focus(screen.getByLabelText('Received into'));
    fireEvent.mouseDown(screen.getByText('310-0010 · MAYBANK'));
    expect(screen.getByText(/Books: Dr 310-0010 MAYBANK · Cr 305-0000 Other Debtors \(AHMAD BIN ALI\) · RM 300\.00 · posts now and knocks the bills off/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save & post' }));
    expect(createDebtorReceipt.mock.calls[0]![0]).toMatchObject({
      debtorId: 'd1', bankAccountCode: '310-0010', postNow: true, allocations: [{ billId: 'b1', amountSen: 30_000 }],
    });
  });

  test('Edit opens the posted receipt in the form, says it re-posts, and saves through its route', async () => {
    draw('?form=edit&id=g1');
    expect(screen.getByRole('heading', { name: 'Edit HC-RCT-2611-001' })).toBeTruthy();
    expect(screen.getByText('Saving changes re-posts it: the old journal gets a contra and a fresh one books what you save.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Received from'), { target: { value: 'ALLIANZ GENERAL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & re-post' }));
    expect(updateReceipt.mock.calls[0]![0]).toEqual({
      id: 'g1', receiptDate: `${NOW}-05`, payerName: 'ALLIANZ GENERAL', bankAccountCode: '310-0010',
      lines: [{ description: '车险赔偿', creditAccountCode: '700-0000', amountSen: 88_800 }],
    });
  });
});
