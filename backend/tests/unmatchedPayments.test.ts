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
      pay({ id: 'p-card-confirm', method: 'merchant', merchant_provider: 'PBB', amount_sen: 324000, paid_at: '2026-09-02', approval_code: 'R18656' }),
      pay({ id: 'p-card-waiting', method: 'installment', merchant_provider: 'MBB', amount_sen: 269000, paid_at: '2026-09-03', so_doc_no: 'SO-B' }),
      pay({ id: 'p-card-cimb', method: 'merchant', merchant_provider: 'CIMB', amount_sen: 50000, paid_at: '2026-09-05' }),
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
      { id: 'si-pay-1', company_id: CO, sales_invoice_id: 'inv-1', paid_at: '2026-09-12', amount_sen: 200000, method: 'transfer', merchant_provider: null, online_type: 'Bank Transfer', approval_code: null },
    ],
    mfg_sales_orders: [
      { company_id: CO, doc_no: 'SO-A', debtor_name: 'Chong Hui Wen', status: 'CONFIRMED', salesperson_id: 'st-1' },
      { company_id: CO, doc_no: 'SO-B', debtor_name: 'Poon How kei', status: 'CONFIRMED', salesperson_id: null },
      { company_id: CO, doc_no: 'SO-X', debtor_name: 'Gone', status: 'CANCELLED', salesperson_id: null },
    ],
    sales_invoices: [{ id: 'inv-1', company_id: CO, invoice_number: 'SI-2609-001', debtor_name: 'Acme' }],
    staff: [{ id: 'st-1', name: 'Nico' }],
    acc_acquirers: [
      { company_id: CO, display_name: 'GHL', is_active: true },
      { company_id: CO, display_name: 'PBB', is_active: true },
      { company_id: CO, display_name: 'MBB', is_active: true },
      { company_id: CO, display_name: 'CIMB', is_active: false },
    ],
    acc_settlement_matches: [
      { company_id: CO, payment_source: 'SOPAY', payment_id: 'p-card-done', settlement_row_id: 1 },
      { company_id: CO, payment_source: 'SOPAY', payment_id: 'p-card-confirm', settlement_row_id: 2 },
    ],
    acc_settlement_rows: [
      { id: 1, company_id: CO, confirmed_at: '2026-09-30T08:41:00Z', posted_je_no: 'JE-S1' },
      { id: 2, company_id: CO, confirmed_at: null, posted_je_no: null },
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
    expect(Object.keys(byId).sort()).toEqual([
      'p-card-cimb', 'p-card-confirm', 'p-card-waiting',
      'p-tr-late', 'p-tr-open-line', 'p-tr-reversed', 'p-tr-unbooked',
      'si-pay-1',
    ]);
    expect(byId['p-card-confirm']).toMatchObject({
      kind: 'card', state: 'CARD_TO_CONFIRM', channel: 'PBB', reference: 'R18656', amountSen: 324000,
      docNo: 'SO-A', customerName: 'Chong Hui Wen', salespersonName: 'Nico',
    });
    expect(byId['p-card-waiting']).toMatchObject({ state: 'CARD_NOT_REPORTED', channel: 'MBB', customerName: 'Poon How kei', salespersonName: null });
    expect(byId['p-card-cimb']).toMatchObject({ state: 'CARD_NO_MERCHANT', channel: 'CIMB' });
    /* A match row on an OPEN line claims nothing; the statement reaches its day. */
    expect(byId['p-tr-open-line']).toMatchObject({ kind: 'transfer', state: 'TRANSFER_NOT_MATCHED', bankAccountCode: '310-0020', statementUpTo: '2026-09-28', reference: '260920CE0DB5C26' });
    expect(byId['p-tr-late']).toMatchObject({ state: 'TRANSFER_NO_STATEMENT', channel: 'TNG', statementUpTo: '2026-09-28' });
    expect(byId['p-tr-unbooked']).toMatchObject({ state: 'TRANSFER_NOT_BOOKED' });
    /* Its only entry was reversed: nothing live for a bank to claim. */
    expect(byId['p-tr-reversed']).toMatchObject({ state: 'TRANSFER_NOT_BOOKED' });
    expect(byId['si-pay-1']).toMatchObject({ source: 'SIPAY', docNo: 'SI-2609-001', customerName: 'Acme', state: 'TRANSFER_NOT_BOOKED' });
  });
});
