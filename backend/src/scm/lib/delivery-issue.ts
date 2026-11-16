/* "Delivered with issue" — the crew reports a problem at POD (damaged, missing
   part, wrong item or colour, customer refused part, other), with photos. The
   delivery itself is NOT blocked: the DO / job is still recorded delivered; this
   adds a scm.delivery_issues row with the crew's photos kept on the POD.

   Owner 2026-11-16: the crew no longer opens the Service Case — the OFFICE does,
   from the DO / SO screen. So reportDeliveryIssue only records the report (no
   case, no service-case permission); createCaseForDeliveryIssue is the office
   action that opens the case and files the POD photos onto it.

   The report routes (scm/routes/delivery-issues.ts) prove WHO may report on
   WHICH delivery (company scope + the crew's own job); the office create is
   gated on the service-case create gate where it is mounted (routes/assr.ts).
   This file does the work once that is proven. */
import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { scopeToAllowedCompanies, activeCompanyId, type CompanyScopeCtx } from './companyScope';
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


type Res<T> = { data: T | null; error: { message: string } | null };

/* Records the crew's report. Claims the photos (which promotes the pending
   slip uploads so the reaper leaves the R2 objects alone — so the photos
   persist on the POD / DO even though no case holds them yet) and inserts one
   scm.delivery_issues row. It does NOT open a Service Case and needs no
   service-case permission: the office opens the case later from the DO / SO
   screen (createCaseForDeliveryIssue). */
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
  }).select('*').single()) as Res<DeliveryIssueRow>;
  if (insErr || !insertedRow) return { ok: false, status: 500, error: 'save_failed', reason: insErr ? insErr.message : 'The issue was not saved.' };
  return { ok: true, issue: insertedRow };
}

/** The office context for createCaseForDeliveryIssue: company scope + env. The
 *  caller passes the supabase client and the actor explicitly, so this works
 *  from the ASSR router (getSupabaseService, no c.get('supabase')) as well as
 *  from an scm route. */
export type DeliveryIssueCaseCtx = CompanyScopeCtx & { env: Env };

/* The OFFICE opens the Service Case from a crew delivery report (owner
   2026-11-16). The crew's photos already live on the POD
   (delivery_issues.photo_keys, kept alive by claimPodPhotos' promote); this
   reads them back and files them on the new case. It runs the four steps the
   old crew auto-path ran — create the case, file the photos, link the report
   row, notify the PIC — and deliberately NOTHING MORE: the customer "case
   received" WhatsApp the generic POST /api/assr sends is not part of this, the
   auto-path never sent one, and the office must not spring a new customer
   message by moving the create here.
     The report row already exists, so order is simpler than the old insert-
   then-create: a failed createAssrCase leaves the report unlinked for a clean
   retry; a create that then fails to link reports the case number so the office
   does not open a second one. */
export async function createCaseForDeliveryIssue(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client, untyped like every route helper
  sb: any,
  c: DeliveryIssueCaseCtx,
  issueId: string,
  actorUserId: number | null,
): Promise<
  | { ok: true; caseId: number; assrNo: string; issue: DeliveryIssueRow }
  | { ok: false; status: 404 | 409 | 500; error: string; reason: string }
> {
  const { data: row, error: loadErr } = (await scopeToAllowedCompanies(
    sb.from('delivery_issues').select('*').eq('id', issueId),
    c,
  ).maybeSingle()) as Res<DeliveryIssueRow>;
  if (loadErr) return { ok: false, status: 500, error: 'load_failed', reason: loadErr.message };
  if (!row) return { ok: false, status: 404, error: 'not_found', reason: 'This delivery report could not be found.' };
  if (row.assr_case_id != null) {
    return { ok: false, status: 409, error: 'already_linked',
      reason: `A service case${row.assr_no ? ` (${row.assr_no})` : ''} was already opened for this report.` };
  }

  // Reconstruct the case document and the complaint "where" from the stored row
  // (the report route's own target is long gone by now). A DO / assr-leg report
  // carries the SO / DO; a project / DP job report has only its source id.
  const caseDocNo = row.so_doc_no || row.do_number || row.source_id || '';
  const where = row.delivery_order_id
    ? ([row.do_number, row.so_doc_no ? `(SO ${row.so_doc_no})` : null].filter(Boolean).join(' ') || 'a delivery order')
    : `${row.leg ?? 'delivery'} job ${row.source_id ?? ''}${row.so_doc_no ? ` (SO ${row.so_doc_no})` : ''}`.trim();

  // The crew member who reported it — a best-effort name for the complaint text.
  let reporterName: string | null = null;
  if (row.reported_by != null) {
    try {
      const u = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?')
        .bind(row.reported_by).first<{ name: string | null }>();
      reporterName = u?.name ?? null;
    } catch { /* the name is optional in the complaint */ }
  }

  let assr: { id: number; assr_no: string };
  try {
    assr = await createAssrCase(c.env, {
      doc_no: caseDocNo,
      items: [],
      complaint_issue: deliveryIssueComplaint(where, row.kinds, row.note, reporterName),
      issue_category: DELIVERY_ISSUE_CATEGORY,
      delivery_order: row.do_number,
      created_by: actorUserId ?? undefined,
      // The SO's own company wins inside createAssrCase; this is the fallback
      // for a job whose document is not an order (a project, a DP job).
      company_id: row.company_id ?? undefined,
    });
  } catch (e) {
    return { ok: false, status: 500, error: 'case_failed',
      reason: `The service case could not be opened: ${(e as Error).message}. The report is still here; try again.` };
  }

  // The crew's POD photos, filed on the case as complaint photos.
  try {
    for (const key of row.photo_keys) await saveAttachment(c.env, assr.id, key, null, 'image/jpeg', 'complaint', actorUserId);
    if (row.photo_keys.length) {
      await logActivity(c.env, assr.id, 'attachment_added', null, 'Delivery issue',
        `Delivery crew's ${row.photo_keys.length} POD photo${row.photo_keys.length === 1 ? '' : 's'} filed on the case`, actorUserId,
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
      reason: `Service case ${assr.assr_no} was opened, but the delivery report was not linked to it. Note the case number; do not create it again.` };
  }

  // The case's PIC hears about it like any new case (best-effort, never throws).
  try {
    const picRow = await c.env.DB.prepare(
      'SELECT assigned_to, assigned_to_2, sales_agent, customer_name FROM assr_cases WHERE id = ?',
    ).bind(assr.id).first<{ assigned_to: number | null; assigned_to_2: number | null; sales_agent: string | null; customer_name: string | null }>();
    if (picRow) {
      await notifyServiceCaseResponsible(c.env, {
        reason: 'created', assrNo: assr.assr_no, customerName: picRow.customer_name,
        userIds: [picRow.assigned_to, picRow.assigned_to_2], agentNames: [picRow.sales_agent],
      });
    }
  } catch (e) {
    console.warn(`[delivery-issue] notify failed for ${assr.assr_no}:`, (e as Error).message);
  }

  return { ok: true, caseId: assr.id, assrNo: assr.assr_no, issue: linked as DeliveryIssueRow };
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
