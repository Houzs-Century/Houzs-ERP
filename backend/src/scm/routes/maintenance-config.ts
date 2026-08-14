// ----------------------------------------------------------------------------
// /maintenance-config — variant config (Bedframe + Sofa + Fabrics) with
// effective-date versioning.
//
// Ported from HOOKKA src/api/routes/maintenance-config.ts. Conventions
// kept identical so the UI (also ported) can drop in:
//   GET    /maintenance-config/resolved?scope=master|customer:<id>|supplier:<id>&asOf=YYYY-MM-DD
//   GET    /maintenance-config/history?scope=...
//   POST   /maintenance-config/changes  body: { scope, config, effectiveFrom, notes? }
//   DELETE /maintenance-config/changes/:id
//
// scope encoding: 'master', 'customer:<uuid>', or 'supplier:<uuid>'. Stored
// as TEXT so adding new scope prefixes (e.g. 'showroom:<id>') is an
// application-layer change only — no migration needed.
//
// PR #208 (Commander 2026-05-27) — adds the supplier:<uuid> scope so PO
// line pricing can resolve surcharges from the supplier's own config
// instead of the master/selling config. See apps/api/src/lib/po-pricing.ts
// for the resolver that falls back to 'master' when a supplier has no row.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { todayMyt } from '../lib/my-time';
import { normalizeConfigInchPools } from '../shared/maintenance-pools';
import { activeCompanyId, scopeToCompany,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import {
  CONFIG_CACHE_TTL_SECONDS,
  bumpConfigVersion,
  configCacheKeyUrl,
  configCacheMatch,
  configCachePut,
  configCacheVersion,
  toClientResponse,
} from '../../services/configCache';
import type { Env, Variables } from '../env';

export const maintenanceConfig = new Hono<{ Bindings: Env; Variables: Variables }>();

maintenanceConfig.use('*', supabaseAuth);

type Row = {
  id: string;
  scope: string;
  config: unknown;
  effective_from: string;
  notes: string | null;
  created_at: string;
  created_by: string | null;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const todayIso = () => todayMyt();

function parseScope(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  if (s === 'master') return 'master';
  if (s.startsWith('customer:')) {
    const id = s.slice('customer:'.length).trim();
    return id ? `customer:${id}` : null;
  }
  if (s.startsWith('supplier:')) {
    // PR #208 (Commander 2026-05-27) — supplier-scoped pricing config drives
    // PO line surcharges. Any non-empty suffix is accepted; the resolver
    // (see lib/po-pricing.ts) falls back to 'master' when no row exists.
    const id = s.slice('supplier:'.length).trim();
    return id ? `supplier:${id}` : null;
  }
  return null;
}

function genId(): string {
  const rnd = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `mch-${rnd}`;
}

// Editor-only — maintenance pricing config feeds SO/PO cost. Same role set as
// the sibling pricing editors (fabric-tier-addon / fabric-library / sofa-combos).
// NOTE (Houzs port): /api/scm/* is owner-gated upstream and the auth bridge maps
// every caller to ONE super_admin system-staff row, so this gate always passes
// today. It is kept for parity with 2990 + the sibling sofa-combos gate, as
// defence-in-depth that turns real once per-user → scm.staff attribution lands.
// Houzs-flavoured: scm.staff lookups are dead (the SCM bridge pins every
// caller to one super_admin row). Both writer routes now gate on the flat
// permission key `scm.config.write` against the REAL Houzs caller.

type McCtx = Context<{ Bindings: Env; Variables: Variables }>;

// ── GET /resolved ──────────────────────────────────────────────────────
// Returns the currently-effective config for the given scope (newest row
// with effective_from <= asOf). asOf defaults to today.
//
// Exported (fairReportHandler precedent) so the route test can drive it on a
// bare Hono app with an injected fake supabase + companyId — the supabaseAuth
// bridge cannot run in the harness.
export const resolvedHandler = async (c: McCtx) => {
  const scope = parseScope(c.req.query('scope'));
  if (!scope) return c.json({ error: 'scope_required' }, 400);

  const asOfRaw = (c.req.query('asOf') ?? '').trim();
  const asOf = ISO_DATE.test(asOfRaw) ? asOfRaw : todayIso();

  // Shared PER-COMPANY read cache. The ACTIVE company id is a REQUIRED key
  // segment (alongside the scope + asOf params the query is built from), so
  // company A's entry can never answer company B. Cache ONLY when the company
  // is RESOLVED to a real id: an unresolved context (pre-migration /
  // cold-start) or a restricted-to-no-company caller BYPASSES caching rather
  // than minting a company-less shared key — never guess the scope. The
  // family version is bumped by every config writer (POST /changes, DELETE
  // /changes/:id, compartment rename, compartment photo set/remove). The asOf
  // segment defaults to today MYT, so cached "today" entries roll naturally
  // at midnight.
  const companyId = activeCompanyId(c);
  let keyUrl: string | null = null;
  if (typeof companyId === 'number' && Number.isInteger(companyId) && companyId > 0) {
    const version = await configCacheVersion(c.env, 'maintcfg');
    if (version != null) {
      keyUrl = configCacheKeyUrl(
        new URL(c.req.url).origin,
        'maintcfg',
        `co=${companyId}&scope=${encodeURIComponent(scope)}&asOf=${encodeURIComponent(asOf)}`,
        version,
      );
    }
  }
  if (keyUrl) {
    const hit = await configCacheMatch(keyUrl);
    if (hit) return toClientResponse(hit);
  }

  const supabase = c.get('supabase');

  const { data: rows, error } = await scopeToCompany(
    supabase
      .from('maintenance_config_history')
      .select('id, scope, config, effective_from, notes, created_at, created_by')
      .eq('scope', scope),
    c,
  )
    .lte('effective_from', asOf)
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  let payload: {
    data: unknown;
    effectiveFrom: string | null;
    hasPendingPriceChange: boolean;
    pendingEffectiveFrom: string | null;
  };
  if (!rows?.length) {
    // A company with no config row yet is a real, cacheable state — without
    // caching it, every SO-form load for that company re-runs the query.
    payload = { data: null, effectiveFrom: null, hasPendingPriceChange: false, pendingEffectiveFrom: null };
  } else {
    const row = rows[0] as Row;

    // Lookahead for a pending future change so the UI can show "Pricing
    // updates 2026-06-15" banner above the live config.
    const { data: pending } = await scopeToCompany(
      supabase
        .from('maintenance_config_history')
        .select('effective_from')
        .eq('scope', scope),
      c,
    )
      .gt('effective_from', asOf)
      .order('effective_from', { ascending: true })
      .limit(1);

    payload = {
      data: row.config,
      effectiveFrom: row.effective_from,
      hasPendingPriceChange: Boolean(pending?.length),
      pendingEffectiveFrom: pending?.[0]?.effective_from ?? null,
    };
  }

  const body = JSON.stringify(payload);
  if (keyUrl) {
    await configCachePut(keyUrl, body, CONFIG_CACHE_TTL_SECONDS.maintcfg);
  }
  return c.body(body, 200, {
    'content-type': 'application/json',
    'x-config-cache': keyUrl ? 'miss' : 'bypass',
  });
};
maintenanceConfig.get('/resolved', resolvedHandler);

// ── GET /history ───────────────────────────────────────────────────────
// Full append-only history for the scope. Each row carries an isPending
// flag so the UI can colour future-effective rows differently.
maintenanceConfig.get('/history', async (c) => {
  const scope = parseScope(c.req.query('scope'));
  if (!scope) return c.json({ error: 'scope_required' }, 400);

  const supabase = c.get('supabase');
  const { data, error } = await scopeToCompany(
    supabase
      .from('maintenance_config_history')
      .select('id, scope, config, effective_from, notes, created_at, created_by')
      .eq('scope', scope),
    c,
  )
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const today = todayIso();
  const rows = (data ?? []).map((r) => ({
    id: r.id,
    scope: r.scope,
    config: r.config,
    effectiveFrom: r.effective_from,
    notes: r.notes ?? '',
    createdAt: r.created_at,
    createdBy: r.created_by,
    isPending: r.effective_from > today,
  }));
  return c.json({ history: rows });
});

// ── POST /changes ──────────────────────────────────────────────────────
// Append a new effective-dated row. body: { scope, config, effectiveFrom, notes? }
// Editor-only (Commander 2026-06-18) — pricing config feeds SO/PO cost and was
// previously writable by ANY authed staff. Now gated app-side to WRITE_ROLES,
// matching the sibling pricing editors. (RLS defence-in-depth can follow.)
// Exported for the same bare-app route test as resolvedHandler above.
export const createChangeHandler = async (c: McCtx) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403);
  }
  let body: { scope?: string; config?: unknown; effectiveFrom?: string; notes?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const scope = parseScope(body.scope);
  if (!scope) return c.json({ error: 'scope_required' }, 400);

  const effectiveFrom = (body.effectiveFrom ?? '').trim();
  if (!ISO_DATE.test(effectiveFrom)) {
    return c.json({ error: 'effective_from_required', message: 'YYYY-MM-DD' }, 400);
  }
  if (body.config == null) {
    return c.json({ error: 'config_required' }, 400);
  }

  const supabase = c.get('supabase');
  const user = c.get('user');
  const id = genId();

  const { data, error } = await supabase
    .from('maintenance_config_history')
    .insert({
      company_id: activeCompanyId(c),
      id,
      scope,
      // Inch-mark hygiene on save (quote-doubling mint, 2026-08-01): a
      // hand-keyed `1""` in a height pool would flow verbatim into every
      // document line and ledger key. Write-side only; history untouched.
      config: normalizeConfigInchPools(body.config),
      effective_from: effectiveFrom,
      notes: body.notes ?? null,
      created_by: user.id,
    })
    .select('id, scope, config, effective_from, notes, created_at')
    .single();

  if (error) {
    /* DEAD BRANCH -- here and at EVERY other 42501 site in this file. 42501 is
       Postgres permission-denied, i.e. RLS, and RLS cannot fire on this path: mig
       0061 enabled RLS on every scm table with NO policies, and the SCM client is
       the SERVICE-ROLE client (scm/middleware/auth.ts:93 -> db/supabase.ts
       getSupabaseService), which bypasses RLS by design. No scm function RAISEs
       42501 either -- the live tree's only ERRCODE is 22023. Do NOT read this as a
       permission check and do NOT treat it as scoping: the only boundary is this
       route's own predicate. (docs/audit-2026-08-13-ledger.md K1) */
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }

  // A new effective-dated row can change /resolved for ANY (scope, asOf)
  // pair — orphan the whole family rather than guessing affected keys.
  await bumpConfigVersion(c.env, 'maintcfg');

  return c.json(
    {
      id: data.id,
      scope: data.scope,
      config: data.config,
      effectiveFrom: data.effective_from,
      notes: data.notes ?? '',
    },
    201,
  );
};
maintenanceConfig.post('/changes', createChangeHandler);

// ── POST /sofa-compartments/rename ─────────────────────────────────────
// Maintenance-is-master cascade rename (Loo 2026-06-04: "what maintenance
// change all will follow"). body: { from, to }. Delegates to the
// rename_sofa_compartment() SECURITY DEFINER function (migration 0149),
// which atomically renames the compartment code text across the SKU
// master, every doc-line snapshot, Modular allowed-options, combos, quick
// picks, in-flight carts and the maintenance config blobs themselves.
/* GATED HERE, and it was not.
   This comment used to read "Admin-gated inside the function (is_admin()); 403
   surfaces here." It is not, and the migration that ported the function says so
   in the opposite direction — scripts/scm-schema/port-missing-functions-triggers.sql:165:

     "The 2990 body opens with `IF NOT is_admin() THEN RAISE forbidden`. scm has
      no is_admin()/auth machinery ... The admin gate now lives in the
      route/RBAC layer - the DB-level gate is dropped here ... (Behaviour
      change - flagged.)"

   The DB handed the gate to the route; the route believed the DB still had it;
   nobody wrote one. So this handler - which renames a compartment code across
   the SKU master, EVERY historical doc-line snapshot, Modular allowed-options,
   combos, quick picks and in-flight carts, irreversibly - opened straight at
   c.req.json() while its two siblings in this same file (POST /changes:237,
   DELETE /changes/:id:347) both check canWriteScmConfig.

   The `42501 -> 403` branch below is dead for the same reason: service-role
   client, RLS bypassed, and the RAISE was removed with the gate. */
maintenanceConfig.post('/sofa-compartments/rename', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: "You don't have permission to rename a compartment code." }, 403);
  }
  let body: { from?: string; to?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const from = (body.from ?? '').trim();
  const to = (body.to ?? '').trim();
  if (!from || !to) return c.json({ error: 'from_and_to_required' }, 400);
  if (from === to) return c.json({ error: 'same_code' }, 400);

  const supabase = c.get('supabase');
  const { data, error } = await supabase.rpc('rename_sofa_compartment', {
    p_from: from,
    p_to: to,
  });
  if (error) {
    if (error.code === '42501' || /forbidden|permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (/code_exists/.test(error.message)) return c.json({ error: 'code_exists' }, 400);
    if (/same_code|empty_code/.test(error.message)) return c.json({ error: 'invalid_code' }, 400);
    return c.json({ error: 'rename_failed', reason: error.message }, 500);
  }
  // The cascade rename rewrites the maintenance config blobs themselves.
  await bumpConfigVersion(c.env, 'maintcfg');
  return c.json({ ok: true, result: data });
});

// ── DELETE /changes/:id ────────────────────────────────────────────────
// Remove a row (typically cancelling a pending future change). Note that
// the table is "effectively" append-only in spirit, but we allow physical
// delete for the cancel-pending UX. Past-effective rows should not be
// deleted in practice — the UI hides the trash icon on those.
maintenanceConfig.delete('/changes/:id', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403);
  }
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  // Multi-company: a write refuses on an unresolved company rather than
  // degrading to every company; scope the load and the delete strictly.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: row, error: findErr } = await scopeToCompanyId(
    supabase
      .from('maintenance_config_history')
      .select('id')
      .eq('id', id),
    co.companyId,
  ).maybeSingle();
  if (findErr) return c.json({ error: 'load_failed', reason: findErr.message }, 500);
  if (!row) return c.json(NOT_THIS_COMPANY, 404);

  const { error } = await scopeToCompanyId(
    supabase.from('maintenance_config_history').delete().eq('id', id),
    co.companyId,
  );
  if (error) {
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  // Cancelling a (typically pending) row changes /resolved's lookahead and
  // possibly the live row — orphan the family.
  await bumpConfigVersion(c.env, 'maintcfg');
  return c.body(null, 204);
});
