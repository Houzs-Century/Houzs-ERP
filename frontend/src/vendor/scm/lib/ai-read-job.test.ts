/* The AI reads on the scan queue, client side (ai-read-job.ts): enqueue, poll
   until each paper is read, and hand back exactly the body the synchronous read
   answered; a failed read carries the same plain-language wording; the page is
   told where each paper is. */
import { afterEach, describe, expect, test, vi } from 'vitest';

const calls: Array<{ path: string; init?: RequestInit }> = [];
let answer: (path: string, init?: RequestInit) => unknown = () => ({});
vi.mock('./authed-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./authed-fetch')>()),
  authedFetch: vi.fn(async (path: string, init?: RequestInit) => { calls.push({ path, init }); return answer(path, init); }),
}));

import { runAiRead, runOneAiRead, type AiReadJob } from './ai-read-job';

const noWait = async () => {};
afterEach(() => { calls.length = 0; });

/** A server whose jobs move through the given polls, one status list per poll. */
const server = (enqueued: Array<{ index: number; job_id: string; status: string }>, polls: AiReadJob[][]) => {
  let n = 0;
  answer = (path) => {
    if (path.endsWith('/enqueue')) return { jobs: enqueued };
    const ids = new URL(`http://x${path}`).searchParams.get('ids')!.split(',');
    const round = polls[Math.min(n++, polls.length - 1)]!;
    return { jobs: round.filter((j) => ids.includes(j.id)) };
  };
};
const job = (id: string, status: AiReadJob['status'], result: AiReadJob['result'] = null, error: string | null = null): AiReadJob => ({ id, status, error, result });

describe('runAiRead', () => {
  test('enqueues once, polls until read, returns the synchronous body; the page hears queued then reading', async () => {
    server([{ index: 0, job_id: 'j1', status: 'queued' }], [
      [job('j1', 'queued')],
      [job('j1', 'running')],
      [job('j1', 'done', { status: 200, body: { ok: true, read: { cnNumber: 'CN-1' } } })],
    ]);
    const stages: string[] = [];
    const body = await runOneAiRead<{ read: { cnNumber: string } }>('/credit-notes/scan', { files: [] }, (s) => stages.push(s), noWait);
    expect(body.read.cnNumber).toBe('CN-1');
    expect(calls[0]).toMatchObject({ path: '/credit-notes/scan/enqueue', init: { method: 'POST', body: JSON.stringify({ files: [] }) } });
    expect(calls.slice(1).map((c) => c.path)).toEqual(Array(3).fill('/credit-notes/scan/jobs?ids=j1'));
    expect(stages).toEqual(['queued', 'queued', 'reading']);
  });

  test('one outcome per paper in order; a paper sent twice shares its job; one failure does not fail the rest', async () => {
    server([
      { index: 1, job_id: 'b', status: 'queued' },
      { index: 0, job_id: 'a', status: 'running' },
      { index: 2, job_id: 'a', status: 'running' },
    ], [[
      job('a', 'done', { status: 200, body: { bills: ['A'] } }),
      job('b', 'error', null, 'The reader took too long and was stopped. Please read it again.'),
    ]]);
    const out = await runAiRead<{ bills: string[] }>('/payment-vouchers/extract', { bills: [] }, null, noWait);
    expect(out.map((o) => (o.ok ? o.body.bills[0] : o.error.message))).toEqual(['A', 'The reader took too long and was stopped. Please read it again.', 'A']);
    expect(calls[1]!.path).toBe('/payment-vouchers/extract/jobs?ids=b,a');
  });

  test('a refusal comes back as the same sentence the synchronous call showed, with its status', async () => {
    server([{ index: 0, job_id: 'j1', status: 'queued' }], [[
      job('j1', 'error', { status: 502, body: { error: 'read_failed', message: 'The reader could not read this credit note.' } }, 'The reader could not read this credit note.'),
    ]]);
    const err = await runOneAiRead('/credit-notes/scan', { files: [] }, null, noWait).catch((e: unknown) => e) as Error & { status?: number };
    expect(err.message).toBe('The reader could not read this credit note.');
    expect(err.status).toBe(502);
  });

  test('a multipart paper is sent as the form itself', async () => {
    server([{ index: 0, job_id: 'j1', status: 'queued' }], [[job('j1', 'done', { status: 200, body: { data: { extracted: {} } } })]]);
    const form = new FormData();
    await runOneAiRead('/scan-payment/extract', form, null, noWait);
    expect(calls[0]!.init!.body).toBe(form);
  });
});
