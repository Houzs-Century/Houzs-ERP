// What this file pins — the entry 系统3 never wrote, in the TWO steps the owner
// says the money actually moves in ("全部卡机都是隔几天收到的。应该是先对卡机
// 报告，然后 match 了就会去 match bank statement"):
//   • confirming a settlement posts the FEE that moment (Dr fee / Cr in-transit),
//     so the card fee reaches the P&L and stops being receivable;
//   • the bank leg is a SEPARATE entry, dated by the bank, and only that one
//     empties what the acquirer still owed;
//   • the two together take 320-0000 to exactly zero;
//   • a selection that does not add up to the statement line is REFUSED with
//     the difference named, never absorbed;
//   • a payment another line already cleared cannot be cleared again;
//   • confirming twice books once, and so does receiving twice.

import { describe, it, expect } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import {
  loadAcquirer, loadPaymentCandidates, loadSettledKeys, confirmSettlementRow,
  postStatementCharge, postBatchReceipt,
} from './settlement';

const CHART: Row[] = ['320-0000', '330-0000', '930-0000'].map((code) => ({
  account_code: code, account_name: code, account_type: 'ASSET', parent_code: null, is_active: true, company_id: 1,
}));

const ACQUIRER: Row = {
  company_id: 1, code: 'MBB', display_name: 'MBB',
  transit_account_code: '320-0000', fee_account_code: '930-0000', bank_account_code: '330-0000',
  statement_format: 'CSV', has_unique_ref: true, fee_method: 'stated',
  date_tolerance_days: 3, column_map: null, is_active: true,
};

const SETTLEMENT_ROW: Row = {
  id: 7, batch_id: 1, company_id: 1, acquirer_code: 'MBB', line_no: 2,
  txn_date: '2026-08-03', ref: 'A1', gross_sen: 100000, fee_sen: 1500, net_sen: 98500,
  bucket: 'MATCHED', match_reason: 'ref', confirmed_at: null, posted_je_no: null,
};

/** The statement the row above came off: one line, paying its net. */
const BATCH: Row = {
  id: 1, company_id: 1, acquirer_code: 'MBB', period_from: '2026-08-03', period_to: '2026-08-03',
  gross_sen: 100000, fee_sen: 1500, net_sen: 98500, stated_net_sen: null,
  adjustment_sen: 0, received_on: null, receipt_je_no: null,
};

const world = (over: Record<string, Row[]> = {}) => fakeSb(
  {
    accounts: CHART,
    acc_account_roles: [],
    acc_acquirers: [ACQUIRER],
    acc_settlement_batches: [{ ...BATCH }],
    acc_settlement_rows: [{ ...SETTLEMENT_ROW }],
    acc_settlement_matches: [],
    journal_entries: [],
    journal_entry_lines: [],
    ...over,
  },
  {},
  [{ table: 'acc_settlement_matches', column: 'payment_id', name: 'acc_settlement_payment_once' }],
);

const ONE_PAYMENT = [{ source: 'SOPAY' as const, id: 'p1', docNo: 'SO-2608-001', amountSen: 100000 }];

/** What an account holds after everything posted, debits positive. */
const balance = (sb: { tables: Record<string, Row[]> }, code: string) =>
  sb.tables.journal_entry_lines
    .filter((l) => l.account_code === code)
    .reduce((s, l) => s + Number(l.debit_sen ?? 0) - Number(l.credit_sen ?? 0), 0);

describe('loadAcquirer', () => {
  it('reads the company/global join, and names an acquirer this company does not use', async () => {
    const sb = world();
    const ok = await loadAcquirer(sb, 1, 'MBB');
    expect(ok.ok && ok.acquirer.transit_account_code).toBe('320-0000');
    const missing = await loadAcquirer(sb, 1, 'GHL');
    expect(missing).toMatchObject({ ok: false });
  });
});

describe('loadPaymentCandidates', () => {
  it('takes card money from BOTH sales panels, and leaves cash and transfers alone', async () => {
    const sb = world({
      mfg_sales_order_payments: [
        { id: 'p1', so_doc_no: 'SO-1', paid_at: '2026-08-01T10:00:00', amount_centi: 100000, approval_code: 'A1', method: 'merchant', merchant_provider: 'MBB', company_id: 1 },
        { id: 'p2', so_doc_no: 'SO-2', paid_at: '2026-08-01T11:00:00', amount_centi: 500, approval_code: null, method: 'cash', merchant_provider: 'MBB', company_id: 1 },
      ],
      sales_invoice_payments: [
        { id: 'q1', sales_invoice_id: 'INV-9', paid_at: '2026-08-02T09:00:00', amount_centi: 2500, approval_code: 'B7', method: 'installment', merchant_provider: 'MBB', company_id: 1 },
      ],
    });
    const r = await loadPaymentCandidates(sb, 1, { display_name: 'MBB', date_tolerance_days: 3 }, '2026-08-01', '2026-08-03');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payments.map((p) => p.id).sort()).toEqual(['p1', 'q1']);
    expect(r.payments.find((p) => p.id === 'q1')).toMatchObject({ source: 'SIPAY', paidOn: '2026-08-02', amountSen: 2500 });
  });

  it('fails closed when the read does not answer', async () => {
    const sb = fakeSb({ mfg_sales_order_payments: [], sales_invoice_payments: [] }, { mfg_sales_order_payments: ['approval_code'] });
    const r = await loadPaymentCandidates(sb, 1, { display_name: 'MBB', date_tolerance_days: 3 }, '2026-08-01', '2026-08-03');
    expect(r.ok).toBe(false);
  });
});

describe('loadSettledKeys', () => {
  it('keys every already-cleared payment, and fails closed on a blip', async () => {
    const sb = world({ acc_settlement_matches: [{ company_id: 1, payment_source: 'SOPAY', payment_id: 'p9' }] });
    const r = await loadSettledKeys(sb, 1);
    expect(r.ok && [...r.keys]).toEqual(['SOPAY:p9']);

    const blip = fakeSb({ acc_settlement_matches: [] }, { acc_settlement_matches: ['payment_id'] });
    expect((await loadSettledKeys(blip, 1)).ok).toBe(false);
  });
});

describe('confirmSettlementRow — reconciling the card machine books the FEE, and only the fee', () => {
  it('books Dr fee / Cr in-transit on the transaction date, and stamps the line', async () => {
    const sb = world();
    const r = await confirmSettlementRow(sb, { companyId: 1, rowId: 7, payments: ONE_PAYMENT, matchReason: 'ref', userName: 'Ah Chew' });
    expect(r).toMatchObject({ ok: true, status: 'confirmed' });

    const lines = sb.tables.journal_entry_lines;
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.account_code === '930-0000')).toMatchObject({ debit_sen: 1500 });
    expect(lines.find((l) => l.account_code === '320-0000')).toMatchObject({ credit_sen: 1500 });
    /* The bank is NOT touched here: the money is still with the acquirer on
       this day, and saying otherwise is the lie the owner caught. */
    expect(lines.some((l) => l.account_code === '330-0000')).toBe(false);

    const je = sb.tables.journal_entries[0];
    expect(je).toMatchObject({ source_type: 'SETTLE', source_doc_no: 'SETTLE-7', entry_date: '2026-08-03' });

    const stamped = sb.tables.acc_settlement_rows[0];
    expect(stamped).toMatchObject({ bucket: 'MATCHED', confirmed_by: 'Ah Chew', posted_je_no: je.je_no });
    expect(sb.tables.acc_settlement_matches).toHaveLength(1);
  });

  /* A line the acquirer charged nothing for. There is nothing to book — the
     whole gross is still owed — and the line must still confirm, or the batch
     can never be finished. */
  it('a fee-free line confirms with no journal entry at all', async () => {
    const sb = world({ acc_settlement_rows: [{ ...SETTLEMENT_ROW, fee_sen: 0, net_sen: 100000 }] });
    const r = await confirmSettlementRow(sb, { companyId: 1, rowId: 7, payments: ONE_PAYMENT, matchReason: 'ref', userName: null });
    expect(r).toMatchObject({ ok: true, status: 'confirmed' });
    expect(r).not.toHaveProperty('jeNo');
    expect(sb.tables.journal_entries).toHaveLength(0);
    expect(sb.tables.acc_settlement_rows[0]).toMatchObject({ bucket: 'MATCHED', posted_je_no: null });
  });

  it('refuses a selection that does not add up, and names the difference', async () => {
    const sb = world();
    const r = await confirmSettlementRow(sb, {
      companyId: 1, rowId: 7, matchReason: 'manual', userName: null,
      payments: [{ source: 'SOPAY', id: 'p1', docNo: 'SO-1', amountSen: 90000 }],
    });
    expect(r).toMatchObject({ ok: false, status: 'amount_mismatch' });
    expect((r as { reason: string }).reason).toMatch(/-100\.00/);
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  it('refuses to clear in-transit money that has no sale behind it', async () => {
    const sb = world();
    const r = await confirmSettlementRow(sb, { companyId: 1, rowId: 7, payments: [], matchReason: 'manual', userName: null });
    expect(r).toMatchObject({ ok: false, status: 'no_payments' });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  it('a payment another line already cleared cannot be cleared twice', async () => {
    const sb = world({ acc_settlement_matches: [{ settlement_row_id: 99, company_id: 1, payment_source: 'SOPAY', payment_id: 'p1', amount_sen: 100000 }] });
    const r = await confirmSettlementRow(sb, { companyId: 1, rowId: 7, payments: ONE_PAYMENT, matchReason: 'ref', userName: null });
    expect(r).toMatchObject({ ok: false, status: 'payment_already_settled' });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  it('confirming twice books once', async () => {
    const sb = world();
    await confirmSettlementRow(sb, { companyId: 1, rowId: 7, payments: ONE_PAYMENT, matchReason: 'ref', userName: null });
    const again = await confirmSettlementRow(sb, { companyId: 1, rowId: 7, payments: ONE_PAYMENT, matchReason: 'ref', userName: null });
    expect(again).toMatchObject({ ok: true, status: 'already_confirmed' });
    expect(sb.tables.journal_entries).toHaveLength(1);
  });

  it('a line set aside is not silently confirmable', async () => {
    const sb = world({ acc_settlement_rows: [{ ...SETTLEMENT_ROW, bucket: 'IGNORED' }] });
    const r = await confirmSettlementRow(sb, { companyId: 1, rowId: 7, payments: ONE_PAYMENT, matchReason: 'manual', userName: null });
    expect(r).toMatchObject({ ok: false, status: 'ignored' });
  });

  /* A refunded sale whose fee the acquirer gives back: the fee walks out of the
     P&L and back into what is receivable, the same two accounts, reversed. */
  it('a rebated fee books the other way round', async () => {
    const sb = world({
      acc_settlement_rows: [{ ...SETTLEMENT_ROW, id: 8, gross_sen: -50000, fee_sen: -750, net_sen: -49250, ref: 'R1' }],
    });
    const r = await confirmSettlementRow(sb, {
      companyId: 1, rowId: 8, matchReason: 'manual', userName: null,
      payments: [{ source: 'SOPAY', id: 'r1', docNo: 'SO-9', amountSen: -50000 }],
    });
    expect(r).toMatchObject({ ok: true, status: 'confirmed' });
    const lines = sb.tables.journal_entry_lines;
    expect(lines.find((l) => l.account_code === '930-0000')).toMatchObject({ credit_sen: 750 });
    expect(lines.find((l) => l.account_code === '320-0000')).toMatchObject({ debit_sen: 750 });
  });
});

describe('postBatchReceipt — the money actually arrives', () => {
  it('books Dr bank / Cr in-transit on the BANK date, once, and stamps the batch', async () => {
    const sb = world();
    const r = await postBatchReceipt(sb, 1, 1, '2026-08-07');
    expect(r).toMatchObject({ ok: true, status: 'posted', amountSen: 98500 });

    const lines = sb.tables.journal_entry_lines;
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.account_code === '330-0000')).toMatchObject({ debit_sen: 98500 });
    expect(lines.find((l) => l.account_code === '320-0000')).toMatchObject({ credit_sen: 98500 });
    /* Dated by the bank, four days after the swipe — the whole point of
       splitting the entry in two. */
    expect(sb.tables.journal_entries[0]).toMatchObject({
      source_type: 'SETTLEBANK', source_doc_no: 'SETTLEBANK-1', entry_date: '2026-08-07',
    });
    expect(sb.tables.acc_settlement_batches[0]).toMatchObject({
      received_on: '2026-08-07', receipt_je_no: sb.tables.journal_entries[0].je_no,
    });

    const again = await postBatchReceipt(sb, 1, 1, '2026-08-07');
    expect(again).toMatchObject({ ok: true, status: 'already_posted' });
    expect(sb.tables.journal_entries).toHaveLength(1);
  });

  /* What the acquirer SAYS it is paying wins over what its lines add up to —
     AEON prints 5,673.84 under lines that come to 5,928.00, and 5,673.84 is
     what the bank will show. */
  it('pays what the statement says it pays, not what its lines come to', async () => {
    const sb = world({
      acc_settlement_batches: [{ ...BATCH, net_sen: 592800, stated_net_sen: 567384, adjustment_sen: 25416 }],
    });
    const r = await postBatchReceipt(sb, 1, 1, '2026-08-10');
    expect(r).toMatchObject({ ok: true, amountSen: 567384 });
    expect(sb.tables.journal_entry_lines.find((l) => l.account_code === '330-0000')).toMatchObject({ debit_sen: 567384 });
  });

  it('refuses a date it was not given, rather than stamping today', async () => {
    const sb = world();
    expect(await postBatchReceipt(sb, 1, 1, '')).toMatchObject({ ok: false, status: 'bad_date' });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  it('names a batch that is not there', async () => {
    const sb = world();
    expect(await postBatchReceipt(sb, 1, 404, '2026-08-07')).toMatchObject({ ok: false, status: 'not_found' });
  });

  it('an unconfigured receiving bank books to the company default rather than nowhere', async () => {
    const sb = world({ acc_acquirers: [{ ...ACQUIRER, bank_account_code: null }] });
    expect(await postBatchReceipt(sb, 1, 1, '2026-08-07')).toMatchObject({ ok: true });
    expect(sb.tables.journal_entry_lines.find((l) => l.debit_sen === 98500)).toMatchObject({ account_code: '330-0000' });
  });

  /* THE WHOLE LOOP, on the owner's own numbers. The customer's 1,000.00 was
     booked to in-transit against AR when it was collected (phase 2A). The card
     machine is reconciled on the 3rd; the money lands on the 7th. */
  it('reconciling then receiving takes settlement-in-transit to exactly zero', async () => {
    const sb = world({
      journal_entry_lines: [
        { account_code: '320-0000', debit_sen: 100000, credit_sen: 0 },
        { account_code: '300-0000', debit_sen: 0, credit_sen: 100000 },
      ],
    });
    expect(balance(sb, '320-0000')).toBe(100000);

    await confirmSettlementRow(sb, { companyId: 1, rowId: 7, payments: ONE_PAYMENT, matchReason: 'ref', userName: null });
    /* In between, in-transit holds exactly what MBB still owes — the fee is
       already lost and is no longer receivable. */
    expect(balance(sb, '320-0000')).toBe(98500);
    expect(balance(sb, '930-0000')).toBe(1500);

    await postBatchReceipt(sb, 1, 1, '2026-08-07');
    expect(balance(sb, '320-0000')).toBe(0);
    expect(balance(sb, '330-0000')).toBe(98500);
  });
});

describe('postStatementCharge — what the statement kept, that no transaction explains', () => {
  /* AEON's subvention fee (owner: it comes off Pine Labs and is a merchant
     charge like any other). The acquirer is never going to pay it, so it comes
     out of what it owes — in-transit — exactly like a per-line fee. */
  it('books Dr fee / Cr in-transit, once, and stamps the batch', async () => {
    const sb = world({
      acc_settlement_batches: [{
        id: 3, company_id: 1, acquirer_code: 'MBB', period_to: '2026-08-14',
        adjustment_sen: 25416, adjustment_je_no: null,
      }],
    });
    const r = await postStatementCharge(sb, 1, 3);
    expect(r).toMatchObject({ ok: true, status: 'posted' });

    const lines = sb.tables.journal_entry_lines;
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.account_code === '930-0000')).toMatchObject({ debit_sen: 25416 });
    expect(lines.find((l) => l.account_code === '320-0000')).toMatchObject({ credit_sen: 25416 });
    expect(sb.tables.journal_entries[0]).toMatchObject({ source_type: 'SETTLEADJ', source_doc_no: 'SETTLEADJ-3', entry_date: '2026-08-14' });
    expect(sb.tables.acc_settlement_batches[0].adjustment_je_no).toBe(sb.tables.journal_entries[0].je_no);

    const again = await postStatementCharge(sb, 1, 3);
    expect(again).toMatchObject({ ok: true, status: 'already_posted' });
    expect(sb.tables.journal_entries).toHaveLength(1);
  });

  it('a statement that pays exactly what its lines come to books nothing', async () => {
    const sb = world({
      acc_settlement_batches: [{ id: 4, company_id: 1, acquirer_code: 'MBB', period_to: '2026-08-14', adjustment_sen: 0 }],
    });
    expect(await postStatementCharge(sb, 1, 4)).toMatchObject({ ok: true, status: 'nothing_to_post' });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  it('a statement that paid MORE than its lines books the other way round', async () => {
    const sb = world({
      acc_settlement_batches: [{ id: 5, company_id: 1, acquirer_code: 'MBB', period_to: '2026-08-14', adjustment_sen: -5000 }],
    });
    expect(await postStatementCharge(sb, 1, 5)).toMatchObject({ ok: true, status: 'posted' });
    const lines = sb.tables.journal_entry_lines;
    expect(lines.find((l) => l.account_code === '320-0000')).toMatchObject({ debit_sen: 5000 });
    expect(lines.find((l) => l.account_code === '930-0000')).toMatchObject({ credit_sen: 5000 });
  });
});
