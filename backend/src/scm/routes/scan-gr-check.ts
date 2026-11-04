// ---------------------------------------------------------------------------
// /scan-gr/check — scan, check, then create (owner 2026-11-03, after Hookka's
// scan modal). Drop any number of delivery orders — one PDF holding twenty, or
// twenty files — and each document is read in the background. What was read
// waits here as an editable working copy (scan_jobs.review) until the operator
// creates the drafts or deletes it; leaving the page or logging out loses
// nothing. A delivery order already received under another goods receipt is
// flagged, and the operator still chooses: create anyway, or delete.
//
// SAFETY: Create converts the checked lines through createDraftGrnFromPoItems,
// the same core as every other path — DRAFT only (no stock moves), always from
// PO lines, company-scoped read of every PO line, qty capped at what is owed.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { activeCompanyId } from '../lib/companyScope';
import { resolveCallerStaffId } from '../lib/salesScope';
import { companyCodeById } from '../lib/doc-no';
import { IMAGE_MIMES, MAX_FILE_BYTES, sha256Hex } from '../lib/scan-ocr';
import { askBoundaries, cutPdf, pdfPageCount, planChunks } from '../lib/scan-split';
import { createDraftGrnFromPoItems } from '../lib/grn-from-po-core';
import { loadOpenPoLines, loadSuppliers } from '../lib/grn-scan-load';
import { blockedReason, cleanReview, duplicateOf, picksOf, type GrnReview } from '../lib/grn-scan-check';
import { runGrnJobFromRow } from './scan-gr';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped service client every scm route uses
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export const scanGrCheck = new Hono<{ Bindings: Env; Variables: Variables }>();
scanGrCheck.use('*', supabaseAuth);

const svcOf = (env: Env) => getSupabaseService(env) as unknown as SupabaseClient;
const callerId = (c: { get(k: 'houzsUser'): { id?: unknown } | undefined }): number | null => {
  const id = c.get('houzsUser')?.id;
  return id != null && Number.isFinite(Number(id)) ? Number(id) : null;
};
const MAX_FILES = 50;
// Older than this, a working copy no longer comes back on its own.
const KEEP_DAYS = 14;

type CheckRow = {
  id: string; batch_id: string | null; status: string; review_state: string; review: GrnReview | null;
  error: string | null; file_name: string | null; page_from: number | null; page_to: number | null;
  image_keys: string[] | null; linked_doc_no: string | null; created_at: string; sample_id: string | null;
};
const ROW_COLS = 'id, batch_id, status, review_state, review, error, file_name, page_from, page_to, image_keys, linked_doc_no, created_at, sample_id';

/* POST /scan-gr/check/upload — multipart, repeated `file`. Every file is one
   document, except a PDF of several pages, which is split into the documents it
   holds. Answers with the batch once every document is queued; the reading
   happens after. */
scanGrCheck.post('/upload', async (c) => {
  // company-scope: every scan_jobs row below is inserted with company_id = the active company; the image_keys update targets only the row just inserted.
  let form: FormData;
  try { form = await c.req.formData(); } catch { return c.json({ error: 'bad_request', reason: 'The files could not be uploaded. Please try again.' }, 400); }
  const files: File[] = [];
  for (const [, v] of form.entries()) if (v instanceof File && v.size > 0) files.push(v);
  if (files.length === 0) return c.json({ error: 'bad_request', reason: 'Add at least one file.' }, 400);
  if (files.length > MAX_FILES) return c.json({ error: 'bad_request', reason: `At most ${MAX_FILES} files at a time.` }, 400);

  const svc = svcOf(c.env);
  const companyId = activeCompanyId(c) ?? null;
  const houzsUserId = callerId(c);
  const uploaderStaffId = (await resolveCallerStaffId(svc, houzsUserId)) ?? c.get('user').id;
  const batchId = crypto.randomUUID();

  // Every document to read: whole files, and each part of a split PDF.
  const docs: Array<{ name: string; mime: string; bytes: ArrayBuffer; pages: [number, number] | null }> = [];
  for (const f of files) {
    const isPdf = f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
    if (f.size > MAX_FILE_BYTES) return c.json({ error: 'bad_request', reason: `${f.name} is larger than 20 MB.` }, 400);
    if (!isPdf && !IMAGE_MIMES.has(f.type)) return c.json({ error: 'bad_request', reason: `${f.name}: use a PDF, JPEG, PNG or WEBP.` }, 400);
    const bytes = await f.arrayBuffer();
    if (!isPdf) { docs.push({ name: f.name, mime: f.type, bytes, pages: null }); continue; }
    const pages = await pdfPageCount(bytes);
    const answer = pages > 1 && c.env.ANTHROPIC_API_KEY
      ? await askBoundaries(c.env.ANTHROPIC_API_KEY, bytes, { env: c.env, feature: 'scan_gr_split', model: 'claude-haiku-4-5', companyId, userId: houzsUserId, waitUntil: null })
      : null;
    const parts = await cutPdf(bytes, planChunks(answer, pages));
    for (const p of parts) docs.push({ name: f.name, mime: 'application/pdf', bytes: p.bytes, pages: pages > 1 ? [p.chunk.startPage, p.chunk.endPage] : null });
  }

  const ids: string[] = [];
  let reused = 0;
  for (const d of docs) {
    /* The same file read before in this company: take that read (as first
       matched, before any edit) instead of paying for another, like Hookka's
       file-hash cache. The operator still checks it. */
    const fileHash = await sha256Hex(d.bytes);
    const { data: prior, error: priorErr } = await svc.from('scan_jobs').select('review, error').eq('company_id', companyId).eq('document_type', 'GR')
      .eq('file_hash', fileHash).not('review', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle();
    // A failed look-up only costs a fresh read, never a wrong one.
    if (priorErr) console.warn('[scan-gr check] earlier-read look-up failed, reading afresh:', priorErr.message);
    const seen = priorErr ? null : (prior as { review: unknown; error: string | null } | null);
    const { data, error } = await svc.from('scan_jobs').insert({
      status: seen ? 'done' : 'queued', document_type: 'GR', review_state: seen ? 'pending' : 'reading', batch_id: batchId,
      review: seen?.review ?? null, error: seen ? seen.error : null, file_hash: fileHash,
      file_name: d.name, page_from: d.pages?.[0] ?? null, page_to: d.pages?.[1] ?? null,
      salesperson: null, salesperson_id: uploaderStaffId, houzs_user_id: houzsUserId, image_keys: [], company_id: companyId,
    }).select('id').single();
    const id = (data as { id?: string } | null)?.id;
    if (error || !id) { console.error('[scan-gr check] insert failed:', error?.message); return c.json({ error: 'enqueue_failed', reason: 'Could not queue the scan. Please try again.' }, 500); }
    const key = `scan-jobs/${id}/0`;
    try {
      await c.env.SO_ITEM_PHOTOS.put(key, d.bytes, { httpMetadata: { contentType: d.mime } });
      await svc.from('scan_jobs').update({ image_keys: [key] }).eq('id', id).eq('company_id', companyId);
    } catch (e) { console.warn('[scan-gr check] R2 put failed:', key, (e as Error).message); }
    if (seen) reused += 1; else ids.push(id);
  }
  for (const id of ids) {
    if (c.env.SCAN_QUEUE) {
      try { await c.env.SCAN_QUEUE.send({ jobId: id }); } catch (e) { console.error('[scan-gr check] queue send failed:', id, (e as Error).message); }
    } else {
      const run = (async () => {
        const { data, error: readErr } = await svc.from('scan_jobs').select('id, salesperson_id, houzs_user_id, image_keys, company_id, review_state').eq('id', id).single();
        if (readErr) { console.error('[scan-gr check] job read failed:', id, readErr.message); return; }
        await runGrnJobFromRow(c.env, id, data as Record<string, unknown>);
      })();
      try { c.executionCtx.waitUntil(run); } catch { /* non-Workers runtime (tests) */ }
    }
  }
  return c.json({ success: true, data: { batchId, documents: ids.length + reused, reused } }, 202);
});

/* GET /scan-gr/check/pending — this user's documents still being read or
   waiting to be checked (last 14 days), with what the editor needs: the
   suppliers, the open PO lines of every supplier on them, and per document
   whether it is a repeat of a receipt already made and what still blocks it. */
scanGrCheck.get('/pending', async (c) => {
  const svc = svcOf(c.env);
  const companyId = activeCompanyId(c) ?? null;
  const since = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString();
  const { data, error } = await svc.from('scan_jobs').select(ROW_COLS)
    .eq('company_id', companyId).eq('document_type', 'GR').eq('houzs_user_id', callerId(c))
    .in('review_state', ['reading', 'pending']).gte('created_at', since)
    .order('created_at', { ascending: true }).limit(200);
  if (error) return c.json({ error: 'query_failed', reason: 'Could not load your scans. Please try again.' }, 500);
  const rows = (data as CheckRow[] | null) ?? [];

  const [suppliers, openLines] = await Promise.all([loadSuppliers(svc, companyId), loadOpenPoLines(svc, companyId)]);
  const open = new Map(openLines.map((l) => [l.poItemId, l]));
  const refs = [...new Set(rows.map((r) => r.review?.doNo).filter((x): x is string => !!x))];
  const existing: Array<{ grnNumber: string; supplierId: string | null; deliveryNoteRef: string | null }> = [];
  if (refs.length > 0) {
    const { data: g, error: gErr } = await svc.from('grns').select('grn_number, supplier_id, delivery_note_ref')
      .eq('company_id', companyId).neq('status', 'CANCELLED').in('delivery_note_ref', refs);
    // Without this read no repeat could be flagged, so the list is refused rather than shown clean.
    if (gErr) return c.json({ error: 'query_failed', reason: 'Could not check for delivery orders already received. Please try again.' }, 500);
    for (const x of (g as Array<{ grn_number: string; supplier_id: string | null; delivery_note_ref: string | null }> | null) ?? []) {
      existing.push({ grnNumber: x.grn_number, supplierId: x.supplier_id, deliveryNoteRef: x.delivery_note_ref });
    }
  }
  // Marked as gold = the read is a good example the scanner learns from (so_scan_samples ACCEPTED / CONFIRMED).
  const sampleIds = rows.map((r) => r.sample_id).filter((x): x is string => !!x);
  const gold = new Set<string>();
  if (sampleIds.length > 0) {
    const { data: ss, error: ssErr } = await svc.from('so_scan_samples').select('id, status').in('id', sampleIds);
    if (ssErr) console.warn('[scan-gr check] sample status read failed (gold marks hidden):', ssErr.message);
    for (const x of (ss as Array<{ id: string; status: string }> | null) ?? []) if (x.status === 'ACCEPTED' || x.status === 'CONFIRMED') gold.add(x.id);
  }
  const supplierIds = new Set(rows.map((r) => r.review?.supplierId).filter(Boolean));
  const documents = rows.map((r) => ({
    id: r.id, batchId: r.batch_id, fileName: r.file_name, pages: r.page_from != null ? [r.page_from, r.page_to] : null,
    state: r.status === 'error' ? 'failed' : r.review_state, note: r.error, review: r.review, createdAt: r.created_at,
    hasFile: (r.image_keys ?? []).length > 0,
    canGold: !!r.sample_id, gold: !!r.sample_id && gold.has(r.sample_id),
    duplicateOf: r.review ? duplicateOf(r.review, existing) : null,
    blocked: r.review ? blockedReason(r.review, open) : null,
  }));
  return c.json({ success: true, data: {
    documents,
    suppliers: suppliers.map((s) => ({ id: s.id, code: s.code, name: s.name })),
    poLines: openLines.filter((l) => l.supplierId && supplierIds.has(l.supplierId)).map((l) => ({
      poItemId: l.poItemId, poNumber: l.poNumber, supplierId: l.supplierId, itemCode: l.itemCode,
      name: l.materialName, remaining: l.remaining, warehouse: l.locationCode,
    })),
  } });
});

/* Open PO lines of one supplier, when the operator changes a document's supplier. */
scanGrCheck.get('/po-lines', async (c) => {
  const supplierId = c.req.query('supplierId') ?? '';
  const lines = (await loadOpenPoLines(svcOf(c.env), activeCompanyId(c) ?? null)).filter((l) => l.supplierId === supplierId);
  return c.json({ success: true, data: { poLines: lines.map((l) => ({
    poItemId: l.poItemId, poNumber: l.poNumber, supplierId: l.supplierId, itemCode: l.itemCode, name: l.materialName, remaining: l.remaining, warehouse: l.locationCode,
  })) } });
});

async function ownRows(svc: SupabaseClient, c: Parameters<typeof activeCompanyId>[0] & { get(k: 'houzsUser'): { id?: unknown } | undefined }, ids: string[]): Promise<CheckRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await svc.from('scan_jobs').select(ROW_COLS)
    .eq('company_id', activeCompanyId(c)).eq('document_type', 'GR').eq('houzs_user_id', callerId(c)).in('id', ids.slice(0, 200));
  if (error) throw new Error(`Could not load your scans: ${error.message}`);
  return (data as CheckRow[] | null) ?? [];
}
/** The request body, or null when it is not JSON (the caller answers 400). */
async function jsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try { return await c.req.json(); } catch { return null; }
}
const idsOf = (body: unknown): string[] => (Array.isArray((body as { ids?: unknown } | null)?.ids) ? ((body as { ids: unknown[] }).ids).filter((x): x is string => typeof x === 'string') : []);

/* PATCH /scan-gr/check/:id {review} — save the operator's edit. */
scanGrCheck.patch('/:id', async (c) => {
  const body = await jsonBody(c) as { review?: unknown } | null;
  const review = cleanReview(body?.review);
  if (!review) return c.json({ error: 'bad_request', reason: 'Nothing to save.' }, 400);
  const svc = svcOf(c.env);
  const row = (await ownRows(svc, c, [c.req.param('id')]))[0] as CheckRow | undefined;
  if (!row) return c.json({ error: 'not_found', reason: 'This scan is no longer here.' }, 404);
  if (row.review_state !== 'pending') return c.json({ error: 'not_editable', reason: row.review_state === 'reading' ? 'Still reading this document.' : 'This scan was already handled.' }, 409);
  const { error } = await svc.from('scan_jobs').update({ review, updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('company_id', activeCompanyId(c)).eq('review_state', 'pending');
  if (error) return c.json({ error: 'save_failed', reason: 'Could not save. Please try again.' }, 500);
  return c.json({ success: true });
});

/* POST /scan-gr/check/create {ids} — make the DRAFT goods receipts. One result
   per document; a refused one keeps its working copy and says why. */
scanGrCheck.post('/create', async (c) => {
  // company-scope: rows are read with the active company and the caller; drafts go through createDraftGrnFromPoItems, whose PO-line read is company-scoped; each row update repeats the company predicate.
  const svc = svcOf(c.env);
  const companyId = activeCompanyId(c) ?? null;
  const rows = (await ownRows(svc, c, idsOf(await jsonBody(c)))).filter((r) => r.review_state === 'pending' && r.review);
  const companyCode = await companyCodeById(svc, companyId);
  const houzsUserId = callerId(c);
  const userId = (await resolveCallerStaffId(svc, houzsUserId)) ?? c.get('user').id;
  const results: Array<{ id: string; ok: boolean; grnNumbers?: string[]; reason?: string }> = [];
  for (const r of rows) {
    const review = r.review as GrnReview;
    const picks = picksOf(review);
    if (picks.length === 0) { results.push({ id: r.id, ok: false, reason: 'No line is tied to a PO line yet.' }); continue; }
    const res = await createDraftGrnFromPoItems(c.env, {
      userId, houzsUserId, companyId, companyCode, picks,
      notes: [review.doNo ? `D.O. ${review.doNo}` : 'Scanned delivery order', review.notes].filter(Boolean).join(' · '),
      receivedDate: review.deliveryDate ?? undefined,
      deliveryNoteRef: review.doNo,
    });
    if (!res.ok || res.created.length === 0) {
      const b = res.ok ? {} : res.body;
      const reason = typeof b.reason === 'string' ? b.reason
        : b.error === 'qty_exceeds_remaining' ? `A line asks for ${String(b.requested)} but only ${String(b.remaining)} is still owed.`
        : b.error === 'po_not_receivable' ? 'A PO on it can no longer be received (closed, cancelled or on hold).'
        : b.error === 'item_not_found' ? 'A PO line on it is not in this company.'
        : 'The goods receipt could not be created.';
      results.push({ id: r.id, ok: false, reason });
      continue;
    }
    const grnNumbers = res.created.map((g) => g.grnNumber);
    await svc.from('scan_jobs').update({ review_state: 'created', linked_doc_no: grnNumbers[0], updated_at: new Date().toISOString() })
      .eq('id', r.id).eq('company_id', companyId);
    results.push({ id: r.id, ok: true, grnNumbers });
  }
  return c.json({ success: true, data: { results } });
});

/* POST /scan-gr/check/discard {ids} — delete scans from the list (Clear all
   sends every id). The read stays for the audit and the learning pool. */
scanGrCheck.post('/discard', async (c) => {
  const svc = svcOf(c.env);
  const rows = await ownRows(svc, c, idsOf(await jsonBody(c)));
  const ids = rows.filter((r) => r.review_state === 'pending' || r.review_state === 'reading' || r.status === 'error').map((r) => r.id);
  if (ids.length === 0) return c.json({ success: true, data: { discarded: 0 } });
  const { error } = await svc.from('scan_jobs').update({ review_state: 'discarded', updated_at: new Date().toISOString() })
    .eq('company_id', activeCompanyId(c)).in('id', ids);
  if (error) return c.json({ error: 'discard_failed', reason: 'Could not delete. Please try again.' }, 500);
  return c.json({ success: true, data: { discarded: ids.length } });
});

/* POST /scan-gr/check/:id/gold — mark this read as a good example: the sample
   lands ACCEPTED (corrected = what was read) and joins the scanner's few-shot
   pool, the same promotion a posted draft gives it. */
scanGrCheck.post('/:id/gold', async (c) => {
  // company-scope: the sample id comes from the caller's own company-scoped scan row; so_scan_samples has no company column.
  const svc = svcOf(c.env);
  const row = (await ownRows(svc, c, [c.req.param('id')]))[0] as CheckRow | undefined;
  if (!row?.sample_id) return c.json({ error: 'not_found', reason: 'Nothing was read off this scan yet.' }, 404);
  const { data: sample, error: readErr } = await svc.from('so_scan_samples').select('extracted, status').eq('id', row.sample_id).maybeSingle();
  if (readErr) return c.json({ error: 'query_failed', reason: 'Could not load this read. Please try again.' }, 500);
  const sm = sample as { extracted: unknown; status: string } | null;
  if (!sm?.extracted) return c.json({ error: 'not_found', reason: 'Nothing was read off this scan.' }, 404);
  if (sm.status === 'ACCEPTED' || sm.status === 'CONFIRMED') return c.json({ success: true });
  const { error } = await svc.from('so_scan_samples').update({ corrected: sm.extracted, status: 'ACCEPTED' }).eq('id', row.sample_id).eq('status', sm.status);
  if (error) return c.json({ error: 'save_failed', reason: 'Could not mark it. Please try again.' }, 500);
  return c.json({ success: true });
});

/* POST /scan-gr/check/:id/retry — read a document that failed once more. */
scanGrCheck.post('/:id/retry', async (c) => {
  const svc = svcOf(c.env);
  const row = (await ownRows(svc, c, [c.req.param('id')]))[0] as CheckRow | undefined;
  if (!row || row.status !== 'error') return c.json({ error: 'not_retryable', reason: 'Only a scan that could not be read can be read again.' }, 409);
  const { error } = await svc.from('scan_jobs').update({ status: 'queued', retry_count: 0, error: null, review_state: 'reading', updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('company_id', activeCompanyId(c)).eq('status', 'error');
  if (error) return c.json({ error: 'retry_failed', reason: 'Could not start the scan again. Please try again.' }, 500);
  if (c.env.SCAN_QUEUE) await c.env.SCAN_QUEUE.send({ jobId: row.id });
  return c.json({ success: true });
});

/* GET /scan-gr/check/:id/file — the document as uploaded (or its pages), for the preview. */
scanGrCheck.get('/:id/file', async (c) => {
  const row = (await ownRows(svcOf(c.env), c, [c.req.param('id')]))[0] as CheckRow | undefined;
  const key = row?.image_keys?.[0];
  if (!key) return c.json({ error: 'not_found' }, 404);
  const obj = await c.env.SO_ITEM_PHOTOS.get(key);
  if (!obj) return c.json({ error: 'not_found' }, 404);
  return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'cache-control': 'private, max-age=600' } });
});
