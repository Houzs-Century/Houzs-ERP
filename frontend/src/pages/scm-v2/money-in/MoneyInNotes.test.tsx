/* Money in › Credit / debit notes (the owner's Claude Design, batch 5 step 7):
   a customer's credit and debit notes, an other debtor's credit note and an
   other debtor's debit note (a bill of its own kind) on one list — All · Credit
   notes · Debit notes with counts, status chips, what an other debtor's credit
   knocked off, the row's next step, Post to ledger one by one or as a batch
   (the first refusal stops it), Cancel asked inline, and the note form in
   place of the list (CreditNotes.tsx's NoteForm, inline) with Copy as new.
   The server half is backend/tests/creditNotes.test.ts and
   otherDebtorCreditNote.test.ts. */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { CreditNote } from '../../../vendor/scm/lib/credit-note-queries';

const TODAY = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/* ── What the server answers (ONE stable object per read, as react-query hands back) ── */
const note = (over: Partial<CreditNote>): CreditNote => ({
  id: 'n1', note_number: 'HC-CN-2611-001', kind: 'CN', party_type: 'CUSTOMER', party_code: '300-C001', party_name: 'TAN MEI LING',
  supplier_id: null, debtor_id: null, so_doc_no: 'HC-SO-2611-004', sales_invoice_id: null, ap_invoice_id: null, purchase_invoice_id: null,
  source_doc_no: 'DR-2611-001', note_date: '2026-11-02', total_sen: 15_000, reason: 'Scratched leg', notes: null, status: 'DRAFT', je_no: null,
  created_at: '2026-11-02T00:00:00Z', created_by: 'Chew', posted_at: null, cancelled_at: null, ...over,
});
const NOTES: CreditNote[] = [
  note({}),
  note({ id: 'n5', note_number: 'HC-CN-2611-002', note_date: '2026-11-03', total_sen: 2_000, reason: 'Late delivery', source_doc_no: null }),
  note({ id: 'n2', note_number: 'HC-DN-2611-001', kind: 'DN', party_name: 'LIM AH KOW', so_doc_no: 'HC-SO-2611-007', source_doc_no: null, total_sen: 5_000, status: 'POSTED', je_no: 'HC-JE-2611-0050', note_date: '2026-11-01' }),
  note({
    id: 'n3', note_number: 'HC-OCN-2611-001', kind: 'OCN', party_type: 'ODEBTOR', party_code: null, party_name: 'EASTERN DECORATOR', debtor_id: 'deb-e',
    so_doc_no: null, source_doc_no: 'CN-2611-025', total_sen: 200_000, status: 'POSTED', je_no: 'HC-JE-2611-0051', note_date: '2026-10-30', appliedSen: 150_000, unusedSen: 50_000,
  }),
  note({ id: 'n4', note_number: 'HC-CN-2610-009', total_sen: 9_000, status: 'CANCELLED', note_date: '2026-10-20' }),
];
const LIST = { data: { rows: NOTES }, isLoading: false, isError: false, error: null };
const odn = (over: Record<string, unknown>) => ({
  kind: 'ODB', docKind: 'DN', id: 'b7', invoiceNumber: 'HC-ODN-2611-001', partyKey: 'D:d2', partyCode: null, partyName: 'OLD DEBTOR', debtorId: 'd2',
  ref: null, description: 'Damaged booth', invoiceDate: '2026-11-01', dueDate: null, currency: 'MYR', totalSen: 10_000, paidSen: 0,
  depositAppliedSen: 0, outstandingSen: 10_000, status: 'POSTED', ...over,
});
const ODN = { data: { rows: [odn({}), odn({ id: 'b8', invoiceNumber: 'HC-ODN-2610-002', invoiceDate: '2026-10-15', paidSen: 10_000, outstandingSen: 0, status: 'PAID' })] }, isLoading: false, isError: false, error: null };
const BILL_B7 = {
  bill: { id: 'b7', bill_number: 'HC-ODN-2611-001', bill_date: '2026-11-01', total_sen: 10_000, received_sen: 0, status: 'POSTED', notes: 'Damaged booth', doc_kind: 'DN',
    lines: [{ id: 'l7', line_no: 1, description: 'Booth repair', credit_account_code: '700-0000', amount_sen: 10_000 }] },
  debtor: { id: 'd2', name: 'OLD DEBTOR', phone: null, notes: null, is_active: true, outstanding_sen: 10_000 },
};
const LINES = [{ id: 'l1', line_no: 1, description: 'Goodwill', account_code: '510-0000', amount_sen: 15_000 }];

const posts: string[] = [];
let refusePost: string | null = null;
vi.mock('../../../vendor/scm/lib/authed-fetch', () => ({
  authedFetch: vi.fn(async (path: string) => {
    const post = /^\/credit-notes\/([^/]+)\/post$/.exec(path);
    if (post) {
      posts.push(post[1]!);
      if (refusePost === post[1]) throw new Error('510-0000 is not a leaf account — pick a leaf.');
      return { ok: true, jeNo: `HC-JE-2611-00${60 + posts.length}` };
    }
    throw new Error(`unexpected ${path}`);
  }),
}));
const createAsync = vi.fn(async (body: Record<string, unknown>) => ({ ok: true, note: { ...note({}), id: 'n9', note_number: 'HC-CN-2611-003', ...body } }));
const postAsync = vi.fn(async (_id: string) => ({ ok: true, jeNo: 'HC-JE-2611-0070', status: 'posted' }));
const cancelMutate = vi.fn();
vi.mock('../../../vendor/scm/lib/credit-note-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/lib/credit-note-queries')>()),
  useCreditNotes: () => LIST,
  useCreditNoteDetail: (id: string | null) => ({
    data: id ? { note: NOTES.find((n) => n.id === id), lines: LINES, allocations: [] } : undefined,
    isLoading: false, isError: false, error: null,
  }),
  useCreateCreditNote: () => ({ mutateAsync: createAsync, isPending: false, isError: false, error: null }),
  useUpdateCreditNote: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null }),
  usePostCreditNote: () => ({ mutateAsync: postAsync, mutate: vi.fn(), isPending: false, isError: false, isSuccess: false, error: null }),
  useCancelCreditNote: () => ({ mutate: cancelMutate, isPending: false, isError: false, error: null }),
  useUploadCreditNoteFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
  /* The customer's open invoices (the knock-off table; noteKnockOff.test.tsx covers it). */
  usePartyKnockOff: () => ({ data: { rows: [] }, isLoading: false, isError: false, error: null }),
}));
vi.mock('../../../vendor/scm/lib/ar-invoice-queries', () => ({
  useArInvoices: () => ODN,
  useArBillDetail: (id: string | null) => ({ data: id === 'b7' ? BILL_B7 : undefined, isLoading: false, isError: false, error: null }),
}));
const ACCOUNTS = { data: { accounts: [
  { account_code: '510-0000', account_name: 'Return inwards', account_type: 'INCOME', parent_code: null, is_active: true, acc_money: false },
  { account_code: '520-0000', account_name: 'Discount allowed', account_type: 'INCOME', parent_code: null, is_active: true, acc_money: false },
  { account_code: '700-0000', account_name: 'Other Income', account_type: 'INCOME', parent_code: null, is_active: true, acc_money: false },
] }, isLoading: false };
const ROLES = { data: { roles: { SALES_RETURNS: '510-0000', AR_OTHER: '305-0000' }, overridden: {} } };
const DEBTORS = { data: { debtors: [{ id: 'd2', name: 'OLD DEBTOR', phone: null, notes: null, is_active: true, outstanding_sen: 10_000 }] }, isLoading: false };
const cancelBill = vi.fn();
vi.mock('../../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/lib/accounting-queries')>()),
  useAccounts: () => ACCOUNTS,
  useAccountRoles: () => ROLES,
  useOtherDebtors: () => DEBTORS,
  useCancelDebtorBill: () => ({ mutate: cancelBill, isPending: false }),
  useCreateDebtorBill: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateDebtorBill: () => ({ mutate: vi.fn(), isPending: false }),
}));
const EVENTS = { data: [], isLoading: false };
vi.mock('../../../vendor/scm/lib/event-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/lib/event-queries')>()),
  useEventOptions: () => EVENTS,
  useEventLabels: () => ({ data: new Map() }),
}));
const PERMS = { value: new Set<string>(['*']) };
vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: (p: string) => PERMS.value.has('*') || PERMS.value.has(p) }) }));

const { MoneyInNotes } = await import('./MoneyInNotes');
const { ToastProvider } = await import('../../../hooks/useToast');

function Where() { const l = useLocation(); return <output data-testid="where">{`${l.pathname}${l.search}`}</output>; }
const draw = (search = '') => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>
      <MemoryRouter initialEntries={[`/scm/credit-notes${search}`]}>
        <Routes><Route path="*" element={<><MoneyInNotes /><Where /></>} /></Routes>
      </MemoryRouter>
    </ToastProvider>
  </QueryClientProvider>,
);
const where = () => screen.getByTestId('where').textContent;
const row = (no: string) => screen.getByText(no, { selector: 'a' }).closest('tr') as HTMLElement;
const menuOf = (no: string) => { fireEvent.click(within(row(no)).getByRole('button', { name: `${no} menu` })); return screen.getByRole('menu'); };
const items = (menu: HTMLElement) => within(menu).getAllByRole('menuitem').map((m) => m.textContent);
const segment = (name: RegExp) => within(screen.getByRole('group', { name: 'Kind of note' })).getByRole('button', { name });
const chip = (name: RegExp) => within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name });

beforeEach(() => {
  vi.clearAllMocks();
  posts.length = 0; refusePost = null;
  PERMS.value = new Set(['*']);
});

describe('one list for every note to a customer or an other debtor', () => {
  test('All · Credit notes · Debit notes with counts; the chips follow; the kind, the party and what an other debtor’s credit knocked off', () => {
    draw();
    expect(screen.getByRole('heading', { name: 'Credit / debit notes' })).toBeTruthy();
    expect(segment(/^All\s*7$/).getAttribute('aria-pressed')).toBe('true');
    expect(segment(/^Credit notes\s*4$/)).toBeTruthy();
    expect(segment(/^Debit notes\s*3$/)).toBeTruthy();
    expect(chip(/^Draft\s*2$/)).toBeTruthy();
    expect(chip(/^Posted\s*4$/)).toBeTruthy();
    expect(chip(/^Cancelled\s*1$/)).toBeTruthy();
    expect(row('HC-OCN-2611-001').textContent).toContain('CN · other debtor');
    expect(within(row('HC-OCN-2611-001')).getByText('RM 1,500.00')).toBeTruthy();
    expect(within(row('HC-OCN-2611-001')).getByText('RM 500.00 not knocked off')).toBeTruthy();
    expect(row('HC-ODN-2611-001').textContent).toContain('DN · other debtor');
    expect(within(row('HC-CN-2611-001')).getByText('HC-SO-2611-004 · DR-2611-001')).toBeTruthy();
    expect(screen.getByText('HC-ODN-2611-001', { selector: 'a' }).getAttribute('href')).toBe('/scm/ar-invoices/bills/b7');
    expect(screen.getByText('HC-CN-2611-001', { selector: 'a' }).getAttribute('href')).toBe('/scm/credit-notes/n1');
    fireEvent.click(segment(/^Debit notes/));
    expect(where()).toBe('/scm/credit-notes?kind=debit');
    expect(screen.queryByText('HC-CN-2611-001', { selector: 'a' })).toBeNull();
    expect(chip(/^Draft\s*0$/)).toBeTruthy();
    fireEvent.click(chip(/^Posted/));
    expect(where()).toBe('/scm/credit-notes?kind=debit&status=posted');
  });

  test('a draft’s button is Post; it posts through its own route and the toast names the journal', async () => {
    draw();
    fireEvent.click(within(row('HC-CN-2611-001')).getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(posts).toEqual(['n1']));
    expect(await screen.findByText('HC-CN-2611-001 posted · HC-JE-2611-0061')).toBeTruthy();
    expect(within(row('HC-DN-2611-001')).getByRole('button', { name: 'Print' })).toBeTruthy();
  });

  test('the batch posts the ticked drafts one by one and stops at the first refusal, verbatim', async () => {
    refusePost = 'n5';
    draw();
    fireEvent.click(screen.getByLabelText('Tick HC-CN-2611-001'));
    fireEvent.click(screen.getByLabelText('Tick HC-CN-2611-002'));
    fireEvent.click(screen.getByLabelText('Tick HC-DN-2611-001'));
    fireEvent.click(screen.getByRole('button', { name: 'Post to ledger · 2' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('510-0000 is not a leaf account — pick a leaf.'));
    expect(posts).toEqual(['n5']);
  });

  test('Cancel is asked inline: a posted other-debtor credit says its knock-off is undone', async () => {
    draw();
    expect(items(menuOf('HC-OCN-2611-001'))).toEqual(['Open', 'Knock off', 'Copy as new', 'Print', 'Cancel note…']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel note…' }));
    const ask = screen.getByRole('region', { name: 'Cancel HC-OCN-2611-001?' });
    expect(ask.textContent).toContain('Its journal is reversed by a contra dated today. The note stays on file as cancelled. Its knock-off against the bills is undone.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel note' }));
    expect(cancelMutate.mock.calls[0]![0]).toBe('n3');
    const opts = cancelMutate.mock.calls[0]![1] as { onSuccess: () => void };
    await act(async () => { opts.onSuccess(); });
    expect(await screen.findByText('HC-OCN-2611-001 cancelled · journal reversed')).toBeTruthy();
  });

  test('an other debtor’s debit note is a bill: money received on it keeps Cancel away; Edit opens the bill form', () => {
    draw();
    expect(items(menuOf('HC-ODN-2610-002'))).toEqual(['Open', 'Edit', 'Copy as new', 'Print']);
    expect(items(menuOf('HC-ODN-2611-001'))).toEqual(['Open', 'Edit', 'Copy as new', 'Print', 'Cancel note…']);
  });

  test('Edit on an other debtor’s debit note is the bill form, back to this list', () => {
    draw('?form=edit&id=b7&src=bill');
    expect(screen.getByRole('heading', { name: 'Edit HC-ODN-2611-001' })).toBeTruthy();
    expect(screen.getByText('Back to Credit / debit notes')).toBeTruthy();
  });

  test('without the post key a draft’s button is Print; without the raise key there is no New note', () => {
    PERMS.value = new Set(['scm.access']);
    draw();
    expect(within(row('HC-CN-2611-001')).queryByRole('button', { name: 'Post' })).toBeNull();
    expect(within(row('HC-CN-2611-001')).getByRole('button', { name: 'Print' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /New note/ })).toBeNull();
  });
});

describe('the note form, in place of the list', () => {
  test('New note: a customer’s credit note, the blank account named (f1); Save & post saves, posts and opens the note', async () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: /New note/ }));
    expect(where()).toBe('/scm/credit-notes?form=new');
    expect(screen.getByRole('heading', { name: 'New note' })).toBeTruthy();
    expect(screen.getByText('Back to Credit / debit notes')).toBeTruthy();
    expect(screen.getByPlaceholderText('— Default · 510-0000 Return inwards —')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Sales order'), { target: { value: 'HC-SO-2611-004' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Scratched leg' } });
    fireEvent.change(screen.getByLabelText('Line 1 description'), { target: { value: 'Goodwill' } });
    fireEvent.change(screen.getByLabelText('Line 1 amount'), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & post' }));
    await waitFor(() => expect(postAsync).toHaveBeenCalledWith('n9'));
    expect(createAsync.mock.calls[0]![0]).toEqual({
      kind: 'CN', noteDate: TODAY, reason: 'Scratched leg', sourceDocNo: null, soDocNo: 'HC-SO-2611-004',
      lines: [{ description: 'Goodwill', accountCode: null, amountSen: 15_000 }],
      allocations: [],
      idempotencyKey: expect.any(String),
    });
    expect(await screen.findByText('HC-CN-2611-003 saved and posted')).toBeTruthy();
    expect(where()).toBe('/scm/credit-notes/n9');
  });

  test('the switch picks the kind: a debit note to an other debtor is the bill form, its debit-note kind', () => {
    draw('?form=new');
    fireEvent.click(within(screen.getByRole('group', { name: 'Credit or debit' })).getByRole('button', { name: 'Debit note' }));
    expect(where()).toBe('/scm/credit-notes?form=new&type=debit');
    expect(screen.getByLabelText('Sales order')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Who the note is to' })).getByRole('button', { name: 'Other debtor' }));
    expect(screen.getByRole('heading', { name: 'New debit note' })).toBeTruthy();
    expect(screen.getByLabelText('Bill debtor')).toBeTruthy();
  });

  test('Copy as new starts from the note — its order, reason and lines — dated today; Save as draft', async () => {
    draw();
    menuOf('HC-CN-2611-001');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy as new' }));
    expect(where()).toBe('/scm/credit-notes?form=copy&id=n1');
    expect(screen.getByRole('heading', { name: 'New note · copy of HC-CN-2611-001' })).toBeTruthy();
    expect((screen.getByLabelText('Sales order') as HTMLInputElement).value).toBe('HC-SO-2611-004');
    fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }));
    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    expect(createAsync.mock.calls[0]![0]).toMatchObject({ kind: 'CN', noteDate: TODAY, soDocNo: 'HC-SO-2611-004', reason: 'Scratched leg' });
    expect(postAsync).not.toHaveBeenCalled();
    expect(await screen.findByText('HC-CN-2611-003 saved as Draft')).toBeTruthy();
  });

  test('a posted note is not edited here', () => {
    draw('?form=edit&id=n2');
    expect(screen.getByRole('alert').textContent).toBe('HC-DN-2611-001 is posted — only a draft changes.');
  });
});
