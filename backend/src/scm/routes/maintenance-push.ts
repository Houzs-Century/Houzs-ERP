// ----------------------------------------------------------------------------
// /maintenance-push — Houzs → 2990 Product Maintenance push.
//
// Owner goal (2026-07-17): "我的整个 Product Maintenance 需要传送数据到 POS 系统,
// 给他们去做选择" — the POS staff pick from options maintained in Houzs.
//
//   GET  /maintenance-push/diff   → the dry-run report. THE DEFAULT. Reads both
//                                   sides, computes what WOULD change, writes
//                                   nothing anywhere.
//   POST /maintenance-push/apply  → actually pushes. Refuses unless the DB kill
//                                   switch is on AND the merge is clean.
//
// There is no UI. Owner rule: a UI needs an approved mockup first.
//
// SHAPE OF THE THING (we are a WRITER — a scoped exception to D2):
// D2 (docs/2990-mirror-full-design.md §3.2) says Houzs never writes 2990's
// database, and this feature is the owner-granted exception to it, for one
// table. The reasoning and its full cost are in lib/bridge-2990.ts's header —
// read that before changing anything here. In short: 2990's
// POST /maintenance-config/changes is an RBAC check plus a plain INSERT, with no
// business logic behind it to reuse, so we do the INSERT ourselves with 2990's
// service-role key. That is what makes this table the exception and not a
// precedent — the SO-amendment write-back DOES have an apply engine behind its
// endpoint (honest-pricing recompute, delivery-fee re-derive, revision bump), so
// it still has to call 2990's API.
//
// What that does NOT change is the hazard everything defensive here answers to:
// the row we insert carries the WHOLE config blob, and 2990's POS subscribes to
// this table via Supabase Realtime (apps/pos/src/lib/queries.ts:1474) — which is
// WAL-based, so it fires for our direct INSERT exactly as it did for 2990's own.
// Whatever we write is on the tablets in ~300ms: no deploy, no review, no error
// if it is wrong. Going direct removed 2990's WRITE_ROLES check, which was the
// ONLY gate in front of this table (RLS is not enabled on it), so the checks in
// this file and in lib/maintenance-push.ts are now the only ones that run
// anywhere. The merge itself lives in lib/maintenance-push.ts, unit-tested
// without a network.
//
// NOT IMPLEMENTED ON PURPOSE — the compartment rename. 2990 exposes
// POST /maintenance-config/sofa-compartments/rename, which rewrites the SKU
// master, every SO / DO / invoice / GRN / PO line snapshot, Modular ticks,
// combos and in-flight carts. That is a mass document rewrite, not a config
// edit, and it is not Houzs's to trigger. There is no code path here that calls
// it, and the merge separately refuses the blob-level disguise of one (an add
// plus a remove on sofaCompartments in a single push).
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { todayMyt } from '../lib/my-time';
import {
  activeCompanyId,
  mintsIntoMirroredNamespace,
  scopeToCompany,
  MIRRORED_COMPANY_CODE,
} from '../lib/companyScope';
import {
  mergeMaintenanceConfig,
  summariseDiff,
  PUSHABLE_POOLS,
  type ConfigBlob,
} from '../lib/maintenance-push';
import {
  readBridgeConfig,
  fetch2990Resolved,
  push2990Change,
  Bridge2990Error,
  type Bridge2990Config,
} from '../lib/bridge-2990';
import type { Env, Variables } from '../env';

export const maintenancePush = new Hono<{ Bindings: Env; Variables: Variables }>();

maintenancePush.use('*', supabaseAuth);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Only the master scope for now. Customer/supplier-scoped configs are 2990's
 *  per-counterparty pricing overrides — pushing option lists into them is a
 *  different question the owner has not been asked. */
const PUSH_SCOPE = 'master';

/** DB kill switch (D8). Fail-CLOSED: a missing table, a cold PostgREST cache, a
 *  missing row and an explicit 'false' all mean the same thing — disabled. The
 *  only way to be enabled is for the row to exist and say exactly 'true'. */
async function pushEnabled(c: { get(k: 'supabase'): any }): Promise<boolean> {
  const { data, error } = await c
    .get('supabase')
    .from('sync_config')
    .select('v')
    .eq('k', 'maintenance_push_enabled')
    .maybeSingle();
  if (error) return false;
  return data?.v === 'true';
}

/** Read Houzs's own currently-effective master config for the ACTIVE company.
 *  Company-scoped like every other reader of this table (requirement 7). */
async function readLocalConfig(c: any): Promise<{ config: ConfigBlob | null; effectiveFrom: string | null }> {
  const asOf = todayMyt();
  const { data: rows, error } = await scopeToCompany(
    c.get('supabase').from('maintenance_config_history').select('config, effective_from').eq('scope', PUSH_SCOPE),
    c,
  )
    .lte('effective_from', asOf)
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Bridge2990Error('local_load_failed', "Could not read Houzs's own maintenance config.", 500, error.message);
  if (!rows?.length) return { config: null, effectiveFrom: null };
  const row = rows[0] as { config: unknown; effective_from: string };
  const cfg = row.config;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { config: null, effectiveFrom: row.effective_from };
  return { config: cfg as ConfigBlob, effectiveFrom: row.effective_from };
}

/** Parse the optional pool filter. Absent = the full default scope (the eight
 *  pure choice-lists). */
function requestedPools(raw: string | undefined): readonly string[] {
  const s = (raw ?? '').trim();
  if (s === '') return PUSHABLE_POOLS;
  return s.split(',').map((p) => p.trim()).filter(Boolean);
}

/** Everything both endpoints do before they diverge: gate, read both sides,
 *  merge. Returns either a ready report or an HTTP refusal. */
async function buildReport(
  c: any,
  opts: { allowRemovals: boolean; pools: readonly string[] },
): Promise<
  | { ok: false; status: number; body: Record<string, unknown> }
  | {
      ok: true;
      merged: ConfigBlob;
      report: Record<string, unknown>;
      refusals: ReturnType<typeof mergeMaintenanceConfig>['refusals'];
      noop: boolean;
      cfg: Bridge2990Config;
    }
> {
  // Direction guard. Under company 2990 the Houzs-side config IS 2990's own
  // mirrored world; pushing it back would be a circular write. This is the
  // maintenance-config flavour of D5 (Houzs originates nothing in 2990's
  // namespace).
  if (mintsIntoMirroredNamespace(c)) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'push_blocked_wrong_company',
        message: `Switch to the Houzs company first. This sends Houzs's option lists to ${MIRRORED_COMPANY_CODE} — running it while ${MIRRORED_COMPANY_CODE} is the active company would send ${MIRRORED_COMPANY_CODE}'s own data back to itself.`,
      },
    };
  }

  const bridge = readBridgeConfig(c.env);
  if (!bridge.ok) {
    return {
      ok: false,
      status: 503,
      body: {
        error: 'bridge_not_configured',
        message: 'The connection to 2990 is not set up yet, so nothing can be sent or compared.',
        missing: bridge.missing,
      },
    };
  }

  const local = await readLocalConfig(c);
  if (!local.config) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'local_config_missing',
        message: 'Houzs has no master maintenance config for this company, so there is nothing to send.',
      },
    };
  }

  const remote = await fetch2990Resolved(bridge.config, PUSH_SCOPE);
  if (!remote.data) {
    // Refuse rather than treat "2990 has no config" as "2990 has an empty
    // config". An empty base would make every Houzs value an addition and the
    // push would look trivially successful while actually creating 2990's
    // master config from scratch — with none of its prices.
    return {
      ok: false,
      status: 409,
      body: {
        error: 'remote_config_missing',
        message: `${MIRRORED_COMPANY_CODE} has no master maintenance config to merge into. Sending one from here would create it from scratch, without any of ${MIRRORED_COMPANY_CODE}'s prices. Someone must check ${MIRRORED_COMPANY_CODE} first.`,
      },
    };
  }

  const merge = mergeMaintenanceConfig(remote.data, local.config, {
    pools: opts.pools,
    allowRemovals: opts.allowRemovals,
  });
  const summary = summariseDiff(merge.diffs);

  return {
    ok: true,
    merged: merge.merged,
    refusals: merge.refusals,
    noop: merge.noop,
    cfg: bridge.config,
    report: {
      scope: PUSH_SCOPE,
      companyId: activeCompanyId(c),
      houzsEffectiveFrom: local.effectiveFrom,
      remoteEffectiveFrom: remote.effectiveFrom,
      remoteHasPendingChange: Boolean(remote.hasPendingPriceChange),
      remotePendingEffectiveFrom: remote.pendingEffectiveFrom,
      allowRemovals: opts.allowRemovals,
      pools: opts.pools,
      summary,
      diffs: merge.diffs,
      refusals: merge.refusals,
      noop: merge.noop,
      // The honest limits of this report, carried in the payload so a reader
      // cannot mistake it for a full safety proof.
      caveats: [
        `A value listed under "additions" is added to ${MIRRORED_COMPANY_CODE}'s master pool. It will still NOT appear in the POS dropdown for any Model whose allowed_options does not list it — apps/pos/src/lib/queries.ts:696 gate() matches by STRING VALUE, and a value that does not match is dropped silently, with no error. Verifying that needs a read of ${MIRRORED_COMPANY_CODE}'s product_models.allowed_options, which this report cannot see.`,
        `A value listed under "remoteOnly" stays on ${MIRRORED_COMPANY_CODE} untouched. Houzs deleting an option never deletes it there.`,
        `Prices are never sent. Every price on ${MIRRORED_COMPANY_CODE} is preserved and re-verified before any write.`,
      ],
    },
  };
}

// ── GET /diff — the dry-run report. Default mode, changes nothing. ──────────
maintenancePush.get('/diff', async (c) => {
  // Gated like the sibling cost-bearing readers: this report echoes 2990's
  // config, prices included, so it is not openRead.
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden', message: 'You do not have permission to view or change product maintenance settings.' }, 403);
  }
  try {
    const r = await buildReport(c, {
      allowRemovals: c.req.query('allowRemovals') === 'true',
      pools: requestedPools(c.req.query('pools')),
    });
    if (!r.ok) return c.json(r.body, r.status as 400);
    const enabled = await pushEnabled(c);
    return c.json({
      mode: 'dry-run',
      wouldSend: r.refusals.length === 0 && !r.noop,
      pushEnabled: enabled,
      ...r.report,
    });
  } catch (e) {
    if (e instanceof Bridge2990Error) return c.json({ error: e.code, message: e.message, detail: e.detail }, e.status as 500);
    throw e;
  }
});

// ── POST /apply — the real push. ────────────────────────────────────────────
// body: { effectiveFrom?: YYYY-MM-DD, notes?: string, allowRemovals?: boolean,
//         pools?: string[], confirm: true }
maintenancePush.post('/apply', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden', message: 'You do not have permission to change product maintenance settings.' }, 403);
  }

  // Kill switch FIRST — before we even read, so a disabled feature cannot be
  // probed for 2990's prices via this route.
  if (!(await pushEnabled(c))) {
    return c.json(
      {
        error: 'push_disabled',
        message: `Sending option lists to ${MIRRORED_COMPANY_CODE} is switched off. Use the dry-run report to see what would be sent.`,
      },
      503,
    );
  }

  let body: { effectiveFrom?: unknown; notes?: unknown; allowRemovals?: unknown; pools?: unknown; confirm?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json', message: 'The request could not be read.' }, 400);
  }

  // Explicit intent. The dry-run is the default everywhere in this feature, so
  // an accidental POST with no confirm must not write to the POS.
  if (body.confirm !== true) {
    return c.json(
      { error: 'confirm_required', message: 'Nothing was sent. Re-send with confirm set to true to actually update 2990.' },
      400,
    );
  }

  const effectiveFrom = typeof body.effectiveFrom === 'string' && body.effectiveFrom.trim() !== '' ? body.effectiveFrom.trim() : todayMyt();
  if (!ISO_DATE.test(effectiveFrom)) {
    return c.json({ error: 'effective_from_invalid', message: 'The date must look like 2026-07-17.' }, 400);
  }

  const pools = Array.isArray(body.pools) && body.pools.length > 0 ? body.pools.map(String) : PUSHABLE_POOLS;

  try {
    const r = await buildReport(c, { allowRemovals: body.allowRemovals === true, pools });
    if (!r.ok) return c.json(r.body, r.status as 400);

    // The merge refused. This is the whole point of the exercise — a refusal is
    // a successful outcome, not an error to be worked around.
    if (r.refusals.length > 0) {
      return c.json(
        {
          error: 'push_refused',
          message: 'Nothing was sent. The change was refused for the reasons listed.',
          refusals: r.refusals,
          ...r.report,
        },
        409,
      );
    }

    if (r.noop) {
      return c.json({ applied: false, reason: 'no_change', message: `${MIRRORED_COMPANY_CODE} already has every option Houzs would send.`, ...r.report });
    }

    const notes =
      typeof body.notes === 'string' && body.notes.trim() !== ''
        ? body.notes.trim()
        : `Option lists from Houzs (${c.get('houzsUser')?.name ?? c.get('houzsUser')?.email ?? 'Houzs'})`;

    const result = await push2990Change(r.cfg, {
      scope: PUSH_SCOPE,
      config: r.merged,
      effectiveFrom,
      notes,
    });

    return c.json({
      applied: true,
      changeId: result.id,
      effectiveFrom: result.effectiveFrom,
      // Who really did this. The row's created_by on 2990 is NULL — Houzs is not
      // a 2990 staff member and the column does not pretend otherwise. The owner
      // ruled the audit trail lives here ("houzs erp 看得到誰改的就行了"), so this
      // response and the row's notes carry the actor.
      requestedByHouzsUserId: c.get('houzsUser')?.id,
      ...r.report,
    });
  } catch (e) {
    if (e instanceof Bridge2990Error) return c.json({ error: e.code, message: e.message, detail: e.detail }, e.status as 500);
    throw e;
  }
});
