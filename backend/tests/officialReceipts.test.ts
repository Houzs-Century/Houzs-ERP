// Official Receipts (GL redesign item 9). Pinned:
//   • a recorded card payment births a DRAFT receipt ({co}DraftOR-YYMM-NNN);
//     a CASH payment is FORMAL in the same breath on the COR series — 钱当场
//     在手; one payment, one receipt, forever (the retry finds the row);
//   • the manual confirm mints the channel number from the money account's
//     letter (default bank when none named) and refuses, with the setup card
//     named, when the bank has no letter;
//   • settlement confirm turns the confirmed payments' receipts FORMAL on
//     the acquirer's payout bank — and stays best-effort (no receipt, no
//     letter → reported, never thrown);
//   • ensure heals a payment recorded before the module existed.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { createReceiptForPayment, ensureReceiptForPayment, formaliseReceiptsForSettlement } from '../src/acc/receipts';
import { receiptFormalise } from '../src/scm/routes/accounting-receipts';

const CO = 2;
/* Every payment here was paid on 2026-07-05: the receipt's series follows the
   PAYMENT date, draft and formal alike (owner 2026-09-07). */
const yymm = '2607';

const world = (over: Record<string, Row[]> = {}) => fakeSb(
  {
    acc_receipts: [],
    acc_bank_letters: [{ company_id: CO, account_code: '310-0010', letter: 'M' }],
    acc_numbering: [],
    acc_account_roles: [],
    accounts: [],
    companies: [{ id: CO, code: '2990' }],
    mfg_sales_order_payments: [],
    sales_invoice_payments: [],
    ...over,
  },
  {},
  [
    { table: 'acc_receipts', column: 'or_number', name: 'acc_receipts_or_number_key' },
    { table: 'acc_receipts', column: 'payment_id', name: 'acc_receipts_payment_once' },
  ],
  ['acc_receipts'],
);

const CARD = {
  source: 'SOPAY' as const, paymentId: 'p1', companyId: CO, companyCode: '2990',
  docNo: '2990-SO-2609-001', method: 'merchant', amountSen: 100000, paidAt: '2026-07-05', createdBy: 'Sales',
};

describe('birth', () => {
  test('a card payment births a DRAFT on the draft series; a repeat finds the same receipt', async () => {
    const sb = world();
    const r1 = await createReceiptForPayment(sb, CARD);
    expect(r1).toMatchObject({ ok: true, status: 'DRAFT', orNumber: `2990-DraftOR-${yymm}-001` });
    const r2 = await createReceiptForPayment(sb, CARD);
    expect(r2.ok && r2.id).toBe(r1.ok && r1.id);
    expect(sb.tables.acc_receipts).toHaveLength(1);
  });

  test('a CASH payment is FORMAL in the same breath, on the COR series', async () => {
    const sb = world();
    const r = await createReceiptForPayment(sb, { ...CARD, paymentId: 'p2', method: 'cash' });
    expect(r).toMatchObject({ ok: true, status: 'FORMAL', orNumber: `2990-COR-${yymm}-001` });
    expect(sb.tables.acc_receipts[0]).toMatchObject({ status: 'FORMAL', channel_account_code: '320-0000' });
  });
});

describe('the manual confirm', () => {
  function harness(tables: Record<string, Row[]> = {}) {
    const sb = world(tables);
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('supabase' as never, sb as never);
      c.set('companyId' as never, CO as never);
      c.set('houzsUser' as never, { name: 'Chew', permissions_set: ['scm.payment_voucher.post'] } as never);
      c.set('allowedCompanyIds' as never, [CO] as never);
      await next();
    });
    app.post('/accounting/receipts/:id/formalise', receiptFormalise as never);
    return { app, sb };
  }

  test('defaults to the company bank, mints {letter}OR, stamps who confirmed', async () => {
    const { app, sb } = harness({
      acc_receipts: [{ id: 7, company_id: CO, or_number: `2990-DraftOR-${yymm}-004`, status: 'DRAFT', payment_source: 'SOPAY', payment_id: 'p9', amount_sen: 5000, paid_at: '2026-07-05' }],
    });
    const res = await app.request('/accounting/receipts/7/formalise', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json() as { orNumber: string }).orNumber).toBe(`2990-MOR-${yymm}-001`);
    expect(sb.tables.acc_receipts[0]).toMatchObject({ status: 'FORMAL', issued_by: 'Chew', channel_account_code: '310-0010' });
  });

  test('a bank with no letter refuses with the setup card named', async () => {
    const { app, sb } = harness({
      acc_receipts: [{ id: 7, company_id: CO, or_number: `2990-DraftOR-${yymm}-004`, status: 'DRAFT', payment_source: 'SOPAY', payment_id: 'p9', amount_sen: 5000, paid_at: '2026-07-05' }],
      acc_bank_letters: [],
    });
    const res = await app.request('/accounting/receipts/7/formalise', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain('Voucher numbering');
    expect(sb.tables.acc_receipts[0]).toMatchObject({ status: 'DRAFT' });
  });
});

describe('settlement confirm turns card receipts formal', () => {
  test('formalises on the payout bank; missing receipts and letters are reported, never thrown', async () => {
    const sb = world({
      acc_receipts: [
        { id: 1, company_id: CO, or_number: `2990-DraftOR-${yymm}-001`, status: 'DRAFT', payment_source: 'SOPAY', payment_id: 'p1', amount_sen: 1, paid_at: '2026-07-05' },
        { id: 2, company_id: CO, or_number: `2990-MOR-${yymm}-009`, status: 'FORMAL', payment_source: 'SOPAY', payment_id: 'p2', amount_sen: 1, paid_at: '2026-07-05' },
      ],
    });
    const out = await formaliseReceiptsForSettlement(sb, CO, '2990',
      [{ source: 'SOPAY', id: 'p1' }, { source: 'SOPAY', id: 'p2' }, { source: 'SOPAY', id: 'p3' }],
      '310-0010', 'Chew');
    expect(out).toEqual([
      { paymentId: 'p1', outcome: 'formalised' },
      { paymentId: 'p2', outcome: 'already_formal' },
      { paymentId: 'p3', outcome: 'no_receipt' },
    ]);
    // -010: the series already held -009, and max+1 never re-issues.
    expect(sb.tables.acc_receipts[0]).toMatchObject({ status: 'FORMAL', or_number: `2990-MOR-${yymm}-010` });
  });
});

describe('ensure heals history', () => {
  test('a payment recorded before the module gets its receipt from its own row', async () => {
    const sb = world({
      mfg_sales_order_payments: [{ id: 'old1', so_doc_no: '2990-SO-2607-009', paid_at: '2026-07-01T10:00:00', method: 'merchant', amount_sen: 25000, company_id: CO, created_by: 'u' }],
    });
    const r = await ensureReceiptForPayment(sb, 'SOPAY', 'old1');
    expect(r).toMatchObject({ ok: true, status: 'DRAFT' });
    expect(sb.tables.acc_receipts[0]).toMatchObject({ doc_no: '2990-SO-2607-009', amount_sen: 25000 });
  });
});
