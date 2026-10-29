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
//   • ensure heals a payment recorded before the module existed;
//   • the receipt follows its payment (owner 2026-10-29: 收据跟着付款改或作废):
//     a DRAFT is rewritten in place and keeps its number; a FORMAL one is
//     CANCELLED (kept, why and who on it, its successor named) and re-issued —
//     formal at once on its own channel when the method is unchanged, born as a
//     new payment's receipt when it changed; a deleted payment's draft goes and
//     its formal receipt is cancelled; a cancelled receipt is nobody's — the
//     payment gets a new one beside it, and no confirm reaches it.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import {
  createReceiptForPayment, ensureReceiptForPayment, followPaymentEdit, followPaymentRemoval, formaliseReceiptsForSettlement,
} from '../src/acc/receipts';
import { receiptFormalise } from '../src/scm/routes/accounting-receipts';
import { receiptFieldChange, repostSoPaymentBestEffort } from '../src/scm/lib/so-payment-row';

const CO = 2;
/* Every payment here was paid on 2026-07-05: the receipt's series follows the
   PAYMENT date, draft and formal alike (owner 2026-09-07). */
const yymm = '2607';

const world = (over: Record<string, Row[]> = {}) => fakeSb(
  {
    acc_official_receipts: [],
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
    { table: 'acc_official_receipts', column: 'or_number', name: 'acc_official_receipts_or_number_key' },
    /* One LIVE receipt per payment (migration 20261029T1500) — a cancelled one
       stands beside its replacement. */
    {
      table: 'acc_official_receipts', column: 'payment_id', name: 'acc_official_receipts_payment_source_payment_id_live',
      covers: (r) => r.status !== 'CANCELLED',
    },
  ],
  ['acc_official_receipts'],
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
    expect(sb.tables.acc_official_receipts).toHaveLength(1);
  });

  test('a CASH payment is FORMAL in the same breath, on the COR series', async () => {
    const sb = world();
    const r = await createReceiptForPayment(sb, { ...CARD, paymentId: 'p2', method: 'cash' });
    expect(r).toMatchObject({ ok: true, status: 'FORMAL', orNumber: `2990-COR-${yymm}-001` });
    expect(sb.tables.acc_official_receipts[0]).toMatchObject({ status: 'FORMAL', channel_account_code: '320-0000' });
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
      acc_official_receipts: [{ id: 7, company_id: CO, or_number: `2990-DraftOR-${yymm}-004`, status: 'DRAFT', payment_source: 'SOPAY', payment_id: 'p9', amount_sen: 5000, paid_at: '2026-07-05' }],
    });
    const res = await app.request('/accounting/receipts/7/formalise', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json() as { orNumber: string }).orNumber).toBe(`2990-MOR-${yymm}-001`);
    expect(sb.tables.acc_official_receipts[0]).toMatchObject({ status: 'FORMAL', issued_by: 'Chew', channel_account_code: '310-0010' });
  });

  test('a bank with no letter refuses with the setup card named', async () => {
    const { app, sb } = harness({
      acc_official_receipts: [{ id: 7, company_id: CO, or_number: `2990-DraftOR-${yymm}-004`, status: 'DRAFT', payment_source: 'SOPAY', payment_id: 'p9', amount_sen: 5000, paid_at: '2026-07-05' }],
      acc_bank_letters: [],
    });
    const res = await app.request('/accounting/receipts/7/formalise', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain('Voucher numbering');
    expect(sb.tables.acc_official_receipts[0]).toMatchObject({ status: 'DRAFT' });
  });
});

describe('settlement confirm turns card receipts formal', () => {
  test('formalises on the payout bank; missing receipts and letters are reported, never thrown', async () => {
    const sb = world({
      acc_official_receipts: [
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
    expect(sb.tables.acc_official_receipts[0]).toMatchObject({ status: 'FORMAL', or_number: `2990-MOR-${yymm}-010` });
  });
});

describe('ensure heals history', () => {
  test('a payment recorded before the module gets its receipt from its own row', async () => {
    const sb = world({
      mfg_sales_order_payments: [{ id: 'old1', so_doc_no: '2990-SO-2607-009', paid_at: '2026-07-01T10:00:00', method: 'merchant', amount_sen: 25000, company_id: CO, created_by: 'u' }],
    });
    const r = await ensureReceiptForPayment(sb, 'SOPAY', 'old1', CO);
    expect(r).toMatchObject({ ok: true, status: 'DRAFT' });
    expect(sb.tables.acc_official_receipts[0]).toMatchObject({ doc_no: '2990-SO-2607-009', amount_sen: 25000 });
  });

  test("another company's payment id is refused, and no receipt is written", async () => {
    const sb = world({
      companies: [{ id: CO, code: '2990' }, { id: 1, code: 'HC' }],
      mfg_sales_order_payments: [{ id: 'hc1', so_doc_no: 'HC-SO-2607-001', paid_at: '2026-07-01T10:00:00', method: 'merchant', amount_sen: 25000, company_id: 1, created_by: 'u' }],
    });
    const r = await ensureReceiptForPayment(sb, 'SOPAY', 'hc1', CO);
    expect(r).toMatchObject({ ok: false });
    expect(sb.tables.acc_official_receipts).toHaveLength(0);
  });
});

describe('the receipt follows its payment (owner 2026-10-29)', () => {
  const WHY = 'Payment on 2990-SO-2609-001 changed';
  const edit = (sb: ReturnType<typeof world>, next: { amountSen: number; paidAt: string; method: string }, paymentId = 'p1') =>
    followPaymentEdit(sb, { source: 'SOPAY', paymentId, companyId: CO, next, why: WHY, actor: 'Chew' });
  /* A card receipt the merchant recon has confirmed on the Maybank account. */
  const formalCard = async () => {
    const sb = world();
    await createReceiptForPayment(sb, CARD);
    await formaliseReceiptsForSettlement(sb, CO, '2990', [{ source: 'SOPAY', id: 'p1' }], '310-0010', 'Recon');
    expect(sb.tables.acc_official_receipts[0]).toMatchObject({ status: 'FORMAL', or_number: `2990-MOR-${yymm}-001` });
    return sb;
  };

  test('a DRAFT follows in place — amount, day and method — and keeps its number', async () => {
    const sb = world();
    await createReceiptForPayment(sb, CARD);
    const r = await edit(sb, { amountSen: 55_800, paidAt: '2026-08-02', method: 'transfer' });
    expect(r).toEqual({ ok: true, touch: null });
    expect(sb.tables.acc_official_receipts).toHaveLength(1);
    expect(sb.tables.acc_official_receipts[0]).toMatchObject({
      or_number: `2990-DraftOR-${yymm}-001`, status: 'DRAFT', amount_sen: 55_800, paid_at: '2026-08-02', method: 'transfer',
    });
  });

  test('a FORMAL receipt is cancelled — why and who on it — and re-issued formal on its own channel', async () => {
    const sb = await formalCard();
    const r = await edit(sb, { amountSen: 55_800, paidAt: '2026-07-05', method: 'merchant' });
    expect(r).toEqual({ ok: true, touch: { from: `2990-MOR-${yymm}-001`, to: `2990-MOR-${yymm}-002`, draft: false } });
    const [old, now] = sb.tables.acc_official_receipts;
    expect(old).toMatchObject({
      or_number: `2990-MOR-${yymm}-001`, status: 'CANCELLED', amount_sen: 100_000, cancelled_by: 'Chew',
      cancel_reason: `${WHY}: amount RM 1,000.00 → RM 558.00`, replaced_by_id: now!.id,
    });
    expect(old!.cancelled_at).toEqual(expect.any(String));
    expect(now).toMatchObject({
      or_number: `2990-MOR-${yymm}-002`, status: 'FORMAL', amount_sen: 55_800, paid_at: '2026-07-05',
      channel_account_code: '310-0010', doc_no: CARD.docNo, payment_id: 'p1',
    });
    /* The payment's receipt is now the new one — ensure (the print button) finds it. */
    expect(await ensureReceiptForPayment(sb, 'SOPAY', 'p1', CO)).toMatchObject({ ok: true, orNumber: `2990-MOR-${yymm}-002` });
  });

  test('re-dated into another month: the replacement takes that month\'s number', async () => {
    const sb = await formalCard();
    const r = await edit(sb, { amountSen: 100_000, paidAt: '2026-06-20', method: 'merchant' });
    expect(r).toMatchObject({ ok: true, touch: { from: `2990-MOR-${yymm}-001`, to: '2990-MOR-2606-001' } });
    expect(sb.tables.acc_official_receipts[0]!.cancel_reason).toBe(`${WHY}: date 2026-07-05 → 2026-06-20`);
  });

  test('a cash receipt is re-issued formal on the cash series at once', async () => {
    const sb = world();
    await createReceiptForPayment(sb, { ...CARD, paymentId: 'p2', method: 'cash' });
    const r = await edit(sb, { amountSen: 118_200, paidAt: '2026-07-05', method: 'cash' }, 'p2');
    expect(r).toMatchObject({ ok: true, touch: { from: `2990-COR-${yymm}-001`, to: `2990-COR-${yymm}-002` } });
    expect(sb.tables.acc_official_receipts.map((x) => x.status)).toEqual(['CANCELLED', 'FORMAL']);
  });

  test('a method change: the replacement is born as the new method\'s receipt — a transfer waits to be confirmed', async () => {
    const sb = await formalCard();
    const r = await edit(sb, { amountSen: 100_000, paidAt: '2026-07-05', method: 'transfer' });
    expect(r).toMatchObject({ ok: true, touch: { from: `2990-MOR-${yymm}-001`, draft: false } });
    /* A draft number — which one is the counter's business (production's RPC never re-issues). */
    expect(r.ok && r.touch?.to).toMatch(new RegExp(`^2990-DraftOR-${yymm}-\\d{3}$`));
    expect(sb.tables.acc_official_receipts.map((x) => [x.status, x.method])).toEqual([['CANCELLED', 'merchant'], ['DRAFT', 'transfer']]);
  });

  test('the edit hook carries it — the PATCH\'s own path — and the audit line names both receipts', async () => {
    const sb = await formalCard();
    const before = {
      paid_at: '2026-07-05', method: 'merchant', amount_sen: 100_000, merchant_provider: 'MBB', installment_months: null,
      online_type: null, approval_code: '062181', account_sheet: 'MBB', collected_by: null,
    };
    const out = await repostSoPaymentBestEffort(sb as never, {
      id: 'p1', docNo: CARD.docNo, companyId: CO, before, next: { ...before, amount_sen: 55_800 }, actor: 'Scarlett',
    });
    expect(out.receipt).toEqual({ from: `2990-MOR-${yymm}-001`, to: `2990-MOR-${yymm}-002`, draft: false });
    expect(receiptFieldChange(out.receipt)).toEqual([{ field: 'receipt', from: `2990-MOR-${yymm}-001`, to: `2990-MOR-${yymm}-002` }]);
    expect(sb.tables.acc_official_receipts[0]).toMatchObject({ status: 'CANCELLED', cancelled_by: 'Scarlett' });
    /* An approval-code typo moves nothing a receipt says. */
    const again = await repostSoPaymentBestEffort(sb as never, {
      id: 'p1', docNo: CARD.docNo, companyId: CO, before: { ...before, amount_sen: 55_800 }, next: { ...before, amount_sen: 55_800, approval_code: '062182' },
    });
    expect(again.receipt).toBeNull();
    expect(receiptFieldChange(again.receipt)).toEqual([]);
  });

  test('nothing the receipt says moved — nothing happens', async () => {
    const sb = await formalCard();
    expect(await edit(sb, { amountSen: 100_000, paidAt: '2026-07-05', method: 'merchant' })).toEqual({ ok: true, touch: null });
    expect(sb.tables.acc_official_receipts).toHaveLength(1);
    expect(sb.tables.acc_official_receipts[0]).toMatchObject({ status: 'FORMAL' });
  });

  test('a deleted payment: its draft goes; its formal receipt is cancelled and kept', async () => {
    const drafts = world();
    await createReceiptForPayment(drafts, CARD);
    const gone = await followPaymentRemoval(drafts, { source: 'SOPAY', paymentId: 'p1', companyId: CO, why: 'Payment on X deleted', actor: 'Chew' });
    expect(gone).toEqual({ ok: true, touch: { from: `2990-DraftOR-${yymm}-001`, to: null, draft: true } });
    expect(drafts.tables.acc_official_receipts).toHaveLength(0);

    const sb = await formalCard();
    const kept = await followPaymentRemoval(sb, { source: 'SOPAY', paymentId: 'p1', companyId: CO, why: 'Payment on X deleted', actor: 'Chew' });
    expect(kept).toEqual({ ok: true, touch: { from: `2990-MOR-${yymm}-001`, to: null, draft: false } });
    expect(sb.tables.acc_official_receipts).toHaveLength(1);
    expect(sb.tables.acc_official_receipts[0]).toMatchObject({ status: 'CANCELLED', cancel_reason: 'Payment on X deleted' });
    expect(sb.tables.acc_official_receipts[0]!.replaced_by_id ?? null).toBeNull();
  });

  test('a cancelled receipt is nobody\'s: a new one is born beside it, and no confirm reaches it', async () => {
    const sb = await formalCard();
    await followPaymentRemoval(sb, { source: 'SOPAY', paymentId: 'p1', companyId: CO, why: 'Payment on X deleted', actor: 'Chew' });
    /* The payment came back (say, keyed again under the same id by a test) — its receipt is new. */
    const born = await createReceiptForPayment(sb, CARD);
    expect(born).toMatchObject({ ok: true, status: 'DRAFT' });
    expect(sb.tables.acc_official_receipts).toHaveLength(2);
    const settled = await formaliseReceiptsForSettlement(sb, CO, '2990', [{ source: 'SOPAY', id: 'p1' }], '310-0010', 'Recon');
    expect(settled).toEqual([{ paymentId: 'p1', outcome: 'formalised' }]);
    expect(sb.tables.acc_official_receipts.map((x) => [x.or_number, x.status])).toEqual([
      [`2990-MOR-${yymm}-001`, 'CANCELLED'], [`2990-MOR-${yymm}-002`, 'FORMAL'],
    ]);

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('supabase' as never, sb as never);
      c.set('companyId' as never, CO as never);
      c.set('houzsUser' as never, { name: 'Chew', permissions_set: ['scm.payment_voucher.post'] } as never);
      c.set('allowedCompanyIds' as never, [CO] as never);
      await next();
    });
    app.post('/accounting/receipts/:id/formalise', receiptFormalise as never);
    const res = await app.request(`/accounting/receipts/${String(sb.tables.acc_official_receipts[0]!.id)}/formalise`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('cancelled');
  });
});
