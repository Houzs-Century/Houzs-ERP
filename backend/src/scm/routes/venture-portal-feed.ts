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
// THE KEY IS MINTED HERE AND SHOWN ONCE. POST /secret/generate makes one and
// returns it in that one response; PUT /secret remains for pasting your own.
// Nothing reads it back afterwards — GET /status answers with its LENGTH, its
// last four characters and WHEN it was set, which is enough to tell "the right
// one is in there" from "the field is empty" without putting a credential on a
// screen, in a log, or in a browser's network tab. The value itself only ever
// leaves the database as a request header the sender builds.
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
  VP_SECRET_LENGTH,
  drainVenturePortalOutbox,
  mintVpSecret,
  probeVenturePortal,
  reconcileVenturePortalOutbox,
} from '../lib/venture-portal-outbox';
import {
  VP_CATALOGUE_MAX_POST_BYTES,
  VP_CATALOGUE_URL_PROBLEM,
  pushVenturePortalCatalogue,
  vpCatalogueUrl,
} from '../lib/venture-portal-catalogue';
import { VP_ATTENDANCE_URL_PROBLEM, vpAttendanceUrl } from '../lib/venture-portal-attendance';
import { writeAudit } from '../../services/audit';
import { resolveCallerStaffId } from '../lib/salesScope';

export const venturePortalFeed = new Hono<{ Bindings: Env; Variables: Variables }>();
venturePortalFeed.use('*', supabaseAuth);

const READ_KEYS = ['scm.venture_portal.read', 'settings.manage'] as const;
const MANAGE_KEYS = ['scm.venture_portal.manage', 'settings.manage'] as const;

const MIN_SECRET_LEN = 32;


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

function maskSecret(
  raw: string | null,
  setAt: string | null,
): { set: boolean; length: number; tail: string; setAt: string | null } {
  const v = (raw ?? '').trim();
  if (!v) return { set: false, length: 0, tail: '', setAt: null };
  return { set: true, length: v.length, tail: v.slice(-4), setAt };
}

type VpConfigRow = { v: string; updatedAt: string | null };

async function readConfigRows(
  sb: ReturnType<typeof getSupabaseService>,
): Promise<Map<string, VpConfigRow> | null> {
  const { data, error } = await sb
    .from('sync_config')
    .select('k, v, updated_at')
    .in('k', VP_CONFIG_KEYS as unknown as string[]);
  if (error) return null;
  const out = new Map<string, VpConfigRow>();
  for (const r of (data ?? []) as { k: string; v: string; updated_at: string | null }[]) {
    out.set(r.k, { v: r.v, updatedAt: r.updated_at ?? null });
  }
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

venturePortalFeed.get('/status', async (c) => {
  const denied = denyRead(c);
  if (denied) return denied;
  const sb = getSupabaseService(c.env);

  const [scope, cfg] = await Promise.all([readFeedScope(sb), readConfigRows(sb)]);
  if (cfg === null) {
    return c.json({ error: 'config_read_failed', message: 'could not read the feed connection' }, 500);
  }

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

  const { data: oldestPending, error: oldestErr } = await sb
    .from('venture_portal_outbox')
    .select('doc_no, created_at, attempts, last_error')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1);
  if (oldestErr) {
    return c.json({ error: 'queue_read_failed', message: oldestErr.message }, 500);
  }

  const { data: catalogueRows, error: catalogueErr } = await sb
    .from('venture_portal_catalogue_state')
    .select('company_id, delivered_digest, delivered_at, portal_result, last_digest, last_outcome, last_attempt_at, last_http_status, last_error, last_bytes, last_parts')
    .order('company_id', { ascending: true });
  if (catalogueErr) {
    return c.json({ error: 'catalogue_read_failed', message: catalogueErr.message }, 500);
  }
  const catalogueUrl = vpCatalogueUrl(cfg.get('vp.url')?.v ?? '');

  const { data: attendanceRows, error: attendanceErr } = await sb
    .from('venture_portal_attendance_state')
    .select('company_id, delivered_digest, delivered_at, portal_result, last_digest, last_outcome, last_attempt_at, last_http_status, last_error, last_bytes')
    .order('company_id', { ascending: true });
  if (attendanceErr) {
    return c.json({ error: 'attendance_read_failed', message: attendanceErr.message }, 500);
  }
  const attendanceUrl = vpAttendanceUrl(cfg.get('vp.url')?.v ?? '');

  return c.json({
    feed: {
      enabled: scope !== 'off',
      scope: scope === 'off' ? 'off' : scope === 'all' ? 'all' : scope,
      configKey: VENTURE_PORTAL_FEED_KEY,
    },
    connection: {
      url: cfg.get('vp.url')?.v ?? '',
      since: cfg.get('vp.since')?.v ?? '',
      secret: maskSecret(cfg.get('vp.secret')?.v ?? null, cfg.get('vp.secret')?.updatedAt ?? null),
      ready: Boolean(cfg.get('vp.url')?.v && cfg.get('vp.secret')?.v) && scope !== 'off',
    },
    queue: {
      ...counts,
      maxAttempts: VP_MAX_ATTEMPTS,
      batch: VP_DRAIN_BATCH,
      lastSent: lastSent?.[0] ?? null,
      lastError: lastError?.[0] ?? null,
      oldestPending: oldestPending?.[0] ?? null,
    },
    catalogue: {
      url: catalogueUrl,
      urlProblem: cfg.get('vp.url')?.v && !catalogueUrl ? VP_CATALOGUE_URL_PROBLEM : null,
      maxPostBytes: VP_CATALOGUE_MAX_POST_BYTES,
      companies: (catalogueRows as unknown[] | null) ?? [],
    },
    attendance: {
      url: attendanceUrl,
      urlProblem: cfg.get('vp.url')?.v && !attendanceUrl ? VP_ATTENDANCE_URL_PROBLEM : null,
      companies: (attendanceRows as unknown[] | null) ?? [],
    },
    canManage: MANAGE_KEYS.some((k) => hasHouzsPerm(c, k)),
  });
});

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
  return c.json({ rows: (data as unknown[] | null) ?? [] });
});

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
  if (parsed.protocol !== 'https:') return c.json({ error: 'url_must_be_https' }, 400);
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) return c.json({ error: 'since_invalid' }, 400);

  const sb = getSupabaseService(c.env);
  const urlErr = await writeConfig(sb, 'vp.url', url);
  if (urlErr) return c.json({ error: 'write_failed', message: urlErr }, 500);
  const sinceErr = await writeConfig(sb, 'vp.since', since);
  if (sinceErr) return c.json({ error: 'write_failed', message: sinceErr }, 500);

  return c.json({ ok: true, url, since });
});

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
  return c.json({ ok: true, secret: maskSecret(secret, new Date().toISOString()) });
});

/**
 * MINT a key here, show it ONCE, and never again.
 *
 * Owner 2026-09-13: 「那边 generate 一个 API key 出来；我这边只需要填那个 API
 * key，它就可以 link 起来了」. This is the primary road now and PUT /secret above
 * is the paste-your-own fallback: the page has a Generate button and no secret
 * box, so nobody has to invent a string, and nobody types the same string twice.
 * Rotating is pressing Generate again and pasting the new key on the portal —
 * the window of 401s in between costs the queue nothing, because a 401 does not
 * consume a row's attempts (classifyVpResponse).
 *
 * SHOWN ONCE is not theatre. The value is returned in THIS response body and
 * never again: GET /status answers its length and last four characters, this
 * route writes no log line carrying it, and the audit row below carries only its
 * tail. If it is lost before it reaches the portal, the answer is to generate
 * another one, which costs nothing.
 */
venturePortalFeed.post('/secret/generate', async (c) => {
  const denied = denyManage(c);
  if (denied) return denied;

  const secret = mintVpSecret();
  const sb = getSupabaseService(c.env);
  const err = await writeConfig(sb, 'vp.secret', secret);
  if (err) return c.json({ error: 'write_failed', message: err }, 500);

  await writeAudit(c.env, {
    action: 'venture_portal.secret.generate',
    entityType: 'sync_config',
    entityId: 'vp.secret',
    summary: 'a Venture Portal API key was generated',
    meta: { length: secret.length, tail: secret.slice(-4) },
    actorId: c.get('houzsUser')?.id ?? null,
    actorEmail: c.get('houzsUser')?.email ?? null,
  });

  return c.json({
    ok: true,
    secret,
    length: VP_SECRET_LENGTH,
    mask: maskSecret(secret, new Date().toISOString()),
  });
});

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

  const actorStaffId = await resolveCallerStaffId(sb, c.get('houzsUser')?.id ?? null);

  const { error } = await sb.from('app_config').upsert(
    {
      key: VENTURE_PORTAL_FEED_KEY,
      value,
      description:
        'ERP -> Venture Portal live sales-order feed. off = nothing is queued and nothing is sent. Set to a company id list (Houzs Century is 1) to enable. Read by scm/lib/venture-portal-feed-flag.ts.',
      updated_at: new Date().toISOString(),
      updated_by: actorStaffId,
    },
    { onConflict: 'key' },
  );
  if (error) return c.json({ error: 'write_failed', message: error.message }, 500);

  await writeAudit(c.env, {
    action: 'venture_portal.scope.set',
    entityType: 'app_config',
    entityId: VENTURE_PORTAL_FEED_KEY,
    summary: enabled
      ? `the Venture Portal feed was turned on for ${value === 'all' ? 'every company' : `company ${value}`}`
      : 'the Venture Portal feed was turned off',
    meta: { value, staffId: actorStaffId },
    actorId: c.get('houzsUser')?.id ?? null,
    actorEmail: c.get('houzsUser')?.email ?? null,
  });

  resetFeedFlagCache();
  return c.json({ ok: true, value });
});

venturePortalFeed.post('/probe', async (c) => {
  const denied = denyManage(c);
  if (denied) return denied;
  const result = await probeVenturePortal(c.env);
  return c.json(result);
});

venturePortalFeed.post('/queue-undelivered', async (c) => {
  const denied = denyManage(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({})) as { includeFailed?: unknown };
  const result = await reconcileVenturePortalOutbox(c.env, {
    includeFailed: body.includeFailed === true,
  });
  return c.json(result);
});

venturePortalFeed.post('/drain', async (c) => {
  const denied = denyManage(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({})) as { limit?: unknown };
  const raw = Number(body.limit ?? VP_DRAIN_BATCH);
  const limit = Math.min(Math.max(Number.isFinite(raw) ? raw : VP_DRAIN_BATCH, 1), 200);
  const result = await drainVenturePortalOutbox(c.env, limit);
  return c.json(result);
});

venturePortalFeed.post('/catalogue/send', async (c) => {
  const denied = denyManage(c);
  if (denied) return denied;
  const result = await pushVenturePortalCatalogue(c.env, { force: true });
  return c.json(result);
});

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
    .eq('status', status);
  if (updErr) return c.json({ error: 'write_failed', message: updErr.message }, 500);
  return c.json({ ok: true, doc_no: (row as { doc_no: string }).doc_no });
});

export default venturePortalFeed;
