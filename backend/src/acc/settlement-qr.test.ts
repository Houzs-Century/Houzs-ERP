// What this file pins — a DuitNow QR line on a merchant report (owner
// 2026-11-09: 这个hlbb merchant 的0000PP 是qr direct 去bank 的，不算卡机的):
//   • its sale is the ONLINE payment the till keyed for it, never card money —
//     offered by the loader, found by "Find the sale", and the only kind its
//     confirm accepts;
//   • linking it books NOTHING: no fee, no move between clearing accounts, no
//     bank stamped on the payment — the sale already put the money in the bank;
//   • a card line still takes card money only;
//   • taking the link back releases the payment and reverses nothing;
//   • the report owes nothing through the acquirer's clearing account, so the
//     bank's QR credit can never be booked against it as a card payout.

import { describe, it, expect } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import {
  confirmSettlementGroup, confirmSettlementRow, findPaymentsForRow, loadPaymentCandidates,
  postBatchReceipt, unconfirmSettlementRow,
} from './settlement';

const CHART: Row[] = ['326-0000', '326-0040', '310-0020', '900-T009'].map((code) => ({
  account_code: code, account_name: code, account_type: 'ASSET', parent_code: null, is_active: true, company_id: 2,
}));

const HLB: Row = {
  company_id: 2, code: 'HLB', display_name: 'HLB',
  transit_account_code: '326-0040', fee_account_code: '900-T009', bank_account_code: '310-0020',
  statement_format: 'CSV', has_unique_ref: true, fee_method: 'stated',
  date_tolerance_days: 7, column_map: null, is_active: true,
};

/* 2990's 00005992284_20261101.CSV: 31/10 RM 3,240 and 01/11 RM 100, both QR —
   and, for the mixing case, a card line of another report. */
const QR_ROW: Row = {
  id: 857, batch_id: 389, company_id: 2, acquirer_code: 'HLB', line_no: 23,
  txn_date: '2026-10-31', ref: null, gross_sen: 324000, fee_sen: 0, net_sen: 324000,
  bucket: 'NEEDS_CONFIRM', match_reason: 'amount+date', confirmed_at: null, posted_je_no: null, channel: 'QR',
};
const QR_ROW_2: Row = { ...QR_ROW, id: 856, line_no: 18, txn_date: '2026-11-01', gross_sen: 10000, net_sen: 10000 };
const CARD_ROW: Row = {
  id: 853, batch_id: 389, company_id: 2, acquirer_code: 'HLB', line_no: 17,
  txn_date: '2026-11-01', ref: '843041', gross_sen: 162000, fee_sen: 1620, net_sen: 160380,
  bucket: 'NEEDS_CONFIRM', match_reason: null, confirmed_at: null, posted_je_no: null, channel: null,
};

const QR_BATCH: Row = {
  id: 389, company_id: 2, acquirer_code: 'HLB', file_name: '00005992284_20261101.CSV',
  period_from: '2026-10-31', period_to: '2026-11-01',
  gross_sen: 0, fee_sen: 0, net_sen: 0, stated_net_sen: null, adjustment_sen: 0,
};

const PAYMENTS: Row[] = [
  /* The QR sale, keyed Online with the QR's own code. */
  { id: 'jenny', so_doc_no: '2990-SO-2611-041', company_id: 2, paid_at: '2026-11-07', amount_sen: 324000, approval_code: '20261031HLBBMYKLA30OQR77370349', method: 'transfer', merchant_provider: null, account_sheet: 'Bank transfer' },
  /* The old guess: a card instalment keyed with no bank. */
  { id: 'how', so_doc_no: '2990-SO-2611-042', company_id: 2, paid_at: '2026-11-07', amount_sen: 324000, approval_code: '078120', method: 'installment', merchant_provider: null, account_sheet: 'Card terminal' },
  { id: 'cash', so_doc_no: '2990-SO-2611-050', company_id: 2, paid_at: '2026-11-01', amount_sen: 10000, approval_code: null, method: 'cash', merchant_provider: null, account_sheet: 'Cash' },
  { id: 'small', so_doc_no: '2990-SO-2611-051', company_id: 2, paid_at: '2026-11-01', amount_sen: 10000, approval_code: null, method: 'transfer', merchant_provider: null, account_sheet: 'Bank transfer' },
];

const world = (over: Record<string, Row[]> = {}) => fakeSb(
  {
    accounts: CHART,
    acc_account_roles: [],
    acc_acquirers: [HLB],
    acc_settlement_batches: [{ ...QR_BATCH }],
    acc_settlement_rows: [{ ...QR_ROW }, { ...QR_ROW_2 }, { ...CARD_ROW }],
    acc_settlement_matches: [],
    acc_settlement_receipts: [],
    acc_settlement_payout_batches: [],
    mfg_sales_order_payments: PAYMENTS.map((p) => ({ ...p })),
    mfg_sales_orders: [],
    sales_invoice_payments: [],
    mfg_so_audit_log: [],
    journal_entries: [],
    journal_entry_lines: [],
    ...over,
  },
  {},
  [{ table: 'acc_settlement_matches', column: 'payment_id', name: 'acc_settlement_payment_once' }],
  ['acc_settlement_batches', 'acc_settlement_rows', 'acc_settlement_matches', 'acc_settlement_receipts'],
);

const JENNY = [{ source: 'SOPAY' as const, id: 'jenny', docNo: '2990-SO-2611-041', amountSen: 324000 }];
const HOW = [{ source: 'SOPAY' as const, id: 'how', docNo: '2990-SO-2611-042', amountSen: 324000 }];

describe('loadPaymentCandidates — the Online pool a QR line is matched against', () => {
  it('takes Online payments only: not card, not cash', async () => {
    const r = await loadPaymentCandidates(world(), 2, { display_name: 'HLB', date_tolerance_days: 7 }, '2026-10-31', '2026-11-01', [], { online: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payments.map((p) => p.id).sort()).toEqual(['jenny', 'small']);
  });
});

describe('confirmSettlementRow — a QR line links its Online sale and books nothing', () => {
  it('links Jenny\'s Online payment: no entry, no bank stamped, the line confirmed', async () => {
    const sb = world();
    const r = await confirmSettlementRow(sb, { companyId: 2, rowId: 857, payments: JENNY, matchReason: 'manual', userName: 'Chew' });
    expect(r).toMatchObject({ ok: true, status: 'confirmed' });
    expect(sb.tables.journal_entries).toEqual([]);
    expect(sb.tables.journal_entry_lines).toEqual([]);
    expect(sb.tables.mfg_sales_order_payments.find((p) => p.id === 'jenny')).toMatchObject({ merchant_provider: null, account_sheet: 'Bank transfer' });
    expect(sb.tables.acc_settlement_matches).toEqual([expect.objectContaining({ settlement_row_id: 857, payment_source: 'SOPAY', payment_id: 'jenny', amount_sen: 324000 })]);
    expect(sb.tables.acc_settlement_rows.find((x) => x.id === 857)).toMatchObject({ bucket: 'MATCHED', posted_je_no: null, confirmed_by: 'Chew' });
    expect(sb.tables.acc_settlement_rows.find((x) => x.id === 857)!.confirmed_at).toBeTruthy();
  });

  it('refuses a card payment, saying a QR sale is keyed Online', async () => {
    const sb = world();
    const r = await confirmSettlementRow(sb, { companyId: 2, rowId: 857, payments: HOW, matchReason: 'manual', userName: 'Chew' });
    expect(r).toMatchObject({ ok: false, status: 'not_online_payment' });
    expect((r as { reason: string }).reason).toMatch(/2990-SO-2611-042/);
    expect((r as { reason: string }).reason).toMatch(/Online/);
    expect(sb.tables.acc_settlement_matches).toEqual([]);
  });

  it('a card line still refuses Online money', async () => {
    const sb = world();
    const r = await confirmSettlementRow(sb, {
      companyId: 2, rowId: 853, payments: [{ source: 'SOPAY', id: 'jenny', docNo: '2990-SO-2611-041', amountSen: 324000 }], matchReason: 'manual', userName: 'Chew',
    });
    expect(r).toMatchObject({ ok: false, status: 'not_card_payment' });
  });

  it('taking the link back releases the payment and reverses nothing', async () => {
    const sb = world();
    await confirmSettlementRow(sb, { companyId: 2, rowId: 857, payments: JENNY, matchReason: 'manual', userName: 'Chew' });
    const back = await unconfirmSettlementRow(sb, 2, 857);
    expect(back).toMatchObject({ ok: true, status: 'unconfirmed' });
    expect(sb.tables.acc_settlement_matches).toEqual([]);
    expect(sb.tables.journal_entries).toEqual([]);
    expect(sb.tables.acc_settlement_rows.find((x) => x.id === 857)).toMatchObject({ bucket: 'NEEDS_CONFIRM', confirmed_at: null });
  });
});

describe('confirmSettlementGroup — QR lines together', () => {
  it('two QR lines paid by Online sales link together and book nothing', async () => {
    const sb = world();
    const r = await confirmSettlementGroup(sb, {
      companyId: 2, rowIds: [857, 856], userName: 'Chew',
      payments: [...JENNY, { source: 'SOPAY', id: 'small', docNo: '2990-SO-2611-051', amountSen: 10000 }],
    });
    expect(r).toMatchObject({ ok: true, status: 'confirmed' });
    expect(sb.tables.journal_entries).toEqual([]);
    expect(sb.tables.acc_settlement_matches.map((m) => m.payment_id).sort()).toEqual(['jenny', 'small']);
  });

  it('a QR line is never matched together with a card line', async () => {
    const sb = world();
    const r = await confirmSettlementGroup(sb, { companyId: 2, rowIds: [857, 853], userName: 'Chew', payments: JENNY });
    expect(r).toMatchObject({ ok: false, status: 'mixed_qr_and_card' });
    expect(sb.tables.acc_settlement_matches).toEqual([]);
  });
});

describe('findPaymentsForRow — "Find the sale" on a QR line searches Online money', () => {
  it('lists the Online payments, the exact amount first, and no card payment', async () => {
    const out = await findPaymentsForRow(world(), 2, 857, '');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payments.map((p) => p.id)).toEqual(['jenny', 'small']);
    expect(out.payments[0]).toMatchObject({ possible: true, method: 'transfer' });
  });

  it('a card line still searches card money only', async () => {
    const out = await findPaymentsForRow(world(), 2, 853, '');
    expect(out.ok && out.payments.map((p) => p.id)).toEqual(['how']);
  });
});

describe('postBatchReceipt — a QR report is never paid out through the clearing account', () => {
  it('refuses to book the bank\'s QR credit against it, and says where the money is', async () => {
    const sb = world();
    const r = await postBatchReceipt(sb, 2, 389, { receivedOn: '2026-11-02', amountSen: 334000, bankAccountCode: '310-0020' });
    expect(r).toMatchObject({ ok: false, status: 'qr_report' });
    expect((r as { reason: string }).reason).toMatch(/QR/);
    expect(sb.tables.journal_entries).toEqual([]);
    expect(sb.tables.acc_settlement_receipts).toEqual([]);
  });
});
