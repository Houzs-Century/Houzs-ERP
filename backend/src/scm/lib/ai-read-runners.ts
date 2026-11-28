
import { extractBillsHandler } from '../routes/pv-extract';
import { readRequestBillHandler } from '../routes/payment-request-bill';
import { scanSupplierCreditNoteHandler } from '../routes/credit-note-scan';
import { extractPaymentHandler } from '../routes/scan-payment';
import { getSupabaseService } from '../../db/supabase';
import type { Env } from '../env';
import {
  aiReadKindOf, dropSnapshot, headlessContext, loadSnapshot, registerAiReadRunner, LOST_READ_ERROR, type AiReadKind,
} from './ai-read-jobs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the handlers take a loosely-typed Hono context
type Any = any;

function handlerFor(kind: AiReadKind): (c: Any) => Promise<Response> {
  switch (kind) {
    case 'pv_extract': return extractBillsHandler;
    case 'pr_read_bill': return readRequestBillHandler;
    case 'cn_scan': return scanSupplierCreditNoteHandler;
    case 'pay_extract': return extractPaymentHandler as (c: Any) => Promise<Response>;
  }
}

const CRASH_ERROR = 'The reader stopped unexpectedly. Please read it again.';

function reasonOf(body: unknown, status: number): string {
  const b = (body ?? {}) as { message?: unknown; reason?: unknown; error?: unknown };
  for (const v of [b.message, b.reason, b.error]) if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 500);
  return `The reader answered ${status}.`;
}

export async function runAiReadJob(env: Env, jobId: string, svc: Any): Promise<void> {
  const { data: row, error } = await svc.from('scan_jobs').select('id, status, document_type').eq('id', jobId).maybeSingle();
  if (error) throw new Error(`scan_jobs read failed for ${jobId}: ${error.message}`);
  if (!row) return;
  const kind = aiReadKindOf(row.document_type);
  if (!kind || row.status !== 'queued') return;

  const { data: claimed, error: claimErr } = await svc.from('scan_jobs')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .eq('id', jobId).eq('status', 'queued').select('id').maybeSingle();
  if (claimErr) throw new Error(`scan_jobs claim failed for ${jobId}: ${claimErr.message}`);
  if (!claimed) return;

  const finish = async (patch: Record<string, unknown>) => {
    const { error: upErr } = await svc.from('scan_jobs')
      .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', jobId).eq('status', 'running');
    if (upErr) console.error('[ai-read] job update failed:', jobId, upErr.message);
  };
  const bucket = env.SO_ITEM_PHOTOS as Any;
  try {
    const loaded = await loadSnapshot(bucket, jobId);
    if (!loaded) { await finish({ status: 'error', error: LOST_READ_ERROR }); return; }
    const { c, settle } = headlessContext(env, svc, loaded.snap, loaded.file);
    const res = await handlerFor(kind)(c);
    await settle();
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    const ok = res.status >= 200 && res.status < 300;
    await finish(ok
      ? { status: 'done', error: null, review: { status: res.status, body } }
      : { status: 'error', error: reasonOf(body, res.status), review: { status: res.status, body } });
  } catch (e) {
    console.error('[ai-read] run failed:', jobId, e);
    await finish({ status: 'error', error: CRASH_ERROR });
  } finally {
    await dropSnapshot(bucket, jobId);
  }
}

/** The queue consumer's entry (index.ts `queue()`, message { aiRead }). */
export async function processAiReadQueueMessage(env: Env, jobId: string): Promise<void> {
  if (!jobId) return;
  await runAiReadJob(env, jobId, getSupabaseService(env));
}

registerAiReadRunner(runAiReadJob);
