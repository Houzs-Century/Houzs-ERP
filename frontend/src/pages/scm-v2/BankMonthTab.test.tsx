// The MONTH screen's render contract. The assembling rules are pinned on the
// server (backend/src/acc/bank-month.test.ts); what is proved here is that the
// screen says them out loud rather than presenting a month it cannot stand up:
//
//   • a month missing a day says so ABOVE the verdict, and names both files,
//     both dates and the amount that moved between them — a difference read
//     carefully off an incomplete month is the wrong number read carefully;
//   • the opening and closing figures name the file they were taken off, so a
//     balance is never a number nobody can check;
//   • a file that straddles the month end is listed and labelled, because its
//     movements DO count here and its balances do not;
//   • the month reuses the file screen's own rows, so a movement has one set of
//     buttons wherever it is looked at.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { BankLine, BankMonth, BankMonthAssembly, BankMonthBalances, Reconciliation } from './bank-queries';

const MONTH: BankMonth = {
  accountCode: '310-0020', month: '2026-09',
  statementCount: 3, lineCount: 12,
  openCount: 2, openSen: 312306, openPayoutCount: 1,
  inSen: 3032963, outSen: 352894,
  periodFrom: '2026-09-01', periodTo: '2026-09-03',
  openingBalanceSen: 1000000, closingBalanceSen: 1090000,
  complete: true, gapCount: 0, locked: null,
};

const ASSEMBLY: BankMonthAssembly = {
  month: '2026-09', monthFrom: '2026-09-01', monthTo: '2026-09-30',
  periodFrom: '2026-09-01', periodTo: '2026-09-03',
  statementOpeningSen: 1000000,
  openingFrom: { statementId: 1, fileName: 'd01.csv', on: '2026-09-01' },
  statementClosingSen: 1090000,
  closingFrom: { statementId: 3, fileName: 'd03.csv', on: '2026-09-03' },
  spanningIds: [], breaks: [], gaps: [], complete: true,
};

const RECON: Reconciliation = {
  periodFrom: '2026-09-01', periodTo: '2026-09-03',
  openingStatementSen: 1000000, openingLedgerSen: 1000000, broughtForwardSen: 0,
  movementsStatementSen: 90000, movementsLedgerSen: 0,
  closingStatementSen: 1090000, closingLedgerSen: 1000000, differenceSen: 90000,
  bankNotInBooks: { count: 2, sen: 90000 },
  booksNotOnBank: { count: 0, sen: 0 },
  unmatchedJeNos: [],
  carried: { count: 0, sen: 0 }, carriedJeNos: [], broughtForwardExplained: null,
  outstandingPayments: { count: 0, sen: 0 }, outstandingReceipts: { count: 0, sen: 0 }, outstandingJeNos: [],
  computedClosingSen: 1090000, unexplainedSen: 0, tallies: true,
  consistent: true, inconsistency: null, reconciled: false,
};

const LINE: BankLine & { file_name: string | null } = {
  id: 1, line_no: 2, booked_on: '2026-09-01',
  description: 'CR/CARD SALES MN 32409997', reference: '99970814',
  amount_sen: 60000, charge_sen: 0, kind: 'PAYOUT',
  acquirer_code: 'HLB', trading_date: '2026-09-01', merchant_no: '32409997',
  matched_batch_id: null, split: null, state: 'OPEN', posted_je_no: null, note: null,
  matches: [], candidates: [], entryCandidates: [], file_name: 'd01.csv',
};

const STATEMENTS = [
  { id: 1, account_code: '310-0020', file_name: 'd01.csv', period_from: '2026-09-01', period_to: '2026-09-01', opening_balance_sen: 1000000, closing_balance_sen: 1050000, spanning: false },
  { id: 3, account_code: '310-0020', file_name: 'd03.csv', period_from: '2026-09-03', period_to: '2026-09-03', opening_balance_sen: 1020000, closing_balance_sen: 1090000, spanning: false },
];

/* vi.hoisted, because a vi.mock factory runs before the consts above exist —
   the mutable handles have to be created in the hoisted block or every test
   reads undefined. */
const state = vi.hoisted(() => ({
  months: [] as unknown[],
  assembly: null as unknown,
  recon: null as unknown,
  lines: [] as unknown[],
  statements: [] as unknown[],
  lock: null as unknown,
  balances: null as unknown,
  repeats: undefined as unknown,
  autoMatch: vi.fn(),
  typeClosing: vi.fn(),
  leaveOut: vi.fn(),
  todo: [] as unknown[],
  entries: [] as unknown[],
  match: vi.fn(),
  book: vi.fn(),
  /* Whether the person may post a manual journal and match bank lines (Record journal). */
  mayPost: true,
}));

/* The A4 statement's letterhead and who printed it. */
vi.mock('../../hooks/useBranding', () => ({ useBranding: () => ({ companyName: 'Houzs Century', companyCode: 'HC' }) }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { name: 'Chew', email: 'chew@example.com' }, can: () => state.mayPost }) }));

/* Record journal opens the manual journal form, which names the bank's account from the chart. */
vi.mock('../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/accounting-queries')>()),
  useAccounts: () => ({
    data: { accounts: [{ account_code: '310-0020', account_name: 'HONG LEONG BANK', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true, special_type: null }] },
    isLoading: false,
  }),
}));

/* To do's own "upload the statement" rule says where the uploads stop. */
vi.mock('./finance/finance-todo-queries', () => ({ useFinanceTodo: () => ({ data: { mine: state.todo, others: [] } }) }));

/* The failed-print notice needs the app's notify; the tab is mounted without
   the provider here, so the hook is a spy. */
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => vi.fn() }));

vi.mock('./bank-queries', () => ({
  useBankMonths: () => ({ data: { months: state.months }, isLoading: false }),
  useBankMonth: () => ({
    data: {
      accountCode: '310-0020', month: '2026-09',
      assembly: state.assembly, reconciliation: state.recon, lock: state.lock,
      balances: state.balances,
      statements: state.statements, lines: state.lines, unmatchedEntries: state.entries,
      repeats: state.repeats,
    },
    isLoading: false,
  }),
  /* The file screen's rows come with it; the month renders them, so their hooks
     have to exist even where this screen never presses them. */
  useBankSetup: () => ({ data: { accounts: [], recognises: [] }, isLoading: false }),
  useBankStatements: () => ({ data: { statements: [] }, isLoading: false }),
  useBankStatement: () => ({ data: undefined, isLoading: false }),
  useUploadBankStatement: () => ({ mutate: vi.fn(), isPending: false }),
  useBookBankReceipt: () => ({ mutate: state.book, mutateAsync: vi.fn(), isPending: false, isError: false, error: null }),
  useMatchBankGroup: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useMatchBankLine: () => ({ mutate: state.match, mutateAsync: vi.fn(), isPending: false, isError: false, error: null }),
  fetchBankMonth: vi.fn(),
  invalidateAfterBankPosting: vi.fn(),
  useIgnoreBankLine: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useUndoBankLine: () => ({ mutate: vi.fn(), isPending: false }),
  useLockBankMonth: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useUnlockBankMonth: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useAutoMatchStatement: () => ({ mutate: vi.fn(), mutateAsync: state.autoMatch, isPending: false, isError: false, error: null }),
  useTypeMonthClosing: () => ({ mutate: state.typeClosing, isPending: false, isError: false, error: null }),
  useLeaveOutRepeats: () => ({ mutateAsync: state.leaveOut, isPending: false }),
}));

import { BankMonthTab, monthLabel, parseRm, previousMonthOf } from './BankMonthTab';

/* jsdom does not scroll; the walk's chips scroll to the tabs they open. */
Element.prototype.scrollIntoView = vi.fn();

const setUp = (over: {
  months?: unknown[]; assembly?: BankMonthAssembly; recon?: Reconciliation;
  lines?: unknown[]; statements?: unknown[]; lock?: unknown; balances?: BankMonthBalances;
  repeats?: { count: number; statementIds: number[] }; mayPost?: boolean;
} = {}) => {
  state.mayPost = over.mayPost ?? true;
  state.months = over.months ?? [MONTH];
  state.assembly = over.assembly ?? ASSEMBLY;
  state.recon = over.recon ?? RECON;
  state.lines = over.lines ?? [LINE];
  state.statements = over.statements ?? STATEMENTS;
  state.lock = over.lock ?? null;
  state.balances = over.balances ?? { closing: null, previousClosing: null };
  state.repeats = over.repeats;
  state.autoMatch.mockReset();
  state.typeClosing.mockReset();
  state.leaveOut.mockReset();
  state.todo = [];
  state.match.mockReset();
  state.book.mockReset();
  state.entries = [];
};

/* The print dialog this screen mounts reads the company branding through
   react-query, so the tree needs a client — the same wrapper NotificationBell's
   test uses. Retries off: a test that waits out a retry is a slow test that
   still fails. */
const show = (at = '/scm/bank-recon') => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[at]}><BankMonthTab /></MemoryRouter>
  </QueryClientProvider>,
);

/* The redesign opens a month by itself: the account with lines to decide, its oldest month not yet locked. */
const openMonth = () => show();

describe('the accounts and their months', () => {
  test('names the month in the numeric shape the rest of the ERP uses', () => {
    expect(monthLabel('2026-09')).toBe('09/2026');
    expect(monthLabel('2026-01')).toBe('01/2026');
    /* Anything that is not a month is shown as it came rather than guessed at. */
    expect(monthLabel('rubbish')).toBe('rubbish');
  });

  test('a card per account says what is left to decide, and where its statements stand', () => {
    setUp({ months: [MONTH, { ...MONTH, accountCode: '310-0010', month: '2026-08', openCount: 0, statementCount: 5 }] });
    show();
    expect(screen.getByText('2 lines to decide')).toBeTruthy();
    expect(screen.getByText('All matched · 2026/08 not locked yet')).toBeTruthy();
    /* The account with lines to decide comes up, and its month opens below. */
    expect(screen.getByText('310-0020 statements')).toBeTruthy();
    expect(screen.getByText('September 2026')).toBeTruthy();
  });

  test('a month chip says what is left on it', () => {
    setUp();
    show();
    const chip = screen.getByRole('button', { name: /^2026\/09/ });
    expect(chip.textContent).toContain('2 to decide');
    expect(chip.getAttribute('aria-pressed')).toBe('true');
  });

  test('marks a month that is missing something', () => {
    setUp({ months: [{ ...MONTH, complete: false, gapCount: 2 }] });
    show();
    expect(screen.getByRole('button', { name: /^2026\/09/ }).textContent).toContain('Missing days');
  });

  test('says nothing about months when none came back', () => {
    setUp({ months: [] });
    show();
    expect(screen.getByText(/No bank account takes statements in this company yet/)).toBeTruthy();
    expect(screen.queryByText('to decide')).toBeNull();
  });

  /* Owner, 2026-09-13: by month 这里我无法分辨什么也会，你可能做成两个 tab? One
     account's months at a time; the other account is one press on its card. */
  test('shows one account at a time, the other one press away on its card', () => {
    setUp({ months: [MONTH, { ...MONTH, accountCode: '310-0010', month: '2026-08', openCount: 0, statementCount: 5 }] });
    show();
    expect(screen.queryByRole('button', { name: /^2026\/08/ })).toBeNull();
    fireEvent.click(screen.getByText('All matched · 2026/08 not locked yet'));
    expect(screen.getByText('310-0010 statements')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^2026\/08/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^2026\/09/ })).toBeNull();
  });

  test('every month sits under All months, by year', () => {
    setUp({ months: [MONTH, { ...MONTH, month: '2026-08', openCount: 0 }, { ...MONTH, month: '2025-12', openCount: 0, locked: { lockedBy: 'Chew', lockedAt: '2026-01-05T03:00:00Z' } }] });
    show();
    fireEvent.click(screen.getByText('All months'));
    const pop = screen.getByRole('dialog', { name: 'All months' });
    expect(pop.textContent).toContain('2025');
    expect(pop.textContent).toContain('December');
    expect(pop.textContent).toContain('12 movements');
    expect(pop.textContent).toContain('Locked');
  });

  test('the address opens the month asked for', () => {
    setUp({ months: [MONTH, { ...MONTH, month: '2026-08', openCount: 0 }] });
    show('/scm/bank-recon?account=310-0020&month=2026-08');
    expect(screen.getByText('August 2026')).toBeTruthy();
  });

  test('a statement that stops short says which days are missing, from To do', () => {
    setUp();
    state.todo = [{ key: 'bank-missing:310-0020', rule: 'bank-missing', since: '2026-09-04' }];
    show();
    expect(screen.getByText('The 310-0020 statement stops at 2026/09/03 · 2026/09/04 onward missing')).toBeTruthy();
    expect(screen.getByText(/2026\/09\/04 onward missing$/, { selector: 'div' })).toBeTruthy();
  });
});

describe('the month: where it stands', () => {
  test('walks the four steps', () => {
    setUp();
    show();
    expect(screen.getByText('Statement in')).toBeTruthy();
    expect(screen.getByText('Covers 2026/09/01 → 2026/09/03')).toBeTruthy();
    expect(screen.getByText('0 of 1 line · 1 to go')).toBeTruthy();
    expect(screen.getByText('Waiting on 1 bank line')).toBeTruthy();
    expect(screen.getByText('Ready once every bank line is decided and it tallies')).toBeTruthy();
  });

  test('the statement less the ledger is the difference, and says what makes it', () => {
    setUp();
    show();
    expect(screen.getByText('Statement closes at')).toBeTruthy();
    expect(screen.getByText('Per the ledger')).toBeTruthy();
    expect(screen.getByText('RM 900.00')).toBeTruthy();
    expect(screen.getByText(/2 bank lines not matched yet/)).toBeTruthy();
    expect(screen.getByText('+RM 900.00')).toBeTruthy();
    expect(screen.getByText('Nothing unexplained')).toBeTruthy();
  });
});

/* Owner, 2026-09-13: 我的 matching 在 bank statement，然后 lock 在 by month？
   不能做一起？ — the month says how much is left, and runs the rule itself. */
describe('what is still to decide, on the month', () => {
  test('says how many are left, and runs the rule over every file that fed the month', async () => {
    setUp();
    state.autoMatch
      .mockResolvedValueOnce({ ok: true, matched: 2, jeNos: ['JE-1', 'JE-2'], contraPairs: 1 })
      .mockResolvedValueOnce({ ok: true, matched: 1, jeNos: ['JE-3'], contraPairs: 0 });
    openMonth();
    expect(screen.getByText('1 still to decide')).toBeTruthy();
    fireEvent.click(screen.getByText('Match the obvious ones now'));
    await waitFor(() => expect(state.autoMatch).toHaveBeenCalledTimes(2));
    /* One call per file of the month, in the order the files cover it. */
    expect(state.autoMatch.mock.calls.map((c) => c[0])).toEqual([1, 3]);
    expect(await screen.findByText(/3 matched — JE-1, JE-2, JE-3; 1 pair the bank reversed left out/)).toBeTruthy();
    /* The voucher a line names is the rule too (owner 2026-11-10). */
    expect(screen.getByText(/carry a voucher's number/)).toBeTruthy();
  });

  test('a file the server refuses is named, and the others still run', async () => {
    setUp();
    state.autoMatch
      .mockRejectedValueOnce(new Error('310-0020 2026-08 was closed by Chew on 2026-09-01, so matching would change a month that has already been reconciled and reported.'))
      .mockResolvedValueOnce({ ok: true, matched: 1, jeNos: ['JE-3'], contraPairs: 0 });
    openMonth();
    fireEvent.click(screen.getByText('Match the obvious ones now'));
    expect(await screen.findByText(/1 matched — JE-3/)).toBeTruthy();
    expect(screen.getByText(/d01\.csv: .*closed by Chew/)).toBeTruthy();
  });

  test('says nothing is left, and offers no rule, once every movement is decided', () => {
    setUp({ lines: [{ ...LINE, state: 'POSTED', posted_je_no: 'JE-1' }] });
    openMonth();
    expect(screen.getByText('Nothing left to decide')).toBeTruthy();
    expect(screen.queryByText('Match the obvious ones now')).toBeNull();
  });

  test('offers no rule on a closed month', () => {
    setUp({ lock: { accountCode: '310-0020', month: '2026-09', lockedBy: 'Chew', lockedAt: '2026-10-02T03:14:00Z', lockNote: null, closingStatementSen: 1090000, closingLedgerSen: 1090000, differenceSen: 0, statementCount: 3, wasComplete: true } });
    openMonth();
    expect(screen.getByText('1 still to decide')).toBeTruthy();
    expect(screen.queryByText('Match the obvious ones now')).toBeNull();
  });
});

/* Owner 2026-10-14 (这个我重新上传会需要重新match 过？ → B，做): the month-end file
   repeated the any-day export's movements printed with more words; one press
   files them as already recorded, the files carrying them in turn. */
describe('movements an earlier file already recorded', () => {
  test('one press leaves them out, asking each file that carries them; none waiting, no button', async () => {
    setUp({ repeats: { count: 42, statementIds: [3] } });
    state.leaveOut.mockResolvedValueOnce({ ok: true, leftOut: 42, lineIds: [] });
    openMonth();
    expect(screen.getByText(/d03\.csv repeats them, printed a little differently/)).toBeTruthy();
    fireEvent.click(screen.getByText('Leave out 42 already recorded'));
    await waitFor(() => expect(state.leaveOut).toHaveBeenCalledTimes(1));
    expect(state.leaveOut.mock.calls[0]![0]).toBe(3);
    expect(await screen.findByText('42 left out.')).toBeTruthy();
  });

  test('no button when nothing repeats, or on a closed month', () => {
    setUp({ repeats: { count: 0, statementIds: [] } });
    const first = show();
    expect(screen.queryByText(/already recorded$/)).toBeNull();
    first.unmount();
    setUp({ repeats: { count: 2, statementIds: [3] }, lock: { accountCode: '310-0020', month: '2026-09', lockedBy: 'Chew', lockedAt: '2026-10-02T03:14:00Z', lockNote: null, closingStatementSen: 1090000, closingLedgerSen: 1090000, differenceSen: 0, statementCount: 3, wasComplete: true } });
    openMonth();
    expect(screen.queryByText('Leave out 2 already recorded')).toBeNull();
  });
});

/* ── The figure he types, for a month no file prints a balance for (docs/bugs/0858) ── */
describe('the month-end balance typed off the bank statement', () => {
  const NO_BALANCES: BankMonthAssembly = {
    ...ASSEMBLY, complete: false,
    statementOpeningSen: null, openingFrom: null,
    statementClosingSen: null, closingFrom: null,
    gaps: ['None of this month\'s files prints an opening balance. Type the closing balance of 2026-08 off the bank\'s month-end statement and 2026-09 opens there.', 'None of this month\'s files prints a closing balance. Type it off the bank\'s month-end statement and the month can tally.'],
  };
  const TYPED_CLOSING = { statementId: null, fileName: null, on: '2026-09-30', typed: { month: '2026-09', by: 'Chew', at: '2026-09-13T07:05:00Z', note: 'per the September e-statement' } };
  const STORED = { month: '2026-09', closingSen: 1090000, typedBy: 'Chew', typedAt: '2026-09-13T07:05:00Z', note: 'per the September e-statement' };

  test('reads money the way people type it', () => {
    expect(parseRm('19,840.54')).toBe(1984054);
    expect(parseRm(' 10000 ')).toBe(1000000);
    expect(parseRm('-120.00')).toBe(-12000);
    expect(parseRm('')).toBeNull();
    expect(parseRm('ten')).toBeNull();
    expect(parseRm('1.234')).toBeNull();
    expect(previousMonthOf('2026-09')).toBe('2026-08');
    expect(previousMonthOf('2026-01')).toBe('2025-12');
    expect(previousMonthOf('rubbish')).toBeNull();
  });

  test('offers the closing box, and the previous month\'s, only where no file prints the figure', () => {
    setUp();   // both ends printed by files
    openMonth();
    expect(screen.queryByLabelText('Closing balance per the bank statement')).toBeNull();
    expect(screen.queryByLabelText('Closing balance of the previous month')).toBeNull();
  });

  test('saves the closing under this month and the opening under the previous one, in sen', () => {
    setUp({ assembly: NO_BALANCES });
    openMonth();
    expect(screen.getByText(/Closing balance of 08\/2026 — 09\/2026 opens there/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Closing balance per the bank statement'), { target: { value: '19,840.54' } });
    fireEvent.change(screen.getByLabelText('Note on the closing balance per the bank statement'), { target: { value: 'per the September e-statement' } });
    fireEvent.click(screen.getAllByText('Save')[0]!);
    expect(state.typeClosing).toHaveBeenCalledWith({ accountCode: '310-0020', month: '2026-09', closingSen: 1984054, note: 'per the September e-statement' });

    fireEvent.change(screen.getByLabelText('Closing balance of the previous month'), { target: { value: '10000' } });
    fireEvent.click(screen.getAllByText('Save')[1]!);
    expect(state.typeClosing).toHaveBeenLastCalledWith({ accountCode: '310-0020', month: '2026-08', closingSen: 1000000, note: null });
  });

  test('will not save what is not a money amount', () => {
    setUp({ assembly: NO_BALANCES });
    openMonth();
    fireEvent.change(screen.getByLabelText('Closing balance per the bank statement'), { target: { value: 'ten' } });
    expect(screen.getAllByText('Save')[0]!.closest('button')!.disabled).toBe(true);
    expect(screen.getByText(/Not a money amount/)).toBeTruthy();
  });

  /* A figure with no author is a number nobody can check: the screen names
     who typed it, the box carries it, and it can be taken back. */
  test('names the typed figure where the figures come from, shows it in the box, and can clear it', () => {
    setUp({
      assembly: { ...NO_BALANCES, statementClosingSen: 1090000, closingFrom: TYPED_CLOSING },
      balances: { closing: STORED, previousClosing: null },
    });
    openMonth();
    expect(screen.getByText(/the closing balance typed for 09\/2026 by Chew on 2026-09-13/)).toBeTruthy();
    expect((screen.getByLabelText('Closing balance per the bank statement') as HTMLInputElement).value).toBe('10900.00');
    expect(screen.getByText(/typed by Chew on 2026-09-13/)).toBeTruthy();
    /* Nothing changed, so there is nothing to save. */
    expect(screen.getAllByText('Save')[0]!.closest('button')!.disabled).toBe(true);
    fireEvent.click(screen.getByText('Clear'));
    expect(state.typeClosing).toHaveBeenCalledWith({ accountCode: '310-0020', month: '2026-09', closingSen: null, note: null });
  });

  test('offers no box on a closed month', () => {
    setUp({
      assembly: NO_BALANCES,
      lock: { accountCode: '310-0020', month: '2026-09', lockedBy: 'Chew', lockedAt: '2026-10-02T03:14:00Z', lockNote: null, closingStatementSen: 1090000, closingLedgerSen: 1090000, differenceSen: 0, statementCount: 3, wasComplete: true },
    });
    openMonth();
    expect(screen.queryByLabelText('Closing balance per the bank statement')).toBeNull();
  });
});

describe('a month with a day missing from it', () => {
  const BROKEN: BankMonthAssembly = {
    ...ASSEMBLY,
    complete: false,
    breaks: [{
      beforeId: 1, beforeFile: 'd04.csv', beforeTo: '2026-09-04', beforeClosingSen: 1050000,
      afterId: 2, afterFile: 'd08.csv', afterFrom: '2026-09-08', afterOpeningSen: 1070000,
      gapSen: 20000,
    }],
    gaps: ['d04.csv closes on 2026-09-04 and d08.csv opens on 2026-09-08 at a different figure — 20000 sen moved on days between them that have not been uploaded.'],
  };

  /* THE ONE THAT MATTERS. A difference computed over a month short of four
     days is not a smaller version of the right answer, it is an answer about a
     different month — so what is missing is said FIRST. */
  test('says what is missing above the verdict', () => {
    setUp({ assembly: BROKEN });
    openMonth();
    expect(screen.getByText('This month is not covered end to end')).toBeTruthy();
    expect(screen.getByText(/d04\.csv closes on 2026-09-04 and d08\.csv opens on 2026-09-08/)).toBeTruthy();
  });

  test('names how much movement the difference is short by', () => {
    setUp({ assembly: BROKEN });
    openMonth();
    expect(screen.getByText(/the difference above is missing/)).toBeTruthy();
    expect(screen.getByText('RM 200.00')).toBeTruthy();
  });

  test('a complete month says none of it', () => {
    setUp();
    openMonth();
    expect(screen.queryByText('This month is not covered end to end')).toBeNull();
  });
});

describe('where the figures came from', () => {
  /* A balance with no provenance is a number nobody can check — both ends name
     their file and their day. */
  test('names the file and day behind each end of the month', () => {
    setUp();
    openMonth();
    expect(screen.getByText(/Opened at/)).toBeTruthy();
    expect(screen.getByText(/d01\.csv \(2026-09-01\)/)).toBeTruthy();
    expect(screen.getByText(/d03\.csv \(2026-09-03\)/)).toBeTruthy();
  });

  test('says nothing where no file inside the month printed a balance', () => {
    setUp({
      assembly: {
        ...ASSEMBLY, complete: false,
        statementOpeningSen: null, openingFrom: null,
        statementClosingSen: null, closingFrom: null,
        gaps: ['None of this month\'s files prints an opening balance.'],
      },
    });
    openMonth();
    expect(screen.queryByText(/Opened at/)).toBeNull();
  });
});

describe('a file that straddles the month end', () => {
  test('is listed, and labelled as speaking only for its movements', () => {
    setUp({
      assembly: { ...ASSEMBLY, complete: false, spanningIds: [9], gaps: ['1 file(s) cross the edge of this month.'] },
      statements: [
        ...STATEMENTS,
        { id: 9, account_code: '310-0020', file_name: 'aug28-sep03.csv', period_from: '2026-08-28', period_to: '2026-09-03', opening_balance_sen: 777777, closing_balance_sen: 888888, spanning: true },
      ],
    });
    openMonth();
    expect(screen.getByText('aug28-sep03.csv')).toBeTruthy();
    expect(screen.getByText(/crosses the month edge/)).toBeTruthy();
  });
});

describe('closing a month', () => {
  const HELD = {
    accountCode: '310-0020', month: '2026-09',
    lockedBy: 'Chew', lockedAt: '2026-10-02T03:14:00Z',
    lockNote: 'known timing difference, agreed with the bank',
    closingStatementSen: 1090000, closingLedgerSen: 1045000, differenceSen: 45000,
    statementCount: 12, wasComplete: false,
  };

  test('an open month offers to lock, and says what locking does', () => {
    setUp({ recon: { ...RECON, bankNotInBooks: { count: 0, sen: 0 }, closingLedgerSen: 1090000, differenceSen: 0, reconciled: true }, lines: [{ ...LINE, state: 'POSTED', posted_je_no: 'JE-1' }] });
    openMonth();
    expect(screen.getByText('Lock Sep')).toBeTruthy();
    expect(screen.getByText(/Locking fixes what this month says/)).toBeTruthy();
  });

  /* Owner, 2026-09-11: 当 closing bank statement amount 无法 tally 就无法 lock.
     The button is OFF until the month tallies, is whole and has nothing left
     to decide — and it says which of those is missing. No reason box. */
  test('the close button is off, and says why, while the month does not tally', () => {
    setUp({ recon: { ...RECON, bankNotInBooks: { count: 0, sen: 0 }, computedClosingSen: 1060000, unexplainedSen: 30000, tallies: false } });
    openMonth();
    const go = screen.getByText('Lock Sep').closest('button')!;
    expect(go.disabled).toBe(true);
    expect(screen.getByText(/Can’t lock yet · .*RM 300\.00 unexplained/)).toBeTruthy();
    expect(screen.queryByLabelText('Why this month is being closed anyway')).toBeNull();
  });

  test('the lock is off while lines are still to decide, or a day is missing', () => {
    setUp();   // one line still to decide
    openMonth();
    expect(screen.getByText('Lock Sep').closest('button')!.disabled).toBe(true);
    expect(screen.getByText(/Can’t lock yet · 1 line to decide/)).toBeTruthy();
  });

  test('the lock is on when the month tallies, is whole and no line is still to decide', () => {
    setUp({ recon: { ...RECON, bankNotInBooks: { count: 0, sen: 0 }, closingLedgerSen: 1090000, differenceSen: 0, reconciled: true }, lines: [{ ...LINE, state: 'POSTED', posted_je_no: 'JE-1' }] });
    openMonth();
    expect(screen.getByText('Lock Sep').closest('button')!.disabled).toBe(false);
    expect(screen.getByText('Ready to lock')).toBeTruthy();
    expect(screen.queryByLabelText('Why this month is being closed anyway')).toBeNull();
  });

  /* THE ONE THAT MATTERS ON A CLOSED MONTH: the figures shown are the ones
     SNAPSHOTTED when it was closed, not today's. A lock exists to fix a claim,
     and rendering live numbers here would quietly rewrite it. */
  test('a closed month shows the figures it was closed at, and who closed it', () => {
    setUp({ lock: HELD });
    openMonth();
    expect(screen.getByText(/Locked 2026\/10\/02 by Chew/)).toBeTruthy();
    expect(screen.getByText(/RM 10,900\.00 per the bank against RM 10,450\.00 in the ledger/)).toBeTruthy();
    expect(screen.getByText(/NOT covered end to end/)).toBeTruthy();
    expect(screen.getByText(/known timing difference/)).toBeTruthy();
  });

  test('a closed month offers no way to close it again', () => {
    setUp({ lock: HELD });
    openMonth();
    expect(screen.queryByText('Lock Sep')).toBeNull();
    expect(screen.getByText('Unlock…')).toBeTruthy();
  });

  /* Reopening demands a reason, and the button stays dead until there is one —
     the server refuses without it, and a screen that lets the press through
     just to collect a refusal has wasted the trip. */
  test('reopening cannot be pressed without a reason', () => {
    setUp({ lock: HELD });
    openMonth();
    fireEvent.click(screen.getByText('Unlock…'));
    expect(screen.getByText(/Unlocking needs the approve right and a reason/)).toBeTruthy();
    const go = screen.getByText('Unlock it').closest('button')!;
    expect(go.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Why this month is being unlocked'), {
      target: { value: 'the bank re-issued 12 Sep' },
    });
    expect(screen.getByText('Unlock it').closest('button')!.disabled).toBe(false);
  });

  test('the chip says a month is locked instead of how clean it looks', () => {
    setUp({ months: [{ ...MONTH, openCount: 0, locked: { lockedBy: 'Chew', lockedAt: '2026-10-02T03:14:00Z' } }] });
    show();
    const chip = screen.getByRole('button', { name: /^2026\/09/ });
    expect(chip.textContent).toContain('Locked');
    expect(chip.textContent).not.toContain('to decide');
  });
});

describe('the reconciliation statement', () => {
  /* Owner: match 完了我要report. The door has to be on the month, and the
     dialog has to say whether the month behind the paper is whole — printing
     an incomplete month is a decision, not a discovery made on the sheet. */
  test('offers the statement from the month view', () => {
    setUp();
    openMonth();
    expect(screen.getByText('Print reconciliation')).toBeTruthy();
  });

  /* The redesign (owner question d6): the statement is an A4 page the browser
     prints — the walk, then the three lists; matched lines are not printed;
     Draft until the month is locked, Final after. */
  test('prints the walk from the ledger to the bank, marked Draft while the month is open', () => {
    setUp();
    openMonth();
    fireEvent.click(screen.getByText('Print reconciliation'));
    const sheet = screen.getByLabelText('Bank reconciliation statement');
    expect(sheet.textContent).toContain('BANK RECONCILIATION STATEMENT');
    expect(sheet.textContent).toContain('Draft · not locked. Still open: 2 bank lines to decide.');
    expect(sheet.textContent).toContain('Balance per the ledger on 2026/09/03');
    expect(sheet.textContent).toContain('Balance per bank statement on 2026/09/03');
    expect(sheet.textContent).toContain('Bank lines not in the ledger yet');
    expect(sheet.textContent).toContain('Ledger entries not on the bank yet');
    /* Nothing set aside, nothing owed by the books: each list says None. */
    expect(screen.getAllByText('None.').length).toBe(2);
  });

  test('a locked month prints Final, and matched lines are left off the paper', () => {
    setUp({
      lines: [{ ...LINE, state: 'POSTED', posted_je_no: 'JE-1', description: 'MATCHED LINE' }],
      lock: { accountCode: '310-0020', month: '2026-09', lockedBy: 'Chew', lockedAt: '2026-10-02T03:14:00Z', lockNote: null, closingStatementSen: 1090000, closingLedgerSen: 1090000, differenceSen: 0, statementCount: 3, wasComplete: true },
    });
    openMonth();
    fireEvent.click(screen.getByText('Print reconciliation'));
    const sheet = screen.getByLabelText('Bank reconciliation statement');
    expect(sheet.textContent).toContain('Final · locked 2026/10/02 by Chew');
    expect(sheet.textContent).not.toContain('MATCHED LINE');
  });

  test('the earlier PDF is one press away for one more release, and its dialog says whether the month is whole', () => {
    setUp({ assembly: { ...ASSEMBLY, complete: false, gaps: ['a day is missing'] } });
    openMonth();
    fireEvent.click(screen.getByText('Print reconciliation'));
    fireEvent.click(screen.getByText('Old PDF'));
    expect(screen.getByText(/not covered end to end — 1 thing\(s\) missing/)).toBeTruthy();
  });
});

/* A line set aside is out of the ledger and on the statement: the difference
   names it apart, and the month cannot lock while it moves the balance. */
describe('lines set aside', () => {
  const ASIDE = { ...LINE, id: 9, line_no: 9, kind: 'OTHER' as const, state: 'IGNORED' as const, amount_sen: 30000, note: 'own transfer' };
  const UNTALLIED = { ...RECON, bankNotInBooks: { count: 0, sen: 0 }, computedClosingSen: 1060000, unexplainedSen: 30000, tallies: false };

  test('are their own part of the difference, and leave nothing unexplained when they are all of it', () => {
    setUp({ lines: [ASIDE], recon: UNTALLIED });
    openMonth();
    expect(screen.getByText(/1 line set aside/)).toBeTruthy();
    expect(screen.getByText('+RM 300.00')).toBeTruthy();
    expect(screen.getByText('Nothing unexplained')).toBeTruthy();
    expect(screen.getByText(/Can’t lock yet · set-aside lines change the balance by RM 300\.00$/)).toBeTruthy();
  });

  test('a repeat of a line already recorded is not one of them', () => {
    setUp({ lines: [{ ...ASIDE, kind: 'DUPLICATE' as const }], recon: UNTALLIED });
    openMonth();
    expect(screen.queryByText(/set aside/, { selector: 'button' })).toBeNull();
    /* Said where the difference is walked, and where the month stands. */
    expect(screen.getAllByText('RM 300.00 unexplained').length).toBeGreaterThan(0);
  });
});

describe('the movements of the month', () => {
  test('carries the file screen own rows, with what each movement came off', () => {
    setUp();
    openMonth();
    /* A payout the matcher could not tie to one report sits under To choose, and the month opens there. */
    expect(screen.getByRole('tab', { name: /^To choose/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('a card payout, matched')).toBeTruthy();
  });

  /* The one-press door for every certain payout is on the month too — the
     rows are the file screen's own (docs/bugs/0868). */
  test('offers to book every certain payout at once, on the month', () => {
    setUp({ lines: [{ ...LINE, matched_batch_id: 7, candidates: [{ id: 7, acquirerCode: 'HLB', fileName: 'hlb-0901.csv', periodFrom: '2026-09-01', periodTo: '2026-09-01', payableSen: 60000, outstandingSen: 60000 }] }] });
    openMonth();
    expect(screen.getByText('Money received — all 1 matched payout')).toBeTruthy();
  });

  test('says the reconciliation as the three figures and what makes the difference', () => {
    setUp();
    openMonth();
    expect(screen.getByText('Difference')).toBeTruthy();
    expect(screen.getByText('2 bank lines not matched yet')).toBeTruthy();
  });

  test('refuses to publish a difference it cannot account for', () => {
    setUp({
      recon: { ...RECON, consistent: false, inconsistency: 'The difference of 100 sen does not equal what is unmatched.' },
    });
    openMonth();
    expect(screen.getByText('These numbers do not add up')).toBeTruthy();
    expect(screen.queryByText(/The bank and the books differ by/)).toBeNull();
  });
});

/* ── The redesign's six tabs (batch 3, step 10) ─────────────────────────── */
describe('the month in six tabs', () => {
  const CERTAIN = { ...LINE, id: 2, line_no: 3, matched_batch_id: 7, candidates: [{ id: 7, acquirerCode: 'HLB', fileName: 'hlb-0901.csv', periodFrom: '2026-09-01', periodTo: '2026-09-01', payableSen: 60000, outstandingSen: 60000 }] };
  const ONE_ENTRY = {
    ...LINE, id: 3, line_no: 4, kind: 'OTHER' as const, acquirer_code: null, description: 'IBG TAN WEI MING', amount_sen: 300000,
    entryCandidates: [{ jeNo: 'JE-2609-0041', entryDate: '2026-09-01', sourceType: 'OR', sourceDocNo: 'OR-2609-004', debitSen: 300000, creditSen: 0, amountSen: 300000, daysApart: 0, reference: 'OR-2609-004 · SO-2609-011', who: 'Tan Wei Ming' }],
  };
  const NOTHING_FITS = { ...LINE, id: 4, line_no: 5, kind: 'OTHER' as const, acquirer_code: null, description: 'DUITNOW 8605 SERVICE', amount_sen: -860540 };
  const MATCHED = { ...LINE, id: 5, line_no: 6, state: 'POSTED' as const, posted_je_no: 'JE-2609-0050' };
  const ASIDE = { ...LINE, id: 6, line_no: 7, state: 'IGNORED' as const, note: 'reversed by the bank the same day' };
  const tabOf = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}`) });

  test('each line sits in the tab its decision puts it in, with the count on the tab', () => {
    setUp({ lines: [CERTAIN, ONE_ENTRY, NOTHING_FITS, LINE, MATCHED, ASIDE] });
    openMonth();
    expect(tabOf('To match').textContent).toBe('To match2');
    expect(tabOf('To choose').textContent).toBe('To choose1');
    expect(tabOf('No entry found').textContent).toBe('No entry found1');
    expect(tabOf('Matched').textContent).toBe('Matched1');
    expect(tabOf('Set aside').textContent).toBe('Set aside1');
    /* The month opens on the first tab with lines to work. */
    expect(tabOf('To match').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/Same amount, one entry, names agree/)).toBeTruthy();
  });

  test('To match: the one entry is matched with one press; nothing new is posted', () => {
    setUp({ lines: [ONE_ENTRY] });
    openMonth();
    expect(screen.getByText('OR-2609-004 · SO-2609-011')).toBeTruthy();
    expect(screen.getByText('Tan Wei Ming')).toBeTruthy();
    fireEvent.click(screen.getByText('Match'));
    expect(state.match).toHaveBeenCalledWith({ lineId: 3, jeNo: 'JE-2609-0041' });
  });

  test('To match: a payout owed exactly this is booked through its own door, and the all-at-once button is there', () => {
    setUp({ lines: [CERTAIN] });
    openMonth();
    expect(screen.getByText('Money received — all 1 matched payout')).toBeTruthy();
    fireEvent.click(screen.getByText('Money received'));
    expect(state.book).toHaveBeenCalledWith({ lineId: 2, allocations: [{ batchId: 7, amountSen: 60000 }] });
  });

  test('"Not this" moves a line from To match to To choose, and links nothing', () => {
    setUp({ lines: [ONE_ENTRY] });
    openMonth();
    fireEvent.click(screen.getByText('Not this'));
    expect(state.match).not.toHaveBeenCalled();
    expect(tabOf('To match').textContent).toBe('To match0');
    fireEvent.click(tabOf('To choose'));
    expect(screen.getByText('This is that entry')).toBeTruthy();
  });

  test('No entry found keeps the row\'s own way to leave a line out, with its reason', () => {
    setUp({ lines: [NOTHING_FITS] });
    openMonth();
    expect(tabOf('No entry found').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Not ours to reconcile')).toBeTruthy();
  });

  /* Owner 2026-11-03 on d10 (「这样需要」, the journal only): a line nothing fits is recorded from itself. */
  test('No entry found: Record journal opens the manual journal on the line — its day, the bank’s leg filled in', () => {
    setUp({ lines: [NOTHING_FITS] });
    openMonth();
    fireEvent.click(screen.getByText('Record journal'));
    const drawer = screen.getByRole('dialog', { name: 'Record journal' });
    expect(within(drawer).getByText(/Bank line 5 · 2026\/09\/01 · Out 8,605\.40/)).toBeTruthy();
    expect(within(drawer).getByLabelText("The bank's leg").textContent).toContain('310-0020 — HONG LEONG BANK');
    expect(within(drawer).getByLabelText('Bank credit').textContent).toBe('8605.40');
    expect((within(drawer).getByLabelText('Line 1 debit') as HTMLInputElement).value).toBe('8605.40');
  });

  test('the journal stays open while the tabs change under it — its line leaves No entry found once it posts', () => {
    setUp({ lines: [NOTHING_FITS, MATCHED] });
    openMonth();
    fireEvent.click(screen.getByText('Record journal'));
    fireEvent.click(tabOf('Matched'));
    expect(tabOf('Matched').getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByRole('dialog', { name: 'Record journal' })).getByText(/Bank line 5 · 2026\/09\/01/)).toBeTruthy();
  });

  test('Record journal is not offered on a locked month', () => {
    setUp({
      lines: [NOTHING_FITS],
      lock: { accountCode: '310-0020', month: '2026-09', lockedBy: 'Chew', lockedAt: '2026-10-02T03:14:00Z', lockNote: null, closingStatementSen: 1090000, closingLedgerSen: 1090000, differenceSen: 0, statementCount: 3, wasComplete: true },
    });
    openMonth();
    expect(tabOf('No entry found').textContent).toBe('No entry found1');
    expect(screen.queryByText('Record journal')).toBeNull();
  });

  test('Record journal is not offered to someone who may not post a journal', () => {
    setUp({ lines: [NOTHING_FITS], mayPost: false });
    openMonth();
    expect(screen.getByText('Not ours to reconcile')).toBeTruthy();
    expect(screen.queryByText('Record journal')).toBeNull();
  });

  test('a card payout with no report is not recorded as a journal — its money is owed by a report', () => {
    setUp({ lines: [{ ...LINE, id: 7, line_no: 8, kind: 'PAYOUT_NO_BATCH' as const }] });
    openMonth();
    expect(tabOf('No entry found').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText('Record journal')).toBeNull();
  });

  test('Matched and Set aside list what was decided, with Undo', () => {
    setUp({ lines: [MATCHED, ASIDE] });
    openMonth();
    /* Nothing open: the month opens on Matched. */
    expect(tabOf('Matched').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/JE-2609-0050/)).toBeTruthy();
    expect(screen.getByText('Undo')).toBeTruthy();
    fireEvent.click(tabOf('Set aside'));
    expect(screen.getByText(/reversed by the bank the same day/)).toBeTruthy();
  });

  test('Not on the bank yet names where each entry stands', () => {
    setUp({ lines: [ONE_ENTRY] });
    state.entries = [
      { jeNo: 'JE-2609-0041', entryDate: '2026-09-01', sourceType: 'OR', sourceDocNo: 'OR-2609-004', debitSen: 300000, creditSen: 0, reference: 'OR-2609-004', who: 'Tan Wei Ming' },
      { jeNo: 'JE-2608-0090', entryDate: '2026-08-28', sourceType: 'PV', sourceDocNo: 'PV-2608-031', debitSen: 0, creditSen: 120000, reference: 'PV-2608-031', who: 'MK Properties', carried: true },
    ];
    openMonth();
    fireEvent.click(tabOf('Not on the bank yet'));
    expect(screen.getByText('Offered under To match')).toBeTruthy();
    expect(screen.getByText('Earlier month · 2026/08')).toBeTruthy();
  });

  test('the walk opens the tab it names', () => {
    setUp({ lines: [MATCHED], recon: { ...RECON, outstandingReceipts: { count: 1, sen: 300000 } } });
    state.entries = [{ jeNo: 'JE-2609-0041', entryDate: '2026-09-01', sourceType: 'OR', sourceDocNo: 'OR-2609-004', debitSen: 300000, creditSen: 0, reference: 'OR-2609-004', who: 'Tan Wei Ming' }];
    openMonth();
    fireEvent.click(screen.getByText(/1 ledger entry not on the bank yet/));
    expect(tabOf('Not on the bank yet').getAttribute('aria-selected')).toBe('true');
  });

  test('the address opens the tab asked for, and an empty tab says what it looked for', () => {
    setUp({ lines: [MATCHED] });
    show('/scm/bank-recon?account=310-0020&month=2026-09&tab=set-aside');
    expect(tabOf('Set aside').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Nothing set aside.')).toBeTruthy();
  });
});
