/* A customer's credit note knocks off the customer's sales invoices (owner
   2026-11-03: 「要」 — his design, "like AutoCount"; batch 5 c6 / f2):
     • the list: Knock off on a posted customer note — never on the note that
       closed a deposit invoice, whose Knocks off names the final invoice;
     • the knock form (`?form=knock`): the note's fields locked, the customer's
       invoices with what each is for and owes, tick = in full as far as the
       credit reaches, the design's blocking sentences, Save knock-off sets it
       whole and posts nothing;
     • the note's page: what it knocked off, read only, and Knock off;
     • the New note form: the customer's open invoices once the sales order is
       typed, the ticks ride the body as the draft's plan.
   The server half is backend/tests/creditNoteSalesInvoiceKnockOff.test.ts. */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { CreditAllocation, CreditNote, KnockOffRow } from '../../../vendor/scm/lib/credit-note-queries';

const note = (over: Partial<CreditNote>): CreditNote => ({
  id: 'cn1', note_number: 'HC-CN-2611-001', kind: 'CN', party_type: 'CUSTOMER', party_code: '300-C002', party_name: 'TAN AH KOW',
  supplier_id: null, debtor_id: null, so_doc_no: 'HC-SO-2611-004', sales_invoice_id: null, ap_invoice_id: null, purchase_invoice_id: null,
  source_doc_no: 'DR-2611-001', note_date: '2026-11-02', total_sen: 50_000, reason: 'Scratched headboard', notes: null, status: 'POSTED', je_no: 'HC-JE-2611-0040',
  created_at: '2026-11-02T00:00:00Z', created_by: 'Chew', posted_at: '2026-11-02T00:00:00Z', cancelled_at: null, appliedSen: 30_000, unusedSen: 20_000, depositPaper: null, ...over,
});
const NOTES: CreditNote[] = [
  note({}),
  /* The note that closed a deposit invoice at the final invoice. */
  note({
    id: 'cn2', note_number: 'HC-CN-2611-002', source_doc_no: 'HC-DI-2611-001', sales_invoice_id: 'si-7', sales_invoice_number: 'HC-SI-2611-007',
    total_sen: 100_000, reason: 'Deposit invoice HC-DI-2611-001 closed by final invoice HC-SI-2611-007', appliedSen: 0, unusedSen: 0, depositPaper: 'closes',
  }),
  note({ id: 'cn3', note_number: 'HC-CN-2611-003', status: 'DRAFT', je_no: null, posted_at: null, appliedSen: undefined, unusedSen: undefined }),
];
const LIST = { data: { rows: NOTES }, isLoading: false, isError: false, error: null };
const ALLOCS: CreditAllocation[] = [
  { id: 'al-1', kind: 'SI', docId: 'si-1', number: 'HC-SI-2611-001', docDate: '2026-11-01', docTotalSen: 300_000, amountSen: 30_000, appliedSen: 30_000, createdAt: '2026-11-02T01:00:00Z', createdBy: 'Chew' },
];
const KO_ROWS: KnockOffRow[] = [
  { kind: 'SI', id: 'si-1', number: 'HC-SI-2611-001', invoiceRef: 'HC-SO-2611-004', invoiceDate: '2026-11-01', totalSen: 300_000, owedSen: 200_000, noteSen: 30_000, status: 'PARTIALLY_PAID' },
  { kind: 'SI', id: 'si-2', number: 'HC-SI-2611-002', invoiceRef: 'HC-SO-2611-009', invoiceDate: '2026-11-02', totalSen: 15_000, owedSen: 15_000, noteSen: 0, status: 'SENT' },
];
/* ONE stable object per read, as react-query hands back — a fresh object each render loops the lists' filtered-rows effect. */
const DETAILS = new Map<string, unknown>();
const detailOf = (id: string | null) => {
  const n = NOTES.find((x) => x.id === id);
  if (!n) return undefined;
  if (DETAILS.has(n.id)) return DETAILS.get(n.id) as ReturnType<typeof detailFor>;
  const d = detailFor(n);
  DETAILS.set(n.id, d);
  return d;
};
const detailFor = (n: CreditNote) => {
  return {
    note: n, lines: [{ id: 'l1', line_no: 1, description: 'Goodwill', account_code: '510-0000', amount_sen: n.total_sen }],
    allocations: n.id === 'cn1' ? ALLOCS : [], appliedSen: n.id === 'cn1' ? 30_000 : 0, leftSen: n.id === 'cn1' ? 20_000 : 0,
    depositPaper: n.depositPaper === 'closes' ? { kind: 'closes' as const, di: 'HC-DI-2611-001' } : null,
    closedInvoice: n.depositPaper === 'closes' ? { id: 'si-7', number: 'HC-SI-2611-007', date: '2026-11-01', totalSen: 400_000 } : null,
  };
};

const KO_CN1 = { data: { rows: KO_ROWS, totalSen: 50_000, takenSen: 30_000, leftSen: 20_000, posted: true }, isLoading: false, isError: false, error: null };
const KO_CN2 = {
  data: { rows: [], totalSen: 100_000, takenSen: 0, leftSen: 0, posted: true, refusal: 'HC-CN-2611-002 closes deposit invoice HC-DI-2611-001 at the final invoice — the order’s deposit lowers that invoice, so the note knocks nothing off.' },
  isLoading: false, isError: false, error: null,
};
const KO_NONE = { data: undefined, isLoading: false, isError: false, error: null };
const PARTY_ROWS = { data: { rows: KO_ROWS.map((r) => ({ ...r, owedSen: r.owedSen - r.noteSen, noteSen: 0 })) }, isLoading: false, isError: false, error: null };
const PARTY_EMPTY = { data: { rows: [] }, isLoading: false, isError: false, error: null };
const PARTY_NONE = { data: undefined, isLoading: false, isError: false, error: null };
const AR_EMPTY = { data: { rows: [] }, isLoading: false, isError: false, error: null };
const ACCOUNTS = { data: { accounts: [
  { account_code: '300-0000', account_name: 'Trade Debtors', account_type: 'ASSET', parent_code: null, is_active: true },
  { account_code: '510-0000', account_name: 'Return inwards', account_type: 'INCOME', parent_code: null, is_active: true },
] }, isLoading: false };
const ROLES = { data: { roles: { AR: '300-0000', SALES_RETURNS: '510-0000' }, overridden: {} } };
const DEBTORS = { data: { debtors: [] }, isLoading: false };
const FILES = { data: { files: [] }, isLoading: false };
const EVENTS = { data: [], isLoading: false };
const LABELS = { data: new Map() };
const setMutate = vi.fn();
const createAsync = vi.fn(async (body: Record<string, unknown>) => ({ ok: true, note: { ...note({}), id: 'cn9', note_number: 'HC-CN-2611-009', status: 'DRAFT', ...body } }));
const partyCalls: unknown[] = [];
vi.mock('../../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn(async (path: string) => { throw new Error(`unexpected ${path}`); }) }));
vi.mock('../../../vendor/scm/lib/credit-note-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/lib/credit-note-queries')>()),
  useCreditNotes: () => LIST,
  useCreditNoteDetail: (id: string | null) => ({ data: detailOf(id), isLoading: false, isError: false, error: null }),
  useCreditNoteKnockOff: (id: string | null) => (id === 'cn1' ? KO_CN1 : id === 'cn2' ? KO_CN2 : KO_NONE),
  usePartyKnockOff: (party: unknown) => {
    partyCalls.push(party);
    const p = party as { who: string; id: string; by?: string } | null;
    return p?.who === 'customer' && p.id === 'HC-SO-2611-004' ? PARTY_ROWS : p ? PARTY_EMPTY : PARTY_NONE;
  },
  useSetCreditNoteAllocations: () => ({ mutate: setMutate, isPending: false, isError: false, error: null, data: undefined }),
  useCreateCreditNote: () => ({ mutateAsync: createAsync, isPending: false, isError: false, error: null }),
  useUpdateCreditNote: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null }),
  usePostCreditNote: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false, isError: false, isSuccess: false, error: null }),
  useCancelCreditNote: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useCreditNoteFiles: () => FILES,
  useUploadCreditNoteFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteCreditNoteFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('../../../vendor/scm/lib/ar-invoice-queries', () => ({ useArInvoices: () => AR_EMPTY }));
vi.mock('../../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/lib/accounting-queries')>()),
  useAccounts: () => ACCOUNTS,
  useAccountRoles: () => ROLES,
  useOtherDebtors: () => DEBTORS,
  useCancelDebtorBill: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../../vendor/scm/lib/event-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/lib/event-queries')>()),
  useEventOptions: () => EVENTS,
  useEventLabels: () => LABELS,
}));
vi.mock('../../../vendor/scm/components/NotifyDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/components/NotifyDialog')>()),
  useNotify: () => vi.fn(),
}));
vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));

const { MoneyInNotes } = await import('./MoneyInNotes');
const { NotePage } = await import('../NotePage');
const { ToastProvider } = await import('../../../hooks/useToast');
const { ConfirmProvider } = await import('../../../vendor/scm/components/ConfirmDialog');

function Where() { const l = useLocation(); return <output data-testid="where">{`${l.pathname}${l.search}`}</output>; }
const draw = (url: string) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/scm/credit-notes/:id" element={<><NotePage side="AR" /><Where /></>} />
            <Route path="*" element={<><MoneyInNotes /><Where /></>} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </ToastProvider>
  </QueryClientProvider>,
);
const where = () => screen.getByTestId('where').textContent;
const row = (no: string) => screen.getByText(no, { selector: 'a' }).closest('tr') as HTMLElement;
const menuOf = (no: string) => { fireEvent.click(within(row(no)).getByRole('button', { name: `${no} menu` })); return screen.getByRole('menu'); };
const items = (menu: HTMLElement) => within(menu).getAllByRole('menuitem').map((m) => m.textContent);

beforeEach(() => { vi.clearAllMocks(); partyCalls.length = 0; });

describe('the list', () => {
  test('Knock off on a posted customer note; the close-out has none and names the final invoice', () => {
    draw('/scm/credit-notes');
    expect(items(menuOf('HC-CN-2611-001'))).toEqual(['Open', 'Knock off', 'Copy as new', 'Print', 'Cancel note…']);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(within(row('HC-CN-2611-001')).getByText('RM 300.00')).toBeTruthy();
    expect(within(row('HC-CN-2611-001')).getByText('RM 200.00 not knocked off')).toBeTruthy();
    expect(within(row('HC-CN-2611-002')).getByText('HC-SI-2611-007')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Knock off' }));
    expect(where()).toBe('/scm/credit-notes?form=knock&id=cn1');
  });

  test('the close-out and a draft offer no Knock off', () => {
    draw('/scm/credit-notes');
    expect(items(menuOf('HC-CN-2611-002'))).not.toContain('Knock off');
  });
});

describe('the knock form — Knock off <no>', () => {
  test('the note locked, the customer’s invoices, tick and type; Save knock-off sets it whole', async () => {
    draw('/scm/credit-notes?form=knock&id=cn1');
    expect(screen.getByRole('heading', { name: 'Knock off HC-CN-2611-001' })).toBeTruthy();
    expect(screen.getByText('Only the knock-off changes. The note is posted, so its lines and amount stay as they are, and knocking off posts nothing.')).toBeTruthy();
    expect((screen.getByLabelText('Customer') as HTMLInputElement).disabled).toBe(true);
    const table = screen.getByRole('region', { name: 'Knock off against TAN AH KOW’s invoices' });
    expect(within(table).getByText('HC-SO-2611-009 · total RM 150.00')).toBeTruthy();
    expect(screen.getByText('Posts nothing · both sides sit in 300-0000 Trade Debtors · knocks off RM 300.00 · RM 200.00 stays as credit')).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save knock-off' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    /* Ticked: in full as far as the credit left reaches — RM 150.00 of the RM 200.00 left. */
    fireEvent.click(screen.getByLabelText('Knock off HC-SI-2611-002'));
    expect(screen.getByText('Posts nothing · both sides sit in 300-0000 Trade Debtors · knocks off RM 450.00 · RM 50.00 stays as credit')).toBeTruthy();
    fireEvent.click(save);
    expect(setMutate).toHaveBeenCalledTimes(1);
    expect(setMutate.mock.calls[0]![0]).toEqual({ noteId: 'cn1', targets: [{ kind: 'SI', id: 'si-1', amountSen: 30_000 }, { kind: 'SI', id: 'si-2', amountSen: 15_000 }] });
    const opts = setMutate.mock.calls[0]![1] as { onSuccess: (r: { ok: boolean; short: unknown[] }) => void };
    opts.onSuccess({ ok: true, short: [] });
    expect(await screen.findByText('HC-CN-2611-001 · knock-off saved')).toBeTruthy();
    await waitFor(() => expect(where()).toBe('/scm/credit-notes'));
  });

  test('the design’s blocking sentences: over an invoice’s outstanding, over the note', () => {
    draw('/scm/credit-notes?form=knock&id=cn1');
    const amount = screen.getByLabelText('Amount off HC-SI-2611-002');
    fireEvent.change(amount, { target: { value: '160' } });
    fireEvent.blur(amount);
    expect(screen.getByText('HC-SI-2611-002 only has RM 150.00 outstanding.')).toBeTruthy();
    fireEvent.change(amount, { target: { value: '150' } });
    fireEvent.blur(amount);
    const first = screen.getByLabelText('Amount off HC-SI-2611-001');
    fireEvent.change(first, { target: { value: '400' } });
    fireEvent.blur(first);
    expect(screen.getByText('The knock-offs add up to RM 550.00, more than the note (RM 500.00).')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save knock-off' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('a close-out says why it knocks nothing off; from the note page Back returns there', () => {
    draw('/scm/credit-notes?form=knock&id=cn2&back=note');
    expect(screen.getAllByText(/closes deposit invoice HC-DI-2611-001 at the final invoice/).length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Save knock-off' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Back to the note'));
    expect(where()).toBe('/scm/credit-notes/cn2');
  });
});

describe('the note’s page', () => {
  test('what it knocked off, read only, and Knock off to change it', () => {
    draw('/scm/credit-notes/cn1');
    const section = screen.getByRole('region', { name: 'Knocks off' });
    expect(within(section).getByText('Knocked off RM 300.00 ·', { exact: false })).toBeTruthy();
    expect(within(section).getByText('Not knocked off RM 200.00')).toBeTruthy();
    const link = within(section).getByRole('link', { name: 'HC-SI-2611-001' });
    expect(link.getAttribute('href')).toBe('/scm/ar-invoices/sales/si-1');
    expect(within(section).getByText('RM 3,000.00')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Knock off' }));
    expect(where()).toBe('/scm/credit-notes?form=knock&id=cn1&back=note');
  });

  test('a close-out says what it closed and offers no Knock off', () => {
    draw('/scm/credit-notes/cn2');
    const section = screen.getByRole('region', { name: 'Knocks off' });
    expect(section.textContent).toContain('It closes deposit invoice HC-DI-2611-001 at the final invoice HC-SI-2611-007');
    expect(screen.queryByRole('button', { name: 'Knock off' })).toBeNull();
  });

  test('a draft with no plan says how to set one', () => {
    draw('/scm/credit-notes/cn3');
    expect(within(screen.getByRole('region', { name: 'Knocks off' })).getByText('No knock-off set. Edit the draft to knock it off against an invoice.')).toBeTruthy();
  });
});

describe('the New note form', () => {
  test('the sales order lists the customer’s open invoices; the ticks ride the draft', async () => {
    draw('/scm/credit-notes?form=new');
    expect(screen.getByText('Type the sales order or the customer to list their open invoices.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Sales order'), { target: { value: 'HC-SO-2611-004' } });
    fireEvent.change(screen.getByLabelText('Line 1 amount'), { target: { value: '100' } });
    const box = await screen.findByLabelText('Knock off HC-SI-2611-001', {}, { timeout: 2000 });
    expect(partyCalls).toContainEqual({ who: 'customer', id: 'HC-SO-2611-004', by: 'so' });
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }));
    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    expect(createAsync.mock.calls[0]![0]).toMatchObject({ kind: 'CN', soDocNo: 'HC-SO-2611-004', allocations: [{ kind: 'SI', id: 'si-1', amountSen: 10_000 }] });
  });
});
