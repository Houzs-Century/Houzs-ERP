// ----------------------------------------------------------------------------
// post-si-revenue — idempotent Sales Invoice → General Ledger posting.
//
// Confirming / creating a Sales Invoice records revenue: Dr AR / Cr Sales for
// the invoice total, booked through acc/engine (THE one posting gate — see
// backend/src/acc/rules.ts for the whole rules table). This file owns the SI
// specifics only: fetching the invoice, the migrated-source guard, and mapping
// the engine's answers onto this module's historical result contract.
//
// IDEMPOTENT: keyed on (source_type='SI', source_doc_no=invoice_number) — the
// engine's guard fails closed on a read blip and the database repeats the rule
// with the acc_je_one_active_source unique index. This is the single source of
// truth shared by:
//   • POST /accounting/post/si/:invoiceNumber  (manual / explicit re-post)
//   • POST /sales-invoices                     (auto-post on create/confirm)
// ----------------------------------------------------------------------------

import { todayMyt } from './my-time';
import { postJournal, reverseJournal } from '../../acc/engine';
import { resolveRoles, siLines, DEFAULT_ROLE_CODES } from '../../acc/rules';

export type PostSiResult =
  | { ok: true; status: 'posted'; jeNo: string; jeId: string; totalSen: number }
  | { ok: true; status: 'already_posted'; jeNo: string; jeId: string }
  /* Deliberately not posted, and that is a SUCCESS — see the migrated guard in
     postSiRevenue. `ok: true` so no caller records a failure for a thing that
     was never meant to post. */
  | { ok: true; status: 'migrated_source' }
  | { ok: false; status: 'invoice_not_found' | 'zero_total' | 'je_insert_failed' | 'lines_insert_failed' | 'post_failed'; reason?: string };

/**
 * Post (or no-op if already posted) the GL entry for a Sales Invoice.
 * Returns a structured result; never throws on the expected failure paths.
 */
export async function postSiRevenue(sb: any, invoiceNumber: string): Promise<PostSiResult> {
  const { data: si, error } = await sb
    .from('sales_invoices')
    .select('invoice_number, invoice_date, debtor_code, debtor_name, total_centi, company_id, migrated_no_stock')
    .eq('invoice_number', invoiceNumber)
    .single();
  if (error || !si) return { ok: false, status: 'invoice_not_found' };

  /* MIGRATED PAPERWORK BOOKS NO REVENUE (migration 0280). This invoice mirrors
     one AutoCount already raised, and AutoCount already booked the revenue and
     the receivable. Posting Dr AR / Cr Sales here would count the same sale in
     two books — and because the SI auto-posts on create/confirm, the leak would
     be immediate and silent. Guarding here rather than at the call sites means
     every path is covered by construction. */
  if ((si as { migrated_no_stock?: boolean | null }).migrated_no_stock === true) {
    return { ok: true, status: 'migrated_source' };
  }
  // Multi-company (mig 0061): the JE + lines belong to the SI's company.
  const companyId = (si as { company_id?: number | null }).company_id ?? null;

  const totalSen = Number(si.total_centi);
  if (totalSen <= 0) return { ok: false, status: 'zero_total' };

  const roles = await resolveRoles(sb, companyId);
  const r = await postJournal(sb, {
    companyId,
    entryDate: si.invoice_date,
    sourceType: 'SI',
    sourceDocNo: si.invoice_number,
    narration: `Sales invoice ${si.invoice_number} — ${si.debtor_name}`,
    lines: siLines(roles, si, totalSen),
  });

  if (r.ok) {
    if (r.status === 'already_posted') return { ok: true, status: 'already_posted', jeNo: r.jeNo, jeId: r.jeId };
    return { ok: true, status: 'posted', jeNo: r.jeNo, jeId: r.jeId, totalSen };
  }
  /* The engine's idempotency guard failed to ANSWER — the SI stays unposted and
     the next call (create/confirm/resync are all idempotent) posts it once.
     Logged the way the in-file guard used to log, because silence here is how a
     revenue posting quietly never happens. */
  if (r.status === 'idempotency_read_failed') {
    /* eslint-disable-next-line no-console */
    console.error('[si-revenue] idempotency read failed — SI NOT posted:', invoiceNumber, r.reason);
    return { ok: false, status: 'post_failed', reason: r.reason };
  }
  if (r.status === 'je_insert_failed' || r.status === 'lines_insert_failed' || r.status === 'post_failed') {
    return { ok: false, status: r.status, reason: r.reason };
  }
  // Shape/chart refusals (unbalanced, bad account, …) cannot happen for the
  // fixed 2-line rule unless the chart itself is wrong — surface them loudly
  // under the historical catch-all status.
  return { ok: false, status: 'post_failed', reason: `${r.status}: ${r.reason ?? ''}` };
}

/* 'reversal_read_failed' is the honest third state this type was missing: a read
   that did not answer is neither "reversed" nor "nothing to reverse". */
export type ReverseSiResult =
  | { ok: true; status: 'reversed'; jeNo: string; jeId: string }
  | { ok: true; status: 'already_reversed' | 'nothing_to_reverse' }
  | { ok: false; status: 'reversal_insert_failed' | 'reversal_lines_failed' | 'reversal_read_failed'; reason?: string };

/**
 * Reverse (void) the revenue JE for a Sales Invoice when it is CANCELLED.
 *
 * A faithful contra through the engine: same accounts + parties, debit/credit
 * swapped, original flagged `reversed` + `reversed_by_je`. The balance views
 * (migration 0052) only count `posted = TRUE AND reversed = FALSE`, so the
 * pair nets to zero. Idempotent: keyed on the original's `reversed` flag AND
 * on the existence of a contra tied to it by `reversed_by_je`.
 */
export async function reverseSiRevenue(sb: any, invoiceNumber: string): Promise<ReverseSiResult> {
  return reverseJournal(sb, {
    sourceType: 'SI',
    sourceDocNo: invoiceNumber,
    narration: (orig) => `Reversal of ${orig.je_no} — Sales invoice ${invoiceNumber} cancelled`,
    entryDate: todayMyt(),
    fallbackLines: (totalSen) => [
      { accountCode: DEFAULT_ROLE_CODES.SALES, debitSen: totalSen, creditSen: 0, notes: `Reverse revenue ${invoiceNumber}` },
      { accountCode: DEFAULT_ROLE_CODES.AR, debitSen: 0, creditSen: totalSen, notes: `Reverse AR ${invoiceNumber}` },
    ],
  });
}

export type ResyncSiResult =
  | { ok: true; status: 'unchanged' | 'not_posted' | 'resynced' | 'reversed_to_zero' | 'posted' }
  | { ok: false; status: string; reason?: string };

/**
 * Re-align a Sales Invoice's revenue JE with its CURRENT total after a line was
 * edited / added / deleted post-issue. Wei Siang 2026-06-01 chose "auto void the
 * stale entry + re-post at the new amount" (auto credit-note + reissue) so the
 * GL never drifts from the invoice.
 *
 *   • No live JE yet + total > 0  → post a fresh one (covers a blank invoice
 *     getting its first line, and self-heals a never-posted issued invoice).
 *   • No live JE + total ≤ 0      → nothing to do.
 *   • Live JE, total unchanged    → no-op (no needless churn).
 *   • Live JE, total changed > 0  → void the stale JE, post a fresh one.
 *   • Live JE, new total ≤ 0      → void only (all lines gone → no revenue left).
 *
 * Idempotent: a second call finds the JE already matching → 'unchanged'.
 * Best-effort caller pattern — never blocks the line edit on a GL hiccup.
 */
export async function resyncSiRevenue(sb: any, invoiceNumber: string): Promise<ResyncSiResult> {
  // Current live SI JE (non-reversed) + its booked total.
  const { data: jeRows, error: jeErr } = await sb
    .from('journal_entries')
    .select('id, total_debit_sen, reversed')
    .eq('source_type', 'SI')
    .eq('source_doc_no', invoiceNumber);
  if (jeErr) return { ok: false, status: 'resync_read_failed', reason: `jeRows: ${jeErr.message}` };
  const active = ((jeRows ?? []) as Array<{ id: string; total_debit_sen: number; reversed: boolean | null }>)
    .find((r) => !r.reversed);

  /* The most destructive read in this file, and it reads as a lookup. A blip left
     `si` null, so newTotal folded to 0 and status folded to '' — which walks
     straight past the CANCELLED/DRAFT short-circuit, fails the unchanged-total
     test against any real total, reverses the live JE, and then returns
     { ok:true, 'reversed_to_zero' } because 0 <= 0. A healthy invoice loses its
     revenue on a line edit and the caller is told it succeeded. It does NOT
     re-post (the re-post sits after that early return), so nothing self-heals
     until someone edits a line again.
     `error === null && si === null` stays untouched: the invoice is genuinely
     gone and voiding its JE is the existing, intended behaviour. */
  const { data: si, error: siErr } = await sb
    .from('sales_invoices')
    .select('total_centi, status')
    .eq('invoice_number', invoiceNumber)
    .maybeSingle();
  if (siErr) return { ok: false, status: 'resync_read_failed', reason: `si: ${siErr.message}` };
  const newTotal = Number((si as { total_centi?: number } | null)?.total_centi ?? 0);

  /* A CANCELLED or DRAFT invoice must never (re)post revenue. CANCELLED: its JE
     was already reversed on cancel. DRAFT: it has not committed any revenue yet
     (posting happens on confirm) — editing a draft's lines must NOT post GL.
     Both are short-circuited so a line mutation can't leak revenue. */
  {
    const s = ((si as { status?: string } | null)?.status ?? '').toUpperCase();
    if (s === 'CANCELLED' || s === 'DRAFT') {
      return { ok: true, status: 'not_posted' };
    }
  }

  if (!active) {
    // Never posted (or fully reversed). Post fresh only when there's value —
    // SI posts revenue on issue, so a positive total with no live JE should post.
    if (newTotal > 0) {
      const post = await postSiRevenue(sb, invoiceNumber);
      return post.ok ? { ok: true, status: 'posted' } : { ok: false, status: post.status, reason: (post as { reason?: string }).reason };
    }
    return { ok: true, status: 'not_posted' };
  }

  if (Number(active.total_debit_sen) === newTotal) return { ok: true, status: 'unchanged' };

  // Total changed → void the stale JE.
  const rev = await reverseSiRevenue(sb, invoiceNumber);
  if (!rev.ok) return { ok: false, status: rev.status, reason: (rev as { reason?: string }).reason };

  // Re-post at the new total. A new total of 0 (all lines removed) means there is
  // nothing left to record — the void alone leaves the GL flat.
  if (newTotal <= 0) return { ok: true, status: 'reversed_to_zero' };
  const post = await postSiRevenue(sb, invoiceNumber);
  return post.ok ? { ok: true, status: 'resynced' } : { ok: false, status: post.status, reason: (post as { reason?: string }).reason };
}
