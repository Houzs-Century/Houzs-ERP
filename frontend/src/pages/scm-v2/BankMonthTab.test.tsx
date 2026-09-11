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
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { BankLine, BankMonth, BankMonthAssembly, Reconciliation } from './bank-queries';

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
}));

vi.mock('./bank-queries', () => ({
  useBankMonths: () => ({ data: { months: state.months }, isLoading: false }),
  useBankMonth: () => ({
    data: {
      accountCode: '310-0020', month: '2026-09',
      assembly: state.assembly, reconciliation: state.recon, lock: state.lock,
      statements: state.statements, lines: state.lines, unmatchedEntries: [],
    },
    isLoading: false,
  }),
  /* The file screen's rows come with it; the month renders them, so their hooks
     have to exist even where this screen never presses them. */
  useBankSetup: () => ({ data: { accounts: [], recognises: [] }, isLoading: false }),
  useBankStatements: () => ({ data: { statements: [] }, isLoading: false }),
  useBankStatement: () => ({ data: undefined, isLoading: false }),
  useUploadBankStatement: () => ({ mutate: vi.fn(), isPending: false }),
  useBookBankReceipt: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useMatchBankGroup: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useMatchBankLine: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useIgnoreBankLine: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useUndoBankLine: () => ({ mutate: vi.fn(), isPending: false }),
  useLockBankMonth: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useUnlockBankMonth: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
}));

import { BankMonthTab, monthLabel } from './BankMonthTab';

const setUp = (over: {
  months?: unknown[]; assembly?: BankMonthAssembly; recon?: Reconciliation;
  lines?: unknown[]; statements?: unknown[]; lock?: unknown;
} = {}) => {
  state.months = over.months ?? [MONTH];
  state.assembly = over.assembly ?? ASSEMBLY;
  state.recon = over.recon ?? RECON;
  state.lines = over.lines ?? [LINE];
  state.statements = over.statements ?? STATEMENTS;
  state.lock = over.lock ?? null;
};

/* The print dialog this screen mounts reads the company branding through
   react-query, so the tree needs a client — the same wrapper NotificationBell's
   test uses. Retries off: a test that waits out a retry is a slow test that
   still fails. */
const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <BankMonthTab />
  </QueryClientProvider>,
);

const openMonth = () => {
  show();
  fireEvent.click(screen.getByText('Reconcile'));
};

describe('the list of months', () => {
  test('names the month in the numeric shape the rest of the ERP uses', () => {
    expect(monthLabel('2026-09')).toBe('09/2026');
    expect(monthLabel('2026-01')).toBe('01/2026');
    /* Anything that is not a month is shown as it came rather than guessed at. */
    expect(monthLabel('rubbish')).toBe('rubbish');
  });

  test('says how many files built it and how much is still undecided', () => {
    setUp();
    show();
    expect(screen.getByText('09/2026')).toBeTruthy();
    expect(screen.getByText('3 files')).toBeTruthy();
    expect(screen.getByText('2 of 12 · 1 card payout(s)')).toBeTruthy();
  });

  test('says whether the month can be trusted before it is opened', () => {
    setUp();
    show();
    expect(screen.getByText('covered end to end')).toBeTruthy();
  });

  test('marks a month that is missing something', () => {
    setUp({ months: [{ ...MONTH, complete: false, gapCount: 2 }] });
    show();
    expect(screen.getByText('2 things missing')).toBeTruthy();
    expect(screen.queryByText('covered end to end')).toBeNull();
  });

  test('says nothing about months when none came back', () => {
    setUp({ months: [] });
    show();
    expect(screen.getByText(/No bank statement has been uploaded yet/)).toBeTruthy();
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

  test('names how much movement the difference below is short by', () => {
    setUp({ assembly: BROKEN });
    openMonth();
    expect(screen.getByText(/the difference below is missing/)).toBeTruthy();
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

  test('an open month offers to close, and says what closing does', () => {
    setUp();
    openMonth();
    expect(screen.getByText('Close this month')).toBeTruthy();
    expect(screen.getByText(/Nothing in it can be booked, left out or undone afterwards/)).toBeTruthy();
  });

  /* Owner, 2026-09-11: 当 closing bank statement amount 无法 tally 就无法 lock.
     The button is OFF until the month tallies, is whole and has nothing left
     to decide — and it says which of those is missing. No reason box. */
  test('the close button is off, and says why, while the month does not tally', () => {
    setUp({ recon: { ...RECON, bankNotInBooks: { count: 0, sen: 0 }, computedClosingSen: 1060000, unexplainedSen: 30000, tallies: false } });
    openMonth();
    const go = screen.getByText('Close this month').closest('button')!;
    expect(go.disabled).toBe(true);
    expect(screen.getByText(/does not tally/)).toBeTruthy();
    expect(screen.queryByLabelText('Why this month is being closed anyway')).toBeNull();
  });

  test('the close button is off while movements are still to decide, or a day is missing', () => {
    setUp();   // RECON has two movements still to decide
    openMonth();
    expect(screen.getByText('Close this month').closest('button')!.disabled).toBe(true);
    expect(screen.getByText(/2 movements still to decide/)).toBeTruthy();
  });

  test('the close button is on when the month tallies, is whole and no movement is still to decide', () => {
    setUp({ recon: { ...RECON, bankNotInBooks: { count: 0, sen: 0 }, closingLedgerSen: 1090000, differenceSen: 0, reconciled: true } });
    openMonth();
    expect(screen.getByText('Close this month').closest('button')!.disabled).toBe(false);
    expect(screen.queryByLabelText('Why this month is being closed anyway')).toBeNull();
  });

  /* THE ONE THAT MATTERS ON A CLOSED MONTH: the figures shown are the ones
     SNAPSHOTTED when it was closed, not today's. A lock exists to fix a claim,
     and rendering live numbers here would quietly rewrite it. */
  test('a closed month shows the figures it was closed at, and who closed it', () => {
    setUp({ lock: HELD });
    openMonth();
    expect(screen.getByText(/Closed by Chew on 2026-10-02/)).toBeTruthy();
    expect(screen.getByText(/RM 10,900\.00 per the bank against RM 10,450\.00 in the books/)).toBeTruthy();
    expect(screen.getByText(/NOT covered end to end/)).toBeTruthy();
    expect(screen.getByText(/known timing difference/)).toBeTruthy();
  });

  test('a closed month offers no way to close it again', () => {
    setUp({ lock: HELD });
    openMonth();
    expect(screen.queryByText('Close this month')).toBeNull();
    expect(screen.getByText('Reopen this month')).toBeTruthy();
  });

  /* Reopening demands a reason, and the button stays dead until there is one —
     the server refuses without it, and a screen that lets the press through
     just to collect a refusal has wasted the trip. */
  test('reopening cannot be pressed without a reason', () => {
    setUp({ lock: HELD });
    openMonth();
    fireEvent.click(screen.getByText('Reopen this month'));
    const go = screen.getByText('Reopen it').closest('button')!;
    expect(go.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Why this month is being reopened'), {
      target: { value: 'the bank re-issued 12 Sep' },
    });
    expect(screen.getByText('Reopen it').closest('button')!.disabled).toBe(false);
  });

  test('the list says a month is closed instead of how clean it looks', () => {
    setUp({ months: [{ ...MONTH, locked: { lockedBy: 'Chew', lockedAt: '2026-10-02T03:14:00Z' } }] });
    show();
    expect(screen.getByText(/closed by Chew on 2026-10-02/)).toBeTruthy();
    expect(screen.queryByText('covered end to end')).toBeNull();
  });
});

describe('the reconciliation statement', () => {
  /* Owner: match 完了我要report. The door has to be on the month, and the
     dialog has to say whether the month behind the paper is whole — printing
     an incomplete month is a decision, not a discovery made on the sheet. */
  test('offers the statement from the month view', () => {
    setUp();
    openMonth();
    expect(screen.getByText('Reconciliation statement')).toBeTruthy();
  });

  test('the dialog says the month is whole before anything is printed', () => {
    setUp();
    openMonth();
    fireEvent.click(screen.getByText('Reconciliation statement'));
    expect(screen.getByText('covered end to end')).toBeTruthy();
  });

  test('and says so when it is not', () => {
    setUp({ assembly: { ...ASSEMBLY, complete: false, gaps: ['a day is missing'] } });
    openMonth();
    fireEvent.click(screen.getByText('Reconciliation statement'));
    expect(screen.getByText(/not covered end to end — 1 thing\(s\) missing/)).toBeTruthy();
  });
});

describe('the movements of the month', () => {
  test('carries the file screen own rows, with what each movement came off', () => {
    setUp();
    openMonth();
    expect(screen.getByText('Still to decide (1)')).toBeTruthy();
    expect(screen.getByText('a card payout, matched')).toBeTruthy();
  });

  test('shows the reconciliation the same way the file screen does', () => {
    setUp();
    openMonth();
    expect(screen.getByText(/2 movements on the bank still to decide/)).toBeTruthy();
    expect(screen.getByText(/On the bank, not in the books/)).toBeTruthy();
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
