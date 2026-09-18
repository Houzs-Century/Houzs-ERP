/* A journal entry opened, and a manual journal drafted (owner 2026-09-15,
   docs/bugs/0920: manual journal 数字，account name 都没有，然后没有办法 copy … code
   一行，name 一行 … 无法快速打关键字眼找 account). Pinned:
     · every line names its account — the code on one line, the name on the
       next — and the header prints the date once;
     · Copy, on a manual journal, hands the form the lines, the notes and the
       narration (never the date), and Save draft sends them again;
     · the account is typed to, every word matching the code or the name;
     · Edit (owner 2026-09-15: 我无法 edit) opens the form on the entry's own
       date, number and lines — the parties kept — and Save goes to the edit,
       "Save & post" on a posted entry, never to a create. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { JournalEntry, JournalEntryLine } from '../../vendor/scm/lib/accounting-queries';

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
const createMutate = vi.fn();
const postMutate = vi.fn();
const reverseMutate = vi.fn();
const editMutate = vi.fn();
let detail: { journalEntry: JournalEntry; lines: JournalEntryLine[] } = { journalEntry: JE, lines: LINES };

vi.mock('../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/accounting-queries')>()),
  useAccounts: () => ({ data: { accounts: ACCOUNTS }, isLoading: false }),
  useJournalEntryDetail: () => ({ data: detail, isLoading: false }),
  useCreateJournalEntry: () => ({ mutate: createMutate, isPending: false }),
  usePostJournalEntry: () => ({ mutate: postMutate, isPending: false }),
}));
vi.mock('./accounting-phase1-queries', () => ({
  useReverseJournalEntry: () => ({ mutate: reverseMutate, isPending: false }),
  useEditJournalEntry: () => ({ mutate: editMutate, isPending: false }),
}));

import { JeDetailCard, NewJournalForm, seedFromEntry, editSeedFromEntry, senToRm, type DraftSeed, type EditSeed } from './JournalEntryCards';

describe('an entry opened', () => {
  test('every line names its account: the code on one line, the name on the next; the date once', () => {
    render(<JeDetailCard id="je-163" onClose={() => {}} onCopy={() => {}} />);
    const first = screen.getByText('900-S100').closest('td') as HTMLElement;
    expect(within(first).getByText('GROSS SALARY')).toBeTruthy();
    expect(first.querySelector('br')).toBeTruthy();
    const second = screen.getByText('410-0010').closest('td') as HTMLElement;
    expect(within(second).getByText('SALARY PAYABLE')).toBeTruthy();
    expect(screen.getAllByText('30/06/2026')).toHaveLength(1);
    expect(screen.getByText("Salary - Jun'26")).toBeTruthy();
    expect(screen.getByText('POSTED')).toBeTruthy();
  });

  test('Copy hands over the lines, the notes and the narration — not the date — and only on a manual journal', () => {
    const onCopy = vi.fn();
    render(<JeDetailCard id="je-163" onClose={() => {}} onCopy={onCopy} />);
    fireEvent.click(screen.getByText('Copy'));
    expect(onCopy).toHaveBeenCalledTimes(1);
    const seed = onCopy.mock.calls[0]![0] as DraftSeed;
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
    /* A system entry has no Copy. */
    detail = { journalEntry: { ...JE, id: 'je-9', source_type: 'SOPAY' }, lines: LINES };
    render(<JeDetailCard id="je-9" onClose={() => {}} onCopy={onCopy} />);
    expect(screen.getAllByText('Copy')).toHaveLength(1);
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
    render(<JeDetailCard id="je-163" onClose={() => {}} onEdit={onEdit} />);
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

    detail = { journalEntry: { ...JE, id: 'je-9', source_type: 'SOPAY' }, lines: LINES };
    render(<JeDetailCard id="je-9" onClose={() => {}} onEdit={onEdit} />);
    expect(screen.getAllByText('Edit')).toHaveLength(1);
    detail = { journalEntry: { ...JE, id: 'je-8', reversed: true }, lines: LINES };
    render(<JeDetailCard id="je-8" onClose={() => {}} onEdit={onEdit} />);
    expect(screen.getAllByText('Edit')).toHaveLength(1);
    detail = { journalEntry: JE, lines: LINES };
  });

  test('opened for an edit: titled by the number, dated the entry\'s own day, and Save & post sends the id and the lines to the edit, never to a create', () => {
    createMutate.mockClear(); editMutate.mockClear();
    const seed = editSeedFromEntry(JE, PARTY_LINES);
    render(<NewJournalForm onDone={() => {}} initial={seed} editing={seed} />);
    expect(screen.getByText('Edit 2990-JE-2606-0163')).toBeTruthy();
    expect(screen.getByText(/posted — saving reverses it on its own day/)).toBeTruthy();
    expect(screen.queryByText(/copied — check the date/)).toBeNull();
    expect((screen.getByLabelText('Line 1 debit') as HTMLInputElement).value).toBe('19206.98');
    fireEvent.change(screen.getByLabelText('Line 1 debit'), { target: { value: '19000.00' } });
    fireEvent.change(screen.getByLabelText('Line 2 credit'), { target: { value: '19000.00' } });
    expect(screen.getByText('balanced')).toBeTruthy();
    fireEvent.click(screen.getByText('Save & post'));
    expect(createMutate).not.toHaveBeenCalled();
    expect(editMutate).toHaveBeenCalledTimes(1);
    const body = editMutate.mock.calls[0]![0] as { id: string; entryDate: string; narration: string | null; lines: unknown[] };
    expect(body.id).toBe('je-163');
    expect(body.entryDate).toBe('2026-06-30');
    expect(body.narration).toBe("Salary - Jun'26");
    expect(body.lines).toEqual([
      { accountCode: '900-S100', debitSen: 1900000, creditSen: 0, notes: "Gross Salary - Jun'26", partyType: 'STAFF', partyCode: 'S-07', partyName: 'Aina' },
      { accountCode: '410-0010', debitSen: 0, creditSen: 1900000, notes: "Net Salary - Jun'26" },
    ]);
  });

  test('a draft edited says so and saves as a draft', () => {
    const seed = editSeedFromEntry({ ...JE, posted: false }, LINES);
    render(<NewJournalForm onDone={() => {}} initial={seed} editing={seed} />);
    expect(screen.getByText(/draft — saving rewrites it in place/)).toBeTruthy();
    expect(screen.getByText('Save draft')).toBeTruthy();
    expect(screen.queryByText('Save & post')).toBeNull();
  });
});

describe('a manual journal drafted', () => {
  test('opened from a copy, the form carries the lines and Save draft sends them again', () => {
    createMutate.mockClear();
    render(<NewJournalForm onDone={() => {}} initial={seedFromEntry(JE, LINES)} />);
    expect(screen.getByText(/copied — check the date/)).toBeTruthy();
    expect((screen.getByPlaceholderText('Narration (what is this entry?)') as HTMLInputElement).value).toBe("Salary - Jun'26");
    expect((screen.getByLabelText('Line 1 account') as HTMLInputElement).value).toBe('900-S100 — GROSS SALARY');
    /* The box fills its column and names the account in full on hover (owner 2026-09-18: the name was clipped). */
    expect((screen.getByLabelText('Line 1 account') as HTMLInputElement).style.width).toBe('100%');
    expect((screen.getByLabelText('Line 1 account') as HTMLInputElement).title).toBe('900-S100 — GROSS SALARY');
    expect((screen.getByLabelText('Line 1 debit') as HTMLInputElement).value).toBe('19206.98');
    expect((screen.getByLabelText('Line 2 credit') as HTMLInputElement).value).toBe('19206.98');
    expect((screen.getByLabelText('Line 2 note') as HTMLInputElement).value).toBe("Net Salary - Jun'26");
    expect(screen.getByText('balanced')).toBeTruthy();
    fireEvent.click(screen.getByText('Save draft'));
    expect(createMutate).toHaveBeenCalledTimes(1);
    const body = createMutate.mock.calls[0]![0] as { narration: string | null; lines: Array<{ accountCode: string; debitSen: number; creditSen: number; notes: string | null }> };
    expect(body.narration).toBe("Salary - Jun'26");
    expect(body.lines).toEqual([
      { accountCode: '900-S100', debitSen: 1920698, creditSen: 0, notes: "Gross Salary - Jun'26" },
      { accountCode: '410-0010', debitSen: 0, creditSen: 1920698, notes: "Net Salary - Jun'26" },
    ]);
  });

  test('the account is found by typing a word of its code or its name', () => {
    render(<NewJournalForm onDone={() => {}} />);
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
