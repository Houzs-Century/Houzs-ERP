/* A bank charge deducted from a payout — booked to the account Finance picks.
 *
 * Owner, 2026-09-10, on a PBB advice whose 2026-06-06 day said RM 3,024.18
 * against a merchant report netting RM 3,348.18: 「我检查了好像是银行的卡机
 * application fees 来的，我该如何做」, then 「可以让我点了后选这笔 324 进什么
 * 户口吗」. Until this, the advice screen reported the RM 324.00 difference and
 * stopped — nothing could book it, so the acquirer's transit account would
 * have stayed short by it for ever.
 *
 * What is pinned: the charge is refused unless the account is an ACTIVE
 * EXPENSE LEAF of THIS company (the four refusals the merchant fee account
 * already answers with); the amount defaults to the whole difference and may
 * not exceed it; the journal is Dr the chosen account / Cr the acquirer's
 * transit, DATED THE SETTLEMENT DAY (the deduction happened then, not when the
 * button was pressed); a second charge on the same day is refused rather than
 * stacked; undo reverses through the engine and clears the row; and a read
 * that fails is a refusal, never "no charge yet".
 */
import { describe, expect, it } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { postPayoutCharge, undoPayoutCharge } from './payout-charge';

const CHART: Row[] = [
  { account_code: '326-0010', account_name: 'PBB transit', account_type: 'ASSET', parent_code: null, is_active: true, company_id: 2 },
  { account_code: '900-T009', account_name: 'Terminal charges', account_type: 'EXPENSE', parent_code: '900-0000', is_active: true, company_id: 2 },
  { account_code: '900-0000', account_name: 'Bank charges (header)', account_type: 'EXPENSE', parent_code: null, is_active: true, company_id: 2 },
  { account_code: '905-0000', account_name: 'Stationery', account_type: 'EXPENSE', parent_code: null, is_active: true, company_id: 2 },
  { account_code: '906-0000', account_name: 'Old fees (off)', account_type: 'EXPENSE', parent_code: null, is_active: false, company_id: 2 },
  { account_code: '310-0010', account_name: 'HLB', account_type: 'ASSET', parent_code: null, is_active: true, company_id: 2 },
  /* The same code in the OTHER company — must never be reachable from here. */
  { account_code: '907-0000', account_name: 'Theirs', account_type: 'EXPENSE', parent_code: null, is_active: true, company_id: 1 },
];

const world = (over: { days?: Row[]; jes?: Row[]; lines?: Row[] } = {}) => fakeSb({
  accounts: CHART,
  acc_account_roles: [],
  acc_acquirers: [{ company_id: 2, code: 'PBB', display_name: 'PBB', transit_account_code: '326-0010', fee_account_code: '900-T009', bank_account_code: '310-0010', is_active: true }],
  acc_settlement_batches: [{ id: 6, company_id: 2, acquirer_code: 'PBB', file_name: '2990HOMESB_CSV_20260606.csv', period_from: '2026-06-06', period_to: '2026-06-06', net_sen: 334_818, stated_net_sen: 334_818 }],
  acc_settlement_payouts: [{ id: 3, company_id: 2, acquirer_code: 'PBB', file_name: '2990HOMESB_IBG_20260608.pdf', net_sen: 814_329 }],
  acc_settlement_payout_batches: over.days ?? [
    { id: 11, payout_id: 3, company_id: 2, settled_on: '2026-06-06', net_sen: 302_418, batch_id: 6, charge_sen: 0, charge_account_code: null },
  ],
  journal_entries: over.jes ?? [],
  journal_entry_lines: over.lines ?? [],
}, {}, [], ['acc_settlement_payout_batches', 'acc_settlement_batches', 'acc_settlement_payouts']);

const ask = (sb: ReturnType<typeof world>, over: Record<string, unknown> = {}) =>
  postPayoutCharge(sb, 2, {
    payoutId: 3, settledOn: '2026-06-06', accountCode: '900-T009', note: 'PBB card-terminal application fee', userName: 'Chew',
    ...over,
  });

describe('postPayoutCharge', () => {
  it('books the difference to the chosen account against the transit, dated the settlement day', async () => {
    const sb = world();
    const out = await ask(sb);
    expect(out).toMatchObject({ ok: true, status: 'charged', chargeSen: 32_400, accountCode: '900-T009' });

    const je = sb.tables.journal_entries.find((j: Row) => j.source_type === 'SETTLECHARGE')!;
    expect(je).toMatchObject({ entry_date: '2026-06-06', total_debit_sen: 32_400, source_doc_no: 'SETTLECHARGE-11' });
    const lines = sb.tables.journal_entry_lines.filter((l: Row) => l.journal_entry_id === je.id);
    expect(lines[0]).toMatchObject({ account_code: '900-T009', debit_sen: 32_400, credit_sen: 0 });
    expect(lines[1]).toMatchObject({ account_code: '326-0010', debit_sen: 0, credit_sen: 32_400 });

    const day = sb.tables.acc_settlement_payout_batches[0];
    expect(day).toMatchObject({ charge_sen: 32_400, charge_account_code: '900-T009', charge_note: 'PBB card-terminal application fee', charge_je_no: je.je_no, charge_by: 'Chew' });
  });

  it('lets Finance book only part of the difference — the rest stays a finding', async () => {
    const sb = world();
    expect(await ask(sb, { amountSen: 30_000 })).toMatchObject({ ok: true, chargeSen: 30_000 });
    expect(sb.tables.journal_entries[0].total_debit_sen).toBe(30_000);
  });

  it('refuses a charge larger than the difference — that is not a deduction, it is a mismatch', async () => {
    const out = await ask(world(), { amountSen: 40_000 });
    expect(out.ok).toBe(false);
    expect(out.status).toBe('over_difference');
  });

  it('refuses a charge on a day that already agrees — there is nothing to explain', async () => {
    const sb = world({ days: [{ id: 11, payout_id: 3, company_id: 2, settled_on: '2026-06-06', net_sen: 334_818, batch_id: 6, charge_sen: 0, charge_account_code: null }] });
    expect((await ask(sb)).status).toBe('nothing_to_charge');
  });

  it('refuses a second charge on the same day rather than stacking — undo the first', async () => {
    const sb = world();
    expect((await ask(sb)).ok).toBe(true);
    const again = await ask(sb, { amountSen: 1 });
    expect(again.ok).toBe(false);
    expect(again.status).toBe('already_charged');
    expect(sb.tables.journal_entries.filter((j: Row) => j.source_type === 'SETTLECHARGE')).toHaveLength(1);
  });

  it('requires a note — the report prints it, and a blank line explains nothing', async () => {
    expect((await ask(world(), { note: '   ' })).status).toBe('note_required');
  });

  /* THE FOUR REFUSALS the merchant fee account already answers with — the
     same words, because it is the same question: can the gate post here. */
  it('refuses an account that is not in this company\'s chart, including the other company\'s', async () => {
    expect((await ask(world(), { accountCode: '999-9999' })).status).toBe('bad_account');
    expect((await ask(world(), { accountCode: '907-0000' })).status).toBe('bad_account');
  });

  it('refuses a switched-off account', async () => {
    expect((await ask(world(), { accountCode: '906-0000' })).status).toBe('bad_account');
  });

  it('refuses an account that is not an expense', async () => {
    expect((await ask(world(), { accountCode: '310-0010' })).status).toBe('bad_account');
  });

  it('refuses a header account that has sub-accounts', async () => {
    expect((await ask(world(), { accountCode: '900-0000' })).status).toBe('bad_account');
  });

  it('accepts any other active expense leaf — the account is Finance\'s to choose', async () => {
    const out = await ask(world(), { accountCode: '905-0000' });
    expect(out).toMatchObject({ ok: true, accountCode: '905-0000' });
  });

  it('refuses a day the advice does not name', async () => {
    expect((await ask(world(), { settledOn: '2026-06-09' })).status).toBe('not_found');
  });

  it('refuses a day whose report is not here yet — the difference cannot be known', async () => {
    const sb = world({ days: [{ id: 11, payout_id: 3, company_id: 2, settled_on: '2026-06-06', net_sen: 302_418, batch_id: null, charge_sen: 0, charge_account_code: null }] });
    expect((await ask(sb)).status).toBe('report_missing');
  });

  it('a read that fails is a refusal, never a charge booked on a guess', async () => {
    const sb = fakeSb({
      accounts: CHART, acc_account_roles: [],
      acc_acquirers: [], acc_settlement_batches: [], acc_settlement_payouts: [],
      acc_settlement_payout_batches: [{ id: 11, payout_id: 3, company_id: 2, settled_on: '2026-06-06', net_sen: 302_418, batch_id: 6, charge_sen: 0, charge_account_code: null }],
      journal_entries: [], journal_entry_lines: [],
    }, { acc_settlement_batches: ['stated_net_sen'] }, [], ['acc_settlement_payout_batches']);
    const out = await ask(sb);
    expect(out.ok).toBe(false);
    expect(sb.tables.journal_entries).toHaveLength(0);
  });
});

describe('undoPayoutCharge', () => {
  it('reverses the entry through the engine and clears the day — the contra, not a delete', async () => {
    const sb = world();
    await ask(sb);
    const out = await undoPayoutCharge(sb, 2, { payoutId: 3, settledOn: '2026-06-06' });
    expect(out).toMatchObject({ ok: true, status: 'undone' });

    const original = sb.tables.journal_entries.find((j: Row) => j.source_type === 'SETTLECHARGE')!;
    expect(original.reversed).toBe(true);
    const contra = sb.tables.journal_entries.find((j: Row) => j.source_type === 'SETTLECHARGE_REVERSAL')!;
    expect(contra).toMatchObject({ entry_date: '2026-06-06', total_debit_sen: 32_400 });

    expect(sb.tables.acc_settlement_payout_batches[0]).toMatchObject({ charge_sen: 0, charge_account_code: null, charge_note: null, charge_je_no: null });
  });

  it('a day with no charge has nothing to undo, and says so', async () => {
    expect((await undoPayoutCharge(world(), 2, { payoutId: 3, settledOn: '2026-06-06' })).status).toBe('nothing_to_undo');
  });

  it('after an undo, the same day can be charged again', async () => {
    const sb = world();
    await ask(sb);
    await undoPayoutCharge(sb, 2, { payoutId: 3, settledOn: '2026-06-06' });
    expect((await ask(sb, { accountCode: '905-0000' })).ok).toBe(true);
    expect(sb.tables.journal_entries.filter((j: Row) => j.source_type === 'SETTLECHARGE' && !j.reversed)).toHaveLength(1);
  });
});
