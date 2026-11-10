// The three heavy reads Merchant Recon and Bank Recon open — one report's
// detail, the watch list, one bank statement — pinned WHOLE, on a fixed set of
// rows, so a change made for speed cannot change a single field of what the
// screen is sent. The snapshot was recorded on the code before the speed-up
// (perf/settlement-batch) and the faster code must reproduce it byte for byte.
//
// The second half pins the reads themselves: the report detail used to page
// through EVERY settlement link the company ever made to learn which payments
// were taken, and the bank statement through every bank match. Both now read
// only the rows that can change the answer.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { settlementBatchDetail, settlementWatchlist } from '../src/scm/routes/accounting-settlement';
import { bankStatementDetail } from '../src/scm/routes/accounting-bank';

const CO = 1;
const OTHER = 2;
const GL_PERM = 'scm.payment_voucher.post';

const CHART: Row[] = ['326-0000', '310-0010', '930-0000', '330-0000', '320-0000'].map((code) => ({
  account_code: code, account_name: `Account ${code}`, account_type: 'ASSET', parent_code: null, is_active: true, company_id: CO,
}));

const MBB: Row = {
  company_id: CO, code: 'MBB', display_name: 'MBB',
  transit_account_code: '326-0000', fee_account_code: '930-0000', bank_account_code: '310-0010',
  statement_format: 'CSV', has_unique_ref: true, fee_method: 'stated',
  date_tolerance_days: 3, is_active: true, so_names: null,
  column_map: { date: 'Txn Date', ref: 'Approval Code', gross: 'Gross', fee: 'MDR' },
};
const GHL: Row = { ...MBB, code: 'GHL', display_name: 'GHL', has_unique_ref: false, bank_account_code: null };

const so = (id: string, doc: string, paidAt: string, sen: number, over: Row = {}): Row => ({
  id, so_doc_no: doc, paid_at: paidAt, amount_sen: sen, approval_code: null, method: 'merchant',
  merchant_provider: 'MBB', collected_by: 'u1', created_by: 'u1', account_sheet: null, company_id: CO, ...over,
});

/* A thousand-odd links the company made long ago, to payments far outside the
   report's window — what the old read paged through on every open. */
const OLD_LINKS: Row[] = Array.from({ length: 1205 }, (_, i) => ({
  id: 10_000 + i, company_id: CO, settlement_row_id: 50_000 + i, payment_source: 'SOPAY', payment_id: `old-${i}`, doc_no: null, amount_sen: 100,
}));

function settlementRig(oldLinks: Row[] = OLD_LINKS) {
  const sb = fakeSb(
    {
      accounts: CHART, acc_account_roles: [],
      acc_acquirers: [MBB, GHL],
      acc_settlement_batches: [{
        id: 7, company_id: CO, acquirer_code: 'MBB', file_name: 'mbb-aug.csv', period_from: '2026-08-01', period_to: '2026-08-03',
        row_count: 5, gross_sen: 267700, fee_sen: 4000, net_sen: 263700, stated_net_sen: null, adjustment_sen: 0,
        adjustment_je_no: null, status: 'OPEN', created_at: '2026-08-04T01:00:00Z',
      }],
      acc_settlement_rows: [
        { id: 71, batch_id: 7, company_id: CO, acquirer_code: 'MBB', line_no: 1, txn_date: '2026-08-01', ref: 'A1', gross_sen: 100000, fee_sen: 1500, net_sen: 98500, bucket: 'MATCHED', match_reason: 'ref', confirmed_at: null, posted_je_no: null, notes: 'Matched by approval code A1', matched_with_row_id: null, not_this: null, channel: null },
        { id: 72, batch_id: 7, company_id: CO, acquirer_code: 'MBB', line_no: 2, txn_date: '2026-08-02', ref: 'ZZ9', gross_sen: 50000, fee_sen: 750, net_sen: 49250, bucket: 'NEEDS_CONFIRM', match_reason: null, confirmed_at: null, posted_je_no: null, notes: null, matched_with_row_id: null, not_this: ['SOPAY:p5'], channel: null },
        { id: 73, batch_id: 7, company_id: CO, acquirer_code: 'MBB', line_no: 3, txn_date: '2026-08-02', ref: 'Q7', gross_sen: 77700, fee_sen: 1150, net_sen: 76550, bucket: 'UNMATCHED', match_reason: null, confirmed_at: null, posted_je_no: null, notes: 'No payment recorded near 2026-08-02', matched_with_row_id: null, not_this: null, channel: null },
        { id: 74, batch_id: 7, company_id: CO, acquirer_code: 'MBB', line_no: 4, txn_date: '2026-08-03', ref: 'B2', gross_sen: 20000, fee_sen: 300, net_sen: 19700, bucket: 'MATCHED', match_reason: 'ref', confirmed_at: '2026-08-05T02:00:00Z', posted_je_no: 'JE-2608-0001', notes: null, matched_with_row_id: null, not_this: null, channel: null },
        { id: 75, batch_id: 7, company_id: CO, acquirer_code: 'MBB', line_no: 5, txn_date: '2026-08-03', ref: 'C3', gross_sen: 20000, fee_sen: 300, net_sen: 19700, bucket: 'IGNORED', match_reason: null, confirmed_at: null, posted_je_no: null, notes: 'test swipe', matched_with_row_id: null, not_this: null, channel: null },
      ],
      acc_settlement_matches: [
        /* Line 1's link, stored at an amount Finance has since corrected — opening the report reads it back. */
        { id: 1, company_id: CO, settlement_row_id: 71, payment_source: 'SOPAY', payment_id: 'p1', doc_no: 'SO-2608-001', amount_sen: 99000 },
        { id: 2, company_id: CO, settlement_row_id: 74, payment_source: 'SOPAY', payment_id: 'p4', doc_no: 'SO-2608-004', amount_sen: 20000 },
        /* p3 is another report's — never a candidate here. */
        { id: 3, company_id: CO, settlement_row_id: 999, payment_source: 'SOPAY', payment_id: 'p3', doc_no: 'SO-2608-003', amount_sen: 50000 },
        /* p2 is claimed in ANOTHER company: not this company's claim, so still offered. */
        { id: 4, company_id: OTHER, settlement_row_id: 888, payment_source: 'SOPAY', payment_id: 'p2', doc_no: 'X', amount_sen: 50000 },
        ...oldLinks,
      ],
      acc_settlement_receipts: [
        { id: 1, company_id: CO, batch_id: 7, received_on: '2026-08-06', amount_sen: 50000, bank_ref: 'IBG1', note: null, je_no: 'JE-2608-0009', created_by: 'Tester', created_at: '2026-08-06T03:00:00Z', charge_sen: 0, charge_account_code: null, charge_note: null, charge_je_no: null },
      ],
      acc_settlement_payout_batches: [],
      mfg_sales_order_payments: [
        so('p1', 'SO-2608-001', '2026-08-01T10:00:00', 100000, { approval_code: 'A1' }),
        so('p2', 'SO-2608-002', '2026-08-02T11:00:00', 50000),
        so('p3', 'SO-2608-003', '2026-08-01T12:00:00', 50000),
        so('p4', 'SO-2608-004', '2026-08-03T09:00:00', 20000, { approval_code: 'B2' }),
        so('p5', 'SO-2608-005', '2026-08-02T15:00:00', 50000),
        /* Keyed a week late, but carrying line 3's reference: found by it. */
        so('p6', 'SO-2608-006', '2026-08-12T15:00:00', 77000, { approval_code: 'Q7' }),
        /* Cancelled order: its money is nobody's candidate. */
        so('p7', 'SO-2608-007', '2026-08-02T16:00:00', 50000),
        /* Another company's payment, same window, same amount. */
        so('p8', 'SO-2608-008', '2026-08-02T16:00:00', 50000, { company_id: OTHER }),
      ],
      sales_invoice_payments: [
        { id: 's1', sales_invoice_id: 'si-1', paid_at: '2026-08-03T10:00:00', amount_sen: 50000, approval_code: null, method: 'merchant', merchant_provider: null, collected_by: null, created_by: 'u2', account_sheet: 'Sheet 2', company_id: CO },
      ],
      mfg_sales_orders: [
        { doc_no: 'SO-2608-001', debtor_name: 'Ali', status: 'CONFIRMED', salesperson_id: 'st1', ref: 'HC1', customer_so_no: null, company_id: CO },
        { doc_no: 'SO-2608-002', debtor_name: 'Bee', status: 'CONFIRMED', salesperson_id: 'st2', ref: null, customer_so_no: 'C-2', company_id: CO },
        { doc_no: 'SO-2608-005', debtor_name: 'Eve', status: 'CONFIRMED', salesperson_id: null, ref: null, customer_so_no: null, company_id: CO },
        { doc_no: 'SO-2608-006', debtor_name: 'Fay', status: 'CONFIRMED', salesperson_id: 'st1', ref: null, customer_so_no: null, company_id: CO },
        { doc_no: 'SO-2608-007', debtor_name: 'Gus', status: 'CANCELLED', salesperson_id: null, ref: null, customer_so_no: null, company_id: CO },
      ],
      staff: [{ id: 'st1', name: 'Sam' }, { id: 'st2', name: 'Tia' }],
      sales_invoices: [{ id: 'si-1', invoice_number: 'IV-2608-001', debtor_name: 'Cat', company_id: CO }],
      journal_entries: [], journal_entry_lines: [],
    },
    {}, [], ['acc_settlement_batches', 'acc_settlement_rows', 'acc_settlement_matches', 'acc_settlement_receipts'],
  );
  /* Every table the handlers open, in order — what the read-narrowing tests count. */
  const opened: string[] = [];
  const realFrom = sb.from;
  sb.from = (t: string) => { opened.push(t); return realFrom(t); };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: [GL_PERM] } as never);
    c.set('allowedCompanyIds' as never, [CO, OTHER] as never);
    await next();
  });
  app.get('/settlement/batches/:id', settlementBatchDetail as never);
  app.get('/settlement/watchlist', settlementWatchlist as never);
  return { app, sb, opened };
}

describe('GET /settlement/batches/:id — the response is pinned whole', () => {
  test('the four piles, their candidates, links, receipts and bank read exactly as before', async () => {
    const { app, sb } = settlementRig();
    const res = await app.request('/settlement/batches/7');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchSnapshot();
    /* The read-back of a corrected payment still writes the link (docs/bugs/0833). */
    expect(sb.tables.acc_settlement_matches!.find((m) => m.payment_id === 'p1')).toMatchObject({ amount_sen: 100000 });
  });

  test('another company\'s report is not found, and its lines are never read', async () => {
    const { app, sb } = settlementRig();
    sb.tables.acc_settlement_batches![0]!.company_id = OTHER;
    const res = await app.request('/settlement/batches/7');
    expect(res.status).toBe(404);
  });

  test('which payments are taken is asked of the window\'s payments, not of every link the company ever made', async () => {
    /* The same report, with and without a thousand-odd old links elsewhere in
       the company: the work done must not grow with the company's history. The
       old read paged the whole table, one page more per thousand links. */
    const matchReads = async (oldLinks: Row[]) => {
      const { app, opened } = settlementRig(oldLinks);
      expect((await app.request('/settlement/batches/7')).status).toBe(200);
      return opened.filter((t) => t === 'acc_settlement_matches').length;
    };
    expect(await matchReads(OLD_LINKS)).toBe(await matchReads([]));
  });
});

describe('GET /settlement/watchlist — the response is pinned whole', () => {
  test('both lists, the untagged payment once, the salesperson and the order ref', async () => {
    const { app } = settlementRig();
    const res = await app.request('/settlement/watchlist?from=2026-07-25&to=2026-08-31');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchSnapshot();
  });

  test('one merchant asked for: only its own list', async () => {
    const { app } = settlementRig();
    const res = await app.request('/settlement/watchlist?from=2026-07-25&to=2026-08-31&acquirer=GHL');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchSnapshot();
  });
});

/* ── Bank statement detail ─────────────────────────────────────────────── */

const BANK_ACCOUNT: Row = {
  id: 1, company_id: CO, account_code: '330-0000', bank_code: 'MBB',
  account_no: '0000564418610346', statement_format: 'CSV', delimiter: '|',
  amount_format: 'integer-sen', credit_indicator: 'CR', is_active: true, column_map: {},
};

function bankRig() {
  const lines: Row[] = [
    { id: 1, statement_id: 1, company_id: CO, line_no: 1, booked_on: '2026-08-03', description: 'CR/CARD SALES MN 32410011 DATED 31072026', reference: '00113107', amount_sen: 728448, state: 'POSTED', posted_je_no: 'JE-2608-0100', kind: 'PAYOUT', acquirer_code: 'MBB' },
    { id: 2, statement_id: 1, company_id: CO, line_no: 2, booked_on: '2026-08-03', description: 'LAU LEE YEN', reference: 'Jaslyn', amount_sen: 171000, state: 'POSTED', posted_je_no: null, kind: 'OTHER', acquirer_code: null },
    { id: 3, statement_id: 1, company_id: CO, line_no: 3, booked_on: '2026-08-12', description: 'SERVICE CHARGE', reference: 'BCHARGE1', amount_sen: -2500, state: 'OPEN', posted_je_no: null, kind: 'OTHER', acquirer_code: null },
    /* Another statement of the same account. */
    { id: 4, statement_id: 2, company_id: CO, line_no: 1, booked_on: '2026-09-01', description: 'TRANSFER', reference: 'X', amount_sen: 5000, state: 'POSTED', posted_je_no: null, kind: 'OTHER', acquirer_code: null },
  ];
  /* A thousand-odd matches of other statements — what the old read paged through. */
  const foreign: Row[] = Array.from({ length: 1103 }, (_, i) => ({
    id: 100 + i, company_id: CO, bank_line_id: 9000 + i, je_no: `JE-OLD-${i}`, amount_sen: 1, match_reason: 'manual',
  }));
  const sb = fakeSb(
    {
      accounts: CHART, acc_account_roles: [],
      acc_acquirers: [{ ...MBB, bank_account_code: '330-0000', transit_account_code: '320-0000' }],
      acc_bank_statement_config: [BANK_ACCOUNT],
      acc_bank_recognition_rules: [],
      acc_bank_statements: [
        { id: 1, company_id: CO, account_code: '330-0000', file_name: 'aug.csv', period_from: '2026-08-01', period_to: '2026-08-31', opening_balance_sen: 100000, closing_balance_sen: 996948, file_hash: 'h1' },
        { id: 2, company_id: CO, account_code: '330-0000', file_name: 'sep.csv', period_from: '2026-09-01', period_to: '2026-09-30', opening_balance_sen: null, closing_balance_sen: null, file_hash: 'h2' },
      ],
      acc_bank_statement_lines: lines,
      acc_bank_statement_matches: [
        { id: 1, company_id: CO, bank_line_id: 2, je_no: 'JE-2608-0200', amount_sen: 171000, match_reason: 'manual' },
        { id: 2, company_id: CO, bank_line_id: 4, je_no: 'JE-2609-0001', amount_sen: 5000, match_reason: 'manual' },
        /* The same line id in another company: never this statement's. */
        { id: 3, company_id: OTHER, bank_line_id: 2, je_no: 'JE-OTHER', amount_sen: 171000, match_reason: 'manual' },
        ...foreign,
      ],
      acc_bank_month_balances: [],
      acc_settlement_batches: [], acc_settlement_rows: [], acc_settlement_matches: [], acc_settlement_receipts: [],
      acc_settlement_payouts: [], acc_settlement_payout_batches: [],
      journal_entries: [], journal_entry_lines: [],
      v_gl_entries: [
        { company_id: CO, account_code: '330-0000', je_no: 'JE-2607-0001', entry_date: '2026-07-31', source_type: 'JV', source_doc_no: 'OB', debit_sen: 100000, credit_sen: 0, notes: null },
        { company_id: CO, account_code: '330-0000', je_no: 'JE-2608-0100', entry_date: '2026-08-03', source_type: 'SETTLEBANK', source_doc_no: 'S1', debit_sen: 728448, credit_sen: 0, notes: null },
        { company_id: CO, account_code: '330-0000', je_no: 'JE-2608-0200', entry_date: '2026-08-03', source_type: 'OR', source_doc_no: 'OR-1', debit_sen: 171000, credit_sen: 0, party_name: 'LAU LEE YEN', notes: null },
        { company_id: CO, account_code: '330-0000', je_no: 'JE-2608-0300', entry_date: '2026-08-12', source_type: 'PV', source_doc_no: 'PV-1', debit_sen: 0, credit_sen: 2500, party_name: 'MAYBANK', notes: null },
      ],
    },
    {}, [], ['acc_bank_statements', 'acc_bank_statement_lines', 'acc_bank_statement_matches', 'acc_bank_month_balances'],
  );
  const opened: string[] = [];
  const realFrom = sb.from;
  sb.from = (t: string) => { opened.push(t); return realFrom(t); };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: [GL_PERM] } as never);
    c.set('allowedCompanyIds' as never, [CO, OTHER] as never);
    await next();
  });
  app.get('/bank/statements/:id', bankStatementDetail as never);
  return { app, opened };
}

describe('GET /bank/statements/:id — the response is pinned whole', () => {
  test('the lines, their matches, the reconciliation and the candidates read exactly as before', async () => {
    const { app } = bankRig();
    const res = await app.request('/bank/statements/1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchSnapshot();
  });

  test('the matches are read for THIS statement\'s lines, not every match the company holds', async () => {
    const { app, opened } = bankRig();
    expect((await app.request('/bank/statements/1')).status).toBe(200);
    /* Old: the whole table, 1,106 rows = two pages and growing. */
    expect(opened.filter((t) => t === 'acc_bank_statement_matches').length).toBeLessThanOrEqual(1);
  });
});
