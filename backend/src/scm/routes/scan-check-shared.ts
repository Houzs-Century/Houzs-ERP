// ---------------------------------------------------------------------------
// scan-check-shared — what the check step of every scanned document does alike
// (owner 2026-11-03, "做进我所有的 OCR 流程里"): take a pile of files, split each
// PDF into its documents, queue them, and let the operator delete, re-read,
// mark as gold or view one. Each document type keeps its own routes and its own
// working copy (scan-gr-check.ts, scan-pi-check.ts).
// ---------------------------------------------------------------------------

import type { Context } from 'hono';
import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import type { Env, Variables } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { activeCompanyId } from '../lib/companyScope';
import { resolveCallerStaffId } from '../lib/salesScope';
import { IMAGE_MIMES, MAX_FILE_BYTES, sha256Hex } from '../lib/scan-ocr';
import { askBoundaries, BOUNDARY_MODEL, cutPdf, pdfPageCount, planChunks } from '../lib/scan-split';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped service client every scm route uses
export type SupabaseClient = SupabaseClientGeneric<any, any, any>;
export type CheckContext = Context<{ Bindings: Env; Variables: Variables }>;
export type CheckDocType = 'GR' | 'PI';

export const svcOf = (env: Env) => getSupabaseService(env) as unknown as SupabaseClient;
export const callerId = (c: { get(k: 'houzsUser'): { id?: unknown } | undefined }): number | null => {
  const id = c.get('houzsUser')?.id;
  return id != null && Number.isFinite(Number(id)) ? Number(id) : null;
};

const MAX_FILES = 50;
// Older than this, a working copy no longer comes back on its own.
export const KEEP_DAYS = 14;

export type CheckRow<R> = {
  id: string; batch_id: string | null; status: string; review_state: string; review: R | null;
  error: string | null; file_name: string | null; page_from: number | null; page_to: number | null;
  image_keys: string[] | null; linked_doc_no: string | null; created_at: string; sample_id: string | null;
};
export const ROW_COLS = 'id, batch_id, status, review_state, review, error, file_name, page_from, page_to, image_keys, linked_doc_no, created_at, sample_id';

export async function ownRows<R>(svc: SupabaseClient, c: CheckContext, documentType: CheckDocType, ids: string[]): Promise<Array<CheckRow<R>>> {
  if (ids.length === 0) return [];
  const { data, error } = await svc.from('scan_jobs').select(ROW_COLS)
    .eq('company_id', activeCompanyId(c)).eq('document_type', documentType).eq('houzs_user_id', callerId(c)).in('id', ids.slice(0, 200));
  if (error) throw new Error(`Could not load your scans: ${error.message}`);
  return (data as unknown as Array<CheckRow<R>> | null) ?? [];
}

/** This user's documents still being read or waiting to be checked, oldest first. */
export async function waitingRows<R>(svc: SupabaseClient, c: CheckContext, documentType: CheckDocType): Promise<{ rows: Array<CheckRow<R>> } | { failed: true }> {
  const since = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString();
  const { data, error } = await svc.from('scan_jobs').select(ROW_COLS)
    .eq('company_id', activeCompanyId(c)).eq('document_type', documentType).eq('houzs_user_id', callerId(c))
    .in('review_state', ['reading', 'pending']).gte('created_at', since)
    .order('created_at', { ascending: true }).limit(200);
  if (error) return { failed: true };
  return { rows: (data as unknown as Array<CheckRow<R>> | null) ?? [] };
}

/** Which of these samples are marked gold (ACCEPTED / CONFIRMED). */
export async function goldSamples(svc: SupabaseClient, sampleIds: string[]): Promise<Set<string>> {
  const gold = new Set<string>();
  if (sampleIds.length === 0) return gold;
  const { data, error } = await svc.from('so_scan_samples').select('id, status').in('id', sampleIds);
  if (error) console.warn('[scan check] sample status read failed (gold marks hidden):', error.message);
  for (const x of (data as Array<{ id: string; status: string }> | null) ?? []) if (x.status === 'ACCEPTED' || x.status === 'CONFIRMED') gold.add(x.id);
  return gold;
}

/** The request body, or null when it is not JSON (the caller answers 400). */
export async function jsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try { return await c.req.json(); } catch { return null; }
}
export const idsOf = (body: unknown): string[] => (Array.isArray((body as { ids?: unknown } | null)?.ids) ? ((body as { ids: unknown[] }).ids).filter((x): x is string => typeof x === 'string') : []);

/** A kept read worth reusing for the same file: it read at least one line. */
export const hasLines = (review: unknown): boolean => {
  const lines = (review as { lines?: unknown } | null)?.lines;
  return Array.isArray(lines) && lines.length > 0;
};

type UploadOpts = {
  /** What a copy reused from an earlier read of the same file carries for this new scan. */
  scannedToday: <T extends object>(review: T) => T;
  documentType: CheckDocType;
  // The AI-usage feature the split is booked under.
  feature: string;
  reviewVersion: number;
  // Where the queue is unbound (test runtime): read one document now.
  runLocal: (env: Env, id: string, row: Record<string, unknown>) => Promise<unknown>;
};

/* Multipart, repeated `file`. Every file is one document, except a PDF of several
   pages, which is split into the documents it holds. Answers with the batch once
   every document is queued; the reading happens after. */
export async function handleUpload(c: CheckContext, opts: UploadOpts): Promise<Response> {
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
      ? await askBoundaries(c.env.ANTHROPIC_API_KEY, bytes, { env: c.env, feature: opts.feature, model: BOUNDARY_MODEL, companyId, userId: houzsUserId, waitUntil: null })
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
    const { data: prior, error: priorErr } = await svc.from('scan_jobs').select('review, error').eq('company_id', companyId).eq('document_type', opts.documentType)
      .eq('file_hash', fileHash).not('review', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle();
    // A failed look-up only costs a fresh read, never a wrong one.
    if (priorErr) console.warn('[scan check] earlier-read look-up failed, reading afresh:', priorErr.message);
    const found = priorErr ? null : (prior as { review: { v?: number } | null; error: string | null } | null);
    // A read kept in an older shape is read again rather than reused, and so is
    // one with no lines: an empty read is a failed or doubtful one, and reusing
    // it made every re-upload of DO-2611-037 come back empty (2026-11-13).
    const seen = found?.review?.v === opts.reviewVersion && hasLines(found.review) ? found : null;
    const { data, error } = await svc.from('scan_jobs').insert({
      status: seen ? 'done' : 'queued', document_type: opts.documentType, review_state: seen ? 'pending' : 'reading', batch_id: batchId,
      review: seen?.review ? opts.scannedToday(seen.review) : null, error: seen ? seen.error : null, file_hash: fileHash,
      file_name: d.name, page_from: d.pages?.[0] ?? null, page_to: d.pages?.[1] ?? null,
      salesperson: null, salesperson_id: uploaderStaffId, houzs_user_id: houzsUserId, image_keys: [], company_id: companyId,
    }).select('id').single();
    const id = (data as { id?: string } | null)?.id;
    if (error || !id) { console.error('[scan check] insert failed:', error?.message); return c.json({ error: 'enqueue_failed', reason: 'Could not queue the scan. Please try again.' }, 500); }
    const key = `scan-jobs/${id}/0`;
    try {
      await c.env.SO_ITEM_PHOTOS.put(key, d.bytes, { httpMetadata: { contentType: d.mime } });
      await svc.from('scan_jobs').update({ image_keys: [key] }).eq('id', id).eq('company_id', companyId);
    } catch (e) { console.warn('[scan check] R2 put failed:', key, (e as Error).message); }
    if (seen) reused += 1; else ids.push(id);
  }
  for (const id of ids) {
    if (c.env.SCAN_QUEUE) {
      try { await c.env.SCAN_QUEUE.send({ jobId: id }); } catch (e) { console.error('[scan check] queue send failed:', id, (e as Error).message); }
    } else {
      const run = (async () => {
        const { data, error: readErr } = await svc.from('scan_jobs').select('id, salesperson_id, houzs_user_id, image_keys, company_id, review_state').eq('id', id).single();
        if (readErr) { console.error('[scan check] job read failed:', id, readErr.message); return; }
        await opts.runLocal(c.env, id, data as Record<string, unknown>);
      })();
      try { c.executionCtx.waitUntil(run); } catch { /* non-Workers runtime (tests) */ }
    }
  }
  return c.json({ success: true, data: { batchId, documents: ids.length + reused, reused } }, 202);
}

/* Delete scans from the list (Clear all sends every id). The read stays for the
   audit and the learning pool. */
export async function handleDiscard(c: CheckContext, documentType: CheckDocType): Promise<Response> {
  const svc = svcOf(c.env);
  const rows = await ownRows<unknown>(svc, c, documentType, idsOf(await jsonBody(c)));
  const ids = rows.filter((r) => r.review_state === 'pending' || r.review_state === 'reading' || r.status === 'error').map((r) => r.id);
  if (ids.length === 0) return c.json({ success: true, data: { discarded: 0 } });
  const { error } = await svc.from('scan_jobs').update({ review_state: 'discarded', updated_at: new Date().toISOString() })
    .eq('company_id', activeCompanyId(c)).in('id', ids);
  if (error) return c.json({ error: 'discard_failed', reason: 'Could not delete. Please try again.' }, 500);
  return c.json({ success: true, data: { discarded: ids.length } });
}

/* Mark this read as a good example: the sample lands ACCEPTED (corrected = what
   was read) and joins the scanner's few-shot pool, the same promotion a posted
   draft gives it. */
export async function handleGold(c: CheckContext, documentType: CheckDocType): Promise<Response> {
  // company-scope: the sample id comes from the caller's own company-scoped scan row; so_scan_samples has no company column.
  const svc = svcOf(c.env);
  const row = (await ownRows<unknown>(svc, c, documentType, [c.req.param('id') as string]))[0] as CheckRow<unknown> | undefined;
  if (!row?.sample_id) return c.json({ error: 'not_found', reason: 'Nothing was read off this scan yet.' }, 404);
  const { data: sample, error: readErr } = await svc.from('so_scan_samples').select('extracted, status').eq('id', row.sample_id).maybeSingle();
  if (readErr) return c.json({ error: 'query_failed', reason: 'Could not load this read. Please try again.' }, 500);
  const sm = sample as { extracted: unknown; status: string } | null;
  if (!sm?.extracted) return c.json({ error: 'not_found', reason: 'Nothing was read off this scan.' }, 404);
  if (sm.status === 'ACCEPTED' || sm.status === 'CONFIRMED') return c.json({ success: true });
  const { error } = await svc.from('so_scan_samples').update({ corrected: sm.extracted, status: 'ACCEPTED' }).eq('id', row.sample_id).eq('status', sm.status);
  if (error) return c.json({ error: 'save_failed', reason: 'Could not mark it. Please try again.' }, 500);
  return c.json({ success: true });
}

/* Read a document that failed once more. */
export async function handleRetry(c: CheckContext, documentType: CheckDocType): Promise<Response> {
  const svc = svcOf(c.env);
  const row = (await ownRows<unknown>(svc, c, documentType, [c.req.param('id') as string]))[0] as CheckRow<unknown> | undefined;
  if (!row || row.status !== 'error') return c.json({ error: 'not_retryable', reason: 'Only a scan that could not be read can be read again.' }, 409);
  const { error } = await svc.from('scan_jobs').update({ status: 'queued', retry_count: 0, error: null, review_state: 'reading', updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('company_id', activeCompanyId(c)).eq('status', 'error');
  if (error) return c.json({ error: 'retry_failed', reason: 'Could not start the scan again. Please try again.' }, 500);
  if (c.env.SCAN_QUEUE) await c.env.SCAN_QUEUE.send({ jobId: row.id });
  return c.json({ success: true });
}

/* The document as uploaded (or its pages), for the preview. */
export async function handleFile(c: CheckContext, documentType: CheckDocType): Promise<Response> {
  const row = (await ownRows<unknown>(svcOf(c.env), c, documentType, [c.req.param('id') as string]))[0] as CheckRow<unknown> | undefined;
  const key = row?.image_keys?.[0];
  if (!key) return c.json({ error: 'not_found' }, 404);
  const obj = await c.env.SO_ITEM_PHOTOS.get(key);
  if (!obj) return c.json({ error: 'not_found' }, 404);
  return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'cache-control': 'private, max-age=600' } });
}
