/* Payments not matched yet — three lists under one date range (owner 2026-09-30:
   我有没有一个表是显示全部还没 match 的; 2026-11-10: 关于那个unmatch payment 我要优化 …
   → 做). Pinned:
     • three lists, each a tile with its count and money: the merchant report
       lines nobody reconciled, the payments not matched, the bank's money with
       no entry; the address says which is open;
     • every row says where it is stuck and links the screen that unsticks it —
       a card the merchant matched but the bank has not paid names its report;
     • each list's chips carry their counts and narrow the list and its sentence;
     • Export all writes EVERY row of the three, whatever chip is on, a sheet or
       a part each, with the columns each table shows; one list's PDF prints it;
     • the lists ask for the last 180 days by default. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SettlementBatch, SettlementRow } from './settlement-queries';
import type { UnmatchedBankLine, UnmatchedPayment } from './unmatched-payments-queries';

const row = (over: Partial<UnmatchedPayment>): UnmatchedPayment => ({
  source: 'SOPAY', paymentId: 'p1', docNo: '2990-SO-2609-045', customerName: 'YEAP KAR CHUN', salespersonName: 'Nico', collectedByName: 'Esther',
  paidOn: '2026-09-02', kind: 'card', channel: 'PBB', amountSen: 324_000, reference: 'R18656', ageDays: 28,
  state: 'CARD_TO_CONFIRM', bankAccountCode: null, statementUpTo: null, ...over,
});
const ROWS: UnmatchedPayment[] = [
  row({}),
  row({ paymentId: 'p2', docNo: '2990-SO-2609-031', customerName: 'Chong Hui Wen', kind: 'transfer', channel: 'Bank Transfer', amountSen: 143_300, reference: '260920CE0DB5C26', ageDays: 10, state: 'TRANSFER_NOT_MATCHED', bankAccountCode: '310-0020', statementUpTo: '2026-09-28' }),
  row({ paymentId: 'p3', docNo: '2990-SO-2608-069', customerName: 'Poon How kei', kind: 'transfer', channel: 'TNG', amountSen: 150_000, reference: '602788', ageDays: 1, state: 'TRANSFER_NO_STATEMENT', bankAccountCode: '310-0020', statementUpTo: '2026-09-28' }),
  row({ paymentId: 'p4', docNo: '2990-SO-2609-050', channel: null, amountSen: 50_000, ageDays: 3, state: 'CARD_NOT_REPORTED', collectedByName: null }),
  /* Owner 2026-11-10: the merchant matched them; the bank has not. */
  row({ paymentId: 'p5', docNo: '2990-SO-2610-011', channel: 'MBB', amountSen: 100_000, ageDays: 20, state: 'CARD_NOT_IN_BANK',
    report: { batchId: 31, fileName: 'mbb-1001.csv', acquirerCode: 'MBB', waitingLines: 2, bankShare: 0 } }),
  row({ paymentId: 'p6', docNo: '2990-SO-2610-012', channel: 'MBB', amountSen: 200_000, ageDays: 18, state: 'CARD_NOT_IN_BANK',
    report: { batchId: 32, fileName: 'mbb-1002.csv', acquirerCode: 'MBB', waitingLines: 0, bankShare: 0 } }),
];

/* Merchant Recon's own reports: two open lines in the window, one decided, one outside it. */
const BATCHES = [
  { id: 7, acquirer_code: 'MBB', file_name: '027032649949_DVS04A_1_20261101.CSV', period_from: '2026-11-01', period_to: '2026-11-01', open_count: 2 },
  { id: 8, acquirer_code: 'GHL', file_name: 'ghl-done.csv', period_from: '2026-10-01', period_to: '2026-10-01', open_count: 0 },
] as unknown as SettlementBatch[];
const line = (over: Partial<SettlementRow>): SettlementRow => ({
  id: 1, line_no: 19, txn_date: '2026-11-01', ref: '075427', gross_sen: 164_000, fee_sen: 1_640, net_sen: 162_360,
  bucket: 'NEEDS_CONFIRM', match_reason: 'amount+date', confirmed_at: null, posted_je_no: null, notes: null,
  linked: [], candidates: [], comboHints: [], clue: null, ...over,
});
const GUESS = { source: 'SOPAY' as const, id: 'g1', docNo: '2990-SO-2611-021', paidOn: '2026-11-04', amountSen: 164_000, approvalCode: '080405', customerName: 'Alice Ong' };
const DETAIL_ROWS: SettlementRow[] = [
  line({ suggested: [GUESS], candidates: [GUESS] }),
  line({ id: 2, line_no: 20, ref: '999001', gross_sen: 50_000, bucket: 'UNMATCHED' }),
  line({ id: 3, line_no: 21, confirmed_at: '2026-11-02T00:00:00Z' }),
];

const BANK: UnmatchedBankLine[] = [
  { lineId: 101, statementId: 1, accountCode: '310-0020', bankName: 'Hong Leong', bookedOn: '2026-10-05', month: '2026-10', description: 'IBG FROM UNKNOWN',
    reference: null, amountSen: 77_700, what: 'TRANSFER', kind: 'OTHER', acquirerCode: null, entryCount: 0, entries: [], ageDays: 36,
    note: 'No entry of this amount in the books within 7 days of it — record the receipt first.' },
  { lineId: 102, statementId: 1, accountCode: '310-0020', bankName: 'Hong Leong', bookedOn: '2026-10-07', month: '2026-10', description: 'MBB MERCHANT SETTLEMENT',
    reference: null, amountSen: 100_000, what: 'CARD', kind: 'PAYOUT_NO_BATCH', acquirerCode: 'MBB', entryCount: 0, entries: [], ageDays: 34,
    note: 'MBB paid RM 1,000.00, and no reconciled report of theirs is waiting for money. Reconcile the merchant report first.' },
];

const asked: Array<[string, string]> = [];
vi.mock('./unmatched-payments-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./unmatched-payments-queries')>()),
  useUnmatchedPayments: (from: string, to: string) => {
    asked.push([from, to]);
    return { data: { from, to, rows: ROWS }, isLoading: false, isError: false };
  },
  useUnmatchedBankLines: (from: string, to: string) => ({ data: { from, to, rows: BANK }, isLoading: false, isError: false }),
}));
const detailsAsked: number[][] = [];
vi.mock('./settlement-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./settlement-queries')>()),
  useSettlementBatches: () => ({ data: { batches: BATCHES }, isLoading: false, isError: false }),
  useSettlementBatchDetails: (ids: number[]) => {
    detailsAsked.push(ids);
    return { details: ids.map(() => ({ rows: DETAIL_ROWS })), loading: false, failed: false };
  },
}));

const writeBook = vi.fn();
vi.mock('../../components/dataTableLineExport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/dataTableLineExport')>()),
  writeLineExportBook: (...args: unknown[]) => writeBook(...args),
}));
const printPdf = vi.fn();
vi.mock('../../vendor/scm/lib/unmatched-payments-pdf', () => ({ generateUnmatchedPdf: (...args: unknown[]) => printPdf(...args) }));

import { UnmatchedPayments } from './UnmatchedPayments';

const draw = (at = '/scm/unmatched-payments') => render(<MemoryRouter initialEntries={[at]}><UnmatchedPayments /></MemoryRouter>);
const rowOf = (text: string): HTMLElement => screen.getByText(text).closest('tr') as HTMLElement;
const tab = (name: RegExp) => screen.getByRole('tab', { name });

/* The window is today's: pin today, so the lines below stay inside it. */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T04:00:00Z'));
  writeBook.mockClear();
  printPdf.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

describe('three lists on one page', () => {
  test('each list is a tile with its count and money; Payments opens first, the address picks another', () => {
    draw();
    expect(tab(/^Merchant report lines\s*2/).getAttribute('aria-selected')).toBe('false');
    expect(tab(/^Payments\s*6/).getAttribute('aria-selected')).toBe('true');
    expect(tab(/^Bank money in\s*2/).textContent).toContain('RM 1,777.00');
    fireEvent.click(tab(/^Bank money in/));
    expect(tab(/^Bank money in/).getAttribute('aria-selected')).toBe('true');
  });

  test('only open reports overlapping the dates are read, as Merchant Recon reads them', () => {
    detailsAsked.length = 0;
    draw('/scm/unmatched-payments?list=reports');
    expect(detailsAsked.at(-1)).toEqual([7]);
  });

  test('asks for the last 180 days by default', () => {
    asked.length = 0;
    draw();
    const [from, to] = asked[0]!;
    expect((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000).toBe(180);
  });
});

describe('Payments', () => {
  test('each row says where it is stuck and links the screen that unsticks it', () => {
    draw();
    const card = within(rowOf('2990-SO-2609-045'));
    expect(card.getByText('Card · PBB')).toBeTruthy();
    expect(card.getByText('On a merchant report — waiting for you to confirm')).toBeTruthy();
    expect(card.getByText('Merchant reports').getAttribute('href')).toBe('/scm/merchant-recon');
    expect(card.getByText('2990-SO-2609-045').getAttribute('href')).toBe('/scm/sales-orders/2990-SO-2609-045');

    const transfer = within(rowOf('2990-SO-2609-031'));
    expect(transfer.getByText('Transfer · Bank Transfer')).toBeTruthy();
    expect(transfer.getByText('Not matched to the bank statement yet')).toBeTruthy();
    expect(transfer.getByText('Bank statements').getAttribute('href')).toBe('/scm/bank-recon');

    const late = within(rowOf('2990-SO-2608-069'));
    expect(late.getByText(/^Bank statement for this day not uploaded yet \(uploaded to /)).toBeTruthy();

    /* Keyed in without a bank: 未标, as Merchant Recon names it. */
    const untagged = within(rowOf('2990-SO-2609-050'));
    expect(untagged.getByText('Card · 未标')).toBeTruthy();
    expect(untagged.getByText('Not on a merchant report yet')).toBeTruthy();
  });

  /* Owner 2026-11-10: 如果merchant 对的上但bank 还有没有对的上要分开 … 因为可以是另外一笔卡着. */
  test('a card the merchant matched but the bank has not paid says which report holds it', () => {
    draw();
    const held = within(rowOf('2990-SO-2610-011'));
    expect(held.getByText('Merchant matched — mbb-1001.csv still has 2 lines to reconcile, so the bank cannot be matched yet')).toBeTruthy();
    expect(held.getByText('Merchant reports').getAttribute('href')).toBe('/scm/merchant-recon?acq=MBB&batch=31');
    const credit = within(rowOf('2990-SO-2610-012'));
    expect(credit.getByText('Merchant matched — the bank credit for mbb-1002.csv is not matched yet')).toBeTruthy();
    expect(credit.getByText('Bank statements').getAttribute('href')).toBe('/scm/bank-recon');
  });

  test('the stages carry their counts, and the list and its sentence follow the choice', () => {
    draw();
    expect(screen.getByRole('button', { name: 'All (6)' })).toBeTruthy();
    expect(screen.getByText(/^6 payments not matched, .*9,673\.00 in total\. Card 4 \(.*6,740\.00\) · Transfer 2 \(.*2,933\.00\)\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Card · merchant matched, bank not yet (2)' }));
    expect(screen.queryByText('2990-SO-2609-045')).toBeNull();
    expect(screen.getByText('2990-SO-2610-011')).toBeTruthy();
    expect(screen.getByText(/^2 payments not matched, .*3,000\.00 in total\.$/)).toBeTruthy();
    /* A stage with nothing in it is not offered. */
    expect(screen.queryByRole('button', { name: /Transfer · not in the books/ })).toBeNull();
  });

  /* Owner 2026-11-09: sales person 应该不太对，应该是collected by 的人. */
  test('names who collected the payment; the order\'s salesperson waits under Columns', () => {
    draw();
    const card = within(rowOf('2990-SO-2609-045'));
    expect(card.getByText('Esther')).toBeTruthy();
    expect(card.queryByText('Nico')).toBeNull();
    const nobody = within(rowOf('2990-SO-2609-050'));
    expect(nobody.getAllByText('—').length).toBeGreaterThan(0);
    expect(nobody.queryByText('Nico')).toBeNull();
  });
});

describe('Merchant report lines', () => {
  test('the open lines, as Merchant Recon words them, each opening its report on its tab', () => {
    draw('/scm/unmatched-payments?list=reports');
    const guess = within(rowOf('075427'));
    expect(guess.getByText('2990-SO-2611-021')).toBeTruthy();
    expect(guess.getByText('Alice Ong')).toBeTruthy();
    expect(guess.getByText('the system’s guess — check it')).toBeTruthy();
    expect(guess.getByText('Merchant reports').getAttribute('href'))
      .toBe('/scm/merchant-recon?acq=MBB&batch=7&tab=to-choose');
    const none = within(rowOf('999001'));
    expect(none.getByText('no sale in the ERP')).toBeTruthy();
    expect(none.getByText('Merchant reports').getAttribute('href')).toBe('/scm/merchant-recon?acq=MBB&batch=7&tab=no-sale');
    /* The confirmed line is done: not listed. */
    expect(screen.getByText(/^2 lines not reconciled/)).toBeTruthy();
  });

  test('"No sale in the ERP" narrows to the card money nobody keyed', () => {
    draw('/scm/unmatched-payments?list=reports');
    fireEvent.click(screen.getByRole('button', { name: 'No sale in the ERP (1)' }));
    expect(screen.queryByText('075427')).toBeNull();
    expect(screen.getByText('999001')).toBeTruthy();
  });
});

describe('Bank money in', () => {
  test('what each line is, why it is open, and the month it opens in', () => {
    draw('/scm/unmatched-payments?list=bank');
    const transfer = within(rowOf('IBG FROM UNKNOWN'));
    expect(transfer.getByText('Transfer')).toBeTruthy();
    expect(transfer.getByText(/^No entry of this amount in the books/)).toBeTruthy();
    expect(transfer.getByText('Bank statements').getAttribute('href')).toBe('/scm/bank-recon?account=310-0020&month=2026-10');
    const payout = within(rowOf('MBB MERCHANT SETTLEMENT'));
    expect(payout.getByText('Card payout · MBB')).toBeTruthy();
    expect(payout.getByText(/Reconcile the merchant report first/)).toBeTruthy();
  });
});

/* Owner 2026-11-10: 要支持可以export 全部 / 也要支持pdf，这个export可以根据我显示的column 来export. */
describe('Export', () => {
  test('Export all writes every row of the three lists, a sheet each, whatever chip is on', async () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Card · merchant matched, bank not yet (2)' }));
    fireEvent.click(screen.getByRole('button', { name: /Export all · Excel/ }));
    await waitFor(() => expect(writeBook).toHaveBeenCalledTimes(1));
    const [sheets, fileName] = writeBook.mock.calls[0]! as [Array<{ name: string; matrix: { header: string[]; body: unknown[][] } }>, string];
    expect(sheets.map((s) => [s.name, s.matrix.body.length])).toEqual([['Merchant report lines', 2], ['Payments', 6], ['Bank money in', 2]]);
    expect(fileName).toMatch(/^payments-not-matched-all-\d{4}-\d{2}-\d{2}\.xlsx$/);
    /* The columns each table shows: Collected by, not the hidden Salesperson. */
    const payments = sheets[1]!.matrix.header;
    expect(payments).toContain('Collected by');
    expect(payments).not.toContain('Salesperson');
    expect(payments).toContain('Where it is stuck');
  });

  test('a column the reader hid stays out of Export all — on a list not even open', async () => {
    /* The Bank list is not the one open; its table still says what it shows. */
    localStorage.setItem('dt:hidden:unmatched-bank-lines', JSON.stringify(['description']));
    localStorage.setItem('dt:shown:unmatched-payments', JSON.stringify(['salesperson']));
    try {
      draw();
      fireEvent.click(screen.getByRole('button', { name: /Export all · Excel/ }));
      await waitFor(() => expect(writeBook).toHaveBeenCalledTimes(1));
      const [sheets] = writeBook.mock.calls[0]! as [Array<{ name: string; matrix: { header: string[] } }>];
      expect(sheets[2]!.matrix.header).not.toContain('Description');
      expect(sheets[2]!.matrix.header).toContain('Why it is open');
      expect(sheets[1]!.matrix.header).toContain('Salesperson');
    } finally {
      localStorage.removeItem('dt:hidden:unmatched-bank-lines');
      localStorage.removeItem('dt:shown:unmatched-payments');
    }
  });

  test('Export all as a PDF prints the three lists, a part each', async () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: /Export all · PDF/ }));
    await waitFor(() => expect(printPdf).toHaveBeenCalledTimes(1));
    const [parts, opts] = printPdf.mock.calls[0]! as [Array<{ title: string; view: { matrix: { body: unknown[][] } } }>, { subtitle: string }];
    expect(parts.map((p) => [p.title, p.view.matrix.body.length])).toEqual([['Merchant report lines', 2], ['Payments', 6], ['Bank money in', 2]]);
    expect(opts.subtitle).toMatch(/^Dated .* to .* · every row of the three lists$/);
  });

  test('one list\'s PDF prints what that list shows, and says which chip', async () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Card · merchant matched, bank not yet (2)' }));
    const payments = screen.getAllByRole('button', { name: /^PDF$/ });
    fireEvent.click(payments[0]!);
    await waitFor(() => expect(printPdf).toHaveBeenCalledTimes(1));
    const [parts, opts] = printPdf.mock.calls[0]! as [Array<{ title: string; view: { matrix: { body: unknown[][] } } }>, { subtitle: string }];
    expect(parts.map((p) => [p.title, p.view.matrix.body.length])).toEqual([['Payments', 2]]);
    expect(opts.subtitle).toMatch(/ · Card · merchant matched, bank not yet$/);
  });
});
