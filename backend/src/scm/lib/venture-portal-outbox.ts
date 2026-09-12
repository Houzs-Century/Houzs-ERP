// ----------------------------------------------------------------------------
// venture-portal-outbox — the SENDER for the ERP -> Venture Portal live
// sales-order feed. Queue and snapshot builder are migration 20260912T1800.
//
// WHAT THE PORTAL DOES WITH THIS. It pays Revenue Department commission out of
// our sales orders. Until now that was a monthly xlsx somebody exported and
// imported. Each delivery here carries one order's header, every line with its
// COST (line_cost_sen — the input its margin layer was waiting for), every
// payment, and the salesperson behind it. A cancellation travels as a status
// change or as {deleted:true}; the portal excludes it and stops paying on it.
//
// WHY THE WORKER AND NOT pg_cron/pg_net. The portal's hand-off contract
// specifies pg_cron every 10s and pg_net for the POST. Neither extension is
// installed on production — measured 2026-09-12, see the migration header for
// the query and its NULL. The migration header also says why installing them
// is the wrong trade for this repo: a pg_cron job is invisible to every gate
// here. This runs in the */5 cron beside two outboxes that already work.
//
// THREE OFF SWITCHES, and the feed is dark until all three are set:
//   1. scm.app_config 'scm.venture_portal_feed' — seeded 'off'
//      (venture-portal-feed-flag.ts). This carries the COMPANY SCOPE too.
//   2. scm.sync_config 'vp.url'    — no receiver, nothing is sent.
//   3. scm.sync_config 'vp.secret' — the portal answers 503 without it anyway.
// `vp.since` is a date floor: orders dated before it are never sent, so
// enabling the feed cannot leak years of history into somebody's commission.
//
// The company scope lives ONLY in the app_config flag. The contract put it in a
// second place (a vp.companies config row) and this deliberately does not: two
// places that both decide who gets delivered is how a company nobody enabled
// ends up in an external system.
// ----------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { isFeedEnabled, readFeedScope, type FeedScope } from './venture-portal-feed-flag';

/* The SCM PostgREST client is untyped at every call site in this tree; a typed
   signature here would describe a contract nothing else keeps. Named once so
   the three `any`s live in one place rather than on every function. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
type ScmClient = SupabaseClient<any, any, any>;

/** Per-sweep cap. 25 matches amendment-command's drain and keeps the sweep well
 *  inside the Worker subrequest diet CLAUDE.md holds this repo to: one POST per
 *  document plus ONE rpc for the whole batch. */
export const VP_DRAIN_BATCH = 25;

/** Attempts before a row is parked as `failed` for a human to look at.
 *
 *  THE CONTRACT SAYS RETRY FOREVER. This does not, and the difference is
 *  deliberate: the contract's own table says a 422 "will not fix itself", so
 *  retrying one every five minutes until the heat death of the universe buys
 *  nothing and hides it. A parked row is visible on the admin page; an
 *  eternally-pending one is indistinguishable from a queue that is merely busy.
 *  Config refusals (401/503) do NOT consume an attempt — see classifyResponse. */
export const VP_MAX_ATTEMPTS = 6;

/** How long a delivery may take before we treat it as failed and retry. */
const VP_TIMEOUT_MS = 10_000;

/**
 * The states an outbox row may be in — the migration's CHECK constraint, in
 * TypeScript, once.
 *
 * ONE HOME, because it had three: this list, the status-counts loop in the route
 * and the `/rows` filter validation all spelled it by hand until
 * check-duplicated-decisions caught it. The SQL CHECK is unavoidably a fourth
 * spelling; nothing can import into a migration.
 *
 * The vocabulary is scm.autocount_outbox's ON PURPOSE so this system has one
 * dialect for "where is my outbox row" — but it is NOT the same list. That
 * outbox may grow a fifth state for a reason that has nothing to do with this
 * feed, and inheriting it would be the bug the duplicated-decision gate exists
 * to find.
 */
export const VP_ROW_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;

/** The scm.sync_config keys this feed reads. One home, for VP_ROW_STATUSES'
 *  reason — the route listed them a second time to render them. */
export const VP_CONFIG_KEYS = ['vp.url', 'vp.secret', 'vp.since'] as const;

export type VpConfig = { url: string; secret: string; since: string | null };

export type VpDrainSummary = {
  skipped?: string;
  processed: number;
  sent: number;
  failed: number;
  retried: number;
  outOfScope: number;
};

type VpOutboxRow = {
  id: string;
  doc_no: string;
  op: string;
  attempts: number;
};

type VpPayload = {
  docNo: string;
  deleted: boolean;
  snapshotAt: string;
  header?: Record<string, unknown> | null;
  items?: unknown[];
  payments?: unknown[];
  salesperson?: unknown;
};

/**
 * The receiver URL, the shared secret and the date floor.
 *
 * Returns null when the feed is not wired up yet, which is the normal state
 * before somebody fills the admin page in — never an error.
 */
export async function readVpConfig(
  sb: ScmClient,
): Promise<VpConfig | null> {
  const { data, error } = await sb
    .from('sync_config')
    .select('k, v')
    .in('k', VP_CONFIG_KEYS as unknown as string[]);
  if (error) return null;
  /* The `| null` in the cast is not decoration. supabase-js types `data` as
     non-nullable, so without it the linter calls the `?? []` redundant and the
     guard gets deleted — while PostgREST really does answer null. This repo has
     a dozen of those findings in its money routes for exactly this reason;
     correcting the type is better than silencing the check. */
  const rows = (data as { k: string; v: string }[] | null) ?? [];
  const at = (k: string) => rows.find((r) => r.k === k)?.v.trim() || '';
  const url = at('vp.url');
  const secret = at('vp.secret');
  if (!url || !secret) return null;
  return { url, secret, since: at('vp.since') || null };
}

/**
 * What the portal's answer means for the row.
 *
 * `attempt` says whether this outcome is the DOCUMENT's fault. A missing secret
 * is ours, and must not burn the row's six attempts while somebody is still
 * filling in the config — otherwise enabling the feed a week late would find
 * every queued order already parked as failed.
 */
export function classifyVpResponse(status: number): {
  outcome: 'sent' | 'failed' | 'retry';
  attempt: boolean;
  note: string;
} {
  if (status >= 200 && status <= 299) {
    return { outcome: 'sent', attempt: true, note: '' };
  }
  if (status === 401) {
    return { outcome: 'retry', attempt: false, note: 'http 401 — wrong or missing shared secret; fix the secret on the feed settings page' };
  }
  if (status === 503) {
    return { outcome: 'retry', attempt: false, note: 'http 503 — the portal has no ERP_SYNC_SECRET set yet; nothing to fix on our side' };
  }
  if (status === 400 || status === 422) {
    /* The portal could not READ the delivery. Retrying sends the same bytes, so
       this is parked at once rather than six times. */
    return { outcome: 'failed', attempt: true, note: `http ${status} — the portal could not read this delivery; a person must look` };
  }
  return { outcome: 'retry', attempt: true, note: `http ${status}` };
}

/** The portal's own word for what it did, when it gave us one. A 200 whose
 *  outcome is `held` or `stale` is a SUCCESSFUL delivery the portal chose not to
 *  apply, and the contract warns twice against conflating the two. */
function readPortalOutcome(body: string): string | null {
  try {
    const j = JSON.parse(body) as { outcome?: unknown; result?: unknown };
    const v = j.outcome ?? j.result;
    return typeof v === 'string' && v.length <= 40 ? v : null;
  } catch {
    return null;
  }
}

function inScope(scope: FeedScope, companyId: number | null): boolean {
  if (scope === 'off') return false;
  if (scope === 'all') return true;
  if (companyId == null) return false;
  return scope.includes(Number(companyId));
}

/**
 * Send every pending delivery, oldest first.
 *
 * `limit` is explicit rather than defaulted at the call sites that matter: the
 * cron uses the batch constant, the admin page's "send now" passes its own.
 */
export async function drainVenturePortalOutbox(
  env: Env,
  limit: number = VP_DRAIN_BATCH,
  fetchImpl: typeof fetch = fetch,
): Promise<VpDrainSummary> {
  const zero = { processed: 0, sent: 0, failed: 0, retried: 0, outOfScope: 0 };
  const sb = getSupabaseService(env);

  const scope = await readFeedScope(sb);
  if (scope === 'off') return { skipped: 'feed_off', ...zero };

  const cfg = await readVpConfig(sb);
  if (!cfg) return { skipped: 'not_configured', ...zero };

  const { data, error } = await sb
    .from('venture_portal_outbox')
    .select('id, doc_no, op, attempts')
    .eq('status', 'pending')
    .lt('attempts', VP_MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) return { skipped: 'query_failed', ...zero };

  const rows = (data as VpOutboxRow[] | null) ?? [];
  if (!rows.length) return { ...zero };

  /* SCOPE FIRST, and from the order itself. A document whose company is not
     enabled, or which predates vp.since, is marked skipped WITHOUT a request,
     so the queue never fills with orders the portal does not want. A row whose
     order no longer exists is NOT out of scope — it is a deletion, and the
     portal needs it to stop paying commission on a cancelled sale. */
  const docNos = rows.map((r) => r.doc_no);
  const { data: soData } = await sb
    .from('mfg_sales_orders')
    .select('doc_no, company_id, so_date')
    .in('doc_no', docNos);
  const soByDoc = new Map<string, { company_id: number | null; so_date: string | null }>(
    ((soData ?? []) as { doc_no: string; company_id: number | null; so_date: string | null }[])
      .map((s) => [s.doc_no, { company_id: s.company_id, so_date: s.so_date }]),
  );

  const summary = { ...zero };
  const deliverable: VpOutboxRow[] = [];
  for (const row of rows) {
    const so = soByDoc.get(row.doc_no);
    if (so) {
      const tooOld = cfg.since != null && so.so_date != null && so.so_date < cfg.since;
      if (!inScope(scope, so.company_id) || tooOld) {
        await sb
          .from('venture_portal_outbox')
          .update({
            status: 'skipped',
            last_error: tooOld ? `dated before vp.since (${cfg.since})` : 'company not enabled for the feed',
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id);
        summary.outOfScope += 1;
        continue;
      }
    }
    deliverable.push(row);
  }
  if (!deliverable.length) return summary;

  /* ONE round trip for every payload in the sweep (see the migration's note on
     the subrequest diet). Built at SEND time, so a retry carries current state
     and five edits to one order collapse into one delivery. */
  const { data: built, error: buildErr } = await sb.rpc('vp_build_payloads', {
    p_doc_nos: deliverable.map((r) => r.doc_no),
  });
  if (buildErr || !built) {
    return { skipped: 'payload_build_failed', ...summary };
  }
  const payloadByDoc = new Map<string, VpPayload>(
    (built as VpPayload[]).map((p) => [p.docNo, p]),
  );

  for (const row of deliverable) {
    const payload = payloadByDoc.get(row.doc_no);
    if (!payload) {
      /* The builder answered for every other document but not this one. That is
         a contradiction, not a delivery problem, so it is recorded and left
         pending rather than sent as something invented here. */
      await markRetry(sb, row, 'the snapshot builder returned no payload for this document', true);
      summary.processed += 1;
      summary.retried += 1;
      continue;
    }

    /* Re-checked per row, not once per sweep: somebody may turn the feed off
       mid-sweep, and off must stop the next delivery rather than finish the
       batch. Off leaves the row pending — it is not a failure. */
    const so = soByDoc.get(row.doc_no);
    if (so && !(await isFeedEnabled(sb, so.company_id))) break;

    summary.processed += 1;
    const result = await deliverOne(cfg, payload, fetchImpl);
    const verdict = classifyVpResponse(result.status);

    if (verdict.outcome === 'sent') {
      await sb
        .from('venture_portal_outbox')
        .update({
          status: 'sent',
          attempts: row.attempts + 1,
          last_error: null,
          portal_outcome: result.outcome,
          sent_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      summary.sent += 1;
      continue;
    }

    const note = result.transportError ? `${verdict.note} ${result.transportError}`.trim() : verdict.note;
    if (verdict.outcome === 'failed') {
      await markFailed(sb, row, note, verdict.attempt);
      summary.failed += 1;
      continue;
    }

    const attempts = verdict.attempt ? row.attempts + 1 : row.attempts;
    if (verdict.attempt && attempts >= VP_MAX_ATTEMPTS) {
      await markFailed(sb, row, `${note} (gave up after ${attempts} attempts)`, true);
      summary.failed += 1;
    } else {
      await markRetry(sb, row, note, verdict.attempt);
      summary.retried += 1;
    }
  }

  return summary;
}

async function markRetry(
  sb: ScmClient,
  row: VpOutboxRow,
  note: string,
  countAttempt: boolean,
): Promise<void> {
  await sb
    .from('venture_portal_outbox')
    .update({
      status: 'pending',
      attempts: countAttempt ? row.attempts + 1 : row.attempts,
      last_error: note,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);
}

async function markFailed(
  sb: ScmClient,
  row: VpOutboxRow,
  note: string,
  countAttempt: boolean,
): Promise<void> {
  await sb
    .from('venture_portal_outbox')
    .update({
      status: 'failed',
      attempts: countAttempt ? row.attempts + 1 : row.attempts,
      last_error: note,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);
}

/**
 * One delivery. Never throws: a transport failure is an outcome, reported as
 * status 0 so classifyVpResponse retries it.
 *
 * The secret goes in the header the portal's own mirror receivers already use.
 * It is never logged and never returned.
 */
async function deliverOne(
  cfg: VpConfig,
  payload: VpPayload,
  fetchImpl: typeof fetch,
): Promise<{ status: number; outcome: string | null; transportError: string | null }> {
  try {
    const res = await fetchImpl(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sync-secret': cfg.secret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(VP_TIMEOUT_MS),
    });
    const body = await res.text().catch(() => '');
    return {
      status: res.status,
      outcome: res.ok ? readPortalOutcome(body) : null,
      transportError: res.ok ? null : body.slice(0, 300) || null,
    };
  } catch (e) {
    return { status: 0, outcome: null, transportError: String((e as Error | undefined)?.message ?? e).slice(0, 200) };
  }
}

/**
 * Probe the receiver's health endpoint with the configured secret.
 *
 * This is the "prove the route before any delivery" step the contract asks for,
 * turned into a button. It sends no sales-order data.
 */
export async function probeVenturePortal(
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; body: string; reason?: string }> {
  const sb = getSupabaseService(env);
  const cfg = await readVpConfig(sb);
  if (!cfg) return { ok: false, status: 0, body: '', reason: 'not_configured' };
  /* The health endpoint is the delivery URL's sibling, per the contract:
     .../sales-orders -> .../health. Derived rather than stored so there is one
     URL to keep right. */
  const healthUrl = cfg.url.replace(/\/[^/]*$/, '/health');
  try {
    const res = await fetchImpl(healthUrl, {
      method: 'GET',
      headers: { 'x-sync-secret': cfg.secret },
      signal: AbortSignal.timeout(VP_TIMEOUT_MS),
    });
    const body = (await res.text().catch(() => '')).slice(0, 500);
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: '', reason: String((e as Error | undefined)?.message ?? e).slice(0, 200) };
  }
}

/**
 * Re-queue any in-scope sales order with no delivered row.
 *
 * THE BACKSTOP THAT MAKES "one order missed is impossible" more than a hope.
 * The capture trigger swallows its own errors on purpose — it must never roll
 * back a salesperson's Save — so a row CAN be missed, and this is what finds
 * it. Also picks up an order parked as `failed` once a person has cleared the
 * cause, and an order that fell in scope later because somebody moved
 * vp.since back.
 *
 * Returns the number of rows re-queued. Steady state is 0.
 */
export async function reconcileVenturePortalOutbox(
  env: Env,
  opts: { includeFailed: boolean },
): Promise<{ skipped?: string; requeued: number }> {
  const sb = getSupabaseService(env);
  const scope = await readFeedScope(sb);
  if (scope === 'off') return { skipped: 'feed_off', requeued: 0 };
  const cfg = await readVpConfig(sb);
  if (!cfg) return { skipped: 'not_configured', requeued: 0 };

  const { data, error } = await sb.rpc('vp_requeue_undelivered', {
    p_companies: scope === 'all' ? null : scope,
    p_since: cfg.since,
    p_include_failed: opts.includeFailed,
  });
  if (error) return { skipped: 'requeue_failed', requeued: 0 };
  return { requeued: Number(data ?? 0) };
}
