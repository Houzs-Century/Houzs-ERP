// ----------------------------------------------------------------------------
// /accounting — simple double-entry accounting layer (PR #36).
//
// Endpoints:
//   GET    /accounts                  — chart of accounts
//   GET    /journal-entries           — list (filter by date range / source)
//   GET    /journal-entries/:id       — one JE w/ lines
//   POST   /journal-entries           — create draft JE (lines included)
//   POST   /journal-entries/:id/post  — mark posted (trigger checks balance)
//   POST   /post/si/:invoiceNumber    — auto-post a SI: Dr AR, Cr Revenue
//   POST   /post/pi/:invoiceNumber    — auto-post a PI: Dr Inventory, Cr AP
//   GET    /gl                        — flat GL stream (v_gl_entries)
//   GET    /balances                  — running account balances (v_account_balances)
//   GET    /ar-aging                  — v_ar_aging
//   GET    /ap-aging                  — v_ap_aging
//
// Note: this is intentionally minimal — single legal entity, single currency.
// ERPNext-style chart hierarchy + cost centres are deferred.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { postSiRevenue } from '../lib/post-si-revenue';
import { MIGRATED_NO_GL_MESSAGE } from '../lib/migrated-chain';
import { paginateAll } from '../lib/paginate-all';
import { safeRate, toMyrSen } from '../lib/fx';
import { todayMyt } from '../lib/my-time';
import { nextJeNo, jePrefixForCompany } from '../lib/doc-no';
import {
  scopeToCompany, activeCompanyId, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY,
} from '../lib/companyScope';

export const accounting = new Hono<{ Bindings: Env; Variables: Variables }>();
accounting.use('*', supabaseAuth);

/* ════════════════════════════════════════════════════════════════════════
   Helpers
   ════════════════════════════════════════════════════════════════════════ */

type JeLineIn = {
  accountCode: string;
  debitSen?: number;
  creditSen?: number;
  partyType?: string | null;
  partyCode?: string | null;
  partyName?: string | null;
  notes?: string | null;
};

/* ════════════════════════════════════════════════════════════════════════
   Chart of Accounts
   ════════════════════════════════════════════════════════════════════════ */

accounting.get('/accounts', async (c) => {
  const sb = c.get('supabase');
  // Chart of Accounts is per-company (scm.accounts.company_id NOT NULL, mig 0083)
  // — scope so one company can't see the other's account codes/names.
  let q = sb
    .from('accounts')
    .select('account_code, account_name, account_type, parent_code, is_active');
  q = scopeToCompany(q, c);
  const { data, error } = await q.order('account_code');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ accounts: data ?? [] });
});

/* ════════════════════════════════════════════════════════════════════════
   Journal Entries
   ════════════════════════════════════════════════════════════════════════ */

accounting.get('/journal-entries', async (c) => {
  const sb = c.get('supabase');
  const sourceType = c.req.query('sourceType');
  const sourceDocNo = c.req.query('sourceDocNo');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const posted = c.req.query('posted');

  let q = sb.from('journal_entries')
    .select('id, je_no, entry_date, source_type, source_doc_no, narration, total_debit_sen, total_credit_sen, posted, posted_at, reversed, created_at')
    .order('entry_date', { ascending: false })
    .order('je_no', { ascending: false });

  if (sourceType)  q = q.eq('source_type', sourceType);
  if (sourceDocNo) q = q.eq('source_doc_no', sourceDocNo);
  if (from)        q = q.gte('entry_date', from);
  if (to)          q = q.lte('entry_date', to);
  if (posted === 'true')  q = q.eq('posted', true);
  if (posted === 'false') q = q.eq('posted', false);
  q = scopeToCompany(q, c); // multi-company: isolate JEs to the active company

  const { data, error } = await q.limit(500);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ journalEntries: data ?? [] });
});

accounting.get('/journal-entries/:id', async (c) => {
  const id = c.req.param('id');
  const sb = c.get('supabase');
  const { data: je, error: e1 } = await scopeToCompany(
    sb
      .from('journal_entries')
      .select('*')
      .eq('id', id),
    c,
  )
    .single();
  if (e1) return c.json({ error: 'not_found', reason: e1.message }, 404);
  const { data: lines, error: e2 } = await sb
    .from('journal_entry_lines')
    .select('*')
    .eq('journal_entry_id', id)
    .order('line_no');
  if (e2) return c.json({ error: 'load_failed', reason: e2.message }, 500);
  return c.json({ journalEntry: je, lines: lines ?? [] });
});

accounting.post('/journal-entries', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const entryDate = body.entryDate ?? todayMyt();
  const sourceType = String(body.sourceType ?? 'MANUAL');
  const sourceDocNo = body.sourceDocNo ?? null;
  const narration = body.narration ?? null;
  const lines = Array.isArray(body.lines) ? (body.lines as JeLineIn[]) : [];
  if (lines.length < 2) return c.json({ error: 'min_2_lines' }, 400);

  let dr = 0, cr = 0;
  for (const l of lines) {
    dr += Number(l.debitSen ?? 0);
    cr += Number(l.creditSen ?? 0);
  }
  if (dr !== cr) return c.json({ error: 'unbalanced', debit: dr, credit: cr }, 400);
  if (dr === 0) return c.json({ error: 'zero_amount' }, 400);

  const sb = c.get('supabase');
  const jeNo = await nextJeNo(sb, new Date(entryDate), companyDocPrefix(c));

  const jeCompanyId = activeCompanyId(c);
  const { data: je, error: jeErr } = await sb
    .from('journal_entries')
    .insert({
      ...(jeCompanyId != null ? { company_id: jeCompanyId } : {}),
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
  if (jeErr) return c.json({ error: 'insert_failed', reason: jeErr.message }, 500);

  const lineRows = lines.map((l, i) => ({
    ...(jeCompanyId != null ? { company_id: jeCompanyId } : {}),
    journal_entry_id: je.id,
    line_no: i + 1,
    account_code: l.accountCode,
    debit_sen: Number(l.debitSen ?? 0),
    credit_sen: Number(l.creditSen ?? 0),
    party_type: l.partyType ?? null,
    party_code: l.partyCode ?? null,
    party_name: l.partyName ?? null,
    notes: l.notes ?? null,
  }));
  const { error: linesErr } = await sb.from('journal_entry_lines').insert(lineRows);
  if (linesErr) {
    await sb.from('journal_entries').delete().eq('id', je.id);
    return c.json({ error: 'lines_insert_failed', reason: linesErr.message }, 500);
  }
  return c.json({ journalEntry: je, lineCount: lineRows.length }, 201);
});

/* POST /journal-entries/:id/post — mark a journal entry posted.
 *
 * LEAK FIX (audit item 1). This used to post by BLIND ID: no load, no company
 * scope, no status check. `UPDATE journal_entries SET posted = true WHERE id =
 * $1` on a service-role client — RLS is bypassed, so that predicate WAS the
 * isolation boundary and it named only the id. Anyone signed into company A
 * who could produce a company B journal-entry id posted B's GL entry, and the
 * only trace was a posted JE in B's books that nobody in B did.
 *
 * Now: resolve the company (required — see requireActiveCompanyId), LOAD the
 * entry within it, check its status, and scope the UPDATE itself as well. The
 * update carries the company predicate too, rather than trusting the load —
 * they run as two statements, and the one that writes is the one that has to
 * be safe.
 *
 * Exported so the route test can drive it without the supabaseAuth bridge,
 * which cannot run in this harness. */
export const postJournalEntryHandler = async (c: any) => {
  const id = c.req.param('id');
  const sb = c.get('supabase');

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  // Load within the company first. A miss means "not yours OR not there", and
  // both answer the same way — telling A that B's id exists is itself a leak.
  const { data: je, error: loadErr } = await scopeToCompanyId(
    sb.from('journal_entries').select('id, je_no, posted, reversed').eq('id', id),
    co.companyId,
  ).maybeSingle();
  if (loadErr) return c.json({ error: 'load_failed', reason: loadErr.message }, 500);
  if (!je) return c.json(NOT_THIS_COMPANY, 404);

  // Status checks the blind update never made.
  if ((je as { posted?: boolean }).posted === true) {
    return c.json({ error: 'already_posted', message: 'This journal entry is already posted.' }, 409);
  }
  if ((je as { reversed?: boolean }).reversed === true) {
    return c.json({
      error: 'je_reversed',
      message: 'This journal entry was reversed and cannot be posted. Create a new one.',
    }, 409);
  }

  const { data, error } = await scopeToCompanyId(
    sb.from('journal_entries').update({ posted: true }).eq('id', id),
    co.companyId,
  ).select('*').maybeSingle();
  if (error) {
    // The trigger throws if unbalanced — pass through as 400
    if (String(error.message).includes('not balanced')) {
      return c.json({ error: 'unbalanced', reason: error.message }, 400);
    }
    return c.json({ error: 'post_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ journalEntry: data });
};

accounting.post('/journal-entries/:id/post', postJournalEntryHandler);

/* ════════════════════════════════════════════════════════════════════════
   Auto-post helpers — SI / PI confirm
   ════════════════════════════════════════════════════════════════════════ */

accounting.post('/post/si/:invoiceNumber', async (c) => {
  const invoiceNumber = c.req.param('invoiceNumber');
  const sb = c.get('supabase');

  /* LEAK GUARD (DRAFT, two-state — 2026-06-25 anchoring diff vs 2990) — a DRAFT SI
     has not committed any revenue; the manual re-post endpoint must refuse it, or an
     operator could post a draft's revenue out-of-band (the SI route's confirm
     transition is the ONLY path that should post a draft). postSiRevenue itself does
     not check status, so the guard lives here at the caller.

     Company scope (owner audit 2026-07-22): the SELECT was pinned only by
     invoice_number, safe TODAY because doc-number prefixes ('2990-SI-…') are
     globally unique. Tightening now so a future prefix rule change or a
     collision cannot post revenue against the wrong company's books. */
  {
    const { data: si } = await scopeToCompany(
      sb.from('sales_invoices').select('status').eq('invoice_number', invoiceNumber),
      c,
    ).maybeSingle();
    if (!si) return c.json({ error: 'invoice_not_found' }, 404);
    if ((si as { status?: string }).status === 'DRAFT') {
      return c.json({ error: 'not_postable', message: 'SI is a draft — confirm it (DRAFT → Issued) before posting revenue.' }, 409);
    }
  }

  // Delegates to the shared idempotent poster (post-si-revenue). Same code path
  // the SI POST handler uses on confirm, so manual + auto posting can never
  // diverge or double-post.
  const r = await postSiRevenue(sb, invoiceNumber);

  if (r.ok) {
    /* Nothing to post and nothing wrong: AutoCount already booked this sale.
       Answered explicitly so the caller is not left inferring it from a missing
       jeNo. */
    if (r.status === 'migrated_source') {
      return c.json({ ok: true, status: 'migrated_source', posted: false, message: MIGRATED_NO_GL_MESSAGE });
    }
    if (r.status === 'already_posted') {
      // Keep the historical 409 contract for the explicit re-post endpoint.
      return c.json({ error: 'already_posted', existingJe: { id: r.jeId, je_no: r.jeNo } }, 409);
    }
    return c.json({ ok: true, jeNo: r.jeNo, jeId: r.jeId, totalSen: r.totalSen });
  }
  if (r.status === 'invoice_not_found') return c.json({ error: 'invoice_not_found' }, 404);
  if (r.status === 'zero_total')        return c.json({ error: 'zero_total' }, 400);
  return c.json({ error: r.status, reason: r.reason }, 500);
});

/* ── postPiAccounting (extracted 2026-06-01) — idempotent PI → GL post ──────
   Writes Dr Inventory (1200) / Cr Payables (2000) for the PI total. Shared by
   the manual POST /post/pi route AND resyncPiAccounting (void+repost on a
   post-issue line edit). Mirrors postSiRevenue: keyed on an ACTIVE (non-reversed)
   PI JE, so a reversed original never blocks a fresh re-post. */
export type PostPiResult =
  | { ok: true; status: 'posted'; jeNo: string; jeId: string; totalSen: number }
  | { ok: true; status: 'already_posted'; jeNo: string; jeId: string }
  /* Deliberately not posted, and that is a SUCCESS — see the migrated guard
     below. It is `ok: true` so the confirm handler does not write its
     "AP/GL post FAILED" audit row for a thing that was never meant to post. */
  | { ok: true; status: 'migrated_source' }
  | { ok: false; status: 'invoice_not_found' | 'zero_total' | 'je_insert_failed' | 'lines_insert_failed' | 'post_failed'; reason?: string };

export async function postPiAccounting(sb: any, invoiceNumber: string): Promise<PostPiResult> {
  // Idempotency — an ACTIVE (non-reversed) PI JE already exists?
  /* This guard is the ONLY thing that makes posting idempotent, and `?? []` folded
     a failed read into "no JE exists yet" — so a transient blip does not skip the
     posting, it posts a SECOND Dr Inventory / Cr AP for the same invoice and
     doubles the supplier's payable in the GL. Nothing is written before this
     point, so returning strands nothing: the PI simply stays unposted and a later
     call (this function is called on confirm and by resyncPiAccounting) posts it
     once, correctly. A PI that has genuinely never been posted resolves
     error === null with data === [] and MUST still fall through. */
  const { data: existingRows, error: existErr } = await sb
    .from('journal_entries')
    .select('id, je_no, reversed')
    .eq('source_type', 'PI')
    .eq('source_doc_no', invoiceNumber);
  if (existErr) {
    /* eslint-disable-next-line no-console */
    console.error('[pi-accounting] idempotency read failed — PI NOT posted:', invoiceNumber, existErr.message);
    return { ok: false, status: 'post_failed', reason: existErr.message };
  }
  const active = ((existingRows ?? []) as Array<{ id: string; je_no: string; reversed: boolean | null }>)
    .find((r) => !r.reversed);
  if (active) return { ok: true, status: 'already_posted', jeNo: active.je_no, jeId: active.id };

  const { data: piRaw, error } = await sb
    .from('purchase_invoices')
    .select('id, invoice_number, invoice_date, supplier_id, total_centi, currency, exchange_rate, company_id, migrated_no_stock, suppliers(code, name)')
    .eq('invoice_number', invoiceNumber)
    .single();
  if (error || !piRaw) return { ok: false, status: 'invoice_not_found' };

  /* MIGRATED PAPERWORK POSTS NO JOURNAL (migration 0280). This invoice mirrors
     one AutoCount already raised, and AutoCount already booked the payable
     behind it. Posting Dr 1200 / Cr 2000 here would count the same money in two
     books. The guard lives in this function rather than at its call sites so
     every caller — the confirm handler, resyncPiAccounting, any future one — is
     covered by construction. */
  if ((piRaw as unknown as { migrated_no_stock?: boolean | null }).migrated_no_stock === true) {
    return { ok: true, status: 'migrated_source' };
  }
  // Cast through `unknown` — Supabase JS without generated types returns
  // `GenericStringError` from `.select(string).single()` even when data is
  // populated. Project-wide pattern; see routes/admin.ts L97.
  const pi = piRaw as unknown as {
    id: string;
    invoice_number: string;
    invoice_date: string;
    supplier_id: string | null;
    total_centi: number;
    currency: string | null;
    exchange_rate: string | number | null;
    company_id: number | null;
    suppliers: { code: string | null; name: string | null } | null;
  };

  /* Multi-currency AP (migration 0082) — the PI's total_centi is in the PI's OWN
     currency (RMB / USD / SGD / MYR). The GL must be MYR, so convert AT POST TIME:
     exchange_rate = MYR per 1 unit of `currency` (1 for MYR). The PI row is
     untouched — only the JE legs below carry the converted amount. For an MYR PI
     the rate is 1, so this is a no-op (totalSen unchanged) and existing MYR GL
     behaviour is byte-for-byte identical. The single Dr/Cr pair post the SAME
     figure, so the JE always balances. */
  const foreignTotalSen = Number(pi.total_centi);
  if (foreignTotalSen <= 0) return { ok: false, status: 'zero_total' };
  const totalSen = toMyrSen(foreignTotalSen, pi.exchange_rate); // MYR posted to the GL

  const supplier = pi.suppliers ?? { code: null, name: null };
  const lines: JeLineIn[] = [
    {
      accountCode: '1200',                                   // Inventory (simplification: all PI → Inventory)
      debitSen: totalSen,
      notes: `Inventory from ${pi.invoice_number}`,
    },
    {
      accountCode: '2000',                                   // Accounts Payable
      creditSen: totalSen,
      partyType: 'SUPPLIER',
      partyCode: supplier.code ?? null,
      partyName: supplier.name ?? null,
      notes: `AP for ${pi.invoice_number}`,
    },
  ];

  const jeNo = await nextJeNo(sb, new Date(pi.invoice_date), jePrefixForCompany(pi.company_id));
  // Multi-company (mig 0061): the JE + its lines belong to the PI's company.
  const companyId = pi.company_id ?? null;
  const { data: je, error: jeErr } = await sb
    .from('journal_entries')
    .insert({
      ...(companyId != null ? { company_id: companyId } : {}),
      je_no: jeNo,
      entry_date: pi.invoice_date,
      source_type: 'PI',
      source_doc_no: pi.invoice_number,
      narration: `Purchase invoice ${pi.invoice_number} — ${supplier.name ?? ''}`,
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

accounting.post('/post/pi/:invoiceNumber', async (c) => {
  const invoiceNumber = c.req.param('invoiceNumber');
  const sb = c.get('supabase');

  /* LEAK GUARD (DRAFT, PI two-state — 2026-06-25 anchoring diff vs 2990) — a DRAFT
     PI has committed no AP/GL; the manual re-post endpoint must refuse it, or an
     operator could post a draft's payables out-of-band (the PI route's confirm
     transition is the ONLY path that should post a draft). postPiAccounting does not
     check status, so the guard lives here at the caller — mirrors the /post/si DRAFT
     guard.

     Company scope (owner audit 2026-07-22): same treatment as /post/si — pin
     the invoice_number lookup to the active company so a future prefix
     collision or a HOUZS_OWNS_2990 flip can't post AP against the wrong
     company's books. */
  {
    const { data: pi } = await scopeToCompany(
      sb.from('purchase_invoices').select('status').eq('invoice_number', invoiceNumber),
      c,
    ).maybeSingle();
    if (!pi) return c.json({ error: 'invoice_not_found' }, 404);
    if ((pi as { status?: string }).status === 'DRAFT') {
      return c.json({ error: 'not_postable', message: 'PI is a draft — confirm it (DRAFT → Posted) before posting payables.' }, 409);
    }
  }

  const r = await postPiAccounting(sb, invoiceNumber);
  if (r.ok && r.status === 'migrated_source') {
    return c.json({ ok: true, status: 'migrated_source', posted: false, message: MIGRATED_NO_GL_MESSAGE });
  }
  if (r.ok && r.status === 'already_posted') {
    return c.json({ error: 'already_posted', existingJe: { id: r.jeId, je_no: r.jeNo } }, 409);
  }
  if (r.ok) return c.json({ ok: true, jeNo: r.jeNo, jeId: r.jeId, totalSen: r.totalSen });
  if (r.status === 'invoice_not_found') return c.json({ error: 'invoice_not_found' }, 404);
  if (r.status === 'zero_total') return c.json({ error: 'zero_total' }, 400);
  return c.json({ error: r.status, reason: r.reason }, 500);
});

/* ════════════════════════════════════════════════════════════════════════
   PI accounting reversal (bug #5) — mirror of reverseSiRevenue
   ────────────────────────────────────────────────────────────────────────
   PI posting writes Dr Inventory (1200) / Cr Payables (2000). On PI cancel we
   must trace that back ("取消 PI 要追溯回去") with a contra JE that nets the
   original to zero + flags the original `reversed = true`, so payables +
   inventory value stop being overstated. The balance views only count
   `posted = TRUE AND reversed = FALSE` (migration 0052), so the reversing entry
   exactly cancels the original — net GL impact zero.

   IDEMPOTENT: keyed on the original JE's `reversed` flag AND on the existence of
   a reversing JE (source_type='PI_REVERSAL', source_doc_no=invoice_number).
   Re-cancelling / retries / a second cancel PATCH all no-op. Best-effort
   (audit-DLQ pattern): the caller logs but never un-cancels the PI on failure. */
export async function reversePiAccounting(
  sb: any,
  invoiceNumber: string,
): Promise<{ ok: boolean; status: string; jeNo?: string; jeId?: string; reason?: string }> {
  // Find the ACTIVE (non-reversed) PI JE — an invoice may carry several
  // historical PI JEs after edit-driven void+repost cycles (resyncPiAccounting),
  // so we void the live one, not an arbitrary `.limit(1)` row. Nothing live →
  // nothing to reverse.
  /* A failed read used to return { ok:true, 'nothing_to_reverse' }: the PI is
     cancelled, the caller logs nothing, and Dr Inventory / Cr Payables stays live
     against it — payables and inventory value both left overstated, which is the
     exact condition the contra above exists to undo ("取消 PI 要追溯回去"). */
  const { data: origRows, error: origErr } = await sb
    .from('journal_entries')
    .select('id, je_no, entry_date, reversed, total_debit_sen, total_credit_sen, narration, company_id')
    .eq('source_type', 'PI')
    .eq('source_doc_no', invoiceNumber);
  if (origErr) return { ok: false, status: 'reversal_read_failed', reason: `origRows: ${origErr.message}` };
  const orig = ((origRows ?? []) as Array<{ id: string; je_no: string; entry_date: string; reversed: boolean; total_debit_sen: number; total_credit_sen: number; narration: string | null; company_id: number | null }>)
    .find((r) => !r.reversed);
  if (!orig) return { ok: true, status: 'nothing_to_reverse' };

  // Idempotency guard — a reversing JE already tied to THIS original exists (the
  // flag never stuck). Keyed on reversed_by_je = orig.id, NOT just "any reversal
  // for this invoice", so a prior cycle's reversal doesn't block voiding the
  // current live JE.
  /* Idempotency guard — a blip defeats it rather than degrading it, writing a
     SECOND contra JE so the cancellation is booked twice. Nothing written yet. */
  const { data: revExisting, error: revExistErr } = await sb
    .from('journal_entries')
    .select('id, je_no')
    .eq('source_type', 'PI_REVERSAL')
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
  /* Caught before the `?? []` fold, which cannot tell a failed read from a
     line-less original and would silently contra the canonical Dr 2000 / Cr 1200
     instead of the accounts the original actually used. Still pre-write. */
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
  const revJeNo = await nextJeNo(sb, new Date(orig.entry_date), jePrefixForCompany(companyId));
  const { data: revJe, error: revErr } = await sb
    .from('journal_entries')
    .insert({
      ...(companyId != null ? { company_id: companyId } : {}),
      je_no: revJeNo,
      entry_date: todayMyt(),
      source_type: 'PI_REVERSAL',
      source_doc_no: invoiceNumber,
      narration: `Reversal of ${orig.je_no} — Purchase invoice ${invoiceNumber} cancelled`,
      total_debit_sen: totalSen,
      total_credit_sen: totalSen,
      reversed_by_je: orig.id,
    })
    .select('*')
    .single();
  if (revErr) return { ok: false, status: 'reversal_insert_failed', reason: revErr.message };

  // Swap each original line's debit/credit so the reversal nets the original to
  // zero (Dr Payables / Cr Inventory). Fall back to the canonical 2-line entry
  // if the original had no lines.
  const companyLine = companyId != null ? { company_id: companyId } : {};
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
        { ...companyLine, journal_entry_id: revJe.id, line_no: 1, account_code: '2000', debit_sen: totalSen, credit_sen: 0, party_type: null, party_code: null, party_name: null, notes: `Reverse AP ${invoiceNumber}` },
        { ...companyLine, journal_entry_id: revJe.id, line_no: 2, account_code: '1200', debit_sen: 0, credit_sen: totalSen, party_type: null, party_code: null, party_name: null, notes: `Reverse inventory ${invoiceNumber}` },
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

/* ── resyncPiAccounting (2026-06-01) — re-align a posted PI's GL after a line edit
   Wei Siang chose "auto void the stale entry + re-post at the new amount". UNLIKE
   the SI side, a PI does NOT auto-post on create — it only has a JE once someone
   manually posts it from the accounting page. So this NEVER auto-creates a JE: it
   only fires when an ACTIVE PI JE already exists and its total no longer matches
   the invoice. Idempotent + best-effort. */
export async function resyncPiAccounting(
  sb: any,
  invoiceNumber: string,
): Promise<{ ok: boolean; status: string; reason?: string }> {
  const { data: jeRows, error: jeRowsErr } = await sb
    .from('journal_entries')
    .select('id, total_debit_sen, reversed')
    .eq('source_type', 'PI')
    .eq('source_doc_no', invoiceNumber);
  if (jeRowsErr) return { ok: false, status: 'resync_read_failed', reason: `jeRows: ${jeRowsErr.message}` };
  const active = ((jeRows ?? []) as Array<{ id: string; total_debit_sen: number; reversed: boolean | null }>)
    .find((r) => !r.reversed);
  // Not posted to the GL yet → nothing to keep in sync (PI posts only on demand).
  if (!active) return { ok: true, status: 'not_posted' };

  /* #690 flagged this read as folding "a blip into a changed total and churns a
     void+repost". It is worse than that: there is no repost. A blip leaves `pi`
     null, newTotal folds to 0, the live JE is reversed, and `newTotal <= 0` then
     returns 'reversed_to_zero' BEFORE postPiAccounting is reached — so a healthy
     PI silently loses its payable on a line edit and the caller is told ok.
     `error === null && pi === null` (invoice genuinely gone) keeps voiding, as
     today. */
  const { data: pi, error: piErr } = await sb
    .from('purchase_invoices')
    .select('total_centi, exchange_rate')
    .eq('invoice_number', invoiceNumber)
    .maybeSingle();
  if (piErr) return { ok: false, status: 'resync_read_failed', reason: `pi: ${piErr.message}` };
  const piRow = pi as { total_centi?: number; exchange_rate?: string | number | null } | null;
  // Migration 0082 — the posted JE is in MYR; compare against the MYR-equivalent
  // of the (foreign) PI total so a foreign PI doesn't churn a void+repost every
  // edit. MYR ⇒ rate 1, so newTotal === total_centi (unchanged behaviour).
  const newTotal = toMyrSen(Number(piRow?.total_centi ?? 0), safeRate(piRow?.exchange_rate));
  if (Number(active.total_debit_sen) === newTotal) return { ok: true, status: 'unchanged' };

  // Total changed → void the stale JE, then re-post at the new amount.
  const rev = await reversePiAccounting(sb, invoiceNumber);
  if (!rev.ok) return { ok: false, status: rev.status, reason: rev.reason };
  if (newTotal <= 0) return { ok: true, status: 'reversed_to_zero' };
  const post = await postPiAccounting(sb, invoiceNumber);
  return post.ok ? { ok: true, status: 'resynced' } : { ok: false, status: post.status, reason: (post as { reason?: string }).reason };
}

/* ════════════════════════════════════════════════════════════════════════
   GL stream + balances + aging
   ════════════════════════════════════════════════════════════════════════ */

accounting.get('/gl', async (c) => {
  const sb = c.get('supabase');
  const accountCode = c.req.query('accountCode');
  const from = c.req.query('from');
  const to = c.req.query('to');

  // PostgREST's 1000-row cap silently truncated the GL export — page through so
  // a wide account/date range exports every entry, not just the first 1000.
  const { data, error } = await paginateAll((pFrom, pTo) => {
    let q = sb.from('v_gl_entries').select('*');
    q = scopeToCompany(q, c); // multi-company: isolate GL lines to the active company (view exposes company_id, mig 0106)
    if (accountCode) q = q.eq('account_code', accountCode);
    if (from)        q = q.gte('entry_date', from);
    if (to)          q = q.lte('entry_date', to);
    return q.range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ glEntries: data ?? [] });
});

accounting.get('/balances', async (c) => {
  const sb = c.get('supabase');
  // PostgREST's 1000-row cap silently truncated the balance list — page through
  // so every account balance is returned, not just the first 1000.
  const { data, error } = await paginateAll((from, to) => scopeToCompany(sb
    .from('v_account_balances')
    .select('*'), c) // multi-company: isolate balances to the active company (view exposes company_id, mig 0106)
    .range(from, to));
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ balances: data ?? [] });
});

accounting.get('/ar-aging', async (c) => {
  const sb = c.get('supabase');
  /* LEAK GUARD (DRAFT, two-state — 2026-06-25 anchoring diff vs 2990) — v_ar_aging
     filters CANCELLED/VOID but NOT DRAFT (the view predates the SI two-state). A
     DRAFT SI has posted no AR yet, so it must never appear in the aging buckets; the
     view exposes s.status, so filter DRAFT out here at the route (migrations are
     frozen). */
  // PostgREST's 1000-row cap silently truncated the aging buckets — page through
  // so the full AR ledger is bucketed, not just the first 1000 rows. Ordering
  // stays inside the page factory so every page is consistent.
  const { data, error } = await paginateAll((from, to) => scopeToCompany(sb
    .from('v_ar_aging')
    .select('*')
    .neq('status', 'DRAFT'), c) // multi-company: isolate AR aging to the active company (view exposes company_id, mig 0106)
    .order('days_overdue', { ascending: false })
    .range(from, to));
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ arAging: data ?? [] });
});

accounting.get('/ap-aging', async (c) => {
  const sb = c.get('supabase');
  /* LEAK GUARD (DRAFT, PI two-state — 2026-06-25 anchoring diff vs 2990) — v_ap_aging
     filters CANCELLED/VOID but NOT DRAFT (the view predates the PI two-state). A
     DRAFT PI has posted no AP yet, so it must never appear in the aging buckets; the
     view exposes p.status, so filter DRAFT out here at the route (migrations are
     frozen). Mirrors the /ar-aging DRAFT fix. */
  // PostgREST's 1000-row cap silently truncated the aging buckets — page through
  // so the full AP ledger is bucketed, not just the first 1000 rows. Ordering
  // stays inside the page factory so every page is consistent.
  const { data, error } = await paginateAll((from, to) => scopeToCompany(sb
    .from('v_ap_aging')
    .select('*')
    .neq('status', 'DRAFT'), c) // multi-company: isolate AP aging to the active company (view exposes company_id, mig 0106)
    .order('days_overdue', { ascending: false })
    .range(from, to));
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ apAging: data ?? [] });
});
