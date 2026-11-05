// A sundry receipt and an other debtor as pages (the owner's Claude Design,
// batch 5 step 2): the receipt's lines, journal and steps (Copy as new, Edit —
// the form in place of the page — and Void asked inline); the debtor's party
// data, bills and receipts each opening its own page, Edit debtor and
// Deactivate. The writes are the same hooks as the Receipts and Debtor
// maintenance pages — the server half is backend/tests/receipts.test.ts and
// otherDebtors.test.ts.

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const JOURNALS: Record<string, unknown[]> = {
  'RCT|HC-RCT-2610-004': [{
    id: 'je-9', je_no: 'HC-JE-2610-0912', entry_date: '2026-10-05', source_type: 'RCT', reversed: false, created_at: '2026-10-05T02:00:00Z',
    lines: [
      { line_no: 1, account_code: '310-0001', debit_sen: 88_800, credit_sen: 0, party_name: null, notes: null },
      { line_no: 2, account_code: '700-0000', debit_sen: 0, credit_sen: 88_800, party_name: null, notes: null },
    ],
  }],
};
vi.mock('../../../vendor/scm/lib/authed-fetch', () => ({
  authedFetch: vi.fn(async (path: string) => {
    const q = new URLSearchParams(path.split('?')[1] ?? '');
    return { journalEntries: JOURNALS[`${q.get('sourceType')}|${q.get('sourceDocNo')}`] ?? [] };
  }),
}));

const RECEIPT = {
  receipt: { id: 'g1', receipt_number: 'HC-RCT-2610-004', payer_name: 'Booth refund — MLE', receipt_date: '2026-10-05', bank_account_code: '310-0001', total_sen: 88_800, status: 'POSTED', notes: null },
  lines: [{ id: 'gl1', line_no: 1, description: 'Deposit returned', credit_account_code: '700-0000', amount_sen: 88_800 }],
};
const DEBTOR = {
  debtor: { id: 'd1', name: 'AHMAD BIN ALI', phone: '012-345', notes: 'Rents the back lot', is_active: true, outstanding_sen: 0, address1: '12 Jalan Satu', city: 'Petaling Jaya', postcode: '46000', business_reg_no: '202001012345', email: 'ahmad@example.com' },
  bills: [
    { id: 'b1', bill_number: 'HC-ODB-2609-001', bill_date: '2026-09-05', total_sen: 50_000, received_sen: 50_000, status: 'PAID', notes: '转租九月', created_at: '2026-09-05T02:00:00Z', lines: [] },
    { id: 'b2', bill_number: 'HC-ODB-2609-002', bill_date: '2026-09-20', total_sen: 30_000, received_sen: 10_000, status: 'POSTED', notes: 'Booth rental', created_at: '2026-09-20T02:00:00Z', lines: [] },
  ],
  receipts: [
    { id: 'r1', receipt_number: 'HC-ODR-2610-001', receipt_date: '2026-10-03', bank_account_code: '310-0001', total_sen: 60_000, status: 'POSTED', submitted_at: 'x', submitted_by: null, checked_at: 'x', checked_by: null, approved_at: '2026-10-03T03:00:00Z', approved_by: null, posted_at: null, notes: null,
      bills: [{ billId: 'b1', no: 'HC-ODB-2609-001', amountSen: 50_000 }, { billId: 'b2', no: 'HC-ODB-2609-002', amountSen: 10_000 }] },
  ],
};
const createReceipt = vi.fn();
const updateReceipt = vi.fn();
const voidReceipt = vi.fn();
const updateDebtor = vi.fn();
vi.mock('../../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/lib/accounting-queries')>()),
  useAccounts: () => ({ data: { accounts: [
    { account_code: '310-0001', account_name: 'Hong Leong Bank', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true },
    { account_code: '700-0000', account_name: 'Other Income', account_type: 'INCOME', parent_code: null, is_active: true, acc_money: false },
    { account_code: '305-0000', account_name: 'Other Debtors', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false },
  ] }, isLoading: false }),
  useAccountRoles: () => ({ data: { roles: { AR_OTHER: '305-0000' }, overridden: {} } }),
  useReceiptDetail: (id: string | null) => ({ data: id === 'g1' ? RECEIPT : undefined, isLoading: false, error: null }),
  useCreateReceipt: () => ({ mutate: createReceipt, isPending: false }),
  useUpdateReceipt: () => ({ mutate: updateReceipt, isPending: false }),
  useVoidReceipt: () => ({ mutate: voidReceipt, isPending: false }),
  useDebtorDetail: (id: string | null) => ({ data: id === 'd1' ? DEBTOR : undefined, isLoading: false, error: null }),
  useUpdateDebtor: () => ({ mutate: updateDebtor, isPending: false }),
  useOtherDebtors: () => DEBTORS,
}));
const DEBTORS = { data: { debtors: [{ id: 'd1', name: 'AHMAD BIN ALI', phone: '012-345', notes: null, is_active: true, outstanding_sen: 20_000 }] }, isLoading: false };
const EVENTS = { data: [], isLoading: false };
vi.mock('../../../vendor/scm/lib/event-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/lib/event-queries')>()),
  useEventOptions: () => EVENTS,
  useEventLabels: () => ({ data: new Map() }),
}));
vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const sundryPdf = vi.fn(async (_d: unknown, _o: unknown) => {});
vi.mock('../../../vendor/scm/lib/sundry-receipt-pdf', () => ({ generateSundryReceiptPdf: (d: unknown, o: unknown) => sundryPdf(d, o) }));
vi.mock('../PvDocParts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../PvDocParts')>()),
  VoucherTaskDrawer: ({ link }: { link: { type: string; no: string; to: string } }) => <div role="dialog" aria-label="Add task">{`${link.type} ${link.no} → ${link.to}`}</div>,
}));

beforeEach(() => { vi.clearAllMocks(); });

const { SundryReceiptDoc } = await import('./SundryReceiptDoc');
const { OtherDebtorDoc } = await import('./OtherDebtorDoc');
const { ToastProvider } = await import('../../../hooks/useToast');

const open = (path: string, route: string, page: ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}><Routes><Route path={route} element={page} /></Routes></MemoryRouter>
    </ToastProvider>
  </QueryClientProvider>,
);
const openReceipt = (search = '') => open(`/scm/receipts/sundry/g1${search}`, '/scm/receipts/sundry/:id', <SundryReceiptDoc />);
const openDebtor = (search = '') => open(`/scm/other-debtors/d1${search}`, '/scm/other-debtors/:id', <OtherDebtorDoc />);
const fact = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement;

describe('a sundry receipt, as a page', () => {
  test('who paid, into which account, its lines and journal; Void asks inline, then reverses', async () => {
    openReceipt();
    expect(screen.getByRole('heading', { level: 1, name: 'HC-RCT-2610-004' })).toBeTruthy();
    expect(screen.getByText('Back to Receipts')).toBeTruthy();
    expect(screen.getByText('Booth refund — MLE')).toBeTruthy();
    expect(fact('Received into').textContent).toBe('310-0001 Hong Leong Bank');
    expect(within(screen.getByRole('region', { name: 'Lines' })).getByText('Deposit returned')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Dr 310-0001 Hong Leong Bank · Cr 700-0000 Other Income · RM 888\.00 · HC-JE-2610-0912/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Void…' }));
    const ask = screen.getByRole('region', { name: 'Void HC-RCT-2610-004?' });
    expect(ask.textContent).toContain('Its journal HC-JE-2610-0912 is reversed by a contra dated today. The receipt stays on file as voided.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Void receipt' }));
    expect(voidReceipt.mock.calls[0]![0]).toBe('g1');
  });

  test('Edit opens the form in place, says it re-posts, and sends every field', () => {
    openReceipt();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('heading', { name: 'Edit HC-RCT-2610-004' })).toBeTruthy();
    expect(screen.getByText('Saving changes re-posts it: the old journal gets a contra and a fresh one books what you save.')).toBeTruthy();
    expect((screen.getByLabelText('Received from') as HTMLInputElement).value).toBe('Booth refund — MLE');
    fireEvent.change(screen.getByLabelText('Received from'), { target: { value: 'MLE Events' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & re-post' }));
    expect(updateReceipt.mock.calls[0]![0]).toEqual({
      id: 'g1', receiptDate: '2026-10-05', payerName: 'MLE Events', bankAccountCode: '310-0001',
      lines: [{ description: 'Deposit returned', creditAccountCode: '700-0000', amountSen: 88_800 }],
    });
  });

  test('Copy as new starts today with the same payer, account and lines, and posts new', () => {
    openReceipt('?form=copy');
    expect(screen.getByRole('heading', { name: 'New receipt · copy of HC-RCT-2610-004' })).toBeTruthy();
    expect(screen.getByText(/posts now/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save & post' }));
    const sent = createReceipt.mock.calls[0]![0] as { receiptDate: string; payerName: string; lines: unknown[] };
    expect(sent.receiptDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sent.receiptDate).not.toBe('2026-10-05');
    expect(sent.payerName).toBe('Booth refund — MLE');
    expect(sent.lines).toEqual([{ description: 'Deposit returned', creditAccountCode: '700-0000', amountSen: 88_800 }]);
  });

  test('a form that cannot save says why and keeps its button grey', () => {
    openReceipt('?form=copy');
    fireEvent.change(screen.getByLabelText('Received from'), { target: { value: '  ' } });
    expect(screen.getByText('Type who paid.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save & post' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('a sundry receipt prints (batch 5 step 10)', () => {
  test('Print opens the print dialog on the A4 paper; Print now hands the receipt, its lines and its journal to the RECEIPT', async () => {
    openReceipt();
    await waitFor(() => expect(screen.getAllByText(/HC-JE-2610-0912/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /Print/ }));
    const preview = screen.getByRole('dialog', { name: 'Print preview' });
    expect(preview.textContent).toContain('A4 portrait · same letterhead as the payment voucher · one per page');
    fireEvent.click(within(preview).getByText('Print now'));
    await waitFor(() => expect(sundryPdf).toHaveBeenCalled());
    const [data, opts] = sundryPdf.mock.calls[0]! as [{ receipt: { receipt_number: string }; lines: unknown[]; journalNo: string | null }, unknown];
    expect(data.receipt.receipt_number).toBe('HC-RCT-2610-004');
    expect(data.lines).toHaveLength(1);
    expect(data.journalNo).toBe('HC-JE-2610-0912');
    expect(opts).toEqual({ action: 'print' });
  });
});

describe('an other debtor, as a page', () => {
  test('who they are and where the paper goes, what they owe, their bills and receipts each opening its own page', async () => {
    openDebtor();
    expect(screen.getByRole('heading', { level: 1, name: 'AHMAD BIN ALI' })).toBeTruthy();
    expect(screen.getByText('Back to Debtor maintenance')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Rents the back lot')).toBeTruthy();
    expect(screen.getByText('46000 Petaling Jaya')).toBeTruthy();
    expect(fact('Registration no.').textContent).toBe('202001012345');
    expect(fact('Open bills').textContent).toBe('1');
    expect(fact('Received').textContent).toBe('RM 600.00');
    expect(screen.getByText('RM 200.00', { selector: 'div' })).toBeTruthy();
    expect(screen.getByText(/Bills and receipts post to the 305-0000 Other Debtors control/)).toBeTruthy();
    const bills = screen.getByRole('region', { name: 'Bills' });
    expect(within(bills).getByText('HC-ODB-2609-002').closest('a')!.getAttribute('href')).toBe('/scm/ar-invoices/bills/b2');
    expect(within(bills).getByText('Open bills in Invoices').closest('a')!.getAttribute('href')).toBe('/scm/ar-invoices?debtor=d1');
    const receipts = screen.getByRole('region', { name: 'Receipts' });
    expect(within(receipts).getByText('HC-ODR-2610-001').closest('a')!.getAttribute('href')).toBe('/scm/receipts/debtor/r1');
    expect(within(receipts).getByText('HC-ODB-2609-001, HC-ODB-2609-002')).toBeTruthy();
  });

  test('Edit debtor opens the debtor form in place and saves every field; Deactivate', () => {
    openDebtor();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(updateDebtor.mock.calls[0]![0]).toEqual({ id: 'd1', isActive: false });
    fireEvent.click(screen.getByRole('button', { name: 'Edit debtor' }));
    expect(screen.getByRole('heading', { name: 'Edit AHMAD BIN ALI' })).toBeTruthy();
    expect(screen.getByText('Back to AHMAD BIN ALI')).toBeTruthy();
    expect((screen.getByLabelText('Registration no.') as HTMLInputElement).value).toBe('202001012345');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(updateDebtor.mock.calls[1]![0]).toMatchObject({ id: 'd1', name: 'AHMAD BIN ALI', address1: '12 Jalan Satu', businessRegNo: '202001012345' });
  });

  /* Batch 5 step 6: the page raises the debtor's documents in place. */
  test('New bill and New receipt open their forms in place, on this debtor', () => {
    const view = openDebtor();
    fireEvent.click(within(screen.getByRole('region', { name: 'Bills' })).getByRole('button', { name: /New bill/ }));
    expect(screen.getByRole('heading', { name: 'New debtor bill' })).toBeTruthy();
    expect(screen.getByText('Back to AHMAD BIN ALI')).toBeTruthy();
    expect((screen.getByLabelText('Bill debtor') as HTMLSelectElement).value).toBe('d1');
    view.unmount();
    openDebtor();
    fireEvent.click(within(screen.getByRole('region', { name: 'Receipts' })).getByRole('button', { name: /New receipt/ }));
    expect(screen.getByRole('heading', { name: 'New receipt · Other debtor' })).toBeTruthy();
    expect((screen.getByLabelText('Debtor') as HTMLSelectElement).value).toBe('d1');
    expect(screen.getByText('What AHMAD BIN ALI still owes')).toBeTruthy();
    expect(screen.getByLabelText('Collect HC-ODB-2609-002 in full')).toBeTruthy();
    expect(screen.queryByLabelText('Collect HC-ODB-2609-001 in full')).toBeNull(); // paid in full
  });
});
