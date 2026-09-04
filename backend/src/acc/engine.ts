// ----------------------------------------------------------------------------
// acc/engine — THE one posting gate.
//
// Every journal entry in the system is written by postJournal, and every
// reversal by reverseJournal. No other code may insert into journal_entries /
// journal_entry_lines. (Requirements brief §2.1: three prior ERPs each grew
// multiple posting paths and each shipped an entry that silently never hit the
// ledger; this file exists so that class of bug has nowhere to live.)
//
// What the gate enforces, in order:
//   1. Shape       — ≥2 lines, integer sen, every line one-sided (Dr xor Cr)
//   2. Balance     — Σdebit === Σcredit, and > 0
//   3. Chart       — the account code exists for the company, is active, and
//                    is not a parent (a header with children takes no money)
//   4. Idempotency — one ACTIVE entry per (company, source_type, source_doc_no).
//                    Checked by a read that FAILS CLOSED, and enforced again by
//                    the partial unique index acc_je_one_active_source at the
//                    database, so a read blip can delay a posting but can never
//                    double it.
//   5. Numbering   — je_no minted per company+month; a concurrent mint loses
//                    the unique index race and re-mints (max 8 tries), so two
//                    operators posting at once both succeed with distinct
//                    numbers. (§2.12)
//
// The write sequence (insert entry → insert lines → flip posted) and the
// compensating delete of a header whose lines failed are the SAME sequence the
// three historical posting paths used — behaviour-preserving on purpose, so
// the existing suites keep proving the same decisions.
// ----------------------------------------------------------------------------

import { nextJeNo, jePrefixForCompany } from '../scm/lib/doc-no';
import { todayMyt } from '../scm/lib/my-time';
import { dateOrNull } from '../scm/lib/date-coerce';
import { REVERSAL_SOURCE, CONTROL_ROLES, resolveRoles } from './rules';
import { accMastersCompanyId } from './masters-company';
import type { RuleLine } from './rules';

export type EngineLine = RuleLine;

export type PostJournalInput = {
  companyId: number | null;
  /** DOCUMENT date — drives every report (§2.5). Never "the day the button was pressed". */
  entryDate: string;
  sourceType: string;
  sourceDocNo: string | null;
  narration: string | null;
  lines: EngineLine[];
  /** default true. false = manual JV draft: entry + lines written, posted stays false. */
  postNow?: boolean;
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

/**
 * Validate the company's chart allows every code the entry names.
 *
 * A company with NO chart rows at all is tolerated (legacy mode: validation
 * has nothing to validate against, and refusing would stop books that posted
 * fine for months) — but it is logged, loudly, every time. A company WITH a
 * chart gets the full rule: the code must exist, be active, and have no
 * children (§2.9 — a parent "Operating Expense" header must really be blocked,
 * not just labelled Header in the UI).
 */
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
    // Fail closed: an unanswered chart is not an empty chart. The document
    // stays unposted and the caller's retry posts it once the read answers.
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

export async function postJournal(sb: any, input: PostJournalInput): Promise<PostJournalResult> {
  const { companyId, sourceType, sourceDocNo, narration } = input;
  /* `entryDate: string` does not stop `""` — an unfilled <input type="date">
     posts one, and journal_entries.entry_date is `date NOT NULL`. Blank would
     500 the whole post AND poison nextJeNo (`new Date("")` is Invalid Date,
     so the month prefix comes out NaN). Today is the only sane document date
     for a journal being written today, and it is what every caller that omits
     the key already gets. */
  const entryDate = dateOrNull(input.entryDate) ?? todayMyt();
  const postNow = input.postNow !== false;
  const lines = input.lines ?? [];

  // 1+2 — shape and balance. Rejected before any read or write.
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

  // 3 — the chart allows every named account.
  const chartOk = await checkAccounts(sb, companyId, [...new Set(lines.map((l) => l.accountCode))]);
  if (!chartOk.ok) return { ok: false, status: chartOk.status, reason: chartOk.reason };

  // 3b — control accounts are SYSTEM-maintained (brief §2.4): a MANUAL journal
  // may not name them. Every AR/AP movement must come from a document through
  // its rule, or the "control balance = detail sum" self-check stops meaning
  // anything.
  if (sourceType === 'MANUAL') {
    const roles = await resolveRoles(sb, companyId);
    const controlCodes = new Set(CONTROL_ROLES.map((role) => roles[role]));
    const hit = lines.find((l) => controlCodes.has(l.accountCode));
    if (hit) {
      return {
        ok: false,
        status: 'control_account_manual',
        reason: `${hit.accountCode} is a control account — it is maintained by documents, not manual journals`,
      };
    }
  }

  // 4 — one ACTIVE entry per source document. The read fails CLOSED (a blip
  // must never read as "no entry exists yet" — that is precisely how a second
  // Dr AR / Cr Sales gets booked), and the partial unique index repeats the
  // rule at the database for whatever a blip lets through.
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

  // 5 — mint + insert, re-minting on a number collision (§2.12). Two
  // concurrent posts both read the same max; the loser's insert hits the
  // je_no unique index and the next attempt reads past the winner.
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
      })
      .select('*')
      .single();
    if (!jeErr) {
      je = inserted as { id: string; je_no: string };
      break;
    }
    lastErr = jeErr;
    if (jeErr.code !== '23505') break;
    // A 23505 from the one-active-source index (not the je_no index) means a
    // concurrent caller posted this very document between our guard read and
    // our insert — that is already_posted, not a retry.
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
  }));
  const { error: linesErr } = await sb.from('journal_entry_lines').insert(lineRows);
  if (linesErr) {
    // Compensating delete: the header without its lines must not survive.
    // (The only DELETE the ledger ever sees — a pre-posted header is paperwork
    // that never happened, not history.)
    await sb.from('journal_entries').delete().eq('id', je.id);
    return { ok: false, status: 'lines_insert_failed', reason: linesErr.message };
  }

  if (!postNow) return { ok: true, status: 'draft', jeNo: je.je_no, jeId: je.id, totalSen: dr };

  const { error: postErr } = await sb.from('journal_entries').update({ posted: true }).eq('id', je.id);
  if (postErr) return { ok: false, status: 'post_failed', reason: postErr.message };

  return { ok: true, status: 'posted', jeNo: je.je_no, jeId: je.id, totalSen: dr };
}

/* ═══════════════════════════ Reversal (void) ═══════════════════════════════ */

export type ReverseJournalInput = {
  /** source_type of the ORIGINAL entry (e.g. 'SI'); the contra's own type comes from REVERSAL_SOURCE. */
  sourceType: string;
  /** Find the original by source document… */
  sourceDocNo?: string;
  /** …or by its journal-entry id (manual JVs carry no source_doc_no). One of the two is required. */
  jeId?: string;
  /** When provided, both the lookup and the write are scoped to the company (PV path). SI/PI pass null: doc numbers are globally unique by prefix. */
  companyId?: number | null;
  /** narration for the contra entry, given the original. */
  narration: (orig: { je_no: string }) => string;
  /** entry_date for the contra. Defaults to today (MYT) — a void happens when it happens. */
  entryDate?: string;
  /** canonical 2-line fallback if the original somehow has no lines. */
  fallbackLines?: (totalSen: number) => EngineLine[];
};

export type ReverseJournalResult =
  | { ok: true; status: 'reversed'; jeNo: string; jeId: string }
  | { ok: true; status: 'already_reversed' | 'nothing_to_reverse' }
  | { ok: false; status: 'reversal_read_failed' | 'reversal_insert_failed' | 'reversal_lines_failed'; reason?: string };

export async function reverseJournal(sb: any, input: ReverseJournalInput): Promise<ReverseJournalResult> {
  const revType = REVERSAL_SOURCE[input.sourceType] ?? `${input.sourceType}_REVERSAL`;

  if (!input.sourceDocNo && !input.jeId) {
    return { ok: false, status: 'reversal_read_failed', reason: 'reverseJournal needs sourceDocNo or jeId' };
  }

  // The ACTIVE original — a document may carry several historical entries
  // after edit-driven void+repost cycles; the live one is the one to void.
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

  // A contra tied to THIS original already exists (the flag never stuck) —
  // make the flag stick and stop. Keyed on reversed_by_je, not "any reversal
  // for this document", so a prior cycle's contra doesn't block this one.
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
    // Nothing of value to reverse — flag it so re-voids no-op.
    await sb.from('journal_entries').update({ reversed: true }).eq('id', orig.id);
    return { ok: true, status: 'reversed', jeNo: orig.je_no, jeId: orig.id };
  }

  // Mirror the SAME accounts + parties with debit/credit swapped — a faithful
  // contra. The read is caught before the `?? []` fold: a failed read is not
  // "the original had no lines", and falling through would contra assumed
  // accounts instead of the real ones.
  const { data: origLines, error: origLinesErr } = await sb
    .from('journal_entry_lines')
    .select('account_code, debit_sen, credit_sen, party_type, party_code, party_name, notes')
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
  }>;

  const companyId = orig.company_id ?? null;
  const companyCol = companyId != null ? { company_id: companyId } : {};
  const prefix = await jePrefixForCompany(sb, companyId);

  // The contra is dated when the void HAPPENS (today by default), so it must be
  // NUMBERED in that same month's series — mirror postJournal, which mints from
  // the entry's OWN date. Minting from orig.entry_date put an Aug void into the
  // original's (e.g. Jan) JE-YYMM series while the row itself was dated Aug.
  const contraEntryDate = dateOrNull(input.entryDate) ?? todayMyt();

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
  await sb.from('journal_entries').update({ posted: true }).eq('id', revJe.id);
  await sb.from('journal_entries').update({ reversed: true, reversed_by_je: revJe.id }).eq('id', orig.id);

  return { ok: true, status: 'reversed', jeNo: revJe.je_no, jeId: revJe.id };
}
