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

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test, vi, afterEach } from 'vitest';
import type { BankLine, Reconciliation, LedgerEntry } from './bank-queries';

const bookMutate = vi.fn();
const bookMutateAsync = vi.fn();
const uploadMutate = vi.fn();
/* pdf.js never runs under jsdom: the extractor is stubbed, and what is
   pinned is that a picked .pdf goes to the server AS its extracted text,
   marked as a PDF (docs/bugs/0869). */
vi.mock('../../vendor/scm/lib/pdf-text', () => ({
  PDF_TEXT_KIND: 'houzs-pdf-text/1',
  extractPdfText: vi.fn(async () => ({ kind: 'houzs-pdf-text/1', pages: [{ lines: [{ y: 693, cells: [{ x: 449, t: '31/08/26' }] }] }] })),
}));
const matchMutate = vi.fn();
const groupMutate = vi.fn();
const ignoreMutate = vi.fn();

const LINE: BankLine = {
  id: 1, line_no: 2, booked_on: '2026-08-03',
  description: 'CR/CARD SALES MN 32409997 DATED 14082026', reference: '99970814',
  amount_sen: 227700, charge_sen: 0, kind: 'PAYOUT',
  acquirer_code: 'MBB', trading_date: '2026-08-14', merchant_no: '32409997',
  matched_batch_id: 7, split: null, state: 'OPEN', posted_je_no: null, note: null, matches: [], entryCandidates: [],
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
  carried: { count: 0, sen: 0 }, carriedJeNos: [], broughtForwardExplained: null,
  outstandingPayments: { count: 0, sen: 0 }, outstandingReceipts: { count: 0, sen: 0 }, outstandingJeNos: [],
  computedClosingSen: 5312306, unexplainedSen: 0, tallies: true,
  consistent: true, inconsistency: null, reconciled: false,
};

let recon: Reconciliation = RECON;
let lines: BankLine[] = [LINE, SPLIT, OTHER];
let unmatched: LedgerEntry[] = [];
let statementPeriod = { period_from: '2026-08-01', period_to: '2026-08-12' };
const periodMutate = vi.fn();
const autoMatchMutate = vi.fn();
let autoMatchResult: { matched: number; jeNos: string[]; contraPairs: number } | undefined;
afterEach(() => { unmatched = []; recon = RECON; lines = [LINE, SPLIT, OTHER]; statementPeriod = { period_from: '2026-08-01', period_to: '2026-08-12' }; });

vi.mock('./bank-queries', () => ({
  useBankSetup: () => ({ data: { accounts: [{ account_code: '310-0010', bank_code: 'MBB', account_no: '0000564418610346', statement_format: 'CSV', is_active: true, ready: true }], recognises: ['MBB', 'PBB', 'AEON', 'HLB'] }, isLoading: false }),
  useBankStatements: () => ({ data: { statements: [{ id: 1, account_code: '310-0010', file_name: 'aug.csv', period_from: '2026-08-01', period_to: '2026-08-12', line_count: 9, skipped_lines: 1, in_sen: 3032963, out_sen: 352894, opening_balance_sen: null, closing_balance_sen: null, status: 'OPEN', uploaded_by: 'Tester', created_at: '', open_count: 3, open_sen: 312306, open_payout_count: 2 }] }, isLoading: false }),
  useBankStatement: () => ({
    data: {
      statement: { id: 1, account_code: '310-0010', file_name: 'aug.csv', ...statementPeriod, line_count: 9, skipped_lines: 1, in_sen: 3032963, out_sen: 352894, opening_balance_sen: 5000000, closing_balance_sen: 5312306, status: 'OPEN', uploaded_by: null, created_at: '' },
      reconciliation: recon,
      lines,
      unmatchedEntries: unmatched,
    },
    isLoading: false,
  }),
  useUploadBankStatement: () => ({ mutate: uploadMutate, isPending: false }),
  useBookBankReceipt: () => ({ mutate: bookMutate, mutateAsync: bookMutateAsync, isPending: false, isError: false, error: null }),
  useMatchBankLine: () => ({ mutate: matchMutate, isPending: false, isError: false, error: null }),
  useMatchBankGroup: () => ({ mutate: groupMutate, isPending: false, isError: false, error: null }),
  useSetStatementPeriod: () => ({ mutate: periodMutate, isPending: false, isError: false, error: null }),
  useAutoMatchStatement: () => ({ mutate: autoMatchMutate, isPending: false, isError: false, error: null, data: autoMatchResult }),
  useIgnoreBankLine: () => ({ mutate: ignoreMutate, isPending: false, isError: false, error: null }),
  useUndoBankLine: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { BankStatementTab } from './BankStatementTab';

const openStatement = () => {
  render(<BankStatementTab />);
  fireEvent.click(screen.getByText('Reconcile'));
};

/* docs/bugs/0794: the month box is ALSO how a file with no transactions is
   filed — the sentence under it must say so, or the refusal it points at
   makes no sense. */
/* Owner, 2026-09-11: in the books, not on this statement 我要看到 payment
   detail, 例如 pay to who; and 之前 in book 还没有 recon 的也要带下来. */
describe('what the books hold that the bank has not shown', () => {
  test('names who each entry was paid to or received from, this month\'s and earlier months\' in one table', () => {
    unmatched = [
      { jeNo: '2990-JE-2604-0024', entryDate: '2026-04-30', sourceType: 'PV', sourceDocNo: '2990-HPV-2604-007', debitSen: 0, creditSen: 310168, partyName: 'HOUZS VENTURE HOLDING SDN BHD', carried: false },
      { jeNo: '2990-JE-2603-0009', entryDate: '2026-03-28', sourceType: 'PV', sourceDocNo: '2990-HPV-2603-009', debitSen: 0, creditSen: 45000, partyName: 'TENAGA NASIONAL BERHAD', carried: true },
    ];
    recon = { ...RECON, booksNotOnBank: { count: 1, sen: -310168 }, carried: { count: 1, sen: -45000 }, carriedJeNos: ['2990-JE-2603-0009'], broughtForwardSen: 45000, broughtForwardExplained: true };
    openStatement();
    /* One table (owner: 全部就是 outstanding items，一张表列完), this month's and
       the earlier one alike, each with who. */
    const table = screen.getByText(/Outstanding items — in the books, not yet on the bank \(2\)/).closest('section') as HTMLElement;
    expect(within(table).getByText('HOUZS VENTURE HOLDING SDN BHD')).toBeTruthy();
    expect(within(table).getByText('TENAGA NASIONAL BERHAD')).toBeTruthy();
    expect(within(table).getByText('2990-JE-2603-0009')).toBeTruthy();
    expect(screen.queryByText(/From earlier months/)).toBeNull();
    expect(screen.queryByText(/brought forward/)).toBeNull();
    unmatched = [];
    recon = RECON;
  });

  test('a candidate entry names who was paid', () => {
    lines = [{ ...IN_BOOKS, entryCandidates: [{ ...IN_BOOKS.entryCandidates[0]!, partyName: 'AH SENG TRADING' }] }];
    openStatement();
    expect(screen.getByText(/HOUZS CENTURY SDN\. BHD\./)).toBeTruthy();
    lines = [LINE, SPLIT, OTHER];
  });

  test('a candidate entry names its document and its customer when the server has them (docs/bugs/0918)', () => {
    lines = [{ ...IN_BOOKS, entryCandidates: [{ ...IN_BOOKS.entryCandidates[0]!, reference: '2990DraftOR-2608-005 · 2990-SO-2608-067', who: 'NG KAH YEE' }] }];
    openStatement();
    expect(screen.getByText(/2990DraftOR-2608-005 · 2990-SO-2608-067 · NG KAH YEE/)).toBeTruthy();
    lines = [LINE, SPLIT, OTHER];
  });

  test('the month box says a dated file it names covers the whole month', () => {
    render(<BankStatementTab />);
    expect(screen.getByText(/covers that whole month/)).toBeTruthy();
  });
});

/* ── Several movements to one entry ──────────────────────────────────────────
   Owner, 2026-09-11, on OR-2604-001 = RM 29,000 + RM 10,000: 你应该开发让我自由选.
   Tick the movements, choose the entry, and the totals must agree
   (docs/bugs/0803). */
describe('choosing an entry for several movements at once', () => {
  const RECEIPT: LedgerEntry = { jeNo: '2990-JE-2604-0017', entryDate: '2026-04-30', sourceType: 'RCT', sourceDocNo: '2990-OR-2604-001', debitSen: 3900000, creditSen: 0, partyName: 'HOUZS VENTURE HOLDING SDN BHD', carried: false };
  const OTHER_ENTRY: LedgerEntry = { jeNo: '2990-JE-2604-0024', entryDate: '2026-04-30', sourceType: 'PV', sourceDocNo: '2990-HPV-2604-007', debitSen: 0, creditSen: 310168, partyName: 'HOUZS VENTURE HOLDING SDN BHD', carried: false };
  const big: BankLine = { ...OTHER, id: 21, line_no: 18, amount_sen: 2900000, description: 'Fund Transfer at DIO', reference: '2990 Home PV-000050 HOUZS VENTURE HOLDING SDN. BHD.' };
  const small: BankLine = { ...OTHER, id: 22, line_no: 17, amount_sen: 1000000, description: 'Fund Transfer at DIO', reference: '2990 PV-000051 HOUZS VENTURE HOLDING SDN. BHD.' };

  /* No second list (owner 2026-09-15: 下面不是有 list 了吗; docs/bugs/0918): the
     entries are ticked in the outstanding list the screen already had, and
     the totals and the button sit in a bar at the foot of the window. */
  test('ticking movements raises the bar with their total; the entries are ticked in the outstanding list, which names who', () => {
    lines = [big, small, OTHER];
    unmatched = [RECEIPT, OTHER_ENTRY];
    openStatement();
    expect(screen.queryByText(/Choose the entry these movements are/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Match the ticked movements and entries' })).toBeNull();
    fireEvent.click(screen.getByLabelText('Pick line 18'));
    fireEvent.click(screen.getByLabelText('Pick line 17'));
    const bar = screen.getByRole('region', { name: 'Match the ticked movements and entries' });
    /* The bar lives in the page column, stuck to the foot of the scrolling pane, the
       bottom-right button cluster kept clear — not fixed across the window, where the
       sidebar covered its left and the + / Assistant discs its buttons (owner 2026-09-22). */
    expect(bar.style.position).toBe('sticky');
    expect(bar.style.left).toBe('');
    expect(bar.className).toContain('lg:pr-36');
    expect(bar.textContent).toContain('2 movements');
    expect(bar.textContent).toContain('RM 39,000.00');
    expect(bar.textContent).toContain('Tick the entry');
    expect(screen.queryByText(/Choose the entry these movements are/)).toBeNull();
    const list = screen.getByText(/Outstanding items — in the books, not yet on the bank \(2\)/).closest('section') as HTMLElement;
    expect(within(list).getAllByText('HOUZS VENTURE HOLDING SDN BHD', { selector: 'td' })).toHaveLength(2);
    expect(within(list).getByLabelText('Entry 2990-JE-2604-0017 for the picked movements')).toBeTruthy();
    /* Clear empties both sides and the bar goes. */
    fireEvent.click(within(bar).getByText('Clear'));
    expect(screen.queryByRole('region', { name: 'Match the ticked movements and entries' })).toBeNull();
  });

  test('the button waits until the two totals agree, then sends the movements and the entry', () => {
    lines = [big, small, OTHER];
    unmatched = [RECEIPT, OTHER_ENTRY];
    openStatement();
    fireEvent.click(screen.getByLabelText('Pick line 18'));
    fireEvent.click(screen.getByLabelText('Pick line 17'));
    const go = () => screen.getByText('These are that entry') as HTMLButtonElement;
    expect(go().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Entry 2990-JE-2604-0024 for the picked movements'));
    expect(go().disabled).toBe(true);
    expect(screen.getByText(/RM 42,101\.68 out/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Entry 2990-JE-2604-0024 for the picked movements'));
    fireEvent.click(screen.getByLabelText('Entry 2990-JE-2604-0017 for the picked movements'));
    expect(go().disabled).toBe(false);
    fireEvent.click(go());
    expect(groupMutate.mock.calls[0]?.[0]).toEqual({ lineIds: [21, 22], jeNos: ['2990-JE-2604-0017'] });
  });
});

/* An old file uploaded before the month box covered a month reads 30/4 → 30/4.
   It can be re-filed as the month's statement in place (owner: 可以，没有问题，
   这只是显示问题吧) — docs/bugs/0806. */
describe('re-filing an old statement as its month\'s', () => {
  test('offers the button when the file does not cover its month, and sends the month', () => {
    statementPeriod = { period_from: '2026-04-30', period_to: '2026-04-30' };
    openStatement();
    const go = screen.getByText("This file is April 2026's statement");
    fireEvent.click(go);
    expect(periodMutate.mock.calls[0]?.[0]).toEqual({ id: 1, month: '2026-04' });
  });

  test('offers nothing when the file already covers the month', () => {
    statementPeriod = { period_from: '2026-04-01', period_to: '2026-04-30' };
    openStatement();
    expect(screen.queryByText(/'s statement$/)).toBeNull();
  });
});

/* Owner, 2026-09-11: 为了方便看，你可以把这个金额分成 debit 和 credit 吗？ The
   books' tables carry Debit and Credit the way a ledger does (a payment is a
   credit to the bank account); the bank's own movements carry Deposit and
   Withdrawal, the words on the statement (docs/bugs/0813). */
describe('amounts in two columns', () => {
  const cellsOf = (row: HTMLElement) => within(row).getAllByRole('cell').map((c) => String(c.textContent).trim());

  test('an entry in the books shows under Debit or Credit, never as a signed figure', () => {
    unmatched = [
      { jeNo: '2990-JE-2604-0024', entryDate: '2026-04-30', sourceType: 'PV', sourceDocNo: '2990-HPV-2604-007', debitSen: 0, creditSen: 310168, partyName: 'HOUZS VENTURE HOLDING SDN BHD', carried: false },
      { jeNo: '2990-JE-2606-0084', entryDate: '2026-06-04', sourceType: 'RCT', sourceDocNo: '2990-OR-2606-001', debitSen: 1200000, creditSen: 0, partyName: 'HOUZS VENTURE HOLDING SDN BHD', carried: false },
    ];
    openStatement();
    const table = screen.getByText(/Outstanding items — in the books, not yet on the bank \(2\)/).closest('section') as HTMLElement;
    const heads = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['', 'Entry', 'Date', 'Reference', 'Customer / payee', 'Debit', 'Credit']);
    expect(cellsOf(within(table).getByText('2990-JE-2604-0024').closest('tr') as HTMLElement).slice(5)).toEqual(['', 'RM 3,101.68']);
    expect(cellsOf(within(table).getByText('2990-JE-2606-0084').closest('tr') as HTMLElement).slice(5)).toEqual(['RM 12,000.00', '']);
    expect(screen.queryByText('RM -3,101.68')).toBeNull();
  });

  /* Named by the document a person holds and by the person (docs/bugs/0918):
     the OR and the SO, the PV number, the customer — off the server's
     reference and who; an entry without them keeps its source. */
  test('the outstanding list names each entry by its reference and its customer or payee, dates dd/mm/yyyy', () => {
    unmatched = [
      { jeNo: '2990-JE-2608-0044', entryDate: '2026-08-05', sourceType: 'SOPAY', sourceDocNo: 'cacb0d35-8f9f-4a94-a156-d1b0f96b52d0', debitSen: 187000, creditSen: 0, partyName: null, notes: 'Payment received (transfer) — 2990-SO-2606-014', reference: '2990DraftOR-2608-001 · 2990-SO-2606-014', who: 'Ah Meng', carried: false },
      { jeNo: '2990-JE-2608-0145', entryDate: '2026-08-12', sourceType: 'PV', sourceDocNo: '2990-HPV-2608-017', debitSen: 0, creditSen: 1890, partyName: 'LOO WEN WEI', notes: null, reference: '2990-HPV-2608-017', who: 'LOO WEN WEI', carried: false },
      { jeNo: '2990-JE-2607-0001', entryDate: '2026-07-01', sourceType: 'MANUAL', sourceDocNo: null, debitSen: 100, creditSen: 0, partyName: null, notes: 'Opening', carried: true },
    ];
    openStatement();
    const table = screen.getByText(/Outstanding items — in the books, not yet on the bank \(3\)/).closest('section') as HTMLElement;
    expect(cellsOf(within(table).getByText('2990-JE-2608-0044').closest('tr') as HTMLElement).slice(1, 5)).toEqual(['2990-JE-2608-0044', '05/08/2026', '2990DraftOR-2608-001 · 2990-SO-2606-014', 'Ah Meng']);
    expect(cellsOf(within(table).getByText('2990-JE-2608-0145').closest('tr') as HTMLElement).slice(2, 5)).toEqual(['12/08/2026', '2990-HPV-2608-017', 'LOO WEN WEI']);
    /* No reference from the server: the source, and the note for who. */
    expect(cellsOf(within(table).getByText(/2990-JE-2607-0001/).closest('tr') as HTMLElement).slice(1, 5)).toEqual(['2990-JE-2607-0001 · earlier month', '01/07/2026', 'MANUAL', 'Opening']);
    expect(screen.queryByText('cacb0d35-8f9f-4a94-a156-d1b0f96b52d0')).toBeNull();
  });

  test('a bank movement shows under Deposit or Withdrawal', () => {
    openStatement();
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toContain('Deposit');
    expect(heads).toContain('Withdrawal');
    expect(heads).not.toContain('Amount');
    const charge = screen.getByText('SERVICE CHARGE').closest('tr') as HTMLElement;
    const cells = cellsOf(charge);
    /* tick box, the movement, Deposit, Withdrawal, what it looks like, what to do */
    expect(cells[2]).toBe('');
    expect(cells[3]).toBe('RM 25.00');
    expect(screen.queryByText('RM -25.00')).toBeNull();
  });

  test('a movement reads date · line, then its reference, then its description; the list runs by date', () => {
    lines = [
      { ...OTHER, id: 31, line_no: 46, booked_on: '2026-08-14', amount_sen: -480000, description: 'CIB Instant Transfer at DIO', reference: 'Transfer 2990 HOME SDN. BHD. 20260814HLBBMYKL010OCB72193076' },
      { ...OTHER, id: 32, line_no: 26, booked_on: '2026-08-06', amount_sen: -517375, description: 'CIB Instant Transfer at DIO', reference: 'JULY SALARY ENG SUI HOR 20260806HLBBMYKL010OCB64596966' },
      { ...OTHER, id: 33, line_no: 12, booked_on: '2026-08-04', amount_sen: -412467, description: 'CIB Instant Transfer at DIO', reference: 'JULY SALARY LING WAI 20260804HLBBMYKL010OCB62409168' },
      { ...OTHER, id: 34, line_no: 15, booked_on: '2026-08-04', amount_sen: -417931, description: 'CIB Instant Transfer at DIO', reference: 'JULY SALARY CHONG KAR YIN 20260804HLBBMYKL010OCB62429132' },
    ];
    openStatement();
    const rows = screen.getAllByLabelText(/^Pick line /).map((b) => b.getAttribute('aria-label'));
    /* Oldest first, then the line — not biggest first (owner: 不是根据日期往下排的). */
    expect(rows).toEqual(['Pick line 12', 'Pick line 15', 'Pick line 26', 'Pick line 46']);
    const cell = screen.getByText('JULY SALARY ENG SUI HOR 20260806HLBBMYKL010OCB64596966').closest('td') as HTMLElement;
    const linesOfCell = Array.from(cell.querySelectorAll(':scope > div')).map((d) => String(d.textContent).trim());
    expect(linesOfCell).toEqual(['06/08/2026 · line 26', 'JULY SALARY ENG SUI HOR 20260806HLBBMYKL010OCB64596966', 'CIB Instant Transfer at DIO']);
    expect(screen.queryByText('2026-08-06')).toBeNull();
  });
});

/* docs/bugs/0814 — the obvious ones are matched without a hand; a statement
   uploaded before the rule can have it run. */
describe('matching the obvious ones', () => {
  test('a statement with movements still to decide offers to run the rule, and says what it did', () => {
    autoMatchResult = { matched: 3, jeNos: ['JE-1', 'JE-2', 'JE-3'], contraPairs: 1 };
    openStatement();
    fireEvent.click(screen.getByText('Match the obvious ones now'));
    expect(autoMatchMutate.mock.calls[0]?.[0]).toBe(1);
    expect(screen.getByText(/3 matched by amount and name/)).toBeTruthy();
    /* And the pair the bank reversed (docs/bugs/0817). */
    expect(screen.getByText(/1 pair the bank reversed left out/)).toBeTruthy();
    autoMatchResult = undefined;
  });

  test('a movement matched by the rule says so where it is listed as dealt with', () => {
    lines = [{ ...OTHER, state: 'POSTED', posted_je_no: '2990-JE-2606-0060', matches: [{ je_no: '2990-JE-2606-0060', amount_sen: -2500, match_reason: 'amount+name' }] }];
    openStatement();
    fireEvent.click(screen.getByText('Show'));
    expect(screen.getByText(/matched by amount and name/)).toBeTruthy();
  });
});

describe('the year-and-month box', () => {
  test('says it also files a statement that carries no transactions', () => {
    render(<BankStatementTab />);
    expect(screen.getByLabelText('Statement month')).toBeTruthy();
    expect(screen.getByText(/no transactions at all/)).toBeTruthy();
  });
});

describe('the list of statements read', () => {
  test('says how much of each is still undecided, and how much of that is card money', () => {
    render(<BankStatementTab />);
    expect(screen.getByText('3 of 9 · 2 card payout(s)')).toBeTruthy();
  });

  test('names which acquirers can be recognised at all', () => {
    render(<BankStatementTab />);
    expect(screen.getByText(/Card money is recognised for MBB, PBB, AEON, HLB/)).toBeTruthy();
  });

  /* One account's files at a time (owner 2026-09-13: 无法分辨), the tab
     naming the bank the way the upload box does. */
  test('lists the files one account at a time, the tab naming the bank', () => {
    render(<BankStatementTab />);
    const tab = screen.getByRole('tab', { name: 'MBB · 310-0010' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('aug.csv')).toBeTruthy();
  });
});

/* ── The owner's form (2026-09-11, docs/bugs/0806) ─────────────────────────
   Closing — the books (−)/+ unreconciled items = closing bank statement. The
   panel lays that walk out, says whether it TALLIES, and calls a month whose
   only difference is an unpresented payment reconciled — not "differing". */
describe('the reconciliation panel', () => {
  /* April on 2990's Hong Leong account: books −2,163.31, one payment of
     3,101.68 the bank has not paid yet, bank 938.37. */
  const APRIL: Reconciliation = {
    ...RECON,
    closingStatementSen: 93837, closingLedgerSen: -216331, differenceSen: 310168,
    bankNotInBooks: { count: 0, sen: 0 },
    booksNotOnBank: { count: 1, sen: -310168 }, unmatchedJeNos: ['2990-JE-2604-0024'],
    outstandingPayments: { count: 1, sen: -310168 }, outstandingReceipts: { count: 0, sen: 0 }, outstandingJeNos: ['2990-JE-2604-0024'],
    computedClosingSen: 93837, unexplainedSen: 0, tallies: true, reconciled: true,
  };

  test('walks from the books through the outstanding items to the bank, and says it tallies', () => {
    recon = APRIL;
    openStatement();
    expect(screen.getByText(/^Reconciled/)).toBeTruthy();
    const row = (label: string | RegExp) => screen.getByText(label).closest('tr') as HTMLElement;
    expect(within(row('Closing per the books')).getByText('RM -2,163.31')).toBeTruthy();
    expect(within(row(/^Add: payments in the books the bank has not paid yet/)).getByText('RM 3,101.68')).toBeTruthy();
    expect(screen.getByText(/Add: payments in the books the bank has not paid yet \(1 item\)/)).toBeTruthy();
    expect(within(row('Closing per the books after outstanding items')).getByText('RM 938.37')).toBeTruthy();
    expect(within(row('Closing per bank statement')).getByText('RM 938.37')).toBeTruthy();
    expect(screen.getByText('✓ Tallies')).toBeTruthy();
    expect(screen.queryByText(/differ by/)).toBeNull();
    expect(screen.queryByText(/brought forward/)).toBeNull();
  });

  test('says by how much it is off when the bank\'s closing is not reached', () => {
    recon = { ...APRIL, closingStatementSen: 93837 + 777, unexplainedSen: 777, tallies: false, reconciled: false };
    openStatement();
    expect(screen.getByText(/Does not tally/)).toBeTruthy();
    expect(screen.getByText('✗ Off by RM 7.77')).toBeTruthy();
    expect(screen.queryByText(/^Reconciled/)).toBeNull();
  });

  test('a movement still to decide is its own line, and the month is not reconciled until it is', () => {
    recon = { ...APRIL, closingStatementSen: 93837 + 5000, computedClosingSen: 93837 + 5000, bankNotInBooks: { count: 1, sen: 5000 }, reconciled: false };
    openStatement();
    expect(screen.getByText(/On the bank, not in the books \(1 still to decide\)/)).toBeTruthy();
    expect(screen.getByText('✓ Tallies')).toBeTruthy();
    expect(screen.queryByText(/^Reconciled/)).toBeNull();
    expect(screen.getByText(/1 movement on the bank still to decide/)).toBeTruthy();
  });

  test('refuses to show a walk it cannot account for', () => {
    recon = { ...APRIL, consistent: false, inconsistency: 'The statement balances and the lines under them disagree — check the file before trusting either.', reconciled: false, tallies: false };
    openStatement();
    expect(screen.getByText(/These numbers do not add up/)).toBeTruthy();
    expect(screen.getByText(/check the file before trusting either/)).toBeTruthy();
    expect(screen.queryByText(/Closing per the books/)).toBeNull();
  });

  test('says there is nothing to compare when the file prints no balances', () => {
    recon = { ...APRIL, closingStatementSen: null, openingStatementSen: null, differenceSen: null, unexplainedSen: null, tallies: false, reconciled: false };
    openStatement();
    expect(screen.getByText(/prints no balances/)).toBeTruthy();
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

/* ── "THIS MOVEMENT IS ALREADY IN THE BOOKS" ──────────────────────────────────
   Owner, 2026-09-09, looking at a RM 3,000 transfer with the RM 3,000 receipt
   that posted it sitting one section below: the only button on the row was
   "Not ours to reconcile", which is not true. It IS ours; it is already booked.

   What is pinned here is the shape of the choice, because the operator is
   agreeing that two records are ONE FACT: nothing is pre-selected for him, the
   entry is named well enough to recognise (number, date, and the document
   behind it), and the button cannot fire until he has actually chosen. Which
   entries are offered at all is the server's decision and is pinned in
   backend/src/acc/bank-entry-match.test.ts. */

const IN_BOOKS: BankLine = {
  ...OTHER, id: 4, line_no: 4, amount_sen: 300000,
  description: 'DEPO OPEN HLBB BANK HPV-2602-028 HOUZS CENTURY SDN. BHD.',
  reference: 'Fund Transfer at DIO',
  entryCandidates: [
    {
      jeNo: '2990-JE-2602-0002', entryDate: '2026-02-07',
      sourceType: 'RCT', sourceDocNo: '2990-OR-2609-001',
      debitSen: 300000, creditSen: 0, amountSen: 300000, daysApart: 0,
    },
    {
      jeNo: '2990-JE-2602-0011', entryDate: '2026-02-09',
      sourceType: 'PV', sourceDocNo: '2990-HPV-2602-028',
      debitSen: 300000, creditSen: 0, amountSen: 300000, daysApart: 2,
    },
  ],
};

describe('a movement that is already in the books', () => {
  const openWith = (l: BankLine) => {
    lines = [l];
    openStatement();
  };

  test('offers the entries it could be, named by number, date and document', () => {
    openWith(IN_BOOKS);
    expect(screen.getByText('2990-JE-2602-0002')).toBeTruthy();
    expect(screen.getByText(/RCT · 2990-OR-2609-001/)).toBeTruthy();
    expect(screen.getByText('This is that entry')).toBeTruthy();
    lines = [LINE, SPLIT, OTHER];
  });

  /* An entry a few days off is offered — a cheque banked on Friday clears on
     Monday — but the distance is SHOWN, because that is the thing the operator
     has to weigh. */
  test('says how far off a candidate is, and says nothing when it is the same day', () => {
    openWith(IN_BOOKS);
    expect(screen.getByText(/2d apart/)).toBeTruthy();
    expect(screen.queryByText(/0d apart/)).toBeNull();
    lines = [LINE, SPLIT, OTHER];
  });

  /* THE ONE THAT MATTERS. Two records being one fact is a judgement; a
     pre-ticked answer would make it for him. */
  test('pre-selects nothing, and will not fire until he chooses', () => {
    openWith(IN_BOOKS);
    const go = screen.getByText('This is that entry').closest('button')!;
    expect(go.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Entry 2990-JE-2602-0002 for line 4'));
    expect(screen.getByText('This is that entry').closest('button')!.disabled).toBe(false);
    lines = [LINE, SPLIT, OTHER];
  });

  test('sends the entry he chose, not the first one offered', () => {
    matchMutate.mockClear();
    openWith(IN_BOOKS);
    fireEvent.click(screen.getByLabelText('Entry 2990-JE-2602-0011 for line 4'));
    fireEvent.click(screen.getByText('This is that entry'));
    expect(matchMutate).toHaveBeenCalledWith({ lineId: 4, jeNo: '2990-JE-2602-0011' });
    lines = [LINE, SPLIT, OTHER];
  });

  /* Leaving it out stays available — some movements really are none of our
     business — but it is no longer the only thing on offer. */
  test('still offers to leave it out', () => {
    openWith(IN_BOOKS);
    expect(screen.getByText('Not ours to reconcile')).toBeTruthy();
    lines = [LINE, SPLIT, OTHER];
  });

  test('a movement the books hold nothing like gets no such list', () => {
    openWith({ ...IN_BOOKS, id: 5, line_no: 5, entryCandidates: [] });
    expect(screen.queryByText('This is that entry')).toBeNull();
    expect(screen.getByText('Not ours to reconcile')).toBeTruthy();
    lines = [LINE, SPLIT, OTHER];
  });
});

/* ── WHERE THE RECONCILIATION IS SAVED ────────────────────────────────────────
   Owner, 2026-09-09: 我也没有看到哪里可以save 这个recon. There is no Save because
   there is no draft — so the screen has to say that, and then point at the
   thing he is actually looking for, which is closing the MONTH. */

describe('where a reconciliation is saved', () => {
  test('says there is nothing to save, because each decision writes itself', () => {
    openStatement();
    expect(screen.getByText(/Nothing here needs saving/)).toBeTruthy();
  });

  test('points at closing the month while there is still work', () => {
    openStatement();
    expect(screen.getByText(/recorded/)).toBeTruthy();
    expect(screen.getByText(/By month/)).toBeTruthy();
  });

  /* When the file is finished, name the month by number so the person is not
     translating a date range in his head. */
  /* Spoken only over movements that were READ and counted. A failed read hands
     back an empty list, which is indistinguishable from a finished statement —
     so an absence must never be reported as completion. */
  test('says nothing about being finished when no movement came back', () => {
    lines = [];
    openStatement();
    expect(screen.queryByText(/movements read on this file are decided/)).toBeNull();
    expect(screen.getByText(/Nothing here needs saving/)).toBeTruthy();
    lines = [LINE, SPLIT, OTHER];
  });

  test('names the month once every movement is decided', () => {
    lines = [{ ...OTHER, state: 'IGNORED', note: 'own transfer' }];
    openStatement();
    expect(screen.getByText(/movements read on this file are decided/)).toBeTruthy();
    expect(screen.getByText(/08\/2026/)).toBeTruthy();
    lines = [LINE, SPLIT, OTHER];
  });
});

/* ── Every certain payout at once (owner 2026-09-14: 这些我还需要自己确定吗？;
   docs/bugs/0868). Certain = the matcher tied it to one report for exactly
   what that report is still owed — LINE. The split (SPLIT) and the plain
   movement (OTHER) are not, and stay for a person. ─────────────────────────── */
describe('every certain payout at once', () => {
  test('names how many are certain, posts each through the row\'s own door with the row\'s own allocation, and leaves the rest alone', async () => {
    bookMutateAsync.mockReset();
    bookMutateAsync.mockResolvedValue({ ok: true, status: 'posted', jeNo: 'JE-9', results: [] });
    openStatement();
    fireEvent.click(screen.getByText('Money received — all 1 matched payout'));
    await waitFor(() => expect(bookMutateAsync).toHaveBeenCalledTimes(1));
    expect(bookMutateAsync).toHaveBeenCalledWith({ lineId: 1, allocations: [{ batchId: 7, amountSen: 227700 }] });
    expect(await screen.findByText(/1 posted — JE-9/)).toBeTruthy();
  });

  test('a refusal is named with the line and the amount, and the others still post', async () => {
    bookMutateAsync.mockReset();
    lines = [LINE, { ...LINE, id: 4, line_no: 11, amount_sen: 374304, matched_batch_id: 3, note: null }, SPLIT, OTHER];
    bookMutateAsync
      .mockResolvedValueOnce({ ok: true, status: 'posted', jeNo: 'JE-9', results: [] })
      .mockRejectedValueOnce(new Error('310-0010 2026-08 was closed by Chew on 2026-09-01 — reopen it first.'));
    openStatement();
    fireEvent.click(screen.getByText('Money received — all 2 matched payouts'));
    await waitFor(() => expect(bookMutateAsync).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/1 posted — JE-9/)).toBeTruthy();
    /* The table runs by date then line (docs/bugs/0918), so line 2 posts and
       line 11 (RM 3,743.04) is the one refused — named with its amount. */
    expect(bookMutateAsync.mock.calls.map((c) => (c[0] as { lineId: number }).lineId)).toEqual([1, 4]);
    expect(screen.getByText(/line 11 \(RM 3,743\.04\): .*closed by Chew/)).toBeTruthy();
  });

  test('offers nothing when no payout is certain', () => {
    lines = [SPLIT, OTHER];
    openStatement();
    expect(screen.queryByText(/Money received — all/)).toBeNull();
  });
});

/* ── The bank's monthly statement PDF (owner 2026-09-14: 也支持 csv，也支持 pdf;
   docs/bugs/0869): the browser reads its text with positions and the upload
   carries it marked as a PDF; a CSV goes as it always did. ────────────────── */
describe('uploading a statement PDF', () => {
  const pick = async (file: File) => {
    render(<BankStatementTab />);
    fireEvent.change(screen.getByLabelText('Bank account'), { target: { value: '310-0010' } });
    const input = screen.getByLabelText('Bank statement file') as HTMLInputElement;
    expect(input.accept).toContain('.pdf');
    fireEvent.change(input, { target: { files: [file] } });
    const go = () => screen.getByText('Upload bank statement').closest('button') as HTMLButtonElement;
    await waitFor(() => expect(go().disabled).toBe(false));
    fireEvent.click(go());
    expect(uploadMutate).toHaveBeenCalledTimes(1);
    return uploadMutate.mock.calls[0]![0] as { fileName: string; format: string; content: string; accountCode: string };
  };

  test('a picked .pdf is sent as its extracted text, marked PDF', async () => {
    uploadMutate.mockReset();
    const sent = await pick(new File(['%PDF-1.4'], 'MBBcurrent_564418759397_2026-08-31.pdf', { type: 'application/pdf' }));
    expect(sent).toMatchObject({ accountCode: '310-0010', fileName: 'MBBcurrent_564418759397_2026-08-31.pdf', format: 'PDF' });
    expect(JSON.parse(sent.content)).toMatchObject({ kind: 'houzs-pdf-text/1', pages: [{ lines: [{ y: 693 }] }] });
  });

  test('a picked .csv is sent as its text, marked CSV, as it always was', async () => {
    uploadMutate.mockReset();
    const sent = await pick(new File(['EFFECT DATE|AMOUNT\n20260605|100'], 'aug.csv', { type: 'text/csv' }));
    expect(sent).toMatchObject({ fileName: 'aug.csv', format: 'CSV', content: 'EFFECT DATE|AMOUNT\n20260605|100' });
  });
});

/* ── A decision that changes under an open row (docs/bugs/0870). The matcher
   decides every line again on each read; a row drawn as "check which" whose
   decision becomes "one payout for several reports" must show the reports
   the matcher picked, ticked, with the button live — not its old empty
   state. ───────────────────────────────────────────────────────────────── */
describe('a row whose decision changes under it', () => {
  test('re-seeds its ticks from the new decision instead of keeping the old empty ones', () => {
    const before: BankLine = {
      ...SPLIT, id: 12, line_no: 12, amount_sen: 813169, charge_sen: 0, kind: 'PAYOUT_UNSURE', matched_batch_id: null, split: null,
      note: 'PBB paid RM 8,131.69, and no single report of theirs is owed that. 6 are still waiting — choose, or record it against more than one.',
      candidates: [
        { id: 21, acquirerCode: 'PBB', fileName: '2990HOMESB_CSV_20260703.csv', periodFrom: '2026-07-03', periodTo: '2026-07-03', payableSen: 166869, outstandingSen: 166869 },
        { id: 22, acquirerCode: 'PBB', fileName: '2990HOMESB_CSV_20260704.csv', periodFrom: '2026-07-04', periodTo: '2026-07-04', payableSen: 312660, outstandingSen: 312660 },
        { id: 23, acquirerCode: 'PBB', fileName: '2990HOMESB_CSV_20260705.csv', periodFrom: '2026-07-05', periodTo: '2026-07-05', payableSen: 333640, outstandingSen: 333640 },
        { id: 26, acquirerCode: 'PBB', fileName: '2990HOMESB_CSV_20260712.csv', periodFrom: '2026-07-12', periodTo: '2026-07-12', payableSen: 720324, outstandingSen: 720324 },
      ],
    };
    lines = [before];
    const r = render(<BankStatementTab />);
    fireEvent.click(screen.getByText('Reconcile'));
    /* Undecided: every report offered, nothing ticked, the button dead. */
    expect(screen.getAllByRole('checkbox', { name: /Report .* for line 12/ })).toHaveLength(4);
    expect((screen.getByText('Money received').closest('button') as HTMLButtonElement).disabled).toBe(true);

    /* The next read: three reports now add up to it exactly. */
    lines = [{
      ...before, kind: 'PAYOUT_SPLIT',
      split: [{ batchId: 21, amountSen: 166869 }, { batchId: 22, amountSen: 312660 }, { batchId: 23, amountSen: 333640 }],
      note: '3 of PBB\'s reports add up to RM 8,131.69 exactly — 2990HOMESB_CSV_20260703.csv RM 1,668.69 + 2990HOMESB_CSV_20260704.csv RM 3,126.60 + 2990HOMESB_CSV_20260705.csv RM 3,336.40. Check them and record it.',
    }];
    r.rerender(<BankStatementTab />);
    const ticked = screen.getAllByRole('checkbox', { name: /Report .* for line 12/ }) as HTMLInputElement[];
    expect(ticked.map((c) => [c.getAttribute('aria-label'), c.checked])).toEqual([
      ['Report 2990HOMESB_CSV_20260703.csv for line 12', true],
      ['Report 2990HOMESB_CSV_20260704.csv for line 12', true],
      ['Report 2990HOMESB_CSV_20260705.csv for line 12', true],
    ]);
    expect(screen.getByText('Not this one? 1 other report(s)')).toBeTruthy();
    const go = screen.getByText('Money received — 3 reports').closest('button') as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    expect(bookMutate).toHaveBeenLastCalledWith({
      lineId: 12,
      allocations: [{ batchId: 21, amountSen: 166869 }, { batchId: 22, amountSen: 312660 }, { batchId: 23, amountSen: 333640 }],
    });
  });
});
