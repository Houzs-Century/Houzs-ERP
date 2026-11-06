/* What the "Merchant reports still to reconcile" list exports (owner 2026-11-06): the lines
   the screen is showing, in its order, in its words, and money that still adds up when
   one line paid several orders. The screen reads the same helpers, so the two cannot differ. */

import { describe, expect, test } from 'vitest';
import type { SettlementBatch, SettlementRow } from './settlement-queries';
import { LINE_STATUS_WORDS, lineStatus, openReportsOf, ordersOf, reportLinesMatrix } from './merchantReconExport';

const row = (over: Partial<SettlementRow>): SettlementRow => ({
  id: 1, line_no: 17, txn_date: '2026-11-05', ref: 'R41797', gross_sen: 399000, fee_sen: 4788, net_sen: 394212,
  bucket: 'NEEDS_CONFIRM', match_reason: null, confirmed_at: null, posted_je_no: null, notes: null,
  linked: [], candidates: [], comboHints: [], clue: null, ...over,
});
const batch = (over: Partial<SettlementBatch>): SettlementBatch => ({
  id: 7, acquirer_code: 'AEON', file_name: 'a.csv', net_sen: 394212, stated_net_sen: 378364, ...over,
} as SettlementBatch);
const LINKED = {
  settlement_row_id: 1, payment_source: 'SOPAY', payment_id: 'm1', doc_no: 'HC-SO-1', amount_sen: 165000,
  paid_on: '2025-11-18', customer_name: 'Mandy Lim', approval_code: 'HC6301', salesperson: 'Lim Yau Wei', account_sheet: '903549',
};
const SUGGESTED = {
  source: 'SOPAY' as const, id: 's1', docNo: 'HC-SO-2', paidOn: '2025-11-24', amountSen: 30000, approvalCode: 'ZNT5481',
  customerName: 'Angelia', salesperson: 'Anthony', accountSheet: 'tbc',
};

describe('one line, as the screen reads it', () => {
  test('a claimed payment reads the same as a suggested one', () => {
    expect(ordersOf(row({ linked: [LINKED] }))).toEqual([{
      key: 'm1', docNo: 'HC-SO-1', source: 'SOPAY', customer: 'Mandy Lim', sales: 'Lim Yau Wei', sheet: '903549', paidOn: '2025-11-18', code: 'HC6301', amountSen: 165000,
    }]);
    expect(ordersOf(row({ suggested: [SUGGESTED] }))).toEqual([{
      key: 's1', docNo: 'HC-SO-2', source: 'SOPAY', customer: 'Angelia', sales: 'Anthony', sheet: 'tbc', paidOn: '2025-11-24', code: 'ZNT5481', amountSen: 30000,
    }]);
  });

  test('a claimed payment wins over a suggestion, and with no document number shows the payment id and opens nothing', () => {
    expect(ordersOf(row({ linked: [{ ...LINKED, doc_no: null }], suggested: [SUGGESTED] })).map((o) => [o.docNo, o.source])).toEqual([['m1', null]]);
  });

  test('the status words are the screen\'s', () => {
    expect(lineStatus(row({ confirmed_at: '2026-11-05T00:00:00Z', linked: [LINKED] }))).toBe('done');
    expect(lineStatus(row({ linked: [LINKED] }))).toBe('matched');
    expect(lineStatus(row({ suggested: [SUGGESTED] }))).toBe('guess');
    expect(lineStatus(row({ bucket: 'UNMATCHED' }))).toBe('none');
    expect(lineStatus(row({}))).toBe('choose');
    expect(LINE_STATUS_WORDS).toEqual({
      done: 'done', matched: 'matched by reference', guess: 'the system’s guess — check it', none: 'no sale in the ERP', choose: 'you choose',
    });
  });
});

describe('the reports the list is showing', () => {
  test('only the open lines, in the list\'s order, each report at what it really pays', () => {
    const reports = openReportsOf(
      [batch({ id: 7 }), batch({ id: 8, acquirer_code: 'MBB', file_name: 'b.CSV', net_sen: 500, stated_net_sen: null })],
      [
        { rows: [row({ id: 1 }), row({ id: 2, confirmed_at: '2026-11-05T00:00:00Z' }), row({ id: 3, bucket: 'IGNORED' })] },
        { rows: [row({ id: 4, ref: 'B1' })] },
      ],
    );
    expect(reports.map((r) => [r.merchant, r.file, r.netSen, r.lines.length])).toEqual([['AEON', 'a.csv', 378364, 1], ['MBB', 'b.CSV', 500, 1]]);
  });

  test('a report with nothing left open by the time it is read is not printed empty', () => {
    expect(openReportsOf([batch({})], [{ rows: [row({ confirmed_at: '2026-11-05T00:00:00Z' })] }])).toEqual([]);
  });

  test('a line with no order says how many it could be; money read as text still counts as money', () => {
    const [r] = openReportsOf([batch({})], [{
      rows: [
        row({ candidates: [SUGGESTED, SUGGESTED] }),
        row({ bucket: 'UNMATCHED', gross_sen: '1200' as unknown as number, fee_sen: '14' as unknown as number, net_sen: '1186' as unknown as number }),
      ],
    }]);
    expect(r!.lines[0]).toMatchObject({ document: '2 possible', orders: [], status: 'you choose', tone: null });
    expect(r!.lines[1]).toMatchObject({ document: null, grossSen: 1200, feeSen: 14, netSen: 1186, status: 'no sale in the ERP', tone: 'bad' });
  });
});

describe('the Excel', () => {
  const reports = openReportsOf([batch({})], [{
    rows: [
      row({ line_no: 24, ref: '036911', gross_sen: 195000, fee_sen: 2340, net_sen: 192660, linked: [LINKED, { ...LINKED, payment_id: 'm2', doc_no: 'HC-SO-3', amount_sen: 30000 }] }),
      row({ line_no: 31, ref: 'R3', candidates: [SUGGESTED] }),
    ],
  }]);
  const m = reportLinesMatrix(reports);

  test('one flat heading row, the screen\'s columns with the merchant and the report beside them', () => {
    expect(m.header).toEqual(['Merchant', 'Report', 'Date', 'Line', 'Reference', 'Gross', 'Fee', 'Net', 'Document', 'Customer', 'Sales', 'Account sheet', 'Paid on', 'Approval', 'Amount', 'Status']);
    expect(m.formats).toEqual(['text', 'text', 'date', 'number', 'text', 'money', 'money', 'money', 'text', 'text', 'text', 'text', 'date', 'text', 'money', 'text']);
  });

  test('a line paying several orders takes a row each, its own money once, so Gross still adds up', () => {
    expect(m.body[0]).toEqual(['AEON', 'a.csv', '2026-11-05', 24, '036911', 1950, 23.4, 1926.6, 'HC-SO-1', 'Mandy Lim', 'Lim Yau Wei', '903549', '2025-11-18', 'HC6301', 1650, 'matched by reference']);
    expect(m.body[1]).toEqual(['AEON', 'a.csv', '2026-11-05', 24, '036911', null, null, null, 'HC-SO-3', 'Mandy Lim', 'Lim Yau Wei', '903549', '2025-11-18', 'HC6301', 300, 'matched by reference']);
  });

  test('a line with no order still takes its row', () => {
    expect(m.body[2]).toEqual(['AEON', 'a.csv', '2026-11-05', 31, 'R3', 3990, 47.88, 3942.12, '1 possible', null, null, null, null, null, null, 'you choose']);
  });
});
