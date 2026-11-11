// ---------------------------------------------------------------------------
// /scan-pi/check — scan, check, then create, for supplier invoices (owner
// 2026-11-04: "PI也是需要"). The PI twin of scan-gr-check.ts: one PDF holding many
// invoices or many files; each is read in the background and waits as an
// editable working copy until the operator creates the drafts or deletes it.
// An invoice number already on a purchase invoice of that supplier is flagged,
// and can still be created or deleted.
//
// SAFETY: Create converts the checked rows through createDraftPiFromGrnItems,
// the same core as every other path: DRAFT only (no AP booked), always from
// posted GRN lines, company-scoped, never over what is left to bill.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { activeCompanyId } from '../lib/companyScope';
import { resolveCallerStaffId } from '../lib/salesScope';
import { companyCodeById } from '../lib/doc-no';
import { saveScanCodes } from '../lib/grn-scan-codes';
import { loadSuppliers } from '../lib/grn-scan-load';
import { createDraftPiFromGrnItems } from '../lib/pi-from-grn-core';
import { loadBillableLines, reviewOfPiRead } from '../lib/pi-scan-run';
import type { PiScanExtract } from '../lib/pi-scan-extract';
import { PI_REVIEW_VERSION, billBlocked, billCodesToTeach, billPicks, cleanPiReview, duplicatePi, extractOfReview, mergeRebuiltLines, repeatedPis, staleSuggestions, staleTie, type BillableLine, type ExistingPi, type PiReview } from '../lib/pi-scan-check';
import { aiSkuMatcher, type AiSkuMatcher } from '../lib/pi-scan-ai-match';
import { refVariants } from '../lib/grn-scan-check';
import { callerId, goldSamples, handleDiscard, handleFile, handleGold, handleRetry, handleUpload, idsOf, jsonBody, ownRows, svcOf, waitingRows, type CheckRow } from './scan-check-shared';
import { reapStalePiScanJobs, runPiJobFromRow } from './scan-pi';

export const scanPiCheck = new Hono<{ Bindings: Env; Variables: Variables }>();
scanPiCheck.use('*', supabaseAuth);

scanPiCheck.post('/upload', (c) => handleUpload(c, { documentType: 'PI', feature: 'scan_pi_split', reviewVersion: PI_REVIEW_VERSION, scannedToday: (review) => review, runLocal: runPiJobFromRow }));

/* GET /scan-pi/check/pending — this user's invoices still being read or waiting
   to be checked, with the suppliers, what is left to bill on every supplier on
   them, and per invoice whether it repeats one already made. */
/* A working copy of an older shape: rebuild it from the stored read, once, so a
   waiting invoice takes the newer matching without being uploaded again. The head
   the operator may have edited and every row already tied stay; a row still
   untied takes what the newer matching ties it to. Copies rebuild side by side:
   each may ask the AI once. */
async function upgradeCopies(svc: ReturnType<typeof svcOf>, companyId: number | null, rows: Array<CheckRow<PiReview>>, ai: AiSkuMatcher | null, open: ReadonlyMap<string, BillableLine>): Promise<void> {
  await Promise.all(rows.map((r) => upgradeCopy(svc, companyId, r, ai, open)));
}

async function upgradeCopy(svc: ReturnType<typeof svcOf>, companyId: number | null, r: CheckRow<PiReview>, ai: AiSkuMatcher | null, open: ReadonlyMap<string, BillableLine>): Promise<void> {
  if (r.review_state !== 'pending' || !r.review) return;
  /* A SUGGESTED tie to a receipt line another invoice has since billed is stale: the
     row showed blank under "no longer open to bill" and never matched again (owner
     2026-11-10, INV-2610-097 after the batch's other invoices were created). Untie it
     and rebuild; a tie the operator chose keeps its warning instead. A row printed at
     RM 0 tied to a line that costs money is stale too (INV-2610-097's free JAGER). */
  const stale = staleSuggestions(r.review, open);
  if (r.review.v === PI_REVIEW_VERSION && stale === 0) return;
  const older = r.review.v < PI_REVIEW_VERSION;
  if (stale > 0) r.review = { ...r.review, lines: r.review.lines.map((l) => (staleTie(l, open, older) ? { ...l, grnItemId: null, grnNumber: null, suggested: false, ai: false } : l)) };
  /* The stored read when there is one; else the copy's own rows (2026-11-09: the
     five HOOKKA invoices waiting at deploy carried no scan sample, so they were
     skipped and kept their old, empty matching). */
  let parsed: PiScanExtract | null = null;
  if (r.sample_id) {
    const { data, error } = await svc.from('so_scan_samples').select('extracted').eq('id', r.sample_id).maybeSingle();
    if (error) { console.warn('[scan-pi check] read not loaded, copy left as it is:', r.id, error.message); return; }
    parsed = (data as { extracted: PiScanExtract | null } | null)?.extracted ?? null;
  }
  if (!parsed || !Array.isArray(parsed.lines)) parsed = extractOfReview(r.review);
  if (!parsed) return;
  const { review, note } = await reviewOfPiRead(svc, companyId, parsed, ai);
  // A supplier the operator chose stands; the rows' ties then follow the copy kept.
  const keepSupplier = r.review.supplierId != null && r.review.supplierId !== review.supplierId;
  const lines = keepSupplier ? r.review.lines : mergeRebuiltLines(r.review.lines, review.lines);
  const next: PiReview = { ...review, supplierId: r.review.supplierId ?? review.supplierId, invoiceNumber: r.review.invoiceNumber ?? review.invoiceNumber, invoiceDate: r.review.invoiceDate ?? review.invoiceDate, lines };
  const stillNote = lines.some((l) => l.grnItemId) ? null : note;
  const { error: upErr } = await svc.from('scan_jobs').update({ review: next, error: stillNote }).eq('id', r.id).eq('company_id', companyId).eq('review_state', 'pending');
  if (upErr) { console.warn('[scan-pi check] copy not upgraded:', r.id, upErr.message); return; }
  r.review = next;
  r.error = stillNote;
}

scanPiCheck.get('/pending', async (c) => {
  const svc = svcOf(c.env);
  const companyId = activeCompanyId(c) ?? null;
  // A document whose queue message died comes back here even if nobody opens the old list.
  await reapStalePiScanJobs(c.env, svc, (p) => { try { c.executionCtx.waitUntil(p); } catch { /* tests */ } });
  const waiting = await waitingRows<PiReview>(svc, c, 'PI');
  if ('failed' in waiting) return c.json({ error: 'query_failed', reason: 'Could not load your scans. Please try again.' }, 500);
  const { rows } = waiting;
  const [suppliers, lines] = await Promise.all([loadSuppliers(svc, companyId), loadBillableLines(svc, companyId)]);
  if (lines === null) return c.json({ error: 'query_failed', reason: 'Could not load what is left to bill. Please try again.' }, 500);
  const open = new Map(lines.map((l) => [l.grnItemId, l]));
  await upgradeCopies(svc, companyId, rows, aiSkuMatcher(c.env, companyId, callerId(c)), open);
  const refs = [...new Set(rows.flatMap((r) => (r.review?.invoiceNumber ? refVariants(r.review.invoiceNumber) : [])))];
  const existing: ExistingPi[] = [];
  if (refs.length > 0) {
    const { data, error } = await svc.from('purchase_invoices').select('id, invoice_number, supplier_id, supplier_invoice_ref, status, invoice_date')
      .eq('company_id', companyId).neq('status', 'CANCELLED').in('supplier_invoice_ref', refs);
    // Without this read no repeat could be flagged, so the list is refused rather than shown clean.
    if (error) return c.json({ error: 'query_failed', reason: 'Could not check for invoices already billed. Please try again.' }, 500);
    for (const x of (data as Array<{ id: string; invoice_number: string; supplier_id: string | null; supplier_invoice_ref: string | null; status: string; invoice_date: string | null }> | null) ?? []) {
      existing.push({ id: x.id, invoiceNumber: x.invoice_number, supplierId: x.supplier_id, supplierInvoiceRef: x.supplier_invoice_ref, status: x.status, invoiceDate: x.invoice_date });
    }
  }
  const gold = await goldSamples(svc, rows.map((r) => r.sample_id).filter((x): x is string => !!x));
  const repeats = repeatedPis(rows.map((r) => ({ id: r.id, fileName: r.file_name, review: r.review })));
  return c.json({ success: true, data: {
    documents: rows.map((r) => ({
      id: r.id, batchId: r.batch_id, fileName: r.file_name, pages: r.page_from != null ? [r.page_from, r.page_to] : null,
      state: r.status === 'error' ? 'failed' : r.review_state, note: r.error, review: r.review, createdAt: r.created_at,
      hasFile: (r.image_keys ?? []).length > 0,
      canGold: !!r.sample_id, gold: !!r.sample_id && gold.has(r.sample_id),
      duplicateOf: r.review ? duplicatePi(r.review, existing) : null,
      repeatOf: repeats.get(r.id) ?? null,
      blocked: r.review ? billBlocked(r.review, open) : null,
    })),
    suppliers: suppliers.map((s) => ({ id: s.id, code: s.code, name: s.name })),
    billLines: lines,
  } });
});

/* PATCH /scan-pi/check/:id {review} — save the operator's edit. */
scanPiCheck.patch('/:id', async (c) => {
  const review = cleanPiReview(((await jsonBody(c)) as { review?: unknown } | null)?.review);
  if (!review) return c.json({ error: 'bad_request', reason: 'Nothing to save.' }, 400);
  const svc = svcOf(c.env);
  const row = (await ownRows<PiReview>(svc, c, 'PI', [c.req.param('id')]))[0] as CheckRow<PiReview> | undefined;
  if (!row) return c.json({ error: 'not_found', reason: 'This scan is no longer here.' }, 404);
  if (row.review_state !== 'pending') return c.json({ error: 'not_editable', reason: row.review_state === 'reading' ? 'Still reading this document.' : 'This scan was already handled.' }, 409);
  const { error } = await svc.from('scan_jobs').update({ review, updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('company_id', activeCompanyId(c)).eq('review_state', 'pending');
  if (error) return c.json({ error: 'save_failed', reason: 'Could not save. Please try again.' }, 500);
  return c.json({ success: true });
});

const REFUSED: Record<string, string> = {
  qty_exceeds_remaining: 'A row bills more than is left on its Goods Receipt line.',
  item_not_found: 'A Goods Receipt line on it is not in this company.',
};

/* POST /scan-pi/check/create {ids} — make the DRAFT purchase invoices. One result
   per document; a refused one keeps its working copy and says why. */
scanPiCheck.post('/create', async (c) => {
  // company-scope: rows are read with the active company and the caller; drafts go through createDraftPiFromGrnItems, whose GRN-line read is company-scoped; each row update repeats the company predicate.
  const svc = svcOf(c.env);
  const companyId = activeCompanyId(c) ?? null;
  const rows = (await ownRows<PiReview>(svc, c, 'PI', idsOf(await jsonBody(c)))).filter((r) => r.review_state === 'pending' && r.review);
  const companyCode = await companyCodeById(svc, companyId);
  const houzsUserId = callerId(c);
  const userId = (await resolveCallerStaffId(svc, houzsUserId)) ?? c.get('user').id;
  const itemOfLine = new Map(((await loadBillableLines(svc, companyId)) ?? []).map((l) => [l.grnItemId, l.itemCode]));
  const results: Array<{ id: string; ok: boolean; docNumbers?: string[]; reason?: string }> = [];
  for (const r of rows) {
    const review = r.review as PiReview;
    const picks = billPicks(review);
    if (picks.length === 0) { results.push({ id: r.id, ok: false, reason: 'No row is tied to a Goods Receipt line yet.' }); continue; }
    const res = await createDraftPiFromGrnItems(c.env, {
      userId, houzsUserId, companyId, allowedCompanyIds: companyId != null ? [companyId] : null, companyCode, picks,
      supplierInvoiceNumber: review.invoiceNumber, invoiceDate: review.invoiceDate, notes: review.notes,
      /* The queue showed "Already billed" (duplicatePi) before this button; the
         operator's choice to create anyway stands. */
      duplicateBill: 'allow',
    });
    if (!res.ok || res.created.length === 0) {
      const b = res.ok ? {} : res.body;
      results.push({ id: r.id, ok: false, reason: (typeof b.message === 'string' && b.message) || (typeof b.reason === 'string' && b.reason) || REFUSED[String(b.error)] || 'The purchase invoice could not be created.' });
      continue;
    }
    const docNumbers = res.created.map((d) => d.invoiceNumber);
    const teach = billCodesToTeach(review, (id) => itemOfLine.get(id));
    if (teach.length > 0 && review.supplierId && companyId != null) {
      const saved = await saveScanCodes(svc, { companyId, supplierId: review.supplierId, userId: houzsUserId, pairs: teach });
      if (!saved.ok) console.warn('[scan-pi check] codes not remembered:', saved.reason);
    }
    await svc.from('scan_jobs').update({ review_state: 'created', linked_doc_no: docNumbers.join(', '), updated_at: new Date().toISOString() })
      .eq('id', r.id).eq('company_id', companyId);
    results.push({ id: r.id, ok: true, docNumbers });
  }
  return c.json({ success: true, data: { results } });
});

scanPiCheck.post('/discard', (c) => handleDiscard(c, 'PI'));
scanPiCheck.post('/:id/gold', (c) => handleGold(c, 'PI'));
scanPiCheck.post('/:id/retry', (c) => handleRetry(c, 'PI'));
scanPiCheck.get('/:id/file', (c) => handleFile(c, 'PI'));
