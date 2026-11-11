// ----------------------------------------------------------------------------
// AI reads on the scan queue (backend scm/lib/ai-read-jobs.ts) — the bill
// reader, the payment request's bill, the supplier credit note and the
// card-terminal receipt. The request answers at once with one job per paper;
// this polls until each is read and hands back exactly what the old synchronous
// endpoint answered, so every form fills as before. A failed read throws (or,
// for a batch, comes back as that paper's failure) with the same plain-language
// wording authedFetch gave the synchronous refusal. Polling, never a socket.
// ----------------------------------------------------------------------------

import { authedFetch, humanApiError } from './authed-fetch';

/** Where a paper is: waiting for a reader, or being read. Done and failed are
 *  the outcome itself. */
export type AiReadStage = 'queued' | 'reading';

export type AiReadJob = {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  error: string | null;
  result: { status: number; body: unknown } | null;
};
type Enqueued = { jobs: Array<{ index: number; job_id: string; status: string }> };

export type AiReadOutcome<T> = { ok: true; body: T } | { ok: false; error: Error };

export const AI_READ_POLL_MS = 1500;
/* Past the server's own 5-minute stale mark, so the server's "took too long"
   sentence normally arrives first. */
const AI_READ_DEADLINE_MS = 6 * 60_000;
const TOO_LONG = 'Reading took too long — nothing was saved. Please read it again.';

const stageOf = (status: string): AiReadStage => (status === 'running' ? 'reading' : 'queued');

/** The error a failed read carries: the handler's own refusal through the same
 *  wording the synchronous call showed, else the job's sentence. */
export function aiReadError(job: AiReadJob): Error {
  if (job.result && (job.result.status < 200 || job.result.status >= 300)) {
    const body = JSON.stringify(job.result.body ?? {});
    const err = new Error(humanApiError(job.result.status, body)) as Error & { status?: number; body?: string };
    err.status = job.result.status;
    err.body = body;
    return err;
  }
  return new Error(job.error ?? 'The read failed. Please read it again.');
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Poll `<base>/jobs` until every job is read or failed. */
export async function pollAiReads<T>(
  base: string,
  ids: string[],
  onStage: ((id: string, stage: AiReadStage) => void) | null,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<Map<string, AiReadOutcome<T>>> {
  const pending = new Set(ids);
  const out = new Map<string, AiReadOutcome<T>>();
  const started = Date.now();
  while (pending.size > 0) {
    await wait(AI_READ_POLL_MS);
    if (Date.now() - started > AI_READ_DEADLINE_MS) {
      for (const id of pending) out.set(id, { ok: false, error: new Error(TOO_LONG) });
      break;
    }
    const { jobs } = await authedFetch<{ jobs: AiReadJob[] }>(`${base}/jobs?ids=${[...pending].join(',')}`);
    for (const j of jobs) {
      if (!pending.has(j.id)) continue;
      if (j.status === 'done' && j.result) {
        out.set(j.id, { ok: true, body: j.result.body as T });
        pending.delete(j.id);
      } else if (j.status === 'done' || j.status === 'error') {
        out.set(j.id, { ok: false, error: aiReadError(j) });
        pending.delete(j.id);
      } else {
        onStage?.(j.id, stageOf(j.status));
      }
    }
  }
  return out;
}

/** Send the paper(s) to `<base>/enqueue`, then poll. One outcome per paper, in
 *  the order sent; `onStage(index, stage)` follows each one. */
export async function runAiRead<T>(
  base: string,
  body: unknown,
  onStage: ((index: number, stage: AiReadStage) => void) | null,
  wait?: (ms: number) => Promise<void>,
): Promise<Array<AiReadOutcome<T>>> {
  const { jobs } = await authedFetch<Enqueued>(`${base}/enqueue`, {
    method: 'POST',
    body: body instanceof FormData ? body : JSON.stringify(body),
  });
  const indicesOf = new Map<string, number[]>();
  for (const j of jobs) {
    indicesOf.set(j.job_id, [...(indicesOf.get(j.job_id) ?? []), j.index]);
    onStage?.(j.index, stageOf(j.status));
  }
  const outcomes = await pollAiReads<T>(base, [...indicesOf.keys()], onStage
    ? (id, stage) => { for (const i of indicesOf.get(id) ?? []) onStage(i, stage); }
    : null, wait);
  return [...jobs].sort((a, b) => a.index - b.index)
    .map((j) => outcomes.get(j.job_id) ?? { ok: false as const, error: new Error(TOO_LONG) });
}

/** One paper, one answer: the read's body, or its failure thrown. */
export async function runOneAiRead<T>(
  base: string,
  body: unknown,
  onStage: ((stage: AiReadStage) => void) | null,
  wait?: (ms: number) => Promise<void>,
): Promise<T> {
  const first = (await runAiRead<T>(base, body, onStage ? (_i, s) => { onStage(s); } : null, wait)).at(0);
  if (!first) throw new Error('The reader sent nothing back. Please read it again.');
  if (!first.ok) throw first.error;
  return first.body;
}

/** How a stage reads on screen: `what` is the paper ("the bill"). */
export const aiReadStageNote = (stage: AiReadStage, what: string): string =>
  (stage === 'queued' ? `Queued — ${what} is waiting for the reader…` : `Reading ${what}…`);
