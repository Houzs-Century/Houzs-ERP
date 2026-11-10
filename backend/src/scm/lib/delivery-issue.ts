/* "Delivered with issue" — the crew reports a problem at POD (damaged, missing
   part, wrong item or colour, customer refused part, other), with photos. The
   delivery itself is NOT blocked: the DO / job is still recorded delivered; this
   adds a scm.delivery_issues row and opens an After-Sales Service case linked to
   the SO and the DO, with the photos on the case.

   The routes (scm/routes/delivery-issues.ts) prove WHO may report on WHICH
   delivery (company scope + the crew's own job); this file does the work once
   that is proven. */
import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { scopeToAllowedCompanies, activeCompanyId } from './companyScope';
import { claimPodPhotos, doStopContext, jobStopContext } from './pod-photo-claim';
import { createAssrCase, saveAttachment, logActivity } from '../../services/assr';
import { notifyServiceCaseResponsible } from '../../services/assrNotify';
import { JOB_SOURCE_TYPES } from '../routes/delivery-job-progress';
import {
  DELIVERY_ISSUE_KINDS, DELIVERY_ISSUE_MAX_PHOTOS, DELIVERY_ISSUE_NOTE_MAX,
  deliveryIssueKindLabel, type DeliveryIssueKind,
} from '../shared/delivery-issue-kinds';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/* The Service Case's issue category for every crew-reported delivery problem,
   so the office can filter them in Service Cases. */
export const DELIVERY_ISSUE_CATEGORY = 'Delivery issue';

export type ParsedDeliveryIssue = { kinds: DeliveryIssueKind[]; note: string | null; photoKeys: unknown[] };

/** Validates the crew's report. At least one kind; "Other" needs a note. */
export function parseDeliveryIssueBody(body: unknown):
  | { ok: true; value: ParsedDeliveryIssue }
  | { ok: false; error: string; reason: string } {
  const b = (body && typeof body === 'object' ? body : {}) as { kinds?: unknown; note?: unknown; photoKeys?: unknown };
  const allowed = new Set<string>(DELIVERY_ISSUE_KINDS.map((k) => k.value));
  const raw = Array.isArray(b.kinds) ? b.kinds : [];
  if (raw.some((k) => typeof k !== 'string' || !allowed.has(k)))
    return { ok: false, error: 'invalid_kind', reason: 'Unknown problem type. Refresh the app and try again.' };
  const kinds = DELIVERY_ISSUE_KINDS.map((k) => k.value).filter((v) => raw.includes(v));
  if (!kinds.length) return { ok: false, error: 'kind_required', reason: 'Tick at least one problem.' };
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, DELIVERY_ISSUE_NOTE_MAX) : null;
  if (kinds.includes('other') && !note) return { ok: false, error: 'note_required', reason: 'Describe the problem when you tick "Other".' };
  const photoKeys = Array.isArray(b.photoKeys) ? b.photoKeys : [];
  if (photoKeys.length > DELIVERY_ISSUE_MAX_PHOTOS)
    return { ok: false, error: 'too_many_photos', reason: `At most ${DELIVERY_ISSUE_MAX_PHOTOS} photos per report.` };
  return { ok: true, value: { kinds, note, photoKeys } };
}

/** The Service Case's complaint text. */
export function deliveryIssueComplaint(where: string, kinds: readonly string[], note: string | null, reporter: string | null): string {
  const lines = [
    `Reported by the delivery crew${reporter ? ` (${reporter})` : ''} at proof of delivery, ${where}.`,
    `Problem: ${kinds.map(deliveryIssueKindLabel).join(', ')}.`,
  ];
  if (note) lines.push(`Crew note: ${note}`);
  lines.push('The delivery was recorded as delivered with this issue.');
  return lines.join('\n');
}

export type DeliveryIssueTarget = {
  /** The delivery's own company (DO / job row) — the issue row's company. */
  companyId: number | null;
  deliveryOrderId: string | null;
  doNumber: string | null;
  soDocNo: string | null;
  job: { sourceType: 'dp' | 'project' | 'assr'; sourceId: string; leg: string } | null;
  /** The document the Service Case is raised against (the SO, else the job's own document). */
  caseDocNo: string;
  /** "DO-2410-0001 (SO HC-SO-001234)" — for the complaint text. */
  where: string;
};

export type DeliveryIssueRow = {
  id: string;
  company_id: number | null;
  delivery_order_id: string | null;
  do_number: string | null;
  so_doc_no: string | null;
  source_type: string | null;
  source_id: string | null;
  leg: string | null;
  kinds: string[];
  note: string | null;
  photo_keys: string[];
  assr_case_id: number | null;
  assr_no: string | null;
  reported_by: number | null;
  reported_at: string;
};


/* Records the issue and opens the Service Case. Order matters so a failure is
   retryable without a duplicate case: the issue row goes in first (no case yet);
   a failed case create deletes it again; only then is the case linked. */
export async function reportDeliveryIssue(c: Ctx, target: DeliveryIssueTarget, issue: ParsedDeliveryIssue):
  Promise<{ ok: true; issue: DeliveryIssueRow } | { ok: false; status: 400 | 500; error: string; reason: string }> {
  const sb = c.get('supabase');
  const me = Number(c.get('houzsUser')?.id) || null;

  // The route admitted the caller to this stop, so a crew member's photo for it is accepted too.
  const stopContext = target.job ? jobStopContext(target.job) : target.deliveryOrderId ? doStopContext(target.deliveryOrderId) : null;
  const claim = await claimPodPhotos(sb, c, { houzsUserId: me, stopContext }, issue.photoKeys);
  if (!claim.ok) return { ok: false, status: 400, error: 'photo_not_accepted', reason: claim.reason };
  const photoKeys = claim.keys;
  // A project / case with no company still gets one (the caller's), so the
  // company-scoped reads below and on the office screens can find the row.
  const companyId = target.companyId ?? activeCompanyId(c) ?? null;

  type Res<T> = { data: T | null; error: { message: string } | null };
  const { data: insertedRow, error: insErr } = (await sb.from('delivery_issues').insert({
    company_id: companyId,
    delivery_order_id: target.deliveryOrderId,
    do_number: target.doNumber,
    so_doc_no: target.soDocNo,
    source_type: target.job?.sourceType ?? null,
    source_id: target.job?.sourceId ?? null,
    leg: target.job?.leg ?? null,
    kinds: issue.kinds,
    note: issue.note,
    photo_keys: photoKeys,
    reported_by: me,
  }).select('id').single()) as Res<{ id: string }>;
  if (insErr || !insertedRow) return { ok: false, status: 500, error: 'save_failed', reason: insErr ? insErr.message : 'The issue was not saved.' };
  const issueId = insertedRow.id;

  let assr: { id: number; assr_no: string };
  try {
    assr = await createAssrCase(c.env, {
      doc_no: target.caseDocNo,
      items: [],
      complaint_issue: deliveryIssueComplaint(target.where, issue.kinds, issue.note, c.get('houzsUser')?.name ?? null),
      issue_category: DELIVERY_ISSUE_CATEGORY,
      delivery_order: target.doNumber,
      created_by: me ?? undefined,
      // The SO's own company wins inside createAssrCase; this is the fallback
      // for a job whose document is not an order (a project, a DP job).
      company_id: companyId ?? undefined,
    });
  } catch (e) {
    // company-scope: the row this request inserted a moment ago, by its own id
    await scopeToAllowedCompanies(sb.from('delivery_issues').delete().eq('id', issueId), c);
    return { ok: false, status: 500, error: 'case_failed', reason: `The service case could not be opened: ${(e as Error).message}. Nothing was saved; try again.` };
  }

  // Photos on the case (complaint photos: what the office and the next crew see).
  try {
    for (const key of photoKeys) await saveAttachment(c.env, assr.id, key, null, 'image/jpeg', 'complaint', me);
    if (photoKeys.length) {
      await logActivity(c.env, assr.id, 'attachment_added', null, 'Delivery issue',
        `Delivery crew added ${photoKeys.length} photo${photoKeys.length === 1 ? '' : 's'} at POD`, me,
        { category: 'service', source_channel: 'app' });
    }
  } catch (e) {
    console.warn(`[delivery-issue] photos not filed on ${assr.assr_no}:`, (e as Error).message);
  }

  const { data: linked, error: linkErr } = await scopeToAllowedCompanies(
    sb.from('delivery_issues').update({ assr_case_id: assr.id, assr_no: assr.assr_no }).eq('id', issueId),
    c,
  ).select('*').single();
  if (linkErr || !linked) {
    return { ok: false, status: 500, error: 'link_failed',
      reason: `Service case ${assr.assr_no} was opened, but the delivery was not linked to it. Tell the office the case number; do not report again.` };
  }

  // The case's PIC hears about it like any new case (best-effort, never throws).
  try {
    // company-scope: the case this request just created, by its own id
    const row = await c.env.DB.prepare(
      `SELECT assigned_to, assigned_to_2, sales_agent, customer_name FROM assr_cases WHERE id = ?`,
    ).bind(assr.id).first<{ assigned_to: number | null; assigned_to_2: number | null; sales_agent: string | null; customer_name: string | null }>();
    if (row) {
      await notifyServiceCaseResponsible(c.env, {
        reason: 'created', assrNo: assr.assr_no, customerName: row.customer_name,
        userIds: [row.assigned_to, row.assigned_to_2], agentNames: [row.sales_agent],
      });
    }
  } catch (e) {
    console.warn(`[delivery-issue] notify failed for ${assr.assr_no}:`, (e as Error).message);
  }

  return { ok: true, issue: linked as DeliveryIssueRow };
}

export type DeliveryIssueFilter = {
  deliveryOrderIds?: string[];
  doNumbers?: string[];
  soDocNos?: string[];
  /** "assr:12:delivery" style job keys. */
  jobKeys?: string[];
};

const MAX_FILTER_VALUES = 300;

/** The issues matching ANY of the filter's keys, newest first, inside the
 *  caller's allowed companies. An empty filter returns nothing. */
export async function listDeliveryIssues(c: Ctx, f: DeliveryIssueFilter): Promise<DeliveryIssueRow[]> {
  const clean = (xs: string[] | undefined) => [...new Set((xs ?? []).map((x) => x.trim()).filter(Boolean))].slice(0, MAX_FILTER_VALUES);
  const ids = clean(f.deliveryOrderIds).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  const dos = clean(f.doNumbers);
  const sos = clean(f.soDocNos);
  const jobs = clean(f.jobKeys).map((k) => k.split(':')).filter((p) => p.length === 3 && (JOB_SOURCE_TYPES as readonly string[]).includes(p[0]!));
  // PostgREST or() values: quote each one so a comma or a dot in a doc number is data.
  const q = (v: string) => `"${v.replace(/["\\]/g, '')}"`;
  const arms: string[] = [];
  if (ids.length) arms.push(`delivery_order_id.in.(${ids.join(',')})`);
  if (dos.length) arms.push(`do_number.in.(${dos.map(q).join(',')})`);
  if (sos.length) arms.push(`so_doc_no.in.(${sos.map(q).join(',')})`);
  for (const [t, id, leg] of jobs) arms.push(`and(source_type.eq.${t},source_id.eq.${q(id!)},leg.eq.${q(leg!)})`);
  if (!arms.length) return [];
  const { data, error } = (await scopeToAllowedCompanies(
    c.get('supabase').from('delivery_issues').select('*').or(arms.join(',')),
    c,
  ).order('reported_at', { ascending: false }).limit(500)) as { data: DeliveryIssueRow[] | null; error: { message: string } | null };
  if (error) throw new Error(error.message);
  return data ?? [];
}
