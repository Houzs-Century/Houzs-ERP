/* Payments not matched yet — three lists under one date range (owner 2026-09-30:
   我有没有一个表是显示全部还没 match 的; 2026-11-10: 关于那个unmatch payment 我要优化 …
   → 做). Pinned:
     • three lists, each a tile with its count and money: the merchant report
       lines nobody reconciled, the payments not matched, the bank's money with
       no entry; the address says which is open;
     • every row says where it is stuck and links the screen that unsticks it; a
       card the merchant matched is matched, not listed (owner 2026-11-10: 已经match
       了就不要出现), and a payment names the same money waiting on another list —
       the report line that guesses it (a QR line for a QR sale keyed as a transfer,
       2026-11-11), the bank line offered its entry (会不会duplicate);
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
  row({ paymentId: 'p2', docNo: '2990-SO-2609-031', customerName: 'Chong Hui Wen', kind: 'transfer', channel: 'Bank Transfer', amountSen: 143_300, reference: '260920CE0DB5C26', ageDays: 10, state: 'TRANSFER_NOT_MATCHED', bankAccountCode: '310-0020', statementUpTo: '2026-09-28', jeNo: 'JE-2609-0031' }),
  row({ paymentId: 'p3', docNo: '2990-SO-2608-069', customerName: 'Poon How kei', kind: 'transfer', channel: 'TNG', amountSen: 150_000, reference: '602788', ageDays: 1, state: 'TRANSFER_NO_STATEMENT', bankAccountCode: '310-0020', statementUpTo: '2026-09-28', jeNo: 'JE-2609-0099' }),
  row({ paymentId: 'p4', docNo: '2990-SO-2609-050', channel: null, amountSen: 50_000, ageDays: 3, state: 'CARD_NOT_REPORTED', collectedByName: null }),
  /* The sale MBB's 01/11 report line 19 guesses (GUESS below): the same money, from the books' side. */
  row({ paymentId: 'g1', docNo: '2990-SO-2611-021', customerName: 'Alice Ong', channel: 'MBB', amountSen: 164_000, reference: '080405',
    paidOn: '2026-11-04', ageDays: 6, state: 'CARD_NOT_REPORTED' }),
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
  { lineId: 103, statementId: 1, accountCode: '310-0020', bankName: 'Hong Leong', bookedOn: '2026-09-21', month: '2026-09', description: 'IBG CHONG HUI WEN',
    reference: null, amountSen: 143_300, what: 'TRANSFER', kind: 'OTHER', acquirerCode: null, entryCount: 1, ageDays: 50,
    entries: [{ jeNo: 'JE-2609-0031', entryDate: '2026-09-20', doc: '2990-SO-2609-031', who: 'Chong Hui Wen', daysApart: 1 }],
    note: 'One entry of this amount: 2990-SO-2609-031 · Chong Hui Wen, 20/09/2026 — match it on Bank statements.' },
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
const writeFile = vi.fn();
vi.mock('../../components/dataTableLineExport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/dataTableLineExport')>()),
  writeLineExportBook: (...args: unknown[]) => writeBook(...args),
  writeLineExportFile: (...args: unknown[]) => writeFile(...args),
}));
const printPdf = vi.fn();
vi.mock('../../vendor/scm/lib/unmatched-payments-pdf', () => ({ generateUnmatchedPdf: (...args: unknown[]) => printPdf(...args) }));

import { UnmatchedPayments } from './UnmatchedPayments';
import { reportLinesOf, withSameMoney } from './unmatchedLists';
import { primeInVisitColFilters, resetInVisitColFilters } from '../../components/dataTableColFilterMemory';

const draw = (at = '/scm/unmatched-payments') => render(<MemoryRouter initialEntries={[at]}><UnmatchedPayments /></MemoryRouter>);
/* The row on the list that is open: the other two stay mounted, hidden, and may name the same document. */
const rowOf = (text: string): HTMLElement => screen.getAllByText(text).find((el) => el.closest('[hidden]') == null)!.closest('tr') as HTMLElement;
const tab = (name: RegExp) => screen.getByRole('tab', { name });

/* The window is today's: pin today, so the lines below stay inside it. */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T04:00:00Z'));
  writeBook.mockClear();
  writeFile.mockClear();
  printPdf.mockClear();
});
afterEach(() => { vi.useRealTimers(); resetInVisitColFilters(); });

describe('three lists on one page', () => {
  test('each list is a tile with its count and money; Payments opens first, the address picks another', () => {
    draw();
    expect(tab(/^Merchant report lines\s*2/).getAttribute('aria-selected')).toBe('false');
    expect(tab(/^Payments\s*5/).getAttribute('aria-selected')).toBe('true');
    expect(tab(/^Bank money in\s*3/).textContent).toContain('RM 3,210.00');
    fireEvent.click(tab(/^Bank money in/));
    expect(tab(/^Bank money in/).getAttribute('aria-selected')).toBe('true');
    /* Owner 2026-11-11: Merchant Report Line -> Bank Money In -> Payment. */
    expect(screen.getAllByRole('tab').map((t) => /^(Merchant report lines|Bank money in|Payments)/.exec(t.textContent)?.[1]))
      .toEqual(['Merchant report lines', 'Bank money in', 'Payments']);
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

  /* Owner 2026-11-10: 已经match 了就不要出现 / 会不会duplicate. */
  test('a payment names the same money waiting on another list, and opens it', () => {
    draw();
    const guessed = within(rowOf('2990-SO-2611-021'));
    const report = guessed.getByText('Merchant report line · MBB · 2026/11/01 · line 19');
    expect(report.getAttribute('href')).toBe('/scm/merchant-recon?acq=MBB&batch=7&tab=to-choose');
    const transfer = within(rowOf('2990-SO-2609-031'));
    const bankLine = transfer.getByText('Bank money in · 2026/09/21 · RM 1,433.00');
    expect(bankLine.getAttribute('href')).toBe('/scm/bank-recon?account=310-0020&month=2026-09');
    /* Nothing on another list: nothing named. */
    expect(within(rowOf('2990-SO-2608-069')).queryByText(/^(Merchant report line|Bank money in) · /)).toBeNull();
  });

  /* Owner 2026-11-11 (QR 的单 merchant 对上了，也像卡一样): a DuitNow QR sale is keyed as a
     transfer. Once its QR line is confirmed the server leaves it off; a QR line only guessing
     it is the same money, named the way a card's line is — before any bank line. */
  test('a QR sale a QR line guesses names that line, as a card does', () => {
    const sale = { source: 'SOPAY' as const, id: 'q1', docNo: '2990-SO-2611-090', paidOn: '2026-10-31', amountSen: 200_000, approvalCode: '0000PP', customerName: 'QR Customer' };
    const qrReport = { id: 384, acquirer_code: 'HLB', file_name: 'hlb-qr-1031.csv', period_from: '2026-10-31', period_to: '2026-10-31', open_count: 2 } as unknown as SettlementBatch;
    const qrLine = line({ id: 9, line_no: 18, txn_date: '2026-10-31', ref: '0000PP', gross_sen: 200_000, fee_sen: 0, net_sen: 200_000, channel: 'QR', suggested: [sale], candidates: [sale] });
    const reports = reportLinesOf([qrReport], [{ rows: [qrLine] }], '2026-05-14', '2026-11-10', '2026-11-10');
    const credit = { ...BANK[2]!, entries: [{ jeNo: 'JE-2610-0448', entryDate: '2026-10-31', doc: '2990-SO-2611-090', who: 'QR Customer', daysApart: 2 }] };
    const [named] = withSameMoney([row({ paymentId: 'q1', docNo: '2990-SO-2611-090', kind: 'transfer', channel: 'Bank Transfer', amountSen: 200_000,
      state: 'TRANSFER_NOT_MATCHED', bankAccountCode: '310-0020', statementUpTo: '2026-11-30', jeNo: 'JE-2610-0448' })], reports, [credit]);
    expect(named!.same).toEqual({ text: 'Merchant report line · HLB · 2026/10/31 · line 18', to: '/scm/merchant-recon?acq=HLB&batch=384&tab=to-choose' });
  });

  test('there is no stage for a card the merchant matched — it is matched', () => {
    draw();
    expect(screen.queryByRole('button', { name: /merchant matched/ })).toBeNull();
    expect(screen.queryByText(/^Merchant matched — /)).toBeNull();
  });

  test('the stages carry their counts, and the list and its sentence follow the choice', () => {
    draw();
    expect(screen.getByRole('button', { name: 'All (5)' })).toBeTruthy();
    expect(screen.getByText(/^5 payments not matched, .*8,313\.00 in total\. Card 3 \(.*5,380\.00\) · Transfer 2 \(.*2,933\.00\)\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Card · not on a report (2)' }));
    expect(screen.queryByText('2990-SO-2609-045')).toBeNull();
    expect(rowOf('2990-SO-2611-021')).toBeTruthy();
    expect(screen.getByText(/^2 payments not matched, .*2,140\.00 in total\.$/)).toBeTruthy();
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

/* Owner 2026-11-10: 要支持可以export 全部 / 也要支持pdf，这个export可以根据我显示的column 来export.
   Owner 2026-11-11: 我filter 了三个card 的东西，但是export 了还是全部 / export 出来时注明是 … /
   顺序 Merchant Report Line -> Bank Money In -> Payment. */
describe('Export', () => {
  const REPORT_TITLE = 'Merchant RECEIVED, CANNOT MATCHED Which Sales Order';
  const BANK_TITLE = 'Bank Received, CANNOT MATCHED Which Sales Order';
  const PAY_TITLE = 'Record Payment Received, Bank CANNOT Found';
  type Sheet = { name: string; heading: string[]; matrix: { header: string[]; body: unknown[][] } };
  type Part = { title: string; label: string; note: string; view: { matrix: { body: unknown[][] } } };

  test('Export all writes the three lists in the owner\'s order, each under its title — every row when nothing narrows them', async () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: /Export all · Excel/ }));
    await waitFor(() => expect(writeBook).toHaveBeenCalledTimes(1));
    const [sheets, fileName] = writeBook.mock.calls[0]! as [Sheet[], string];
    expect(sheets.map((s) => [s.name, s.heading[0], s.matrix.body.length])).toEqual([
      ['Merchant received', REPORT_TITLE, 2],
      ['Bank received', BANK_TITLE, 3],
      ['Payment recorded', PAY_TITLE, 5],
    ]);
    for (const s of sheets) expect(s.heading[1]).toMatch(/^Dated .* to .* · No filter — every row$/);
    expect(fileName).toMatch(/^payments-not-matched-\d{4}-\d{2}-\d{2}\.xlsx$/);
    /* The columns each table shows: Collected by, not the hidden Salesperson. */
    const payments = sheets[2]!.matrix.header;
    expect(payments).toContain('Collected by');
    expect(payments).not.toContain('Salesperson');
    expect(payments).toContain('Where it is stuck');
    expect(payments).toContain('Possibly the same as');
  });

  test('Export all follows each list\'s chip and column filters, and says them above the list', async () => {
    primeInVisitColFilters('unmatched-payments', { collectedBy: ['Esther'] });
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Card · not on a report (2)' }));
    fireEvent.click(tab(/^Bank money in/));
    fireEvent.click(screen.getByRole('button', { name: 'Card payout (1)' }));
    fireEvent.click(screen.getByRole('button', { name: /Export all · Excel/ }));
    await waitFor(() => expect(writeBook).toHaveBeenCalledTimes(1));
    const [sheets] = writeBook.mock.calls[0]! as [Sheet[]];
    expect(sheets.map((s) => [s.name, s.matrix.body.length])).toEqual([['Merchant received', 2], ['Bank received', 1], ['Payment recorded', 1]]);
    expect(sheets.map((s) => s.heading[1]!.replace(/^Dated .* to \S+ · /, ''))).toEqual([
      'No filter — every row',
      'Filter: Card payout',
      'Filter: Card · not on a report · Collected by: Esther',
    ]);
    /* The same, on paper. */
    fireEvent.click(screen.getByRole('button', { name: /Export all · PDF/ }));
    await waitFor(() => expect(printPdf).toHaveBeenCalledTimes(1));
    const [parts] = printPdf.mock.calls[0]! as [Part[]];
    expect(parts.map((p) => [p.title, p.view.matrix.body.length, p.note])).toEqual([
      [REPORT_TITLE, 2, 'No filter — every row'],
      [BANK_TITLE, 1, 'Filter: Card payout'],
      [PAY_TITLE, 1, 'Filter: Card · not on a report · Collected by: Esther'],
    ]);
  });

  test('a list\'s own Excel writes what it shows, under its title, in a file of its name', async () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Card · not on a report (2)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
    const [matrix, sheetName, fileName, heading] = writeFile.mock.calls[0]! as [{ body: unknown[][] }, string, string, string[]];
    expect(matrix.body).toHaveLength(2);
    expect(sheetName).toBe('Payment recorded');
    expect(fileName).toMatch(/^payment-recorded-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(heading[0]).toBe(PAY_TITLE);
    expect(heading[1]).toMatch(/^Dated .* · Filter: Card · not on a report$/);
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
      expect(sheets[1]!.matrix.header).not.toContain('Description');
      expect(sheets[1]!.matrix.header).toContain('Why it is open');
      expect(sheets[2]!.matrix.header).toContain('Salesperson');
    } finally {
      localStorage.removeItem('dt:hidden:unmatched-bank-lines');
      localStorage.removeItem('dt:shown:unmatched-payments');
    }
  });

  test('Export all as a PDF prints the three lists in the owner\'s order, a part each under its title', async () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: /Export all · PDF/ }));
    await waitFor(() => expect(printPdf).toHaveBeenCalledTimes(1));
    const [parts, opts] = printPdf.mock.calls[0]! as [Part[], { subtitle: string }];
    expect(parts.map((p) => [p.title, p.label, p.view.matrix.body.length, p.note])).toEqual([
      [REPORT_TITLE, 'Merchant received', 2, 'No filter — every row'],
      [BANK_TITLE, 'Bank received', 3, 'No filter — every row'],
      [PAY_TITLE, 'Payment recorded', 5, 'No filter — every row'],
    ]);
    expect(opts.subtitle).toMatch(/^Dated \S+ to \S+$/);
  });

  test('one list\'s PDF prints what that list shows, under its title, and says which chip', async () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Card · not on a report (2)' }));
    const payments = screen.getAllByRole('button', { name: /^PDF$/ });
    fireEvent.click(payments[0]!);
    await waitFor(() => expect(printPdf).toHaveBeenCalledTimes(1));
    const [parts, opts] = printPdf.mock.calls[0]! as [Part[], { subtitle: string }];
    expect(parts.map((p) => [p.title, p.view.matrix.body.length, p.note])).toEqual([[PAY_TITLE, 2, 'Filter: Card · not on a report']]);
    expect(opts.subtitle).toMatch(/^Dated \S+ to \S+$/);
  });
});
