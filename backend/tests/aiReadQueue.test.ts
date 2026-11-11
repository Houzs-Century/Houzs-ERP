/* The AI reads on the scan queue (scm/lib/ai-read-jobs.ts): the bill reader,
   the credit-note scan, the payment request's bill and the receipt used to hold
   the request open for the whole model call (p95 17-28 s). Now the request
   stores what was sent and answers with a job id; the queue consumer runs the
   SAME handler and the page polls. Pinned:
     • enqueue answers 202 with a job, sends { aiRead } to the queue, and the
       polled result is exactly what the synchronous endpoint answers;
     • the AI-usage row is written with the caller's company and user;
     • the bill reader makes one job per bill, each with its own answer;
     • the same file sent again while its read is under way reuses the job;
     • a reader failure and a refusal both come back as a failed job with the
       handler's own status, body and sentence; a read that never finishes is
       marked failed by the poll;
     • one company cannot poll another company's job. */

import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { creditNotes } from '../src/scm/routes/credit-notes';
import { paymentVouchers } from '../src/scm/routes/payment-vouchers';
import { runAiReadJob } from '../src/scm/lib/ai-read-runners';
import { LOST_READ_ERROR, STALE_READ_ERROR } from '../src/scm/lib/ai-read-jobs';

const KEYS = ['scm.payment_voucher.create'];
const USER_ID = 42;

const fakeR2 = () => {
  const store = new Map<string, ArrayBuffer>();
  const bytes = (v: ArrayBuffer | string) => (typeof v === 'string' ? new TextEncoder().encode(v).buffer : v);
  return {
    store,
    put: async (k: string, v: ArrayBuffer | string) => { store.set(k, bytes(v)); },
    get: async (k: string) => { const hit = store.get(k); return hit ? { body: new Blob([hit]).stream() } : null; },
    delete: async (k: string | string[]) => { for (const key of Array.isArray(k) ? k : [k]) store.delete(key); },
  };
};

const CN_READ = {
  isCreditNote: true, vendorName: 'DIGLANT MANUFACTURING SDN. BHD.', vendorRegNo: null, cnNumber: 'DGPSC26000280', cnDate: '2026-09-21',
  invoiceNumbers: [], subtotalRm: 100, sstRm: 0, totalRm: 100, remark: null,
  lines: [{ description: "Sales Rebate - Aug'26", invoiceNo: null, itemCode: null, qty: 1, unitPriceRm: 100, amountRm: 100 }],
};
const BILL_READ = (invoiceNumber: string) => ({
  vendorName: 'Tenaga Nasional Berhad', vendorRegNo: null, documentKind: 'bill', invoiceNumber,
  invoiceDate: '2026-09-01', dueDate: null, currency: 'MYR', totalRm: '150.00', sstRm: null, lines: [],
});
const anthropicAnswer = (body: unknown) => new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(body) }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
afterEach(() => { vi.unstubAllGlobals(); });

function world() {
  const tables: Record<string, Row[]> = {
    scan_jobs: [], scan_files: [],
    suppliers: [{ id: 'sup-d', company_id: 1, code: '400-D002', name: 'DIGLANT MANUFACTURING SDN BHD.', status: 'ACTIVE' }],
    accounts: [{ company_id: 1, account_code: '591-0000', account_name: 'SPONSORSHIP', account_type: 'EXPENSE', parent_code: null, is_active: true, special_type: null }],
    acc_account_roles: [], acc_credit_notes: [], purchase_invoices: [], ap_invoices: [], acc_vendor_memory: [],
  };
  const sb = fakeSb(tables);
  const r2 = fakeR2();
  const sent: unknown[] = [];
  const usage: unknown[][] = [];
  const env = {
    ANTHROPIC_API_KEY: 'k',
    DATABASE_URL: 'postgres://usage-recorder', // the usage rows go to the fake DB below
    SO_ITEM_PHOTOS: r2,
    SCAN_QUEUE: { send: async (m: unknown) => { sent.push(m); } },
    DB: { prepare: () => ({ bind: (...args: unknown[]) => ({ run: async () => { usage.push(args); } }) }) },
  };
  const appFor = (companyId: number, perms: readonly string[] = KEYS) => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('supabase' as never, sb as never);
      c.set('companyId' as never, companyId as never);
      c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
      c.set('houzsUser' as never, { id: USER_ID, name: 'Chew', permissions_set: new Set(perms) } as never);
      c.set('allowedCompanyIds' as never, [companyId] as never);
      c.set('companies' as never, [{ id: companyId, code: 'HOUZS' }] as never);
      c.set('companyCode' as never, 'HOUZS' as never);
      await next();
    });
    app.route('/credit-notes', creditNotes);
    app.route('/payment-vouchers', paymentVouchers);
    return (path: string, method: string, body?: unknown) =>
      app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env as never);
  };
  const run = (id: string) => runAiReadJob(env as never, id, sb);
  return { tables, sb, r2, sent, usage, env, appFor, run };
}

type Job = { id: string; status: string; error: string | null; result: { status: number; body: Row } | null };
const PAGE = (name = 'cn.pdf', data = 'JVBERi0=') => ({ files: [{ name, mime: 'application/pdf', dataBase64: data }] });
const enqueue = async (req: ReturnType<ReturnType<typeof world>['appFor']>, path: string, body: unknown) => {
  const res = await req(path, 'POST', body);
  expect(res.status, await res.clone().text()).toBe(202);
  return (await res.json() as { jobs: Array<{ index: number; job_id: string; status: string; reused: boolean }> }).jobs;
};
const poll = async (req: ReturnType<ReturnType<typeof world>['appFor']>, path: string, ids: string[]) => {
  const res = await req(`${path}?ids=${ids.join(',')}`, 'GET');
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json() as { jobs: Job[] }).jobs;
};

describe('enqueue, poll, result', () => {
  test('the credit-note scan answers a job at once; the polled result is what the synchronous scan answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => anthropicAnswer(CN_READ)));
    const w = world();
    const req = w.appFor(1);
    const [job] = await enqueue(req, '/credit-notes/scan/enqueue', PAGE());
    expect(job).toMatchObject({ index: 0, status: 'queued', reused: false });
    expect(w.sent).toEqual([{ aiRead: job!.job_id }]);
    expect(w.tables.scan_jobs[0]).toMatchObject({ document_type: 'AI_CN_SCAN', company_id: 1, status: 'queued', houzs_user_id: USER_ID });
    expect((await poll(req, '/credit-notes/scan/jobs', [job!.job_id]))[0]).toMatchObject({ status: 'queued', result: null });
    expect(fetch).not.toHaveBeenCalled(); // the request itself never calls the reader

    await w.run(job!.job_id);
    const [done] = await poll(req, '/credit-notes/scan/jobs', [job!.job_id]);
    expect(done!.status).toBe('done');
    const sync = await req('/credit-notes/scan', 'POST', PAGE());
    expect(done!.result).toEqual({ status: 200, body: await sync.json() });
    expect(done!.result!.body.read.cnNumber).toBe('DGPSC26000280');
    /* The stored request is gone once read. */
    expect([...w.r2.store.keys()].filter((k) => k.startsWith('ai-reads/'))).toEqual([]);
    /* AI usage: one row per call, the caller's company and user, same feature. */
    expect(w.usage[0]!.slice(0, 3)).toEqual(['credit_note_extract', 1, USER_ID]);
  });

  test('the bill reader makes one job per bill, each with its own answer, and runs no job twice', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => anthropicAnswer(BILL_READ(`INV-${++call}`))));
    const w = world();
    const req = w.appFor(1);
    const jobs = await enqueue(req, '/payment-vouchers/extract/enqueue', { bills: [PAGE('a.pdf', 'QUFB'), PAGE('b.pdf', 'QkJC')] });
    expect(jobs.map((j) => j.index)).toEqual([0, 1]);
    expect(new Set(jobs.map((j) => j.job_id)).size).toBe(2);
    await w.run(jobs[0]!.job_id);
    const mid = await poll(req, '/payment-vouchers/extract/jobs', jobs.map((j) => j.job_id));
    expect(mid.map((j) => j.status)).toEqual(['done', 'queued']);
    await w.run(jobs[1]!.job_id);
    await w.run(jobs[1]!.job_id); // a redelivered message
    const done = await poll(req, '/payment-vouchers/extract/jobs', jobs.map((j) => j.job_id));
    expect(done.map((j) => (j.result!.body.bills as Row[])[0]!.extraction.invoiceNumber)).toEqual(['INV-1', 'INV-2']);
    expect(call).toBe(2);
  });

  test('the batch refusals still answer at once, before any job', async () => {
    const w = world();
    const res = await w.appFor(1)('/payment-vouchers/extract/enqueue', 'POST', { bills: [{ files: [{ name: 'a.docx', mime: 'application/msword', dataBase64: 'aGk=' }] }] });
    expect([res.status, (await res.json() as Row).error]).toEqual([400, 'bad_file_type']);
    expect((await w.appFor(1, [])('/credit-notes/scan/enqueue', 'POST', PAGE())).status).toBe(403);
    expect(w.tables.scan_jobs).toEqual([]);
  });
});

describe('a second submit of the same file', () => {
  test('reuses the running job (same company, renamed copy); a new read starts once it has finished', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => anthropicAnswer(CN_READ)));
    const w = world();
    const req = w.appFor(1);
    const [first] = await enqueue(req, '/credit-notes/scan/enqueue', PAGE('cn.pdf'));
    const [again] = await enqueue(req, '/credit-notes/scan/enqueue', PAGE('CN copy.pdf'));
    expect(again).toMatchObject({ job_id: first!.job_id, reused: true });
    expect(w.sent).toHaveLength(1);
    expect(w.tables.scan_jobs).toHaveLength(1);
    /* Another company's same file is its own read. */
    const [other] = await enqueue(w.appFor(2), '/credit-notes/scan/enqueue', PAGE('cn.pdf'));
    expect(other!.job_id).not.toBe(first!.job_id);
    /* A different file is a different read. */
    const [different] = await enqueue(req, '/credit-notes/scan/enqueue', PAGE('cn.pdf', 'SGVsbG8='));
    expect(different!.reused).toBe(false);

    await w.run(first!.job_id);
    const [later] = await enqueue(req, '/credit-notes/scan/enqueue', PAGE('cn.pdf'));
    expect(later!.reused).toBe(false);
    expect(later!.job_id).not.toBe(first!.job_id);
  });
});

describe('failures reach the page', () => {
  test('the reader failing: a failed job with the handler\'s own status, body and sentence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('overloaded', { status: 529 })));
    const w = world();
    const req = w.appFor(1);
    const [job] = await enqueue(req, '/credit-notes/scan/enqueue', PAGE());
    await w.run(job!.job_id);
    const [failed] = await poll(req, '/credit-notes/scan/jobs', [job!.job_id]);
    expect(failed!.status).toBe('error');
    expect(failed!.result!.status).toBe(502);
    expect(failed!.result!.body.error).toBe('read_failed');
    expect(failed!.error).toBe(failed!.result!.body.message);
  });

  test('a refusal found in the job (a wrong file type) is a failed job too', async () => {
    const w = world();
    const req = w.appFor(1);
    const [job] = await enqueue(req, '/credit-notes/scan/enqueue', { files: [{ name: 'a.docx', mime: 'application/msword', dataBase64: 'aGk=' }] });
    await w.run(job!.job_id);
    const [failed] = await poll(req, '/credit-notes/scan/jobs', [job!.job_id]);
    expect([failed!.status, failed!.result!.status, failed!.result!.body.error]).toEqual(['error', 400, 'bad_file_type']);
  });

  test('a read that never finishes is marked failed by the poll; a lost stored request fails, never hangs', async () => {
    const w = world();
    const req = w.appFor(1);
    const [stuck] = await enqueue(req, '/credit-notes/scan/enqueue', PAGE());
    w.tables.scan_jobs[0]!.updated_at = new Date(Date.now() - 6 * 60_000).toISOString();
    expect((await poll(req, '/credit-notes/scan/jobs', [stuck!.job_id]))[0]).toMatchObject({ status: 'error', error: STALE_READ_ERROR });

    const [lost] = await enqueue(req, '/credit-notes/scan/enqueue', PAGE('x.pdf', 'WFhY'));
    w.r2.store.clear();
    await w.run(lost!.job_id);
    expect((await poll(req, '/credit-notes/scan/jobs', [lost!.job_id]))[0]).toMatchObject({ status: 'error', error: LOST_READ_ERROR });
  });
});

describe('company scope on the job read', () => {
  test('another company polls the job as if it did not exist; a bad id list is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => anthropicAnswer(CN_READ)));
    const w = world();
    const [job] = await enqueue(w.appFor(1), '/credit-notes/scan/enqueue', PAGE());
    await w.run(job!.job_id);
    const [seen] = await poll(w.appFor(2), '/credit-notes/scan/jobs', [job!.job_id]);
    expect(seen).toEqual({ id: job!.job_id, status: 'error', error: LOST_READ_ERROR, result: null });
    /* Nor through another kind's poll in the same company. */
    expect((await poll(w.appFor(1), '/payment-vouchers/extract/jobs', [job!.job_id]))[0]!.result).toBeNull();
    expect((await w.appFor(1)('/credit-notes/scan/jobs?ids=not-a-uuid', 'GET')).status).toBe(400);
    expect((await w.appFor(1, [])(`/credit-notes/scan/jobs?ids=${job!.job_id}`, 'GET')).status).toBe(403);
  });
});
