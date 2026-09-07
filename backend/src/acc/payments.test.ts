// Customer payments into the ledger — the newest auto-posting document type,
// so it gets its mandatory behaviour locks (brief §2.1). The decisions pinned:
// which account each method debits, that AR is always the credit, that
// imported/migrated money never books, that a payment posts ONCE, and that the
// backfill converges instead of double-posting.

import { describe, it, expect } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { postSoPayment, postSiPayment, reverseSoPayment, backfillSoPayments, unbookedPayments } from './payments';
import { DEFAULT_ROLE_CODES } from './rules';

const CHART: Row[] = ['300-0000', '500-0000', '320-0000', '310-0010', '326-0000', '327-0000', '888-0000'].map((code) => ({
  account_code: code, account_name: code, account_type: 'ASSET', parent_code: null, is_active: true, company_id: 1,
}));

const SO: Row = { doc_no: 'SO-2608-001', company_id: 1, customer_name: 'Ah Meng', customer_phone: '0123' };

const PAY = (over: Partial<Row> = {}): Row => ({
  id: 'pay-1',
  so_doc_no: 'SO-2608-001',
  paid_at: '2026-08-10T14:00:00+08:00',
  method: 'merchant',
  merchant_provider: 'MBB',
  amount_sen: 50000,
  company_id: 1,
  ...over,
});

const world = (over: { pays?: Row[]; jes?: Row[]; acquirers?: Row[] } = {}) =>
  fakeSb({
    accounts: CHART,
    acc_account_roles: [],
    acc_acquirers: over.acquirers ?? [
      { company_id: 1, code: 'MBB', display_name: 'MBB', transit_account_code: '888-0000', is_active: true },
    ],
    mfg_sales_orders: [SO],
    mfg_sales_order_payments: over.pays ?? [PAY()],
    journal_entries: over.jes ?? [],
    journal_entry_lines: [],
  });

describe('postSoPayment — the money finally reaches the books', () => {
  it('merchant payment: Dr the ACQUIRER transit account, Cr AR, keyed on the payment row', async () => {
    const sb = world();
    const out = await postSoPayment(sb, PAY() as never);
    expect(out).toMatchObject({ ok: true, status: 'posted' });
    const lines = sb.tables.journal_entry_lines;
    expect(lines[0]).toMatchObject({ account_code: '888-0000', debit_sen: 50000 });
    expect(lines[1]).toMatchObject({ account_code: DEFAULT_ROLE_CODES.AR, credit_sen: 50000, party_name: 'Ah Meng' });
    const je = sb.tables.journal_entries[0];
    expect(je).toMatchObject({ source_type: 'SOPAY', source_doc_no: 'pay-1', entry_date: '2026-08-10', posted: true });
  });

  it('an UNMAPPED acquirer books to the generic EDC transit — loudly, never nowhere', async () => {
    const sb = world({ acquirers: [] });
    const out = await postSoPayment(sb, PAY({ merchant_provider: 'Public' }) as never);
    expect(out).toMatchObject({ ok: true, status: 'posted' });
    expect(sb.tables.journal_entry_lines[0]).toMatchObject({ account_code: DEFAULT_ROLE_CODES.TRANSIT_EDC });
  });

  it('cash debits CASH; transfer debits the default bank', async () => {
    const sb = world();
    await postSoPayment(sb, PAY({ id: 'pay-c', method: 'cash' }) as never);
    await postSoPayment(sb, PAY({ id: 'pay-t', method: 'transfer' }) as never);
    const debits = sb.tables.journal_entry_lines.filter((l) => l.debit_sen > 0).map((l) => l.account_code);
    expect(debits).toEqual([DEFAULT_ROLE_CODES.CASH, DEFAULT_ROLE_CODES.BANK_DEFAULT]);
  });

  it('imported rows never book — AutoCount already carries that money', async () => {
    const sb = world();
    const out = await postSoPayment(sb, PAY({ method: 'imported' }) as never);
    expect(out).toMatchObject({ ok: true, status: 'skipped_imported' });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  it('posts ONCE: the second call answers already_posted and writes nothing', async () => {
    const sb = world();
    await postSoPayment(sb, PAY() as never);
    const again = await postSoPayment(sb, PAY() as never);
    expect(again).toMatchObject({ ok: true, status: 'already_posted' });
    expect(sb.tables.journal_entries).toHaveLength(1);
  });

  it('a payment with no usable paid_at is refused — money is never dated "today by accident" (§2.5)', async () => {
    const sb = world();
    const out = await postSoPayment(sb, PAY({ paid_at: null }) as never);
    expect(out).toMatchObject({ ok: false, status: 'bad_paid_at' });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  it('an SO lookup that does not answer fails CLOSED', async () => {
    const sb = fakeSb({
      accounts: CHART, acc_account_roles: [], acc_acquirers: [],
      mfg_sales_orders: [SO], journal_entries: [], journal_entry_lines: [],
    }, { mfg_sales_orders: ['company_id'] });
    const out = await postSoPayment(sb, PAY() as never);
    expect(out).toMatchObject({ ok: false, status: 'so_read_failed' });
  });
});

describe('reverseSoPayment — a deleted payment leaves no live money behind', () => {
  it('writes the contra and flags the original', async () => {
    const sb = world();
    await postSoPayment(sb, PAY() as never);
    const out = await reverseSoPayment(sb, 'pay-1', 'SO-2608-001');
    expect(out).toMatchObject({ ok: true, status: 'reversed' });
    const rev = sb.tables.journal_entries.find((j) => j.source_type === 'SOPAY_REVERSAL')!;
    expect(rev.source_doc_no).toBe('pay-1');
    expect(sb.tables.journal_entries.find((j) => j.source_type === 'SOPAY')!.reversed).toBe(true);
  });

  it('nothing_to_reverse for a row that never posted (imported) — deleting it is not an error', async () => {
    const sb = world();
    const out = await reverseSoPayment(sb, 'pay-never-posted', 'SO-X');
    expect(out).toMatchObject({ ok: true, status: 'nothing_to_reverse' });
  });
});

describe('postSiPayment — the invoice-side twin', () => {
  const SI: Row = { id: 'si-1', invoice_number: 'HC-SI-2608-001', company_id: 1, debtor_code: 'C1', debtor_name: 'Ah Meng', migrated_no_stock: false };
  const siWorld = (si: Row = SI) => fakeSb({
    accounts: CHART, acc_account_roles: [], acc_acquirers: [],
    sales_invoices: [si], journal_entries: [], journal_entry_lines: [],
  });
  const SIPAY: Row = { id: 'sp-1', sales_invoice_id: 'si-1', paid_at: '2026-08-10', method: 'cash', merchant_provider: null, amount_sen: 1000, company_id: 1 };

  it('books Dr CASH / Cr AR against the invoice', async () => {
    const sb = siWorld();
    const out = await postSiPayment(sb, SIPAY as never);
    expect(out).toMatchObject({ ok: true, status: 'posted' });
    expect(sb.tables.journal_entries[0]).toMatchObject({ source_type: 'SIPAY', source_doc_no: 'sp-1' });
  });

  it('a MIGRATED invoice books nothing — its receivable lives in AutoCount', async () => {
    const sb = siWorld({ ...SI, migrated_no_stock: true });
    const out = await postSiPayment(sb, SIPAY as never);
    expect(out).toMatchObject({ ok: true, status: 'skipped_imported' });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });
});

describe('backfillSoPayments — converges, never double-posts', () => {
  it('posts unposted rows, skips posted and imported ones, and reports the shape', async () => {
    const sb = world({
      pays: [
        PAY(),
        PAY({ id: 'pay-2', method: 'cash' }),
        PAY({ id: 'pay-3', method: 'imported' }),
      ],
    });
    // pay-1 already posted once.
    await postSoPayment(sb, PAY() as never);
    const out = await backfillSoPayments(sb, 100);
    expect(out.ok).toBe(true);
    // pay-1 excluded by the pre-scan; imported rows excluded by the query.
    expect(out.scanned).toBe(1);
    expect(out.posted).toBe(1);
    expect(out.failed).toHaveLength(0);
    expect(out.remaining).toBe(0);
    // The ledger holds exactly two SOPAY entries — one per real payment.
    expect(sb.tables.journal_entries.filter((j) => j.source_type === 'SOPAY')).toHaveLength(2);
    // Second run: nothing left to do.
    const again = await backfillSoPayments(sb, 100);
    expect(again).toMatchObject({ ok: true, scanned: 0, posted: 0, remaining: 0 });
  });
});

/* ── The unbooked-payments panel ───────────────────────────────────────────
   Owner, asked whether the accounting page should say when a payment never
   reached the ledger: 要.

   What is pinned here is the CUTOFF, because it is the whole difference
   between a useful alarm and a silenced one. About 2,700 historical payments
   are deliberately unbooked (the owner's trial-period decision), and a panel
   that opened on 2,700 rows would be scrolled past on day one and every real
   failure with it. */

describe('payments that never reached the ledger', () => {
  const payRow = (id: string, docNo: string, paidAt: string, sen: number, method = 'merchant') => ({
    id, so_doc_no: docNo, paid_at: paidAt, amount_sen: sen, method, company_id: 1,
  });
  const je = (docNo: string, entryDate: string, over: Record<string, unknown> = {}) => ({
    id: `je-${docNo}`, je_no: `JE-${docNo}`, company_id: 1, source_type: 'SOPAY',
    source_doc_no: docNo, entry_date: entryDate, posted: true, reversed: false, ...over,
  });

  const world = (tables: Record<string, unknown[]>) => fakeSb({
    journal_entries: [], journal_entry_lines: [],
    mfg_sales_order_payments: [], sales_invoice_payments: [],
    ...tables,
  } as never);

  it('says nothing at all until this company has booked its FIRST payment', async () => {
    /* No entry anywhere: the module is not running here, so unbooked is the
       expected state for every row and listing them would be the noise. */
    const r = await unbookedPayments(world({
      mfg_sales_order_payments: [payRow('p1', 'SO-1', '2026-01-05', 50000)],
    }), 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.since).toBeNull();
    expect(r.rows).toHaveLength(0);
    /* …but it SAYS how much is sitting there (docs/bugs/0652): the card used to
       read "all of them" for a company whose hook had refused every payment. */
    expect(r.neverBooked).toEqual({ count: 1, totalSen: 50000, firstPaidOn: '2026-01-05', lastPaidOn: '2026-01-05' });
  });

  it('ignores everything dated before the first booked payment', async () => {
    const r = await unbookedPayments(world({
      journal_entries: [je('p2', '2026-08-01')],
      mfg_sales_order_payments: [
        payRow('old', 'SO-OLD', '2026-01-05', 900000),   // historical, deliberately unbooked
        payRow('p2', 'SO-2', '2026-08-01', 50000),       // booked
        payRow('p3', 'SO-3', '2026-08-05', 12345),       // NOT booked, and after the boundary
      ],
    }), 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.since).toBe('2026-08-01');
    expect(r.rows.map((x) => x.id)).toEqual(['p3']);
    expect(r.totalSen).toBe(12345);
  });

  /* The three the poster itself skips. Reporting them would be reporting as
     failures the rows it was told to leave alone. */
  it('does not report what the poster deliberately skips', async () => {
    const r = await unbookedPayments(world({
      journal_entries: [je('p2', '2026-08-01')],
      mfg_sales_order_payments: [
        payRow('p2', 'SO-2', '2026-08-01', 50000),
        payRow('imported', 'SO-4', '2026-08-05', 70000, 'imported'),
        payRow('zero', 'SO-5', '2026-08-05', 0),
        payRow('nodate', 'SO-6', '', 70000),
      ],
    }), 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(0);
  });

  /* A reversed entry is not a booking: the money is on the document and NOT in
     the books, which is exactly what this panel exists to find. */
  it('counts a payment whose only entry was reversed', async () => {
    const r = await unbookedPayments(world({
      journal_entries: [je('p2', '2026-08-01'), je('p3', '2026-08-05', { reversed: true })],
      mfg_sales_order_payments: [
        payRow('p2', 'SO-2', '2026-08-01', 50000),
        payRow('p3', 'SO-3', '2026-08-05', 12345),
      ],
    }), 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.id)).toEqual(['p3']);
  });

  it('covers invoice payments as well as order payments, oldest first', async () => {
    const r = await unbookedPayments(world({
      journal_entries: [je('p2', '2026-08-01')],
      mfg_sales_order_payments: [
        payRow('p2', 'SO-2', '2026-08-01', 50000),
        payRow('late', 'SO-9', '2026-08-20', 10000),
      ],
      sales_invoice_payments: [
        { id: 'q1', sales_invoice_id: 'INV-1', paid_at: '2026-08-10', amount_sen: 30000, method: 'merchant', company_id: 1 },
      ],
    }), 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.id)).toEqual(['q1', 'late']);
    expect(r.rows.map((x) => x.source)).toEqual(['SIPAY', 'SOPAY']);
    expect(r.totalSen).toBe(40000);
  });
});

/* ── The dry run (docs/bugs/0652) ──────────────────────────────────────────────
   The hook only ever logged its refusals to the console; 2990's 15 panel-path
   payments and 64 SO-create deposits never reached the books and nothing on a
   screen said why. The dry run answers with the gate's own checks, writing
   nothing. */
describe('dry run — would this post, and if not, why?', () => {
  it("answers would_post with the gate's own lines and writes nothing", async () => {
    const sb = world();
    const out = await postSoPayment(sb, PAY() as never, { dryRun: true });
    expect(out).toMatchObject({ ok: true, status: 'would_post', entryDate: '2026-08-10' });
    if (!out.ok || out.status !== 'would_post') return;
    expect(out.lines.map((l) => [l.accountCode, l.debitSen, l.creditSen])).toEqual([
      ['888-0000', 50000, 0],
      [DEFAULT_ROLE_CODES.AR, 0, 50000],
    ]);
    expect(sb.tables.journal_entries).toHaveLength(0);
    expect(sb.tables.journal_entry_lines).toHaveLength(0);
  });

  it('names the account the chart refuses — the reason the silent hook never surfaced', async () => {
    const sb = world({ acquirers: [{ company_id: 1, code: 'MBB', display_name: 'MBB', transit_account_code: '999-0000', is_active: true }] });
    const out = await postSoPayment(sb, PAY() as never, { dryRun: true });
    expect(out).toMatchObject({ ok: false, status: 'account_invalid' });
    expect(String((out as { reason?: string }).reason)).toContain('999-0000');
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  it('the backfill dry run reports every candidate with its verdict and posts none', async () => {
    const sb = world({ pays: [PAY(), PAY({ id: 'pay-2', method: 'cash' }), PAY({ id: 'pay-3', method: 'imported' })] });
    const out = await backfillSoPayments(sb, 100, { dryRun: true });
    expect(out).toMatchObject({ ok: true, dryRun: true, scanned: 2, posted: 0, wouldPost: 2, skipped: 0 });
    expect(out.rows.map((r) => [r.id, r.status, r.amountSen])).toEqual([['pay-1', 'would_post', 50000], ['pay-2', 'would_post', 50000]]);
    expect(sb.tables.journal_entries).toHaveLength(0);
    /* The real run afterwards posts exactly those two. */
    const real = await backfillSoPayments(sb, 100);
    expect(real).toMatchObject({ ok: true, dryRun: false, posted: 2, wouldPost: 0 });
    expect(sb.tables.journal_entries.filter((j) => j.source_type === 'SOPAY')).toHaveLength(2);
  });
});
