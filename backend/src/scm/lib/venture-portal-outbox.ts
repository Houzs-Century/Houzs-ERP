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
  const { data: soData, error: soErr } = await sb
    .from('mfg_sales_orders')
    .select('doc_no, company_id, so_date')
    .in('doc_no', docNos);
  /* THE ERROR IS BOUND AND THE SWEEP ABORTS, and this is the one read here where
     swallowing it is not a cosmetic bug. This map IS the company-scope check.
     Left unbound, a five-second database blip returns no rows, every `so` below
     is undefined, `if (so)` is false — and the row falls through to `deliverable`
     WITHOUT ANY SCOPE CHECK AT ALL. A blip would deliver another company's sales
     order, with its costs and margins, to an external portal. That is the exact
     shape audit:swallowed-reads exists to catch, and it caught it here.
     Returning leaves every row pending, which the next sweep retries. */
  if (soErr) return { skipped: 'scope_read_failed', ...zero };
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

// ---------------------------------------------------------------------------
// THE KEY THIS SIDE MINTS
//
// Owner 2026-09-13: 「那边 generate 一个 API key 出来；我这边只需要填那个 API
// key，它就可以 link 起来了」. Before this, linking the two systems meant
// inventing a string and typing the SAME string into two places — and a
// hand-invented shared secret is the one configuration mistake here that cannot
// be undone by fixing it later: a short one on a public receiver is guessable,
// and a delivery cannot be recalled.
//
// So the key is minted HERE, shown once, and pasted on the portal. The portal
// side (its PRs #117 + #118, live) reads a key pasted on its own page, so there
// is exactly one place a human types it, and it is not this one.
//
// IT LIVES IN THE SENDER MODULE because this module is already the one home for
// what `vp.secret` IS — VP_CONFIG_KEYS and readVpConfig are above. The route
// mints through here so "a Venture Portal key" has one definition, and its
// shape can be pinned by a test without booting a router.
// ---------------------------------------------------------------------------

/** 64 URL-SAFE SYMBOLS, and the count is load-bearing — see mintVpSecret. */
export const VP_SECRET_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 48 characters = 288 bits. The portal's floor is 32 characters
 *  (ERP_SYNC_SECRET_MIN_LENGTH in its src/lib/erp-sync/auth.ts [external]), and
 *  this feed's own MIN_SECRET_LEN is the same 32, so a generated key clears both
 *  with room to spare. */
export const VP_SECRET_LENGTH = 48;

/**
 * A new shared secret.
 *
 * `byte & 63` is UNIFORM because 64 divides 256 exactly — every symbol is
 * reachable from exactly four byte values. That is why the alphabet is 64 long
 * and not 62: a `% 62` over an alphanumeric alphabet would make the first two
 * symbols likelier than the rest, and the usual fix (reject and re-draw) is code
 * nobody needs if the arithmetic is chosen not to need it. A test pins the
 * LENGTH of the alphabet for exactly this reason — shorten it and the bias is
 * silent.
 *
 * URL-safe rather than plain base64: this value is typed into a form on the
 * portal by a person and sent as an HTTP header, and `+`, `/` and `=` survive
 * neither road reliably.
 */
export function mintVpSecret(): string {
  const bytes = new Uint8Array(VP_SECRET_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += VP_SECRET_ALPHABET[b & 63];
  return out;
}

// ---------------------------------------------------------------------------
// SECONDS INSTEAD OF FIVE MINUTES — the kick
//
// Owner 2026-09-13: 「我要秒级 update 的」. The capture trigger already runs in
// the SAME TRANSACTION as the salesperson's Save, so nothing about WHEN we know
// changes here. What waited was the DRAIN, on the five-minute cron. This kicks
// the drain from the request that caused the change.
//
// WHAT IS DELIBERATELY UNCHANGED: both cron sweeps. They are the zero-loss
// guarantee and this is a latency optimisation sitting on top of them. A kick
// that is debounced away, lost with its isolate, or never scheduled at all
// (because the change came from a migration rather than a request) costs nothing
// but time — the sweep still collects it. Read every line below as best-effort,
// because that is what makes it safe to put on every write.
//
// WHY ~1.5 SECONDS AND NOT ZERO: the payload is built at SEND time (see the file
// header), so five edits to one order collapse into one delivery — but only if
// the delivery happens after the fifth. Saving a sales order and its lines is
// several requests in a row; draining instantly would POST the order once per
// request and the portal would upsert the same document four times over.
// ---------------------------------------------------------------------------

/** The debounce window AND the wait before the first sweep — ONE number on
 *  purpose. A write arriving inside the window is covered by the drain already
 *  scheduled, because that drain has not run yet and the arriving write's outbox
 *  row is already committed (the trigger is same-transaction, and this code runs
 *  after the response). Two numbers here would be two chances for a write to
 *  fall between them and wait for the cron. */
export const VP_KICK_DELAY_MS = 1_500;

/** Sweeps one kick may run: 4 x VP_DRAIN_BATCH = 100 documents, so a backfill or
 *  a POS rush clears in seconds rather than at 25 per five minutes. */
export const VP_KICK_MAX_SWEEPS = 4;

/* TWO KICKS CAN OVERLAP, and that is a deliberate choice rather than an
   oversight. The debounce only collapses writes inside ONE window; a busy
   backfill sweep is 25 POSTs and can easily outlast 1.5 s, so a save arriving
   mid-sweep starts a second drain and both may read the same pending rows.
   There is no in-flight lock because the alternative is worse for the thing the
   owner actually asked for: a lock would make a save that lands during a long
   drain get no kick at all, and wait for the five-minute sweep.

   What the overlap costs is a duplicate POST. The portal upserts one live row
   per document and applies the newest snapshotAt, answering `duplicate` — which
   is a SUCCESSFUL delivery it chose not to re-apply (see the taxonomy above), so
   nothing is double-counted in anybody's commission. `attempts` can undercount a
   little, which matters to nothing: it exists to park a row that keeps failing.

   LIKELY, not PROVEN here: the dedupe is the portal's behaviour, stated in its
   contract, and its receiver lives in another repository. The same overlap is
   already reachable today by pressing "Send now" while the cron sweeps, so the
   kick makes an existing property more frequent rather than creating one. */

type VpKickSeams = { now: () => number; sleep: (ms: number) => Promise<void> };

const VP_KICK_PRODUCTION_SEAMS: VpKickSeams = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let vpKickSeams: VpKickSeams = VP_KICK_PRODUCTION_SEAMS;
let vpLastKickAt = 0;

/**
 * Test seam — drop the debounce clock, and optionally replace the clock and the
 * 1.5 s wait so a test does not have to spend it.
 *
 * PRODUCTION CALLS THIS WITH NOTHING, and calling it with nothing restores the
 * real clock and the real sleep, so an override cannot leak into another test.
 * Same shape as primeWriteFreezeCache next door, and for the same reason:
 * vi.mock does not reliably intercept module imports under the Cloudflare
 * Workers pool, which is where this file's suite runs.
 */
export function resetVpKick(over?: Partial<VpKickSeams>): void {
  vpLastKickAt = 0;
  vpKickSeams = over ? { ...VP_KICK_PRODUCTION_SEAMS, ...over } : VP_KICK_PRODUCTION_SEAMS;
}

export type VpKickOutcome = 'scheduled' | 'debounced' | 'no_execution_context';

/**
 * Is another sweep worth running? PURE, so the decision can be pinned without a
 * database — the shape lib/write-freeze.ts's isFrozen is written in.
 *
 * THE TEST IS "DID A FULL BATCH LEAVE THE QUEUE", not "was a full batch
 * processed", and the difference is a real trap. A 401 leaves its row PENDING
 * and costs it no attempts (classifyVpResponse), so a queue of 25 rows against a
 * mismatched key would be `processed: 25` on every sweep — four sweeps, 100
 * POSTs, the same 25 rows, on every single kick, for as long as the two keys
 * disagree. Counting only the rows that actually LEFT `pending` stops after one
 * sweep in that case and still walks a real backfill down at 100 per kick.
 *
 * `outOfScope` counts, because those rows were cleared with no request at all —
 * continuing is nearly free and there may be hundreds more behind them.
 *
 * Conservative where it is unsure, on purpose: 20 delivered and 5 retried stops
 * the kick, and the next save's kick or the five-minute sweep picks the rest up.
 * The cron is the guarantee; this is only the accelerator.
 */
export function vpKickSweepAgain(summary: VpDrainSummary): boolean {
  if (summary.skipped) return false;
  return summary.sent + summary.failed + summary.outOfScope >= VP_DRAIN_BATCH;
}

/**
 * Schedule a drain for the change this request just made.
 *
 * NEVER THROWS INTO THE REQUEST and never delays it: the wait and the sweeps all
 * happen inside ctx.waitUntil, after the response has been sent. A failure here
 * must be invisible to the person who pressed Save, because their save already
 * succeeded — the only consequence of losing a kick is that the order leaves on
 * the five-minute sweep instead of in a couple of seconds.
 *
 * `ctx` is `| null` rather than optional, per CLAUDE.md: it DECIDES whether
 * anything is scheduled at all, so every call site has to say which case it is
 * in. A Hono context with no ExecutionContext passes null and gets a truthful
 * answer back instead of a silent no-op.
 */
export function kickVenturePortalDrain(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void } | null,
): VpKickOutcome {
  if (ctx == null) return 'no_execution_context';

  const now = vpKickSeams.now();
  if (now - vpLastKickAt < VP_KICK_DELAY_MS) return 'debounced';

  try {
    ctx.waitUntil(runVpKick(env));
    /* Stamped only once something IS scheduled. Stamped before the call, a
       waitUntil that refused would debounce the next 1.5 s of writes into a
       drain that does not exist. */
    vpLastKickAt = now;
  } catch (e) {
    console.error('[vp-kick] could not schedule a drain', String((e as Error | undefined)?.message ?? e));
    return 'no_execution_context';
  }
  return 'scheduled';
}

/** The scheduled work. Swallows everything — see kickVenturePortalDrain. */
async function runVpKick(env: Env): Promise<void> {
  try {
    await vpKickSeams.sleep(VP_KICK_DELAY_MS);
    for (let sweep = 0; sweep < VP_KICK_MAX_SWEEPS; sweep += 1) {
      const summary = await drainVenturePortalOutbox(env);
      if (!vpKickSweepAgain(summary)) return;
    }
  } catch (e) {
    /* [vp-kick] is the string to alert on. A burst of these means the drain is
       failing for every save, which the page's own verdict will also be saying. */
    console.error('[vp-kick] drain failed', String((e as Error | undefined)?.message ?? e));
  }
}
