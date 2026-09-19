// ---------------------------------------------------------------------------
// scan-pi — the supplier-INVOICE scanner's HTTP surface: photo/scan an invoice,
// land a DRAFT Purchase Invoice by converting the matching Goods Receipt(s).
// The PI MIRROR of scan-so.ts's /enqueue + poll, sharing the SAME scan_jobs
// table, SCAN_QUEUE and R2 bucket — a PI scan is just a scan_jobs row stamped
// document_type='PI', which the queue consumer routes to runPiScanJob.
//
// SAFETY: enqueue only persists photos + a job row; it creates NO document. The
// DRAFT PI (or the needs-review outcome) is decided in the background by
// runPiScanJob, which converts from the GRN and never fabricates a standalone
// invoice. See tasks/PLAN-ocr-scan-gr-pi.md.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Env } from '../env';
import type { Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { getSupabaseService } from '../../db/supabase';
import { activeCompanyId } from '../lib/companyScope';
import { parseScanFiles } from '../lib/scan-anthropic';
import { runPiScanJob } from '../lib/pi-scan-run';
import { reapStaleScanJobs } from './scan-so';
import { jobToJson } from './scan-so-serialize';

export const scanPi = new Hono<{ Bindings: Env; Variables: Variables }>();
scanPi.use('*', supabaseAuth);

const SCAN_JOBS_MISSING_MSG = 'Scanning is not set up on the server yet. Please enter this invoice manually.';
function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const code = err.code ?? '';
  const msg = err.message ?? '';
  return code === '42P01' || /relation .* does not exist|could not find the table/i.test(msg);
}

// GET /scan-pi/slip-image?key=scan-slips/... — serve the stored invoice image.
// Same key namespace + policy as scan-so's slip-image (mig 0033).
scanPi.get('/slip-image', async (c) => {
  const key = c.req.query('key') ?? '';
  if (!key.startsWith('scan-slips/')) {
    return c.json({ error: 'bad_request', reason: 'key must start with scan-slips/' }, 400);
  }
  // The binding is typed as always-present, but an older deploy can leave it
  // unbound — guard defensively (nullable cast so the check is real).
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
// Same multipart contract as /scan-so/enqueue.
scanPi.post('/enqueue', async (c) => {
  /* company-scope: the only writes here are to a scan_jobs row this handler
     itself just minted — the INSERT stamps company_id: activeCompanyId(c), and
     the image_keys UPDATE addresses that same freshly-created id (never a
     caller-supplied one), so there is no cross-company row to reach. Same shape
     as scan-so's /enqueue (grandfathered). */
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
  const svc = getSupabaseService(c.env);

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

// GET /scan-pi/jobs — this company's recent PI scan jobs (reaps stale jobs on
// poll, exactly like /scan-so/jobs; the reaper is document-type aware).
scanPi.get('/jobs', async (c) => {
  const svc = getSupabaseService(c.env);
  await reapStaleScanJobs(c.env, svc, (p) => {
    try { c.executionCtx.waitUntil(p); } catch { /* test runtime */ }
  });
  const { data, error } = await svc
    .from('scan_jobs')
    .select('id, status, salesperson, so_doc_no, linked_doc_no, document_type, error, sample_id, duplicate_of, image_keys, created_at, updated_at')
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

// GET /scan-pi/jobs/:id — poll one PI scan job.
scanPi.get('/jobs/:id', async (c) => {
  /* company-scope: a by-id poll of an opaque scan_jobs UUID the client received
     from its OWN enqueue — a read, and the same unscoped by-id poll scan-so's
     /jobs/:id makes (grandfathered). It returns only status/linked-doc text, no
     cross-company data worth leaking. */
  const id = (c.req.param('id') as string | undefined ?? '').trim();
  if (!id) return c.json({ error: 'bad_request', reason: 'Missing job id.' }, 400);
  const svc = getSupabaseService(c.env);
  await reapStaleScanJobs(c.env, svc, (p) => {
    try { c.executionCtx.waitUntil(p); } catch { /* test runtime */ }
  });
  const { data, error } = await svc
    .from('scan_jobs')
    .select('id, status, salesperson, so_doc_no, linked_doc_no, document_type, error, sample_id, duplicate_of, image_keys, created_at, updated_at')
    .eq('id', id)
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return c.json({ error: 'table_missing', reason: SCAN_JOBS_MISSING_MSG }, 503);
    return c.json({ error: 'query_failed', reason: 'Could not load the scan job. Please try again.' }, 500);
  }
  if (!data) return c.json({ error: 'not_found', reason: 'Scan job not found.' }, 404);
  return c.json({ success: true, data: { job: jobToJson(data as Record<string, unknown>) } });
});

// POST /scan-pi/jobs/clear-failed — clear this company's terminal error PI scan
// cards (the mobile "Clear" button). Only status='error' rows, this company.
scanPi.post('/jobs/clear-failed', async (c) => {
  const svc = getSupabaseService(c.env);
  const { error } = await svc
    .from('scan_jobs')
    .delete()
    .eq('company_id', activeCompanyId(c))
    .eq('document_type', 'PI')
    .eq('status', 'error');
  if (error) return c.json({ error: 'clear_failed', reason: 'Could not clear the failed scans.' }, 500);
  return c.json({ success: true });
});
