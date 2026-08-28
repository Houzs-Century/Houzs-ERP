// Step two's screen — the money the BANK received. Its own file because it is
// its own screen (owner, 2026-08-17: 就一页对卡机报告，对了没有问题就去对bank
// statement 或daily transaction report).
//
// What is proved here:
//   • a statement waiting for money says how much is still owed, and how far
//     the card-machine side got;
//   • the credits already banked are listed, and one can be taken back off;
//   • a credit is recorded with a date and an amount, blank meaning "the rest";
//   • the paid-not-yet-in-the-bank detail lives here now, with its three states.

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { SettlementBatch } from './settlement-queries';

const OWED: SettlementBatch = {
  id: 1, acquirer_code: 'HLB', file_name: 'hlb-aug.csv',
  period_from: '2026-08-16', period_to: '2026-08-16', row_count: 4,
  gross_sen: 709400, fee_sen: 4755, net_sen: 704645, stated_net_sen: null,
  adjustment_sen: 0, adjustment_je_no: null,
  received_sen: 281858, receipt_count: 1, outstanding_sen: 422787, received_on: null,
  confirmed_count: 4, open_count: 0,
  status: 'OPEN', uploaded_by: null, created_at: '',
};
/* Reconciled by nobody yet — the money can still be recorded, but the screen
   has to say the fees are not in the books. */
const SETTLED: SettlementBatch = {
  ...OWED, id: 2, acquirer_code: 'MBB', file_name: 'mbb-aug.csv',
  net_sen: 227700, received_sen: 227700, outstanding_sen: 0, receipt_count: 1,
  received_on: '2026-08-18', confirmed_count: 1, open_count: 0,
};
/* THE GATE: a report whose lines are not all decided does not belong on this
   screen at all (owner: 核对完了没有问题才会显示去 bank statement 的
   reconciliation). */
const NOT_READY: SettlementBatch = {
  ...OWED, id: 3, acquirer_code: 'AEON', file_name: 'aeon-aug.csv',
  net_sen: 592800, received_sen: 0, outstanding_sen: 592800, receipt_count: 0,
  received_on: null, confirmed_count: 0, open_count: 2,
};

const receivedMutate = vi.fn();
const undoMutate = vi.fn();

vi.mock('./settlement-queries', () => ({
  useSettlementBatches: () => ({ data: { batches: [OWED, SETTLED, NOT_READY] }, isLoading: false }),
  useSettlementBatch: () => ({
    data: {
      batch: {
        ...OWED,
        receipts: [{ id: 9, received_on: '2026-08-18', amount_sen: 281858, bank_ref: null, note: null, je_no: 'JE-2608-0017', created_by: 'Ah Chew' }],
      },
      rows: [{
        id: 7, bucket: 'MATCHED', confirmed_at: '2026-08-17T00:00:00Z',
        txn_date: '2026-08-16', ref: '663554', gross_sen: 180000, fee_sen: 2700, net_sen: 177300,
        linked: [{ settlement_row_id: 7, payment_source: 'SOPAY', payment_id: 'm9', doc_no: 'SO-2608-020', amount_sen: 180000, customer_name: 'Chong Wei Ming' }],
      }],
    },
    isLoading: false,
  }),
  useMarkBatchReceived: () => ({ mutate: receivedMutate, isPending: false, isError: false, error: null }),
  useUndoReceipt: () => ({ mutate: undoMutate, isPending: false }),
  useInTransit: () => ({ data: { from: '2026-02-17', to: '2026-08-17', totalSen: 357900, ageing: { MBB: { '0-7': { count: 1, sen: 230000 } }, GHL: { 'over-30': { count: 1, sen: 29400 } } }, lines: [
    { acquirerCode: 'MBB', source: 'SOPAY', paymentId: 'm1', docNo: 'SO-2608-040', paidOn: '2026-08-14', amountSen: 230000, approvalCode: '861777', recordedBy: 'Siti at the KL till', recordedById: 'u1', ageDays: 3, state: 'MATCHED_NOT_POSTED' },
    { acquirerCode: 'GHL', source: 'SOPAY', paymentId: 'g9', docNo: 'SO-2607-001', paidOn: '2026-07-02', amountSen: 29400, approvalCode: null, recordedBy: null, recordedById: null, ageDays: 46, state: 'NOT_ON_A_STATEMENT' },
    { acquirerCode: 'PBB', source: 'SOPAY', paymentId: 'b3', docNo: 'SO-2608-050', paidOn: '2026-08-12', amountSen: 98500, approvalCode: '114220', recordedBy: null, recordedById: null, ageDays: 5, state: 'RECONCILED_NOT_PAID' },
  ] }, isLoading: false }),
}));

/* Layer 4 owns the first tab now; this file is about the money views, so the
   bank-statement screen is stubbed rather than exercised here. Its own contract
   is BankStatementTab.test.tsx — and the payment-advice tab likewise has its
   own file, PayoutAdviceTab.test.tsx. */
vi.mock('./BankStatementTab', () => ({ BankStatementTab: () => <div>bank statement tab</div> }));
vi.mock('./PayoutAdviceTab', () => ({ PayoutAdviceTab: () => <div>payment advice tab</div> }));

import { BankRecon } from './BankRecon';

/* The page opens on the bank statement now (owner: upload 然后你也自动核对).
   Every test below is about the money views, so each one starts by asking for
   the tab it is testing. */
const draw = () => {
  const r = render(<MemoryRouter><BankRecon /></MemoryRouter>);
  fireEvent.click(screen.getByText('Money to come in'));
  return r;
};

describe('the tab strip', () => {
  /* The advice is where a Public Bank payout starts, so its tab has to be on
     this screen — one press from the statement it will match. */
  test('carries the payment advice beside the bank statement', () => {
    render(<MemoryRouter><BankRecon /></MemoryRouter>);
    fireEvent.click(screen.getByText('Payment advice'));
    expect(screen.getByText('payment advice tab')).toBeTruthy();
  });
});

describe('the statements waiting for money', () => {
  test('lists what is still owed, and hides the settled ones until asked', () => {
    draw();
    /* The headline total and the one owed statement's line — same number, so
       both must be on screen. */
    expect(screen.getAllByText('RM 4,227.87')).toHaveLength(2);
    /* The money columns, once each — what he came here to check (owner:
       我应该是需要核对 net 的数据罢了哦). */
    expect(screen.getByText('Net it should pay')).toBeTruthy();
    expect(screen.getByText('RM 7,046.45')).toBeTruthy();       // the net
    expect(screen.getByText('RM 2,818.58')).toBeTruthy();       // received
    expect(screen.getByText('hlb-aug.csv')).toBeTruthy();
    expect(screen.queryByText('mbb-aug.csv')).toBeNull();

    fireEvent.click(screen.getByLabelText('Show statements already settled'));
    expect(screen.getByText('mbb-aug.csv')).toBeTruthy();
    expect(screen.getByText('all in')).toBeTruthy();
  });

  /* A report that is not reconciled is NOT here — and the screen says so by
     name, so "where did AEON go" is never a question. */
  test('a report that is not reconciled yet is kept off this screen, and named', () => {
    draw();
    expect(screen.queryByText('aeon-aug.csv')).toBeNull();
    expect(screen.getByText(/1 merchant report is not here yet/)).toBeTruthy();
    expect(screen.getByText(/AEON/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Show statements already settled'));
    expect(screen.queryByText('aeon-aug.csv')).toBeNull();
  });

  test('a statement shows its credits, takes another, and can undo one', () => {
    draw();
    /* The button says what pressing it is FOR while money is outstanding. */
    fireEvent.click(screen.getByText('Record the money'));
    expect(screen.getByText(/RM 4,227.87 still to come of RM 7,046.45/)).toBeTruthy();
    expect(screen.getByText('JE-2608-0017')).toBeTruthy();
    expect(screen.getByText('Ah Chew')).toBeTruthy();

    const post = screen.getByText('Money received') as HTMLButtonElement;
    expect(post.disabled).toBe(true);            // no date, nothing to post
    /* Typed the way the operator types it — DateField reads dd/mm/yyyy and
       hands the parent ISO. */
    fireEvent.change(screen.getByLabelText('Money arrived in the bank on'), { target: { value: '19/08/2026' } });
    fireEvent.click(screen.getByText('Money received'));
    /* Amount blank = the rest of it; nobody retypes a number the statement
       already knows. */
    expect(receivedMutate).toHaveBeenCalledWith(
      { batchId: 1, receivedOn: '2026-08-19', amountSen: null },
      expect.anything(),
    );

    fireEvent.change(screen.getByLabelText('Amount of this credit'), { target: { value: '2000.00' } });
    fireEvent.click(screen.getByText('Money received'));
    expect(receivedMutate).toHaveBeenLastCalledWith(
      { batchId: 1, receivedOn: '2026-08-19', amountSen: 200000 },
      expect.anything(),
    );

    fireEvent.click(screen.getByText('Undo'));
    expect(undoMutate).toHaveBeenCalledWith(9);
  });
});

/* The owner's own words: he needs to see that a customer HAS paid while the
   money has not arrived or been reconciled — in DETAIL, not as a balance. */
describe('paid, not yet in the bank', () => {
  test('names the document, the age, who keyed it in and where the money is', () => {
    draw();
    fireEvent.click(screen.getByText('Still with the merchants'));

    expect(screen.getByText('RM 3,579.00')).toBeTruthy();          // sitting with acquirers
    expect(screen.getByText('SO-2608-040')).toBeTruthy();          // named to the document
    expect(screen.getByText('On a statement, waiting to be confirmed')).toBeTruthy();
    expect(screen.getByText('The acquirer has not reported it yet')).toBeTruthy();
    /* Three states, three different jobs: chase the acquirer, finish the
       reconciling, or wait for a payout that is already agreed. */
    expect(screen.getByText('Reconciled — the payout has not arrived')).toBeTruthy();
    expect(screen.getByText('Siti at the KL till')).toBeTruthy();
  });

  test('ages it by acquirer so a stale balance cannot hide', () => {
    draw();
    fireEvent.click(screen.getByText('Still with the merchants'));
    expect(screen.getByText('over 30 days')).toBeTruthy();
    // 46 days on GHL — the number the operator is meant to chase.
    expect(screen.getByText('46')).toBeTruthy();
  });
});

/* 这里 pending bank statement matching 的也显示 detail 哦 (owner, 2026-08-20).
   A file name is not a transaction: what tells him whether RM 4,227.87 is the
   right thing to chase is the sale behind it. */
describe('a statement waiting for money shows what it is waiting FOR', () => {
  test('names the transaction, the reference and the customer, not just the file', () => {
    draw();
    expect(screen.getByText('hlb-aug.csv')).toBeTruthy();
    /* FOLDED AWAY by default — from the card side this is agreed already, and
       what he came for is the net (owner: 从卡机那边 recon 完了，我应该是需要核对
       net 的数据罢了哦). */
    expect(screen.queryByText('663554')).toBeNull();
    expect(screen.queryByText('SO-2608-020')).toBeNull();

    /* And one press away when the net does NOT match and he needs to see what
       the report is made of. */
    fireEvent.click(screen.getByLabelText('Transactions in hlb-aug.csv'));
    const row = screen.getByText('663554').closest('tr') as HTMLElement;
    const cells = [...row.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells).toContain('RM 1,773.00');   // the net the acquirer will pay
    /* The fee and the gross belong to step 1 and are NOT repeated here. */
    expect(cells).not.toContain('RM 27.00');
    expect(cells).not.toContain('RM 1,800.00');
    expect(cells).toContain('SO-2608-020');
    expect(cells).toContain('Chong Wei Ming');
  });
});
