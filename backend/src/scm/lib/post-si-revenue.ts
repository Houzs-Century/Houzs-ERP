// ----------------------------------------------------------------------------
// post-si-revenue — idempotent Sales Invoice → General Ledger posting.
//
// Confirming / creating a Sales Invoice records revenue: it writes a balanced
// journal entry Dr 1100 (Accounts Receivable) / Cr 4000 (Sales Revenue) for the
// invoice total into journal_entries + journal_entry_lines, then marks it
// posted.
//
// IDEMPOTENT: keyed on (source_type='SI', source_doc_no=invoice_number). If a
// JE for that invoice already exists, this is a no-op that reports the existing
// JE — it never double-posts. This is the single source of truth shared by:
//   • POST /accounting/post/si/:invoiceNumber  (manual / explicit re-post)
//   • POST /sales-invoices                     (auto-post on create/confirm)
// ----------------------------------------------------------------------------

import { todayMyt } from './my-time';
import { nextJeNo, jePrefixForCompany } from './doc-no';

export type PostSiResult =
  | { ok: true; status: 'posted'; jeNo: string; jeId: string; totalSen: number }
  | { ok: true; status: 'already_posted'; jeNo: string; jeId: string }
  /* Deliberately not posted, and that is a SUCCESS — see the migrated guard in
     postSiRevenue. `ok: true` so no caller records a failure for a thing that
     was never meant to post. */
  | { ok: true; status: 'migrated_source' }
  | { ok: false; status: 'invoice_not_found' | 'zero_total' | 'je_insert_failed' | 'lines_insert_failed' | 'post_failed'; reason?: string };

/* Every read below binds its `error`. supabase-js does NOT throw — a failed
   select resolves { data: null, error }, so `?? []` folds "we could not ask" into
   "the answer is no". On an idempotency guard that inversion does not degrade the
   result, it DEFEATS the guard and writes the entry a second time. Discriminator
   (shared with #678/#690): error !== null → abort; error === null && data === []
   → genuinely nothing there → fall through, which is the correct first booking
   and MUST keep working. */

/**
 * Post (or no-op if already posted) the GL entry for a Sales Invoice.
 * Returns a structured result; never throws on the expected failure paths.
 */
export async function postSiRevenue(sb: any, invoiceNumber: string): Promise<PostSiResult> {
  // ── Idempotency guard — does an ACTIVE (non-reversed) SI JE already exist? ──
  // We deliberately ignore REVERSED JEs: after resyncSiRevenue voids a stale
  // entry it calls us to post a FRESH one at the new total, so a reversed
  // original must NOT block the re-post. The trial-balance views already exclude
  // reversed entries, so only a live one means "already posted".
  /* #690 hardened this exact guard on the PI side (postPiAccounting) and left its
     SI original — the twin the PI docblock names as the thing it "mirrors". The SI
     side is the hotter path: PI posts only on demand, SI auto-posts on every
     create/confirm. A blip here reads as "no JE exists yet" and books a SECOND
     Dr AR / Cr Sales, double-counting the revenue. Nothing is written before this
     point, so returning strands nothing: the SI stays unposted and the next call
     (create/confirm/resync are all idempotent) posts it once. */
  const { data: existingRows, error: existErr } = await sb
    .from('journal_entries')
    .select('id, je_no, reversed')
    .eq('source_type', 'SI')
    .eq('source_doc_no', invoiceNumber);
  if (existErr) {
    /* eslint-disable-next-line no-console */
    console.error('[si-revenue] idempotency read failed — SI NOT posted:', invoiceNumber, existErr.message);
    return { ok: false, status: 'post_failed', reason: existErr.message };
  }
  const activeExisting = ((existingRows ?? []) as Array<{ id: string; je_no: string; reversed: boolean | null }>)
    .find((r) => !r.reversed);
  if (activeExisting) {
    return { ok: true, status: 'already_posted', jeNo: activeExisting.je_no, jeId: activeExisting.id };
  }

  const { data: si, error } = await sb
    .from('sales_invoices')
    .select('invoice_number, invoice_date, debtor_code, debtor_name, total_centi, company_id, migrated_no_stock')
    .eq('invoice_number', invoiceNumber)
    .single();
  if (error || !si) return { ok: false, status: 'invoice_not_found' };

  /* MIGRATED PAPERWORK BOOKS NO REVENUE (migration 0280). This invoice mirrors
     one AutoCount already raised, and AutoCount already booked the revenue and
     the receivable. Posting Dr 1100 / Cr 4000 here would count the same sale in
     two books — and because the SI auto-posts on create/confirm, the leak would
     be immediate and silent. Guarding here rather than at the five call sites
     means every path is covered by construction. */
  if ((si as { migrated_no_stock?: boolean | null }).migrated_no_stock === true) {
    return { ok: true, status: 'migrated_source' };
  }
  // Multi-company (mig 0061): the JE + lines belong to the SI's company.
  const companyId = (si as { company_id?: number | null }).company_id ?? null;

  const totalSen = Number(si.total_centi);
  if (totalSen <= 0) return { ok: false, status: 'zero_total' };

  const lines = [
    {
      accountCode: '1100',                                   // Accounts Receivable
      debitSen: totalSen,
      creditSen: 0,
      partyType: 'CUSTOMER',
      partyCode: si.debtor_code,
      partyName: si.debtor_name,
      notes: `AR for ${si.invoice_number}`,
    },
    {
      accountCode: '4000',                                   // Sales Revenue
      debitSen: 0,
      creditSen: totalSen,
      partyType: null,
      partyCode: null,
      partyName: null,
      notes: `Revenue from ${si.invoice_number}`,
    },
  ];

  const jeNo = await nextJeNo(sb, new Date(si.invoice_date), jePrefixForCompany(companyId));
  const { data: je, error: jeErr } = await sb
    .from('journal_entries')
    .insert({
      ...(companyId != null ? { company_id: companyId } : {}),
      je_no: jeNo,
      entry_date: si.invoice_date,
      source_type: 'SI',
      source_doc_no: si.invoice_number,
      narration: `Sales invoice ${si.invoice_number} — ${si.debtor_name}`,
      total_debit_sen: totalSen,
      total_credit_sen: totalSen,
    })
    .select('*')
    .single();
  if (jeErr) return { ok: false, status: 'je_insert_failed', reason: jeErr.message };

  const lineRows = lines.map((l, i) => ({
    ...(companyId != null ? { company_id: companyId } : {}),
    journal_entry_id: je.id,
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
    await sb.from('journal_entries').delete().eq('id', je.id);
    return { ok: false, status: 'lines_insert_failed', reason: linesErr.message };
  }

  const { error: postErr } = await sb
    .from('journal_entries')
    .update({ posted: true })
    .eq('id', je.id);
  if (postErr) return { ok: false, status: 'post_failed', reason: postErr.message };

  return { ok: true, status: 'posted', jeNo: je.je_no, jeId: je.id, totalSen };
}

/* 'reversal_read_failed' is the honest third state this type was missing: a read
   that did not answer is neither "reversed" nor "nothing to reverse". It is the
   ONLY type change the read-hardening needed — the whole downstream chain already
   widens to `string` (ResyncSiResult's ok:false) or only console.errors the value
   (sales-invoices.ts), and nothing anywhere narrows on a reversal status literal. */
export type ReverseSiResult =
  | { ok: true; status: 'reversed'; jeNo: string; jeId: string }
  | { ok: true; status: 'already_reversed' | 'nothing_to_reverse' }
  | { ok: false; status: 'reversal_insert_failed' | 'reversal_lines_failed' | 'reversal_read_failed'; reason?: string };

/**
 * Reverse (void) the revenue JE for a Sales Invoice when it is CANCELLED.
 *
 * Writes a MIRROR journal entry — Dr 4000 (Sales Revenue) / Cr 1100 (Accounts
 * Receivable) for the same total — that nets the original to zero, then flags
 * the original `reversed = true` + `reversed_by_je`. The trial-balance /
 * account-balance views (migration 0052) only count `posted = TRUE AND
 * reversed = FALSE`, so once flagged the original revenue no longer counts and
 * the reversing entry exactly cancels it — net GL impact zero.
 *
 * IDEMPOTENT: keyed on the original JE's `reversed` flag AND on the existence
 * of a reversing JE (source_type='SI_REVERSAL', source_doc_no=invoice_number).
 * Re-cancelling, retries, or a second status PATCH all no-op.
 */
export async function reverseSiRevenue(sb: any, invoiceNumber: string): Promise<ReverseSiResult> {
  // Find the ACTIVE (non-reversed) SI revenue JE — an invoice may carry several
  // historical SI JEs after edit-driven void+repost cycles (resyncSiRevenue), so
  // we void the live one, not an arbitrary `.limit(1)` row. Nothing live →
  // nothing to reverse.
  /* A failed read here used to return { ok:true, 'nothing_to_reverse' } — the
     caller cancels the SI, believes the GL was squared, and logs nothing, while a
     live revenue JE stays posted against a cancelled invoice. The books then claim
     revenue the company cancelled, and no later run revisits it: every healthy
     retry of this function sees the JE and reverses it, but nothing retries a
     cancel that already reported success. */
  const { data: origRows, error: origErr } = await sb
    .from('journal_entries')
    .select('id, je_no, entry_date, reversed, total_debit_sen, total_credit_sen, narration, company_id')
    .eq('source_type', 'SI')
    .eq('source_doc_no', invoiceNumber);
  if (origErr) return { ok: false, status: 'reversal_read_failed', reason: `origRows: ${origErr.message}` };
  const orig = ((origRows ?? []) as Array<{ id: string; je_no: string; entry_date: string; reversed: boolean; total_debit_sen: number; total_credit_sen: number; narration: string | null; company_id: number | null }>)
    .find((r) => !r.reversed);
  if (!orig) return { ok: true, status: 'nothing_to_reverse' };

  // Idempotency guard — a reversing JE already tied to THIS original exists (the
  // flag never stuck). Keyed on reversed_by_je = orig.id, NOT just "any reversal
  // for this invoice", so a prior cycle's reversal doesn't block voiding the
  // current live JE.
  /* This guard is the only thing making the reversal idempotent, so a blip does not
     degrade it — it defeats it and writes a SECOND contra JE. The cancellation is
     then booked twice and the invoice's revenue is over-reversed. Still before any
     write: returning leaves the original live and a retry reverses it once. */
  const { data: revExisting, error: revExistErr } = await sb
    .from('journal_entries')
    .select('id, je_no')
    .eq('source_type', 'SI_REVERSAL')
    .eq('reversed_by_je', orig.id)
    .limit(1);
  if (revExistErr) return { ok: false, status: 'reversal_read_failed', reason: `revExisting: ${revExistErr.message}` };
  if (revExisting && revExisting.length > 0) {
    // The reversing JE exists but the flag never got set — make the flag stick.
    await sb.from('journal_entries').update({ reversed: true, reversed_by_je: revExisting[0].id }).eq('id', orig.id);
    return { ok: true, status: 'already_reversed' };
  }

  const totalSen = Number(orig.total_debit_sen ?? orig.total_credit_sen ?? 0);
  if (totalSen <= 0) {
    // Nothing of value to reverse — just flag it so re-cancels no-op.
    await sb.from('journal_entries').update({ reversed: true }).eq('id', orig.id);
    return { ok: true, status: 'reversed', jeNo: orig.je_no, jeId: orig.id };
  }

  // Load the original lines so the reversal mirrors the SAME accounts + parties,
  // just with debit/credit swapped (a faithful contra entry).
  /* The `?? []` fold below is load-bearing for the genuinely-empty case, so the
     error must be caught BEFORE it: a failed read is indistinguishable from "the
     original had no lines" and silently takes the canonical-2-line fallback, which
     mirrors the assumed accounts instead of the real ones (wrong party attribution
     at best; a contra against accounts the original never touched at worst). Last
     read before the first write — abort is still free. */
  const { data: origLines, error: origLinesErr } = await sb
    .from('journal_entry_lines')
    .select('account_code, debit_sen, credit_sen, party_type, party_code, party_name, notes')
    .eq('journal_entry_id', orig.id)
    .order('line_no');
  if (origLinesErr) return { ok: false, status: 'reversal_read_failed', reason: `origLines: ${origLinesErr.message}` };
  const oLines = (origLines ?? []) as Array<{
    account_code: string; debit_sen: number; credit_sen: number;
    party_type: string | null; party_code: string | null; party_name: string | null; notes: string | null;
  }>;

  // Multi-company (mig 0061): a reversal belongs to the same company as the JE it undoes.
  const companyId = orig.company_id ?? null;
  const companyLine = companyId != null ? { company_id: companyId } : {};
  const revJeNo = await nextJeNo(sb, new Date(orig.entry_date), jePrefixForCompany(companyId));
  const { data: revJe, error: revErr } = await sb
    .from('journal_entries')
    .insert({
      ...companyLine,
      je_no: revJeNo,
      entry_date: todayMyt(),
      source_type: 'SI_REVERSAL',
      source_doc_no: invoiceNumber,
      narration: `Reversal of ${orig.je_no} — Sales invoice ${invoiceNumber} cancelled`,
      total_debit_sen: totalSen,
      total_credit_sen: totalSen,
      reversed_by_je: orig.id,
    })
    .select('*')
    .single();
  if (revErr) return { ok: false, status: 'reversal_insert_failed', reason: revErr.message };

  // Swap each original line's debit/credit so the reversal nets the original to
  // zero. Fall back to the canonical 2-line entry if the original had no lines.
  const swapped = oLines.length > 0
    ? oLines.map((l, i) => ({
        ...companyLine,
        journal_entry_id: revJe.id,
        line_no: i + 1,
        account_code: l.account_code,
        debit_sen: Number(l.credit_sen ?? 0),
        credit_sen: Number(l.debit_sen ?? 0),
        party_type: l.party_type ?? null,
        party_code: l.party_code ?? null,
        party_name: l.party_name ?? null,
        notes: `Reversal — ${l.notes ?? ''}`.trim(),
      }))
    : [
        { ...companyLine, journal_entry_id: revJe.id, line_no: 1, account_code: '4000', debit_sen: totalSen, credit_sen: 0, party_type: null, party_code: null, party_name: null, notes: `Reverse revenue ${invoiceNumber}` },
        { ...companyLine, journal_entry_id: revJe.id, line_no: 2, account_code: '1100', debit_sen: 0, credit_sen: totalSen, party_type: null, party_code: null, party_name: null, notes: `Reverse AR ${invoiceNumber}` },
      ];
  const { error: linesErr } = await sb.from('journal_entry_lines').insert(swapped);
  if (linesErr) {
    await sb.from('journal_entries').delete().eq('id', revJe.id);
    return { ok: false, status: 'reversal_lines_failed', reason: linesErr.message };
  }

  // Post the reversal + flag the original. Order matters: if the flag update
  // fails the reversing JE still exists, so guard #2 makes a retry idempotent.
  await sb.from('journal_entries').update({ posted: true }).eq('id', revJe.id);
  await sb.from('journal_entries').update({ reversed: true, reversed_by_je: revJe.id }).eq('id', orig.id);

  return { ok: true, status: 'reversed', jeNo: revJe.je_no, jeId: revJe.id };
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
