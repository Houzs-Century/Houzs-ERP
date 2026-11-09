/* "Delivered with issue" routes — the crew's problem report at POD and the
   office's reads of it. The work lives in scm/lib/delivery-issue.ts; each router
   here is mounted on the prefix whose area guard already says who may reach it
   (scm/index.ts):

     POST /delivery-orders-mfg/:id/delivery-issue       report on a DO (the DO's
          crew, or anyone whose delivery scope is 'all')
     GET  /delivery-orders-mfg/:id/delivery-issues      the DO detail page
     GET  /mfg-sales-orders/:docNo/delivery-issues      the SO detail page
     POST /delivery-jobs/:sourceType/:sourceId/:leg/issue   report on a non-DO job
     GET  /delivery-planning/delivery-issues?so=&do=&jobs=  Last Mile rows, the
          driver's POD / job screens

   Reporting never changes the DO or job status: the delivery is recorded
   delivered either way; the issue is a separate row plus a Service Case. */
import { Hono, type Context } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { scopeToAllowedCompanies } from '../lib/companyScope';
import { resolveDeliveryScope, scopeMatchesAssignment } from '../lib/deliveryScope';
import { fetchDoCrewAssignment } from './delivery-pod-context';
import { parseJob, loadJob } from './delivery-job-progress';
import { parseDeliveryIssueBody, reportDeliveryIssue, listDeliveryIssues } from '../lib/delivery-issue';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const NOT_YOUR_JOB = 'You can only report a problem on a delivery assigned to you.';
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

async function readBody(c: Ctx): Promise<unknown> {
  try { return await c.req.json(); } catch { return null; }
}

/* ── On the DO router ─────────────────────────────────────────────────────── */
export const doDeliveryIssues = new Hono<{ Bindings: Env; Variables: Variables }>();
doDeliveryIssues.use('*', supabaseAuth);

doDeliveryIssues.post('/:id/delivery-issue', async (c) => {
  const parsed = parseDeliveryIssueBody(await readBody(c));
  if (!parsed.ok) return c.json({ error: parsed.error, reason: parsed.reason }, 400);
  const sb = c.get('supabase');
  const ref = c.req.param('id');
  const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  const { data: header, error } = await scopeToAllowedCompanies(
    sb.from('delivery_orders').select('id, do_number, so_doc_no, status, company_id').eq(byId ? 'id' : 'do_number', ref),
    c,
  ).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!header) return c.json({ error: 'not_found', reason: 'This delivery order could not be found.' }, 404);
  const h = header as { id: string; do_number: string | null; so_doc_no: string | null; status: string | null; company_id: number | null };
  if (String(h.status ?? '').toUpperCase() === 'CANCELLED')
    return c.json({ error: 'do_cancelled', reason: 'This delivery order was cancelled.' }, 409);
  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  if (scope.mode !== 'all' && !scopeMatchesAssignment(scope, await fetchDoCrewAssignment(sb, h.id)))
    return c.json({ error: 'not_your_job', reason: NOT_YOUR_JOB }, 403);
  try {
    const r = await reportDeliveryIssue(c, {
      companyId: h.company_id,
      deliveryOrderId: h.id,
      doNumber: h.do_number,
      soDocNo: h.so_doc_no,
      job: null,
      caseDocNo: h.so_doc_no || h.do_number || h.id,
      where: [h.do_number, h.so_doc_no ? `(SO ${h.so_doc_no})` : null].filter(Boolean).join(' ') || 'a delivery order',
    }, parsed.value);
    if (!r.ok) return c.json({ error: r.error, reason: r.reason }, r.status);
    return c.json({ issue: r.issue }, 201);
  } catch (e) {
    return c.json({ error: 'save_failed', reason: (e as Error).message }, 500);
  }
});

doDeliveryIssues.get('/:id/delivery-issues', async (c) => {
  try {
    return c.json({ issues: await listDeliveryIssues(c, { deliveryOrderIds: [c.req.param('id')] }) });
  } catch (e) {
    return c.json({ error: 'load_failed', reason: (e as Error).message }, 500);
  }
});

/* ── On the SO router ─────────────────────────────────────────────────────── */
export const soDeliveryIssues = new Hono<{ Bindings: Env; Variables: Variables }>();
soDeliveryIssues.use('*', supabaseAuth);

soDeliveryIssues.get('/:docNo/delivery-issues', async (c) => {
  try {
    return c.json({ issues: await listDeliveryIssues(c, { soDocNos: [c.req.param('docNo')] }) });
  } catch (e) {
    return c.json({ error: 'load_failed', reason: (e as Error).message }, 500);
  }
});

/* ── On the delivery-jobs router (a non-DO stop) ──────────────────────────── */
export const jobDeliveryIssues = new Hono<{ Bindings: Env; Variables: Variables }>();
jobDeliveryIssues.use('*', supabaseAuth);

jobDeliveryIssues.post('/:sourceType/:sourceId/:leg/issue', async (c) => {
  const job = parseJob(c);
  if ('error' in job) return c.json({ error: 'invalid_job', reason: job.error }, 400);
  const parsed = parseDeliveryIssueBody(await readBody(c));
  if (!parsed.ok) return c.json({ error: parsed.error, reason: parsed.reason }, 400);
  // loadJob applies the company predicate and the crew's own-job rule.
  const loaded = await loadJob(c, job.sourceType, job.sourceId, job.leg);
  if (!loaded.ok) return c.json({ error: loaded.error, reason: loaded.reason }, loaded.status);
  const row = loaded.row;
  const docRef = String((job.sourceType === 'assr' ? row.assr_no : job.sourceType === 'project' ? row.code : row.dp_no) ?? job.sourceId);
  // A service-case leg's SO is the case's doc_no; a project / DP job has none.
  const soDocNo = job.sourceType === 'assr' && row.doc_no ? String(row.doc_no) : null;
  try {
    const r = await reportDeliveryIssue(c, {
      companyId: loaded.companyId,
      deliveryOrderId: null,
      doNumber: null,
      soDocNo,
      job,
      caseDocNo: soDocNo ?? docRef,
      where: `${job.leg} job ${docRef}${soDocNo ? ` (SO ${soDocNo})` : ''}`,
    }, parsed.value);
    if (!r.ok) return c.json({ error: r.error, reason: r.reason }, r.status);
    return c.json({ issue: r.issue }, 201);
  } catch (e) {
    return c.json({ error: 'save_failed', reason: (e as Error).message }, 500);
  }
});

/* ── On the delivery-planning router (Last Mile + the crew's screens) ─────── */
export const lastMileDeliveryIssues = new Hono<{ Bindings: Env; Variables: Variables }>();
lastMileDeliveryIssues.use('*', supabaseAuth);

lastMileDeliveryIssues.get('/delivery-issues', async (c) => {
  try {
    const issues = await listDeliveryIssues(c, {
      soDocNos: list(c.req.query('so')),
      doNumbers: list(c.req.query('do')),
      jobKeys: list(c.req.query('jobs')),
    });
    return c.json({ issues });
  } catch (e) {
    return c.json({ error: 'load_failed', reason: (e as Error).message }, 500);
  }
});
