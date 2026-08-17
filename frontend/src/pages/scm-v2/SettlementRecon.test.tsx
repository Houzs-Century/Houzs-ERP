// The settlement screen's render contract. The rules themselves are pinned on
// the server (backend/src/acc/settlement-*.test.ts and tests/settlementRoutes);
// what is proved here is that the screen SAYS them:
//   • an acquirer with no unique reference is called out before an upload;
//   • a statement the server refused shows the server's sentence, verbatim;
//   • the four piles carry their counts and a line shows its clue;
//   • a selection that does not add up cannot be confirmed.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { AcquirerSetup, SettlementRow } from './settlement-queries';

const MBB: AcquirerSetup = {
  code: 'MBB', display_name: 'MBB', statement_format: 'CSV', has_unique_ref: true,
  fee_method: 'stated', date_tolerance_days: 3, column_map: { date: 'Txn Date', gross: 'Gross' },
  transit_account_code: '320-0000', fee_account_code: '930-0000', bank_account_code: '330-0000',
  is_active: true, ready: true, autoMatchable: true,
};
const GHL: AcquirerSetup = { ...MBB, code: 'GHL', display_name: 'GHL', has_unique_ref: false, autoMatchable: false, dates_have_no_year: true };

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

const confirmMutate = vi.fn();
const uploadMutateAsync = vi.fn();
let saveMutate = vi.fn();

vi.mock('./settlement-queries', () => ({
  useAcquirerSetup: () => ({ data: { acquirers: [MBB, GHL] }, isLoading: false }),
  useSaveAcquirerSetup: () => ({ mutate: saveMutate, isPending: false }),
  useSettlementBatches: () => ({ data: { batches: [{ id: 1, acquirer_code: 'MBB', file_name: 'aug.csv', period_from: '2026-08-01', period_to: '2026-08-03', row_count: 2, gross_sen: 177700, fee_sen: 2600, net_sen: 175100, status: 'OPEN', uploaded_by: null, created_at: '' }] }, isLoading: false }),
  useSettlementBatch: () => ({
    data: {
      batch: { id: 1, acquirer_code: 'MBB' },
      acquirer: { code: 'MBB', hasUniqueRef: true, dateToleranceDays: 3 },
      buckets: { MATCHED: 1, NEEDS_CONFIRM: 1, UNMATCHED: 0, IGNORED: 0 },
      rows: [ROW],
    },
    isLoading: false,
  }),
  useUploadStatement: () => ({ mutateAsync: uploadMutateAsync, isPending: false }),
  useConfirmSettlementRow: () => ({ mutate: confirmMutate, isPending: false, isError: false, error: null }),
  useConfirmMatched: () => ({ mutate: vi.fn(), isPending: false, data: null }),
  useIgnoreSettlementRow: () => ({ mutate: vi.fn(), isPending: false }),
  useSettlementWatchlist: () => ({ data: { from: '2026-05-18', to: '2026-08-16', clean: false, recordedNotArrived: [], arrivedNotRecorded: [] }, isLoading: false }),
  useInTransit: () => ({ data: { from: '2026-02-17', to: '2026-08-17', totalSen: 259400, ageing: { MBB: { '0-7': { count: 1, sen: 230000 } }, GHL: { 'over-30': { count: 1, sen: 29400 } } }, lines: [
    { acquirerCode: 'MBB', source: 'SOPAY', paymentId: 'm1', docNo: 'SO-2608-040', paidOn: '2026-08-14', amountSen: 230000, approvalCode: '861777', ageDays: 3, state: 'MATCHED_NOT_POSTED' },
    { acquirerCode: 'GHL', source: 'SOPAY', paymentId: 'g9', docNo: 'SO-2607-001', paidOn: '2026-07-02', amountSen: 29400, approvalCode: null, ageDays: 46, state: 'NOT_ON_A_STATEMENT' },
  ] }, isLoading: false }),
}));

import { SettlementRecon, refusalText } from './SettlementRecon';

const draw = () => render(<MemoryRouter><SettlementRecon /></MemoryRouter>);

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

describe('the reconcile tab', () => {
  test('an acquirer with no unique reference is called out before anything is uploaded', () => {
    draw();
    fireEvent.change(screen.getByLabelText('Acquirer'), { target: { value: 'GHL' } });
    expect(screen.getByText(/sends no unique transaction reference/)).toBeTruthy();
  });

  test('several statements can be picked at once', () => {
    draw();
    expect(screen.getByLabelText('Statement files').hasAttribute('multiple')).toBe(true);
    expect(screen.getByText(/several files at once/)).toBeTruthy();
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

  test('the four piles carry their counts, and a line shows its clue and its candidates', () => {
    draw();
    fireEvent.click(screen.getByText('Open'));
    expect(screen.getByText(/Matched \(1\)/)).toBeTruthy();
    expect(screen.getByText(/Needs confirming \(1\)/)).toBeTruthy();
    expect(screen.getByText(/Not matched \(0\)/)).toBeTruthy();
    expect(screen.getByText(/pair\(s\) of payments add up/)).toBeTruthy();
    expect(screen.getByText('SO-2608-001')).toBeTruthy();
  });

  test('a part-selection cannot be confirmed; the pair that adds up can', () => {
    draw();
    fireEvent.click(screen.getByText('Open'));
    const confirm = screen.getByText('Confirm and post') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Select SO-2608-001'));
    expect(screen.getByText(/Selected RM 600\.00 of RM 1,000\.00/)).toBeTruthy();
    expect((screen.getByText('Confirm and post') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Select SO-2608-002'));
    expect((screen.getByText('Confirm and post') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('Confirm and post'));
    expect(confirmMutate).toHaveBeenCalledWith(expect.objectContaining({
      rowId: 7,
      payments: [
        expect.objectContaining({ id: 'p1', amountSen: 60000 }),
        expect.objectContaining({ id: 'p2', amountSen: 40000 }),
      ],
    }));
  });
});

/* The owner's own words: he needs to see that a customer HAS paid while the
   money has not arrived or been reconciled — in DETAIL, not as a balance. */
describe('paid, not yet in the bank', () => {
  test('names the document, the age and where the money actually is', () => {
    draw();
    fireEvent.click(screen.getByText('Paid, not yet in the bank'));

    expect(screen.getByText('RM 2,594.00')).toBeTruthy();          // the total sitting with acquirers
    expect(screen.getByText('SO-2608-040')).toBeTruthy();          // named to the document
    expect(screen.getByText('On a statement, waiting to be confirmed')).toBeTruthy();
    expect(screen.getByText('The acquirer has not reported it yet')).toBeTruthy();
  });

  test('ages it by acquirer so a stale balance cannot hide', () => {
    draw();
    fireEvent.click(screen.getByText('Paid, not yet in the bank'));
    expect(screen.getByText('over 30 days')).toBeTruthy();
    // 46 days on GHL — the number the operator is meant to chase.
    expect(screen.getByText('46')).toBeTruthy();
  });
});

describe('the setup tab', () => {
  test('names which acquirers are ready, and warns where nothing can auto-confirm', () => {
    draw();
    fireEvent.click(screen.getByText('Acquirer setup'));
    expect(screen.getAllByText('ready').length).toBe(2);
    expect(screen.getByText(/nothing from GHL can be confirmed automatically/)).toBeTruthy();
  });

  /* The headings used to be one raw JSON box. An owner cannot be asked to type
     {"date":"Txn Date",…} — and a typo in it was only discovered at upload. */
  test('each heading is its own labelled field, seeded from the saved layout', () => {
    draw();
    fireEvent.click(screen.getByText('Acquirer setup'));
    expect((screen.getByLabelText('MBB Date heading') as HTMLInputElement).value).toBe('Txn Date');
    expect((screen.getByLabelText('MBB Amount heading') as HTMLInputElement).value).toBe('Gross');
    expect(screen.getByLabelText('MBB Reference heading')).toBeTruthy();
    expect(screen.getByLabelText('MBB Net heading')).toBeTruthy();
  });

  test('a required heading left blank is refused HERE, not at upload time', () => {
    saveMutate = vi.fn();
    draw();
    fireEvent.click(screen.getByText('Acquirer setup'));
    const dateField = screen.getByLabelText('MBB Date heading');
    fireEvent.change(dateField, { target: { value: '' } });
    const card = within(dateField.closest('section') as HTMLElement);
    fireEvent.click(card.getByText('Save'));
    /* MBB carries a unique reference AND states its fee per line, so those
       headings are required too — the message names every one still missing,
       not just the field that was cleared. */
    expect(card.getByText(/Fill in the Date, Fee, Reference headings/)).toBeTruthy();
    expect(saveMutate).not.toHaveBeenCalled();
  });
});
