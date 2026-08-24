// The bank statement screen's render contract. The rules are pinned on the
// server (backend/src/acc/bank-*.test.ts and tests/bankRoutes); what is proved
// here is that the screen SAYS them:
//
//   • a difference is BROKEN DOWN into the two sides that make it up, never
//     shown as a bare number;
//   • numbers that do not add up REPLACE the verdict rather than sitting beside
//     it — publishing a difference nothing can account for looks like work;
//   • the select is seeded from what the MATCHER decided, not from the first
//     candidate of that acquirer;
//   • a split payout shows the gross the bank actually credited, or the amount
//     matches no line on the page the operator is holding;
//   • leaving a movement out demands a reason, because it leaves the difference
//     for ever.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { BankLine, Reconciliation } from './bank-queries';

const bookMutate = vi.fn();
const ignoreMutate = vi.fn();

const LINE: BankLine = {
  id: 1, line_no: 2, booked_on: '2026-08-03',
  description: 'CR/CARD SALES MN 32409997 DATED 14082026', reference: '99970814',
  amount_sen: 227700, charge_sen: 0, kind: 'PAYOUT',
  acquirer_code: 'MBB', trading_date: '2026-08-14', merchant_no: '32409997',
  matched_batch_id: 7, split: null, state: 'OPEN', posted_je_no: null, note: null, matches: [],
  candidates: [
    { id: 3, acquirerCode: 'MBB', fileName: 'other.csv', periodFrom: '2026-08-01', periodTo: '2026-08-01', payableSen: 374304, outstandingSen: 374304 },
    { id: 7, acquirerCode: 'MBB', fileName: 'mbb-credit.csv', periodFrom: '2026-08-14', periodTo: '2026-08-14', payableSen: 227700, outstandingSen: 227700 },
  ],
};

/* The split payout: RM 875.00 credited, RM 3.94 taken back. */
const SPLIT: BankLine = {
  ...LINE, id: 2, line_no: 7, booked_on: '2026-08-09',
  description: 'DR/CARD SALES M/N 2259020 DATED 08082026', reference: 'D90200808',
  amount_sen: 87106, charge_sen: 394, kind: 'PAYOUT_UNSURE', matched_batch_id: null,
  note: 'The bank names 2026-08-08, which is mbb-debit.csv, but that report is owed RM 900.00 and this credit is RM 871.06. Check before recording it.',
};

const OTHER: BankLine = {
  ...LINE, id: 3, line_no: 9, description: 'SERVICE CHARGE', reference: 'BCHARGE',
  amount_sen: -2500, charge_sen: 0, kind: 'OTHER',
  acquirer_code: null, trading_date: null, merchant_no: null,
  matched_batch_id: null, note: null, candidates: [],
};

const RECON: Reconciliation = {
  periodFrom: '2026-08-01', periodTo: '2026-08-12',
  openingStatementSen: 5000000, openingLedgerSen: 5000000, broughtForwardSen: 0,
  movementsStatementSen: 312306, movementsLedgerSen: 0,
  closingStatementSen: 5312306, closingLedgerSen: 5000000, differenceSen: 312306,
  bankNotInBooks: { count: 3, sen: 312306 },
  booksNotOnBank: { count: 0, sen: 0 },
  unmatchedJeNos: [],
  consistent: true, inconsistency: null, reconciled: false,
};

let recon: Reconciliation = RECON;
let lines: BankLine[] = [LINE, SPLIT, OTHER];

vi.mock('./bank-queries', () => ({
  useBankSetup: () => ({ data: { accounts: [{ account_code: '330-0000', bank_code: 'MBB', account_no: '0000564418610346', statement_format: 'CSV', is_active: true, ready: true }], recognises: ['MBB', 'PBB', 'AEON', 'HLB'] }, isLoading: false }),
  useBankStatements: () => ({ data: { statements: [{ id: 1, account_code: '330-0000', file_name: 'aug.csv', period_from: '2026-08-01', period_to: '2026-08-12', line_count: 9, skipped_lines: 1, in_sen: 3032963, out_sen: 352894, opening_balance_sen: null, closing_balance_sen: null, status: 'OPEN', uploaded_by: 'Tester', created_at: '', open_count: 3, open_sen: 312306, open_payout_count: 2 }] }, isLoading: false }),
  useBankStatement: () => ({
    data: {
      statement: { id: 1, account_code: '330-0000', file_name: 'aug.csv', period_from: '2026-08-01', period_to: '2026-08-12', line_count: 9, skipped_lines: 1, in_sen: 3032963, out_sen: 352894, opening_balance_sen: 5000000, closing_balance_sen: 5312306, status: 'OPEN', uploaded_by: null, created_at: '' },
      reconciliation: recon,
      lines,
      unmatchedEntries: [],
    },
    isLoading: false,
  }),
  useUploadBankStatement: () => ({ mutate: vi.fn(), isPending: false }),
  useBookBankReceipt: () => ({ mutate: bookMutate, isPending: false, isError: false, error: null }),
  useMatchBankLine: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useIgnoreBankLine: () => ({ mutate: ignoreMutate, isPending: false, isError: false, error: null }),
  useUndoBankLine: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { BankStatementTab } from './BankStatementTab';

const openStatement = () => {
  render(<BankStatementTab />);
  fireEvent.click(screen.getByText('Reconcile'));
};

describe('the list of statements read', () => {
  test('says how much of each is still undecided, and how much of that is card money', () => {
    render(<BankStatementTab />);
    expect(screen.getByText('3 of 9 · 2 card payout(s)')).toBeTruthy();
  });

  test('names which acquirers can be recognised at all', () => {
    render(<BankStatementTab />);
    expect(screen.getByText(/Card money is recognised for MBB, PBB, AEON, HLB/)).toBeTruthy();
  });
});

describe('the reconciliation panel', () => {
  test('breaks the difference into the two sides that make it up', () => {
    openStatement();
    expect(screen.getByText(/The bank and the books differ by RM 3,123\.06/)).toBeTruthy();
    expect(screen.getByText(/on the bank and not in the books/)).toBeTruthy();
    expect(screen.getByText(/in the books and not on the bank/)).toBeTruthy();
  });

  /* A gap that predates the statement gets its own line — this period's work
     cannot close it, and folding it into the difference hides that. */
  test('names a difference brought forward separately', () => {
    recon = { ...RECON, broughtForwardSen: 30000 };
    openStatement();
    expect(screen.getByText(/brought forward/)).toBeTruthy();
    recon = RECON;
  });

  /* THE ONE THAT MATTERS: numbers that cannot account for themselves must
     REPLACE the verdict, not sit under it. */
  test('refuses to show a difference it cannot account for', () => {
    recon = { ...RECON, consistent: false, inconsistency: 'The difference of 100 sen does not equal what is unmatched on either side.' };
    openStatement();
    expect(screen.getByText('These numbers do not add up')).toBeTruthy();
    expect(screen.queryByText(/The bank and the books differ by/)).toBeNull();
    expect(screen.queryByText(/Made up of/)).toBeNull();
    recon = RECON;
  });

  test('says reconciled only when it is', () => {
    recon = { ...RECON, differenceSen: 0, closingLedgerSen: 5312306, bankNotInBooks: { count: 0, sen: 0 }, reconciled: true };
    openStatement();
    expect(screen.getByText(/Reconciled — the bank and the books agree/)).toBeTruthy();
    recon = RECON;
  });

  /* A file with no balances has nothing to compare — and a null must never
     render as a reconciled zero. */
  test('says there is nothing to compare when the file prints no balances', () => {
    recon = { ...RECON, closingStatementSen: null, differenceSen: null, broughtForwardSen: null };
    openStatement();
    expect(screen.getByText(/prints no balances/)).toBeTruthy();
    recon = RECON;
  });
});

describe('a movement still to decide', () => {
  test('ticks the statement the MATCHER chose, not the first candidate', () => {
    openStatement();
    /* Candidate 3 is listed first; 7 is the one whose day and amount agreed. */
    expect((screen.getByLabelText('Report mbb-credit.csv for line 2') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getAllByText('Money received')[0]!);
    expect(bookMutate).toHaveBeenCalledWith({
      lineId: 1, allocations: [{ batchId: 7, amountSen: 227700 }],
    });
  });

  /* 如果他很多，那么他会显示很多比哦？(owner, 2026-08-20). It did: every
     outstanding report of that acquirer, on every row, even where the matcher
     had already worked out which one it was. With ten reports open that is ten
     tick boxes a row and the one that matters is buried among nine that are
     not. A decided line shows its decision alone. */
  test('a decided line shows only its match, with the rest one press away', () => {
    openStatement();
    expect(screen.queryByLabelText('Report other.csv for line 2')).toBeNull();

    fireEvent.click(screen.getByLabelText('Other reports for line 2'));
    expect((screen.getByLabelText('Report other.csv for line 2') as HTMLInputElement).checked).toBe(false);
    /* And it folds back, so one look does not leave the screen noisy. */
    fireEvent.click(screen.getByLabelText('Other reports for line 2'));
    expect(screen.queryByLabelText('Report other.csv for line 2')).toBeNull();
  });

  /* The escape hatch has to be visible, or a wrong match is a dead end. */
  test('says how many other reports there are', () => {
    openStatement();
    expect(screen.getByText('Not this one? 1 other report(s)')).toBeTruthy();
  });

  /* An UNSURE line has decided nothing, so hiding candidates would hide the
     whole question. Every one stays on screen. */
  test('an unsure line still shows every report to choose from', () => {
    openStatement();
    expect(screen.getByLabelText('Report other.csv for line 7')).toBeTruthy();
    expect(screen.getByLabelText('Report mbb-credit.csv for line 7')).toBeTruthy();
    expect(screen.queryByLabelText('Other reports for line 7')).toBeNull();
  });

  /* Anything less than certain is left blank: a pre-filled guess is a guess
     somebody will press. */
  test('leaves an unsure payout for a person to choose', () => {
    openStatement();
    expect((screen.getByLabelText('Report other.csv for line 7') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Report mbb-credit.csv for line 7') as HTMLInputElement).checked).toBe(false);
  });

  /* ONE CREDIT, SEVERAL REPORTS — Public Bank's advice, and the shape the owner
     named on the merchant side: 顾客可能刷一次卡，但是还两个单. */
  test('pre-ticks every report of a split the matcher worked out', () => {
    lines = [{ ...LINE, kind: 'PAYOUT_SPLIT', amount_sen: 602004, matched_batch_id: null,
      split: [{ batchId: 3, amountSen: 374304 }, { batchId: 7, amountSen: 227700 }] }];
    openStatement();
    expect((screen.getByLabelText('Report other.csv for line 2') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Report mbb-credit.csv for line 2') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByText('Money received — 2 reports'));
    expect(bookMutate).toHaveBeenCalledWith({
      lineId: 1,
      allocations: [{ batchId: 3, amountSen: 374304 }, { batchId: 7, amountSen: 227700 }],
    });
    lines = [LINE, SPLIT, OTHER];
  });

  /* The same rule the merchant side applies to a swipe covering two orders: a
     leftover is a difference, and a difference must not be booked. */
  test('will not post a selection that does not add up, and says by how much', () => {
    lines = [{ ...LINE, kind: 'PAYOUT_SPLIT', amount_sen: 602004, matched_batch_id: null,
      split: [{ batchId: 3, amountSen: 374304 }, { batchId: 7, amountSen: 227700 }] }];
    openStatement();

    fireEvent.click(screen.getByLabelText('Report other.csv for line 2'));
    expect(screen.getByText(/Selected RM 2,277\.00 of RM 6,020\.04/)).toBeTruthy();
    expect(screen.getByText('RM 3,743.04 short')).toBeTruthy();
    expect((screen.getByText('Money received').closest('button') as HTMLButtonElement).disabled).toBe(true);
    lines = [LINE, SPLIT, OTHER];
  });

  test('shows the gross the bank actually credited when it split the payout', () => {
    openStatement();
    /* RM 871.06 arrived as RM 875.00 less RM 3.94 — without this the amount
       matches no line on the page he is holding. */
    expect(screen.getByText('RM 875.00 less RM 3.94 charge')).toBeTruthy();
  });

  test('carries the clue the matcher wrote, with both numbers in it', () => {
    openStatement();
    expect(screen.getByText(/that report is owed RM 900\.00 and this credit is RM 871\.06/)).toBeTruthy();
  });

  test('offers no merchant report for money that is not card money', () => {
    openStatement();
    expect(screen.queryByLabelText('Merchant report for line 9')).toBeNull();
  });

  /* An ignored movement leaves the difference for ever and this sentence is
     all the next person will have. */
  test('will not leave a movement out without a reason', () => {
    openStatement();
    const row = screen.getByText('SERVICE CHARGE').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByText('Not ours to reconcile'));
    const button = within(row).getByText('Leave it out').closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(within(row).getByLabelText('Why line 9 is not ours'), {
      target: { value: 'bank charge, posted from the GL side' },
    });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(ignoreMutate).toHaveBeenCalledWith({ lineId: 3, note: 'bank charge, posted from the GL side' });
  });
});

describe('what is in the books and not on the statement', () => {
  test('is its own section, named, not a count', () => {
    lines = [LINE];
    render(<BankStatementTab />);
    fireEvent.click(screen.getByText('Reconcile'));
    /* With none, the section stays off the screen rather than showing a zero. */
    expect(screen.queryByText(/In the books, not on this statement/)).toBeNull();
    lines = [LINE, SPLIT, OTHER];
  });
});
