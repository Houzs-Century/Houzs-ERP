/* A bank charge counts toward what a statement has been paid.
 *
 * Public Bank's 2026-06-06 report nets RM 3,348.18; the bank credited
 * RM 3,024.18 and kept RM 324.00 as a terminal fee (docs/bugs/0787). Once that
 * charge is booked against the day, the credit of RM 3,024.18 is the WHOLE of
 * what is still owed on the statement — so the receipt for it must read as
 * "fully received", not leave RM 324.00 outstanding for ever, and a second
 * credit must be refused the way it is on any settled statement.
 */
import { describe, expect, it } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { loadBatchReceipts, postBatchReceipt } from './settlement';

const CHART: Row[] = ['310-0010', '326-0010', '300-0000'].map((code) => ({
  account_code: code, account_name: code, account_type: 'ASSET', parent_code: null, is_active: true, company_id: 2,
}));

const world = (chargeSen: number) => fakeSb({
  accounts: CHART,
  acc_account_roles: [],
  acc_acquirers: [{ company_id: 2, code: 'PBB', display_name: 'PBB', transit_account_code: '326-0010', fee_account_code: '900-T009', bank_account_code: '310-0010', is_active: true }],
  acc_settlement_batches: [{ id: 6, company_id: 2, acquirer_code: 'PBB', period_to: '2026-06-06', net_sen: 334_818, stated_net_sen: 334_818 }],
  acc_settlement_payout_batches: [{ id: 11, payout_id: 3, company_id: 2, settled_on: '2026-06-06', net_sen: 302_418, batch_id: 6, charge_sen: chargeSen, charge_account_code: chargeSen > 0 ? '900-T009' : null }],
  acc_settlement_receipts: [],
  journal_entries: [],
  journal_entry_lines: [],
}, {}, [], ['acc_settlement_receipts', 'acc_settlement_batches', 'acc_settlement_payout_batches']);

describe('a statement with a bank charge booked against its payout', () => {
  it('reports the charge beside the credits', async () => {
    const r = await loadBatchReceipts(world(32_400), 2, 6);
    expect(r).toMatchObject({ ok: true, receivedSen: 0, chargedSen: 32_400 });
  });

  it('takes the bank credit as the rest, and the statement is then fully received', async () => {
    const sb = world(32_400);
    const first = await postBatchReceipt(sb, 2, 6, { receivedOn: '2026-06-08', userName: 'Chew' });
    expect(first).toMatchObject({ ok: true, status: 'posted', amountSen: 302_418, outstandingSen: 0 });
    const again = await postBatchReceipt(sb, 2, 6, { receivedOn: '2026-06-09', userName: 'Chew' });
    expect(again.ok).toBe(false);
    expect(again.status).toBe('fully_received');
  });

  it('refuses a credit larger than what is left after the charge', async () => {
    const out = await postBatchReceipt(world(32_400), 2, 6, { receivedOn: '2026-06-08', amountSen: 334_818 });
    expect(out.ok).toBe(false);
    expect(out.status).toBe('over_receipt');
  });

  /* Without the charge the old arithmetic holds: the whole net is outstanding
     and the bank's short credit leaves RM 324.00 owing — the state this change
     exists to end, still reported honestly when no charge has been booked. */
  it('with no charge booked, the short credit leaves the difference outstanding', async () => {
    const out = await postBatchReceipt(world(0), 2, 6, { receivedOn: '2026-06-08', amountSen: 302_418 });
    expect(out).toMatchObject({ ok: true, outstandingSen: 32_400 });
  });
});
