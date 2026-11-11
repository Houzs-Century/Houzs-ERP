// ----------------------------------------------------------------------------
// AI reads on the scan queue — the bill reader (PV / AP invoice), the payment
// request's bill, the supplier credit note and the card-terminal receipt.
//
// Each of those used to hold the request open for the whole Anthropic call
// (p95 17-28 s, one at 644 s), so staff watched a spinner and pressed again.
// Now the request only stores what was sent and answers with a job id; the
// SCAN_QUEUE consumer replays the UNCHANGED synchronous handler with the
// caller's context captured at enqueue (company, user, permissions), and keeps
// the handler's status + JSON body on the scm.scan_jobs row (`review`) for the
// page to poll. Same fields, same validation, same AI-usage rows, same model —
// the handler is the same function.
//
//   scan_jobs.document_type   AI_PV_EXTRACT | AI_PR_READ_BILL | AI_CN_SCAN | AI_PAY_EXTRACT
//   scan_jobs.file_hash       sha256 of what was sent: the same file sent again
//                             by the same company while a read is under way
//                             reuses that job
//   scan_jobs.review          { status, body } — the handler's answer
//   scan_jobs.image_keys      the R2 keys of the stored request (deleted once read)
//
// This module never imports a route (scan-payment.ts registers its routes from
// here). The runner that knows the four handlers registers itself
// (ai-read-runners.ts), so there is no import cycle.
// ----------------------------------------------------------------------------

import { requireActiveCompanyId } from './companyScope';
import type { Env } from '../env';

export const AI_READ_KINDS = {
  pv_extract: 'AI_PV_EXTRACT',
  pr_read_bill: 'AI_PR_READ_BILL',
  cn_scan: 'AI_CN_SCAN',
  pay_extract: 'AI_PAY_EXTRACT',
} as const;
export type AiReadKind = keyof typeof AI_READ_KINDS;

export function aiReadKindOf(documentType: unknown): AiReadKind | null {
  for (const [kind, dt] of Object.entries(AI_READ_KINDS)) if (dt === documentType) return kind as AiReadKind;
  return null;
}

/** A queued or running read untouched this long is dead (isolate evicted, a
 *  hung model call); the poll marks it failed so the page can say so. */
export const AI_READ_STALE_MINUTES = 5;
export const STALE_READ_ERROR = 'The reader took too long and was stopped. Please read it again.';
export const LOST_READ_ERROR = 'This read is no longer available. Please read it again.';
const NO_PERM = { error: "You don't have permission to do that." };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm service client and the Hono context are loosely typed across these routes
type Any = any;

/** What the consumer needs to replay the request: the body, the one uploaded
 *  file (multipart kinds), and the context values the handlers read. */
export type AiReadSnapshot = {
  kind: AiReadKind;
  body: unknown;
  file: { name: string; type: string } | null;
  vars: Record<string, unknown>;
};

const VAR_KEYS = ['companyId', 'companyCode', 'allowedCompanyIds', 'companies', 'houzsUser', 'user'] as const;

/** The request context values the handlers read, as JSON. A Set does not
 *  survive JSON, so houzsUser's permissions travel as an array. */
export function snapshotVars(c: { get(key: string): unknown }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of VAR_KEYS) {
    const v = c.get(k);
    if (v !== undefined) out[k] = v;
  }
  const hu = out.houzsUser as (Record<string, unknown> & { permissions_set?: Set<string>; permissions?: string[] }) | undefined;
  if (hu) {
    const { permissions_set: set, ...rest } = hu;
    out.houzsUser = { ...rest, permissions: rest.permissions ?? (set ? [...set] : []) };
  }
  return out;
}

export function restoreVars(vars: Record<string, unknown>): Map<string, unknown> {
  const m = new Map(Object.entries(vars));
  const hu = m.get('houzsUser') as (Record<string, unknown> & { permissions?: string[] }) | undefined;
  if (hu) m.set('houzsUser', { ...hu, permissions_set: new Set(hu.permissions ?? []) });
  return m;
}

/** A Hono-shaped context for running a handler off the request: `get`, `env`,
 *  `req.json()` / `req.formData()`, `json()`, and an executionCtx whose
 *  waitUntil work (AI-usage rows, kept originals) is awaited by `settle`. */
export function headlessContext(env: Env, svc: Any, snap: AiReadSnapshot, file: ArrayBuffer | null) {
  const waits: Promise<unknown>[] = [];
  const store = restoreVars(snap.vars);
  store.set('supabase', svc);
  const c = {
    env,
    get: (k: string) => store.get(k),
    set: (k: string, v: unknown) => { store.set(k, v); },
    req: {
      json: async () => JSON.parse(JSON.stringify(snap.body ?? {})),
      formData: async () => {
        const fd = new FormData();
        if (file && snap.file) fd.append('file', new File([file], snap.file.name, { type: snap.file.type }));
        return fd;
      },
      query: () => undefined,
      param: () => undefined,
      header: () => undefined,
    },
    json: (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }),
    executionCtx: { waitUntil: (p: Promise<unknown>) => { waits.push(p); } },
  };
  return { c, settle: () => Promise.allSettled(waits) };
}

async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What makes two submits "the same": the kind, the body without file names
 *  (a renamed copy is the same paper), and the uploaded file's bytes. */
export async function aiReadHash(kind: AiReadKind, body: unknown, file: ArrayBuffer | null): Promise<string> {
  const canon = JSON.stringify(body ?? {}, (k, v) => (k === 'name' ? undefined : v));
  return sha256Hex(`${kind}\n${canon}\n${file ? await sha256Hex(file) : ''}`);
}

type Bucket = {
  put(k: string, v: ArrayBuffer | string, o?: unknown): Promise<unknown>;
  get(k: string): Promise<{ body?: ReadableStream; arrayBuffer?: () => Promise<ArrayBuffer> } | null>;
  delete(k: string | string[]): Promise<unknown>;
};
const requestKey = (id: string) => `ai-reads/${id}/request.json`;
const fileKey = (id: string) => `ai-reads/${id}/file`;

async function readBytes(obj: { body?: ReadableStream; arrayBuffer?: () => Promise<ArrayBuffer> }): Promise<ArrayBuffer> {
  return typeof obj.arrayBuffer === 'function' ? obj.arrayBuffer() : new Response(obj.body).arrayBuffer();
}

export async function loadSnapshot(bucket: Bucket | undefined, id: string): Promise<{ snap: AiReadSnapshot; file: ArrayBuffer | null } | null> {
  if (!bucket) return null;
  const obj = await bucket.get(requestKey(id));
  if (!obj) return null;
  const snap = JSON.parse(new TextDecoder().decode(await readBytes(obj))) as AiReadSnapshot;
  let file: ArrayBuffer | null = null;
  if (snap.file) {
    const f = await bucket.get(fileKey(id));
    if (!f) return null;
    file = await readBytes(f);
  }
  return { snap, file };
}

export async function dropSnapshot(bucket: Bucket | undefined, id: string): Promise<void> {
  if (!bucket) return;
  try { await bucket.delete([requestKey(id), fileKey(id)]); } catch { /* best-effort: the bytes are also kept in scan_files */ }
}

/* ── The runner, registered by ai-read-runners.ts ─────────────────────────── */
type Runner = (env: Env, jobId: string, svc: Any) => Promise<void>;
let runner: Runner | null = null;
export function registerAiReadRunner(fn: Runner): void { runner = fn; }

/* ── Enqueue ──────────────────────────────────────────────────────────────── */
export type AiReadGate = (c: Any) => boolean;
export type AiReadSplit = (c: Any) => Promise<
  | { ok: true; bodies: unknown[]; file: { bytes: ArrayBuffer; name: string; type: string } | null }
  | { ok: false; resp: Response }
>;

/** The JSON kinds that read ONE paper per request: the body is the job. */
export const oneJsonBody: AiReadSplit = async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return { ok: false, resp: c.json({ error: 'invalid_json' }, 400) }; }
  return { ok: true, bodies: [body], file: null };
};

const firstOf = (list: unknown): unknown => (Array.isArray(list) && list.length > 0 ? list[0] : undefined);
const fileNameOf = (body: unknown, file: { name: string } | null): string | null => {
  if (file) return file.name || null;
  const b = (body ?? {}) as { files?: unknown; bills?: unknown; fromRequest?: unknown; requestId?: unknown };
  const firstBill = firstOf(b.bills) as { files?: unknown } | undefined;
  const firstFile = (firstOf(b.files) ?? firstOf(firstBill?.files)) as { name?: unknown } | undefined;
  const first = firstFile?.name ?? b.fromRequest ?? b.requestId;
  return typeof first === 'string' && first ? first.slice(0, 200) : null;
};

/** POST …/enqueue — store what was sent, answer at once with one job per paper:
 *  202 { jobs: [{ index, job_id, status, reused }] }. */
export function aiReadEnqueue(kind: AiReadKind, gate: AiReadGate, split: AiReadSplit) {
  const documentType = AI_READ_KINDS[kind];
  return async (c: Any): Promise<Response> => {
    /* company-scope: every row is inserted with company_id = the active company
       (strict, refused when unresolved); the reuse lookup and the image_keys
       update are scoped to that company and to rows this call just found or made. */
    if (!gate(c)) return c.json(NO_PERM, 403);
    const co = requireActiveCompanyId(c);
    if (!co.ok) return c.json(co.refusal, 409);
    const bucket = c.env?.SO_ITEM_PHOTOS as Bucket | undefined;
    if (!bucket) return c.json({ error: 'reader_store_missing', message: 'The reader cannot store the file on this server. Please try again later.' }, 503);
    const prep = await split(c);
    if (!prep.ok) return prep.resp;

    const svc = c.get('supabase');
    const vars = snapshotVars(c);
    const user = c.get('user') as { id?: string } | undefined;
    const hu = c.get('houzsUser') as { id?: unknown } | undefined;
    const houzsUserId = Number.isInteger(Number(hu?.id)) && Number(hu?.id) > 0 ? Number(hu?.id) : null;
    const batchId = crypto.randomUUID();
    const cutoff = new Date(Date.now() - AI_READ_STALE_MINUTES * 60_000).toISOString();
    const jobs: Array<{ index: number; job_id: string; status: string; reused: boolean }> = [];

    for (const [index, body] of prep.bodies.entries()) {
      const hash = await aiReadHash(kind, body, prep.file?.bytes ?? null);
      const { data: running, error: runErr } = await svc.from('scan_jobs').select('id, status')
        .eq('company_id', co.companyId).eq('document_type', documentType).eq('file_hash', hash)
        .in('status', ['queued', 'running']).gte('updated_at', cutoff)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (runErr) return c.json({ error: 'enqueue_failed', message: 'Could not start the read. Please try again.' }, 500);
      if (running) {
        jobs.push({ index, job_id: String(running.id), status: String(running.status), reused: true });
        continue;
      }
      const now = new Date().toISOString();
      const { data: row, error: insErr } = await svc.from('scan_jobs').insert({
        id: crypto.randomUUID(), status: 'queued', document_type: documentType, salesperson: null,
        salesperson_id: user?.id ?? null, houzs_user_id: houzsUserId, company_id: co.companyId,
        file_hash: hash, batch_id: batchId, file_name: fileNameOf(body, prep.file), image_keys: [],
        created_at: now, updated_at: now,
      }).select('id').single();
      const id = (row as { id?: string } | null)?.id;
      if (insErr || !id) {
        console.error('[ai-read enqueue] job insert failed:', insErr?.message);
        return c.json({ error: 'enqueue_failed', message: 'Could not start the read. Please try again.' }, 500);
      }
      const snap: AiReadSnapshot = { kind, body, file: prep.file ? { name: prep.file.name, type: prep.file.type } : null, vars };
      try {
        await bucket.put(requestKey(id), JSON.stringify(snap), { httpMetadata: { contentType: 'application/json' } });
        if (prep.file) await bucket.put(fileKey(id), prep.file.bytes, { httpMetadata: { contentType: prep.file.type } });
      } catch (e) {
        console.error('[ai-read enqueue] R2 put failed:', id, (e as Error).message);
        await svc.from('scan_jobs').update({ status: 'error', error: 'The file could not be stored. Please try again.', updated_at: now }).eq('id', id).eq('company_id', co.companyId);
        return c.json({ error: 'enqueue_failed', message: 'The file could not be stored. Please try again.' }, 500);
      }
      await svc.from('scan_jobs').update({ image_keys: prep.file ? [requestKey(id), fileKey(id)] : [requestKey(id)] })
        .eq('id', id).eq('company_id', co.companyId);

      if (c.env?.SCAN_QUEUE) {
        try {
          await c.env.SCAN_QUEUE.send({ aiRead: id });
        } catch (e) {
          console.error('[ai-read enqueue] SCAN_QUEUE.send failed:', id, (e as Error).message);
          await svc.from('scan_jobs').update({ status: 'error', error: 'Could not start the read. Please try again.', updated_at: now }).eq('id', id).eq('company_id', co.companyId);
          return c.json({ error: 'enqueue_failed', message: 'Could not start the read. Please try again.' }, 500);
        }
      } else if (runner) {
        // No queue bound (local dev): run after the response, as scan-pi does.
        const p = runner(c.env, id, svc).catch((e) => console.error('[ai-read] run failed:', id, e));
        try { c.executionCtx.waitUntil(p); } catch { /* non-Workers runtime: the promise runs on its own */ }
      }
      jobs.push({ index, job_id: id, status: 'queued', reused: false });
    }
    return c.json({ jobs }, 202);
  };
}

/* ── Poll ─────────────────────────────────────────────────────────────────── */
export type AiReadJobJson = {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  error: string | null;
  /** The handler's answer, once the read finished: exactly what the
   *  synchronous endpoint would have answered. */
  result: { status: number; body: unknown } | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function aiReadJobJson(r: Record<string, unknown>): AiReadJobJson {
  const status = String(r.status ?? '');
  const terminal = status === 'done' || status === 'error';
  const review = (r.review ?? null) as { status?: unknown; body?: unknown } | null;
  return {
    id: String(r.id),
    status: (['queued', 'running', 'done', 'error'].includes(status) ? status : 'error') as AiReadJobJson['status'],
    error: status === 'error' ? String(r.error ?? LOST_READ_ERROR) : null,
    result: terminal && review && typeof review.status === 'number' ? { status: review.status, body: review.body ?? null } : null,
  };
}

/** GET …/jobs?ids=a,b — this company's reads of this kind. An id that is not
 *  this company's reads exactly like one that does not exist. */
export function aiReadPoll(kind: AiReadKind, gate: AiReadGate) {
  const documentType = AI_READ_KINDS[kind];
  return async (c: Any): Promise<Response> => {
    if (!gate(c)) return c.json(NO_PERM, 403);
    const co = requireActiveCompanyId(c);
    if (!co.ok) return c.json(co.refusal, 409);
    const ids = [...new Set(String(c.req.query('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
    if (ids.length === 0 || ids.length > 50 || ids.some((id) => !UUID.test(id))) {
      return c.json({ error: 'bad_request', message: 'Send between 1 and 50 job ids.' }, 400);
    }
    const svc = c.get('supabase');
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - AI_READ_STALE_MINUTES * 60_000).toISOString();
    // company-scope: the reaper and the read both carry this company's predicate.
    await svc.from('scan_jobs').update({ status: 'error', error: STALE_READ_ERROR, updated_at: now })
      .eq('company_id', co.companyId).eq('document_type', documentType)
      .in('status', ['queued', 'running']).lt('updated_at', cutoff);
    const { data, error } = await svc.from('scan_jobs').select('id, status, error, review')
      .eq('company_id', co.companyId).eq('document_type', documentType).in('id', ids);
    if (error) return c.json({ error: 'load_failed', message: 'Could not check the read. Please try again.' }, 500);
    const byId = new Map(((data ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.id), r]));
    return c.json({
      jobs: ids.map((id) => {
        const r = byId.get(id);
        return r ? aiReadJobJson(r) : { id, status: 'error', error: LOST_READ_ERROR, result: null };
      }),
    });
  };
}
