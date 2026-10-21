// Deciding a merchant's open report lines again (acc/settlement-rematch).
// Owner 2026-10-21: 「全部做，Pinelabs=AEON，Public=PBB」 — the reports already
// uploaded are matched again under the new names (已经上传的报告也重新对一次).
//
// What is pinned:
//   • an open line whose sale was keyed under the merchant's other name is now
//     matched, with its link written;
//   • a stored link to the wrong payment is released and the right one taken
//     (PBB 16/09 RM 4,000, ref 213017: RM 3,500 keyed PBB vs RM 4,000 keyed Public);
//   • confirmed and set-aside lines are never touched;
//   • a payment one report takes is gone for the next;
//   • a second run changes nothing.
import { describe, expect, it } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { rematchOpenLines } from './settlement-rematch';

const acquirer = (code: string, soNames: string[]): Row => ({
  company_id: 1, code, display_name: code, so_names: soNames,
  transit_account_code: '326-0000', fee_account_code: '900-T009', bank_account_code: '310-0010',
  statement_format: 'CSV', has_unique_ref: true, fee_method: 'stated', date_tolerance_days: 7,
  column_map: null, is_active: true,
});
const line = (over: Row): Row => ({
  company_id: 1, fee_sen: 0, net_sen: 0, match_reason: null, notes: null, confirmed_at: null, ...over,
});
const pay = (over: Row): Row => ({ company_id: 1, method: 'merchant', ...over });

const world = (names: { AEON: string[]; PBB: string[] } = { AEON: ['Pinelabs'], PBB: ['Public'] }) => fakeSb(
  {
    acc_acquirers: [acquirer('AEON', names.AEON), acquirer('PBB', names.PBB)],
    acc_settlement_batches: [
      { id: 1, company_id: 1, acquirer_code: 'AEON', period_from: '2026-09-05', period_to: '2026-09-05' },
      { id: 2, company_id: 1, acquirer_code: 'AEON', period_from: '2026-09-06', period_to: '2026-09-06' },
      { id: 3, company_id: 1, acquirer_code: 'PBB', period_from: '2026-09-16', period_to: '2026-09-16' },
    ],
    acc_settlement_rows: [
      line({ id: 11, batch_id: 1, acquirer_code: 'AEON', line_no: 1, txn_date: '2026-09-05', ref: '090666', gross_sen: 700000, bucket: 'NEEDS_CONFIRM' }),
      line({ id: 12, batch_id: 1, acquirer_code: 'AEON', line_no: 2, txn_date: '2026-09-05', ref: '111111', gross_sen: 200000, bucket: 'MATCHED', match_reason: 'ref', confirmed_at: '2026-10-21T03:55:00Z' }),
      line({ id: 13, batch_id: 1, acquirer_code: 'AEON', line_no: 3, txn_date: '2026-09-05', ref: '222222', gross_sen: 300000, bucket: 'IGNORED' }),
      line({ id: 21, batch_id: 2, acquirer_code: 'AEON', line_no: 1, txn_date: '2026-09-06', ref: '333333', gross_sen: 700000, bucket: 'UNMATCHED' }),
      line({ id: 31, batch_id: 3, acquirer_code: 'PBB', line_no: 5, txn_date: '2026-09-16', ref: '213017', gross_sen: 400000, bucket: 'MATCHED', match_reason: 'ref', notes: 'Reference 213017 matches HC-SO-2609-097' }),
    ],
    acc_settlement_matches: [
      { id: 1, company_id: 1, settlement_row_id: 12, payment_source: 'SOPAY', payment_id: 'pC', doc_no: 'SO-C', amount_sen: 200000 },
      { id: 2, company_id: 1, settlement_row_id: 31, payment_source: 'SOPAY', payment_id: 'p97', doc_no: 'HC-SO-2609-097', amount_sen: 350000 },
    ],
    mfg_sales_order_payments: [
      pay({ id: 'pA', so_doc_no: 'SO-A', paid_at: '2026-09-05T11:00:00', amount_sen: 700000, approval_code: '090666', merchant_provider: 'Pinelabs' }),
      pay({ id: 'pC', so_doc_no: 'SO-C', paid_at: '2026-09-05T12:00:00', amount_sen: 200000, approval_code: '111111', merchant_provider: 'AEON' }),
      pay({ id: 'pD', so_doc_no: 'SO-D', paid_at: '2026-09-06T12:00:00', amount_sen: 700000, approval_code: null, method: 'imported', merchant_provider: null }),
      pay({ id: 'p97', so_doc_no: 'HC-SO-2609-097', paid_at: '2026-09-16T10:00:00', amount_sen: 350000, approval_code: '213017', merchant_provider: 'PBB' }),
      pay({ id: 'p98', so_doc_no: 'HC-SO-2609-098', paid_at: '2026-09-16T10:05:00', amount_sen: 400000, approval_code: '213017', merchant_provider: 'Public' }),
    ],
    mfg_sales_orders: [], sales_invoice_payments: [], sales_invoices: [],
  },
  {},
  [{ table: 'acc_settlement_matches', column: 'payment_id', name: 'acc_settlement_payment_once' }],
  ['acc_settlement_batches', 'acc_settlement_rows', 'acc_settlement_matches'],
);

const rowOf = (sb: ReturnType<typeof world>, id: number) => sb.tables.acc_settlement_rows.find((r) => r.id === id)!;
const linksOf = (sb: ReturnType<typeof world>, id: number) =>
  sb.tables.acc_settlement_matches.filter((l) => l.settlement_row_id === id).map((l) => l.payment_id);

describe('matching a merchant\'s open lines again', () => {
  it("takes the sale keyed under the merchant's other name, and leaves confirmed and set-aside lines alone", async () => {
    const sb = world();
    const r = await rematchOpenLines(sb, 1, 'AEON');
    expect(r).toEqual({ ok: true, acquirerCode: 'AEON', reports: 2, lines: 2, matched: 1, newlyMatched: 1, released: 0, failed: [] });
    expect(rowOf(sb, 11)).toMatchObject({ bucket: 'MATCHED', match_reason: 'ref', notes: 'Reference 090666 matches SO-A' });
    expect(linksOf(sb, 11)).toEqual(['pA']);
    /* Confirmed: the ledger's. Set aside: a person's decision. */
    expect(rowOf(sb, 12)).toMatchObject({ bucket: 'MATCHED', confirmed_at: '2026-10-21T03:55:00Z' });
    expect(linksOf(sb, 12)).toEqual(['pC']);
    expect(rowOf(sb, 13).bucket).toBe('IGNORED');
    /* pA was taken by the first report, so the second only offers what is left. */
    expect(rowOf(sb, 21).bucket).toBe('NEEDS_CONFIRM');
    expect(linksOf(sb, 21)).toEqual([]);
  });

  it('releases a link to the wrong payment and takes the right one — the 213017 line', async () => {
    const sb = world();
    const r = await rematchOpenLines(sb, 1, 'PBB');
    expect(r).toMatchObject({ ok: true, reports: 1, lines: 1, matched: 1, newlyMatched: 1, released: 0 });
    expect(linksOf(sb, 31)).toEqual(['p98']);
    expect(sb.tables.acc_settlement_matches.some((l) => l.payment_id === 'p97')).toBe(false);
    expect(rowOf(sb, 31)).toMatchObject({ bucket: 'MATCHED' });
    expect(String(rowOf(sb, 31).notes)).toContain('HC-SO-2609-098');
  });

  it('without the other name, a code on a different amount is released to a person — never left matched', async () => {
    const sb = world({ AEON: ['Pinelabs'], PBB: [] });
    const r = await rematchOpenLines(sb, 1, 'PBB');
    expect(r).toMatchObject({ ok: true, matched: 0, newlyMatched: 0, released: 1 });
    expect(rowOf(sb, 31).bucket).toBe('NEEDS_CONFIRM');
    expect(linksOf(sb, 31)).toEqual([]);
  });

  it('a second run changes nothing', async () => {
    const sb = world();
    await rematchOpenLines(sb, 1, 'AEON');
    await rematchOpenLines(sb, 1, 'PBB');
    const before = JSON.stringify([sb.tables.acc_settlement_rows, sb.tables.acc_settlement_matches]);
    expect(await rematchOpenLines(sb, 1, 'AEON')).toMatchObject({ ok: true, newlyMatched: 0, released: 0, matched: 1 });
    expect(await rematchOpenLines(sb, 1, 'PBB')).toMatchObject({ ok: true, newlyMatched: 0, released: 0, matched: 1 });
    /* Same answers, same links; only the update stamps could differ, and none were written. */
    expect(JSON.stringify([sb.tables.acc_settlement_rows, sb.tables.acc_settlement_matches])).toBe(before);
  });

  it('a merchant this company has not set up is refused by name', async () => {
    const r = await rematchOpenLines(world(), 1, 'GHL');
    expect(r).toEqual({ ok: false, reason: 'GHL is not set up for this company.' });
  });
});
