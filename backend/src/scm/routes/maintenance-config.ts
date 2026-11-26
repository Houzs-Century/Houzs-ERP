
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { todayMyt } from '../lib/my-time';
import { normalizeConfigInchPools } from '../shared/maintenance-pools';
import { autoDeriveEnabled } from '../lib/auto-derive-cost';
import { deriveMasterConfigCostFromSuppliers, configCostChanged } from '../lib/derive-config-cost';
import type { MaintenanceConfig } from '../shared/mfg-pricing';
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
    const id = s.slice('supplier:'.length).trim();
    return id ? `supplier:${id}` : null;
  }
  return null;
}

function genId(): string {
  const rnd = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `mch-${rnd}`;
}


type McCtx = Context<{ Bindings: Env; Variables: Variables }>;

export const resolvedHandler = async (c: McCtx) => {
  const scope = parseScope(c.req.query('scope'));
  if (!scope) return c.json({ error: 'scope_required' }, 400);

  const asOfRaw = (c.req.query('asOf') ?? '').trim();
  const asOf = ISO_DATE.test(asOfRaw) ? asOfRaw : todayIso();

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
    payload = { data: null, effectiveFrom: null, hasPendingPriceChange: false, pendingEffectiveFrom: null };
  } else {
    const row = rows[0] as Row;

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

async function recomputeMasterConfigCostFromSuppliers(
  supabase: SupabaseClient,
  companyId: number | null | undefined,
  createdBy: string,
): Promise<void> {
  try {
    const asOf = todayMyt();
    let sq = supabase
      .from('maintenance_config_history')
      .select('scope, config, effective_from, created_at')
      .like('scope', 'supplier:%')
      .lte('effective_from', asOf);
    if (companyId != null) sq = sq.eq('company_id', companyId);
    const { data: supRows, error: supErr } = await sq
      .order('effective_from', { ascending: false })
      .order('created_at', { ascending: false });
    if (supErr) throw new Error(supErr.message);
    const latestByScope = new Map<string, MaintenanceConfig>();
    for (const r of (supRows ?? []) as { scope: string; config: unknown }[]) {
      if (!latestByScope.has(r.scope)) latestByScope.set(r.scope, r.config as MaintenanceConfig);
    }
    const supplierConfigs = [...latestByScope.values()];
    if (supplierConfigs.length === 0) return;

    let mq = supabase
      .from('maintenance_config_history')
      .select('config')
      .eq('scope', 'master')
      .lte('effective_from', asOf);
    if (companyId != null) mq = mq.eq('company_id', companyId);
    const { data: masterRow, error: mErr } = await mq
      .order('effective_from', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (mErr) throw new Error(mErr.message);
    const master = ((masterRow as { config?: unknown } | null)?.config ?? null) as MaintenanceConfig | null;

    const derived = deriveMasterConfigCostFromSuppliers(master, supplierConfigs);
    if (!configCostChanged(master, derived)) return;

    const { error: insErr } = await supabase.from('maintenance_config_history').insert({
      company_id: companyId,
      id: genId(),
      scope: 'master',
      config: normalizeConfigInchPools(derived),
      effective_from: asOf,
      notes: 'auto-derived cost (max supplier)',
      created_by: createdBy,
    });
    if (insErr) throw new Error(insErr.message);
  } catch (e) {
    console.error('[auto-derive] master config cost recompute failed:', e instanceof Error ? e.message : e);
  }
}

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
      config: normalizeConfigInchPools(body.config),
      effective_from: effectiveFrom,
      notes: body.notes ?? null,
      created_by: user.id,
    })
    .select('id, scope, config, effective_from, notes, created_at')
    .single();

  if (error) {
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }

  if (scope.startsWith('supplier:') && (await autoDeriveEnabled(supabase, activeCompanyId(c)))) {
    await recomputeMasterConfigCostFromSuppliers(supabase, activeCompanyId(c), user.id);
  }

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
// body: { from, to, apply }. Renames a compartment code in the ACTIVE company
// only, via scm.rename_sofa_compartment (migration *_scm_rename_sofa_compartment_scoped).
// `apply` must be literally true to write; anything else is a preview that
// returns what would change. A code still used by any SKU, doc line, stock row
// or POS combo of this company is refused (409 in_use, with counts): the code is
// part of every SKU code (`<MODEL>-<code>`), so renaming it would orphan them.
// Owner 2026-10-02: only an unused code (a typo) may be renamed; wording staff
// see changes through the SKU name or the compartment description.
// The function is SECURITY DEFINER with no gate of its own: the gate is here.
export const renameSofaCompartmentHandler = async (c: McCtx) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: "You don't have permission to rename a compartment code." }, 403);
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: { from?: unknown; to?: unknown; apply?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const from = typeof body.from === 'string' ? body.from.trim() : '';
  const to = typeof body.to === 'string' ? body.to.trim() : '';
  if (!from || !to) return c.json({ error: 'from_and_to_required' }, 400);
  if (from === to) return c.json({ error: 'same_code' }, 400);
  const apply = body.apply === true;

  const supabase = c.get('supabase');
  const { data, error } = await supabase.rpc('rename_sofa_compartment', {
    p_company_id: co.companyId,
    p_from: from,
    p_to: to,
    p_apply: apply,
  });
  if (error) {
    const msg = String(error.message ?? '');
    if (/code_exists/.test(msg)) {
      return c.json({ error: 'code_exists', reason: `"${to}" is already a compartment code.` }, 400);
    }
    if (/invalid_code|empty_code|same_code/.test(msg)) {
      return c.json({ error: 'invalid_code', reason: 'A compartment code cannot contain spaces, e.g. 1A(LHF) or Console.' }, 400);
    }
    if (/code_too_long/.test(msg)) {
      return c.json({ error: 'code_too_long', reason: 'Model code + "-" + this code would pass the 30-character item code limit.' }, 400);
    }
    return c.json({ error: 'rename_failed', reason: msg }, 500);
  }
  const result = data as { applied?: boolean; refused?: string | null } | null;
  if (apply && result?.refused === 'in_use') {
    return c.json({ error: 'in_use', reason: `"${from}" is still used by this company's SKUs, documents or stock.`, result }, 409);
  }
  if (apply && result?.applied !== true) {
    return c.json({ error: 'rename_failed', reason: 'The rename did not apply.', result }, 500);
  }
  if (apply) await bumpConfigVersion(c.env, 'maintcfg');
  return c.json({ ok: true, applied: apply, result });
};
maintenanceConfig.post('/sofa-compartments/rename', renameSofaCompartmentHandler);

maintenanceConfig.delete('/changes/:id', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403);
  }
  const id = c.req.param('id');
  const supabase = c.get('supabase');
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
  await bumpConfigVersion(c.env, 'maintcfg');
  return c.body(null, 204);
});
