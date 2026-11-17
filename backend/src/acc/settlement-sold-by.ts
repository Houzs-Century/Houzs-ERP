// ----------------------------------------------------------------------------
// acc/settlement-sold-by — a merchant report line that is ANOTHER company's sale.
//
// Owner, 2026-11-17: 2990's AEON instalment sales are swiped on Houzs's AEON
// terminal (2990's own AEON is switched off), so they land on HOUZS's AEON
// reports with no Houzs sale behind them, and Houzs pays 2990 the money back by
// voucher — 「houzs 那边的报表要确定这些和refund给2990 contra 掉」, then
// 「可以开始做先」.
//
// Confirming such a line books it to the account this company keeps for the
// other one (scm.acc_company_links; Houzs -> 2990: 350-0070), one SETTLEFOR
// journal dated by the swipe:
//
//     Dr card clearing        gross   the swipe is on this company's report…
//         Cr link account     gross   …and the money is the other company's
//     Dr link account         fee     the acquirer's fee is theirs too
//         Cr card clearing    fee
//     Dr link account         share   and so is the line's share of the statement
//         Cr merchant charges share   charge, which SETTLEADJ booked here whole
//
// The link account then holds what the acquirer pays for the line — the net
// the other company is owed — the voucher paying them back clears it (Dr link,
// Cr bank), and the report counts the line confirmed, so its payout matches.
// A statement charge is shared over the report's lines by gross (owner: the
// RM 106.93 of RM 150.88 Houzs gave R21077), largest remainder, so the shares
// of a report sold wholly by the other company add up to the whole charge.
// ----------------------------------------------------------------------------

import type { RuleLine } from './rules';
import { postJournal, reverseJournal } from './engine';
import { loadAcquirer, postStatementCharge } from './settlement';
import { fmtSen } from '../scm/shared/format';

type Sb = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- PostgREST builders are chained structurally, as in acc/settlement
type Fail = { ok: false; status: string; reason: string };

export const SOLD_BY_SOURCE = 'SETTLEFOR';
export const soldByDocNo = (rowId: number): string => `${SOLD_BY_SOURCE}-${rowId}`;
const SOLD_BY_NOTE = 'Sold by ';
const isoDay = (v: unknown): string => String(v ?? '').slice(0, 10);
const fail = (status: string, reason: string): Fail => ({ ok: false, status, reason });

/** Each line's share of a statement charge, by gross, to the sen: largest
    remainder, so the shares add up to the charge exactly. A line with no gross
    (a refund) takes none. */
export function chargeSharesOf(adjustmentSen: number, lines: ReadonlyArray<{ id: number; grossSen: number }>): Map<number, number> {
  const out = new Map<number, number>(lines.map((l) => [l.id, 0]));
  const counted = lines.filter((l) => l.grossSen > 0);
  const total = counted.reduce((s, l) => s + l.grossSen, 0);
  if (adjustmentSen === 0 || total === 0) return out;
  const whole = Math.abs(adjustmentSen);
  const parts = counted.map((l) => {
    const exact = (whole * l.grossSen) / total;
    return { id: l.id, sen: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let left = whole - parts.reduce((s, p) => s + p.sen, 0);
  for (const p of [...parts].sort((a, b) => b.rest - a.rest || a.id - b.id)) {
    if (left <= 0) break;
    p.sen += 1;
    left -= 1;
  }
  for (const p of parts) out.set(p.id, adjustmentSen < 0 ? -p.sen : p.sen);
  return out;
}

/** What the other company is owed for the line: what the acquirer pays for it. */
export const owedOf = (s: { grossSen: number; feeSen: number; chargeShareSen: number }): number =>
  s.grossSen - s.feeSen - s.chargeShareSen;

/** The SETTLEFOR journal of one line sold by another company. A zero fee or
    share books no pair; a negative one (a rebate) books its pair the other way. */
export function soldByLines(
  accounts: { transitAccountCode: string; linkAccountCode: string; feeAccountCode: string },
  s: { acquirerCode: string; txnDate: string; ref: string | null; grossSen: number; feeSen: number; chargeShareSen: number; soldBy: string },
): RuleLine[] {
  const tag = `${s.acquirerCode} ${s.txnDate}${s.ref ? ` ref ${s.ref}` : ''}, sold by ${s.soldBy}`;
  const out: RuleLine[] = [
    { accountCode: accounts.transitAccountCode, debitSen: s.grossSen, creditSen: 0, notes: `Swiped on this terminal — ${tag}` },
    { accountCode: accounts.linkAccountCode, debitSen: 0, creditSen: s.grossSen, notes: `The money is ${s.soldBy}'s — ${tag}` },
  ];
  const back = (sen: number, from: string, words: string, otherWords: string) => {
    if (sen === 0) return;
    const a = Math.abs(sen);
    out.push(
      { accountCode: accounts.linkAccountCode, debitSen: sen > 0 ? a : 0, creditSen: sen > 0 ? 0 : a, notes: `${words} — ${tag}` },
      { accountCode: from, debitSen: sen > 0 ? 0 : a, creditSen: sen > 0 ? a : 0, notes: `${otherWords} — ${tag}` },
    );
  };
  back(s.feeSen, accounts.transitAccountCode, `${s.acquirerCode}'s fee is ${s.soldBy}'s`, 'Fee is no longer receivable');
  back(s.chargeShareSen, accounts.feeAccountCode, `Its share of the statement charge is ${s.soldBy}'s`, 'Not this company\'s charge');
  return out;
}

export type CompanyLink = { companyId: number; code: string; name: string; accountCode: string; accountName: string | null; usable: boolean };

/** The companies this one keeps an account for, as Merchant Recon offers them,
    each with that account and whether the posting gate would take it (an
    ACTIVE account of THIS company). Fails closed. */
export async function loadCompanyLinks(sb: Sb, companyId: number): Promise<{ ok: true; links: CompanyLink[] } | Fail> {
  const { data, error } = await sb.from('acc_company_links')
    .select('other_company_id, account_code').eq('company_id', companyId).order('other_company_id');
  if (error) return fail('load_failed', error.message);
  const rows = (data ?? []) as Array<{ other_company_id: number; account_code: string }>;
  if (rows.length === 0) return { ok: true, links: [] };
  const [cos, accs] = await Promise.all([
    /* public.companies: the scm client alone answers "Could not find the table 'scm.companies'". */
    sb.schema('public').from('companies').select('id, code, name').in('id', rows.map((r) => Number(r.other_company_id))),
    sb.from('accounts').select('account_code, account_name, is_active')
      .eq('company_id', companyId).in('account_code', rows.map((r) => String(r.account_code))),
  ]);
  if (cos.error) return fail('load_failed', cos.error.message);
  if (accs.error) return fail('load_failed', accs.error.message);
  const companyOf = new Map(((cos.data ?? []) as Array<{ id: number; code: string | null; name: string | null }>).map((co) => [Number(co.id), co]));
  const accountOf = new Map(((accs.data ?? []) as Array<{ account_code: string; account_name: string | null; is_active: boolean | null }>).map((a) => [String(a.account_code), a]));
  return {
    ok: true,
    links: rows.map((r) => {
      const co = companyOf.get(Number(r.other_company_id));
      const acc = accountOf.get(String(r.account_code));
      return {
        companyId: Number(r.other_company_id),
        code: String(co?.code ?? r.other_company_id),
        name: String(co?.name ?? co?.code ?? r.other_company_id),
        accountCode: String(r.account_code),
        accountName: acc?.account_name ?? null,
        usable: acc?.is_active === true,
      };
    }),
  };
}

export type SoldByInput = { companyId: number; rowId: number; otherCompanyId: number; note: string | null; userName: string | null };
export type SoldByResult =
  | { ok: true; status: 'confirmed'; jeNo: string; batchId: number; owedSen: number; chargeShareSen: number; accountCode: string; soldBy: string }
  | Fail;

type LineRow = {
  id: number; batch_id: number; acquirer_code: string; txn_date: string; ref: string | null; gross_sen: number; fee_sen: number;
  bucket: string; confirmed_at: string | null; channel: string | null; sold_by_company_id: number | null;
};

/** Confirm one line as the other company's sale: the SETTLEFOR journal, the
    report's statement charge (once, SETTLEADJ — the share above reverses this
    line's part of it), then the line's stamp. A press after a half-done one
    resumes: both entries are idempotent through the gate. */
export async function markSoldBy(sb: Sb, input: SoldByInput): Promise<SoldByResult> {
  const { companyId } = input;
  const { data: rowRaw, error } = await sb.from('acc_settlement_rows')
    .select('id, batch_id, acquirer_code, txn_date, ref, gross_sen, fee_sen, bucket, confirmed_at, channel, sold_by_company_id')
    .eq('id', input.rowId).eq('company_id', companyId).maybeSingle();
  if (error) return fail('load_failed', error.message);
  if (!rowRaw) return fail('not_found', `settlement line ${input.rowId} not found`);
  const row = rowRaw as LineRow;
  if (row.confirmed_at) return fail('already_confirmed', 'This line is already confirmed. Undo it first to book it another way.');
  if (row.bucket === 'IGNORED') return fail('ignored', 'This line was set aside. Put it back in the list first.');
  if (row.channel === 'QR') return fail('qr_line', 'A DuitNow QR line is not a card swipe on this terminal; it cannot be another company\'s sale here.');
  if (!(Number(row.gross_sen) > 0)) return fail('not_a_sale', 'Only a sale can be another company\'s; this line takes money back.');

  const [linked, links] = await Promise.all([
    sb.from('acc_settlement_matches').select('id').eq('company_id', companyId).eq('settlement_row_id', row.id).limit(1),
    loadCompanyLinks(sb, companyId),
  ]);
  if (linked.error) return fail('load_failed', linked.error.message);
  if (((linked.data ?? []) as unknown[]).length > 0) {
    return fail('linked', 'This line is matched to one of this company\'s own sales. If that match is wrong, press Not this first.');
  }
  if (!links.ok) return links;
  const link = links.links.find((l) => l.companyId === input.otherCompanyId);
  if (!link) return fail('no_link', 'No account is kept here for that company\'s money, so its sale cannot be booked.');
  if (!link.usable) return fail('link_account_unusable', `${link.accountCode} is not an active account of this company.`);

  const [batchRes, siblings, acq] = await Promise.all([
    sb.from('acc_settlement_batches').select('id, adjustment_sen').eq('id', row.batch_id).eq('company_id', companyId).maybeSingle(),
    sb.from('acc_settlement_rows').select('id, gross_sen').eq('batch_id', row.batch_id).eq('company_id', companyId),
    loadAcquirer(sb, companyId, row.acquirer_code),
  ]);
  if (batchRes.error) return fail('load_failed', batchRes.error.message);
  if (!batchRes.data) return fail('not_found', `report ${row.batch_id} not found`);
  if (siblings.error) return fail('load_failed', siblings.error.message);
  if (!acq.ok) return fail('acquirer_unavailable', acq.reason);

  const lines = ((siblings.data ?? []) as Array<{ id: number; gross_sen: number }>).map((l) => ({ id: Number(l.id), grossSen: Number(l.gross_sen) }));
  const chargeShareSen = chargeSharesOf(Number((batchRes.data as { adjustment_sen: number | null }).adjustment_sen ?? 0), lines).get(row.id) ?? 0;
  const figures = { grossSen: Number(row.gross_sen), feeSen: Number(row.fee_sen), chargeShareSen };
  const owedSen = owedOf(figures);
  const day = isoDay(row.txn_date);

  const posted = await postJournal(sb, {
    companyId,
    entryDate: day,
    sourceType: SOLD_BY_SOURCE,
    sourceDocNo: soldByDocNo(row.id),
    narration: `${row.acquirer_code} ${day}${row.ref ? ` ref ${row.ref}` : ''} — sold by ${link.code}: ${fmtSen(owedSen)} owed to it`,
    lines: soldByLines(
      { transitAccountCode: acq.acquirer.transit_account_code, linkAccountCode: link.accountCode, feeAccountCode: acq.acquirer.fee_account_code },
      { acquirerCode: row.acquirer_code, txnDate: day, ref: row.ref, ...figures, soldBy: link.code },
    ),
  });
  if (!posted.ok) return fail(posted.status, posted.reason ?? 'the posting gate refused the entry');

  const charge = await postStatementCharge(sb, companyId, Number(row.batch_id));
  if (!charge.ok) return fail('statement_charge_failed', `${charge.reason} (the entry ${posted.jeNo} DID post — press again to finish)`);

  const now = new Date().toISOString();
  const note = (input.note ?? '').trim();
  const { error: upErr } = await sb.from('acc_settlement_rows').update({
    bucket: 'MATCHED',
    match_reason: 'manual',
    confirmed_at: now,
    confirmed_by: input.userName ?? null,
    posted_je_no: posted.jeNo,
    posted_je_id: posted.jeId,
    sold_by_company_id: input.otherCompanyId,
    notes: `${SOLD_BY_NOTE}${link.code}${note ? `: ${note.slice(0, 200)}` : ''}`,
    updated_at: now,
  }).eq('id', row.id).eq('company_id', companyId);
  if (upErr) return fail('stamp_failed', `${upErr.message} (the entry ${posted.jeNo} DID post — press again to finish stamping the line)`);

  return { ok: true, status: 'confirmed', jeNo: posted.jeNo, batchId: Number(row.batch_id), owedSen, chargeShareSen, accountCode: link.accountCode, soldBy: link.code };
}

/** Take a line sold by another company back: its SETTLEFOR journal reversed and
    the line back among the ones to decide. `not_sold_by` for any other line, so
    the caller takes it back the ordinary way. Refused, as every undo of a line
    is, while money is recorded received against its report. */
export async function unmarkSoldBy(
  sb: Sb, companyId: number, rowId: number,
): Promise<{ ok: true; status: 'unconfirmed'; jeNo: string | null } | Fail> {
  const { data: rowRaw, error } = await sb.from('acc_settlement_rows')
    .select('id, batch_id, txn_date, confirmed_at, sold_by_company_id, notes')
    .eq('id', rowId).eq('company_id', companyId).maybeSingle();
  if (error) return fail('load_failed', error.message);
  if (!rowRaw) return fail('not_found', `settlement line ${rowId} not found`);
  const row = rowRaw as { id: number; batch_id: number; txn_date: string; confirmed_at: string | null; sold_by_company_id: number | null; notes: string | null };
  if (row.sold_by_company_id == null || !row.confirmed_at) return fail('not_sold_by', 'This line is not booked as another company\'s sale.');

  const { data: received, error: rcErr } = await sb.from('acc_settlement_receipts')
    .select('id').eq('batch_id', row.batch_id).eq('company_id', companyId).limit(1);
  if (rcErr) return fail('load_failed', rcErr.message);
  if (((received ?? []) as unknown[]).length > 0) {
    return fail('has_receipts', 'Money is already recorded received against this statement. Undo those credits on the bank side first, then take this line back.');
  }

  const reversed = await reverseJournal(sb, {
    sourceType: SOLD_BY_SOURCE,
    sourceDocNo: soldByDocNo(row.id),
    companyId,
    entryDate: isoDay(row.txn_date),
    narration: (orig: { je_no: string }) => `Reversal of ${orig.je_no} — the line is no longer another company's sale`,
  });
  if (!reversed.ok) return fail(reversed.status, reversed.reason ?? 'the reversal was refused');

  const { error: upErr } = await sb.from('acc_settlement_rows').update({
    confirmed_at: null, confirmed_by: null, posted_je_no: null, posted_je_id: null,
    bucket: 'NEEDS_CONFIRM', match_reason: null, sold_by_company_id: null,
    notes: String(row.notes ?? '').startsWith(SOLD_BY_NOTE) ? null : row.notes,
    updated_at: new Date().toISOString(),
  }).eq('id', row.id).eq('company_id', companyId);
  if (upErr) return fail('update_failed', `${upErr.message} (the entry WAS reversed — press undo again to finish the line)`);
  return { ok: true, status: 'unconfirmed', jeNo: reversed.status === 'reversed' ? reversed.jeNo : null };
}
