
import { nextJeNo, jePrefixForCompany } from '../scm/lib/doc-no';
import { todayMyt } from '../scm/lib/my-time';
import { dateOrNull } from '../scm/lib/date-coerce';
import { REVERSAL_SOURCE, CONTROL_ROLES, resolveRoles } from './rules';
import { accMastersCompanyId } from './masters-company';
import type { RuleLine } from './rules';

export type EngineLine = RuleLine;

export type PostJournalInput = {
  companyId: number | null;
  entryDate: string;
  sourceType: string;
  sourceDocNo: string | null;
  narration: string | null;
  lines: EngineLine[];
  postNow?: boolean;
  opening?: boolean;
};

export type PostJournalOk = {
  ok: true;
  status: 'posted' | 'already_posted' | 'draft';
  jeNo: string;
  jeId: string;
  totalSen: number;
};
export type PostJournalErr = {
  ok: false;
  status:
    | 'min_2_lines'
    | 'bad_line'
    | 'unbalanced'
    | 'zero_total'
    | 'account_invalid'
    | 'control_account_manual'
    | 'account_check_failed'
    | 'idempotency_read_failed'
    | 'je_insert_failed'
    | 'lines_insert_failed'
    | 'je_prefix_failed'
    | 'post_failed';
  reason?: string;
};
export type PostJournalResult = PostJournalOk | PostJournalErr;

const isIntSen = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 0;

async function checkAccounts(
  sb: any,
  companyId: number | null,
  codes: string[],
): Promise<{ ok: true } | { ok: false; status: 'account_invalid' | 'account_check_failed'; reason: string }> {
  const co = accMastersCompanyId(companyId, 'checkAccounts');
  const { data, error } = await sb
    .from('accounts')
    .select('account_code, parent_code, is_active')
    .eq('company_id', co);
  if (error) {
    return { ok: false, status: 'account_check_failed', reason: error.message };
  }
  const chart = (data ?? []) as Array<{ account_code: string; parent_code: string | null; is_active: boolean | null }>;
  if (chart.length === 0) {
    /* eslint-disable-next-line no-console */
    console.error(`[acc/engine] company ${co} has NO chart of accounts — posting unvalidated (legacy tolerance)`);
    return { ok: true };
  }
  const byCode = new Map(chart.map((a) => [a.account_code, a]));
  const parents = new Set(chart.map((a) => a.parent_code).filter((p): p is string => p != null && p !== ''));
  for (const code of codes) {
    const acc = byCode.get(code);
    if (!acc) return { ok: false, status: 'account_invalid', reason: `account ${code} does not exist for company ${co}` };
    if (acc.is_active === false) return { ok: false, status: 'account_invalid', reason: `account ${code} is deactivated` };
    if (parents.has(code)) return { ok: false, status: 'account_invalid', reason: `account ${code} is a parent header — post to its children` };
  }
  return { ok: true };
}

/**
 * The read-only half of the gate — steps 1–3b: shape, balance, the chart, the
 * control guard. postJournal runs it first; a DRY RUN (acc/payments' diagnosis,
 * docs/bugs/0652) runs it alone, so "would this post, and if not why?" is
 * answered by the same code that posts — never by a second opinion.
 */
export async function validateJournal(sb: any, input: PostJournalInput): Promise<{ ok: true; totalSen: number } | PostJournalErr> {
  const { companyId, sourceType } = input;
  const lines = input.lines ?? [];

  if (lines.length < 2) return { ok: false, status: 'min_2_lines' };
  let dr = 0;
  let cr = 0;
  for (const l of lines) {
    if (!isIntSen(l.debitSen ?? 0) || !isIntSen(l.creditSen ?? 0)) {
      return { ok: false, status: 'bad_line', reason: `non-integer sen on account ${l.accountCode}` };
    }
    if ((l.debitSen ?? 0) > 0 && (l.creditSen ?? 0) > 0) {
      return { ok: false, status: 'bad_line', reason: `line on ${l.accountCode} carries both debit and credit` };
    }
    dr += l.debitSen ?? 0;
    cr += l.creditSen ?? 0;
  }
  if (dr !== cr) return { ok: false, status: 'unbalanced', reason: `debit ${dr} ≠ credit ${cr}` };
  if (dr === 0) return { ok: false, status: 'zero_total' };

  const chartOk = await checkAccounts(sb, companyId, [...new Set(lines.map((l) => l.accountCode))]);
  if (!chartOk.ok) return { ok: false, status: chartOk.status, reason: chartOk.reason };

  if (sourceType === 'MANUAL' || sourceType === 'OPENING') {
    const roles = await resolveRoles(sb, companyId);
    const controlCodes = new Set(CONTROL_ROLES.map((role) => roles[role]));
    const hit = lines.find((l) => controlCodes.has(l.accountCode));
    if (hit) {
      return {
        ok: false,
        status: 'control_account_manual',
        reason: sourceType === 'OPENING'
          ? `${hit.accountCode} is a control account — its opening is the opening bills, not a line of the opening journal`
          : `${hit.accountCode} is a control account — it is maintained by documents, not manual journals`,
      };
    }
  }
  return { ok: true, totalSen: dr };
}

export async function postJournal(sb: any, input: PostJournalInput): Promise<PostJournalResult> {
  const { companyId, sourceType, sourceDocNo, narration } = input;
  const entryDate = dateOrNull(input.entryDate) ?? todayMyt();
  const postNow = input.postNow !== false;
  const lines = input.lines ?? [];

  const v = await validateJournal(sb, input);
  if (!v.ok) return v;
  const dr = v.totalSen;
  const cr = dr;

  if (sourceDocNo != null) {
    let q = sb
      .from('journal_entries')
      .select('id, je_no, reversed')
      .eq('source_type', sourceType)
      .eq('source_doc_no', sourceDocNo);
    if (companyId != null) q = q.eq('company_id', companyId);
    const { data: existingRows, error: existErr } = await q;
    if (existErr) return { ok: false, status: 'idempotency_read_failed', reason: existErr.message };
    const active = ((existingRows ?? []) as Array<{ id: string; je_no: string; reversed: boolean | null }>).find(
      (r) => !r.reversed,
    );
    if (active) return { ok: true, status: 'already_posted', jeNo: active.je_no, jeId: active.id, totalSen: dr };
  }

  /* CONTAINED, not swallowed. jePrefixForCompany FAILS CLOSED by throwing —
     correctly, because minting under the wrong company's prefix would collide
     two ledgers' running numbers, and that is worse than not posting.
     But an escaping throw is not the same as failing closed: it left the
     document already POSTED, the ledger empty, and the operator staring at the
     generic "Something went wrong" with nothing naming the cause. Turn it into
     the structured refusal every other failure in this function returns, so the
     caller logs a reason and the audit trail records that the AP/GL post did
     not happen. See docs/bugs/0522. */
  let prefix: string;
  try {
    prefix = await jePrefixForCompany(sb, companyId);
  } catch (e) {
    return { ok: false, status: 'je_prefix_failed', reason: e instanceof Error ? e.message : String(e) };
  }
  const companyCol = companyId != null ? { company_id: companyId } : {};
  let je: { id: string; je_no: string } | null = null;
  let lastErr: { code?: string; message?: string } | null = null;
  for (let attempt = 0; attempt < 8 && !je; attempt += 1) {
    const jeNo = await nextJeNo(sb, new Date(entryDate), prefix);
    const { data: inserted, error: jeErr } = await sb
      .from('journal_entries')
      .insert({
        ...companyCol,
        je_no: jeNo,
        entry_date: entryDate,
        source_type: sourceType,
        source_doc_no: sourceDocNo,
        narration,
        total_debit_sen: dr,
        total_credit_sen: cr,
        ...(input.opening === true ? { opening: true } : {}),
      })
      .select('*')
      .single();
    if (!jeErr) {
      je = inserted as { id: string; je_no: string };
      break;
    }
    lastErr = jeErr;
    if (jeErr.code !== '23505') break;
    if (String(jeErr.message ?? '').includes('acc_je_one_active_source')) {
      let q2 = sb
        .from('journal_entries')
        .select('id, je_no')
        .eq('source_type', sourceType)
        .eq('source_doc_no', sourceDocNo ?? '');
      if (companyId != null) q2 = q2.eq('company_id', companyId);
      const { data: winner, error: winnerErr } = await q2.limit(1);
      if (winnerErr) {
        return { ok: false, status: 'je_insert_failed', reason: `${jeErr.message}; winner lookup failed: ${winnerErr.message}` };
      }
      const w = (winner ?? [])[0] as { id: string; je_no: string } | undefined;
      if (w) return { ok: true, status: 'already_posted', jeNo: w.je_no, jeId: w.id, totalSen: dr };
      return { ok: false, status: 'je_insert_failed', reason: jeErr.message };
    }
  }
  if (!je) return { ok: false, status: 'je_insert_failed', reason: lastErr?.message ?? 'mint retries exhausted' };

  const lineRows = lines.map((l, i) => ({
    ...companyCol,
    journal_entry_id: je!.id,
    line_no: i + 1,
    account_code: l.accountCode,
    debit_sen: l.debitSen ?? 0,
    credit_sen: l.creditSen ?? 0,
    party_type: l.partyType ?? null,
    party_code: l.partyCode ?? null,
    party_name: l.partyName ?? null,
    notes: l.notes ?? null,
    project_id: l.projectId ?? null,
  }));
  const { error: linesErr } = await sb.from('journal_entry_lines').insert(lineRows);
  if (linesErr) {
    await sb.from('journal_entries').delete().eq('id', je.id);
    return { ok: false, status: 'lines_insert_failed', reason: linesErr.message };
  }

  if (!postNow) return { ok: true, status: 'draft', jeNo: je.je_no, jeId: je.id, totalSen: dr };

  const { error: postErr } = await sb.from('journal_entries').update({ posted: true }).eq('id', je.id);
  if (postErr) return { ok: false, status: 'post_failed', reason: postErr.message };

  return { ok: true, status: 'posted', jeNo: je.je_no, jeId: je.id, totalSen: dr };
}


export type ReverseJournalInput = {
  sourceType: string;
  sourceDocNo?: string;
  jeId?: string;
  companyId?: number | null;
  narration: (orig: { je_no: string }) => string;
  entryDate?: string;
  /** Date the contra on the ORIGINAL entry's own day instead: the entry records
      something that never happened (a payment Finance removes from a cancelled
      order, owner 2026-09-29), so the pair must net to zero in the month it sits
      in rather than leave that month overstated. `entryDate`, when given, wins. */
  onOriginalDate?: boolean;
  fallbackLines?: (totalSen: number) => EngineLine[];
  opening?: boolean;
};

export type ReverseJournalResult =
  | { ok: true; status: 'reversed'; jeNo: string; jeId: string; originalJeNo: string }
  | { ok: true; status: 'already_reversed' | 'nothing_to_reverse' }
  | { ok: false; status: 'reversal_read_failed' | 'reversal_insert_failed' | 'reversal_lines_failed' | 'reversal_post_failed' | 'reversal_flag_failed'; reason?: string };

const storedDay = (v: unknown): string =>
  v instanceof Date ? (Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10)) : String(v ?? '').slice(0, 10);

export async function reverseJournal(sb: any, input: ReverseJournalInput): Promise<ReverseJournalResult> {
  const revType = REVERSAL_SOURCE[input.sourceType] ?? `${input.sourceType}_REVERSAL`;

  if (!input.sourceDocNo && !input.jeId) {
    return { ok: false, status: 'reversal_read_failed', reason: 'reverseJournal needs sourceDocNo or jeId' };
  }

  let q = sb
    .from('journal_entries')
    .select('id, je_no, entry_date, reversed, total_debit_sen, total_credit_sen, narration, company_id, source_doc_no')
    .eq('source_type', input.sourceType);
  q = input.jeId ? q.eq('id', input.jeId) : q.eq('source_doc_no', input.sourceDocNo);
  if (input.companyId != null) q = q.eq('company_id', input.companyId);
  const { data: origRows, error: origErr } = await q;
  if (origErr) return { ok: false, status: 'reversal_read_failed', reason: `origRows: ${origErr.message}` };
  const orig = (
    (origRows ?? []) as Array<{
      id: string;
      je_no: string;
      entry_date: string;
      reversed: boolean | null;
      total_debit_sen: number;
      total_credit_sen: number;
      company_id: number | null;
      source_doc_no: string | null;
    }>
  ).find((r) => !r.reversed);
  if (!orig) return { ok: true, status: 'nothing_to_reverse' };

  const { data: revExisting, error: revExistErr } = await sb
    .from('journal_entries')
    .select('id, je_no')
    .eq('source_type', revType)
    .eq('reversed_by_je', orig.id)
    .limit(1);
  if (revExistErr) return { ok: false, status: 'reversal_read_failed', reason: `revExisting: ${revExistErr.message}` };
  if (revExisting && revExisting.length > 0) {
    await sb.from('journal_entries').update({ reversed: true, reversed_by_je: revExisting[0].id }).eq('id', orig.id);
    return { ok: true, status: 'already_reversed' };
  }

  const totalSen = Number(orig.total_debit_sen ?? orig.total_credit_sen ?? 0);
  if (totalSen <= 0) {
    await sb.from('journal_entries').update({ reversed: true }).eq('id', orig.id);
    return { ok: true, status: 'reversed', jeNo: orig.je_no, jeId: orig.id, originalJeNo: orig.je_no };
  }

  const { data: origLines, error: origLinesErr } = await sb
    .from('journal_entry_lines')
    .select('account_code, debit_sen, credit_sen, party_type, party_code, party_name, notes, project_id')
    .eq('journal_entry_id', orig.id)
    .order('line_no');
  if (origLinesErr) return { ok: false, status: 'reversal_read_failed', reason: `origLines: ${origLinesErr.message}` };
  const oLines = (origLines ?? []) as Array<{
    account_code: string;
    debit_sen: number;
    credit_sen: number;
    party_type: string | null;
    party_code: string | null;
    party_name: string | null;
    notes: string | null;
    project_id?: number | null;
  }>;

  const companyId = orig.company_id ?? null;
  const companyCol = companyId != null ? { company_id: companyId } : {};
  const prefix = await jePrefixForCompany(sb, companyId);

  const contraEntryDate = dateOrNull(input.entryDate)
    ?? (input.onOriginalDate ? dateOrNull(storedDay(orig.entry_date)) : null)
    ?? todayMyt();

  let revJe: { id: string; je_no: string } | null = null;
  let lastErr: { code?: string; message?: string } | null = null;
  for (let attempt = 0; attempt < 8 && !revJe; attempt += 1) {
    const revJeNo = await nextJeNo(sb, new Date(contraEntryDate), prefix);
    const { data: inserted, error: revErr } = await sb
      .from('journal_entries')
      .insert({
        ...companyCol,
        je_no: revJeNo,
        entry_date: contraEntryDate,
        source_type: revType,
        source_doc_no: input.sourceDocNo ?? orig.source_doc_no ?? null,
        narration: input.narration(orig),
        total_debit_sen: totalSen,
        total_credit_sen: totalSen,
        reversed_by_je: orig.id,
        ...(input.opening === true ? { opening: true } : {}),
      })
      .select('*')
      .single();
    if (!revErr) {
      revJe = inserted as { id: string; je_no: string };
      break;
    }
    lastErr = revErr;
    if (revErr.code !== '23505') break;
  }
  if (!revJe) return { ok: false, status: 'reversal_insert_failed', reason: lastErr?.message ?? 'mint retries exhausted' };

  const swapped =
    oLines.length > 0
      ? oLines.map((l, i) => ({
          ...companyCol,
          journal_entry_id: revJe!.id,
          line_no: i + 1,
          account_code: l.account_code,
          debit_sen: Number(l.credit_sen ?? 0),
          credit_sen: Number(l.debit_sen ?? 0),
          party_type: l.party_type ?? null,
          party_code: l.party_code ?? null,
          party_name: l.party_name ?? null,
          notes: `Reversal — ${l.notes ?? ''}`.trim(),
          project_id: l.project_id ?? null,
        }))
      : (input.fallbackLines ? input.fallbackLines(totalSen) : []).map((l, i) => ({
          ...companyCol,
          journal_entry_id: revJe!.id,
          line_no: i + 1,
          account_code: l.accountCode,
          debit_sen: l.debitSen ?? 0,
          credit_sen: l.creditSen ?? 0,
          party_type: l.partyType ?? null,
          party_code: l.partyCode ?? null,
          party_name: l.partyName ?? null,
          notes: l.notes ?? null,
          project_id: l.projectId ?? null,
        }));
  if (swapped.length === 0) {
    await sb.from('journal_entries').delete().eq('id', revJe.id);
    return { ok: false, status: 'reversal_lines_failed', reason: 'original has no lines and no fallback was provided' };
  }
  const { error: linesErr } = await sb.from('journal_entry_lines').insert(swapped);
  if (linesErr) {
    await sb.from('journal_entries').delete().eq('id', revJe.id);
    return { ok: false, status: 'reversal_lines_failed', reason: linesErr.message };
  }

  // Post the contra + flag the original. Order matters: if the flag update
  // fails the contra still exists, so the reversed_by_je guard makes a retry
  // idempotent instead of double-voiding.
  //
  // BOTH answers are read (owner 2026-10-20, 「这样要修」). Unread, a contra the
  // database refused to post — the one-active index refused every SECOND void
  // of a document until 20261020T1100 — still flagged the original reversed
  // and answered ok, so the caller booked afresh over a void that never posted:
  // 35 such contras in production by 2026-10-20. A refused post now takes the
  // unposted contra back out and leaves the original live, so the caller stops
  // with nothing half-done.
  const { error: postErr } = await sb.from('journal_entries').update({ posted: true }).eq('id', revJe.id);
  if (postErr) {
    await sb.from('journal_entry_lines').delete().eq('journal_entry_id', revJe.id);
    await sb.from('journal_entries').delete().eq('id', revJe.id);
    return { ok: false, status: 'reversal_post_failed', reason: postErr.message };
  }
  const { error: flagErr } = await sb.from('journal_entries').update({ reversed: true, reversed_by_je: revJe.id }).eq('id', orig.id);
  if (flagErr) return { ok: false, status: 'reversal_flag_failed', reason: flagErr.message };

  return { ok: true, status: 'reversed', jeNo: revJe.je_no, jeId: revJe.id, originalJeNo: orig.je_no };
}
