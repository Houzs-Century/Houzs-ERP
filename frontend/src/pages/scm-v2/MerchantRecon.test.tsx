// The settlement screen's render contract. The rules themselves are pinned on
// the server (backend/src/acc/settlement-*.test.ts and tests/settlementRoutes);
// what is proved here is that the screen SAYS them:
//   • an acquirer with no unique reference is called out before an upload;
//   • a statement the server refused shows the server's sentence, verbatim;
//   • the four piles carry their counts and a line shows its clue;
//   • a selection that does not add up cannot be confirmed;
//   • the money side is NOT here — it is BankRecon.test.tsx, and the setup is
//     SettlementSetup.test.tsx: three jobs, three screens, as the owner asked.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { AcquirerSetup, SettlementRow } from './settlement-queries';

const MBB: AcquirerSetup = {
  code: 'MBB', display_name: 'MBB', statement_format: 'CSV', has_unique_ref: true,
  fee_method: 'stated', date_tolerance_days: 3, column_map: { date: 'Txn Date', gross: 'Gross' },
  transit_account_code: '320-0000', fee_account_code: '930-0000', bank_account_code: '330-0000',
  is_active: true, ready: true, autoMatchable: true,
};
const GHL: AcquirerSetup = { ...MBB, code: 'GHL', display_name: 'GHL', has_unique_ref: false, autoMatchable: false, dates_have_no_year: true, bank_account_code: null, bankReady: false };

const ROW: SettlementRow = {
  id: 7, line_no: 2, txn_date: '2026-08-03', ref: 'ZZ9',
  gross_sen: 100000, fee_sen: 1500, net_sen: 98500,
  bucket: 'NEEDS_CONFIRM', match_reason: 'amount+date', confirmed_at: null,
  posted_je_no: null, notes: null, linked: [],
  candidates: [
    { source: 'SOPAY', id: 'p1', docNo: 'SO-2608-001', paidOn: '2026-08-01', amountSen: 60000, approvalCode: 'A1' },
    { source: 'SOPAY', id: 'p2', docNo: 'SO-2608-002', paidOn: '2026-08-02', amountSen: 40000, approvalCode: null },
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
const confirmMatchedMutate = vi.fn();
const uploadMutateAsync = vi.fn();
const saveMutate = vi.fn();

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
const setBatchList = (b: Array<Record<string, unknown>>) => { batchList = b; };

vi.mock('./settlement-queries', () => ({
  useAcquirerSetup: () => ({ data: { acquirers: [MBB, GHL], bankAccounts: [{ account_code: '330-0000', account_name: 'Bank — Maybank Current' }] }, isLoading: false }),
  useSaveAcquirerSetup: () => ({ mutate: saveMutate, isPending: false }),
  useSettlementBatches: () => ({ data: { batches: batchList }, isLoading: false }),
  useSettlementBatch: () => ({
    data: {
      batch: {
        id: 1, acquirer_code: 'MBB', net_sen: 175100, stated_net_sen: null,
        adjustment_sen: 0, adjustment_je_no: null, received_on: null,
        received_sen: 60000, outstanding_sen: 115100,
        receipts: [{ id: 9, received_on: '2026-08-05', amount_sen: 60000, bank_ref: null, note: null, je_no: 'JE-2608-0007', created_by: 'Ah Chew' }],
      },
      acquirer: { code: 'MBB', hasUniqueRef: true, dateToleranceDays: 3 },
      buckets: { MATCHED: 1, NEEDS_CONFIRM: 1, UNMATCHED: 0, IGNORED: 0 },
      rows: [ROW, MATCHED_ROW, SUGGESTED_ROW, DONE_ROW],
    },
    isLoading: false,
  }),
  useUploadStatement: () => ({ mutateAsync: uploadMutateAsync, isPending: false }),
  useConfirmSettlementRow: () => ({ mutate: confirmMutate, isPending: false, isError: false, error: null }),
  useConfirmMatched: () => ({ mutate: confirmMatchedMutate, isPending: false, data: null }),
  useIgnoreSettlementRow: () => ({ mutate: vi.fn(), isPending: false }),
  useSettlementWatchlist: () => ({ data: { from: '2026-05-18', to: '2026-08-16', clean: false, arrivedNotRecorded: [], recordedNotArrived: [
    { source: 'SOPAY', id: 'w1', acquirerCode: 'MBB', docNo: 'SO-2607-088', paidOn: '2026-07-18', amountSen: 35000, approvalCode: 'A0900', ageDays: 29 },
  ] }, isLoading: false }),
}));

/* The advice tab is the acquirer's own paperwork, so it has a door on this
   screen too (owner, 2026-08-24: 毕竟它属于card merchant 那边). Its contract is
   PayoutAdviceTab.test.tsx; here it is stubbed and only its door is proved. */
vi.mock('./PayoutAdviceTab', () => ({ PayoutAdviceTab: () => <div>payment advice tab</div> }));

import { MerchantRecon } from './MerchantRecon';
import { refusalText } from './settlement-ui';

const draw = () => render(<MemoryRouter><MerchantRecon /></MemoryRouter>);

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

describe('the tab strip', () => {
  test('carries the payment advice beside the reports, and opens on the reports', () => {
    draw();
    /* The work queue is the default — the advice is a door, not a detour. */
    expect(screen.queryByText('payment advice tab')).toBeNull();
    fireEvent.click(screen.getByText('Payment advice'));
    expect(screen.getByText('payment advice tab')).toBeTruthy();
  });
});

describe('the reconcile tab', () => {
  test('an acquirer with no unique reference is called out before anything is uploaded', () => {
    draw();
    fireEvent.change(screen.getByLabelText('Acquirer'), { target: { value: 'GHL' } });
    expect(screen.getByText(/sends no unique reference/)).toBeTruthy();
  });

  test('several reports can be picked at once', () => {
    draw();
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
    });
    draw();
    fireEvent.change(screen.getByLabelText('Acquirer'), { target: { value: 'MBB' } });
    const picker = screen.getByLabelText('Statement files');
    const file = new File(['Txn Date,Gross'], 'aug.csv', { type: 'text/csv' });
    /* jsdom's File carries no .text() — the page reads the file with it. */
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('Txn Date,Gross') });
    fireEvent.change(picker, { target: { files: [file] } });
    await waitFor(() => expect((screen.getByText(/^Upload merchant report/) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText(/^Upload merchant report/));

    await waitFor(() => expect(screen.getByText(/report read/)).toBeTruthy());
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
    expect(screen.getByText('Card payments no merchant report has reported yet (1)')).toBeTruthy();
    expect(screen.getByText('SO-2607-088')).toBeTruthy();
    expect(screen.getByText('A0900')).toBeTruthy();
  });

  /* Only Hong Leong writes its dates without a year. Showing everyone else a
     field they cannot answer is how a screen teaches people to ignore it. */
  test('the statement month is asked only of the acquirer whose file has no year', () => {
    draw();
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
    fireEvent.click(screen.getByLabelText('Show lines already decided'));
    /* The counts are stated ONCE, at the top. */
    expect(screen.getAllByText(/still to decide/)).toHaveLength(1);
    expect(screen.getByText(/1 matched, waiting for you to confirm/)).toBeTruthy();
    expect(screen.getByText(/opens for this report once every line is done/)).toBeTruthy();
    /* The line that needs a person still carries its clue… */
    expect(screen.getByText('No single payment matches; 1 pair(s) of payments add up to this amount')).toBeTruthy();
    /* …and the matched one names its match once, in the words of the work. */
    expect(screen.getByText(/Matched to/)).toBeTruthy();
    /* …and does NOT also repeat that as a grey clue above it. */
    expect(screen.queryByText('Reference 969745 matches SO-2608-043')).toBeNull();
  });

  test('a report opens on the lines still to decide, with its clue and candidates', () => {
    draw();
    fireEvent.click(screen.getByText('Reconcile'));
    /* Two kinds of not-done on this report, and the screen names both: one
       matched by reference (a button) and one that needs a person. */
    expect(screen.getByText('1 matched, waiting for you to confirm · 2 still to decide')).toBeTruthy();
    expect(screen.getByText(/pair\(s\) of payments add up/)).toBeTruthy();
    expect(screen.getByText('SO-2608-001')).toBeTruthy();
    // the list it came from is off the screen
    expect(screen.queryByLabelText('Statement files')).toBeNull();
    // and the counts are still stated, so nothing is hidden
    expect(screen.getByText('1 done · 0 set aside')).toBeTruthy();
    // the finished line is not on screen until he asks for it
    expect(screen.queryByText(/JE-2608-0011/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Show lines already decided'));
    /* It comes back as a TABLE row now, not a card: a line already decided
       asks nothing of anybody, so it is information, and the journal number
       reads inside its status cell. */
    expect(screen.getByText(/done · JE-2608-0011/)).toBeTruthy();
  });

  /* The approval code may be mistyped, so the system falls back to amount+date
     and offers its answer PRE-TICKED — he confirms rather than re-does the
     search (2026-08-18: 尽量根据日期金额去尝试自动匹配后让我知道，我 final
     confirm). Still a suggestion: nothing posts until the button is pressed. */
  test('the system best guess arrives already ticked, ready to confirm', () => {
    draw();
    fireEvent.click(screen.getByText('Reconcile'));
    /* SUGGESTED_ROW carries one payment that makes its amount exactly. */
    expect((screen.getByLabelText('Select SO-2608-050') as HTMLInputElement).checked).toBe(true);
    const confirms = screen.getAllByText('Confirm and post') as HTMLButtonElement[];
    expect(confirms.some((b) => !b.disabled)).toBe(true);
  });

  test('a part-selection cannot be confirmed; the pair that adds up can', () => {
    draw();
    fireEvent.click(screen.getByText('Reconcile'));
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

/* 但是当我upload 很多时我要一个一个按confirm? — no. The reports waiting on the
   work list take ONE press for every line that matched by its approval code,
   and that press must not touch the lines that need a person. */
describe('confirming a pile of reports', () => {
  test('the work list offers one press for every matched line, and says what it leaves alone', () => {
    confirmMatchedMutate.mockClear();
    draw();

    /* The mocked batch: 1 matched by reference, 1 to choose, 1 with no sale. */
    const button = screen.getByText(/Confirm all 1 matched, across 1 report/);
    expect(screen.getByText(/the 2 line\(s\) needing you are left alone/)).toBeTruthy();

    fireEvent.click(button);
    expect(confirmMatchedMutate).toHaveBeenCalledTimes(1);
    expect(confirmMatchedMutate.mock.calls[0]![0]).toBe(1);
  });

  test('it reports what got through, per report, rather than failing the pile', () => {
    confirmMatchedMutate.mockImplementation((_id, opts) => {
      opts.onSuccess({ confirmed: 4, failed: [{ rowId: 9, reason: 'no_account' }] });
    });
    draw();

    fireEvent.click(screen.getByText(/Confirm all 1 matched, across 1 report/));
    expect(screen.getByText(/Posted 4\./)).toBeTruthy();
    expect(screen.getByText(/1 could not be/)).toBeTruthy();
    confirmMatchedMutate.mockReset();
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
    fireEvent.change(screen.getByLabelText('Acquirer'), { target: { value: 'MBB' } });
    const file = new File(['Txn Date,Gross'], 'aug.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('Txn Date,Gross') });
    fireEvent.change(screen.getByLabelText('Statement files'), { target: { files: [file] } });
    await waitFor(() => expect((screen.getByText(/^Upload merchant report/) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText(/^Upload merchant report/));
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

  test('a line that needs choosing keeps its card', () => {
    open();
    /* ROW has candidates and no link: a person has to pick. */
    const card = screen.getByLabelText('Select SO-2608-001').closest('section') as HTMLElement;
    expect(card).toBeTruthy();
    expect(within(card).getByText('Confirm and post')).toBeTruthy();
  });

  /* It used to sit under EVERY line — 27 copies on his Public Bank report. */
  test('the "set aside" explanation is said once', () => {
    open();
    expect(screen.getAllByText(/just moves a line out of the working list/)).toHaveLength(1);
  });
});
