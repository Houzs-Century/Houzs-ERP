// ----------------------------------------------------------------------------
// venture-portal-attendance — the SENDER for the ERP -> Venture Portal SALES
// ATTENDING push: who the PMS lists at each project (a brand's booth at a
// fair), so the portal scores each salesperson's Fair result at the booth they
// were sent to, and pays outstation claims for it, instead of asking them to
// pick one or guessing it from their bills.
//
// THE BODY IS BUILT IN SQL (scm.vp_build_attendance, migration
// *_scm_vp_sales_attending.sql): one company's projects from `since` on, with
// or without anybody listed, each listed rep with the scm.staff id of its login.
// The portal retires any of its booths from `since` on that a delivery does not
// list, so the body is always the whole window, never a change set.
//
// GATED AND ANSWERED EXACTLY LIKE THE CATALOGUE, with its helpers: the switch
// and its company scope, vp.url and vp.secret, the digest decision, the
// response verdict and the state row. The receiver is vp.url's sibling:
// .../sales-orders -> .../sales-attending. A vp.url of any other shape is NOT
// guessed at; nothing is sent and the status page says why.
//
// ONE POST per company: the body is ~140 KB, far under the portal's 4.5 MB
// limit, so there is nothing to split.
//
// LIVE. A statement trigger on public.projects, public.project_sales_attendees
// and public.sales_reps marks scm.venture_portal_attendance_changes in the same
// transaction as the edit; the write kick (mounted on /api/scm/* and
// /api/projects/*) runs pushVenturePortalAttendanceOnChange after the order
// drain and the catalogue, so a Sales Attending edit reaches the portal in
// seconds. The */5 cron runs the same push and stays the safety net.
// ----------------------------------------------------------------------------

import type { Env } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { readFeedScope } from './venture-portal-feed-flag';
import { readVpConfig } from './venture-portal-outbox';
import {
  companiesFor,
  inScope,
  portalAnswer,
  postPart,
  vpCatalogueDecision,
  vpCatalogueVerdict,
  vpPushStateRow,
  vpSiblingUrl,
  type ScmClient,
  type VpCatalogueOutcome,
  type VpCatalogueState,
} from './venture-portal-catalogue';

/** Why vpAttendanceUrl answered null — one sentence for the log and the page. */
export const VP_ATTENDANCE_URL_PROBLEM =
  'vp.url is not an https URL ending in /sales-orders, so the /sales-attending receiver cannot be derived';

/** The Sales Attending receiver: the order feed's vp.url with /sales-orders → /sales-attending. */
export function vpAttendanceUrl(salesOrdersUrl: string): string | null {
  return vpSiblingUrl(salesOrdersUrl, 'sales-attending');
}

export type VpAttendanceCompanyResult = {
  companyId: number;
  /** unchanged / refused_unchanged: nothing was sent. build_failed: the SQL did
   *  not answer, nothing was sent, next run tries again. */
  action: 'unchanged' | 'refused_unchanged' | 'build_failed' | VpCatalogueOutcome;
  digest: string | null;
  bytes: number;
  httpStatus: number | null;
  note: string | null;
};

export type VpAttendanceSummary = { skipped?: string; companies: VpAttendanceCompanyResult[] };

/** How many marks one run clears. A burst beyond it is cleared by the next run. */
export const VP_ATTENDANCE_CHANGES_BATCH = 1_000;

/**
 * Clear the change marks this run covers — FIRST, in every push, so a mark
 * written while the run builds survives it and earns the next one. A failure
 * is logged and ignored: a mark left behind costs one more digest.
 */
async function clearAttendanceChanges(sb: ScmClient): Promise<void> {
  const { data, error } = await sb
    .from('venture_portal_attendance_changes')
    .select('id')
    .order('id', { ascending: true })
    .limit(VP_ATTENDANCE_CHANGES_BATCH);
  if (error) {
    console.error('[vp-attendance] could not read the change marks', error.message);
    return;
  }
  const ids = ((data as Array<{ id: number | string }> | null) ?? []).map((r) => r.id);
  if (!ids.length) return;
  const { error: delErr } = await sb.from('venture_portal_attendance_changes').delete().in('id', ids);
  if (delErr) console.error('[vp-attendance] could not clear the change marks', delErr.message);
}

/**
 * The kick's step after the catalogue: send the list if a Sales Attending
 * table changed. While the feed is off it costs the one cached flag read the
 * drain already made; with no mark, one read of an empty table.
 */
export async function pushVenturePortalAttendanceOnChange(
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<VpAttendanceSummary> {
  const sb = getSupabaseService(env);
  if ((await readFeedScope(sb)) === 'off') return { skipped: 'feed_off', companies: [] };
  const { data, error } = await sb.from('venture_portal_attendance_changes').select('id').limit(1);
  if (error) return { skipped: 'changes_read_failed', companies: [] };
  if (!(data as unknown[] | null)?.length) return { skipped: 'unchanged', companies: [] };
  return pushVenturePortalAttendance(env, { force: false }, fetchImpl);
}

/**
 * Send each in-scope company's Sales Attending if it changed since the portal
 * last accepted it — or regardless, when `force`.
 *
 * Never throws for a delivery problem: every answer is recorded on the
 * company's state row and returned. A failed read aborts BEFORE anything is
 * sent, because not knowing what was delivered is not a reason to send.
 */
export async function pushVenturePortalAttendance(
  env: Env,
  opts: { force: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<VpAttendanceSummary> {
  const sb = getSupabaseService(env);

  await clearAttendanceChanges(sb);

  const scope = await readFeedScope(sb);
  if (scope === 'off') return { skipped: 'feed_off', companies: [] };

  const cfg = await readVpConfig(sb);
  if (!cfg) return { skipped: 'not_configured', companies: [] };

  const url = vpAttendanceUrl(cfg.url);
  if (!url) {
    /* [vp-attendance] is the string to alert on. The status page shows the
       same fact (attendance.url is null). */
    console.error(`[vp-attendance] ${VP_ATTENDANCE_URL_PROBLEM}; nothing sent`);
    return { skipped: 'attendance_url_unknown', companies: [] };
  }

  const companies = await companiesFor(sb, scope);
  if (companies === null) return { skipped: 'companies_read_failed', companies: [] };
  if (!companies.length) return { companies: [] };

  const { data: stateData, error: stateErr } = await sb
    .from('venture_portal_attendance_state')
    .select('company_id, delivered_digest, last_digest, last_outcome')
    .in('company_id', companies);
  if (stateErr) return { skipped: 'state_read_failed', companies: [] };
  const stateByCompany = new Map<number, VpCatalogueState>(
    ((stateData as (VpCatalogueState & { company_id: number | string })[] | null) ?? [])
      .map((r) => [Number(r.company_id), r]),
  );

  const results: VpAttendanceCompanyResult[] = [];
  for (const companyId of companies) {
    /* Re-read per company (cached 30 s): off must stop the next delivery, not
       finish the round. */
    if (!inScope(await readFeedScope(sb), companyId)) break;

    const result: VpAttendanceCompanyResult = {
      companyId, action: 'build_failed', digest: null, bytes: 0, httpStatus: null, note: null,
    };
    results.push(result);

    if (!opts.force) {
      const { data: digest, error } = await sb.rpc('vp_attendance_digest', { p_company_id: companyId });
      if (error || typeof digest !== 'string' || !digest) {
        result.note = `the Sales Attending digest could not be computed: ${error?.message ?? 'no answer'}`;
        continue;
      }
      result.digest = digest;
      const decision = vpCatalogueDecision(digest, stateByCompany.get(companyId) ?? null, false);
      if (decision !== 'send') {
        result.action = decision;
        continue;
      }
    }

    /* The body AND its digest from one build, so the digest recorded below
       describes the list that was sent even if it changed since the digest
       was asked for above. */
    const { data: snap, error: snapErr } = await sb.rpc('vp_attendance_snapshot', { p_company_id: companyId });
    const snapshot = snap as { digest?: unknown; body?: unknown } | null;
    if (
      snapErr
      || typeof snapshot?.digest !== 'string'
      || snapshot.body === null
      || typeof snapshot.body !== 'object'
      || Array.isArray(snapshot.body)
    ) {
      result.note = `the Sales Attending list could not be built: ${snapErr?.message ?? 'no answer'}`;
      continue;
    }
    const digest = snapshot.digest;
    result.digest = digest;

    const body = JSON.stringify(snapshot.body);
    result.bytes = new TextEncoder().encode(body).length;

    const res = await postPart(url, cfg.secret, body, fetchImpl);
    const verdict = vpCatalogueVerdict([res.status], 1);
    const failureText = res.status >= 200 && res.status <= 299 ? '' : res.transportError ?? res.text.slice(0, 300);
    const now = new Date().toISOString();
    result.action = verdict.outcome;
    result.httpStatus = res.status;
    result.note = verdict.outcome === 'sent' ? null : `${verdict.note}${failureText ? ` — ${failureText}` : ''}`;

    const row = vpPushStateRow({
      companyId, digest, verdict, httpStatus: result.httpStatus, note: result.note,
      bytes: result.bytes, parts: null, portalResult: portalAnswer(res.text), now,
    });
    /* A lost write leaves the previous record in place, so the next run sees a
       digest it never recorded as delivered and normally sends again. */
    const { error: writeErr } = await sb
      .from('venture_portal_attendance_state')
      .upsert(row, { onConflict: 'company_id' });
    if (writeErr) {
      console.error('[vp-attendance] could not record the delivery state', companyId, writeErr.message);
      result.note = `${result.note ? `${result.note}; ` : ''}state not recorded: ${writeErr.message}`;
    }
  }

  return { companies: results };
}
