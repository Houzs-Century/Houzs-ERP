/* Bank statements › No entry found › Record journal (owner 2026-11-03 on d10:
   「这样需要」 — the journal only). Pinned:
     · which lines may be recorded: an open line of money nothing fits and no
       card report is owed by — never a card payout, never a matched line;
     · the form opens on the line's day with the bank's leg fixed — Cr the bank
       for money out, Dr it for money in, to the sen — and the other side
       ready for its account; the narration is the line's;
     · Save & post looks at the month first, then makes the draft, posts it
       with today's call and matches the line with today's call — in that
       order;
     · a locked month, a line no longer open, or an entry that fits the line
       now refuses before anything is written;
     · a match refused after the post is said plainly, and pressing again asks
       the match only — never a second journal; a line found already matched
       to that entry is done; a line matched elsewhere meanwhile is left alone;
     · a refused post leaves the draft, and pressing again posts that same
       draft — never a second one. */

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { BankLine } from './bank-queries';

const ACCOUNTS = [
  { account_code: '310-0010', account_name: 'MAYBANK 5144', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true, special_type: null },
  { account_code: '903-0001', account_name: 'BANK CHARGES', account_type: 'EXPENSE', parent_code: null, is_active: true, acc_money: false, special_type: null },
  { account_code: '590-0005', account_name: 'INTEREST RECEIVED', account_type: 'INCOME', parent_code: null, is_active: true, acc_money: false, special_type: null },
];
type Seen = { id: number; state: string; posted_je_no: string | null; entryCandidates: Array<{ jeNo: string }> };
const OPEN_NOW: Seen = { id: 41, state: 'OPEN', posted_je_no: null, entryCandidates: [] };
const calls: string[] = [];
const seen = (lines: Seen[], lock: unknown = null) => async () => { calls.push('look'); return { lock, lines }; };
const create = vi.fn(async (_body: unknown) => { calls.push('create'); return { journalEntry: { id: 'je-9', je_no: 'HC-JE-2610-0901' } }; });
const edit = vi.fn(async (_body: unknown) => { calls.push('edit'); return { journalEntry: { id: 'je-9', je_no: 'HC-JE-2610-0901' } }; });
const post = vi.fn(async (id: string) => { calls.push(`post ${id}`); return { journalEntry: { id, je_no: 'HC-JE-2610-0901' } }; });
const match = vi.fn(async (v: { lineId: number; jeNo: string }) => { calls.push(`match ${v.lineId} ${v.jeNo}`); return { ok: true }; });
const month = vi.fn(seen([OPEN_NOW]));

vi.mock('../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/accounting-queries')>()),
  useAccounts: () => ({ data: { accounts: ACCOUNTS }, isLoading: false }),
  useCreateJournalEntry: () => ({ mutateAsync: create, isPending: false }),
  usePostJournalEntry: () => ({ mutate: vi.fn(), mutateAsync: post, isPending: false }),
}));
vi.mock('./accounting-phase1-queries', () => ({
  useJournalEntryCard: () => ({ data: undefined, isLoading: true, isError: false }),
  useReverseJournalEntry: () => ({ mutate: vi.fn(), isPending: false }),
  useEditJournalEntry: () => ({ mutateAsync: edit, isPending: false }),
}));
vi.mock('./bank-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bank-queries')>()),
  fetchBankMonth: () => month(),
  useMatchBankLine: () => ({ mutateAsync: match, isPending: false }),
}));

import { BankRecordJournal, recordableLine } from './BankRecordJournal';

const LINE: BankLine = {
  id: 41, line_no: 12, booked_on: '2026-10-23', description: 'SERVICE CHARGE IBG', reference: 'SC 2310',
  amount_sen: -2500, charge_sen: 0, kind: 'OTHER', acquirer_code: null, trading_date: null, merchant_no: null,
  matched_batch_id: null, split: null, state: 'OPEN', posted_je_no: null, note: null, matches: [], candidates: [], entryCandidates: [],
};
const wrap = (ui: ReactNode) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>;
const draw = (line: BankLine = LINE) => {
  const onClose = vi.fn();
  const onToast = vi.fn();
  render(wrap(<BankRecordJournal line={line} accountCode="310-0010" onClose={onClose} onToast={onToast} />));
  return { onClose, onToast };
};
/* The other side's account, typed to and picked — then Save & post. */
const recordAsCharge = () => {
  const box = screen.getByLabelText('Line 1 account') as HTMLInputElement;
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: 'charges' } });
  fireEvent.mouseDown(screen.getByRole('option', { name: /903-0001 — BANK CHARGES/ }));
  fireEvent.click(screen.getByText('Save & post'));
};
const alertText = () => screen.getByRole('alert').textContent;

beforeEach(() => {
  calls.length = 0;
  for (const m of [create, edit, post, match, month]) m.mockClear();
  month.mockImplementation(seen([OPEN_NOW]));
  match.mockImplementation(async (v) => { calls.push(`match ${v.lineId} ${v.jeNo}`); return { ok: true }; });
  post.mockImplementation(async (id) => { calls.push(`post ${id}`); return { journalEntry: { id, je_no: 'HC-JE-2610-0901' } }; });
});

describe('which lines may be recorded', () => {
  test('an open line nothing fits; never a card payout, a line something may fit, or a decided one', () => {
    expect(recordableLine(LINE)).toBe(true);
    expect(recordableLine({ ...LINE, amount_sen: 1200 })).toBe(true);
    expect(recordableLine({ ...LINE, kind: 'PAYOUT_NO_BATCH' })).toBe(false);
    expect(recordableLine({ ...LINE, state: 'POSTED' })).toBe(false);
    expect(recordableLine({ ...LINE, state: 'IGNORED' })).toBe(false);
    expect(recordableLine({ ...LINE, entryCandidates: [{ jeNo: 'JE-1' }] as unknown as BankLine['entryCandidates'] })).toBe(false);
    expect(recordableLine({ ...LINE, candidates: [{ id: 7 }] as unknown as BankLine['candidates'] })).toBe(false);
  });
});

describe('Record journal', () => {
  test('opens on the line’s day with the bank’s leg fixed — Cr the bank for money out — and the other side ready for its account', () => {
    draw();
    expect(screen.getByText('Record journal')).toBeTruthy();
    expect(screen.getByText(/Bank line 12 · 2026\/10\/23 · Out 25\.00/)).toBeTruthy();
    expect(screen.getByLabelText('Date').textContent).toBe('2026/10/23');
    expect(screen.getByLabelText("The bank's leg").textContent).toContain('310-0010 — MAYBANK 5144');
    expect(screen.getByLabelText('Bank credit').textContent).toBe('25.00');
    expect(screen.getByLabelText('Bank debit').textContent).toBe('');
    expect((screen.getByLabelText('Line 1 debit') as HTMLInputElement).value).toBe('25.00');
    expect((screen.getByLabelText('Narration') as HTMLInputElement).value).toBe('SC 2310 · SERVICE CHARGE IBG');
    /* No draft from a bank line: it is posted and matched, or nothing. */
    expect(screen.queryByText('Save draft')).toBeNull();
    expect((screen.getByText('Save & post') as HTMLButtonElement).disabled).toBe(true);
  });

  test('the other side is any account but the bank’s own — its leg is already there', () => {
    draw();
    const box = screen.getByLabelText('Line 1 account') as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '0' } });
    expect(screen.getByRole('option', { name: /903-0001 — BANK CHARGES/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /310-0010/ })).toBeNull();
  });

  test('money in: Dr the bank, the other side a credit', () => {
    draw({ ...LINE, amount_sen: 1234, description: 'INTEREST CREDIT', reference: null });
    expect(screen.getByText(/· In 12\.34/)).toBeTruthy();
    expect(screen.getByLabelText('Bank debit').textContent).toBe('12.34');
    expect((screen.getByLabelText('Line 1 credit') as HTMLInputElement).value).toBe('12.34');
    expect((screen.getByLabelText('Narration') as HTMLInputElement).value).toBe('INTEREST CREDIT');
  });

  test('Save & post: the month is looked at, the draft made and posted with today’s calls, then the line matched to it — in that order', async () => {
    const { onClose, onToast } = draw();
    recordAsCharge();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toEqual(['look', 'create', 'post je-9', 'look', 'match 41 HC-JE-2610-0901']);
    expect(create.mock.calls[0]![0]).toEqual({
      entryDate: '2026-10-23', narration: 'SC 2310 · SERVICE CHARGE IBG',
      lines: [
        { accountCode: '310-0010', debitSen: 0, creditSen: 2500, notes: 'Bank line 12' },
        { accountCode: '903-0001', debitSen: 2500, creditSen: 0, notes: null },
      ],
    });
    expect(onToast).toHaveBeenCalledWith('Posted HC-JE-2610-0901 · matched to bank line 12');
  });

  test('a locked month refuses before anything is written', async () => {
    month.mockImplementation(seen([OPEN_NOW], { lockedBy: 'Finance' }));
    draw();
    recordAsCharge();
    await waitFor(() => expect(alertText()).toContain('October 2026 is locked for 310-0010, so nothing was written'));
    expect(calls).toEqual(['look']);
  });

  test('a month that cannot be read refuses before anything is written', async () => {
    month.mockImplementation(async () => { calls.push('look'); throw new Error('Failed to fetch'); });
    draw();
    recordAsCharge();
    await waitFor(() => expect(alertText()).toContain('The bank line could not be checked, so nothing was written: Failed to fetch. Try again.'));
    expect(calls).toEqual(['look']);
  });

  test('a line matched meanwhile refuses before anything is written', async () => {
    month.mockImplementation(seen([{ ...OPEN_NOW, state: 'POSTED', posted_je_no: 'JE-2610-0007' }]));
    draw();
    recordAsCharge();
    await waitFor(() => expect(alertText()).toContain('no longer open'));
    expect(calls).toEqual(['look']);
  });

  test('an entry that fits the line now is matched, never recorded a second time', async () => {
    month.mockImplementation(seen([{ ...OPEN_NOW, entryCandidates: [{ jeNo: 'HC-JE-2610-0901' }] }]));
    draw();
    recordAsCharge();
    await waitFor(() => expect(alertText()).toContain('HC-JE-2610-0901 now fits this line, so nothing was written. Match it under To match.'));
    expect(calls).toEqual(['look']);
  });

  test('a match refused after the post is said plainly; pressing again asks the match only — never a second journal', async () => {
    match.mockImplementationOnce(async (v) => { calls.push(`match ${v.lineId} ${v.jeNo}`); throw new Error('Whether this month is closed could not be checked, so nothing was changed. Try again.'); });
    const { onClose } = draw();
    recordAsCharge();
    await waitFor(() => expect(alertText()).toContain('Posted HC-JE-2610-0901, but the bank line was not matched: Whether this month is closed'));
    expect(alertText()).toContain('The line stays open — match it to HC-JE-2610-0901 by hand, or press Match again.');
    expect(onClose).not.toHaveBeenCalled();
    /* Posted: the lines can no longer change, and the button only asks the match again. */
    expect(screen.getByLabelText('Line 1 debit').closest('fieldset')!.disabled).toBe(true);
    fireEvent.click(screen.getByText('Match again'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toEqual(['look', 'create', 'post je-9', 'look', 'match 41 HC-JE-2610-0901', 'look', 'match 41 HC-JE-2610-0901']);
    expect(create).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  test('a line found already matched to the posted entry is done — the match is not asked twice', async () => {
    month
      .mockImplementationOnce(seen([OPEN_NOW]))
      .mockImplementationOnce(seen([{ ...OPEN_NOW, state: 'POSTED', posted_je_no: 'HC-JE-2610-0901' }]));
    const { onClose, onToast } = draw();
    recordAsCharge();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toEqual(['look', 'create', 'post je-9', 'look']);
    expect(onToast).toHaveBeenCalledWith('Posted HC-JE-2610-0901 · matched to bank line 12');
  });

  test('a line matched to another entry meanwhile is left as it is, and said', async () => {
    month
      .mockImplementationOnce(seen([OPEN_NOW]))
      .mockImplementationOnce(seen([{ ...OPEN_NOW, state: 'POSTED', posted_je_no: 'JE-2610-0007' }]));
    const { onClose } = draw();
    recordAsCharge();
    await waitFor(() => expect(alertText()).toContain('Posted HC-JE-2610-0901, but the bank line was matched or set aside meanwhile, so it was left as it is.'));
    expect(alertText()).toContain('HC-JE-2610-0901 is not needed — reverse it in Journal entries.');
    expect(calls).toEqual(['look', 'create', 'post je-9', 'look']);
    expect(match).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('a refused post leaves the draft; pressing again posts that same draft — never a second one', async () => {
    post.mockImplementationOnce(async (id) => { calls.push(`post ${id}`); throw new Error('refused'); });
    const { onClose } = draw();
    recordAsCharge();
    await waitFor(() => expect(alertText()).toContain('HC-JE-2610-0901 is saved as a draft but was not posted'));
    fireEvent.click(screen.getByText('Save & post'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toEqual(['look', 'create', 'post je-9', 'look', 'edit', 'post je-9', 'look', 'match 41 HC-JE-2610-0901']);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
