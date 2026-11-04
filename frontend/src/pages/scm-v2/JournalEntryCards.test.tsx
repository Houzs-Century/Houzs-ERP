/* A journal entry opened, and a manual journal drafted (owner 2026-09-15,
   docs/bugs/0920: manual journal 数字，account name 都没有，然后没有办法 copy … code
   一行，name 一行 … 无法快速打关键字眼找 account), as the drawer of the owner's
   redesign (batch 6 §2.3 a4–a5). Pinned:
     · every line names its account — the code on one line, the name on the
       next — and a click on it opens the General ledger; the date shows once;
     · Post · Edit · Copy · Reverse only on a manual journal (owner question
       g3); a document's entry offers "Open <document>" and nothing that posts;
     · Copy hands the form the lines, the notes and the narration (never the
       date), and Save draft sends them again;
     · Save & post on a new journal is the create and then today's post; a
       refused post leaves the draft standing and the drawer on it;
     · the account is typed to, every word matching the code or the name;
     · Edit (owner 2026-09-15: 我无法 edit) opens the form on the entry's own
       date, number and lines — the parties kept — and Save & post goes to the
       edit, never to a create. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type { JournalEntry, JournalEntryLine } from '../../vendor/scm/lib/accounting-queries';
import type { JournalEntryCardData } from './accounting-phase1-queries';

const JE: JournalEntry = {
  id: 'je-163', je_no: '2990-JE-2606-0163', entry_date: '2026-06-30', source_type: 'MANUAL', source_doc_no: null,
  narration: "Salary - Jun'26", total_debit_sen: 2428465, total_credit_sen: 2428465, posted: true, posted_at: '2026-07-01T00:00:00Z', reversed: false, created_at: '',
};
const LINES: JournalEntryLine[] = [
  { id: 'l1', journal_entry_id: 'je-163', line_no: 1, account_code: '900-S100', debit_sen: 1920698, credit_sen: 0, party_type: null, party_code: null, party_name: null, notes: "Gross Salary - Jun'26" },
  { id: 'l2', journal_entry_id: 'je-163', line_no: 2, account_code: '410-0010', debit_sen: 0, credit_sen: 1920698, party_type: null, party_code: null, party_name: null, notes: "Net Salary - Jun'26" },
];
const ACCOUNTS = [
  { account_code: '900-S100', account_name: 'GROSS SALARY', account_type: 'EXPENSE', parent_code: null, is_active: true, acc_money: false, special_type: null },
  { account_code: '900-S500', account_name: 'STAFF ALLOWANCE', account_type: 'EXPENSE', parent_code: null, is_active: true, acc_money: false, special_type: null },
  { account_code: '410-0010', account_name: 'SALARY PAYABLE', account_type: 'LIABILITY', parent_code: null, is_active: true, acc_money: false, special_type: null },
];
const createMutateAsync = vi.fn();
const postMutate = vi.fn();
const postMutateAsync = vi.fn();
const reverseMutate = vi.fn();
const editMutateAsync = vi.fn();
let detail: JournalEntryCardData = { journalEntry: JE, lines: LINES };

vi.mock('../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/accounting-queries')>()),
  useAccounts: () => ({ data: { accounts: ACCOUNTS }, isLoading: false }),
  useCreateJournalEntry: () => ({ mutateAsync: createMutateAsync, isPending: false }),
  usePostJournalEntry: () => ({ mutate: postMutate, mutateAsync: postMutateAsync, isPending: false }),
}));
vi.mock('./accounting-phase1-queries', () => ({
  useJournalEntryCard: () => ({ data: detail, isLoading: false, isError: false }),
  useReverseJournalEntry: () => ({ mutate: reverseMutate, isPending: false }),
  useEditJournalEntry: () => ({ mutateAsync: editMutateAsync, isPending: false }),
}));

import { JeDetailCard, NewJournalForm, seedFromEntry, editSeedFromEntry, senToRm, rmToSen, journalDocumentHref, type DraftSeed, type EditSeed } from './JournalEntryCards';

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
);

describe('an entry opened', () => {
  test('every line names its account: the code on one line, the name on the next; the date once; a click opens the ledger', () => {
    const onOpenAccount = vi.fn();
    render(wrap(<JeDetailCard id="je-163" onClose={() => {}} onCopy={() => {}} onOpenAccount={onOpenAccount} />));
    const first = screen.getByText('900-S100').closest('button') as HTMLElement;
    expect(within(first).getByText('GROSS SALARY')).toBeTruthy();
    expect(first.querySelector('br')).toBeTruthy();
    expect(first.title).toBe('Open in General ledger');
    const second = screen.getByText('410-0010').closest('button') as HTMLElement;
    expect(within(second).getByText('SALARY PAYABLE')).toBeTruthy();
    expect(screen.getAllByText('2026/06/30')).toHaveLength(1);
    expect(screen.getByText("Salary - Jun'26")).toBeTruthy();
    expect(screen.getByText('Posted')).toBeTruthy();
    expect(screen.getByText('2990-JE-2606-0163')).toBeTruthy();
    /* The total row adds the lines. */
    expect(screen.getByText('Total').closest('[role="row"]')!.textContent).toContain('19,206.98');
    fireEvent.click(first);
    expect(onOpenAccount).toHaveBeenCalledWith('900-S100', '2026-06-30');
  });

  test('Copy hands over the lines, the notes and the narration — not the date — and only on a manual journal', () => {
    const onCopy = vi.fn();
    render(wrap(<JeDetailCard id="je-163" onClose={() => {}} onCopy={onCopy} />));
    fireEvent.click(screen.getByText('Copy'));
    expect(onCopy).toHaveBeenCalledTimes(1);
    const seed = onCopy.mock.calls[0]![0] as DraftSeed;
    expect(onCopy.mock.calls[0]![1]).toBe('2990-JE-2606-0163');
    expect(seed).toEqual({
      narration: "Salary - Jun'26",
      lines: [
        { accountCode: '900-S100', debit: '19206.98', credit: '', notes: "Gross Salary - Jun'26" },
        { accountCode: '410-0010', debit: '', credit: '19206.98', notes: "Net Salary - Jun'26" },
      ],
    });
    expect(seedFromEntry(JE, LINES)).toEqual(seed);
    expect(senToRm(0)).toBe('');
    expect(senToRm(143_65)).toBe('143.65');
    expect(rmToSen('1,234.50')).toBe(123450);
    expect(rmToSen('abc')).toBeNull();
  });

  test('a document’s entry opens its document and offers nothing that posts (g3)', () => {
    const onOpenDocument = vi.fn();
    detail = {
      journalEntry: { ...JE, id: 'je-9', je_no: '2990-JE-2609-0009', source_type: 'SI', source_doc_no: '2990-SI-2609-001', narration: 'Sales invoice 2990-SI-2609-001' },
      lines: LINES,
      document: { kind: 'SI', id: 'si-1', number: '2990-SI-2609-001' },
    };
    render(wrap(<JeDetailCard id="je-9" onClose={() => {}} onCopy={() => {}} onEdit={() => {}} onOpenDocument={onOpenDocument} />));
    for (const label of ['Post', 'Edit', 'Copy', 'Reverse']) expect(screen.queryByRole('button', { name: label })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open 2990-SI-2609-001' }));
    expect(onOpenDocument).toHaveBeenCalledWith('/scm/sales-invoices/si-1');
    expect(screen.getByText('SI · Sales invoice')).toBeTruthy();
    expect(screen.getByText(/Written by its document/)).toBeTruthy();
    detail = { journalEntry: JE, lines: LINES };
  });

  test('where each kind of document opens', () => {
    expect(journalDocumentHref({ kind: 'SO', id: 'HC-SO-2610-001', number: 'HC-SO-2610-001' })).toBe('/scm/sales-orders/HC-SO-2610-001');
    expect(journalDocumentHref({ kind: 'PV', id: 'pv-1', number: 'HPV-1' })).toBe('/scm/payment-vouchers/pv-1');
    expect(journalDocumentHref({ kind: 'PI', id: 'pi-1', number: 'PI-1' })).toBe('/scm/purchase-invoices/pi-1');
    expect(journalDocumentHref({ kind: 'API', id: 'api-1', number: 'API-1' })).toBe('/scm/ap-invoices/api-1');
    expect(journalDocumentHref({ kind: 'NOTE', id: 'cn-1', number: 'CN-1' })).toBe('/scm/credit-notes/cn-1');
    expect(journalDocumentHref({ kind: 'SUPPLIER_NOTE', id: 'scn-1', number: 'SCN-1' })).toBe('/scm/supplier-notes/scn-1');
  });

  test('a draft manual journal offers Post; a posted one Reverse; a reversed one only Copy', () => {
    detail = { journalEntry: { ...JE, posted: false, posted_at: null }, lines: LINES };
    const { unmount } = render(wrap(<JeDetailCard id="je-163" onClose={() => {}} onCopy={() => {}} onEdit={() => {}} />));
    expect(screen.getByText('Draft')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    expect(postMutate).toHaveBeenCalledWith('je-163', expect.anything());
    expect(screen.queryByRole('button', { name: 'Reverse' })).toBeNull();
    unmount();
    detail = { journalEntry: JE, lines: LINES };
    const posted = render(wrap(<JeDetailCard id="je-163" onClose={() => {}} onCopy={() => {}} onEdit={() => {}} />));
    expect(screen.queryByRole('button', { name: 'Post' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reverse' }));
    expect(reverseMutate).toHaveBeenCalledWith('je-163', expect.anything());
    posted.unmount();
    detail = { journalEntry: { ...JE, reversed: true }, lines: LINES };
    render(wrap(<JeDetailCard id="je-163" onClose={() => {}} onCopy={() => {}} onEdit={() => {}} />));
    expect(screen.getByText('Reversed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    for (const label of ['Post', 'Edit', 'Reverse']) expect(screen.queryByRole('button', { name: label })).toBeNull();
    detail = { journalEntry: JE, lines: LINES };
  });
});

describe('an entry edited', () => {
  const PARTY_LINES: JournalEntryLine[] = [
    { ...LINES[0]!, party_type: 'STAFF', party_code: 'S-07', party_name: 'Aina' },
    LINES[1]!,
  ];

  test('Edit hands over the entry — id, number, date, posted — and the lines with their parties; not on a system or a reversed entry', () => {
    const onEdit = vi.fn();
    detail = { journalEntry: JE, lines: PARTY_LINES };
    const first = render(wrap(<JeDetailCard id="je-163" onClose={() => {}} onEdit={onEdit} />));
    fireEvent.click(screen.getByText('Edit'));
    const seed = onEdit.mock.calls[0]![0] as EditSeed;
    expect(seed).toEqual({
      id: 'je-163', jeNo: '2990-JE-2606-0163', posted: true, entryDate: '2026-06-30', narration: "Salary - Jun'26",
      lines: [
        { accountCode: '900-S100', debit: '19206.98', credit: '', notes: "Gross Salary - Jun'26", partyType: 'STAFF', partyCode: 'S-07', partyName: 'Aina' },
        { accountCode: '410-0010', debit: '', credit: '19206.98', notes: "Net Salary - Jun'26", partyType: null, partyCode: null, partyName: null },
      ],
    });
    expect(editSeedFromEntry(JE, PARTY_LINES)).toEqual(seed);
    /* Copy still drops the party — a new month's salary line names a new person. */
    expect(seedFromEntry(JE, PARTY_LINES).lines[0]).toEqual({ accountCode: '900-S100', debit: '19206.98', credit: '', notes: "Gross Salary - Jun'26" });
    first.unmount();

    detail = { journalEntry: { ...JE, id: 'je-9', source_type: 'SOPAY' }, lines: LINES };
    const sys = render(wrap(<JeDetailCard id="je-9" onClose={() => {}} onEdit={onEdit} />));
    expect(screen.queryByText('Edit')).toBeNull();
    sys.unmount();
    detail = { journalEntry: { ...JE, id: 'je-8', reversed: true }, lines: LINES };
    render(wrap(<JeDetailCard id="je-8" onClose={() => {}} onEdit={onEdit} />));
    expect(screen.queryByText('Edit')).toBeNull();
    detail = { journalEntry: JE, lines: LINES };
  });

  test('opened for an edit: titled by the number, dated the entry\'s own day, and Save & post sends the id and the lines to the edit, never to a create', async () => {
    createMutateAsync.mockReset(); editMutateAsync.mockReset();
    editMutateAsync.mockResolvedValue({ journalEntry: { ...JE, id: 'je-200', je_no: '2990-JE-2611-0200' }, lineCount: 2, replaced: null });
    const onSaved = vi.fn();
    const seed = editSeedFromEntry(JE, PARTY_LINES);
    render(wrap(<NewJournalForm onCancel={() => {}} onSaved={onSaved} initial={seed} editing={seed} />));
    expect(screen.getByText('Edit 2990-JE-2606-0163')).toBeTruthy();
    expect(screen.getByText(/posted — saving reverses it on its own day/)).toBeTruthy();
    expect(screen.queryByText(/check the date, the figures/)).toBeNull();
    /* A posted entry is saved and posted in one step — there is no draft to keep. */
    expect(screen.queryByText('Save draft')).toBeNull();
    expect((screen.getByLabelText('Line 1 debit') as HTMLInputElement).value).toBe('19206.98');
    fireEvent.change(screen.getByLabelText('Line 1 debit'), { target: { value: '19000.00' } });
    fireEvent.change(screen.getByLabelText('Line 2 credit'), { target: { value: '19000.00' } });
    expect(screen.getByText('Balanced')).toBeTruthy();
    fireEvent.click(screen.getByText('Save & post'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('je-200'));
    expect(createMutateAsync).not.toHaveBeenCalled();
    expect(editMutateAsync).toHaveBeenCalledTimes(1);
    const body = editMutateAsync.mock.calls[0]![0] as { id: string; entryDate: string; narration: string | null; lines: unknown[] };
    expect(body.id).toBe('je-163');
    expect(body.entryDate).toBe('2026-06-30');
    expect(body.narration).toBe("Salary - Jun'26");
    expect(body.lines).toEqual([
      { accountCode: '900-S100', debitSen: 1900000, creditSen: 0, notes: "Gross Salary - Jun'26", partyType: 'STAFF', partyCode: 'S-07', partyName: 'Aina' },
      { accountCode: '410-0010', debitSen: 0, creditSen: 1900000, notes: "Net Salary - Jun'26" },
    ]);
  });

  test('a draft edited says so and may be saved as a draft', () => {
    const seed = editSeedFromEntry({ ...JE, posted: false }, LINES);
    render(wrap(<NewJournalForm onCancel={() => {}} onSaved={() => {}} initial={seed} editing={seed} />));
    expect(screen.getByText(/draft — saving rewrites it in place/)).toBeTruthy();
    expect(screen.getByText('Save draft')).toBeTruthy();
  });
});

describe('a manual journal drafted', () => {
  test('opened from a copy, the form carries the lines and Save draft sends them again', async () => {
    createMutateAsync.mockReset(); postMutateAsync.mockReset();
    createMutateAsync.mockResolvedValue({ journalEntry: { ...JE, id: 'je-new', je_no: '2990-JE-2611-0001', posted: false }, lineCount: 2 });
    const onSaved = vi.fn();
    render(wrap(<NewJournalForm onCancel={() => {}} onSaved={onSaved} initial={seedFromEntry(JE, LINES)} copiedFrom="2990-JE-2606-0163" />));
    expect(screen.getByText(/Copied from 2990-JE-2606-0163 — check the date, the figures and the notes/)).toBeTruthy();
    expect((screen.getByLabelText('Narration') as HTMLInputElement).value).toBe("Salary - Jun'26");
    expect((screen.getByLabelText('Line 1 account') as HTMLInputElement).value).toBe('900-S100 — GROSS SALARY');
    /* The box fills its column and names the account in full on hover (owner 2026-09-18: the name was clipped). */
    expect((screen.getByLabelText('Line 1 account') as HTMLInputElement).style.width).toBe('100%');
    expect((screen.getByLabelText('Line 1 account') as HTMLInputElement).title).toBe('900-S100 — GROSS SALARY');
    expect((screen.getByLabelText('Line 1 debit') as HTMLInputElement).value).toBe('19206.98');
    expect((screen.getByLabelText('Line 2 credit') as HTMLInputElement).value).toBe('19206.98');
    expect((screen.getByLabelText('Line 2 note') as HTMLInputElement).value).toBe("Net Salary - Jun'26");
    expect(screen.getByText('Balanced')).toBeTruthy();
    fireEvent.click(screen.getByText('Save draft'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('je-new'));
    expect(postMutateAsync).not.toHaveBeenCalled();
    expect(createMutateAsync).toHaveBeenCalledTimes(1);
    const body = createMutateAsync.mock.calls[0]![0] as { narration: string | null; lines: Array<{ accountCode: string; debitSen: number; creditSen: number; notes: string | null }> };
    expect(body.narration).toBe("Salary - Jun'26");
    expect(body.lines).toEqual([
      { accountCode: '900-S100', debitSen: 1920698, creditSen: 0, notes: "Gross Salary - Jun'26" },
      { accountCode: '410-0010', debitSen: 0, creditSen: 1920698, notes: "Net Salary - Jun'26" },
    ]);
  });

  test('Save & post is the create and then today’s post; a refused post keeps the draft and opens it', async () => {
    createMutateAsync.mockReset(); postMutateAsync.mockReset();
    createMutateAsync.mockResolvedValue({ journalEntry: { ...JE, id: 'je-new', je_no: '2990-JE-2611-0001', posted: false }, lineCount: 2 });
    postMutateAsync.mockRejectedValue(new Error('Account 410-0010 is inactive.'));
    const onSaved = vi.fn();
    render(wrap(<NewJournalForm onCancel={() => {}} onSaved={onSaved} initial={seedFromEntry(JE, LINES)} />));
    fireEvent.click(screen.getByText('Save & post'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('je-new'));
    expect(createMutateAsync).toHaveBeenCalledTimes(1);
    expect(postMutateAsync).toHaveBeenCalledWith('je-new');
  });

  test('the totals say when debits and credits disagree', () => {
    render(wrap(<NewJournalForm onCancel={() => {}} onSaved={() => {}} />));
    fireEvent.change(screen.getByLabelText('Line 1 debit'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Line 2 credit'), { target: { value: '90' } });
    expect(screen.getByText('Out by 10.00')).toBeTruthy();
    expect((screen.getByText('Save & post') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Line 2 credit'), { target: { value: 'ten' } });
    expect(screen.getByText('Check the amounts')).toBeTruthy();
  });

  test('the account is found by typing a word of its code or its name', () => {
    render(wrap(<NewJournalForm onCancel={() => {}} onSaved={() => {}} />));
    const box = screen.getByLabelText('Line 1 account') as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'allow' } });
    expect(screen.getByRole('option', { name: /900-S500 — STAFF ALLOWANCE/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /GROSS SALARY/ })).toBeNull();
    fireEvent.mouseDown(screen.getByText('900-S500 — STAFF ALLOWANCE'));
    expect(box.value).toBe('900-S500 — STAFF ALLOWANCE');
    fireEvent.change(screen.getByLabelText('Line 2 account'), { target: { value: '410 sal' } });
    expect(screen.getByRole('option', { name: /410-0010 — SALARY PAYABLE/ })).toBeTruthy();
  });
});
