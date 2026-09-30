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
import { loadBatchReceipts, postBatchReceipt, undoBatchReceipt } from './settlement';

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

/* A charge KEPT OFF A CREDIT (owner 2026-09-30: 这个RM54 是charges 来的，和之前
 * 的public bank一样 → 做). GHL paid 2990 RM 3,128.40 on 2026-09-02 for its
 * 2026-08-29 report netting RM 3,182.40, and sends no advice — so the RM 54.00
 * rides the credit: booked with it, to the account Finance picks, dated the
 * report's settlement day, and taken back with it. */
const GHL_CHART: Row[] = [
  { account_code: '310-0020', account_name: 'HLB', account_type: 'ASSET', parent_code: null, is_active: true, company_id: 2 },
  { account_code: '326-0030', account_name: 'GHL IN TRANSIT', account_type: 'ASSET', parent_code: null, is_active: true, company_id: 2 },
  { account_code: '900-0000', account_name: 'OPERATING EXPENSES', account_type: 'EXPENSE', parent_code: null, is_active: true, company_id: 2 },
  { account_code: '900-T003', account_name: 'TERMINAL RENTAL CHARGES', account_type: 'EXPENSE', parent_code: '900-0000', is_active: true, company_id: 2 },
];
const ghlWorld = () => fakeSb({
  accounts: GHL_CHART,
  acc_account_roles: [],
  acc_acquirers: [{ company_id: 2, code: 'GHL', display_name: 'GHL', transit_account_code: '326-0030', fee_account_code: '900-T003', bank_account_code: '310-0020', is_active: true }],
  acc_settlement_batches: [{ id: 88, company_id: 2, acquirer_code: 'GHL', period_to: '2026-08-29', net_sen: 318_240, stated_net_sen: null }],
  acc_settlement_payout_batches: [],
  acc_settlement_receipts: [],
  journal_entries: [],
  journal_entry_lines: [],
}, {}, [], ['acc_settlement_receipts', 'acc_settlement_batches', 'acc_settlement_payout_batches']);
const KEPT = { amountSen: 5_400, accountCode: '900-T003', note: 'GHL terminal rental' };

describe('a charge kept off a credit, with no advice to book it on', () => {
  it('books the credit and the charge together; the report is then fully received', async () => {
    const sb = ghlWorld();
    const out = await postBatchReceipt(sb, 2, 88, { receivedOn: '2026-09-02', amountSen: 312_840, bankAccountCode: '310-0020', charge: KEPT });
    expect(out).toMatchObject({ ok: true, status: 'posted', amountSen: 312_840, chargeSen: 5_400, outstandingSen: 0 });
    const receipt = sb.tables.acc_settlement_receipts[0]!;
    expect(receipt).toMatchObject({ amount_sen: 312_840, charge_sen: 5_400, charge_account_code: '900-T003', charge_note: 'GHL terminal rental' });
    const charge = sb.tables.journal_entries.find((j) => j.source_doc_no === `SETTLECHARGE-R${receipt.id}`)!;
    /* Dated the report's settlement day, as an advice day's charge is. */
    expect(charge).toMatchObject({ source_type: 'SETTLECHARGE', entry_date: '2026-08-29' });
    expect(receipt.charge_je_no).toBe(charge.je_no);
    const lines = sb.tables.journal_entry_lines.filter((l) => l.journal_entry_id === charge.id);
    expect(lines.map((l) => [l.account_code, l.debit_sen, l.credit_sen])).toEqual([['900-T003', 5_400, 0], ['326-0030', 0, 5_400]]);
    expect(await loadBatchReceipts(sb, 2, 88)).toMatchObject({ ok: true, receivedSen: 312_840, chargedSen: 5_400 });
    expect((await postBatchReceipt(sb, 2, 88, { receivedOn: '2026-09-03' })).status).toBe('fully_received');
  });

  it('refuses a charge with no note, on an account that is not an expense leaf, or that with the credit passes what is owed — writing nothing', async () => {
    const sb = ghlWorld();
    const at = (charge: typeof KEPT) => postBatchReceipt(sb, 2, 88, { receivedOn: '2026-09-02', amountSen: 312_840, charge });
    expect((await at({ ...KEPT, note: ' ' })).status).toBe('note_required');
    expect((await at({ ...KEPT, accountCode: '310-0020' })).status).toBe('bad_account');
    expect((await at({ ...KEPT, accountCode: '900-0000' })).status).toBe('bad_account');
    const over = await at({ ...KEPT, amountSen: 6_000 });
    expect(over).toMatchObject({ ok: false, status: 'over_receipt' });
    expect(String((over as { reason: string }).reason)).toContain('come to RM 3,188.40');
    expect(sb.tables.acc_settlement_receipts).toHaveLength(0);
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  it('undoing the credit takes its charge back too, each contra on its own entry\'s day', async () => {
    const sb = ghlWorld();
    const out = await postBatchReceipt(sb, 2, 88, { receivedOn: '2026-09-02', amountSen: 312_840, charge: KEPT });
    const receiptId = (out as { receiptId: number }).receiptId;
    expect(await undoBatchReceipt(sb, 2, receiptId)).toMatchObject({ ok: true, status: 'undone' });
    expect(sb.tables.acc_settlement_receipts).toHaveLength(0);
    const contra = (type: string) => sb.tables.journal_entries.find((j) => j.source_type === type);
    expect(contra('SETTLEBANK_REVERSAL')).toMatchObject({ entry_date: '2026-09-02' });
    expect(contra('SETTLECHARGE_REVERSAL')).toMatchObject({ entry_date: '2026-08-29', source_doc_no: `SETTLECHARGE-R${receiptId}` });
    expect(await loadBatchReceipts(sb, 2, 88)).toMatchObject({ ok: true, receivedSen: 0, chargedSen: 0 });
  });
});
