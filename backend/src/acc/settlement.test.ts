// What this file pins — the entry 系统3 never wrote:
//   • confirming a settlement posts Dr bank + Dr fee / Cr in-transit THAT
//     MOMENT, so the card fee reaches the P&L and 320-0000 actually empties;
//   • a selection that does not add up to the statement line is REFUSED with
//     the difference named, never absorbed;
//   • a payment another line already cleared cannot be cleared again;
//   • confirming twice books once;
//   • a refund line walks back out of the same three accounts.

import { describe, it, expect } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { loadAcquirer, loadPaymentCandidates, loadSettledKeys, confirmSettlementRow } from './settlement';

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

const world = (over: Record<string, Row[]> = {}) => fakeSb(
  {
    accounts: CHART,
    acc_account_roles: [],
    acc_acquirers: [ACQUIRER],
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

describe('confirmSettlementRow — the moment of confirmation IS the moment of posting', () => {
  it('books Dr bank + Dr fee / Cr in-transit and stamps the line', async () => {
    const sb = world();
    const r = await confirmSettlementRow(sb, { companyId: 1, rowId: 7, payments: ONE_PAYMENT, matchReason: 'ref', userName: 'Ah Chew' });
    expect(r).toMatchObject({ ok: true, status: 'confirmed' });

    const lines = sb.tables.journal_entry_lines;
    expect(lines).toHaveLength(3);
    expect(lines.find((l) => l.account_code === '330-0000')).toMatchObject({ debit_sen: 98500 });
    expect(lines.find((l) => l.account_code === '930-0000')).toMatchObject({ debit_sen: 1500 });
    expect(lines.find((l) => l.account_code === '320-0000')).toMatchObject({ credit_sen: 100000 });

    const je = sb.tables.journal_entries[0];
    expect(je).toMatchObject({ source_type: 'SETTLE', source_doc_no: 'SETTLE-7', entry_date: '2026-08-03' });

    const stamped = sb.tables.acc_settlement_rows[0];
    expect(stamped).toMatchObject({ bucket: 'MATCHED', confirmed_by: 'Ah Chew', posted_je_no: je.je_no });
    expect(sb.tables.acc_settlement_matches).toHaveLength(1);
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

  it('a refund line walks back out of the same three accounts', async () => {
    const sb = world({
      acc_settlement_rows: [{ ...SETTLEMENT_ROW, id: 8, gross_sen: -50000, fee_sen: 750, net_sen: -49250, ref: 'R1' }],
    });
    const r = await confirmSettlementRow(sb, {
      companyId: 1, rowId: 8, matchReason: 'manual', userName: null,
      payments: [{ source: 'SOPAY', id: 'r1', docNo: 'SO-9', amountSen: -50000 }],
    });
    expect(r).toMatchObject({ ok: true, status: 'confirmed' });
    const lines = sb.tables.journal_entry_lines;
    expect(lines.find((l) => l.account_code === '330-0000')).toMatchObject({ credit_sen: 49250 });
    expect(lines.find((l) => l.account_code === '930-0000')).toMatchObject({ credit_sen: 750 });
    expect(lines.find((l) => l.account_code === '320-0000')).toMatchObject({ debit_sen: 50000 });
  });

  it('an unconfigured receiving bank books to the company default rather than nowhere', async () => {
    const sb = world({ acc_acquirers: [{ ...ACQUIRER, bank_account_code: null }] });
    const r = await confirmSettlementRow(sb, { companyId: 1, rowId: 7, payments: ONE_PAYMENT, matchReason: 'ref', userName: null });
    expect(r).toMatchObject({ ok: true, status: 'confirmed' });
    expect(sb.tables.journal_entry_lines.find((l) => l.debit_sen === 98500)).toMatchObject({ account_code: '330-0000' });
  });
});
