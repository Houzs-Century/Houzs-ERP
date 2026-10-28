// ----------------------------------------------------------------------------
// settlement-demo-server — the owner's local test rig for layer 3.
//
// DEV ONLY. Nothing in the Worker imports this; it is never deployed.
//
// It runs the REAL settlement handlers, the REAL parser, the REAL matcher and
// the REAL posting engine. The only thing that is not real is the database:
// tables live in memory (the same `fakeSb` the suites use), so the owner can
// upload statements, confirm settlements and watch journal entries appear
// WITHOUT any production credentials and without touching a live book.
//
//   npx tsx scripts/settlement-demo-server.ts          (from backend/)
//
// Reset the world at any time with POST /api/scm/demo/reset.
// ----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { Hono } from 'hono';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { postSoPayment, postSiPayment } from '../src/acc/payments';
import { parseStatement } from '../src/acc/settlement-parse';
import {
  settlementSetup, settlementSetupSave, settlementUpload, settlementBatches,
  settlementBatchDetail, settlementConfirmRow, settlementConfirmMatched,
  settlementIgnoreRow, settlementWatchlist, settlementExport, settlementInTransit,
  settlementBatchReceived, settlementReceiptUndo,
  settlementMaintenance, settlementMaintenanceMerchant, settlementMaintenanceBank,
} from '../src/scm/routes/accounting-settlement';
import {
  bankSetup, bankUpload, bankStatements, bankStatementDetail,
  bankLineReceipt, bankLineMatch, bankLineIgnore, bankLineUndo,
} from '../src/scm/routes/accounting-bank';
import { payoutUpload, payoutList } from '../src/scm/routes/accounting-payouts';

const PORT = Number(process.env.DEMO_PORT ?? 8788);
const CO = 1;

/* ── The seeded world ─────────────────────────────────────────────────────── */

const CHART: Row[] = [
  ['320-0000', 'Card Machine Clearing (EDC)', 'ASSET'],
  ['325-0000', 'Online Payment Clearing', 'ASSET'],
  ['330-0000', 'Bank — Maybank Current', 'ASSET'],
  ['331-0000', 'Bank — Hong Leong Current', 'ASSET'],
  ['335-0000', 'Cash on Hand', 'ASSET'],
  ['300-0000', 'Trade Debtor', 'ASSET'],
  ['930-0000', 'Merchant/Gateway Charges', 'EXPENSE'],
].map(([account_code, account_name, account_type]) => ({
  account_code, account_name, account_type, parent_code: null, is_active: true, company_id: CO,
  /* acc_money (migration 0299) is what Daily Bank counts and what the merchant
     setup screen offers as "which bank does this merchant pay us into". */
  acc_money: account_code.startsWith('33'),
}));

/* The layouts are the OWNER'S REAL FILES, read off the exports he uploaded on
   2026-08-17 — not invented ones. Maybank's terminal statement opens with a
   merchant/summary preamble and puts its headings on line 16; GHL's export is
   one header row of snake_case ids and — contrary to 系统3's assumption — DOES
   carry a unique transaction id (gateway_tx_id). */
const ACQUIRER_CONFIG: Row[] = [
  /* HONG LEONG's terminal statement. One file can hold several MERCHANT blocks,
     each with its own SUMMARY and several TERMINAL sections, and its dates carry
     no year. NOTE: the file the owner first sent as "MBB (1).CSV" is this same
     layout and classifies its sales as HLB CARD / NON-HLB CARDS, so it is a Hong
     Leong statement too — Maybank's own merchant numbers look nothing like
     these (32410011 vs 00005407101). Owner to confirm; MBB's real layout is
     still unseen. */
  {
    code: 'HLB', display_name: 'HLB', statement_format: 'CSV', has_unique_ref: true,
    fee_method: 'stated', date_tolerance_days: 3, is_active: true,
    column_map: { date: 'DATE', ref: 'INVOICE/AUTHO', gross: 'TRXN AMOUNT', fee: 'MDR', net: 'TRXN NET' },
    dates_have_no_year: true,
  },
  /* MAYBANK, from the CSV export the owner found on 2026-08-17. Its detail table
     carries NO fee at all — only the gross and an interchange figure — and the
     MDR appears once, on a TOTAL row under the summary table's own headings. So
     the fee is prorated from a figure READ OUT OF THE FILE rather than typed.
     ONE config reads all four of Maybank's report types (DVS04A credit card,
     DVS04E debit card, T41AX Amex, EP41 instalment) — and their rates differ
     enormously: 1.00% / 0.45% / 1.50% / 4.00%. */
  {
    code: 'MBB', display_name: 'MBB', statement_format: 'CSV', has_unique_ref: true,
    fee_method: 'prorated-summary', date_tolerance_days: 3, is_active: true,
    column_map: { date: 'Tran Date', ref: 'Auth Code', gross: 'Amount' },
    summary_totals: { rowLabel: 'TOTAL', fee: 'Disc. Amt', net: 'Net Amount' },
  },
  /* GHL's export DOES carry a unique id (gateway_tx_id) — but the owner
     confirmed on 2026-08-17 that the code the till captures is NOT that id, so
     there is nothing shared to match on and `has_unique_ref` is FALSE. The
     acquirer is not the obstacle; the till is. Capturing the gateway id at the
     point of sale would make GHL auto-matchable, and that is a sales-module
     change for the owner to decide, not something this module may assume. */
  {
    code: 'GHL', display_name: 'GHL', statement_format: 'CSV', has_unique_ref: false,
    fee_method: 'stated', date_tolerance_days: 3, is_active: true,
    column_map: { date: 'tx_create_date', ref: 'gateway_tx_id', gross: 'tx_amount', fee: 'merchant_mdr_amount', net: 'net_amount' },
  },
  /* The 2990 HOME export — a THIRD layout again: quoted fields, DDMMYYYY dates
     with no separators, and an "MDR" column that holds the RATE (0.85 meaning
     0.85%), not the amount. fee_method is gross-minus-net for exactly that
     reason; configured as `stated` it books RM 3.05 of charges against a real
     cost of RM 95.56. Filed under PBB provisionally — the file itself never
     names its acquirer (MID 3332465732, TID 41089055), so the owner confirms. */
  {
    code: 'PBB', display_name: 'PBB', statement_format: 'CSV', has_unique_ref: true,
    fee_method: 'gross-minus-net', date_tolerance_days: 3, is_active: true,
    column_map: { date: 'Trans_date', ref: 'Approval_code', gross: 'Trans_amt', net: 'Sett_amt' },
  },
  /* AEON instalment financing. Its report is XLSX (the page flattens it to CSV
     before upload) and it carries a STATEMENT-LEVEL subvention fee that belongs
     to no transaction: one sale of 6,000.00 less MDR 72.00 nets 5,928.00 on the
     line, and AEON pays 5,673.84. `total_net_label` makes the parser check the
     lines against what the statement says it is paying, so that 254.16 is
     refused loudly instead of being left stranded in 320-0000 forever. */
  {
    code: 'AEON', display_name: 'AEON', statement_format: 'CSV', has_unique_ref: true,
    fee_method: 'stated', date_tolerance_days: 7, is_active: true,
    column_map: {
      date: 'DATE', ref: 'APP. CODE', gross: 'GROSS AMOUNT (RM)',
      fee: 'MDR AMOUNT (RM)', net: 'NET AMOUNT (RM)',
    },
    total_net_label: 'TOTAL NET PAYMENT (RM) :',
  },
];

const COMPANY_LINKS: Row[] = ACQUIRER_CONFIG.map((a) => ({
  company_id: CO, acquirer_code: a.code,
  transit_account_code: '320-0000', fee_account_code: '930-0000',
  bank_account_code: a.code === 'PBB' || a.code === 'HLB' ? '331-0000' : '330-0000',
  is_active: true,
}));

/* The view migration 0301 creates — config joined to this company's link. */
const acquirerView = (): Row[] => COMPANY_LINKS.map((l) => {
  const g = ACQUIRER_CONFIG.find((a) => a.code === l.acquirer_code)!;
  return {
    company_id: l.company_id, code: g.code, display_name: g.display_name,
    transit_account_code: l.transit_account_code, fee_account_code: l.fee_account_code,
    bank_account_code: l.bank_account_code,
    statement_format: g.statement_format, has_unique_ref: g.has_unique_ref,
    fee_method: g.fee_method, date_tolerance_days: g.date_tolerance_days,
    column_map: g.column_map, total_net_label: g.total_net_label ?? null,
    summary_totals: g.summary_totals ?? null,
    dates_have_no_year: g.dates_have_no_year === true,
    is_active: Boolean(g.is_active && l.is_active),
  };
});

const soPay = (id: string, docNo: string, paidAt: string, sen: number, approval: string | null, provider: string): Row => ({
  id, so_doc_no: docNo, paid_at: paidAt, amount_sen: sen, approval_code: approval,
  method: 'merchant', merchant_provider: provider, company_id: CO,
});

/* ── Layer 4: the bank accounts and how to read their statements ──────────── */

const BANK_ACCOUNTS: Row[] = [
  {
    id: 1, company_id: CO, account_code: '330-0000', bank_code: 'MBB',
    account_no: '0000564418610346', statement_format: 'CSV', delimiter: '|',
    amount_format: 'integer-sen', credit_indicator: 'CR', is_active: true,
    column_map: {
      date: 'EFFECT DATE', description: 'TRX DESCRIPTION', reference: 'TRX REFERENCE',
      amount: 'AMOUNT', indicator: 'AMOUNT IND',
    },
  },
  {
    id: 2, company_id: CO, account_code: '331-0000', bank_code: 'HLB',
    account_no: '23600602788', statement_format: 'CSV', delimiter: null,
    amount_format: 'decimal', credit_indicator: 'CR', is_active: true,
    column_map: {
      date: 'Date', description: 'Description', reference: 'Reference',
      debit: 'Debit', credit: 'Credit', balance: 'Balance',
    },
  },
];

/* The same four rules migration 0305 seeds, written from the real statements.
   Kept in step with the migration by tests/bankRecognitionSeed.test.mjs, which
   reads the SQL rather than this list. */
const BANK_RULES: Row[] = [
  { id: 1, acquirer_code: 'MBB', pattern: 'CARD SALES', match_field: 'both', trading_date_pattern: 'DATED\\s*(\\d{8})', merchant_pattern: 'M/?N\\s*(\\d+)', sort_order: 10, is_active: true },
  { id: 2, acquirer_code: 'PBB', pattern: 'PBB-PBCS', match_field: 'both', trading_date_pattern: null, merchant_pattern: null, sort_order: 20, is_active: true },
  { id: 3, acquirer_code: 'AEON', pattern: 'AEON CREDIT SERVICE', match_field: 'both', trading_date_pattern: null, merchant_pattern: null, sort_order: 30, is_active: true },
  { id: 4, acquirer_code: 'HLB', pattern: 'CA Credit Advice', match_field: 'both', trading_date_pattern: 'MERCHANT\\s+(\\d{8})', merchant_pattern: '(\\d{9,})\\s+MERCHANT', sort_order: 40, is_active: true },
];

const seed = () => ({
  /* The chart is unified (migration 0297: one AutoCount-style chart for every
     company), so company 2 carries the same accounts. Its acquirer links are
     deliberately ABSENT — that is what a company nobody has set up looks like,
     and the maintenance screen has to be usable on it. */
  accounts: [
    ...CHART.map((r) => ({ ...r })),
    ...CHART.map((r) => ({ ...r, company_id: 2 })),
  ],
  acc_account_roles: [] as Row[],
  acc_acquirer_config: ACQUIRER_CONFIG.map((r) => ({ ...r })),
  acc_company_acquirers: COMPANY_LINKS.map((r) => ({ ...r })),
  acc_acquirers: acquirerView(),
  /* Layer 4. The Maybank current account exactly as its real export is shaped
     — pipe delimited, dates 20260801, amounts as zero-padded integer sen, CR/DR
     in a column of its own — so the rig reads the owner's own file. Hong Leong
     is here too, in the ordinary decimal/debit-credit shape, to prove the
     config genuinely carries the difference. */
  acc_bank_statement_config: BANK_ACCOUNTS.map((r) => ({ ...r })),
  acc_bank_recognition_rules: BANK_RULES.map((r) => ({ ...r })),
  acc_bank_statements: [] as Row[],
  acc_bank_statement_lines: [] as Row[],
  acc_bank_statement_matches: [] as Row[],
  acc_settlement_payouts: [] as Row[],
  acc_settlement_payout_batches: [] as Row[],
  acc_settlement_batches: [] as Row[],
  acc_settlement_rows: [] as Row[],
  acc_settlement_matches: [] as Row[],
  acc_settlement_receipts: [] as Row[],
  journal_entries: [] as Row[],
  journal_entry_lines: [] as Row[],
  mfg_sales_order_payments: [
    /* ── HLB: these match demo-statements/HLB-Aug.csv, which is the owner's
       OWN Hong Leong export with the merchant/terminal/card numbers replaced —
       two merchant blocks, three terminals, one file. */
    /* ── MBB: these match demo-statements/MBB-*.csv, the owner's own Maybank
       exports with the merchant/account/card numbers replaced. */
    soPay('m1', 'SO-2608-040', '2026-08-14T14:05:00', 230000, '861777', 'MBB'),
    soPay('m2', 'SO-2608-041', '2026-08-01T16:30:00', 389900, '002825', 'MBB'),
    // Card money nobody has settled — this is watchlist 1.
    soPay('m3', 'SO-2608-042', '2026-08-15T10:40:00', 100000, '536320', 'MBB'),   // T41AX  Amex
    soPay('m4', 'SO-2608-043', '2026-08-15T15:55:00', 258800, '969745', 'MBB'),   // DVS04E debit
    /* ONE SWIPE, TWO ORDERS, ONE APPROVAL CODE — the owner's case (2026-08-20:
       多张 so 那边放的 approval code 都一样，然后加起来金额是对的上卡机报告的).
       The till put the same code on both documents because there was only one
       swipe. Together they are RM 1,250.00, which is what the statement line
       for 771234 says. */
    soPay('m5', 'SO-2608-060', '2026-08-15T11:20:00', 70000, '771234', 'MBB'),
    soPay('m6', 'SO-2608-061', '2026-08-15T11:20:00', 55000, '771234', 'MBB'),
    // Card money nobody has settled — this is watchlist 1.
    soPay('m5', 'SO-2607-088', '2026-07-18T09:30:00', 35000, 'A0900', 'MBB'),
    soPay('h1', 'SO-2608-020', '2026-08-16T11:15:00', 180000, '663554', 'HLB'),
    soPay('h2', 'SO-2608-021', '2026-08-16T13:40:00', 59400, '674234', 'HLB'),
    soPay('h3', 'SO-2608-022', '2026-08-16T15:02:00', 120000, '014723', 'HLB'),
    soPay('h4', 'SO-2608-023', '2026-08-16T17:26:00', 350000, '448433', 'HLB'),
    // ── AEON: matches demo-statements/AEON-Aug.csv (the owner's own export).
    soPay('a1', 'SO-2608-030', '2026-08-14T15:10:00', 600000, 'R73811', 'AEON'),
    // ── GHL: the gateway id IS on the statement, so a till that captured it
    //    auto-matches; the one that did not waits for a human.
    soPay('g1', 'SO-2608-010', '2026-08-01T12:00:00', 80000, '615318040666', 'GHL'),
    soPay('g2', 'SO-2608-011', '2026-08-02T13:30:00', 45000, null, 'GHL'), // no id captured at the till - lands in NEEDS_CONFIRM
  ],
  sales_invoice_payments: [
    {
      id: 'q1', sales_invoice_id: 'INV-2608-777', paid_at: '2026-08-03T09:15:00',
      amount_sen: 120000, approval_code: 'A1004', method: 'installment',
      merchant_provider: 'MBB', company_id: CO,
    },
  ],
  /* postSoPayment reads the SO for the company and the customer name. */
  mfg_sales_orders: [
    ['SO-2608-001', 'Tan Ah Seng'], ['SO-2608-002', 'Siti Rahman'],
    ['SO-2608-003', 'Lim Boon Huat'], ['SO-2608-004', 'Kedai Perabot Jaya'],
    ['SO-2608-005', 'Kedai Perabot Jaya'], ['SO-2607-088', 'Wong Mei Ling'],
    ['SO-2608-010', 'Raj Kumar'], ['SO-2608-011', 'Nurul Aina'],
    ['SO-2608-020', 'Chong Wei Ming'], ['SO-2608-021', 'Faridah Hassan'],
    ['SO-2608-022', 'Kedai Tilam Sejahtera'], ['SO-2608-023', 'Ng Choon Hoe'],
    ['SO-2608-030', 'Ooi Sze Ling'], ['SO-2608-040', 'Chan Wai Keong'],
    ['SO-2608-041', 'Nurhaliza Yusof'], ['SO-2608-042', 'Lim Chee Keong'],
    ['SO-2608-043', 'Sarah Abdullah'], ['SO-2607-088', 'Wong Mei Ling'],
    ['SO-2608-060', 'Tan Mei Fong'], ['SO-2608-061', 'Tan Mei Fong'],
  ].map(([doc_no, customer_name]) => ({ doc_no, customer_name, customer_phone: null, company_id: CO })),
  sales_invoices: [
    { id: 'INV-2608-777', invoice_number: 'INV-2608-777', company_id: CO,
      debtor_code: 'C-0042', debtor_name: 'Syarikat Maju', migrated_no_stock: false },
  ],
});

let tables = seed();

/**
 * Book the card takings the way phase 2A already does in production —
 * Dr settlement-in-transit / Cr AR, through the REAL `acc/payments.ts`.
 *
 * Without this the rig would start with an empty 320-0000 and confirming a
 * settlement would drive it NEGATIVE, which tells the owner the opposite of
 * the truth. With it, in-transit starts at the full card takings and the whole
 * point of the screen becomes visible: every confirmation drains it toward
 * zero, and what is left is money swiped but not yet received.
 */
async function bookTheTakings(): Promise<void> {
  const sb = client();
  for (const p of tables.mfg_sales_order_payments) {
    await postSoPayment(sb, p as never);
  }
  for (const p of tables.sales_invoice_payments) {
    await postSiPayment(sb, p as never);
  }
}

const client = () => fakeSb(
  tables,
  {},
  [
    { table: 'acc_settlement_matches', column: 'payment_id', name: 'acc_settlement_payment_once' },
    { table: 'acc_settlement_batches', column: 'file_hash', name: 'acc_settlement_batch_once' },
    { table: 'acc_bank_statements', column: 'file_hash', name: 'acc_bank_stmt_once' },
    { table: 'acc_bank_statement_matches', column: 'je_no', name: 'acc_bank_je_once' },
    { table: 'acc_settlement_payouts', column: 'file_hash', name: 'acc_settlement_payout_once' },
  ],
  ['acc_settlement_batches', 'acc_settlement_rows', 'acc_settlement_matches', 'acc_settlement_receipts',
    'acc_bank_statements', 'acc_bank_statement_lines', 'acc_bank_statement_matches',
    'acc_settlement_payouts', 'acc_settlement_payout_batches'],
);

/* PATCH /setup writes to the two real tables; the view is derived, so refresh
   it after every write exactly as Postgres would. */
const refreshView = () => {
  tables.acc_acquirers.length = 0;
  for (const l of tables.acc_company_acquirers) {
    const g = tables.acc_acquirer_config.find((a) => a.code === l.acquirer_code);
    if (!g) continue;
    tables.acc_acquirers.push({
      company_id: l.company_id, code: g.code, display_name: g.display_name,
      transit_account_code: l.transit_account_code, fee_account_code: l.fee_account_code,
      bank_account_code: l.bank_account_code,
      statement_format: g.statement_format, has_unique_ref: g.has_unique_ref,
      fee_method: g.fee_method, date_tolerance_days: g.date_tolerance_days,
      column_map: g.column_map, total_net_label: g.total_net_label ?? null,
    summary_totals: g.summary_totals ?? null,
    dates_have_no_year: g.dates_have_no_year === true,
      is_active: Boolean(g.is_active && l.is_active),
    });
  }
};

/* ── The app: the real handlers, on the real paths ────────────────────────── */

const app = new Hono();

app.use('*', async (c, next) => {
  c.header('access-control-allow-origin', '*');
  c.header('access-control-allow-headers', '*');
  c.header('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  c.set('supabase' as never, client() as never);
  c.set('companyId' as never, CO as never);
  c.set('houzsUser' as never, { name: 'Owner (demo)', permissions_set: ['scm.payment_voucher.post'] } as never);
  /* Two companies, so the maintenance screen's company picker is real here —
     the owner maintains both from one screen (2026-08-18). */
  c.set('allowedCompanyIds' as never, [1, 2] as never);
  c.set('companies' as never, [
    { id: 1, code: 'HOUZS', name: 'Houzs Century' },
    { id: 2, code: '2990', name: "2990's Home" },
  ] as never);
  await next();
  refreshView();
});

const R = '/api/scm/accounting/settlement';
app.get(`${R}/setup`, settlementSetup as never);
app.patch(`${R}/setup/:code`, settlementSetupSave as never);
app.get(`${R}/maintenance`, settlementMaintenance as never);
app.patch(`${R}/maintenance/merchant`, settlementMaintenanceMerchant as never);
app.patch(`${R}/maintenance/bank`, settlementMaintenanceBank as never);
app.post(`${R}/batches`, settlementUpload as never);
app.get(`${R}/batches`, settlementBatches as never);
app.get(`${R}/batches/:id`, settlementBatchDetail as never);
app.get(`${R}/batches/:id/export`, settlementExport as never);
app.post(`${R}/batches/:id/confirm-matched`, settlementConfirmMatched as never);
app.post(`${R}/batches/:id/received`, settlementBatchReceived as never);
app.post(`${R}/receipts/:id/undo`, settlementReceiptUndo as never);
app.post(`${R}/rows/:id/confirm`, settlementConfirmRow as never);
app.post(`${R}/rows/:id/ignore`, settlementIgnoreRow as never);
app.get(`${R}/watchlist`, settlementWatchlist as never);
app.get(`${R}/in-transit`, settlementInTransit as never);
/* The acquirer's own payment advice — 几份 excel 对一份 pdf. */
app.post(`${R}/payouts`, payoutUpload as never);
app.get(`${R}/payouts`, payoutList as never);

/* Layer 4 — the bank's own statement, on the same real handlers. */
const B = '/api/scm/accounting/bank';
app.get(`${B}/setup`, bankSetup as never);
app.post(`${B}/statements`, bankUpload as never);
app.get(`${B}/statements`, bankStatements as never);
app.get(`${B}/statements/:id`, bankStatementDetail as never);
app.post(`${B}/lines/:id/receipt`, bankLineReceipt as never);
app.post(`${B}/lines/:id/match`, bankLineMatch as never);
app.post(`${B}/lines/:id/ignore`, bankLineIgnore as never);
app.post(`${B}/lines/:id/undo`, bankLineUndo as never);

/* Demo-only: show what actually reached the ledger, and start over. */
app.get('/api/scm/demo/ledger', (c) => c.json({
  entries: tables.journal_entries.map((je) => ({
    ...je,
    lines: tables.journal_entry_lines
      .filter((l) => String(l.journal_entry_id) === String(je.id))
      .map((l) => ({
        account_code: l.account_code,
        account_name: tables.accounts.find((a) => a.account_code === l.account_code)?.account_name ?? l.account_code,
        debit_sen: l.debit_sen, credit_sen: l.credit_sen, notes: l.notes,
      })),
  })),
  transitBalanceSen: tables.journal_entry_lines
    .filter((l) => l.account_code === '320-0000')
    .reduce((s, l) => s + Number(l.debit_sen ?? 0) - Number(l.credit_sen ?? 0), 0),
  payments: [...tables.mfg_sales_order_payments, ...tables.sales_invoice_payments],
  settledPaymentIds: tables.acc_settlement_matches.map((m) => String(m.payment_id)),
}));

app.post('/api/scm/demo/reset', async (c) => {
  tables = seed();
  await bookTheTakings();
  return c.json({ ok: true });
});

/* POST /api/scm/demo/seed-from-statement — the ERP side of a REAL report.
 *
 * The owner, on his own Public Bank file: 我测试pbb的，但会比较难试是因为pbb太多
 * transaction了. The difficulty was never PBB — it was that the rig's fake ERP
 * holds a dozen invented payments, so all 31 of his real transactions correctly
 * read as "no sale in the ERP" and there is nothing to watch match.
 *
 * So this reads a real merchant report with the REAL parser and writes the
 * payments that should be behind it: one sale per line, its own date, its own
 * amount, its own approval code, booked through the REAL posting engine so
 * settlement-in-transit rises exactly as a fortnight of swiping would.
 *
 * `imperfect` leaves the interesting cases in on purpose, because a file where
 * everything matches proves only the easy path:
 *   · the LAST line gets no payment at all      -> "no sale in the ERP"
 *   · the FIRST line's approval code is mistyped -> falls to amount+date, and
 *     the screen offers it pre-ticked for a human
 * DEV ONLY, like the rest of this file. */
app.post('/api/scm/demo/seed-from-statement', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const acquirerCode = String((body as Record<string, unknown>).acquirerCode ?? '').trim();
  const content = String((body as Record<string, unknown>).content ?? '');
  const imperfect = (body as Record<string, unknown>).imperfect !== false;
  if (!acquirerCode || !content.trim()) return c.json({ error: 'acquirerCode and content are required' }, 400);

  const acq = ACQUIRER_CONFIG.find((a) => a.code === acquirerCode);
  if (!acq) return c.json({ error: `unknown acquirer ${acquirerCode}` }, 400);

  const parsed = parseStatement({
    code: String(acq.code),
    statement_format: (acq.statement_format ?? null) as string | null,
    fee_method: (acq.fee_method ?? null) as string | null,
    column_map: (acq.column_map ?? null) as never,
    statementMonth: String((body as Record<string, unknown>).statementMonth ?? '') || null,
    total_net_label: (acq.total_net_label ?? null) as string | null,
    summary_totals: (acq.summary_totals ?? null) as never,
  }, content);
  if (!parsed.ok) return c.json({ error: 'unreadable_statement', message: parsed.reason }, 400);

  const NAMES = ['Tan Wei Ming', 'Siti Nurhaliza', 'Lim Guan Hoe', 'Priya Raman', 'Chong Ai Ling',
    'Abdul Rahman', 'Ng Poh Choo', 'Kumar Selvam', 'Wong Li Fen', 'Faridah Omar'];
  const stamp = tables.mfg_sales_order_payments.length;
  const made: Array<Record<string, unknown>> = [];

  parsed.rows.forEach((row, i) => {
    const last = i === parsed.rows.length - 1;
    if (imperfect && last) return;                       // -> no sale in the ERP
    const docNo = `SO-DEMO-${String(stamp + i + 1).padStart(4, '0')}`;
    tables.mfg_sales_orders.push({
      doc_no: docNo, customer_name: NAMES[i % NAMES.length], customer_phone: null, company_id: CO,
    });
    const payment: Row = {
      id: `seed-${stamp + i + 1}`,
      so_doc_no: docNo,
      paid_at: `${row.txnDate}T12:00:00`,
      amount_sen: row.grossSen,
      /* The mistyped code: the till captured it wrong, which the owner says he
         cannot rule out (我没办法确定 authorised code salesperson 一定填对). */
      approval_code: imperfect && i === 0 ? `${row.ref ?? '000000'}9` : row.ref,
      method: 'merchant',
      merchant_provider: acquirerCode,
      company_id: CO,
    };
    tables.mfg_sales_order_payments.push(payment);
    made.push(payment);
  });

  const sb = client();
  for (const p of made) await postSoPayment(sb, p as never);

  return c.json({
    ok: true,
    linesInFile: parsed.rows.length,
    paymentsCreated: made.length,
    ...(imperfect
      ? { leftOut: 1, mistypedCode: 1, note: 'one line has no payment, and one payment carries a mistyped code — on purpose' }
      : {}),
  });
});

/* ── node:http bridge (no extra dependency; Hono speaks fetch) ─────────────── */

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    void (async () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(','));
      }
      const method = req.method ?? 'GET';
      const request = new Request(`http://localhost:${PORT}${req.url ?? '/'}`, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
      });
      const response = await app.fetch(request);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((err: unknown) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
}).listen(PORT, () => {
  void bookTheTakings().then(() => {
    const transit = tables.journal_entry_lines
      .filter((l) => l.account_code === '320-0000')
      .reduce((s, l) => s + Number(l.debit_sen ?? 0) - Number(l.credit_sen ?? 0), 0);
    /* eslint-disable-next-line no-console */
    console.log(
      `settlement demo API on http://localhost:${PORT} — in-memory database, no production credentials in play\n` +
      `  card takings booked to settlement-in-transit: RM ${(transit / 100).toFixed(2)} across ${tables.journal_entries.length} entries`,
    );
  });
});
