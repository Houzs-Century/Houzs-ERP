// ----------------------------------------------------------------------------
// /venture-portal-feed — the whole ERP -> Venture Portal live feed, from the
// front end. Queue and snapshot builder are migration 20260912T1800; the sender
// is scm/lib/venture-portal-outbox.ts.
//
// WHY THIS EXISTS AT ALL, and it is the point of the endpoint rather than a
// convenience on top of it. The portal's hand-off contract asks for the receiver
// URL, the shared secret, the company scope and the start date to be INSERTed
// by hand, and for the backfill to be a SQL statement somebody pastes into the
// Supabase console. CLAUDE.md forbids exactly that shape: 「一个功能如果上线后
// 的日常操作还需要开 Terminal、跑 SQL、或找 IT 帮忙，就等于没做完」, and the
// owner is not a database console. Rotating a secret, widening the scope,
// reading why a delivery failed and re-sending it are ALL ordinary operations
// that will happen for years after this ships, so every one of them is a button.
//
// THE SECRET IS WRITE-ONLY THROUGH THIS API. PUT /secret sets it; nothing reads
// it back. GET /status answers with its LENGTH and last four characters and
// nothing else, which is enough to tell "the right one is in there" from "the
// field is empty" without putting a credential on a screen, in a log, or in a
// browser's network tab. The value itself only ever leaves the database as a
// request header the sender builds.
//
// DELIBERATELY CROSS-COMPANY, and naming that per CLAUDE.md's rule. Every other
// SCM route carries a company predicate because the service-role client bypasses
// RLS and the predicate is the whole tenant boundary. This page's SUBJECT is
// which companies are in scope, so a company predicate here would make the
// setting unreadable to the person setting it. The boundary is the permission
// gate instead: scm.venture_portal.read to look, scm.venture_portal.manage to
// change anything, settings.manage for both.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { getSupabaseService } from '../../db/supabase';
import {
  VENTURE_PORTAL_FEED_KEY,
  readFeedScope,
  resetFeedFlagCache,
} from '../lib/venture-portal-feed-flag';
import {
  VP_CONFIG_KEYS,
  VP_DRAIN_BATCH,
  VP_MAX_ATTEMPTS,
  VP_ROW_STATUSES,
  drainVenturePortalOutbox,
  probeVenturePortal,
  reconcileVenturePortalOutbox,
} from '../lib/venture-portal-outbox';

export const venturePortalFeed = new Hono<{ Bindings: Env; Variables: Variables }>();
venturePortalFeed.use('*', supabaseAuth);

/** Looking at the feed. */
const READ_KEYS = ['scm.venture_portal.read', 'settings.manage'] as const;
/** Changing the feed — strictly narrower, because everything behind it either
 *  sends sales orders outward or changes who they are sent for. */
const MANAGE_KEYS = ['scm.venture_portal.manage', 'settings.manage'] as const;

/** The contract's floor. A short shared secret on a public receiver is the one
 *  configuration mistake here that cannot be undone by fixing it later. */
const MIN_SECRET_LEN = 32;

/* The status list and the config-key list both live in lib/venture-portal-outbox
   — imported, never re-spelled. They were hand-typed here (twice, for the
   statuses) until check-duplicated-decisions caught it. */

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

function denyRead(c: Ctx) {
  return READ_KEYS.some((k) => hasHouzsPerm(c, k))
    ? null
    : c.json({ error: 'forbidden', need: READ_KEYS }, 403);
}

function denyManage(c: Ctx) {
  return MANAGE_KEYS.some((k) => hasHouzsPerm(c, k))
    ? null
    : c.json({ error: 'forbidden', need: MANAGE_KEYS }, 403);
}

/** Enough to recognise the secret, never enough to use it. */
function maskSecret(raw: string | null): { set: boolean; length: number; tail: string } {
  const v = (raw ?? '').trim();
  if (!v) return { set: false, length: 0, tail: '' };
  return { set: true, length: v.length, tail: v.slice(-4) };
}

/** Null means the read FAILED, which is not the same as "nothing is configured"
 *  — and the page must not render the second when the first happened. */
async function readConfigRows(
  sb: ReturnType<typeof getSupabaseService>,
): Promise<Record<string, string> | null> {
  const { data, error } = await sb
    .from('sync_config')
    .select('k, v')
    .in('k', VP_CONFIG_KEYS as unknown as string[]);
  if (error) return null;
  const out: Record<string, string> = {};
  for (const r of (data ?? []) as { k: string; v: string }[]) out[r.k] = r.v;
  return out;
}

async function writeConfig(
  sb: ReturnType<typeof getSupabaseService>,
  k: string,
  v: string,
): Promise<string | null> {
  const { error } = await sb.from('sync_config').upsert(
    { k, v, updated_at: new Date().toISOString() },
    { onConflict: 'k' },
  );
  return error ? error.message : null;
}

/**
 * Everything the page needs in one read: is it on, is it wired up, what is in
 * the queue, and what went wrong last.
 */
venturePortalFeed.get('/status', async (c) => {
  const denied = denyRead(c);
  if (denied) return denied;
  const sb = getSupabaseService(c.env);

  const [scope, cfg] = await Promise.all([readFeedScope(sb), readConfigRows(sb)]);
  /* EVERY READ BELOW IS BOUND AND A FAILURE ANSWERS 500, because a status board
     that cannot read is not a healthy status board. Swallowed, an unreadable
     queue renders as `failed: 0` and `pending: 0`, and vpVerdict turns that into
     "Working — nothing waiting" on the owner's screen while orders sit
     undelivered. A wrong green is worse than an error: one gets investigated.
     audit:swallowed-reads caught all four of these. */
  if (cfg === null) {
    return c.json({ error: 'config_read_failed', message: 'could not read the feed connection' }, 500);
  }

  /* One grouped read would need an aggregate PostgREST cannot express, so this
     is four counts with head:true — no rows travel, only the counts. */
  const counts: Record<string, number> = {};
  const countErrors: string[] = [];
  await Promise.all(
    VP_ROW_STATUSES.map(async (s) => {
      const { count, error } = await sb
        .from('venture_portal_outbox')
        .select('id', { count: 'exact', head: true })
        .eq('status', s);
      if (error) countErrors.push(`${s}: ${error.message}`);
      else counts[s] = count ?? 0;
    }),
  );
  if (countErrors.length) {
    return c.json({ error: 'queue_read_failed', message: countErrors.join('; ') }, 500);
  }

  const { data: lastSent, error: lastSentErr } = await sb
    .from('venture_portal_outbox')
    .select('doc_no, sent_at, portal_outcome')
    .eq('status', 'sent')
    .order('sent_at', { ascending: false })
    .limit(1);
  if (lastSentErr) {
    return c.json({ error: 'queue_read_failed', message: lastSentErr.message }, 500);
  }

  const { data: lastError, error: lastErrorErr } = await sb
    .from('venture_portal_outbox')
    .select('doc_no, last_error, attempts, updated_at')
    .not('last_error', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(1);
  if (lastErrorErr) {
    return c.json({ error: 'queue_read_failed', message: lastErrorErr.message }, 500);
  }

  /* The oldest thing still waiting IS the health signal. A pending count that
     is merely large means a busy queue; a pending row from two days ago means
     nothing is draining, and those two look identical in a count — which is
     also why this read in particular must never be swallowed. */
  const { data: oldestPending, error: oldestErr } = await sb
    .from('venture_portal_outbox')
    .select('doc_no, created_at, attempts, last_error')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1);
  if (oldestErr) {
    return c.json({ error: 'queue_read_failed', message: oldestErr.message }, 500);
  }

  return c.json({
    feed: {
      enabled: scope !== 'off',
      scope: scope === 'off' ? 'off' : scope === 'all' ? 'all' : scope,
      configKey: VENTURE_PORTAL_FEED_KEY,
    },
    connection: {
      url: cfg['vp.url'] ?? '',
      since: cfg['vp.since'] ?? '',
      secret: maskSecret(cfg['vp.secret'] ?? null),
      /* The three switches, answered as one question: can a delivery happen? */
      ready: Boolean(cfg['vp.url'] && cfg['vp.secret']) && scope !== 'off',
    },
    queue: {
      ...counts,
      maxAttempts: VP_MAX_ATTEMPTS,
      batch: VP_DRAIN_BATCH,
      lastSent: lastSent?.[0] ?? null,
      lastError: lastError?.[0] ?? null,
      oldestPending: oldestPending?.[0] ?? null,
    },
    canManage: MANAGE_KEYS.some((k) => hasHouzsPerm(c, k)),
  });
});

/** The queue itself, newest first. */
venturePortalFeed.get('/rows', async (c) => {
  const denied = denyRead(c);
  if (denied) return denied;
  const sb = getSupabaseService(c.env);

  const status = c.req.query('status');
  const docNo = c.req.query('doc_no');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);

  let q = sb
    .from('venture_portal_outbox')
    .select('id, doc_no, op, status, attempts, last_error, portal_outcome, created_at, updated_at, sent_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status && (VP_ROW_STATUSES as readonly string[]).includes(status)) q = q.eq('status', status);
  if (docNo) q = q.eq('doc_no', docNo);

  const { data, error } = await q;
  if (error) return c.json({ error: 'query_failed', message: error.message }, 500);
  /* `| null` for readVpConfig's reason: supabase-js over-promises non-null and
     the linter would otherwise have the `?? []` deleted. */
  return c.json({ rows: (data as unknown[] | null) ?? [] });
});

/** The receiver URL and the date floor. */
venturePortalFeed.put('/connection', async (c) => {
  const denied = denyManage(c);
  if (denied) return denied;

  const body = await c.req.json().catch(() => ({})) as { url?: unknown; since?: unknown };
  const url = String(body.url ?? '').trim();
  const since = String(body.since ?? '').trim();

  if (!url) return c.json({ error: 'url_required' }, 400);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return c.json({ error: 'url_invalid' }, 400);
  }
  /* HTTPS ONLY. The body carries a customer name, every line's cost and the
     shared secret in a header; there is no version of this that may travel in
     clear text, and a typo'd http:// receiver would do it silently. */
  if (parsed.protocol !== 'https:') return c.json({ error: 'url_must_be_https' }, 400);
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) return c.json({ error: 'since_invalid' }, 400);

  const sb = getSupabaseService(c.env);
  const urlErr = await writeConfig(sb, 'vp.url', url);
  if (urlErr) return c.json({ error: 'write_failed', message: urlErr }, 500);
  const sinceErr = await writeConfig(sb, 'vp.since', since);
  if (sinceErr) return c.json({ error: 'write_failed', message: sinceErr }, 500);

  return c.json({ ok: true, url, since });
});

/**
 * Set or rotate the shared secret.
 *
 * Write-only: the response echoes the mask, never the value. The contract's
 * rotation order is portal first, then here — a window of 401s only delays
 * deliveries, because a 401 does not consume a row's attempts.
 */
venturePortalFeed.put('/secret', async (c) => {
  const denied = denyManage(c);
  if (denied) return denied;

  const body = await c.req.json().catch(() => ({})) as { secret?: unknown };
  const secret = String(body.secret ?? '').trim();
  if (!secret) return c.json({ error: 'secret_required' }, 400);
  if (secret.length < MIN_SECRET_LEN) {
    return c.json({ error: 'secret_too_short', min: MIN_SECRET_LEN, got: secret.length }, 400);
  }

  const sb = getSupabaseService(c.env);
  const err = await writeConfig(sb, 'vp.secret', secret);
  if (err) return c.json({ error: 'write_failed', message: err }, 500);
  return c.json({ ok: true, secret: maskSecret(secret) });
});

/**
 * Turn the feed on or off, and choose which companies it covers.
 *
 * `companies` is required when enabling and may be the string 'all'. There is
 * no default: which companies' sales orders leave this system is precisely the
 * decision this endpoint exists to record, and CLAUDE.md's rule for a deciding
 * parameter is that it must never be inherited silently.
 */
venturePortalFeed.put('/scope', async (c) => {
  const denied = denyManage(c);
  if (denied) return denied;

  const body = await c.req.json().catch(() => ({})) as {
    enabled?: unknown;
    companies?: unknown;
  };
  const enabled = body.enabled === true;

  let value = 'off';
  if (enabled) {
    if (body.companies === 'all') {
      value = 'all';
    } else if (Array.isArray(body.companies) && body.companies.length > 0) {
      const ids = body.companies.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length !== body.companies.length) return c.json({ error: 'companies_invalid' }, 400);
      value = [...new Set(ids)].sort((a, b) => a - b).join(',');
    } else {
      return c.json({ error: 'companies_required' }, 400);
    }
  }

  const sb = getSupabaseService(c.env);
  const { error } = await sb.from('app_config').upsert(
    {
      key: VENTURE_PORTAL_FEED_KEY,
      value,
      description:
        'ERP -> Venture Portal live sales-order feed. off = nothing is queued and nothing is sent. Set to a company id list (Houzs Century is 1) to enable. Read by scm/lib/venture-portal-feed-flag.ts.',
      updated_at: new Date().toISOString(),
      updated_by: c.get('houzsUser')?.id ?? null,
    },
    { onConflict: 'key' },
  );
  if (error) return c.json({ error: 'write_failed', message: error.message }, 500);

  /* The flag has a 30s cache. Without this drop, the page would show the old
     state for half a minute after somebody pressed the switch, which reads as
     "the button did nothing" — the exact failure mode CLAUDE.md records as
     worse than a crash. */
  resetFeedFlagCache();
  return c.json({ ok: true, value });
});

/**
 * Prove the route to the portal before anything is delivered.
 *
 * This is the contract's rollout step 2 as a button. It GETs the receiver's
 * health endpoint with the configured secret and sends no sales-order data.
 */
venturePortalFeed.post('/probe', async (c) => {
  const denied = denyManage(c);
  if (denied) return denied;
  const result = await probeVenturePortal(c.env);
  return c.json(result);
});

/**
 * Queue every in-scope order that has not been delivered.
 *
 * The initial backfill and the "did we miss anything" sweep are one operation
 * (see the migration's note on scm.vp_requeue_undelivered). `includeFailed`
 * releases rows parked after exhausting their attempts, which is what you press
 * AFTER fixing the cause — so it is explicit and defaults to leaving them
 * parked.
 */
venturePortalFeed.post('/queue-undelivered', async (c) => {
  const denied = denyManage(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({})) as { includeFailed?: unknown };
  const result = await reconcileVenturePortalOutbox(c.env, {
    includeFailed: body.includeFailed === true,
  });
  return c.json(result);
});

/**
 * Send now, rather than waiting for the next five-minute sweep.
 *
 * Bounded by the same batch the cron uses unless a larger one is asked for, so
 * the backfill can be walked down in visible steps by somebody watching it.
 */
venturePortalFeed.post('/drain', async (c) => {
  const denied = denyManage(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({})) as { limit?: unknown };
  const raw = Number(body.limit ?? VP_DRAIN_BATCH);
  const limit = Math.min(Math.max(Number.isFinite(raw) ? raw : VP_DRAIN_BATCH, 1), 200);
  const result = await drainVenturePortalOutbox(c.env, limit);
  return c.json(result);
});

/**
 * Release ONE parked row once its cause is fixed.
 *
 * A `sent` row is refused outright. Re-sending is harmless to the portal — it
 * dedupes on snapshotAt — but the button must not read as a way to "re-push" a
 * delivered order, because the next person to reach for it will be doing so on
 * a document whose commission has already been paid.
 */
venturePortalFeed.post('/rows/:id/requeue', async (c) => {
  // company-scope: scm.venture_portal_outbox HAS NO company_id COLUMN — a row is
  // a doc_no and a delivery state, and this page is deliberately cross-company
  // (which companies feed the portal is the setting it edits; see the file
  // header). So there is no predicate to write here, and the usual
  // service-role/RLS argument does not apply the way it does to a document
  // table. What makes it SAFE is that requeueing cannot cause a delivery: it
  // only returns the row to `pending`, and drainVenturePortalOutbox re-reads the
  // order's company_id and the enabled scope on the next sweep, marking an
  // out-of-scope document `skipped` WITHOUT a request. That is asserted by
  // "a company nobody enabled is skipped WITHOUT a request" in
  // venture-portal-outbox.test.ts, so the boundary is a tested code path and not
  // this comment. Authorization is scm.venture_portal.manage / settings.manage.
  const denied = denyManage(c);
  if (denied) return denied;
  const id = c.req.param('id');
  const sb = getSupabaseService(c.env);

  const { data: row, error } = await sb
    .from('venture_portal_outbox')
    .select('id, doc_no, status')
    .eq('id', id)
    .maybeSingle();
  if (error) return c.json({ error: 'query_failed', message: error.message }, 500);
  if (!row) return c.json({ error: 'not_found' }, 404);

  const status = (row as { status: string }).status;
  if (status === 'sent') return c.json({ error: 'already_delivered' }, 409);
  if (status === 'pending') return c.json({ ok: true, unchanged: 'already_pending' });

  const { error: updErr } = await sb
    .from('venture_portal_outbox')
    .update({
      status: 'pending',
      attempts: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    /* Re-read the status in the predicate: between the SELECT above and this
       UPDATE the sweep may have delivered it, and re-opening a delivered row
       would queue a second delivery nobody asked for. */
    .eq('status', status);
  if (updErr) return c.json({ error: 'write_failed', message: updErr.message }, 500);
  return c.json({ ok: true, doc_no: (row as { doc_no: string }).doc_no });
});

export default venturePortalFeed;
