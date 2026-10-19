// ---------------------------------------------------------------------------
// /scan-gr — Claude-powered OCR for supplier DELIVERY ORDERS -> a DRAFT Goods
// Receipt, created by CONVERTING from the matching open PO line(s). The GR twin
// of scan-so.ts: same background-queue + scan_jobs lifecycle + R2 provenance +
// self-learning, routed through document_type='GR'.
//
// SAFETY (non-negotiable, tasks/PLAN-ocr-scan-gr-pi.md + docs/modules/scan-to-gr.md):
//   * A scan ONLY ever lands a DRAFT / unposted GRN. Stock posts later, on the
//     operator's DRAFT -> POSTED (PATCH /grns/:id/post). No OCR read moves stock.
//   * We CONVERT from PO lines (createDraftGrnFromPoItems), never fabricate a
//     standalone GRN, so PO outstanding always clears.
//   * If the matcher cannot confidently resolve the PO line(s), NOTHING is
//     created — the job lands NEEDS-REVIEW (status 'done', no linked doc, slip
//     retained, plain note) and the operator receives from the PO by hand. A
//     wrong link is never guessed.
//
// Transport (parseScanFiles / anthropic fetch / R2 replay) is shared from
// scan-ocr.ts; the GR prompt + shape live in grn-scan-extract.ts; the matcher in
// grn-scan-match.ts (pure) + grn-scan-load.ts (its DB reads).
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { activeCompanyId, scopeToCompany, type CompanyScopeCtx } from '../lib/companyScope';
import { resolveCallerStaffId } from '../lib/salesScope';
import { postPersonalNotice } from '../../services/personalNotice';
import { jobToJson } from './scan-so-serialize';
import {
  CLAUDE_MODEL,
  sha256Hex,
  parseScanFiles,
  loadScanJobFilesFromR2,
  type ContentBlock,
  type UploadedImage,
} from '../lib/scan-ocr';
import { callClaudeGrExtract, emptyScanNote, loadGrnFewShot, type GrnExtracted } from '../lib/grn-scan-extract';
import { draftFromScan, matchScan, toScanned, type ScanDraftOutcome } from '../lib/grn-scan-draft';
import { buildTeachOptions, saveScanCodes } from '../lib/grn-scan-codes';

type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export const scanGr = new Hono<{ Bindings: Env; Variables: Variables }>();
scanGr.use('*', supabaseAuth);

function serviceClient(env: Env): SupabaseClient {
  return getSupabaseService(env) as unknown as SupabaseClient;
}

const SCAN_JOBS_MISSING_MSG =
  'scan-jobs table missing — apply src/db/migrations-pg/0067_scm_scan_jobs.sql to this database.';
const SCAN_JOB_STALE_MINUTES = 3;
const STALE_JOB_ERROR = 'The scan took too long and was stopped. Please scan this delivery order again.';

const JOB_MSG = {
  fallback: 'Something went wrong while reading the delivery order. Please create the GRN manually from the PO.',
  noKey: 'Scanning is not set up on the server yet. Please create the GRN manually from the PO.',
} as const;

function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === '42P01' || /relation .* does not exist/i.test(err.message ?? '');
}

// so_scan_samples row for a GR scan (status EXTRACTED, or FAILED with the error
// blob). document_type='GR' partitions the learning pool. Best-effort.
async function insertGrnScanSample(
  svc: SupabaseClient,
  args: { imageSha256: string | null; parsed: GrnExtracted | null; errorMsg: string | null; claudeText: string },
): Promise<string | null> {
  try {
    const { data, error } = await svc
      .from('so_scan_samples')
      .insert({
        image_sha256: args.imageSha256,
        salesperson: null,
        extracted: args.parsed ?? { error: args.errorMsg, claudeText: args.claudeText },
        status: args.parsed ? 'EXTRACTED' : 'FAILED',
        document_type: 'GR',
      })
      .select('id')
      .single();
    if (error) {
      console.error('[scan-gr] so_scan_samples insert failed:', error.message);
      return null;
    }
    return (data as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[scan-gr] so_scan_samples insert threw:', (e as Error).message);
    return null;
  }
}

// Store the delivery-order photo (first uploaded image) under scan-slips/{id} —
// the SAME key shape + bucket the SO slip proxy serves, so GET /scan-gr/slip-image
// (and the SO one) can stream it back on the GRN detail. PDFs are not stored
// (not inline-viewable). Never fails the job.
async function storeGrnScanImage(
  bucket: R2Bucket | undefined,
  svc: SupabaseClient,
  sampleId: string | null,
  uploadedImages: UploadedImage[],
): Promise<string | null> {
  if (!sampleId || !bucket || uploadedImages.length === 0) return null;
  const key = `scan-slips/${sampleId}`;
  try {
    await bucket.put(key, uploadedImages[0].buffer, { httpMetadata: { contentType: uploadedImages[0].mime } });
    const { error } = await svc.from('so_scan_samples').update({ image_key: key }).eq('id', sampleId);
    if (error) { console.warn('[scan-gr] image_key update failed:', error.message); return null; }
    return key;
  } catch (e) {
    console.warn('[scan-gr] slip R2 put failed:', (e as Error).message);
    return null;
  }
}

async function postGrScanNotice(
  env: Env,
  opts: { houzsUserId: number | null; category: 'GENERAL' | 'WARNING'; title: string; body: string },
): Promise<void> {
  if (opts.houzsUserId == null) return;
  await postPersonalNotice(env, {
    userIds: [opts.houzsUserId],
    category: opts.category,
    title: opts.title,
    body: opts.body,
    source: 'scan',
    expiresDays: 7,
  });
}

async function announceDraft(
  env: Env,
  houzsUserId: number | null,
  outcome: Extract<ScanDraftOutcome, { kind: 'draft' }>,
  touch: (patch: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const { grnNumbers, poNumbers, jobNote } = outcome;
  await touch({ status: 'done', linked_doc_no: grnNumbers[0], error: jobNote });
  const bodyParts = [
    `Your scanned delivery order was saved as a DRAFT goods receipt (${grnNumbers.join(', ')}) from ${poNumbers.join(', ')}. Open it to review and post.`,
  ];
  if (jobNote) bodyParts.push(jobNote);
  await postGrScanNotice(env, {
    houzsUserId,
    category: jobNote ? 'WARNING' : 'GENERAL',
    title: `Goods receipt draft saved — ${grnNumbers.join(', ')}`,
    body: bodyParts.join(' '),
  });
}

// ---------------------------------------------------------------------------
// The GR scan pipeline. Reads the delivery order, matches it to open PO lines,
// and CONVERTS the confident picks into a DRAFT GRN. Mirrors runScanJob's
// touch/fail lifecycle. NEVER posts stock; NEVER creates a standalone GRN.
// ---------------------------------------------------------------------------
async function runGrnScanJob(
  env: Env,
  job: {
    id: string;
    uploaderStaffId: string;
    houzsUserId: number | null;
    companyId: number | null;
    fileBlocks: ContentBlock[];
    uploadedImages: UploadedImage[];
    firstBuffer: ArrayBuffer | null;
    imageKeys: string[];
  },
): Promise<void> {
  const svc = serviceClient(env);
  const touch = async (patch: Record<string, unknown>): Promise<void> => {
    try {
      const { error } = await svc.from('scan_jobs').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', job.id);
      if (error) console.error('[scan-gr] job update failed:', job.id, error.message);
    } catch (e) {
      console.error('[scan-gr] job update threw:', job.id, (e as Error).message);
    }
  };
  const fail = async (plainMsg: string): Promise<void> => {
    await touch({ status: 'error', error: plainMsg });
    await postGrScanNotice(env, {
      houzsUserId: job.houzsUserId,
      category: 'WARNING',
      title: 'Delivery-order scan could not be processed',
      body: `${plainMsg}`,
    });
  };
  // A NEEDS-REVIEW outcome: no document created (safe), slip retained, operator
  // told to receive by hand. Terminal 'done' (persists; not a red failure card).
  const needsReview = async (note: string): Promise<void> => {
    await touch({ status: 'done', error: note });
    await postGrScanNotice(env, {
      houzsUserId: job.houzsUserId,
      category: 'WARNING',
      title: 'Delivery order needs review',
      body: note,
    });
  };

  try {
    await touch({ status: 'running' });
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) { console.error('[scan-gr] ANTHROPIC_API_KEY missing'); return await fail(JOB_MSG.noKey); }

    const fewShot = await loadGrnFewShot(svc);
    const call = await callClaudeGrExtract(apiKey, job.fileBlocks, fewShot,
      { env, feature: 'scan_gr', model: CLAUDE_MODEL, companyId: job.companyId, userId: job.houzsUserId, waitUntil: null });
    const parsed = call.parsed;

    const imageSha256 = job.firstBuffer ? await sha256Hex(job.firstBuffer) : null;
    const sampleId = await insertGrnScanSample(svc, {
      imageSha256, parsed, errorMsg: call.errorMsg, claudeText: call.claudeText,
    });
    if (sampleId) await touch({ sample_id: sampleId });
    await storeGrnScanImage(env.SO_ITEM_PHOTOS, svc, sampleId, job.uploadedImages);

    if (!parsed || parsed.lines.length === 0) {
      console.error('[scan-gr] extraction empty, needs review:', job.id, call.errorMsg);
      return await needsReview(emptyScanNote(parsed));
    }

    const outcome = await draftFromScan(env, svc, job, parsed);
    if (outcome.kind === 'needs_review') return await needsReview(outcome.note);
    await announceDraft(env, job.houzsUserId, outcome, touch);
  } catch (e) {
    console.error('[scan-gr] pipeline threw:', job.id, e);
    await fail(JOB_MSG.fallback);
  }
}

// ---------------------------------------------------------------------------
// POST /scan-gr/enqueue — persist photos + a document_type='GR' job row, respond
// FAST, run the pipeline off the queue (waitUntil fallback when unbound). Same
// multipart contract as /scan-so/enqueue (repeated `file` field).
// ---------------------------------------------------------------------------
scanGr.post('/enqueue', async (c) => {
  /* company-scope: the scan_jobs row is stamped with the active company on
     insert (company_id: activeCompanyId(c) below); the later by-id reads/writes
     the checker attributes to this handler (the image_keys update, and the
     processGrnScanQueueMessage / reaper reads) act only on that just-minted row,
     which cannot belong to another company. Mirrors scan-so.ts's /enqueue. */
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (e) {
    console.error('[scan-gr enqueue] multipart parse failed:', (e as Error).message);
    return c.json({ error: 'bad_request', reason: 'The photos could not be uploaded — please retake them and try again.' }, 400);
  }
  const filesRes = await parseScanFiles(formData);
  if (!filesRes.ok) return c.json({ error: 'bad_request', reason: filesRes.reason }, 400);
  const { fileBlocks, uploadedImages, allFiles, firstBuffer } = filesRes.parsed;

  const user = c.get('user');
  const houzsUser = c.get('houzsUser');
  const houzsUserId = houzsUser?.id != null && Number.isFinite(Number(houzsUser.id)) ? Number(houzsUser.id) : null;

  const svc = serviceClient(c.env);
  // Attribute the receipt to whoever scanned it (their own scm.staff row),
  // falling back to the SCM bridge id when unresolved — same as the SO scanner.
  const uploaderStaffId = (await resolveCallerStaffId(svc, houzsUserId)) ?? user.id;

  const { data: jobRow, error: jobErr } = await svc
    .from('scan_jobs')
    .insert({
      status: 'queued',
      document_type: 'GR',
      salesperson: null,
      salesperson_id: uploaderStaffId,
      houzs_user_id: houzsUserId,
      image_keys: [],
      company_id: activeCompanyId(c),
    })
    .select('id')
    .single();
  const jobId = (jobRow as { id?: string } | null)?.id ?? null;
  if (jobErr || !jobId) {
    if (jobErr && isMissingTable(jobErr)) {
      console.error('[scan-gr enqueue]', SCAN_JOBS_MISSING_MSG);
      return c.json({ error: 'table_missing', reason: 'Scanning is not set up on the server yet. Please create the GRN manually.' }, 503);
    }
    console.error('[scan-gr enqueue] job insert failed:', jobErr?.message);
    return c.json({ error: 'enqueue_failed', reason: 'Could not queue the scan. Please try again.' }, 500);
  }

  // Persist uploaded photos to R2 before responding (durability). The pipeline
  // runs off the in-memory buffers, so a failed put never blocks the job.
  const imageKeys: string[] = [];
  if (c.env.SO_ITEM_PHOTOS) {
    for (let i = 0; i < allFiles.length; i += 1) {
      const key = `scan-jobs/${jobId}/${i}`;
      try {
        await c.env.SO_ITEM_PHOTOS.put(key, allFiles[i].buffer, { httpMetadata: { contentType: allFiles[i].mime } });
        imageKeys.push(key);
      } catch (e) {
        console.warn('[scan-gr enqueue] R2 put failed:', key, (e as Error).message);
      }
    }
    if (imageKeys.length > 0) {
      await svc.from('scan_jobs').update({ image_keys: imageKeys, updated_at: new Date().toISOString() }).eq('id', jobId);
    }
  }

  // Hand to the Cloudflare Queue; the consumer rebuilds everything from the row
  // + R2 photos. FALLBACK to waitUntil when SCAN_QUEUE is unbound (test runtime).
  if (c.env.SCAN_QUEUE) {
    try {
      await c.env.SCAN_QUEUE.send({ jobId });
    } catch (e) {
      console.error('[scan-gr enqueue] SCAN_QUEUE.send failed:', jobId, (e as Error).message);
    }
  } else {
    const pipeline = runGrnScanJob(c.env, {
      id: jobId,
      uploaderStaffId,
      houzsUserId,
      companyId: activeCompanyId(c) ?? null,
      fileBlocks,
      uploadedImages,
      firstBuffer,
      imageKeys,
    });
    try { c.executionCtx.waitUntil(pipeline); } catch { /* non-Workers runtime (tests) */ }
  }

  return c.json({ job_id: jobId, status: 'queued' }, 202);
});

// Rebuild the reaper/queue file inputs, run the GR pipeline. Shared by the queue
// consumer and the stale-job reaper.
async function runGrnJobFromRow(
  env: Env,
  id: string,
  r: Record<string, unknown>,
): Promise<'ran' | 'not_replayable'> {
  const rawKeys = r.imageKeys ?? r.image_keys;
  const imageKeys = Array.isArray(rawKeys) ? rawKeys.map(String) : [];
  const uploaderStaffId = String(r.salespersonId ?? r.salesperson_id ?? '');
  const huRaw = r.houzsUserId ?? r.houzs_user_id;
  const houzsUserId = huRaw != null && Number.isFinite(Number(huRaw)) ? Number(huRaw) : null;
  const coRaw = r.companyId ?? r.company_id;
  const companyId = coRaw != null && Number.isFinite(Number(coRaw)) ? Number(coRaw) : null;

  const files = uploaderStaffId ? await loadScanJobFilesFromR2(env.SO_ITEM_PHOTOS, imageKeys) : null;
  if (!files) return 'not_replayable';
  await runGrnScanJob(env, {
    id, uploaderStaffId, houzsUserId, companyId,
    fileBlocks: files.fileBlocks, uploadedImages: files.uploadedImages, firstBuffer: files.firstBuffer, imageKeys,
  });
  return 'ran';
}

// ---------------------------------------------------------------------------
// Cloudflare Queue consumer for GR jobs — called from scan-so's
// processScanQueueMessage when it reads document_type='GR'. Idempotent: a 'done'
// row acks without re-running (a redelivery must not create a 2nd GRN).
// ---------------------------------------------------------------------------
export async function processGrnScanQueueMessage(env: Env, jobId: string): Promise<void> {
  const id = String(jobId ?? '');
  if (!id) return;
  const svc = serviceClient(env);
  const { data: row, error } = await svc
    .from('scan_jobs')
    .select('id, status, salesperson_id, houzs_user_id, image_keys, company_id, document_type')
    .eq('id', id)
    .single();
  if (error) {
    if ((error as { code?: string }).code === 'PGRST116') { console.warn('[scan-gr queue] job row not found, acking:', id); return; }
    throw new Error(`scan_jobs read failed for ${id}: ${error.message}`);
  }
  const r = row as Record<string, unknown>;
  const status = typeof r.status === 'string' ? r.status : '';
  if (status === 'done') { console.warn('[scan-gr queue] job already done, skipping:', id); return; }

  const outcome = await runGrnJobFromRow(env, id, r);
  if (outcome === 'not_replayable') {
    console.warn('[scan-gr queue] job not replayable, erroring:', id);
    await svc.from('scan_jobs').update({ status: 'error', error: STALE_JOB_ERROR, updated_at: new Date().toISOString() }).eq('id', id);
  }
}

// Stale-job reaper for GR jobs, scoped to document_type='GR' so it and the SO
// reaper never touch each other's rows. One automatic re-run (retry_count 0->1),
// then terminal error — same policy as the SO reaper.
async function reapStaleGrnScanJobs(
  env: Env,
  svc: SupabaseClient,
  runInBackground: (p: Promise<unknown>) => void,
): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    const cutoff = new Date(Date.now() - SCAN_JOB_STALE_MINUTES * 60 * 1000).toISOString();
    const { data: retryRows, error: retryErr } = await svc
      .from('scan_jobs')
      .select('id, salesperson_id, houzs_user_id, image_keys, retry_count, company_id, document_type')
      .eq('document_type', 'GR')
      .in('status', ['queued', 'running'])
      .lt('updated_at', cutoff)
      .eq('retry_count', 0)
      .limit(5);
    if (retryErr) {
      console.warn('[scan-gr jobs] retry pass failed (blanket reap fallback):', retryErr.message);
      await svc.from('scan_jobs')
        .update({ status: 'error', error: STALE_JOB_ERROR, updated_at: nowIso })
        .eq('document_type', 'GR').in('status', ['queued', 'running']).lt('updated_at', cutoff);
      return;
    }
    for (const r of (retryRows ?? []) as Array<Record<string, unknown>>) {
      const id = String(r.id ?? '');
      if (!id) continue;
      const { data: claimed, error: claimErr } = await svc
        .from('scan_jobs')
        .update({ status: 'queued', retry_count: 1, updated_at: nowIso })
        .eq('id', id).eq('retry_count', 0).in('status', ['queued', 'running'])
        .select('id');
      if (claimErr || !claimed || claimed.length === 0) continue;
      runInBackground((async () => {
        console.warn('[scan-gr jobs] re-running stale job (retry 1/1):', id);
        const outcome = await runGrnJobFromRow(env, id, r);
        if (outcome === 'not_replayable') {
          console.warn('[scan-gr jobs] retry not replayable, erroring:', id);
          await svc.from('scan_jobs').update({ status: 'error', error: STALE_JOB_ERROR, updated_at: new Date().toISOString() }).eq('id', id);
        }
      })());
    }
    await svc.from('scan_jobs')
      .update({ status: 'error', error: STALE_JOB_ERROR, updated_at: nowIso })
      .eq('document_type', 'GR').in('status', ['queued', 'running']).lt('updated_at', cutoff).gte('retry_count', 1);
  } catch (e) {
    console.warn('[scan-gr jobs] stale-job reaper failed:', (e as Error).message);
  }
}

const JOB_SELECT = 'id, status, salesperson, so_doc_no, linked_doc_no, document_type, error, sample_id, duplicate_of, image_keys, created_at, updated_at';

// The scan card links straight to the draft, which the app opens by id; the job
// row only keeps the GRN number, so resolve the ids here (company-scoped).
async function withGrnIds(svc: SupabaseClient, c: CompanyScopeCtx, jobs: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  const numbers = [...new Set(jobs.map((j) => j.linkedDocNo).filter((n): n is string => typeof n === 'string' && n !== ''))];
  if (numbers.length === 0) return jobs.map((j) => ({ ...j, linkedDocId: null }));
  const { data, error } = await scopeToCompany(svc.from('grns').select('id, grn_number').in('grn_number', numbers), c);
  if (error) console.warn('[scan-gr jobs] grn id lookup failed:', error.message);
  const idOf = new Map(((data as Array<{ id: string; grn_number: string }> | null) ?? []).map((g) => [g.grn_number, g.id]));
  return jobs.map((j) => ({ ...j, linkedDocId: idOf.get(j.linkedDocNo as string) ?? null }));
}

// GET /scan-gr/jobs — latest 20 GR jobs for the active company.
scanGr.get('/jobs', async (c) => {
  const svc = serviceClient(c.env);
  await reapStaleGrnScanJobs(c.env, svc, (p) => { try { c.executionCtx.waitUntil(p); } catch { /* tests */ } });
  const { data, error } = await svc
    .from('scan_jobs')
    .select(JOB_SELECT)
    .eq('company_id', activeCompanyId(c))
    .eq('document_type', 'GR')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) {
    if (isMissingTable(error)) return c.json({ error: 'table_missing', reason: SCAN_JOBS_MISSING_MSG }, 503);
    return c.json({ error: 'query_failed', reason: 'Could not load scan jobs. Please try again.' }, 500);
  }
  const jobs = await withGrnIds(svc, c, ((data as Array<Record<string, unknown>> | null) ?? []).map(jobToJson));
  return c.json({ success: true, data: { jobs } });
});

// GET /scan-gr/jobs/:id — poll one GR job.
scanGr.get('/jobs/:id', async (c) => {
  const id = (c.req.param('id') ?? '').trim();
  if (!id) return c.json({ error: 'bad_request', reason: 'Missing job id.' }, 400);
  const svc = serviceClient(c.env);
  await reapStaleGrnScanJobs(c.env, svc, (p) => { try { c.executionCtx.waitUntil(p); } catch { /* tests */ } });
  // company-scope: by-id read scoped to the caller's active company, so one
  // company cannot poll another's scan job (the list read below is scoped the
  // same way). scan_jobs.company_id is NOT NULL (mig 0083, HOUZS default 0091).
  const { data, error } = await svc
    .from('scan_jobs').select(JOB_SELECT).eq('id', id).eq('document_type', 'GR')
    .eq('company_id', activeCompanyId(c)).limit(1).maybeSingle();
  if (error) {
    if (isMissingTable(error)) return c.json({ error: 'table_missing', reason: SCAN_JOBS_MISSING_MSG }, 503);
    return c.json({ error: 'query_failed', reason: 'Could not load the scan job. Please try again.' }, 500);
  }
  if (!data) return c.json({ error: 'not_found', reason: 'Scan job not found.' }, 404);
  const [job] = await withGrnIds(svc, c, [jobToJson(data as Record<string, unknown>)]);
  return c.json({ success: true, data: { job } });
});

// The finished GR job and its stored read, for teaching codes. Company-scoped
// by-id read, like GET /jobs/:id.
async function loadTeachableJob(svc: SupabaseClient, c: CompanyScopeCtx, id: string): Promise<
  | { ok: true; job: { id: string; linkedDocNo: string | null; uploaderStaffId: string; houzsUserId: number | null; companyId: number }; parsed: GrnExtracted }
  | { ok: false; status: 400 | 404 | 409; reason: string }
> {
  const companyId = activeCompanyId(c);
  const { data, error } = await svc
    .from('scan_jobs').select('id, status, sample_id, linked_doc_no, salesperson_id, houzs_user_id')
    .eq('id', id).eq('document_type', 'GR').eq('company_id', companyId).limit(1).maybeSingle();
  const row = data as { id: string; status: string; sample_id: string | null; linked_doc_no: string | null; salesperson_id: string | null; houzs_user_id: number | null } | null;
  if (error || !row) return { ok: false, status: 404, reason: 'Scan job not found.' };
  if (row.status !== 'done' || !row.sample_id || !row.salesperson_id) return { ok: false, status: 409, reason: 'This scan has nothing to match yet.' };
  const { data: sample } = await svc.from('so_scan_samples').select('extracted').eq('id', row.sample_id).maybeSingle();
  const parsed = (sample as { extracted: GrnExtracted | null } | null)?.extracted ?? null;
  if (!parsed || !Array.isArray(parsed.lines) || parsed.lines.length === 0) return { ok: false, status: 409, reason: 'No lines were read off this delivery order.' };
  return {
    ok: true,
    job: { id: row.id, linkedDocNo: row.linked_doc_no, uploaderStaffId: row.salesperson_id, houzsUserId: row.houzs_user_id, companyId: companyId as number },
    parsed,
  };
}

// GET /scan-gr/jobs/:id/codes — the supplier codes on this delivery order the
// scan could not match by code, and the PO lines they could be (HC-0120).
scanGr.get('/jobs/:id/codes', async (c) => {
  const svc = serviceClient(c.env);
  const loaded = await loadTeachableJob(svc, c, c.req.param('id').trim());
  if (!loaded.ok) return c.json({ error: 'not_teachable', reason: loaded.reason }, loaded.status);
  const ctx = await matchScan(svc, loaded.job.companyId, loaded.parsed);
  if (ctx.supplierId === null) {
    return c.json({ success: true, data: { supplierKnown: false, rows: [], poLines: [] } });
  }
  const options = buildTeachOptions(loaded.parsed.lines.map(toScanned), ctx.match, ctx.openLines, ctx.supplierId);
  return c.json({ success: true, data: { supplierKnown: true, ...options } });
});

// POST /scan-gr/jobs/:id/codes {pairs: [{printedCode, poItemId}]} — remember
// which of our items each printed code is, for this supplier. A scan that made
// no draft yet is matched again from its stored read (no new OCR call).
scanGr.post('/jobs/:id/codes', async (c) => {
  let body: { pairs?: Array<{ printedCode?: unknown; poItemId?: unknown }> };
  try { body = await c.req.json(); } catch { return c.json({ error: 'bad_request', reason: 'Invalid request.' }, 400); }
  const raw = Array.isArray(body.pairs) ? body.pairs : [];
  const svc = serviceClient(c.env);
  const loaded = await loadTeachableJob(svc, c, c.req.param('id').trim());
  if (!loaded.ok) return c.json({ error: 'not_teachable', reason: loaded.reason }, loaded.status);
  const ctx = await matchScan(svc, loaded.job.companyId, loaded.parsed);
  if (ctx.supplierId === null) return c.json({ error: 'supplier_unknown', reason: 'We could not tell which supplier this delivery order is from.' }, 409);
  const options = buildTeachOptions(loaded.parsed.lines.map(toScanned), ctx.match, ctx.openLines, ctx.supplierId);

  // Only codes this delivery order printed, only onto lines it was offered:
  // the offer is company- and supplier-scoped, so a caller-supplied id cannot
  // reach another company's or supplier's item.
  const printed = new Set(options.rows.map((r) => r.printedCode));
  const lineById = new Map(options.poLines.map((l) => [l.poItemId, l]));
  const pairs: Array<{ printedCode: string; itemCode: string }> = [];
  for (const p of raw) {
    const code = typeof p.printedCode === 'string' ? p.printedCode : '';
    const line = typeof p.poItemId === 'string' ? lineById.get(p.poItemId) : undefined;
    if (!printed.has(code) || !line) return c.json({ error: 'bad_request', reason: `"${code}" cannot be matched to that line.` }, 400);
    pairs.push({ printedCode: code, itemCode: line.itemCode });
  }
  if (pairs.length === 0) return c.json({ error: 'bad_request', reason: 'Choose a PO line for at least one code.' }, 400);

  const houzsUser = c.get('houzsUser');
  const userId = houzsUser?.id != null && Number.isFinite(Number(houzsUser.id)) ? Number(houzsUser.id) : null;
  const saved = await saveScanCodes(svc, { companyId: loaded.job.companyId, supplierId: ctx.supplierId, userId, pairs });
  if (!saved.ok) {
    console.error('[scan-gr codes] save failed:', saved.reason);
    return c.json({ error: 'save_failed', reason: 'Could not save the codes. Please try again.' }, 500);
  }

  let redrafted: string | null = null;
  if (!loaded.job.linkedDocNo) {
    const touch = async (patch: Record<string, unknown>): Promise<void> => {
      const { error } = await svc.from('scan_jobs').update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', loaded.job.id).eq('company_id', loaded.job.companyId);
      if (error) console.error('[scan-gr codes] job update failed:', loaded.job.id, error.message);
    };
    const outcome = await draftFromScan(c.env, svc, loaded.job, loaded.parsed);
    if (outcome.kind === 'draft') {
      await announceDraft(c.env, loaded.job.houzsUserId, outcome, touch);
      redrafted = outcome.grnNumbers[0];
    } else {
      await touch({ error: outcome.note });
    }
  }
  return c.json({ success: true, data: { saved: pairs.length, draft: redrafted } });
});

// POST /scan-gr/jobs/clear-failed — delete this company's terminal error GR rows.
scanGr.post('/jobs/clear-failed', async (c) => {
  const svc = serviceClient(c.env);
  const { error } = await svc
    .from('scan_jobs').delete()
    .eq('status', 'error').eq('company_id', activeCompanyId(c)).eq('document_type', 'GR');
  if (error) {
    if (isMissingTable(error)) return c.json({ error: 'table_missing', reason: SCAN_JOBS_MISSING_MSG }, 503);
    console.error('[scan-gr jobs] clear-failed failed:', error.message);
    return c.json({ error: 'delete_failed', reason: 'Could not clear the failed scans. Please try again.' }, 500);
  }
  return c.json({ success: true });
});

// GET /scan-gr/slip-image?key=scan-slips/<sampleId> — serve the stored delivery
// order photo on the GRN detail. Same R2 proxy + prefix guard as the SO route,
// under the GR permission so procurement users can view it.
scanGr.get('/slip-image', async (c) => {
  const key = c.req.query('key') ?? '';
  if (!key.startsWith('scan-slips/')) return c.json({ error: 'bad_request', reason: 'key must start with scan-slips/' }, 400);
  if (!c.env.SO_ITEM_PHOTOS) return c.json({ error: 'photo_bucket_not_configured' }, 500);
  const obj = await c.env.SO_ITEM_PHOTOS.get(key);
  if (!obj) return c.json({ error: 'slip_image_not_found' }, 404);
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'private, max-age=3600',
    },
  });
});
