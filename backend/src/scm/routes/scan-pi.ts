// ---------------------------------------------------------------------------
// scan-pi — the supplier-INVOICE scanner's HTTP surface: photo/scan an invoice,
// land a DRAFT Purchase Invoice by converting the matching Goods Receipt(s).
// The PI MIRROR of scan-gr.ts (the DO->GRN scanner): a PI scan is a scan_jobs
// row stamped document_type='PI' on the SAME SCAN_QUEUE; scan-so's
// processScanQueueMessage delegates PI-typed jobs to processPiScanQueueMessage
// here (one-way: scan-pi never imports scan-so, so no cycle), and this module
// owns its own stale-job reaper scoped to document_type='PI'.
//
// SAFETY: enqueue only persists photos + a job row; it creates NO document. The
// DRAFT PI (or the needs-review outcome) is decided in the background by
// runPiScanJob, which converts from the GRN and never fabricates a standalone
// invoice. See tasks/PLAN-ocr-scan-gr-pi.md.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { getSupabaseService } from '../../db/supabase';
import { activeCompanyId } from '../lib/companyScope';
import { parseScanFiles, loadScanJobFilesFromR2 } from '../lib/scan-ocr';
import { runPiScanJob } from '../lib/pi-scan-run';
import { jobToJson } from './scan-so-serialize';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema-parameterised scm client, same alias as scan-so.ts / scan-gr.ts
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export const scanPi = new Hono<{ Bindings: Env; Variables: Variables }>();
scanPi.use('*', supabaseAuth);

function serviceClient(env: Env): SupabaseClient {
  return getSupabaseService(env);
}

const SCAN_JOBS_MISSING_MSG = 'Scanning is not set up on the server yet. Please enter this invoice manually.';
// A job still queued/running past 3 minutes is a deploy/isolate zombie (mirror
// of the SO/GR reaper constant).
const SCAN_JOB_STALE_MINUTES = 3;
const STALE_JOB_ERROR = 'The scan took too long and was stopped. Please scan this invoice again.';

function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const code = err.code ?? '';
  const msg = err.message ?? '';
  return code === '42P01' || /relation .* does not exist|could not find the table/i.test(msg);
}

// GET /scan-pi/slip-image?key=scan-slips/... — serve the stored invoice image.
// Same key namespace + policy as scan-so/scan-gr's slip-image (mig 0033).
scanPi.get('/slip-image', async (c) => {
  const key = c.req.query('key') ?? '';
  if (!key.startsWith('scan-slips/')) {
    return c.json({ error: 'bad_request', reason: 'key must start with scan-slips/' }, 400);
  }
  const bucket = c.env.SO_ITEM_PHOTOS as R2Bucket | undefined;
  if (!bucket) return c.json({ error: 'photo_bucket_not_configured' }, 500);
  const obj = await bucket.get(key);
  if (!obj) return c.json({ error: 'slip_image_not_found' }, 404);
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'private, max-age=3600',
    },
  });
});

// POST /scan-pi/enqueue — persist photos + a document_type='PI' job row, respond
// FAST (202), run the pipeline off the queue (waitUntil fallback when unbound).
// Same multipart contract as /scan-so/enqueue and /scan-gr/enqueue.
scanPi.post('/enqueue', async (c) => {
  /* company-scope: the scan_jobs row is stamped with the active company on
     INSERT (company_id: activeCompanyId(c)); the only by-id writes here (the
     image_keys UPDATE, and the later processPiScanQueueMessage / reaper reads)
     act only on that just-minted row, never a caller-supplied id. Same shape as
     scan-so / scan-gr enqueue. */
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (e) {
    console.error('[scan-pi enqueue] multipart parse failed:', (e as Error).message);
    return c.json(
      { error: 'bad_request', reason: 'The photos could not be uploaded — please retake them and try again.' },
      400,
    );
  }
  const filesRes = await parseScanFiles(formData);
  if (!filesRes.ok) return c.json({ error: 'bad_request', reason: filesRes.reason }, 400);
  const { fileBlocks, uploadedImages, allFiles, firstBuffer } = filesRes.parsed;

  const user = c.get('user');
  const houzsUser = c.get('houzsUser');
  const houzsUserId =
    houzsUser?.id != null && Number.isFinite(Number(houzsUser.id)) ? Number(houzsUser.id) : null;
  const companyId = activeCompanyId(c) ?? null;
  const svc = serviceClient(c.env);

  // 1) Durable job row first. salesperson_id carries the scm.staff identity the
  //    headless create stamps as created_by; user.id (the SCM bridge id) is a
  //    valid, replayable staff UUID, so the queue consumer / reaper can always
  //    re-run this job. document_type='PI' is what routes it to runPiScanJob.
  const { data: jobRow, error: jobErr } = await svc
    .from('scan_jobs')
    .insert({
      status: 'queued',
      document_type: 'PI',
      salesperson: null,
      salesperson_id: user.id,
      houzs_user_id: houzsUserId,
      image_keys: [],
      company_id: companyId,
    })
    .select('id')
    .single();
  const jobId = (jobRow as { id?: string } | null)?.id ?? null;
  if (jobErr || !jobId) {
    if (jobErr && isMissingTable(jobErr)) {
      console.error('[scan-pi enqueue] scan_jobs missing');
      return c.json({ error: 'table_missing', reason: SCAN_JOBS_MISSING_MSG }, 503);
    }
    console.error('[scan-pi enqueue] job insert failed:', jobErr?.message);
    return c.json({ error: 'enqueue_failed', reason: 'Could not queue the scan. Please try again.' }, 500);
  }

  // 2) Persist photos to R2 (durability) BEFORE responding. Best-effort.
  const imageKeys: string[] = [];
  const bucket = c.env.SO_ITEM_PHOTOS as R2Bucket | undefined;
  if (bucket) {
    for (let i = 0; i < allFiles.length; i += 1) {
      const key = `scan-jobs/${jobId}/${i}`;
      try {
        await bucket.put(key, allFiles[i].buffer, { httpMetadata: { contentType: allFiles[i].mime } });
        imageKeys.push(key);
      } catch (e) {
        console.warn('[scan-pi enqueue] R2 put failed:', key, (e as Error).message);
      }
    }
    if (imageKeys.length > 0) {
      await svc.from('scan_jobs').update({ image_keys: imageKeys, updated_at: new Date().toISOString() }).eq('id', jobId);
    }
  }

  // 3) Hand off to the Cloudflare Queue (the consumer rebuilds everything from
  //    the row + R2). Fallback: run in waitUntil when SCAN_QUEUE is unbound.
  if (c.env.SCAN_QUEUE) {
    try {
      await c.env.SCAN_QUEUE.send({ jobId });
    } catch (e) {
      console.error('[scan-pi enqueue] SCAN_QUEUE.send failed:', jobId, (e as Error).message);
    }
  } else {
    const pipeline = runPiScanJob(c.env, {
      id: jobId,
      userId: user.id,
      houzsUserId,
      companyId,
      fileBlocks,
      uploadedImages,
      firstBuffer,
      imageKeys,
    });
    try {
      c.executionCtx.waitUntil(pipeline);
    } catch {
      /* non-Workers runtime (tests) — let the floating promise run */
    }
  }

  return c.json({ job_id: jobId, status: 'queued' }, 202);
});

// Rebuild the reaper/queue file inputs, run the PI pipeline. Shared by the queue
// consumer and the stale-job reaper.
async function runPiJobFromRow(
  env: Env,
  id: string,
  r: Record<string, unknown>,
): Promise<'ran' | 'not_replayable'> {
  const rawKeys = r.imageKeys ?? r.image_keys;
  const imageKeys = Array.isArray(rawKeys) ? rawKeys.map(String) : [];
  const userId = String(r.salespersonId ?? r.salesperson_id ?? '');
  const huRaw = r.houzsUserId ?? r.houzs_user_id;
  const houzsUserId = huRaw != null && Number.isFinite(Number(huRaw)) ? Number(huRaw) : null;
  const coRaw = r.companyId ?? r.company_id;
  const companyId = coRaw != null && Number.isFinite(Number(coRaw)) ? Number(coRaw) : null;

  const files = userId ? await loadScanJobFilesFromR2(env.SO_ITEM_PHOTOS, imageKeys) : null;
  if (!files) return 'not_replayable';
  await runPiScanJob(env, {
    id, userId, houzsUserId, companyId,
    fileBlocks: files.fileBlocks, uploadedImages: files.uploadedImages, firstBuffer: files.firstBuffer, imageKeys,
  });
  return 'ran';
}

// ---------------------------------------------------------------------------
// Cloudflare Queue consumer for PI jobs — called from scan-so's
// processScanQueueMessage when it reads document_type='PI'. Idempotent: a 'done'
// row acks without re-running (a redelivery must not create a 2nd PI).
// ---------------------------------------------------------------------------
export async function processPiScanQueueMessage(env: Env, jobId: string): Promise<void> {
  const id = jobId;
  if (!id) return;
  const svc = serviceClient(env);
  const { data: row, error } = await svc
    .from('scan_jobs')
    .select('id, status, salesperson_id, houzs_user_id, image_keys, company_id, document_type')
    .eq('id', id)
    .single();
  if (error) {
    if ((error as { code?: string }).code === 'PGRST116') { console.warn('[scan-pi queue] job row not found, acking:', id); return; }
    throw new Error(`scan_jobs read failed for ${id}: ${error.message}`);
  }
  const r = row as Record<string, unknown>;
  const status = typeof r.status === 'string' ? r.status : '';
  if (status === 'done') { console.warn('[scan-pi queue] job already done, skipping:', id); return; }

  const outcome = await runPiJobFromRow(env, id, r);
  if (outcome === 'not_replayable') {
    console.warn('[scan-pi queue] job not replayable, erroring:', id);
    await svc.from('scan_jobs').update({ status: 'error', error: STALE_JOB_ERROR, updated_at: new Date().toISOString() }).eq('id', id);
  }
}

// Stale-job reaper for PI jobs, scoped to document_type='PI' so it and the SO/GR
// reapers never touch each other's rows. One automatic re-run (retry_count
// 0->1), then terminal error — same policy as the SO/GR reapers.
async function reapStalePiScanJobs(
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
      .eq('document_type', 'PI')
      .in('status', ['queued', 'running'])
      .lt('updated_at', cutoff)
      .eq('retry_count', 0)
      .limit(5);
    if (retryErr) {
      console.warn('[scan-pi jobs] retry pass failed (blanket reap fallback):', retryErr.message);
      await svc.from('scan_jobs')
        .update({ status: 'error', error: STALE_JOB_ERROR, updated_at: nowIso })
        .eq('document_type', 'PI').in('status', ['queued', 'running']).lt('updated_at', cutoff);
      return;
    }
    for (const r of (retryRows as Array<Record<string, unknown>> | null) ?? []) {
      const id = String((r.id as string | undefined) ?? '');
      if (!id) continue;
      const { data: claimed, error: claimErr } = await svc
        .from('scan_jobs')
        .update({ status: 'queued', retry_count: 1, updated_at: nowIso })
        .eq('id', id).eq('retry_count', 0).in('status', ['queued', 'running'])
        .select('id');
      if (claimErr || !Array.isArray(claimed) || claimed.length === 0) continue;
      runInBackground((async () => {
        console.warn('[scan-pi jobs] re-running stale job (retry 1/1):', id);
        const outcome = await runPiJobFromRow(env, id, r);
        if (outcome === 'not_replayable') {
          console.warn('[scan-pi jobs] retry not replayable, erroring:', id);
          await svc.from('scan_jobs').update({ status: 'error', error: STALE_JOB_ERROR, updated_at: new Date().toISOString() }).eq('id', id);
        }
      })());
    }
    await svc.from('scan_jobs')
      .update({ status: 'error', error: STALE_JOB_ERROR, updated_at: nowIso })
      .eq('document_type', 'PI').in('status', ['queued', 'running']).lt('updated_at', cutoff).gte('retry_count', 1);
  } catch (e) {
    console.warn('[scan-pi jobs] stale-job reaper failed:', (e as Error).message);
  }
}

const JOB_SELECT = 'id, status, salesperson, so_doc_no, linked_doc_no, document_type, error, sample_id, duplicate_of, image_keys, created_at, updated_at';

// GET /scan-pi/jobs — latest 20 PI jobs for the active company.
scanPi.get('/jobs', async (c) => {
  const svc = serviceClient(c.env);
  await reapStalePiScanJobs(c.env, svc, (p) => { try { c.executionCtx.waitUntil(p); } catch { /* tests */ } });
  const { data, error } = await svc
    .from('scan_jobs')
    .select(JOB_SELECT)
    .eq('company_id', activeCompanyId(c))
    .eq('document_type', 'PI')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) {
    if (isMissingTable(error)) return c.json({ error: 'table_missing', reason: SCAN_JOBS_MISSING_MSG }, 503);
    return c.json({ error: 'query_failed', reason: 'Could not load scan jobs. Please try again.' }, 500);
  }
  const jobs = ((data as Array<Record<string, unknown>> | null) ?? []).map(jobToJson);
  return c.json({ success: true, data: { jobs } });
});

// GET /scan-pi/jobs/:id — poll one PI job.
scanPi.get('/jobs/:id', async (c) => {
  const id = (c.req.param('id') as string | undefined ?? '').trim();
  if (!id) return c.json({ error: 'bad_request', reason: 'Missing job id.' }, 400);
  const svc = serviceClient(c.env);
  await reapStalePiScanJobs(c.env, svc, (p) => { try { c.executionCtx.waitUntil(p); } catch { /* tests */ } });
  // company-scope: by-id read scoped to the caller's active company, so one
  // company cannot poll another's scan job. scan_jobs.company_id is NOT NULL
  // (mig 0083, HOUZS default 0091).
  const { data, error } = await svc
    .from('scan_jobs').select(JOB_SELECT).eq('id', id).eq('document_type', 'PI')
    .eq('company_id', activeCompanyId(c)).limit(1).maybeSingle();
  if (error) {
    if (isMissingTable(error)) return c.json({ error: 'table_missing', reason: SCAN_JOBS_MISSING_MSG }, 503);
    return c.json({ error: 'query_failed', reason: 'Could not load the scan job. Please try again.' }, 500);
  }
  if (!data) return c.json({ error: 'not_found', reason: 'Scan job not found.' }, 404);
  return c.json({ success: true, data: { job: jobToJson(data as Record<string, unknown>) } });
});

// POST /scan-pi/jobs/clear-failed — delete this company's terminal error PI rows.
scanPi.post('/jobs/clear-failed', async (c) => {
  const svc = serviceClient(c.env);
  const { error } = await svc
    .from('scan_jobs').delete()
    .eq('status', 'error').eq('company_id', activeCompanyId(c)).eq('document_type', 'PI');
  if (error) {
    if (isMissingTable(error)) return c.json({ error: 'table_missing', reason: SCAN_JOBS_MISSING_MSG }, 503);
    console.error('[scan-pi jobs] clear-failed failed:', error.message);
    return c.json({ error: 'delete_failed', reason: 'Could not clear the failed scans. Please try again.' }, 500);
  }
  return c.json({ success: true });
});
