// The settlement screen's render contract. The rules themselves are pinned on
// the server (backend/src/acc/settlement-*.test.ts and tests/settlementRoutes);
// what is proved here is that the screen SAYS them:
//   • an acquirer with no unique reference is called out before an upload;
//   • a statement the server refused shows the server's sentence, verbatim;
//   • the four piles carry their counts and a line shows its clue;
//   • a selection that does not add up cannot be confirmed;
//   • the money side is NOT here — it is BankRecon.test.tsx, and the setup is
//     SettlementSetup.test.tsx: three jobs, three screens, as the owner asked.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { AcquirerSetup, SettlementRow } from './settlement-queries';

const MBB: AcquirerSetup = {
  code: 'MBB', display_name: 'MBB', statement_format: 'CSV', has_unique_ref: true,
  fee_method: 'stated', date_tolerance_days: 3, column_map: { date: 'Txn Date', gross: 'Gross' },
  transit_account_code: '326-0000', fee_account_code: '930-0000', bank_account_code: '310-0010',
  is_active: true, ready: true, autoMatchable: true,
};
const GHL: AcquirerSetup = { ...MBB, code: 'GHL', display_name: 'GHL', has_unique_ref: false, autoMatchable: false, dates_have_no_year: true, bank_account_code: null, bankReady: false };

const ROW: SettlementRow = {
  id: 7, line_no: 2, txn_date: '2026-08-03', ref: 'ZZ9',
  gross_sen: 100000, fee_sen: 1500, net_sen: 98500,
  bucket: 'NEEDS_CONFIRM', match_reason: 'amount+date', confirmed_at: null,
  posted_je_no: null, notes: null, linked: [],
  candidates: [
    /* p1 is a migration-era payment: no merchant tag. p2 was tagged at the till. */
    { source: 'SOPAY', id: 'p1', docNo: 'SO-2608-001', paidOn: '2026-08-01', amountSen: 60000, approvalCode: 'A1', merchantProvider: null },
    { source: 'SOPAY', id: 'p2', docNo: 'SO-2608-002', paidOn: '2026-08-02', amountSen: 40000, approvalCode: null, merchantProvider: 'MBB' },
  ],
  comboHints: [['p1', 'p2']],
  clue: 'No single payment matches; 1 pair(s) of payments add up to this amount',
};

/* A line already dealt with: off the screen unless he asks for it. */
const DONE_ROW: SettlementRow = {
  ...ROW, id: 8, line_no: 1, ref: 'A1', bucket: 'MATCHED', match_reason: 'ref',
  confirmed_at: '2026-08-17T02:00:00Z', posted_je_no: 'JE-2608-0011',
  candidates: [], comboHints: [], clue: null,
};

/* The state the owner was looking at: matched by its reference, not yet
   confirmed. One button away, and the screen must say so once. */
const MATCHED_ROW: SettlementRow = {
  ...ROW, id: 9, line_no: 3, ref: '969745', bucket: 'MATCHED', match_reason: 'ref',
  confirmed_at: null, posted_je_no: null,
  linked: [{ settlement_row_id: 9, payment_source: 'SOPAY', payment_id: 'm4', doc_no: 'SO-2608-043', amount_sen: 258800 }],
  candidates: [], comboHints: [], clue: 'Reference 969745 matches SO-2608-043',
};

/* A line whose approval code matched nothing, with exactly one payment of its
   amount in range — the system offers that one, pre-ticked. */
const SUGGESTED_ROW: SettlementRow = {
  ...ROW, id: 10, line_no: 4, ref: 'TYPO9', bucket: 'NEEDS_CONFIRM', match_reason: 'amount+date',
  gross_sen: 60000, fee_sen: 900, net_sen: 59100, linked: [], comboHints: [],
  candidates: [{ source: 'SOPAY', id: 'b3', docNo: 'SO-2608-050', paidOn: '2026-08-03', amountSen: 60000, approvalCode: '114220' }],
  suggested: [{ source: 'SOPAY', id: 'b3', docNo: 'SO-2608-050', paidOn: '2026-08-03', amountSen: 60000, approvalCode: '114220' }],
  clue: 'Reference TYPO9 matched nothing — SO-2608-050 is the only payment of this amount within 3 day(s). Check it and confirm.',
};

const confirmMutate = vi.fn();
const confirmGroupMutate = vi.fn();
const unconfirmMutate = vi.fn();
const releaseMutate = vi.fn();
const confirmMatchedMutate = vi.fn();
const confirmMatchedBatch = vi.fn();
const refreshAfterPosting = vi.fn();
const uploadMutateAsync = vi.fn();
const saveMutate = vi.fn();
const writeSheet = vi.fn();
const reportLinesPdf = vi.fn();
const waitingCardsPdf = vi.fn();
const readBatches = vi.fn();

/* The batch list, swappable: the screen draws a different conclusion from
   "3 lines still open" than from "every line decided", and both have to be
   provable. Reset by each test that changes it. */
const BATCH = {
  id: 1, acquirer_code: 'MBB', file_name: 'aug.csv', period_from: '2026-08-01', period_to: '2026-08-03',
  row_count: 2, gross_sen: 177700, fee_sen: 2600, net_sen: 175100, stated_net_sen: null,
  adjustment_sen: 0, adjustment_je_no: null, received_on: null, received_sen: 0,
  outstanding_sen: 175100, receipt_count: 0, confirmed_count: 1, open_count: 3,
  to_confirm_count: 1, to_choose_count: 1, no_record_count: 1,
  status: 'OPEN', uploaded_by: null, created_at: '',
};
let batchList: Array<Record<string, unknown>> = [BATCH];

/* A line the window could offer nothing for (docs/bugs/0792). */
const LONELY_ROW: SettlementRow = {
  id: 11, line_no: 9, txn_date: '2026-06-02', ref: '615318040666',
  gross_sen: 286500, fee_sen: 11460, net_sen: 275040,
  bucket: 'UNMATCHED', match_reason: null, confirmed_at: null,
  posted_je_no: null, notes: null, linked: [], candidates: [], comboHints: [], clue: null,
};
const findResults = [
  { source: 'SOPAY' as const, id: 'f1', docNo: '2990-SO-2606-011', customerName: 'Chou Mun Yee', paidOn: '2026-06-14', amountSen: 286500, approvalCode: '005751', merchantProvider: null, possible: true, method: 'installment' },
  { source: 'SOPAY' as const, id: 'f2', docNo: '2990-SO-2606-013', customerName: 'Tan Ah Kow', paidOn: '2026-06-14', amountSen: 336500, approvalCode: '009577', merchantProvider: null, possible: false, method: 'installment' },
];
const setBatchList = (b: Array<Record<string, unknown>>) => { batchList = b; };
const REPORT_ROWS: SettlementRow[] = [ROW, MATCHED_ROW, SUGGESTED_ROW, DONE_ROW, LONELY_ROW];
let reportRows: SettlementRow[] = REPORT_ROWS;
/* What differs on the report a test opens. */
let openedBatch: Record<string, unknown> = {};

vi.mock('./settlement-queries', () => { const m = {
  useAcquirerSetup: () => ({ data: { acquirers: [MBB, GHL], bankAccounts: [{ account_code: '310-0010', account_name: 'Bank — Maybank Current' }] }, isLoading: false }),
  useSaveAcquirerSetup: () => ({ mutate: saveMutate, isPending: false }),
  useReadSettlementBatches: () => readBatches,
  useSettlementBatches: () => ({ data: { batches: batchList }, isLoading: false }),
  useSettlementBatch: () => ({
    data: {
      batch: {
        id: 1, acquirer_code: 'MBB', net_sen: 175100, stated_net_sen: null,
        adjustment_sen: 0, adjustment_je_no: null, received_on: null,
        received_sen: 60000, outstanding_sen: 115100,
        ...openedBatch,
        receipts: [{ id: 9, received_on: '2026-08-05', amount_sen: 60000, bank_ref: null, note: null, je_no: 'JE-2608-0007', created_by: 'Ah Chew' }],
      },
      acquirer: { code: 'MBB', hasUniqueRef: true, dateToleranceDays: 3 },
      buckets: { MATCHED: 1, NEEDS_CONFIRM: 1, UNMATCHED: 0, IGNORED: 0 },
      rows: reportRows,
      /* The owner's 3,053 → 3,052, read back as the report opened (docs/bugs/0833). */
      refreshedLinks: [{ settlementRowId: 2, paymentSource: 'SOPAY', paymentId: 'p7', docNo: 'SO-2608-777', fromSen: 305300, toSen: 305200 }],
    },
    isLoading: false,
  }),
  useUploadStatement: () => ({ mutateAsync: uploadMutateAsync, isPending: false }),
  /* The Upload drawer carries Public Bank's advice too. */
  useUploadPayoutAdvice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePayouts: () => ({ data: { payouts: [], chargeAccounts: [], feeAccountByAcquirer: {} }, isLoading: false }),
  useConfirmSettlementRow: () => ({ mutate: confirmMutate, isPending: false, isError: false, error: null }),
  useConfirmSettlementGroup: () => ({ mutate: confirmGroupMutate, isPending: false, isError: false, error: null }),
  useUnconfirmSettlementRow: () => ({ mutate: unconfirmMutate, isPending: false }),
  useReleaseSettlementRow: () => ({ mutate: releaseMutate, isPending: false }),
  useConfirmMatched: () => ({ mutate: confirmMatchedMutate, isPending: false, data: null }),
  confirmMatchedBatch: (id: number) => confirmMatchedBatch(id),
  useInvalidateAfterPosting: () => refreshAfterPosting,
  useIgnoreSettlementRow: () => ({ mutate: vi.fn(), isPending: false }),
  /* "Find the sale" (docs/bugs/0792): what the server would answer for the
     lonely line — the sale keyed twelve days late, at the exact gross. */
  useFindPayments: (rowId: number | null, q: string) => ({
    data: rowId == null ? undefined : { q, payments: findResults.filter((p) => q === '' || p.docNo.includes(q) || p.customerName.toLowerCase().includes(q.toLowerCase())) },
    isLoading: false, isError: false, error: null,
  }),
  useSettlementWatchlist: () => ({ data: { from: '2026-05-18', to: '2026-08-16', clean: false, arrivedNotRecorded: [], recordedNotArrived: [
    { source: 'SOPAY', id: 'w1', acquirerCode: 'MBB', docNo: 'SO-2607-088', paidOn: '2026-07-18', amountSen: 35000, approvalCode: 'A0900', ageDays: 29, salespersonName: 'Kah Wai', ref: 'HC13025', customer_so_no: 'HC99999', accountSheet: 'R49241' },
    /* Keyed in without a bank — the server lists it once, under no acquirer (docs/bugs/0688). */
    { source: 'SOPAY', id: 'w2', acquirerCode: null, docNo: 'SO-2606-013', paidOn: '2026-06-14', amountSen: 336500, approvalCode: '009577', ageDays: 63, ref: null, customer_so_no: 'ZNT6656', accountSheet: '393020' },
  ] }, isLoading: false }),
}; return { ...m, useSettlementBatchRow: m.useSettlementBatch }; });

/* The advice tab is the acquirer's own paperwork, so it has a door on this
   screen too (owner, 2026-08-24: 毕竟它属于card merchant 那边). Its contract is
   PayoutAdviceTab.test.tsx; here it is stubbed and only its door is proved. */
vi.mock('./PayoutAdviceTab', () => ({ PayoutAdviceTab: () => <div>payment advice tab</div> }));
/* The cards read a missing report off Finance's To do (card-missing). */
let todoJobs: Array<Record<string, unknown>> = [];
vi.mock('./finance/finance-todo-queries', () => ({ useFinanceTodo: () => ({ data: { mine: todoJobs } }) }));

/* The exports leave through these two doors; what goes through them is what is pinned here. */
vi.mock('../../components/dataTableLineExport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/dataTableLineExport')>()),
  writeLineExportFile: (...args: unknown[]) => writeSheet(...args),
}));
vi.mock('../../vendor/scm/lib/merchant-recon-pdf', () => ({
  generateReportLinesPdf: (...args: unknown[]) => reportLinesPdf(...args),
  generateWaitingCardsPdf: (...args: unknown[]) => waitingCardsPdf(...args),
}));
/* "Previous record" leaves through this door (owner 2026-11-11: 之前record，我哪里都不会take-in). */
const markPrevious = vi.fn();
vi.mock('./unmatched-payments-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./unmatched-payments-queries')>()),
  useMarkPrevious: () => ({ mutate: (...args: unknown[]) => markPrevious(...args), isPending: false }),
}));

import { MerchantRecon } from './MerchantRecon';
import { refusalText } from './settlement-ui';

const draw = () => render(<MemoryRouter><MerchantRecon /></MemoryRouter>);
/** The upload is a drawer now (the redesign): the page's Upload button opens it. */
const openUpload = () => fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
/** A report's lines sit in five tabs (the redesign): To confirm · To choose · No sale found ‖ Confirmed · Set aside. */
const openTab = (name: string) => fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}`) }));

/* The bug the owner hit on the local rig: the page showed "Some of the details
   weren't accepted" instead of the statement's actual problem, because the
   shared humanApiError treats any message containing "column" as a database
   internal and replaces it. The server's own sentence is on err.body. */
describe("refusalText — the server's sentence must reach the operator", () => {
  test('prefers the raw body over the humanised message', () => {
    const err = Object.assign(new Error("Some of the details weren't accepted."), {
      status: 400,
      body: JSON.stringify({ error: 'unreadable_statement', message: 'Not a MBB statement — no Txn Date heading. The file has: Invoice No, Customer' }),
    });
    expect(refusalText(err, 'fallback')).toMatch(/no Txn Date heading/);
  });

  test('falls back to the humanised message, then to the caller default', () => {
    expect(refusalText(new Error('plain failure'), 'fallback')).toBe('plain failure');
    expect(refusalText(Object.assign(new Error(''), { body: 'not json' }), 'fallback')).toBe('fallback');
    expect(refusalText(null, 'fallback')).toBe('fallback');
  });
});

describe("the top of the page (the redesign's Merchant reports)", () => {
  test('it is Merchant reports; the payment advices are a door, not a detour', () => {
    draw();
    expect(screen.getByRole('heading', { name: 'Merchant reports' })).toBeTruthy();
    expect(screen.queryByText('payment advice tab')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Payment advices' }));
    expect(screen.getByText('payment advice tab')).toBeTruthy();
  });

  test('a card per acquirer says what is left to decide and where it stands; a missing report comes first', () => {
    todoJobs = [{ key: 'card-missing:GHL', rule: 'card-missing', since: '2026-08-05' }];
    draw();
    const cards = screen.getByRole('group', { name: 'Acquirers' });
    const mbb = within(cards).getByRole('button', { name: /MBB/ });
    const ghl = within(cards).getByRole('button', { name: /GHL/ });
    expect(ghl.textContent).toContain('2026/08/04 report missing');
    expect(mbb.textContent).toMatch(/to decide/);
    todoJobs = [];
  });

  test('choosing an acquirer narrows the page to it and shows its reports by swipe day; choosing it again shows them all', () => {
    draw();
    fireEvent.click(within(screen.getByRole('group', { name: 'Acquirers' })).getByRole('button', { name: /MBB/ }));
    const strip = screen.getByLabelText('MBB reports');
    expect(within(strip).getByText(/by the date customers swiped/)).toBeTruthy();
    expect(within(strip).getByRole('button', { name: /All reports/ })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Acquirers' })).getByRole('button', { name: /MBB/ }));
    expect(screen.queryByLabelText('MBB reports')).toBeNull();
  });
});

describe('the reconcile tab', () => {
  test('an acquirer with no unique reference is called out before anything is uploaded', () => {
    draw();
    openUpload();
    fireEvent.change(screen.getByLabelText('Acquirer'), { target: { value: 'GHL' } });
    expect(screen.getByText(/sends no unique reference/)).toBeTruthy();
  });

  test('several reports can be picked at once', () => {
    draw();
    openUpload();
    fireEvent.change(screen.getByLabelText('Acquirer'), { target: { value: 'MBB' } });
    expect(screen.getByLabelText('Statement files').hasAttribute('multiple')).toBe(true);
  });

  /* After uploading, he wants ONE answer for the lot — not to be dropped into
     the last file (2026-08-18: 让我知道我 upload 的文件有哪里几笔是 match 的，有
     哪里几笔是我要 manual check 或 verify 的，有哪里几笔会是 merchant 收到但完全
     match 不上的). Three numbers, three different jobs. */
  test('uploading lands on what the upload found, across every file', async () => {
    uploadMutateAsync.mockResolvedValue({
      batchId: 1, rows: 2, skippedLines: 0, statedNetSen: null, adjustmentSen: 0,
      grossSen: 177700, feeSen: 2600, netSen: 175100,
      periodFrom: '2026-08-01', periodTo: '2026-08-03',
      buckets: { MATCHED: 1, NEEDS_CONFIRM: 1, UNMATCHED: 1, IGNORED: 0 },
      /* One line the bank pays once, already on another report (docs/bugs/0823). */
      alreadyOnReport: 1,
      alreadyOnReportDetail: [{ lineNo: 1, txnDate: '2026-08-01', ref: 'A1', grossSen: 100000, batchId: 7, fileName: '027012896718_EP41_713_20260801.CSV', lineNoThere: 1 }],
    });
    draw();
    openUpload();
    fireEvent.change(screen.getByLabelText('Acquirer'), { target: { value: 'MBB' } });
    const picker = screen.getByLabelText('Statement files');
    const file = new File(['Txn Date,Gross'], 'aug.csv', { type: 'text/csv' });
    /* jsdom's File carries no .text() — the page reads the file with it. */
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('Txn Date,Gross') });
    fireEvent.change(picker, { target: { files: [file] } });
    await waitFor(() => expect((screen.getByRole('button', { name: /Upload & match/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /Upload & match/ }));
    /* The drawer says the piles; Done lands on what the upload found. */
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));

    await waitFor(() => expect(screen.getByText(/report read/)).toBeTruthy());
    /* What was left out, and where it already is (docs/bugs/0823). */
    expect(screen.getByText(/1 line\(s\) already on 027012896718_EP41_713_20260801\.CSV left out/)).toBeTruthy();
    expect(screen.getByText(/the bank pays a card transaction once/)).toBeTruthy();
    /* The three counts come from the batch list, which the fixture answers. */
    /* The three tallies… */
    expect(screen.getAllByText('matched by reference').length).toBeGreaterThan(0);
    expect(screen.getByText('to check by hand')).toBeTruthy();
    expect(screen.getAllByText('no sale in the ERP').length).toBeGreaterThan(0);
    /* …and every LINE the upload read, with the sale it matched — not a count
       per file (owner: 显示 transaction detail 和 sales order detail). */
    expect(screen.getByText('What the merchant reported')).toBeTruthy();
    expect(screen.getByText('The sale it paid for')).toBeTruthy();
    expect(screen.getByText('SO-2608-043')).toBeTruthy();       // the matched sale, by name
    /* And one button finishes the easy half of the whole upload. */
    expect(screen.getByText(/Confirm all 1 matched/)).toBeTruthy();
  });

  /* His answer to "what should this screen open on": 应该就只会显示还没对上的
     transaction 吧. Both kinds of not-matched, named, on the landing view. */
  test('the landing shows only what is not matched yet, from both sides', () => {
    draw();
    /* The report's OWN LINES, with the sale each matched — the same two columns
       as the upload summary. A file name is not a transaction. */
    expect(screen.getAllByText('What the merchant reported').length).toBeGreaterThan(0);
    expect(screen.getByText('SO-2608-043')).toBeTruthy();          // the matched sale
    expect(screen.getByText('Reconcile')).toBeTruthy();
    /* Lines already decided are not work, so they are not on the work list. */
    expect(screen.queryByText('JE-2608-0011')).toBeNull();
    // and the payments the sales team keyed in that no report has reported
    expect(screen.getByText('Card payments no merchant report has reported yet (2)')).toBeTruthy();
    expect(screen.getByText('SO-2607-088')).toBeTruthy();
    expect(screen.getByText('A0900')).toBeTruthy();
  });

  /* docs/bugs/0688 — the owner, the morning per-bank clearing went live: the
     same instalment under GHL, HLB, MBB and PBB, and the header counting it
     four times. It is one payment: one row, marked 未标, counted once. */
  test('a payment keyed in without a bank is one row, marked 未标, and counted once', () => {
    draw();
    expect(screen.getByText('未标')).toBeTruthy();
    expect(screen.getByText('SO-2606-013')).toBeTruthy();
    expect(screen.getByText(/RM 3,715\.00 in total/)).toBeTruthy();
    expect(screen.getByText(/1 keyed in without a bank/)).toBeTruthy();
  });

  /* Only Hong Leong writes its dates without a year. Showing everyone else a
     field they cannot answer is how a screen teaches people to ignore it. */
  test('the statement month is asked only of the acquirer whose file has no year', () => {
    draw();
    openUpload();
    expect(screen.queryByLabelText('Statement month')).toBeNull();

    fireEvent.change(screen.getByLabelText('Acquirer'), { target: { value: 'GHL' } });
    expect(screen.getByLabelText('Statement month')).toBeTruthy();
    expect(screen.getByText(/GHL dates its lines like/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Acquirer'), { target: { value: 'MBB' } });
    expect(screen.queryByLabelText('Statement month')).toBeNull();
  });

  /* The field this screen used to carry at upload was wrong, and the owner
     caught it: on the day he uploads the card-machine report he cannot know
     when the money will land — 全部卡机都是隔几天收到的。 */
  test('the upload form does not ask when the money arrived', () => {
    draw();
    expect(screen.queryByLabelText('Money reached the bank on')).toBeNull();
  });

  /* Opening a report shows the lines still to decide and NOTHING else — the
     upload row, the other reports and the finished lines are all gone. */
  /* A matched line says it ONCE, in the words of the work it needs — the owner
     looked at two lines saying the same thing and said 好像还是一样. */
  test('a matched line says it once, and is not called a decision', () => {
    draw();
    fireEvent.click(screen.getByText('Reconcile'));
    openTab('Confirmed');
    /* The counts are stated ONCE, at the top. */
    expect(screen.getAllByText(/still to decide/)).toHaveLength(1);
    expect(screen.getByText(/1 matched, waiting for you to confirm/)).toBeTruthy();
    expect(screen.getByText(/opens for this report once every line is done/)).toBeTruthy();
    openTab('To choose');
    /* The line that needs a person still carries its clue… */
    expect(screen.getByText('No single payment matches; 1 pair(s) of payments add up to this amount')).toBeTruthy();
    /* …and the matched one names its match once, in the words of the work. */
    openTab('To confirm');
    expect(screen.getByText(/Matched to/)).toBeTruthy();
    /* …and does NOT also repeat that as a grey clue above it. */
    expect(screen.queryByText('Reference 969745 matches SO-2608-043')).toBeNull();
  });

  test('a payment corrected after the upload is read back as the report opens, and named (docs/bugs/0833)', () => {
    draw();
    fireEvent.click(screen.getByText('Reconcile'));
    const note = screen.getByTestId('refreshed-links');
    expect(note.textContent).toContain('1 link refreshed');
    expect(note.textContent).toContain('SO-2608-777');
    expect(note.textContent).toContain('3,052.00');
  });

  test('a report opens on the lines still to decide, with its clue and candidates', () => {
    draw();
    fireEvent.click(screen.getByText('Reconcile'));
    openTab('To choose');
    /* Two kinds of not-done on this report, and the screen names both: one
       matched by reference (a button) and the ones that need a person — ROW,
       SUGGESTED_ROW, and the LONELY_ROW the window had nothing for. */
    expect(screen.getByText('1 matched, waiting for you to confirm · 3 still to decide')).toBeTruthy();
    expect(screen.getByText(/pair\(s\) of payments add up/)).toBeTruthy();
    expect(screen.getByText('SO-2608-001')).toBeTruthy();
    // the list it came from is off the screen
    expect(screen.queryByLabelText('Statement files')).toBeNull();
    // and the counts are still stated, so nothing is hidden
    expect(screen.getByText('1 done · 0 set aside')).toBeTruthy();
    // the finished line is not on screen until he asks for it
    expect(screen.queryByText(/JE-2608-0011/)).toBeNull();
    openTab('Confirmed');
    /* It comes back as a TABLE row now, not a card: a line already decided
       asks nothing of anybody, so it is information, and the journal number
       reads inside its status cell. */
    expect(screen.getByText(/done · JE-2608-0011/)).toBeTruthy();
    /* And beside it, the way back out of the ledger — the door the ignore
       refusal has always named. One press per row, straight to the server;
       the server's own refusals (money already received) come back verbatim. */
    fireEvent.click(screen.getByTitle(/Take this line back out of the ledger/));
    expect(unconfirmMutate).toHaveBeenCalledWith(8, expect.anything());
  });

  /* A migration-era payment carries no merchant tag; the operator claiming it
     should see that where he ticks it. Strictly null-only: SUGGESTED_ROW's
     candidate omits the field entirely (an older response shape) and must NOT
     be called untagged. */
  test('an untagged payment says so where it is claimed', () => {
    draw();
    fireEvent.click(screen.getByText('Reconcile'));
    openTab('To choose');
    expect(screen.getAllByText('未标 merchant')).toHaveLength(1);
    const cell = screen.getByText(/SO-2608-001/).closest('td') as HTMLElement;
    expect(cell.textContent).toContain('未标 merchant');
    const tagged = screen.getByText(/SO-2608-002/).closest('td') as HTMLElement;
    expect(tagged.textContent).not.toContain('未标 merchant');
  });

  /* The approval code may be mistyped, so the system falls back to amount+date
     and offers its answer PRE-TICKED — he confirms rather than re-does the
     search (2026-08-18: 尽量根据日期金额去尝试自动匹配后让我知道，我 final
     confirm). Still a suggestion: nothing posts until the button is pressed. */
  test('the system best guess arrives already ticked, ready to confirm', () => {
    draw();
    fireEvent.click(screen.getByText('Reconcile'));
    openTab('To choose');
    /* SUGGESTED_ROW carries one payment that makes its amount exactly. */
    expect((screen.getByLabelText('Select SO-2608-050') as HTMLInputElement).checked).toBe(true);
    const confirms = screen.getAllByText('Confirm and post') as HTMLButtonElement[];
    expect(confirms.some((b) => !b.disabled)).toBe(true);
  });

  test('a part-selection cannot be confirmed; the pair that adds up can', () => {
    draw();
    fireEvent.click(screen.getByText('Reconcile'));
    openTab('To choose');
    /* Scoped to THIS line: other lines on the report have their own button. */
    const line = screen.getByLabelText('Select SO-2608-001').closest('section') as HTMLElement;
    const button = () => within(line).getByText('Confirm and post') as HTMLButtonElement;
    expect(button().disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Select SO-2608-001'));
    expect(within(line).getByText(/Selected RM 600\.00 of RM 1,000\.00/)).toBeTruthy();
    expect(button().disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Select SO-2608-002'));
    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    expect(confirmMutate).toHaveBeenCalledWith(expect.objectContaining({
      rowId: 7,
      payments: [
        expect.objectContaining({ id: 'p1', amountSen: 60000 }),
        expect.objectContaining({ id: 'p2', amountSen: 40000 }),
      ],
    }));
  });
});

/* Owner 2026-10-21: 我从 merchant recon 点开 SO，返回也要返回 merchant recon —
   the order's Back returns to this page's address, so the open report has to
   live in it. */
describe('the open report lives in the address', () => {
  function Where() {
    const l = useLocation();
    return <output data-testid="where">{l.search}</output>;
  }

  test('opening a report puts it in the address; the address opens it again; All reports takes it out', () => {
    render(<MemoryRouter initialEntries={['/scm/merchant-recon']}><MerchantRecon /><Where /></MemoryRouter>);
    fireEvent.click(screen.getByText('Reconcile'));
    expect(screen.getByTestId('where').textContent).toBe('?batch=1');
    expect(screen.getByText(/still to decide/)).toBeTruthy();
  });

  test('coming back to ?batch=1 lands on that report, not on the list', () => {
    render(<MemoryRouter initialEntries={['/scm/merchant-recon?batch=1']}><MerchantRecon /><Where /></MemoryRouter>);
    expect(screen.getByText(/still to decide/)).toBeTruthy();
    expect(screen.queryByText('Reconcile')).toBeNull();
  });
});

/* Owner 2026-10-21: 点开那个 HC-SO-013512 这些 sales order 直接打开整张 sales
   order — on the work list, inside a report, and on the watch list. */
describe('an order number opens the whole order', () => {
  const hrefOf = (name: string) => screen.getAllByRole('link', { name })[0]!.getAttribute('href');

  test('on the work list and the watch list, each order number links to that order', () => {
    draw();
    expect(hrefOf('SO-2608-043')).toBe('/scm/sales-orders/SO-2608-043');   // matched by reference
    expect(hrefOf('SO-2608-050')).toBe('/scm/sales-orders/SO-2608-050');   // the system's guess
    expect(hrefOf('SO-2607-088')).toBe('/scm/sales-orders/SO-2607-088');   // not on a report yet
  });

  test('inside a report, the candidates and the matched order are links too — in their own cell, apart from the tick', () => {
    draw();
    fireEvent.click(screen.getByText('Reconcile'));
    openTab('To choose');
    expect(hrefOf('SO-2608-001')).toBe('/scm/sales-orders/SO-2608-001');
    expect(hrefOf('SO-2608-002')).toBe('/scm/sales-orders/SO-2608-002');
    /* The tick and the number are separate cells, so opening the order never ticks it. */
    const link = screen.getAllByRole('link', { name: 'SO-2608-001' })[0]!;
    expect(link.closest('label')).toBeNull();
    expect(link.closest('td')?.querySelector('input[type="checkbox"]')).toBeNull();
    openTab('To confirm');
    expect(hrefOf('SO-2608-043')).toBe('/scm/sales-orders/SO-2608-043');
  });
});

/* 但是当我upload 很多时我要一个一个按confirm? — no. The reports waiting on the
   work list take ONE press for every line that matched by its approval code,
   and that press must not touch the lines that need a person. */
describe('confirming a pile of reports', () => {
  /* Owner 2026-10-21, on "Posted 0. 52 could not be — Network error": every
     open report got a request and the whole screen was read again after each,
     so one press sent thousands. Now only the reports with something to post,
     and one refresh at the end. */
  const NOTHING_TO_POST = { ...BATCH, id: 2, file_name: 'sep.csv', to_confirm_count: 0, to_choose_count: 2, open_count: 2 };
  const CHARGE_ONLY = { ...BATCH, id: 3, file_name: 'aeon.csv', to_confirm_count: 0, adjustment_sen: 48984, adjustment_je_no: null };

  test('a report with a charge beyond its lines: its net is what the acquirer pays, on the list and above the card', () => {
    /* AEON's subvention fee: lines net RM 1,751.00, the report pays RM 1,261.16. */
    const charged = { stated_net_sen: 126_116, adjustment_sen: 48_984, adjustment_je_no: null };
    setBatchList([{ ...BATCH, ...charged }]);
    openedBatch = charged;
    draw();
    expect(screen.getByText('net RM 1,261.16')).toBeTruthy();
    expect(screen.queryByText('net RM 1,751.00')).toBeNull();
    fireEvent.click(screen.getByText('Reconcile'));
    expect(screen.getByText(/· net RM 1,261\.16/)).toBeTruthy();
    openedBatch = {};
    setBatchList([BATCH]);
  });

  test('the work list offers one press for every matched line, sends only the reports with work in them, and refreshes once', async () => {
    confirmMatchedBatch.mockReset();
    refreshAfterPosting.mockReset();
    confirmMatchedBatch.mockResolvedValue({ attempted: 1, confirmed: 1, failed: [], statementCharge: { status: 'nothing_to_post' } });
    setBatchList([BATCH, NOTHING_TO_POST, CHARGE_ONLY]);
    draw();

    /* 1 matched by reference; the report holding only lines to choose is not
       counted, the one with an unbooked statement charge is. */
    const button = screen.getByText(/Confirm all 1 matched, across 2 reports/);
    expect(screen.getByText(/line\(s\) needing you are left alone/)).toBeTruthy();

    fireEvent.click(button);
    await waitFor(() => expect(refreshAfterPosting).toHaveBeenCalledTimes(1));
    expect(confirmMatchedBatch.mock.calls.map((c) => c[0])).toEqual([1, 3]);
    setBatchList([BATCH]);
  });

  test('it says what posted — lines and statement charges — and which report could not, in the server\'s words', async () => {
    confirmMatchedBatch.mockReset();
    confirmMatchedBatch.mockResolvedValueOnce({
      attempted: 5, confirmed: 4, statementCharge: { status: 'posted', jeNo: 'JE-2609-1354' },
      failed: [{ rowId: 9, reason: 'The selected payments add up to RM 3,500.00, but the statement line is RM 4,000.00' }],
    });
    draw();

    fireEvent.click(screen.getByText(/Confirm all 1 matched, across 1 report/));
    expect(await screen.findByText(/Posted 4 lines and 1 statement charge\. 1 could not be:/)).toBeTruthy();
    expect(screen.getByText(/but the statement line is RM 4,000\.00/).textContent).toContain('aug.csv');
  });

  test('a report that fails is named, and the others still post', async () => {
    confirmMatchedBatch.mockReset();
    refreshAfterPosting.mockReset();
    confirmMatchedBatch
      .mockRejectedValueOnce(new Error('Network error — please check your connection and try again.'))
      .mockResolvedValueOnce({ attempted: 2, confirmed: 2, failed: [], statementCharge: null });
    setBatchList([BATCH, { ...BATCH, id: 4, file_name: 'oct.csv', to_confirm_count: 2 }]);
    draw();

    fireEvent.click(screen.getByText(/Confirm all 3 matched, across 2 reports/));
    expect(await screen.findByText(/Posted 2 lines\. 1 could not be:/)).toBeTruthy();
    expect(screen.getByText(/Network error/).textContent).toContain('aug.csv');
    expect(refreshAfterPosting).toHaveBeenCalledTimes(1);
    setBatchList([BATCH]);
  });
});

/* posted all 了就应该核对完了，剩下要核对bank statement 罢了 — so a screen with
   nothing left to decide must stop offering the decision. The bug it fixes was
   visible: four lines stamped done · JE-2608-0013 under a live "Confirm all 4
   matched" and a tally still reading "4 ready to confirm". */
describe('when every line is decided', () => {
  const uploadOneFile = async () => {
    uploadMutateAsync.mockResolvedValue({
      batchId: 1, rows: 2, skippedLines: 0, statedNetSen: null, adjustmentSen: 0,
      grossSen: 177700, feeSen: 2600, netSen: 175100,
      periodFrom: '2026-08-01', periodTo: '2026-08-03',
      buckets: { MATCHED: 1, NEEDS_CONFIRM: 0, UNMATCHED: 0, IGNORED: 0 },
    });
    draw();
    openUpload();
    fireEvent.change(screen.getByLabelText('Acquirer'), { target: { value: 'MBB' } });
    const file = new File(['Txn Date,Gross'], 'aug.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('Txn Date,Gross') });
    fireEvent.change(screen.getByLabelText('Statement files'), { target: { files: [file] } });
    await waitFor(() => expect((screen.getByRole('button', { name: /Upload & match/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /Upload & match/ }));
    /* The drawer says the piles; Done lands on what the upload found. */
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.getByText(/report read/)).toBeTruthy());
  };

  test('the upload summary hands over to the bank instead of offering more work', async () => {
    setBatchList([{ ...BATCH, open_count: 0, confirmed_count: 4, to_confirm_count: 0, to_choose_count: 0, no_record_count: 0 }]);
    await uploadOneFile();

    expect(screen.getByText(/Merchant reconciliation done/)).toBeTruthy();
    expect(screen.getByText(/4 lines across 1 report, every one matched and booked/)).toBeTruthy();
    /* The offer of work is GONE — button and tallies both. */
    expect(screen.queryByText(/Confirm all/)).toBeNull();
    expect(screen.queryByText('ready to confirm')).toBeNull();
    /* And so are the lines: 他confirm 了下面就不应该显示了，就应该显示在 bank
       statement reconciliation 那个区域. */
    expect(screen.queryByText('The sale it paid for')).toBeNull();
    expect(screen.queryByText('SO-2608-043')).toBeNull();
    /* Hidden, not lost — the journal numbers are one press away. */
    fireEvent.click(screen.getByText('Show what was posted'));
    expect(screen.getByText('SO-2608-043')).toBeTruthy();
    expect(screen.getByText(/JE-2608-0011/)).toBeTruthy();
    /* And it points at the money, naming what is still owed. Scoped to the
       panel — the page header carries its own link to the same screen. */
    const panel = screen.getByText(/Merchant reconciliation done/).parentElement as HTMLElement;
    expect(within(panel).getByText(/Still to come: RM 1,751\.00 from MBB/)).toBeTruthy();
    expect(within(panel).getByText(/Bank statement reconciliation/).closest('a')?.getAttribute('href'))
      .toBe('/scm/bank-recon');

    setBatchList([BATCH]);
  });

  test('with the payout already banked it says so, and offers nothing further', async () => {
    setBatchList([{ ...BATCH, open_count: 0, confirmed_count: 4, to_confirm_count: 0, to_choose_count: 0, no_record_count: 0, received_sen: 175100, outstanding_sen: 0 }]);
    await uploadOneFile();

    expect(screen.getByText(/The payouts are in the bank too/)).toBeTruthy();
    expect(screen.queryByText(/Still to come/)).toBeNull();

    setBatchList([BATCH]);
  });
});

/* 可以分成多个 column 吗？不然有一点点难看，太多信息 — 我理想中应该左手边都是
   merchant report 的资料，然后紧挨着就是订单的资料 (owner, 2026-08-20).
   Each fact in a column of its own is what makes a reconciliation readable
   DOWN as well as across: the same gross under the same gross. */
describe('the two bands', () => {
  test('every fact has its own column, on the side it came from', () => {
    draw();
    expect(screen.getAllByText('What the merchant reported').length).toBeGreaterThan(0);
    expect(screen.getAllByText('The sale it paid for').length).toBeGreaterThan(0);
    for (const h of ['Date', 'Reference', 'Gross', 'Fee', 'Net', 'Document', 'Customer', 'Paid on', 'Approval', 'Amount']) {
      expect(screen.getAllByText(h).length, h).toBeGreaterThan(0);
    }
  });

  test('a matched line puts the merchant half and the ERP half in their own cells', () => {
    draw();
    const row = screen.getByText('969745').closest('tr') as HTMLElement;
    const cells = [...row.querySelectorAll('td')].map((td) => td.textContent);
    /* The reference stands alone rather than being glued to the date. */
    expect(cells).toContain('969745');
    /* And the document stands alone rather than being glued to the customer. */
    expect(cells).toContain('SO-2608-043');
  });

  /* A suggestion reads under the SAME headings as a claimed payment — it is
     the same kind of fact, and two layouts for one thing is how a reader stops
     trusting either. */
  test('a suggested sale fills the same columns as a confirmed one', () => {
    draw();
    const row = screen.getByText('TYPO9').closest('tr') as HTMLElement;
    const cells = [...row.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells).toContain('SO-2608-050');
    expect(cells).toContain('114220');
    expect(cells).toContain('2026-08-03');
  });
});

/* 这个是什么? (owner, 2026-08-20) — asked of 27 identical cards sitting under a
   button that would have cleared all 27 at once, each repeating the same
   paragraph about "Set aside". A card is a DECISION; a line already matched by
   its reference asks nothing of anybody. */
describe('inside one report', () => {
  const open = () => { draw(); fireEvent.click(screen.getByText('Reconcile')); };

  test('a matched line is a table row, not a card', () => {
    open();
    /* MATCHED_ROW claimed SO-2608-043 by its reference — no choice to make. */
    const row = screen.getByText('969745').closest('tr') as HTMLElement;
    expect(row).toBeTruthy();
    expect(within(row).getByText('SO-2608-043')).toBeTruthy();
    expect(within(row).getByText(/the button above books it/)).toBeTruthy();
    /* And it has no confirm button of its own — the one at the top does it. */
    expect(within(row).queryByText('Confirm and post')).toBeNull();
  });

  /* Owner 2026-11-03 (batch 3 d2): the reference matched it, and it is not that sale. */
  test('a matched line can be told "Not this" — its match is released, nothing posts', () => {
    open();
    const row = screen.getByText('969745').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByText('Not this'));
    expect(releaseMutate).toHaveBeenCalledWith({ rowId: 9, payments: [] }, expect.anything());
    /* A confirmed line has Undo, not Not this. */
    openTab('Confirmed');
    const done = screen.getByText(/done · JE-2608-0011/).closest('tr') as HTMLElement;
    expect(within(done).queryByText('Not this')).toBeNull();
  });

  /* Owner 2026-11-10 (这个 system guess 的，如果我确定了不是有没有按钮可以按不是了 → 做):
     the guess is no link, so the press names the payments the line shows. */
  test('the system’s guess can be told "Not this" too — on its card, naming the guessed sale', () => {
    releaseMutate.mockClear();
    open();
    openTab('To choose');
    const card = screen.getByLabelText('Select SO-2608-050').closest('section') as HTMLElement;
    fireEvent.click(within(card).getByText('Not this'));
    expect(releaseMutate).toHaveBeenCalledWith({ rowId: 10, payments: ['SOPAY:b3'] }, expect.anything());
    /* A line with only possibilities and no guess has nothing to turn down. */
    const choose = screen.getByLabelText('Select SO-2608-001').closest('section') as HTMLElement;
    expect(within(choose).queryByText('Not this')).toBeNull();
  });

  test('a line that needs choosing keeps its card', () => {
    open();
    openTab('To choose');
    /* ROW has candidates and no link: a person has to pick. */
    const card = screen.getByLabelText('Select SO-2608-001').closest('section') as HTMLElement;
    expect(card).toBeTruthy();
    expect(within(card).getByText('Confirm and post')).toBeTruthy();
  });

  /* It used to sit under EVERY line — 27 copies on his Public Bank report. */
  test('the "set aside" explanation is said once', () => {
    open();
    openTab('To choose');
    expect(screen.getAllByText(/just moves a line out of the working list/)).toHaveLength(1);
  });
});

describe('"Not this" on the work list', () => {
  test('the guess and the reference match each carry it; a line to choose does not', () => {
    releaseMutate.mockClear();
    draw();
    const guess = screen.getByText('TYPO9').closest('tr') as HTMLElement;
    expect(within(guess).getByText('the system’s guess — check it')).toBeTruthy();
    fireEvent.click(within(guess).getByText('Not this'));
    expect(releaseMutate).toHaveBeenLastCalledWith({ rowId: 10, payments: ['SOPAY:b3'] }, expect.anything());

    const matched = screen.getByText('969745').closest('tr') as HTMLElement;
    fireEvent.click(within(matched).getByText('Not this'));
    expect(releaseMutate).toHaveBeenLastCalledWith({ rowId: 9, payments: [] }, expect.anything());

    const choose = screen.getByText('ZZ9').closest('tr') as HTMLElement;
    expect(within(choose).queryByText('Not this')).toBeNull();
  });
});

/* ── Lines matched TOGETHER (owner 2026-11-03, option B) ──────────────────────
   GHL 29/10: the customer swiped RM 5,000 and RM 2,085 for two orders of
   RM 2,990 and RM 4,095. No line equals any payment; the two lines together
   equal the two payments. */
describe('several lines of a report matched together', () => {
  const PAYS = [
    { source: 'SOPAY' as const, id: 'p55', docNo: '2990-SO-2610-055', paidOn: '2026-10-29', amountSen: 299000, approvalCode: null },
    { source: 'SOPAY' as const, id: 'p56', docNo: '2990-SO-2610-056', paidOn: '2026-10-29', amountSen: 409500, approvalCode: null },
  ];
  const SWIPE_A: SettlementRow = {
    ...LONELY_ROW, id: 21, line_no: 4, txn_date: '2026-10-29', ref: null, bucket: 'NEEDS_CONFIRM',
    gross_sen: 500000, fee_sen: 5000, net_sen: 495000, candidates: PAYS, clue: 'No payment or pair of payments makes this amount',
  };
  const SWIPE_B: SettlementRow = { ...SWIPE_A, id: 22, line_no: 5, gross_sen: 208500, fee_sen: 2085, net_sen: 206415 };
  const open = (rows: SettlementRow[]) => { reportRows = rows; draw(); fireEvent.click(screen.getByText('Reconcile')); };
  const cardOf = (lineNo: number) => screen.getByText(`Line ${lineNo}`, { selector: 'span' }).closest('section') as HTMLElement;

  test('ticking the other line makes the target their sum, and one press confirms both', () => {
    try {
      open([SWIPE_A, SWIPE_B]);
      openTab('To choose');
      const card = cardOf(4);
      fireEvent.click(within(card).getByLabelText('Select 2990-SO-2610-055'));
      fireEvent.click(within(card).getByLabelText('Select 2990-SO-2610-056'));
      /* Alone, line 4 is RM 2,085.00 short of what was picked. */
      expect(within(card).getByText(/Selected RM 7,085\.00 of RM 5,000\.00/)).toBeTruthy();
      expect((within(card).getByText('Confirm and post') as HTMLButtonElement).disabled).toBe(true);

      fireEvent.click(within(card).getByText('Match with other lines'));
      fireEvent.click(within(card).getByLabelText('Match with line 5'));
      expect(within(card).getByText(/Selected RM 7,085\.00 of RM 7,085\.00 \(2 lines together\)/)).toBeTruthy();
      const both = within(card).getByText('Confirm the 2 lines and post') as HTMLButtonElement;
      expect(both.disabled).toBe(false);
      fireEvent.click(both);
      expect(confirmGroupMutate).toHaveBeenCalledWith({
        rowIds: [21, 22],
        payments: [
          expect.objectContaining({ id: 'p55', amountSen: 299000 }),
          expect.objectContaining({ id: 'p56', amountSen: 409500 }),
        ],
      });
      expect(confirmMutate).not.toHaveBeenCalledWith(expect.objectContaining({ rowId: 21 }));
    } finally {
      reportRows = REPORT_ROWS;
    }
  });

  test('a line already holding its own payment is not offered to match with', () => {
    try {
      open([SWIPE_A, MATCHED_ROW]);
      openTab('To choose');
      /* MATCHED_ROW claimed its sale by reference; the only other line has nothing to join. */
      expect(within(cardOf(4)).queryByText('Match with other lines')).toBeNull();
    } finally {
      reportRows = REPORT_ROWS;
    }
  });

  test('confirmed together, each line says which line it went with and their total', () => {
    const group = { leadRowId: 21, lines: [{ rowId: 21, lineNo: 4, grossSen: 500000 }, { rowId: 22, lineNo: 5, grossSen: 208500 }], grossSen: 708500 };
    const linked = PAYS.map((p) => ({ settlement_row_id: 21, payment_source: p.source, payment_id: p.id, doc_no: p.docNo, amount_sen: p.amountSen }));
    const done = { bucket: 'MATCHED' as const, confirmed_at: '2026-11-03T05:00:00Z', candidates: [], clue: null, linked, matched_with: group };
    try {
      open([{ ...SWIPE_A, ...done, posted_je_no: 'JE-2610-0101' }, { ...SWIPE_B, ...done, posted_je_no: 'JE-2610-0102' }]);
      openTab('Confirmed');
      const a = screen.getByText(/done · JE-2610-0101/).closest('tr') as HTMLElement;
      expect(within(a).getByText(/with line 5 · together RM 7,085\.00/)).toBeTruthy();
      expect(within(a).getByText('2990-SO-2610-056')).toBeTruthy();
      const b = screen.getByText(/done · JE-2610-0102/).closest('tr') as HTMLElement;
      expect(within(b).getByText(/with line 4 · together RM 7,085\.00/)).toBeTruthy();
    } finally {
      reportRows = REPORT_ROWS;
    }
  });
});

/* ── "Find the sale" — docs/bugs/0792 ────────────────────────────────────────
   GHL line RM 2,865.00 of 2026-06-02: the screen said "no sale in the ERP"
   over 2990-SO-2606-011, the same amount, keyed twelve days later with no bank.
   The person knows which sale it is; the screen must let him say so. */
describe('finding the sale the window could not offer', () => {
  const open = () => { draw(); fireEvent.click(screen.getByText('Reconcile')); };
  const lonely = () => screen.getByText('615318040666').closest('section') as HTMLElement;

  test('a line with no candidate offers the search instead of a dead end', () => {
    open();
    openTab('No sale found');
    const card = lonely();
    expect(within(card).getByText(/find it below/)).toBeTruthy();
    expect(within(card).queryByText('Confirm and post')).toBeNull();
    fireEvent.click(within(card).getByText('Find the sale'));
    expect(within(card).getByLabelText('Find the sale')).toBeTruthy();
  });

  test('the exact gross is marked possible, and the rest is still offered', () => {
    open();
    openTab('No sale found');
    const card = lonely();
    fireEvent.click(within(card).getByText('Find the sale'));
    const hit = within(card).getByLabelText('Select 2990-SO-2606-011').closest('tr') as HTMLElement;
    expect(within(hit).getByText('possible')).toBeTruthy();
    expect(within(hit).getByText('Chou Mun Yee')).toBeTruthy();
    expect(within(hit).getByText('未标 merchant')).toBeTruthy();
    const other = within(card).getByLabelText('Select 2990-SO-2606-013').closest('tr') as HTMLElement;
    expect(within(other).queryByText('possible')).toBeNull();
  });

  test('ticking the found sale confirms it with what the server will read back', () => {
    open();
    openTab('No sale found');
    const card = lonely();
    fireEvent.click(within(card).getByText('Find the sale'));
    fireEvent.click(within(card).getByLabelText('Select 2990-SO-2606-011'));
    expect(within(card).getByText(/Selected RM 2,865\.00 of RM 2,865\.00/)).toBeTruthy();
    const go = within(card).getByText('Confirm and post') as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    expect(confirmMutate).toHaveBeenCalledWith({
      rowId: 11, matchReason: 'manual',
      payments: [{ source: 'SOPAY', id: 'f1', docNo: '2990-SO-2606-011', amountSen: 286500 }],
    });
  });

  test('a found sale that does not add up cannot be confirmed', () => {
    open();
    openTab('No sale found');
    const card = lonely();
    fireEvent.click(within(card).getByText('Find the sale'));
    fireEvent.click(within(card).getByLabelText('Select 2990-SO-2606-013'));
    expect((within(card).getByText('Confirm and post') as HTMLButtonElement).disabled).toBe(true);
    expect(within(card).getByText(/RM 500\.00 out/)).toBeTruthy();
  });

  test('a line that already has candidates can still look further', () => {
    open();
    openTab('To choose');
    const card = screen.getByLabelText('Select SO-2608-001').closest('section') as HTMLElement;
    fireEvent.click(within(card).getByText('Find the sale'));
    expect(within(card).getByLabelText('Find the sale')).toBeTruthy();
  });
});

/* Owner 2026-09-10, on the "not yet reported" table: 我想要看到 salesman 的名字. */
describe('the watchlist names the salesperson', () => {
  test('a payment shows who sold it, and a dash when nobody is named', () => {
    draw();
    const w1 = screen.getByText('SO-2607-088').closest('tr') as HTMLElement;
    expect(within(w1).getByText('Kah Wai')).toBeTruthy();
    const w2 = screen.getByText('SO-2606-013').closest('tr') as HTMLElement;
    expect(within(w2).getByText('—')).toBeTruthy();
  });
});

/* Owner 2026-11-06: 这个 merchant report still to reconcile 和 card payment no merchant report
   has reported yet 我要能 export; 我要有那个 reference HC, ZNT 等等; 可以 right click export; 支持 pdf. */
describe('exporting the two lists', () => {
  const readAll = () => readBatches.mockImplementation(async (ids: number[]) => ids.map(() => ({ rows: reportRows })));
  const reportsMenu = () => fireEvent.contextMenu(screen.getByRole('columnheader', { name: 'Reference' }));
  const cardsMenu = () => fireEvent.contextMenu(screen.getByRole('columnheader', { name: /customer paid on/i }));
  const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
  const clear = () => [writeSheet, reportLinesPdf, waitingCardsPdf, readBatches].forEach((f) => f.mockReset());

  test('the card payments list shows the order\'s Ref No., ref first, and the Account sheet', () => {
    draw();
    expect(screen.getByRole('columnheader', { name: /Ref No\./ })).toBeTruthy();
    /* The reports list has one too. */
    expect(screen.getAllByRole('columnheader', { name: /account sheet/i })).toHaveLength(2);
    const w1 = screen.getByText('SO-2607-088').closest('tr') as HTMLElement;
    expect(within(w1).getByText('HC13025')).toBeTruthy();
    expect(within(w1).queryByText('HC99999')).toBeNull();
    expect(within(w1).getByText('R49241')).toBeTruthy();
    const w2 = screen.getByText('SO-2606-013').closest('tr') as HTMLElement;
    expect(within(w2).getByText('ZNT6656')).toBeTruthy();
    expect(within(w2).getByText('393020')).toBeTruthy();
  });

  test('its right click makes a PDF of the cells the Excel holds, Ref No. included', async () => {
    clear();
    draw();
    cardsMenu();
    press('Export to PDF');
    await waitFor(() => expect(waitingCardsPdf).toHaveBeenCalledTimes(1));
    const [view, opts] = waitingCardsPdf.mock.calls[0]!;
    expect(view.matrix.header).toEqual(['Merchant', 'Document', 'Ref No.', 'Salesperson', 'Customer paid on', 'Days', 'Amount', 'Account sheet', 'Approval']);
    expect(view.matrix.body[0]).toEqual(['MBB', 'SO-2607-088', 'HC13025', 'Kah Wai', '2026-07-18', 29, 350, 'R49241', 'A0900']);
    expect(view.keys).toContain('days');
    expect(opts).toEqual({ merchant: null });
  });

  test('its Excel goes out with the two new columns', async () => {
    clear();
    draw();
    cardsMenu();
    press('Export to Excel');
    await waitFor(() => expect(writeSheet).toHaveBeenCalledTimes(1));
    const [matrix, , file] = writeSheet.mock.calls[0]!;
    expect(file).toMatch(/^card-payments-not-reported-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(matrix.header).toContain('Ref No.');
    expect(matrix.header).toContain('Account sheet');
  });

  test('a right click on the reports list\'s header makes an Excel of every open line, read once per report', async () => {
    clear();
    readAll();
    draw();
    reportsMenu();
    press('Export to Excel');
    await waitFor(() => expect(writeSheet).toHaveBeenCalledTimes(1));
    expect(readBatches).toHaveBeenCalledWith([1]);
    const [matrix, sheet, file] = writeSheet.mock.calls[0]!;
    expect(sheet).toBe('To reconcile');
    expect(file).toMatch(/^merchant-reports-to-reconcile-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(matrix.header.slice(0, 5)).toEqual(['Merchant', 'Report', 'Date', 'Line', 'Reference']);
    /* REPORT_ROWS without the line already done. */
    expect(matrix.body.map((r: unknown[]) => r[4])).toEqual(['ZZ9', '969745', 'TYPO9', '615318040666']);
    expect(matrix.body[0].slice(0, 2)).toEqual(['MBB', 'aug.csv']);
    expect(screen.queryByRole('button', { name: 'Export to Excel' })).toBeNull();
  });

  test('and a PDF of the same reports, saying which merchant the list was cut to', async () => {
    clear();
    readAll();
    draw();
    reportsMenu();
    press('Export to PDF');
    await waitFor(() => expect(reportLinesPdf).toHaveBeenCalledTimes(1));
    const [reports, opts] = reportLinesPdf.mock.calls[0]!;
    expect(reports.map((r: { file: string; lines: unknown[] }) => [r.file, r.lines.length])).toEqual([['aug.csv', 4]]);
    expect(opts).toEqual({ merchant: null });
  });

  test('a file that cannot be made says why, beside the list it was asked of', async () => {
    clear();
    readBatches.mockRejectedValue(new Error('The report could not be read.'));
    draw();
    reportsMenu();
    press('Export to Excel');
    expect((await screen.findByRole('alert')).textContent).toContain('The report could not be read.');
    expect(writeSheet).not.toHaveBeenCalled();
  });

  test('the header says the right click is there', () => {
    draw();
    expect(screen.getByRole('columnheader', { name: 'Reference' }).closest('thead')?.getAttribute('title')).toBe('Right-click to export to Excel or PDF');
  });
});

/* A DuitNow QR line (owner 2026-11-09: 这个hlbb merchant 的0000PP 是qr direct 去bank
   的，不算卡机的 → 「A 照传，做」). Its sale is keyed Online and already in the
   bank, so the screen calls it QR money, offers that sale, and LINKS it — no fee,
   nothing posted, no "Confirm and post". */
describe('a DuitNow QR line', () => {
  const JENNY = {
    source: 'SOPAY' as const, id: 'jenny', docNo: '2990-SO-2611-041', paidOn: '2026-11-07', amountSen: 324000,
    approvalCode: '20261031HLBBMYKLA30OQR77370349', accountSheet: 'Bank transfer', customerName: 'Jenny',
    /* An Online payment carries no bank: that is not "keyed without a bank". */
    merchantProvider: null,
  };
  const QR_ROW: SettlementRow = {
    id: 857, line_no: 23, txn_date: '2026-10-31', ref: null, channel: 'QR',
    gross_sen: 324000, fee_sen: 0, net_sen: 324000, bucket: 'NEEDS_CONFIRM', match_reason: 'amount+date',
    confirmed_at: null, posted_je_no: null, notes: null, linked: [], comboHints: [],
    candidates: [JENNY], suggested: [JENNY],
    clue: 'DuitNow QR — the money went straight to the bank. 2990-SO-2611-041 is the only Online payment of this amount within 7 day(s). Check it and link it.',
  };
  const QR_LONELY: SettlementRow = {
    ...QR_ROW, id: 856, line_no: 18, txn_date: '2026-11-01', gross_sen: 10000, net_sen: 10000,
    bucket: 'UNMATCHED', match_reason: null, candidates: [], suggested: [],
    clue: "DuitNow QR — no Online payment of RM 100.00 near 2026-11-01. Key the sale as Online, with the QR's code.",
  };
  const QR_BATCH = {
    ...BATCH, acquirer_code: 'HLB', file_name: '00005992284_20261101.CSV', gross_sen: 0, fee_sen: 0, net_sen: 0,
    outstanding_sen: 0, qr_count: 2, qr_gross_sen: 334000,
    to_confirm_count: 0, to_choose_count: 1, no_record_count: 1, open_count: 2, confirmed_count: 0,
  };
  const withQr = (run: () => void) => {
    setBatchList([QR_BATCH]);
    reportRows = [QR_ROW, QR_LONELY];
    openedBatch = { acquirer_code: 'HLB', net_sen: 0, received_sen: 0, outstanding_sen: 0, qr_count: 2, qr_gross_sen: 334000 };
    try { run(); } finally { setBatchList([BATCH]); reportRows = REPORT_ROWS; openedBatch = {}; }
  };

  test('on the work list it reads DuitNow QR, in QR words, and its report names the QR money', () => withQr(() => {
    draw();
    expect(screen.getAllByText('DuitNow QR')).toHaveLength(2);
    expect(screen.getByText('the Online sale — check it')).toBeTruthy();
    expect(screen.getByText('no Online sale keyed')).toBeTruthy();
    expect(screen.queryByText('the system’s guess — check it')).toBeNull();
    expect(screen.getByText(/QR RM 3,340\.00 · straight to the bank/)).toBeTruthy();
  }));

  test('inside the report it links the Online sale, ticked — nothing is posted', () => withQr(() => {
    draw();
    fireEvent.click(screen.getByText('Reconcile'));
    openTab('To choose');
    const box = screen.getByLabelText('Select 2990-SO-2611-041') as HTMLInputElement;
    expect(box.checked).toBe(true);
    const line = box.closest('section') as HTMLElement;
    expect(within(line).queryByText('Confirm and post')).toBeNull();
    expect(within(line).getByText('DuitNow QR')).toBeTruthy();
    fireEvent.click(within(line).getByText('Link the sale'));
    expect(confirmMutate).toHaveBeenCalledWith(expect.objectContaining({
      rowId: 857, payments: [expect.objectContaining({ id: 'jenny', amountSen: 324000 })],
    }));
  }));

  /* Owner 2026-11-09 (「为什么我按find the sales 还有这么多？」 → 做): 未标 merchant
     means a CARD payment keyed without its bank. An Online payment has no bank
     to key, so a QR line never says it — not on its sale, not in Find the sale. */
  test('a QR line never marks its Online payments 未标 merchant', () => withQr(() => {
    draw();
    fireEvent.click(screen.getByText('Reconcile'));
    openTab('To choose');
    const line = screen.getByLabelText('Select 2990-SO-2611-041').closest('section') as HTMLElement;
    expect(within(line).queryByText('未标 merchant')).toBeNull();
    fireEvent.click(within(line).getByText('Find the sale'));
    expect(within(line).getByText(/Any Online payment of this company not yet on the bank statement/)).toBeTruthy();
    expect(within(line).getAllByLabelText(/^Select /).length).toBeGreaterThan(1);
    expect(within(line).queryByText('未标 merchant')).toBeNull();
  }));

  test('with no Online sale keyed it says to key the sale as Online', () => withQr(() => {
    draw();
    fireEvent.click(screen.getByText('Reconcile'));
    openTab('No sale');
    expect(screen.getByText(/No Online payment explains this QR money/)).toBeTruthy();
  }));
});

/* Owner 2026-11-11: 我检查确定后，就直接说这个是之前record，我哪里都不会take-in. */
describe('a card payment checked to be the previous system\'s', () => {
  test('is ticked and marked a previous record from the list; what came back is said', () => {
    markPrevious.mockClear();
    draw();
    const press = () => screen.getByRole('button', { name: /^Previous record/ });
    expect(press().hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tick SO-2606-013' }));
    fireEvent.click(press());
    expect(markPrevious).toHaveBeenCalledTimes(1);
    const [refs, handlers] = markPrevious.mock.calls[0]! as [unknown, { onSuccess: (got: unknown) => void }];
    expect(refs).toEqual([{ source: 'SOPAY', id: 'w2' }]);
    act(() => handlers.onSuccess({ ok: true, marked: 1, refused: [] }));
    expect(screen.getByText(/^1 payment marked as previous records/)).toBeTruthy();
  });
});
