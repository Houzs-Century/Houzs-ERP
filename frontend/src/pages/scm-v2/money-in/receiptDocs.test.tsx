// Money in's receipts as pages (the owner's Claude Design, batch 5 step 3): an
// official receipt (Confirm money, the receipt that replaced it, what its
// payment says now, the payment's journal as its books) and an other debtor's
// receipt walking the payment voucher's four layers (Prepare, Check, Withdraw,
// Reject with a reason, Approve & post, Void), plus the bill page's receipts
// and credit notes. The reads are pinned in backend/tests/moneyInDocReads.test.ts.

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/* ── What the server answers ────────────────────────────────────────────── */
const OFFICIAL: Record<string, unknown> = {
  7: {
    receipt: { id: 7, or_number: '2990-DraftOR-2610-031', status: 'DRAFT', payment_source: 'SOPAY', payment_id: 'p-1', doc_no: '2990-SO-2610-011', customer_name: 'Larding Chen', method: 'transfer', amount_sen: 111_500, paid_at: '2026-10-13', channel_account_code: null, issued_at: null, issued_by: null, created_at: '2026-10-13T03:00:00Z', created_by: 'Ivy', cancelled_at: null, cancelled_by: null, cancel_reason: null, replaced_by_id: null },
    replacedBy: null, replaces: null,
    paymentJournal: { id: 'je-b', jeNo: '2990-JE-2610-0140', reversed: false },
    payment: { amountSen: 55_800, paidAt: '2026-10-13', method: 'transfer', soDocNo: '2990-SO-2610-011', salesInvoiceId: null },
    salesOrder: '2990-SO-2610-011', salesInvoice: null, salesperson: 'Mei Ling',
  },
  5: {
    receipt: { id: 5, or_number: '2990-HOR-2610-004', status: 'CANCELLED', payment_source: 'SOPAY', payment_id: 'p-2', doc_no: '2990-SO-2610-012', customer_name: 'Ong', method: 'transfer', amount_sen: 9_000, paid_at: '2026-10-10', channel_account_code: '310-0001', issued_at: '2026-10-10T08:00:00Z', issued_by: 'Chew', created_at: '2026-10-10T03:00:00Z', created_by: 'Ivy', cancelled_at: '2026-10-14T02:00:00Z', cancelled_by: 'Ivy', cancel_reason: 'Payment on 2990-SO-2610-012 deleted', replaced_by_id: 8 },
    replacedBy: { id: 8, orNumber: '2990-DraftOR-2610-040', status: 'DRAFT' }, replaces: null,
    paymentJournal: null, payment: null, salesOrder: '2990-SO-2610-012', salesInvoice: null, salesperson: null,
  },
  9: {
    receipt: { id: 9, or_number: '2990-COR-2610-002', status: 'FORMAL', payment_source: 'SOPAY', payment_id: 'p-3', doc_no: '2990-SO-2610-020', customer_name: 'Tan', method: 'cash', amount_sen: 20_000, paid_at: '2026-10-02', channel_account_code: '300-1000', issued_at: '2026-10-02T03:00:00Z', issued_by: 'Ivy', created_at: '2026-10-02T03:00:00Z', created_by: 'Ivy', cancelled_at: null, cancelled_by: null, cancel_reason: null, replaced_by_id: null },
    replacedBy: null, replaces: null, paymentJournal: { id: 'je-c', jeNo: '2990-JE-2610-0007', reversed: false },
    payment: { amountSen: 20_000, paidAt: '2026-10-02', method: 'cash', soDocNo: '2990-SO-2610-020', salesInvoiceId: null },
    salesOrder: '2990-SO-2610-020', salesInvoice: null, salesperson: 'Ah Seng',
  },
};
const receiptRow = (over: Record<string, unknown>) => ({
  id: 'r1', receipt_number: '2990-ODR-2610-001', debtor_id: 'd1', receipt_date: '2026-10-03', bank_account_code: '310-0001', total_sen: 60_000,
  status: 'DRAFT', submitted_at: null, submitted_by: null, checked_at: null, checked_by: null, approved_at: null, approved_by: null, posted_at: null,
  notes: null, created_at: '2026-10-03T00:00:00Z', created_by: '00000000-0000-4000-8000-000000000001', ...over,
});
const DEBTOR_RECEIPT = { value: {} as Record<string, unknown> };
const debtorReceipt = (over: Record<string, unknown>) => ({
  receipt: receiptRow(over),
  debtor: { id: 'd1', name: 'AHMAD BIN ALI', code: '305-A001', phone: '012-345', notes: null, is_active: true, outstanding_sen: 20_000, address1: '12 Jalan Satu' },
  allocations: [
    { billId: 'b1', amountSen: 50_000, billNumber: '2990-ODB-2609-001', billDate: '2026-09-05', description: '转租九月', totalSen: 50_000, receivedSen: 0, status: 'POSTED', docKind: 'INV' },
    { billId: 'b2', amountSen: 10_000, billNumber: '2990-ODB-2609-002', billDate: '2026-09-20', description: 'Booth rental', totalSen: 30_000, receivedSen: 0, status: 'POSTED', docKind: 'INV' },
  ],
});
const JOURNALS: Record<string, unknown[]> = {
  'SOPAY|p-1': [{
    id: 'je-b', je_no: '2990-JE-2610-0140', entry_date: '2026-10-13', source_type: 'SOPAY', reversed: false, created_at: '2026-10-14T02:00:00Z',
    lines: [
      { line_no: 1, account_code: '310-0001', debit_sen: 55_800, credit_sen: 0, party_name: null, notes: null },
      { line_no: 2, account_code: '300-0000', debit_sen: 0, credit_sen: 55_800, party_name: 'Larding Chen', notes: null },
    ],
  }],
  'ODR|2990-ODR-2610-001': [],
};
const formaliseCalls: string[] = [];
vi.mock('../../../vendor/scm/lib/authed-fetch', () => ({
  authedFetch: vi.fn(async (path: string, init?: { method?: string }) => {
    if (path.startsWith('/accounting/journal-entries')) {
      const q = new URLSearchParams(path.split('?')[1] ?? '');
      return { journalEntries: JOURNALS[`${q.get('sourceType')}|${q.get('sourceDocNo')}`] ?? [] };
    }
    const formal = /^\/accounting\/receipts\/(\d+)\/formalise$/.exec(path);
    if (formal && init?.method === 'POST') { formaliseCalls.push(formal[1]!); return { ok: true, orNumber: '2990-HOR-2610-031' }; }
    const official = /^\/accounting\/receipts\/(\d+)$/.exec(path);
    if (official) return OFFICIAL[official[1]!];
    if (path.startsWith('/other-debtors/receipts/')) return DEBTOR_RECEIPT.value;
    throw new Error(`unexpected read ${path}`);
  }),
}));

const stepMutate = vi.fn();
const voidMutate = vi.fn();
vi.mock('../../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/lib/accounting-queries')>()),
  useAccounts: () => ({ data: { accounts: [
    { account_code: '310-0001', account_name: 'Hong Leong Bank', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true },
    { account_code: '300-0000', account_name: 'Trade Debtors', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false },
    { account_code: '305-0000', account_name: 'Other Debtors', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false },
  ] }, isLoading: false }),
  useAccountRoles: () => ({ data: { roles: { AR: '300-0000', AR_OTHER: '305-0000' }, overridden: {} } }),
  useDebtorReceiptAction: () => ({ mutate: stepMutate, isPending: false }),
  useVoidDebtorReceipt: () => ({ mutate: voidMutate, isPending: false }),
  useUpdateDebtorReceipt: () => ({ mutate: updateDebtorReceipt, isPending: false }),
  useDebtorDetail: (id: string | null) => ({ data: id === 'd1' ? DEBTOR_D1 : undefined, isLoading: false, isError: false, error: null }),
  useOtherDebtors: () => DEBTORS,
}));
const updateDebtorReceipt = vi.fn();
/* What the edit form lists (batch 5 step 6): the debtor and the bills it still owes on. */
const DEBTORS = { data: { debtors: [{ id: 'd1', name: 'AHMAD BIN ALI', phone: '012-345', notes: null, is_active: true, outstanding_sen: 80_000 }] }, isLoading: false };
const DEBTOR_D1 = {
  debtor: DEBTORS.data.debtors[0],
  bills: [
    { id: 'b1', bill_number: '2990-ODB-2609-001', bill_date: '2026-09-05', total_sen: 50_000, received_sen: 0, status: 'POSTED', notes: '转租九月' },
    { id: 'b2', bill_number: '2990-ODB-2609-002', bill_date: '2026-09-20', total_sen: 30_000, received_sen: 0, status: 'POSTED', notes: 'Booth rental' },
  ],
  receipts: [],
};
const PERMS = { value: new Set<string>(['*']) };
vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: (k: string) => PERMS.value.has('*') || PERMS.value.has(k) }) }));
const receiptPdf = vi.fn(async (_r: unknown, _o: unknown) => {});
const debtorPdf = vi.fn(async (_d: unknown, _o: unknown) => {});
vi.mock('../../../vendor/scm/lib/debtor-receipt-pdf', () => ({ generateDebtorReceiptPdf: (d: unknown, o: unknown) => debtorPdf(d, o) }));
vi.mock('../../../vendor/scm/lib/receipt-pdf', () => ({ generateReceiptPdf: (r: unknown, o: unknown) => receiptPdf(r, o) }));
vi.mock('../PvDocParts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../PvDocParts')>()),
  VoucherTaskDrawer: ({ link }: { link: { type: string; no: string; to: string } }) => <div role="dialog" aria-label="Add task">{`${link.type} ${link.no} → ${link.to}`}</div>,
}));

beforeEach(() => { vi.clearAllMocks(); formaliseCalls.length = 0; PERMS.value = new Set(['*']); });

const { OfficialReceiptDoc } = await import('./OfficialReceiptDoc');
const { DebtorReceiptDoc } = await import('./DebtorReceiptDoc');
const { ToastProvider } = await import('../../../hooks/useToast');

const open = (path: string, route: string, page: ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}><Routes><Route path={route} element={page} /></Routes></MemoryRouter>
    </ToastProvider>
  </QueryClientProvider>,
);
const openOfficial = (id: number) => open(`/scm/receipts/official/${id}`, '/scm/receipts/official/:id', <OfficialReceiptDoc />);
const openDebtorReceipt = (over: Record<string, unknown>) => {
  DEBTOR_RECEIPT.value = debtorReceipt(over);
  return open('/scm/receipts/debtor/r1', '/scm/receipts/debtor/:id', <DebtorReceiptDoc />);
};
const fact = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement;

describe('an official receipt, as a page', () => {
  test('a draft: who paid for which order, the salesperson, the payment journal as its books, the payment keyed when it differs; Confirm money turns it formal', async () => {
    openOfficial(7);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: '2990-DraftOR-2610-031' })).toBeTruthy());
    expect(screen.getByText('money not confirmed yet')).toBeTruthy();
    expect(screen.getByText('Larding Chen')).toBeTruthy();
    expect(fact('Sales order').querySelector('a')!.getAttribute('href')).toBe('/scm/sales-orders/2990-SO-2610-011');
    expect(fact('Salesperson').textContent).toBe('Mei Ling');
    expect(fact('Payment journal').textContent).toBe('2990-JE-2610-0140');
    expect(fact('Confirmed').textContent).toBe('Not yet · money not confirmed');
    /* The payment was corrected to RM 558 after the receipt said RM 1,115. */
    expect(fact('Payment keyed').textContent).toBe('RM 558.00');
    await waitFor(() => expect(screen.getByText(/Dr 310-0001 Hong Leong Bank · Cr 300-0000 Trade Debtors \(Larding Chen\) · RM 558\.00 · 2990-JE-2610-0140/)).toBeTruthy());
    const confirm = screen.getByRole('button', { name: 'Confirm money' });
    expect(confirm.getAttribute('title')).toBe('You have seen the money arrive');
    fireEvent.click(confirm);
    await waitFor(() => expect(formaliseCalls).toEqual(['7']));
    await waitFor(() => expect(screen.getByText('2990-DraftOR-2610-031 is formal · 2990-HOR-2610-031')).toBeTruthy());
  });

  test('a cancelled receipt names its re-issue and why, says its payment is gone, and offers no Confirm money', async () => {
    openOfficial(5);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: '2990-HOR-2610-004' })).toBeTruthy());
    expect(screen.getByText('cancelled · Payment on 2990-SO-2610-012 deleted')).toBeTruthy();
    expect(fact('Replaced by').querySelector('a')!.getAttribute('href')).toBe('/scm/receipts/official/8');
    expect(fact('Payment').textContent).toBe('The payment row is gone');
    expect(fact('Confirmed').textContent).toBe('Chew · 2026/10/10');
    expect(screen.queryByRole('button', { name: 'Confirm money' })).toBeNull();
    expect(within(screen.getByRole('complementary', { name: 'Trail' })).getByText('Payment on 2990-SO-2610-012 deleted')).toBeTruthy();
  });

  test('cash is formal at the counter; Print hands the receipt to the A5 paper; Add task links it', async () => {
    openOfficial(9);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: '2990-COR-2610-002' })).toBeTruthy());
    expect(fact('Confirmed').textContent).toBe('Cash at the counter · 2026/10/02');
    expect(screen.queryByText('Payment keyed', { selector: 'dt' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Print/ }));
    const preview = screen.getByRole('dialog', { name: 'Print preview' });
    expect(preview.textContent).toContain('A5 landscape · half an A4 sheet · one receipt per page · same letterhead as the payment voucher');
    fireEvent.click(within(preview).getByText('Print now'));
    await waitFor(() => expect(receiptPdf).toHaveBeenCalled());
    expect((receiptPdf.mock.calls[0]![0] as { or_number: string; sales_order: string }).or_number).toBe('2990-COR-2610-002');
    expect((receiptPdf.mock.calls[0]![0] as { sales_order: string }).sales_order).toBe('2990-SO-2610-020');
    expect(receiptPdf.mock.calls[0]![1]).toEqual({ action: 'print' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Print preview' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /Add task/ }));
    expect(screen.getByRole('dialog', { name: 'Add task' }).textContent).toBe('Official receipt 2990-COR-2610-002 → /scm/receipts/official/9');
  });
});

describe("an other debtor's receipt walks the four layers", () => {
  test('a draft: who paid, into which account, the bills it knocks off; Prepare', async () => {
    openDebtorReceipt({});
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: '2990-ODR-2610-001' })).toBeTruthy());
    expect(screen.getByText('Account 305-A001')).toBeTruthy();
    expect(fact('Received into').textContent).toBe('310-0001 Hong Leong Bank');
    expect(fact('Journal').textContent).toBe('Written at approval');
    const knocks = screen.getByRole('region', { name: 'Knocks off' });
    expect(within(knocks).getByText('2990-ODB-2609-001').closest('a')!.getAttribute('href')).toBe('/scm/ar-invoices/bills/b1');
    expect(within(knocks).getByText('Booth rental')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Posts at approval/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Approve & post' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare' }));
    expect(stepMutate.mock.calls[0]![0]).toEqual({ receiptId: 'r1', action: 'submit' });
  });

  test('prepared: Check, Withdraw, and Reject — which waits for a reason the preparer reads', async () => {
    openDebtorReceipt({ submitted_at: '2026-10-03T01:00:00Z' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(stepMutate.mock.calls[0]![0]).toEqual({ receiptId: 'r1', action: 'withdraw' });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(stepMutate.mock.calls[1]![0]).toEqual({ receiptId: 'r1', action: 'check' });
    fireEvent.click(screen.getByRole('button', { name: 'Reject…' }));
    const ask = screen.getByRole('region', { name: 'Reject 2990-ODR-2610-001?' });
    expect(ask.textContent).toContain('It goes back to Draft. Every mark clears and it starts again.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Reject' }));
    expect(stepMutate).toHaveBeenCalledTimes(2);
    fireEvent.change(within(ask).getByPlaceholderText('Why? The preparer sees this'), { target: { value: 'Wrong bank' } });
    fireEvent.click(within(ask).getByRole('button', { name: 'Reject' }));
    expect(stepMutate.mock.calls[2]![0]).toEqual({ receiptId: 'r1', action: 'reject', note: 'Wrong bank' });
  });

  /* Batch 5 step 6 (c5): a Draft or a Prepared receipt changes in place; it keeps its stage and posts nothing. */
  test('prepared: Edit opens the form in place — the debtor fixed — and saves the date, account and bills', async () => {
    openDebtorReceipt({ submitted_at: '2026-10-03T01:00:00Z' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Edit 2990-ODR-2610-001' })).toBeTruthy());
    expect(screen.getByText('Back to 2990-ODR-2610-001')).toBeTruthy();
    expect(screen.getByText('Saving keeps it Prepared — nothing posts until it is approved.')).toBeTruthy();
    expect((screen.getByLabelText('Debtor') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(updateDebtorReceipt.mock.calls[0]![0]).toEqual({
      receiptId: 'r1', receiptDate: '2026-10-03', bankAccountCode: '310-0001',
      allocations: [{ billId: 'b1', amountSen: 50_000 }, { billId: 'b2', amountSen: 10_000 }],
    });
  });

  test('checked: Approve & post asks what it books and knocks off, then posts', async () => {
    openDebtorReceipt({ submitted_at: '2026-10-03T01:00:00Z', checked_at: '2026-10-03T02:00:00Z' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve & post' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve & post' }));
    const ask = screen.getByRole('region', { name: 'Approve 2990-ODR-2610-001?' });
    expect(ask.textContent).toContain('RM 600.00 books into Hong Leong Bank (310-0001) and 2990-ODB-2609-001, 2990-ODB-2609-002 are knocked off.');
    expect(within(ask).getByRole('button', { name: 'Not now' })).toBeTruthy();
    fireEvent.click(within(ask).getByRole('button', { name: 'Approve & post' }));
    expect(stepMutate.mock.calls[0]![0]).toEqual({ receiptId: 'r1', action: 'approve' });
  });

  /* Batch 5 step 10: the receipt prints on the A4 RECEIPT — DRAFT across it until approved (the generator's). */
  test('Print opens the print dialog; Print now hands the receipt, its debtor and the bills it knocks off to the RECEIPT', async () => {
    openDebtorReceipt({});
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: '2990-ODR-2610-001' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Print/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Print preview' })).getByText('Print now'));
    await waitFor(() => expect(debtorPdf).toHaveBeenCalled());
    const [data, opts] = debtorPdf.mock.calls[0]! as [{ receipt: { receipt_number: string }; debtor: { name: string }; bills: unknown[] }, unknown];
    expect(data.receipt.receipt_number).toBe('2990-ODR-2610-001');
    expect(data.debtor.name).toBe('AHMAD BIN ALI');
    expect(data.bills).toEqual([
      { billNumber: '2990-ODB-2609-001', description: '转租九月', amountSen: 50_000 },
      { billNumber: '2990-ODB-2609-002', description: 'Booth rental', amountSen: 10_000 },
    ]);
    expect(opts).toEqual({ action: 'print' });
  });

  test('checked, for someone who cannot approve: it waits, no Approve', async () => {
    PERMS.value = new Set(['scm.payment_voucher.check']);
    openDebtorReceipt({ submitted_at: '2026-10-03T01:00:00Z', checked_at: '2026-10-03T02:00:00Z' });
    await waitFor(() => expect(screen.getByText('Waiting for approval')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Approve & post' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reject…' })).toBeTruthy();
  });

  test('approved: Void asks, then reverses; a rejection is kept on its trail', async () => {
    openDebtorReceipt({ status: 'POSTED', submitted_at: '2026-10-03T01:00:00Z', checked_at: '2026-10-03T02:00:00Z', approved_at: '2026-10-03T03:00:00Z', notes: '[rejected] Wrong bank' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Void…' })).toBeTruthy());
    expect(within(screen.getByRole('complementary', { name: 'Trail' })).getByText('Wrong bank')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Void…' }));
    const ask = screen.getByRole('region', { name: 'Void 2990-ODR-2610-001?' });
    expect(ask.textContent).toContain('the bills it knocked off owe that money again.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Void receipt' }));
    expect(voidMutate.mock.calls[0]![0]).toBe('r1');
  });
});
