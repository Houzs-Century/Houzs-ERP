// A salesperson's payment record the owner has checked and marked as the
// previous system's (owner 2026-11-11: 我检查确定后，就直接说这个是之前record，
// 我哪里都不会take-in / 我说的是sales man 的收款记录（包括imported from autocount)).
//
// Pinned here:
//   • what may be marked — not a payment a merchant report line holds, not one
//     whose entry counts in the books; a soft-launch entry (before the books'
//     first day) and a reversed one stand in no way; a second press writes nothing;
//   • Undo puts it back; the list names each one;
//   • a marked payment is gone from Payments not matched yet, from Merchant
//     Recon's pools (card payments not reported yet, Find the sale) and from the
//     Cash Flow's AutoCount line;
//   • the doors answer 403 without the reconciliation key and 400 on a bad body.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { listPrevious, markPrevious, refusalOf, undoPrevious } from '../src/acc/previous-payments';
import { loadUnmatchedPayments } from '../src/acc/unmatched-payments';
import { findPaymentsForRow, loadPaymentCandidates } from '../src/acc/settlement';
import { loadAutoCountReceipts } from '../src/acc/autocount-receipts';
import { previousPaymentsList, previousPaymentsMark, previousPaymentsUndo } from '../src/scm/routes/accounting-previous-payments';

const CO = 1;
const GL_PERM = 'scm.payment_voucher.post';

describe('refusalOf — what may be marked', () => {
  test('a merchant line holding it, or an entry in the books, refuses; otherwise it may be marked', () => {
    expect(refusalOf({ found: true, docNo: 'HC-SO-1', merchantLine: false, bookedJeNo: null })).toBeNull();
    expect(refusalOf({ found: false, docNo: null, merchantLine: false, bookedJeNo: null })).toMatchObject({ reason: 'not_found' });
    expect(refusalOf({ found: true, docNo: 'HC-SO-1', merchantLine: true, bookedJeNo: 'JE-1' }))
      .toEqual({ reason: 'merchant_line', message: 'HC-SO-1: a merchant report line holds it. Release it on Merchant Recon first.' });
    expect(refusalOf({ found: true, docNo: 'HC-SO-1', merchantLine: false, bookedJeNo: 'HC-JE-2609-0001' }))
      .toEqual({ reason: 'in_the_books', message: 'HC-SO-1: its entry HC-JE-2609-0001 is in the books, so it is not only the previous system\'s.' });
  });
});

/* ── Over a fake database ────────────────────────────────────────────────── */

const pay = (id: string, over: Row = {}): Row => ({
  id, company_id: CO, so_doc_no: 'HC-SO-A', paid_at: '2026-08-20', amount_sen: 100_000, approval_code: null,
  method: 'imported', merchant_provider: null, online_type: null, collected_by: null, created_by: 'u1', ...over,
});
const je = (id: string, jeNo: string, paymentId: string, entryDate: string, over: Row = {}): Row => ({
  id, company_id: CO, je_no: jeNo, source_type: 'SOPAY', source_doc_no: paymentId, entry_date: entryDate, posted: true, reversed: false, ...over,
});

function world(over: { previous?: Row[]; settings?: Row[] } = {}) {
  return fakeSb({
    acc_company_settings: over.settings ?? [{ company_id: CO, books_start_date: '2026-09-01', opening_stock: null }],
    mfg_sales_order_payments: [
      pay('p-imported'),                                                   // AutoCount's, no entry
      pay('p-soft', { method: 'transfer', online_type: 'Bank Transfer' }), // keyed here before the books: soft launch
      pay('p-booked', { method: 'transfer', online_type: 'Bank Transfer', paid_at: '2026-09-05' }),
      pay('p-reversed', { method: 'transfer', online_type: 'Bank Transfer', paid_at: '2026-09-06' }),
      pay('p-linked', { method: 'merchant', merchant_provider: 'MBB', approval_code: '080405' }),
      pay('p-theirs', { company_id: 2 }),
    ],
    sales_invoice_payments: [],
    mfg_sales_orders: [{ company_id: CO, doc_no: 'HC-SO-A', debtor_name: 'Sample Customer', status: 'CONFIRMED', salesperson_id: null }],
    sales_invoices: [],
    journal_entries: [
      je('je-soft', 'HC-JE-2608-0001', 'p-soft', '2026-08-20'),
      je('je-booked', 'HC-JE-2609-0005', 'p-booked', '2026-09-05'),
      je('je-reversed', 'HC-JE-2609-0006', 'p-reversed', '2026-09-06', { reversed: true }),
    ],
    acc_settlement_matches: [{ company_id: CO, payment_source: 'SOPAY', payment_id: 'p-linked', settlement_row_id: 9 }],
    acc_previous_payment_records: over.previous ?? [],
  });
}
const ref = (id: string) => ({ source: 'SOPAY' as const, id });

describe('marking, undo and the list', () => {
  test('marks what the rule allows and refuses the rest, each in words', async () => {
    const sb = world();
    const out = await markPrevious(sb, CO, ['p-imported', 'p-soft', 'p-reversed', 'p-booked', 'p-linked', 'p-theirs', 'p-none'].map(ref), 'Chew');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    /* A soft-launch entry (before the books' first day) and a reversed one stand in no way. */
    expect(out.marked.map((r) => r.id)).toEqual(['p-imported', 'p-soft', 'p-reversed']);
    expect(out.refused.map((r) => [r.id, r.reason])).toEqual([
      ['p-booked', 'in_the_books'], ['p-linked', 'merchant_line'], ['p-theirs', 'not_found'], ['p-none', 'not_found'],
    ]);
    expect(out.refused[0]!.message).toBe('HC-SO-A: its entry HC-JE-2609-0005 is in the books, so it is not only the previous system\'s.');
    const rows = (await sb.from('acc_previous_payment_records').select('*')).data as Row[];
    expect(rows.map((r) => [r.company_id, r.payment_source, r.payment_id, r.marked_by])).toEqual([
      [CO, 'SOPAY', 'p-imported', 'Chew'], [CO, 'SOPAY', 'p-soft', 'Chew'], [CO, 'SOPAY', 'p-reversed', 'Chew'],
    ]);
  });

  test('with no first day for the books, any live entry is in the books', async () => {
    const out = await markPrevious(world({ settings: [] }), CO, [ref('p-soft')], 'Chew');
    expect(out.ok && out.refused.map((r) => r.reason)).toEqual(['in_the_books']);
  });

  test('a second press writes nothing; Undo puts it back, once', async () => {
    const sb = world();
    await markPrevious(sb, CO, [ref('p-imported')], 'Chew');
    const again = await markPrevious(sb, CO, [ref('p-imported'), ref('p-imported')], 'Siti');
    expect(again.ok && again.marked.map((r) => r.id)).toEqual(['p-imported']);
    const rows = (await sb.from('acc_previous_payment_records').select('*')).data as Row[];
    expect(rows.map((r) => r.marked_by)).toEqual(['Chew']);

    expect(await undoPrevious(sb, CO, [ref('p-imported'), ref('p-soft')])).toEqual({ ok: true, undone: 1 });
    expect(await undoPrevious(sb, CO, [ref('p-imported')])).toEqual({ ok: true, undone: 0 });
    expect(((await sb.from('acc_previous_payment_records').select('*')).data as Row[])).toHaveLength(0);
  });

  test('the list names each marked payment: its document, customer, method and who marked it', async () => {
    const sb = world({ previous: [{ id: 1, company_id: CO, payment_source: 'SOPAY', payment_id: 'p-imported', marked_by: 'Chew', marked_at: '2026-11-11T05:00:00Z' }] });
    const out = await listPrevious(sb, CO);
    expect(out.ok && out.rows).toEqual([{
      source: 'SOPAY', id: 'p-imported', docNo: 'HC-SO-A', customer: 'Sample Customer', paidOn: '2026-08-20', method: 'imported',
      channel: null, amountSen: 100_000, reference: null, markedBy: 'Chew', markedAt: '2026-11-11T05:00:00Z',
    }]);
  });
});

/* ── Gone from where money is taken in ─────────────────────────────────────── */

describe('a marked payment is gone from every list that takes money in', () => {
  const marked = (id: string): Row => ({ id: 1, company_id: CO, payment_source: 'SOPAY', payment_id: id, marked_by: 'Chew', marked_at: '2026-11-11T05:00:00Z' });

  test('Payments not matched yet', async () => {
    const base = {
      mfg_sales_order_payments: [
        pay('p-a', { method: 'transfer', online_type: 'Bank Transfer', paid_at: '2026-09-10', so_doc_no: 'HC-SO-A' }),
        pay('p-b', { method: 'transfer', online_type: 'Bank Transfer', paid_at: '2026-09-11', so_doc_no: 'HC-SO-A' }),
      ],
      sales_invoice_payments: [],
      mfg_sales_orders: [{ company_id: CO, doc_no: 'HC-SO-A', debtor_name: 'Sample Customer', status: 'CONFIRMED', salesperson_id: null }],
      staff: [], acc_acquirers: [], acc_settlement_matches: [], journal_entries: [], acc_bank_statements: [],
    };
    const window = { from: '2026-09-01', to: '2026-09-30', today: '2026-09-30' };
    const before = await loadUnmatchedPayments(fakeSb({ ...base, acc_previous_payment_records: [] }), CO, window);
    expect(before.ok && before.rows.map((r) => r.paymentId).sort()).toEqual(['p-a', 'p-b']);
    const after = await loadUnmatchedPayments(fakeSb({ ...base, acc_previous_payment_records: [marked('p-a')] }), CO, window);
    expect(after.ok && after.rows.map((r) => r.paymentId)).toEqual(['p-b']);
  });

  const MBB = { display_name: 'MBB', date_tolerance_days: 3, so_names: [] as string[] };
  const cardWorld = (previous: Row[]) => fakeSb({
    mfg_sales_order_payments: [
      pay('p-a', { paid_at: '2026-08-20', amount_sen: 164_000, so_doc_no: 'HC-SO-A' }),
      pay('p-b', { paid_at: '2026-08-21', amount_sen: 164_000, so_doc_no: 'HC-SO-A' }),
    ],
    sales_invoice_payments: [],
    mfg_sales_orders: [{ company_id: CO, doc_no: 'HC-SO-A', debtor_name: 'Sample Customer', status: 'CONFIRMED', salesperson_id: null }],
    staff: [],
    acc_settlement_rows: [{ id: 2, batch_id: 5, company_id: CO, acquirer_code: 'MBB', line_no: 1, txn_date: '2026-08-20', ref: null, gross_sen: 164_000, fee_sen: 1_640, net_sen: 162_360, bucket: 'UNMATCHED', confirmed_at: null, posted_je_no: null, channel: null }],
    acc_settlement_matches: [],
    acc_previous_payment_records: previous,
  }, {}, [], ['acc_settlement_rows']);

  test('Merchant Recon\'s pools: no guess, no match, not on the card payments not reported yet', async () => {
    const before = await loadPaymentCandidates(cardWorld([]), CO, MBB, '2026-08-20', '2026-08-21');
    expect(before.ok && before.payments.map((p) => p.id).sort()).toEqual(['p-a', 'p-b']);
    const after = await loadPaymentCandidates(cardWorld([marked('p-a')]), CO, MBB, '2026-08-20', '2026-08-21');
    expect(after.ok && after.payments.map((p) => p.id)).toEqual(['p-b']);
  });

  test('Find the sale', async () => {
    const before = await findPaymentsForRow(cardWorld([]), CO, 2, '');
    expect(before.ok && before.payments.map((p) => p.id).sort()).toEqual(['p-a', 'p-b']);
    const after = await findPaymentsForRow(cardWorld([marked('p-a')]), CO, 2, '');
    expect(after.ok && after.payments.map((p) => p.id)).toEqual(['p-b']);
  });

  test('the Cash Flow\'s AutoCount line', async () => {
    const acWorld = (previous: Row[]) => fakeSb({
      v_gl_entries: [{ company_id: CO, source_type: 'OPENING', entry_date: '2026-08-31' }],
      mfg_sales_order_payments: [
        pay('p-a', { paid_at: '2026-09-03' }),
        pay('p-b', { paid_at: '2026-09-04' }),
      ],
      mfg_sales_orders: [{ company_id: CO, doc_no: 'HC-SO-A', debtor_name: 'Sample Customer', status: 'CONFIRMED' }],
      acc_previous_payment_records: previous,
    });
    const before = await loadAutoCountReceipts(acWorld([]), CO, '2026-09-01', '2026-09-30');
    expect(before.ok && before.payments.map((p) => p.id)).toEqual(['p-a', 'p-b']);
    const after = await loadAutoCountReceipts(acWorld([marked('p-a')]), CO, '2026-09-01', '2026-09-30');
    expect(after.ok && after.payments.map((p) => p.id)).toEqual(['p-b']);
  });
});

/* ── The doors ─────────────────────────────────────────────────────────────── */

function app(perms: readonly string[] = [GL_PERM]) {
  const sb = world();
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    await next();
  });
  a.get('/previous-payments', previousPaymentsList as never);
  a.post('/previous-payments', previousPaymentsMark as never);
  a.post('/previous-payments/undo', previousPaymentsUndo as never);
  return a;
}
const post = (a: Hono, path: string, body: unknown) => a.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('the doors', () => {
  test('without the reconciliation key they answer 403', async () => {
    const a = app([]);
    expect((await a.request('/previous-payments')).status).toBe(403);
    expect((await post(a, '/previous-payments', { payments: [ref('p-imported')] })).status).toBe(403);
  });

  test('a body that names no payment, or a bad one, is refused in words', async () => {
    const a = app();
    const none = await post(a, '/previous-payments', { payments: [] });
    expect(none.status).toBe(400);
    expect((await none.json() as any).message).toBe('Choose at least one payment.');
    const bad = await post(a, '/previous-payments', { payments: [{ source: 'XPAY', id: 'p-1' }] });
    expect(bad.status).toBe(400);
  });

  test('mark, list, undo', async () => {
    const a = app();
    const marked = await post(a, '/previous-payments', { payments: [ref('p-imported'), ref('p-linked')] });
    expect(marked.status).toBe(200);
    const body = await marked.json() as any;
    expect(body).toMatchObject({ ok: true, marked: 1, refused: [{ id: 'p-linked', reason: 'merchant_line' }] });
    const listed = await (await a.request('/previous-payments')).json() as any;
    expect(listed.rows.map((r: any) => [r.id, r.markedBy])).toEqual([['p-imported', 'Chew']]);
    const undone = await (await post(a, '/previous-payments/undo', { payments: [ref('p-imported')] })).json() as any;
    expect(undone).toEqual({ ok: true, undone: 1 });
    expect(((await (await a.request('/previous-payments')).json()) as any).rows).toEqual([]);
  });
});
