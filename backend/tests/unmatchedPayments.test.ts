// Every card and transfer payment not matched yet, on one list (owner
// 2026-09-30: 我有没有一个表是显示全部还没 match 的 → 做).
//
// Pinned here:
//   • "matched" is what the two reconciliation screens mean by it — a card
//     payment once a CONFIRMED merchant line claims it, a transfer once a
//     POSTED bank line claims its live entry (a match row or the line's own
//     posted_je_no); a link alone, or a match on an OPEN line, is not;
//   • where each unmatched one is stuck, in the words the screen needs;
//   • cash, AutoCount carry-overs, cancelled orders and the other company's
//     payments are not on it;
//   • the door answers 403 without the reconciliation key.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { classifyUnmatched, type MatchFacts, type PaymentFact } from '../src/acc/unmatched-payments';
import { unmatchedPaymentsHandler } from '../src/scm/routes/accounting-unmatched-payments';

const CO = 2;
const GL_PERM = 'scm.payment_voucher.post';

/* ── The decision, without a database ─────────────────────────────────────── */

const fact = (over: Partial<PaymentFact> = {}): PaymentFact => ({
  source: 'SOPAY', id: 'p1', docNo: 'SO-1', customerName: 'Kim', salespersonName: null,
  paidOn: '2026-09-20', method: 'merchant', merchantProvider: 'GHL', onlineType: null,
  amountSen: 166800, approvalCode: '805996', ...over,
});
const facts = (over: Partial<MatchFacts> = {}): MatchFacts => ({
  cardClaims: new Map(), activeMerchants: new Set(['GHL', 'PBB', 'MBB', 'HLB']),
  entries: new Map(), onTheBank: new Set(), statementUpTo: new Map(), ...over,
});

describe('classifyUnmatched', () => {
  test('a card payment is matched only once a CONFIRMED line claims it', () => {
    const rows = classifyUnmatched([
      fact({ id: 'done' }),
      fact({ id: 'linked' }),
      fact({ id: 'waiting' }),
    ], facts({ cardClaims: new Map([['SOPAY:done', { confirmed: true }], ['SOPAY:linked', { confirmed: false }]]) }), '2026-09-30');
    expect(rows.map((r) => [r.paymentId, r.state])).toEqual([
      ['linked', 'CARD_TO_CONFIRM'],
      ['waiting', 'CARD_NOT_REPORTED'],
    ]);
  });

  test('a bank no active merchant carries can never be reported; an untagged one still can', () => {
    const rows = classifyUnmatched([
      fact({ id: 'cimb', merchantProvider: 'CIMB' }),
      fact({ id: 'untagged', merchantProvider: '  ' }),
      /* A line already claims it: that decides, whatever the tag says now. */
      fact({ id: 'claimed-cimb', merchantProvider: 'CIMB' }),
    ], facts({ cardClaims: new Map([['SOPAY:claimed-cimb', { confirmed: false }]]) }), '2026-09-30');
    const byId = Object.fromEntries(rows.map((r) => [r.paymentId, r]));
    expect(byId.cimb).toMatchObject({ state: 'CARD_NO_MERCHANT', channel: 'CIMB', kind: 'card' });
    expect(byId.untagged).toMatchObject({ state: 'CARD_NOT_REPORTED', channel: null });
    expect(byId['claimed-cimb']).toMatchObject({ state: 'CARD_TO_CONFIRM' });
  });

  test('a transfer: not booked, not matched, or its statement not uploaded yet', () => {
    const t = (id: string, paidOn: string) => fact({ id, paidOn, method: 'transfer', merchantProvider: null, onlineType: 'TNG', approvalCode: 'REF' });
    const rows = classifyUnmatched([
      t('unbooked', '2026-09-10'),
      t('on-bank', '2026-09-10'),
      t('same-day', '2026-09-28'),
      t('after', '2026-09-29'),
      t('no-account', '2026-09-12'),
    ], facts({
      entries: new Map([
        ['SOPAY:on-bank', { jeNo: 'JE-1', accountCode: '310-0020' }],
        ['SOPAY:same-day', { jeNo: 'JE-2', accountCode: '310-0020' }],
        ['SOPAY:after', { jeNo: 'JE-3', accountCode: '310-0020' }],
        ['SOPAY:no-account', { jeNo: 'JE-4', accountCode: null }],
      ]),
      onTheBank: new Set(['JE-1']),
      statementUpTo: new Map([['310-0020', '2026-09-28']]),
    }), '2026-09-30');
    const byId = Object.fromEntries(rows.map((r) => [r.paymentId, r]));
    expect(Object.keys(byId).sort()).toEqual(['after', 'no-account', 'same-day', 'unbooked']);
    expect(byId.unbooked).toMatchObject({ state: 'TRANSFER_NOT_BOOKED', kind: 'transfer', channel: 'TNG', bankAccountCode: null });
    /* The statement reaches the payment's own day: it is there to match. */
    expect(byId['same-day']).toMatchObject({ state: 'TRANSFER_NOT_MATCHED', bankAccountCode: '310-0020', statementUpTo: '2026-09-28' });
    expect(byId.after).toMatchObject({ state: 'TRANSFER_NO_STATEMENT', statementUpTo: '2026-09-28' });
    expect(byId['no-account']).toMatchObject({ state: 'TRANSFER_NO_STATEMENT', statementUpTo: null });
    /* Its entry's number, so the screen can name the bank line offering that entry (owner 2026-11-10). */
    expect(byId['same-day']).toMatchObject({ jeNo: 'JE-2' });
    expect(byId.unbooked).toMatchObject({ jeNo: null });
  });

  /* Owner 2026-11-10, later the same day (所以这里的unmatch payment，已经match 了就不要出现 /
     会不会duplicate → 做): a card payment is matched once its merchant line is confirmed.
     What is left after that — the report's other lines, its payout — is on Merchant report
     lines and Bank money in, each once; listing the payment as well said it twice. */
  test('a card payment the merchant matched is matched: not listed, whatever its report\'s bank side', () => {
    const report = (n: number, waitingLines: number) => ({ fileName: `mbb-${n}.csv`, acquirerCode: 'MBB', waitingLines });
    const rows = classifyUnmatched([
      fact({ id: 'held' }),
      fact({ id: 'no-credit' }),
      fact({ id: 'to-confirm' }),
    ], facts({
      cardClaims: new Map([
        ['SOPAY:held', { confirmed: true, batchId: 2 }],
        ['SOPAY:no-credit', { confirmed: true, batchId: 3 }],
        ['SOPAY:to-confirm', { confirmed: false, batchId: 2 }],
      ]),
      reports: new Map([[2, report(2, 3)], [3, report(3, 0)]]),
    }), '2026-09-30');
    expect(rows.map((r) => r.paymentId)).toEqual(['to-confirm']);
    /* The line still waiting for you names its report, so the screen can open it. */
    expect(rows[0]).toMatchObject({ state: 'CARD_TO_CONFIRM', report: { batchId: 2, fileName: 'mbb-2.csv', acquirerCode: 'MBB', waitingLines: 3 } });
    expect(rows[0]).toMatchObject({ jeNo: null });
  });

  test('a payment no line claims names no report', () => {
    const [only] = classifyUnmatched([fact({ id: 'waiting' })], facts(), '2026-09-30');
    expect(only).toMatchObject({ state: 'CARD_NOT_REPORTED', report: null });
  });

  test('cash and zero rows are not listed; the oldest comes first, aged to today', () => {
    const rows = classifyUnmatched([
      fact({ id: 'cash', method: 'cash' }),
      fact({ id: 'zero', amountSen: 0 }),
      fact({ id: 'new', paidOn: '2026-09-28', docNo: 'SO-2' }),
      fact({ id: 'old', paidOn: '2026-08-31', docNo: 'SO-9' }),
    ], facts(), '2026-09-30');
    expect(rows.map((r) => [r.paymentId, r.ageDays])).toEqual([['old', 30], ['new', 2]]);
  });
});

/* ── The door, over a fake database ───────────────────────────────────────── */

const pay = (over: Row): Row => ({
  company_id: CO, paid_at: '2026-09-10', amount_sen: 100000, approval_code: null,
  method: 'transfer', merchant_provider: null, online_type: 'Bank Transfer', so_doc_no: 'SO-A', ...over,
});
const je = (id: string, jeNo: string, paymentId: string, over: Row = {}): Row => ({
  id, company_id: CO, je_no: jeNo, source_type: 'SOPAY', source_doc_no: paymentId, posted: true, reversed: false, ...over,
});

function harness(perms: readonly string[] = [GL_PERM]) {
  const sb = fakeSb({
    mfg_sales_order_payments: [
      pay({ id: 'p-card-done', method: 'merchant', merchant_provider: 'GHL', amount_sen: 166800, paid_at: '2026-09-01' }),
      pay({ id: 'p-card-confirm', method: 'merchant', merchant_provider: 'PBB', amount_sen: 324000, paid_at: '2026-09-02', approval_code: 'R18656', collected_by: 'st-2' }),
      pay({ id: 'p-card-waiting', method: 'installment', merchant_provider: 'MBB', amount_sen: 269000, paid_at: '2026-09-03', so_doc_no: 'SO-B' }),
      pay({ id: 'p-card-cimb', method: 'merchant', merchant_provider: 'CIMB', amount_sen: 50000, paid_at: '2026-09-05' }),
      /* Merchant matched (a CONFIRMED line), the money not yet in the bank — three ways. */
      pay({ id: 'p-card-held', method: 'merchant', merchant_provider: 'MBB', amount_sen: 100000, paid_at: '2026-09-04' }),
      pay({ id: 'p-card-no-credit', method: 'merchant', merchant_provider: 'MBB', amount_sen: 100000, paid_at: '2026-09-05' }),
      pay({ id: 'p-card-part', method: 'merchant', merchant_provider: 'MBB', amount_sen: 100000, paid_at: '2026-09-06' }),
      /* Paid in full once the charge PBB kept, booked on its advice day, is counted (owner 2026-11-10). */
      pay({ id: 'p-card-kept', method: 'merchant', merchant_provider: 'PBB', amount_sen: 336500, paid_at: '2026-09-06' }),
      pay({ id: 'p-tr-matched', amount_sen: 162000 }),
      pay({ id: 'p-tr-named', amount_sen: 598000, paid_at: '2026-09-20' }),
      pay({ id: 'p-tr-open-line', amount_sen: 143300, paid_at: '2026-09-20', approval_code: '260920CE0DB5C26' }),
      pay({ id: 'p-tr-late', amount_sen: 150000, paid_at: '2026-09-29', online_type: 'TNG' }),
      pay({ id: 'p-tr-unbooked', amount_sen: 70000, paid_at: '2026-09-15' }),
      pay({ id: 'p-tr-reversed', amount_sen: 80000, paid_at: '2026-09-16' }),
      pay({ id: 'p-cash', method: 'cash', amount_sen: 50000 }),
      pay({ id: 'p-imported', method: 'imported', amount_sen: 50000 }),
      pay({ id: 'p-cancelled', so_doc_no: 'SO-X', amount_sen: 50000 }),
      pay({ id: 'p-outside', paid_at: '2026-08-15' }),
      pay({ id: 'p-other-company', company_id: 1 }),
    ],
    sales_invoice_payments: [
      { id: 'si-pay-1', company_id: CO, sales_invoice_id: 'inv-1', paid_at: '2026-09-12', amount_sen: 200000, method: 'transfer', merchant_provider: null, online_type: 'Bank Transfer', approval_code: null, collected_by: 'st-1' },
    ],
    mfg_sales_orders: [
      { company_id: CO, doc_no: 'SO-A', debtor_name: 'Chong Hui Wen', status: 'CONFIRMED', salesperson_id: 'st-1' },
      { company_id: CO, doc_no: 'SO-B', debtor_name: 'Poon How kei', status: 'CONFIRMED', salesperson_id: null },
      { company_id: CO, doc_no: 'SO-X', debtor_name: 'Gone', status: 'CANCELLED', salesperson_id: null },
    ],
    sales_invoices: [{ id: 'inv-1', company_id: CO, invoice_number: 'SI-2609-001', debtor_name: 'Acme' }],
    staff: [{ id: 'st-1', name: 'Nico' }, { id: 'st-2', name: 'Esther' }],
    acc_acquirers: [
      { company_id: CO, display_name: 'GHL', is_active: true },
      { company_id: CO, display_name: 'PBB', is_active: true },
      { company_id: CO, display_name: 'MBB', is_active: true },
      { company_id: CO, display_name: 'CIMB', is_active: false },
    ],
    acc_settlement_matches: [
      { company_id: CO, payment_source: 'SOPAY', payment_id: 'p-card-done', settlement_row_id: 1 },
      { company_id: CO, payment_source: 'SOPAY', payment_id: 'p-card-confirm', settlement_row_id: 2 },
      { company_id: CO, payment_source: 'SOPAY', payment_id: 'p-card-held', settlement_row_id: 3 },
      { company_id: CO, payment_source: 'SOPAY', payment_id: 'p-card-no-credit', settlement_row_id: 6 },
      { company_id: CO, payment_source: 'SOPAY', payment_id: 'p-card-part', settlement_row_id: 7 },
      { company_id: CO, payment_source: 'SOPAY', payment_id: 'p-card-kept', settlement_row_id: 8 },
    ],
    acc_settlement_rows: [
      { id: 1, batch_id: 1, company_id: CO, confirmed_at: '2026-09-30T08:41:00Z', posted_je_no: 'JE-S1', bucket: 'MATCHED' },
      { id: 2, batch_id: 2, company_id: CO, confirmed_at: null, posted_je_no: null, bucket: 'MATCHED' },
      { id: 3, batch_id: 3, company_id: CO, confirmed_at: '2026-09-30T08:41:00Z', posted_je_no: 'JE-S3', bucket: 'MATCHED' },
      /* Report 3 still has a line to decide — and one set aside, which is no work. */
      { id: 4, batch_id: 3, company_id: CO, confirmed_at: null, posted_je_no: null, bucket: 'NEEDS_CONFIRM' },
      { id: 5, batch_id: 3, company_id: CO, confirmed_at: null, posted_je_no: null, bucket: 'IGNORED' },
      { id: 6, batch_id: 4, company_id: CO, confirmed_at: '2026-09-30T08:41:00Z', posted_je_no: 'JE-S6', bucket: 'MATCHED' },
      { id: 7, batch_id: 5, company_id: CO, confirmed_at: '2026-09-30T08:41:00Z', posted_je_no: 'JE-S7', bucket: 'MATCHED' },
      { id: 8, batch_id: 6, company_id: CO, confirmed_at: '2026-09-30T08:41:00Z', posted_je_no: 'JE-S8', bucket: 'MATCHED' },
    ],
    acc_settlement_batches: [
      { id: 1, company_id: CO, file_name: 'ghl-0901.csv', acquirer_code: 'GHL', net_sen: 166800, stated_net_sen: null },
      { id: 2, company_id: CO, file_name: 'pbb-0902.csv', acquirer_code: 'PBB', net_sen: 324000, stated_net_sen: null },
      { id: 3, company_id: CO, file_name: 'mbb-0904.csv', acquirer_code: 'MBB', net_sen: 100000, stated_net_sen: null },
      { id: 4, company_id: CO, file_name: 'mbb-0905.csv', acquirer_code: 'MBB', net_sen: 100000, stated_net_sen: null },
      { id: 5, company_id: CO, file_name: 'mbb-0906.csv', acquirer_code: 'MBB', net_sen: 100000, stated_net_sen: null },
      { id: 6, company_id: CO, file_name: 'pbb-0906.csv', acquirer_code: 'PBB', net_sen: 334818, stated_net_sen: null },
    ],
    acc_settlement_receipts: [
      /* Report 1 is in the bank, its credit booked. */
      { id: 1, company_id: CO, batch_id: 1, received_on: '2026-09-03', amount_sen: 166800, charge_sen: 0, je_no: 'JE-R1' },
      /* A credit keyed but never booked is not money in the bank. */
      { id: 2, company_id: CO, batch_id: 4, received_on: '2026-09-07', amount_sen: 100000, charge_sen: 0, je_no: null },
      { id: 3, company_id: CO, batch_id: 5, received_on: '2026-09-08', amount_sen: 40000, charge_sen: 0, je_no: 'JE-R5' },
      { id: 4, company_id: CO, batch_id: 6, received_on: '2026-09-08', amount_sen: 302418, charge_sen: 0, je_no: 'JE-R6' },
    ],
    /* The RM 324 PBB kept off that payout, booked on its advice day (acc/payout-charge). */
    acc_settlement_payout_batches: [
      { id: 4, company_id: CO, payout_id: 3, batch_id: 6, settled_on: '2026-09-06', net_sen: 302418, charge_sen: 32400, charge_je_no: 'JE-C4' },
    ],
    journal_entries: [
      je('je-1', 'JE-1', 'p-tr-matched'),
      je('je-2', 'JE-2', 'p-tr-named'),
      je('je-3', 'JE-3', 'p-tr-open-line'),
      je('je-4', 'JE-4', 'p-tr-late'),
      je('je-5', 'JE-5', 'p-tr-reversed', { reversed: true }),
    ],
    journal_entry_lines: ['je-1', 'je-2', 'je-3', 'je-4', 'je-5'].flatMap((id) => [
      { journal_entry_id: id, account_code: '310-0020', debit_sen: 100, credit_sen: 0 },
      { journal_entry_id: id, account_code: '300-0000', debit_sen: 0, credit_sen: 100 },
    ]),
    acc_bank_statement_matches: [
      { company_id: CO, je_no: 'JE-1', bank_line_id: 11 },
      /* An older undo left this behind on an OPEN line — nobody's claim. */
      { company_id: CO, je_no: 'JE-3', bank_line_id: 13 },
    ],
    acc_bank_statement_lines: [
      { id: 11, company_id: CO, state: 'POSTED', posted_je_no: null },
      { id: 12, company_id: CO, state: 'POSTED', posted_je_no: 'JE-9, JE-2' },
      { id: 13, company_id: CO, state: 'OPEN', posted_je_no: null },
    ],
    acc_bank_statements: [
      { id: 1, company_id: CO, account_code: '310-0020', period_to: '2026-08-31' },
      { id: 2, company_id: CO, account_code: '310-0020', period_to: '2026-09-28' },
    ],
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    await next();
  });
  app.get('/unmatched-payments', unmatchedPaymentsHandler as never);
  return { app, sb };
}

describe('GET /unmatched-payments', () => {
  test('without the reconciliation key it is 403', async () => {
    const { app } = harness([]);
    expect((await app.request('/unmatched-payments')).status).toBe(403);
  });

  test('a From after the To is refused in words', async () => {
    const { app } = harness();
    const res = await app.request('/unmatched-payments?from=2026-09-30&to=2026-09-01');
    expect(res.status).toBe(400);
    expect((await res.json() as any).message).toBe('The From date is after the To date.');
  });

  test('lists what is not matched, where each is stuck, and whose sale it was', async () => {
    const { app } = harness();
    const res = await app.request('/unmatched-payments?from=2026-09-01&to=2026-09-30');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    const byId = Object.fromEntries((body.rows as any[]).map((r) => [r.paymentId, r]));
    /* Merchant matched (a confirmed line) is matched, whatever its report's bank side —
       held by the report's other line, its credit not booked, paid in part or in full with
       a kept charge (owner 2026-11-10: 已经match 了就不要出现). */
    expect(Object.keys(byId).sort()).toEqual([
      'p-card-cimb', 'p-card-confirm', 'p-card-waiting',
      'p-tr-late', 'p-tr-open-line', 'p-tr-reversed', 'p-tr-unbooked',
      'si-pay-1',
    ]);
    expect(byId['p-card-confirm']).toMatchObject({
      kind: 'card', state: 'CARD_TO_CONFIRM', channel: 'PBB', reference: 'R18656', amountSen: 324000,
      docNo: 'SO-A', customerName: 'Chong Hui Wen', salespersonName: 'Nico',
      report: { batchId: 2, fileName: 'pbb-0902.csv', acquirerCode: 'PBB', waitingLines: 1 },
    });
    expect(byId['p-card-waiting']).toMatchObject({ state: 'CARD_NOT_REPORTED', channel: 'MBB', customerName: 'Poon How kei', salespersonName: null });
    expect(byId['p-card-cimb']).toMatchObject({ state: 'CARD_NO_MERCHANT', channel: 'CIMB' });
    /* A match row on an OPEN line claims nothing; the statement reaches its day. */
    expect(byId['p-tr-open-line']).toMatchObject({ kind: 'transfer', state: 'TRANSFER_NOT_MATCHED', bankAccountCode: '310-0020', statementUpTo: '2026-09-28', reference: '260920CE0DB5C26', jeNo: 'JE-3' });
    expect(byId['p-tr-late']).toMatchObject({ state: 'TRANSFER_NO_STATEMENT', channel: 'TNG', statementUpTo: '2026-09-28' });
    expect(byId['p-tr-unbooked']).toMatchObject({ state: 'TRANSFER_NOT_BOOKED' });
    /* Its only entry was reversed: nothing live for a bank to claim. */
    expect(byId['p-tr-reversed']).toMatchObject({ state: 'TRANSFER_NOT_BOOKED' });
    expect(byId['si-pay-1']).toMatchObject({ source: 'SIPAY', docNo: 'SI-2609-001', customerName: 'Acme', state: 'TRANSFER_NOT_BOOKED' });
  });

  /* Owner 2026-11-09 (sales person 应该不太对，应该是collected by 的人): the person who took
     the money is named off the payment itself — not the order's salesperson; nobody
     recorded, nobody named. An invoice payment names its collector too. */
  test('names who collected each payment, beside the order\'s salesperson', async () => {
    const { app } = harness();
    const body = await (await app.request('/unmatched-payments?from=2026-09-01&to=2026-09-30')).json() as any;
    const byId = Object.fromEntries((body.rows as any[]).map((r) => [r.paymentId, r]));
    expect(byId['p-card-confirm']).toMatchObject({ collectedByName: 'Esther', salespersonName: 'Nico' });
    expect(byId['p-card-waiting']).toMatchObject({ collectedByName: null });
    expect(byId['si-pay-1']).toMatchObject({ collectedByName: 'Nico' });
  });
});
