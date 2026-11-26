// ----------------------------------------------------------------------------
// /hr — HR / Commission module. Port of 2990 apps/api/src/routes/hr.ts.
//
// This is the module that decides whether 2990's apps/api can be switched off:
// it is the only place anyone's commission is calculated. The MATH is not here —
// it lives in ../shared/hr-commission (byte-identical to 2990's) and
// ../lib/kpi-units. This file is I/O, authorization and company scope only.
//
// Endpoints (20 — 12 ported 1:1 from 2990, 8 added by the 2026-07-17 rulings):
//   GET    /config                 PATCH  /config
//   GET    /profiles               POST   /profiles
//   PATCH  /profiles/:id           DELETE /profiles/:id
//   GET    /item-kpi               POST   /item-kpi
//   POST   /item-kpi/batch
//   PATCH  /item-kpi/:id           DELETE /item-kpi/:id
//   GET    /pickers                GET    /commission
//   GET    /override-levels        POST   /override-levels          (new)
//   PATCH  /override-levels/:id    DELETE /override-levels/:id      (new)
//   GET    /payout/periods         POST   /payout/close             (new)
//   POST   /payout/reopen                                           (new)
//
// ── THE 2026-07-17 OWNER RULINGS (what changed and why) ─────────────────────
// 1. DRAFT EARNS NOTHING ("draft肯定不算"). 2990 excluded only CANCELLED +
//    ON_HOLD of 10 statuses, so DRAFT — the state every SO is BORN in, and the
//    state scan-so lands every OCR'd slip in — paid full commission. See
//    COMMISSION_EXCLUDED_STATUSES for what else that filter reaches.
//
// 2. PERIOD CLOSE / PAYOUT SNAPSHOT (raised by IT, NOT ruled on by the owner —
//    he has not seen this yet). The report recomputed from CURRENT config on
//    every load, so editing one rate silently rewrote every PAST period's
//    payout: no figure he has ever approved was reproducible. A closed period
//    now freezes its rows and is SERVED from them; an open period still
//    recomputes live. See migration 0125 for the full argument.
//
// 3. RECURSIVE OVERRIDE ("無限 讓我們自己add 按SO算"). 2990's override is flat
//    per showroom and has no chain to walk — no manager_id exists anywhere in
//    the HR schema. Houzs has users.manager_id, so commission finally obeys the
//    house rule "reporting-to = FULL recursive downline, every module".
//    Selected by config.override_mode: 'showroom' (2990 parity, the DEFAULT —
//    nobody's pay moves on deploy) or 'chain'. NEVER BOTH: running them
//    together pays a manager twice on overlapping goods. See migration 0124 and
//    rollUpChainGoods for the double-pay guard.
//
// ── AUTHORIZATION (why these keys) ──────────────────────────────────────────
// 2990 gates on scm.staff.role: mutations = admin|super_admin, reads = those
// plus sales_director. Those gates are DEAD under the Houzs bridge — it pins
// every /api/scm/* caller to ONE system scm.staff super_admin row, so a
// role check here would pass for literally everyone. So we gate the REAL caller
// (houzsUser) on two NEW flat keys:
//
//   scm.hr.read   — GET config / profiles / item-kpi / pickers / commission
//   scm.hr.manage — every write (rates, profiles, item-KPI flags)
//
// The read/write SPLIT is 2990's own (sales_director may see the numbers but not
// change the rates); the keys are new because no existing Houzs key means this.
// Deliberately NOT reused:
//   · scm.access — the coarse SCM umbrella. index.ts's own header warns
//     "READ-ONLY IS NOT THE SAME AS SAFE" about exactly this mistake: reports
//     rode the umbrella and shipped every salesperson's cost + margin to any
//     Sales Executive. /commission returns every colleague's SALARY. It is the
//     most sensitive read in the SCM surface and needs its own key.
//   · canViewScmFinance — that gate answers "may this caller see cost/margin on
//     a DOCUMENT". Payroll is a different question about different data, and
//     silently borrowing it would mean any future change to the finance tier
//     quietly re-permissions salaries.
//   · scm.so.view_all — orthogonal (whose ORDERS you may see, not whose PAY).
// Owner + IT Admin hold both new keys via the `*` wildcard, so the module is
// reachable on day one; every other position is granted explicitly via
// Team > Positions. That means it fails CLOSED for everyone else by default,
// which for payroll is the right default.
//
// ── COMPANY SCOPE ───────────────────────────────────────────────────────────
// Houzs runs both companies' books in ONE database. Every read and every write
// here is company-scoped, and the active company must RESOLVE: a commission
// figure computed against an unknown company is a guess, and this is payroll.
// So unlike the rest of SCM (which degrades to "no predicate" when the company
// context is unresolved — see lib/companyScope.ts), HR REFUSES. Migration 0123
// seeds one config row per company, so a resolved company always has an answer.
//
// ── MISSING DATA IS AN ERROR, NOT A ZERO ────────────────────────────────────
// There is no `?? 0` on any money or rate path here. A missing config row, an
// unresolved company or a failed read returns an explicit error. RM 0 is a
// legitimate commission (sold nothing); it must never also be how the module
// says "I don't know".
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  COMMISSION_ENGINE_VERSION,
  COMMISSION_EXCLUDED_STATUSES,
  computeChainCommission,
  computeShowroomCommission,
  kpiFlagFiresOnUnit,
  unitKpiSen,
  unitKpiExcludedSen,
  type CommissionConfig,
  type CommissionRow,
  type OverrideLevel,
  type SalespersonInput,
} from '../shared/hr-commission';
import { activeProductCategories } from '../shared/product-categories';
import { loadProductCategories } from '../lib/product-category-registry';
import { loadKpiUnitsByDoc } from '../lib/kpi-units';
import { supabaseAuth } from '../middleware/auth';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { activeCompanyId, scopeToCompanyId } from '../lib/companyScope';
import { scopeStaffRowsToActiveCompany } from '../lib/staffCompanyScope';
import { resolveCallerStaffId } from '../lib/salesScope';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { uplineChainSteps } from '../../services/orgScope';
import type { Env, Variables } from '../env';
import { fabricSeriesGroups } from '../lib/fabric-series';

export const hr = new Hono<{ Bindings: Env; Variables: Variables }>();

hr.use('*', supabaseAuth);

type HrContext = Context<{ Bindings: Env; Variables: Variables }>;

const HR_READ = 'scm.hr.read';
const HR_MANAGE = 'scm.hr.manage';

const forbidden = (c: HrContext, perm: string) =>
  c.json({ error: 'forbidden', reason: `missing ${perm}` }, 403);

function requireCompany(c: HrContext): { ok: true; companyId: number } | { ok: false; res: Response } {
  const id = activeCompanyId(c);
  if (id == null || !Number.isFinite(Number(id))) {
    return {
      ok: false,
      res: c.json(
        { error: 'company_unresolved', reason: 'The active company could not be determined, so commission cannot be calculated. Please retry in a moment.' },
        503,
      ),
    };
  }
  return { ok: true, companyId: Number(id) };
}

const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path, message: i.message }));

const CONFIG_SELECT =
  'base_bps, personal_kpi_threshold_sen, personal_kpi_bonus_bps, showroom_kpi_threshold_sen, showroom_kpi_bonus_bps, override_base_bps, override_kpi_bonus_bps, override_mode, updated_at';

type ConfigRow = {
  base_bps: number;
  personal_kpi_threshold_sen: number;
  personal_kpi_bonus_bps: number;
  showroom_kpi_threshold_sen: number;
  showroom_kpi_bonus_bps: number;
  override_base_bps: number;
  override_kpi_bonus_bps: number;
  override_mode: string;
  updated_at?: string;
};

type OverrideMode = 'showroom' | 'chain';
const isOverrideMode = (v: unknown): v is OverrideMode => v === 'showroom' || v === 'chain';

const toConfigApi = (r: ConfigRow) => ({
  baseBps: r.base_bps,
  personalKpiThresholdSen: r.personal_kpi_threshold_sen,
  personalKpiBonusBps: r.personal_kpi_bonus_bps,
  showroomKpiThresholdSen: r.showroom_kpi_threshold_sen,
  showroomKpiBonusBps: r.showroom_kpi_bonus_bps,
  overrideBaseBps: r.override_base_bps,
  overrideKpiBonusBps: r.override_kpi_bonus_bps,
  overrideMode: r.override_mode,
  updatedAt: r.updated_at,
});

const toConfig = (r: ConfigRow): CommissionConfig => ({
  baseBps: r.base_bps,
  personalKpiThresholdSen: r.personal_kpi_threshold_sen,
  personalKpiBonusBps: r.personal_kpi_bonus_bps,
  showroomKpiThresholdSen: r.showroom_kpi_threshold_sen,
  showroomKpiBonusBps: r.showroom_kpi_bonus_bps,
  overrideBaseBps: r.override_base_bps,
  overrideKpiBonusBps: r.override_kpi_bonus_bps,
});

async function loadConfigRow(
  c: HrContext,
  companyId: number,
): Promise<{ ok: true; row: ConfigRow } | { ok: false; res: Response }> {
  const sb = c.get('supabase');
  const { data, error } = await sb
    .from('hr_commission_config')
    .select(CONFIG_SELECT)
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) return { ok: false, res: c.json({ error: 'fetch_failed', reason: error.message }, 500) };
  if (!data) {
    return {
      ok: false,
      res: c.json(
        { error: 'config_missing', reason: 'No commission rate settings exist for this company yet, so no commission can be calculated. Set the rates in HR Settings first.' },
        409,
      ),
    };
  }
  return { ok: true, row: data as ConfigRow };
}

hr.get('/config', async (c) => {
  if (!hasHouzsPerm(c, HR_READ)) return forbidden(c, HR_READ);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const cfg = await loadConfigRow(c, co.companyId);
  if (!cfg.ok) return cfg.res;
  return c.json({ config: toConfigApi(cfg.row) });
});

const configPatchSchema = z.object({
  baseBps: z.number().int().nonnegative().optional(),
  personalKpiThresholdSen: z.number().int().nonnegative().optional(),
  personalKpiBonusBps: z.number().int().nonnegative().optional(),
  showroomKpiThresholdSen: z.number().int().nonnegative().optional(),
  showroomKpiBonusBps: z.number().int().nonnegative().optional(),
  overrideBaseBps: z.number().int().nonnegative().optional(),
  overrideKpiBonusBps: z.number().int().nonnegative().optional(),
  overrideMode: z.enum(['showroom', 'chain']).optional(),
});

hr.patch('/config', async (c) => {
  if (!hasHouzsPerm(c, HR_MANAGE)) return forbidden(c, HR_MANAGE);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = configPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: issues(parsed.error) }, 400);

  const sb = c.get('supabase');
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: await resolveCallerStaffId(sb, c.get('houzsUser')?.id),
  };
  const d = parsed.data;
  if (d.baseBps !== undefined) patch.base_bps = d.baseBps;
  if (d.personalKpiThresholdSen !== undefined) patch.personal_kpi_threshold_sen = d.personalKpiThresholdSen;
  if (d.personalKpiBonusBps !== undefined) patch.personal_kpi_bonus_bps = d.personalKpiBonusBps;
  if (d.showroomKpiThresholdSen !== undefined) patch.showroom_kpi_threshold_sen = d.showroomKpiThresholdSen;
  if (d.showroomKpiBonusBps !== undefined) patch.showroom_kpi_bonus_bps = d.showroomKpiBonusBps;
  if (d.overrideBaseBps !== undefined) patch.override_base_bps = d.overrideBaseBps;
  if (d.overrideKpiBonusBps !== undefined) patch.override_kpi_bonus_bps = d.overrideKpiBonusBps;
  if (d.overrideMode !== undefined) patch.override_mode = d.overrideMode;

  if (d.overrideMode === 'chain') {
    const lv = await loadOverrideLevels(c, co.companyId);
    if (!lv.ok) return lv.res;
    if (lv.levels.length === 0) {
      return c.json(
        { error: 'no_override_levels', reason: 'Chain override mode needs at least one override level configured, otherwise every manager would earn RM 0 override. Add the levels first, then switch the mode.' },
        409,
      );
    }
  }

  const { data, error } = await sb
    .from('hr_commission_config')
    .update(patch)
    .eq('company_id', co.companyId)
    .select(CONFIG_SELECT)
    .maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'config_missing', reason: 'No commission rate settings exist for this company yet.' }, 409);
  return c.json({ config: toConfigApi(data as ConfigRow) });
});

const PROFILE_SELECT = 'id, staff_id, tier, showroom_id, active, created_at, updated_at';

type ProfileRow = {
  id: string; staff_id: string; tier: string; showroom_id: string; active: boolean;
  created_at: string; updated_at: string;
};

type StaffLite = { name: string; staffCode: string };

async function loadStaffLite(sb: any, staffIds: string[]): Promise<{ data: Map<string, StaffLite>; error: { message: string } | null }> {
  const ids = [...new Set(staffIds.filter(Boolean))];
  if (ids.length === 0) return { data: new Map(), error: null };
  const res = await chunkIn<{ id: string; name: string | null; staff_code: string | null }>(
    ids,
    (batch, from, to) => sb.from('staff').select('id, name, staff_code').in('id', batch).order('id').range(from, to),
  );
  if (res.error) return { data: new Map(), error: res.error };
  return {
    data: new Map(res.data.map((s) => [s.id, { name: s.name ?? '', staffCode: s.staff_code ?? '' }])),
    error: null,
  };
}

const toProfileApi = (r: ProfileRow, staff: Map<string, StaffLite>) => ({
  id: r.id,
  staffId: r.staff_id,
  staffName: staff.get(r.staff_id)?.name ?? '',
  staffCode: staff.get(r.staff_id)?.staffCode ?? '',
  tier: r.tier,
  showroomId: r.showroom_id,
  active: r.active,
});

hr.get('/profiles', async (c) => {
  if (!hasHouzsPerm(c, HR_READ)) return forbidden(c, HR_READ);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const sb = c.get('supabase');
  const { data, error } = await paginateAll<ProfileRow>((from, to) => sb
    .from('hr_salesperson_profiles')
    .select(PROFILE_SELECT)
    .eq('company_id', co.companyId)
    .order('created_at', { ascending: true })
    .range(from, to),
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  const rows = data ?? [];
  const staff = await loadStaffLite(sb, rows.map((r) => r.staff_id));
  if (staff.error) return c.json({ error: 'fetch_failed', reason: staff.error.message }, 500);
  return c.json({ profiles: rows.map((r) => toProfileApi(r, staff.data)) });
});

const profileCreateSchema = z.object({
  staffId: z.string().uuid(),
  tier: z.enum(['sales', 'manager']),
  showroomId: z.string().uuid(),
  active: z.boolean().default(true),
});

hr.post('/profiles', async (c) => {
  if (!hasHouzsPerm(c, HR_MANAGE)) return forbidden(c, HR_MANAGE);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = profileCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: issues(parsed.error) }, 400);
  const sb = c.get('supabase');
  const { data, error } = await sb
    .from('hr_salesperson_profiles')
    .insert({
      staff_id: parsed.data.staffId,
      tier: parsed.data.tier,
      showroom_id: parsed.data.showroomId,
      active: parsed.data.active,
      company_id: co.companyId,
    })
    .select(PROFILE_SELECT)
    .single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_staff', reason: 'this staff already has an HR profile in this company' }, 409);
    return c.json({ error: 'create_failed', reason: error.message }, 500);
  }
  const row = data as ProfileRow;
  const staff = await loadStaffLite(sb, [row.staff_id]);
  if (staff.error) return c.json({ error: 'fetch_failed', reason: staff.error.message }, 500);
  return c.json({ profile: toProfileApi(row, staff.data) }, 201);
});

const profilePatchSchema = z.object({
  tier: z.enum(['sales', 'manager']).optional(),
  showroomId: z.string().uuid().optional(),
  active: z.boolean().optional(),
});

hr.patch('/profiles/:id', async (c) => {
  if (!hasHouzsPerm(c, HR_MANAGE)) return forbidden(c, HR_MANAGE);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = profilePatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: issues(parsed.error) }, 400);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.tier !== undefined) patch.tier = parsed.data.tier;
  if (parsed.data.showroomId !== undefined) patch.showroom_id = parsed.data.showroomId;
  if (parsed.data.active !== undefined) patch.active = parsed.data.active;
  const sb = c.get('supabase');
  const { data, error } = await sb
    .from('hr_salesperson_profiles')
    .update(patch)
    .eq('id', id)
    .eq('company_id', co.companyId)
    .select(PROFILE_SELECT)
    .maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  const row = data as ProfileRow;
  const staff = await loadStaffLite(sb, [row.staff_id]);
  if (staff.error) return c.json({ error: 'fetch_failed', reason: staff.error.message }, 500);
  return c.json({ profile: toProfileApi(row, staff.data) });
});

hr.delete('/profiles/:id', async (c) => {
  if (!hasHouzsPerm(c, HR_MANAGE)) return forbidden(c, HR_MANAGE);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const id = c.req.param('id');
  const sb = c.get('supabase');
  const { error } = await sb
    .from('hr_salesperson_profiles')
    .delete()
    .eq('id', id)
    .eq('company_id', co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

const ITEM_KPI_SELECT = 'id, flag_type, ref, label, bonus_sen, active, created_at, updated_at';

type ItemKpiRow = {
  id: string; flag_type: 'product' | 'category' | 'fabric' | 'special'; ref: string;
  label: string; bonus_sen: number; active: boolean;
};

const toItemKpiApi = (r: ItemKpiRow) => ({
  id: r.id,
  flagType: r.flag_type,
  ref: r.ref,
  label: r.label,
  bonusSen: r.bonus_sen,
  active: r.active,
});

hr.get('/item-kpi', async (c) => {
  if (!hasHouzsPerm(c, HR_READ)) return forbidden(c, HR_READ);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const sb = c.get('supabase');
  const { data, error } = await paginateAll<ItemKpiRow>((from, to) => sb
    .from('hr_item_kpi')
    .select(ITEM_KPI_SELECT)
    .eq('company_id', co.companyId)
    .order('created_at', { ascending: true })
    .range(from, to),
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ items: (data ?? []).map(toItemKpiApi) });
});

const itemKpiCreateSchema = z.object({
  flagType: z.enum(['product', 'category', 'fabric', 'special']),
  ref: z.string().min(1),
  label: z.string().default(''),
  bonusSen: z.number().int().nonnegative(),
  active: z.boolean().default(true),
});

hr.post('/item-kpi', async (c) => {
  if (!hasHouzsPerm(c, HR_MANAGE)) return forbidden(c, HR_MANAGE);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = itemKpiCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: issues(parsed.error) }, 400);
  const sb = c.get('supabase');
  const { data, error } = await sb
    .from('hr_item_kpi')
    .insert({
      flag_type: parsed.data.flagType,
      ref: parsed.data.ref,
      label: parsed.data.label,
      bonus_sen: parsed.data.bonusSen,
      active: parsed.data.active,
      company_id: co.companyId,
    })
    .select(ITEM_KPI_SELECT)
    .single();
  if (error) return c.json({ error: 'create_failed', reason: error.message }, 500);
  return c.json({ item: toItemKpiApi(data as ItemKpiRow) }, 201);
});

/* POST /item-kpi/batch — several rules in ONE insert (YH 2026-11-06). Picking
   a fabric series made the page save 13 rules one request at a time, each
   waiting for every HR list to reload, and a run once stopped after five. One
   statement is all or nothing: every rule lands, or none does and the error
   says why. Each row is still its own rule (owner 2026-07-18). */
const itemKpiBatchSchema = z.object({ items: z.array(itemKpiCreateSchema).min(1).max(200) });

hr.post('/item-kpi/batch', async (c) => {
  if (!hasHouzsPerm(c, HR_MANAGE)) return forbidden(c, HR_MANAGE);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = itemKpiBatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: issues(parsed.error) }, 400);
  const sb = c.get('supabase');
  const { data, error } = await sb
    .from('hr_item_kpi')
    .insert(parsed.data.items.map((it) => ({
      flag_type: it.flagType,
      ref: it.ref,
      label: it.label,
      bonus_sen: it.bonusSen,
      active: it.active,
      company_id: co.companyId,
    })))
    .select(ITEM_KPI_SELECT);
  if (error) return c.json({ error: 'create_failed', reason: error.message }, 500);
  return c.json({ items: ((data ?? []) as ItemKpiRow[]).map(toItemKpiApi) }, 201);
});

const itemKpiPatchSchema = z.object({
  label: z.string().optional(),
  bonusSen: z.number().int().nonnegative().optional(),
  active: z.boolean().optional(),
});

hr.patch('/item-kpi/:id', async (c) => {
  if (!hasHouzsPerm(c, HR_MANAGE)) return forbidden(c, HR_MANAGE);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = itemKpiPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: issues(parsed.error) }, 400);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.label !== undefined) patch.label = parsed.data.label;
  if (parsed.data.bonusSen !== undefined) patch.bonus_sen = parsed.data.bonusSen;
  if (parsed.data.active !== undefined) patch.active = parsed.data.active;
  const sb = c.get('supabase');
  const { data, error } = await sb
    .from('hr_item_kpi')
    .update(patch)
    .eq('id', id)
    .eq('company_id', co.companyId)
    .select(ITEM_KPI_SELECT)
    .maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json({ item: toItemKpiApi(data as ItemKpiRow) });
});

hr.delete('/item-kpi/:id', async (c) => {
  if (!hasHouzsPerm(c, HR_MANAGE)) return forbidden(c, HR_MANAGE);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const id = c.req.param('id');
  const sb = c.get('supabase');
  const { error } = await sb
    .from('hr_item_kpi')
    .delete()
    .eq('id', id)
    .eq('company_id', co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

// ── override levels (chain mode) ────────────────────────────────────────────
// The config surface for the owner's "讓我們自己add": one editable rate per
// level of the reporting chain. level 1 = a person's DIRECT reports, level 2 =
// their reports' reports, and so on — "無限", bounded only by the rows he adds.
// Seeded EMPTY (migration 0124): inventing a level rate would be inventing a
// payout.
const LEVEL_SELECT = 'id, level, rate_bps, label, active, created_at, updated_at';

type LevelRow = { id: string; level: number; rate_bps: number; label: string; active: boolean };

const toLevelApi = (r: LevelRow) => ({
  id: r.id,
  level: r.level,
  rateBps: r.rate_bps,
  label: r.label,
  active: r.active,
});

async function loadOverrideLevels(
  c: HrContext,
  companyId: number,
): Promise<{ ok: true; levels: OverrideLevel[] } | { ok: false; res: Response }> {
  const sb = c.get('supabase');
  const res = await paginateAll<LevelRow>((f, t) => sb
    .from('hr_override_levels')
    .select(LEVEL_SELECT)
    .eq('active', true)
    .eq('company_id', companyId)
    .order('level')
    .range(f, t),
  );
  if (res.error) return { ok: false, res: c.json({ error: 'override_levels_failed', reason: res.error.message }, 500) };
  return { ok: true, levels: (res.data ?? []).map((r) => ({ level: r.level, rateBps: r.rate_bps })) };
}

hr.get('/override-levels', async (c) => {
  if (!hasHouzsPerm(c, HR_READ)) return forbidden(c, HR_READ);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const sb = c.get('supabase');
  const { data, error } = await paginateAll<LevelRow>((f, t) => sb
    .from('hr_override_levels')
    .select(LEVEL_SELECT)
    .eq('company_id', co.companyId)
    .order('level')
    .range(f, t),
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ levels: (data ?? []).map(toLevelApi) });
});

const levelCreateSchema = z.object({
  // No upper bound on `level`: the owner said 無限 (unlimited). The walk depth
  // follows what is configured here (see /commission), so a level 12 is walked
  // to 12. Only level 0 is impossible — an "override" on your own sale is just
  // being paid twice for it.
  level: z.number().int().min(1),
  rateBps: z.number().int().nonnegative(),
  label: z.string().default(''),
  active: z.boolean().default(true),
});

hr.post('/override-levels', async (c) => {
  if (!hasHouzsPerm(c, HR_MANAGE)) return forbidden(c, HR_MANAGE);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = levelCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: issues(parsed.error) }, 400);
  const sb = c.get('supabase');
  const { data, error } = await sb
    .from('hr_override_levels')
    .insert({
      level: parsed.data.level,
      rate_bps: parsed.data.rateBps,
      label: parsed.data.label,
      active: parsed.data.active,
      company_id: co.companyId,
      updated_by: await resolveCallerStaffId(sb, c.get('houzsUser')?.id),
    })
    .select(LEVEL_SELECT)
    .single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_level', reason: 'this level already has a rate in this company — edit it instead' }, 409);
    return c.json({ error: 'create_failed', reason: error.message }, 500);
  }
  return c.json({ level: toLevelApi(data as LevelRow) }, 201);
});

const levelPatchSchema = z.object({
  rateBps: z.number().int().nonnegative().optional(),
  label: z.string().optional(),
  active: z.boolean().optional(),
});

hr.patch('/override-levels/:id', async (c) => {
  if (!hasHouzsPerm(c, HR_MANAGE)) return forbidden(c, HR_MANAGE);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = levelPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: issues(parsed.error) }, 400);
  const sb = c.get('supabase');
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: await resolveCallerStaffId(sb, c.get('houzsUser')?.id),
  };
  if (parsed.data.rateBps !== undefined) patch.rate_bps = parsed.data.rateBps;
  if (parsed.data.label !== undefined) patch.label = parsed.data.label;
  if (parsed.data.active !== undefined) patch.active = parsed.data.active;
  const { data, error } = await sb
    .from('hr_override_levels')
    .update(patch)
    .eq('id', id)
    .eq('company_id', co.companyId)
    .select(LEVEL_SELECT)
    .maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json({ level: toLevelApi(data as LevelRow) });
});

hr.delete('/override-levels/:id', async (c) => {
  if (!hasHouzsPerm(c, HR_MANAGE)) return forbidden(c, HR_MANAGE);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const id = c.req.param('id');
  const sb = c.get('supabase');
  const { error } = await sb
    .from('hr_override_levels')
    .delete()
    .eq('id', id)
    .eq('company_id', co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

hr.get('/pickers', async (c) => {
  if (!hasHouzsPerm(c, HR_READ)) return forbidden(c, HR_READ);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const sb = c.get('supabase');

  const [staffRes, showroomRes, productRes, fabricRes, specialRes, trackingRes] = await Promise.all([
    paginateAll<{ id: string; name: string; staff_code: string; role: string; user_id: number | null }>((from, to) =>
      sb.from('staff').select('id, name, staff_code, role, active, user_id').eq('active', true).order('name').range(from, to)),
    paginateAll<{ id: string; name: string }>((from, to) =>
      sb.from('showrooms').select('id, name').eq('active', true).eq('company_id', co.companyId).order('sort_order').range(from, to)),
    paginateAll<{ code: string; name: string }>((from, to) =>
      sb.from('mfg_products').select('code, name').eq('pos_active', true).eq('company_id', co.companyId).order('code').range(from, to)),
    paginateAll<{ id: string; label: string }>((from, to) =>
      sb.from('fabric_library').select('id, label').eq('company_id', co.companyId).order('label').range(from, to)),
    paginateAll<{ code: string; label: string }>((from, to) =>
      sb.from('special_addons').select('code, label').eq('company_id', co.companyId).order('label').range(from, to)),
    paginateAll<{ fabric_code: string; series: string | null }>((from, to) =>
      sb.from('fabric_trackings').select('fabric_code, series').eq('company_id', co.companyId).order('fabric_code').range(from, to)),
  ]);
  const firstErr = staffRes.error || showroomRes.error || productRes.error || fabricRes.error || specialRes.error || trackingRes.error;
  if (firstErr) return c.json({ error: 'fetch_failed', reason: firstErr.message }, 500);
  const categories = await loadProductCategories(sb);

  const { scoped: scopedStaff } = await scopeStaffRowsToActiveCompany(
    c,
    (staffRes.data ?? []) as unknown as Array<Record<string, unknown>>,
  );

  return c.json({
    staff: (scopedStaff as unknown as typeof staffRes.data ?? []).map((s) => ({ id: s.id, name: s.name, staffCode: s.staff_code, role: s.role })),
    showrooms: (showroomRes.data ?? []).map((s) => ({ id: s.id, name: s.name })),
    products: (productRes.data ?? []).map((p) => ({ ref: p.code, label: `${p.code} — ${p.name}` })),
    categories: activeProductCategories(categories).map((r) => ({ ref: r.code, label: r.name })),
    fabrics: (fabricRes.data ?? []).map((f) => ({ ref: f.id, label: f.label })),
    fabricSeries: fabricSeriesGroups(trackingRes.data ?? [], new Set((fabricRes.data ?? []).map((f) => f.id))),
    specials: (specialRes.data ?? []).map((s) => ({ ref: s.code, label: s.label })),
  });
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const COMMISSION_EXCLUDED_STATUS_FILTER = `(${COMMISSION_EXCLUDED_STATUSES.join(',')})`;

type OrderRow = {
  doc_no: string;
  salesperson_id: string | null;
  mattress_sofa_sen: number | null;
  bedframe_sen: number | null;
  accessories_sen: number | null;
  others_sen: number | null;
};

const goodsOf = (o: OrderRow): number =>
  (o.mattress_sofa_sen ?? 0) + (o.bedframe_sen ?? 0) + (o.accessories_sen ?? 0) + (o.others_sen ?? 0);

const TIER_RANK: Record<string, number> = { manager: 0, sales: 1 };

type ProfileLite = { staff_id: string; tier: string; showroom_id: string };

async function rollUpChainGoods(
  c: HrContext,
  companyId: number,
  profiles: ProfileLite[],
  commissionableGoods: ReadonlyMap<string, number>,
  levels: OverrideLevel[],
): Promise<{ ok: true; goods: Map<string, Map<number, number>> } | { ok: false; res: Response }> {
  const goods = new Map<string, Map<number, number>>();
  const staffIds = profiles.map((p) => p.staff_id);
  if (staffIds.length === 0 || levels.length === 0) return { ok: true, goods };

  const sb = c.get('supabase');
  const linkRes = await chunkIn<{ id: string; user_id: number | null }>(
    [...new Set(staffIds)],
    (batch, from, to) => sb.from('staff').select('id, user_id').in('id', batch).order('id').range(from, to),
  );
  if (linkRes.error) {
    return { ok: false, res: c.json({ error: 'chain_link_failed', reason: linkRes.error.message }, 500) };
  }

  const userIdOfStaff = new Map<string, number>();
  const staffIdOfUser = new Map<number, string>();
  for (const r of linkRes.data) {
    const uid = Number(r.user_id);
    if (!r.user_id || !Number.isFinite(uid)) continue;
    userIdOfStaff.set(r.id, uid);
    staffIdOfUser.set(uid, r.id);
  }

  /* "無限" in practice: walk exactly as deep as the owner has CONFIGURED, not to
     some constant in this file. Walking past the deepest configured level would
     only find ancestors with no rate. If he adds a level 12, this passes 12 —
     orgScope's MAX_CHAIN_DEPTH default of 10 is a cycle bound, and passing this
     explicitly is what stops that default from silently capping a ruling that
     said unlimited. */
  const maxLevel = Math.max(...levels.map((l) => l.level));

  for (const p of profiles) {
    const sellerGoods = commissionableGoods.get(p.staff_id) ?? 0;
    if (sellerGoods <= 0) continue;
    const sellerUserId = userIdOfStaff.get(p.staff_id);
    if (sellerUserId === undefined) continue;
    const steps = await uplineChainSteps(c.env, sellerUserId, maxLevel);
    for (const step of steps) {
      const earnerStaffId = staffIdOfUser.get(step.userId);
      if (earnerStaffId === undefined) continue;
      const byLevel = goods.get(earnerStaffId) ?? new Map<number, number>();
      byLevel.set(step.level, (byLevel.get(step.level) ?? 0) + sellerGoods);
      goods.set(earnerStaffId, byLevel);
    }
  }
  return { ok: true, goods };
}

type BuiltRow = CommissionRow & {
  staffName: string;
  kpiDetail: Array<{ label: string; qty: number; bonusSen: number; lineSen: number }>;
};
type BuiltShowroom = {
  showroomId: string;
  showroomName: string;
  showroomGoodsSen: number;
  showroomKpiHit: boolean;
  rows: BuiltRow[];
};
type BuiltCommission = {
  configRow: ConfigRow;
  mode: OverrideMode;
  levels: OverrideLevel[];
  showrooms: BuiltShowroom[];
};

async function buildCommissionLive(
  c: HrContext,
  companyId: number,
  from: string,
  to: string,
): Promise<{ ok: true; built: BuiltCommission } | { ok: false; res: Response }> {
  const co = { companyId };
  const sb = c.get('supabase');

  const cfgRes = await loadConfigRow(c, companyId);
  if (!cfgRes.ok) return { ok: false, res: cfgRes.res };
  const config = toConfig(cfgRes.row);

  if (!isOverrideMode(cfgRes.row.override_mode)) {
    return {
      ok: false,
      res: c.json(
        { error: 'invalid_override_mode', reason: `The commission override mode is set to "${cfgRes.row.override_mode}", which this system does not recognise, so no commission can be calculated. Set it to Showroom or Chain in HR Settings.` },
        409,
      ),
    };
  }
  const mode: OverrideMode = cfgRes.row.override_mode;

  const lvRes = await loadOverrideLevels(c, companyId);
  if (!lvRes.ok) return { ok: false, res: lvRes.res };
  const levels = lvRes.levels;

  if (mode === 'chain' && levels.length === 0) {
    return {
      ok: false,
      res: c.json(
        { error: 'no_override_levels', reason: 'Commission is set to chain override mode but no override levels are configured, so every manager would earn RM 0 override. Add the levels in HR Settings, or switch back to showroom mode.' },
        409,
      ),
    };
  }

  type ProfRow = { staff_id: string; tier: string; showroom_id: string };
  const profRes = await paginateAll<ProfRow>((f, t) => sb
    .from('hr_salesperson_profiles')
    .select('staff_id, tier, showroom_id')
    .eq('active', true)
    .eq('company_id', co.companyId)
    .order('staff_id')
    .range(f, t),
  );
  if (profRes.error) return { ok: false, res: c.json({ error: 'profiles_failed', reason: profRes.error.message }, 500) };
  const profiles = profRes.data ?? [];
  const staffLite = await loadStaffLite(sb, profiles.map((p) => p.staff_id));
  if (staffLite.error) return { ok: false, res: c.json({ error: 'profiles_failed', reason: staffLite.error.message }, 500) };
  const staffName = new Map<string, string>(profiles.map((p) => [p.staff_id, staffLite.data.get(p.staff_id)?.name ?? '']));

  const showroomRes = await paginateAll<{ id: string; name: string }>((f, t) => sb
    .from('showrooms').select('id, name').eq('company_id', co.companyId).order('id').range(f, t));
  if (showroomRes.error) return { ok: false, res: c.json({ error: 'showrooms_failed', reason: showroomRes.error.message }, 500) };
  const showroomName = new Map<string, string>((showroomRes.data ?? []).map((s) => [s.id, s.name]));

  const ordRes = await paginateAll<OrderRow>((f, t) => sb
    .from('mfg_sales_orders')
    .select('doc_no, salesperson_id, mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen')
    .gte('so_date', from)
    .lte('so_date', to)
    .not('status', 'in', COMMISSION_EXCLUDED_STATUS_FILTER)
    .eq('on_hold', false)
    .eq('company_id', co.companyId)
    .order('doc_no')
    .range(f, t),
  );
  if (ordRes.error) return { ok: false, res: c.json({ error: 'orders_failed', reason: ordRes.error.message }, 500) };
  const orders = ordRes.data ?? [];

  const personalGoods = new Map<string, number>();
  const docToSalesperson = new Map<string, string>();
  for (const o of orders) {
    if (!o.salesperson_id) continue;
    personalGoods.set(o.salesperson_id, (personalGoods.get(o.salesperson_id) ?? 0) + goodsOf(o));
    docToSalesperson.set(o.doc_no, o.salesperson_id);
  }

  const itemKpiSen = new Map<string, number>();
  const kpiExcludedGoods = new Map<string, number>();
  const kpiDetail = new Map<string, Map<string, { label: string; qty: number; bonusSen: number; lineSen: number }>>();
  if (docToSalesperson.size > 0) {
    let kpi;
    try {
      kpi = await loadKpiUnitsByDoc(sb, [...docToSalesperson.keys()], co.companyId);
    } catch (e) {
      return { ok: false, res: c.json({ error: 'kpi_failed', reason: e instanceof Error ? e.message : String(e) }, 500) };
    }
    const { flags, flagLabel, unitsByDoc } = kpi;
    for (const [docNo, units] of unitsByDoc) {
      const sp = docToSalesperson.get(docNo);
      if (!sp) continue;
      for (const u of units) {
        const bonus = unitKpiSen(u, flags);
        const excluded = unitKpiExcludedSen(u, flags);
        if (bonus > 0) itemKpiSen.set(sp, (itemKpiSen.get(sp) ?? 0) + bonus);
        if (excluded > 0) kpiExcludedGoods.set(sp, (kpiExcludedGoods.get(sp) ?? 0) + excluded);
        if (bonus <= 0) continue;
        for (const f of flags) {
          if (!kpiFlagFiresOnUnit(f, u, flags)) continue;
          const key = `${f.flagType}:${f.ref}`;
          if (!kpiDetail.has(sp)) kpiDetail.set(sp, new Map());
          const m = kpiDetail.get(sp)!;
          const prev = m.get(key) ?? { label: flagLabel.get(key) ?? f.ref, qty: 0, bonusSen: f.bonusSen, lineSen: 0 };
          prev.qty += u.qty;
          prev.lineSen += u.qty * f.bonusSen;
          m.set(key, prev);
        }
      }
    }
  }

  const commissionableGoods = new Map<string, number>();
  for (const p of profiles) {
    commissionableGoods.set(
      p.staff_id,
      Math.max(0, (personalGoods.get(p.staff_id) ?? 0) - (kpiExcludedGoods.get(p.staff_id) ?? 0)),
    );
  }

  const chainGoods = new Map<string, Map<number, number>>();
  if (mode === 'chain') {
    const rolled = await rollUpChainGoods(c, companyId, profiles, commissionableGoods, levels);
    if (!rolled.ok) return { ok: false, res: rolled.res };
    for (const [k, v] of rolled.goods) chainGoods.set(k, v);
  }

  const byShowroom = new Map<string, SalespersonInput[]>();
  for (const p of profiles) {
    const sid = p.showroom_id;
    if (!byShowroom.has(sid)) byShowroom.set(sid, []);
    byShowroom.get(sid)!.push({
      staffId: p.staff_id,
      tier: p.tier as 'sales' | 'manager',
      personalGoodsSen: commissionableGoods.get(p.staff_id) ?? 0,
      itemKpiSen: itemKpiSen.get(p.staff_id) ?? 0,
    });
  }

  const showrooms: BuiltShowroom[] = [...byShowroom.entries()].map(([sid, people]) => {
    const sg = people.reduce((acc, m) => acc + m.personalGoodsSen, 0);
    const computed = mode === 'chain'
      ? computeChainCommission(config, sg, levels, people.map((p) => ({
          ...p,
          goodsByLevel: chainGoods.get(p.staffId) ?? new Map<number, number>(),
        })))
      : computeShowroomCommission(config, sg, people);
    const rows: BuiltRow[] = computed.map((r) => ({
      ...r,
      staffName: staffName.get(r.staffId) ?? '',
      kpiDetail: [...(kpiDetail.get(r.staffId)?.values() ?? [])],
    }));
    rows.sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9));
    return {
      showroomId: sid,
      showroomName: showroomName.get(sid) ?? sid,
      showroomGoodsSen: sg,
      showroomKpiHit: sg >= config.showroomKpiThresholdSen,
      rows,
    };
  });

  return { ok: true, built: { configRow: cfgRes.row, mode, levels, showrooms } };
}


const PERIOD_SELECT =
  'id, company_id, period_from, period_to, revision, status, engine_version, config_snapshot, override_mode, override_levels_snapshot, total_sen, row_count, closed_by_name, closed_at, reopened_by_name, reopened_at, reopen_reason';

type PeriodRow = {
  id: string; period_from: string; period_to: string; revision: number; status: string;
  engine_version: string; config_snapshot: unknown; override_mode: string;
  override_levels_snapshot: unknown; total_sen: number; row_count: number;
  closed_by_name: string; closed_at: string;
  reopened_by_name: string | null; reopened_at: string | null; reopen_reason: string | null;
};

type PayoutRowRec = {
  staff_id: string; staff_name: string; showroom_id: string | null; showroom_name: string;
  showroom_goods_sen: number; showroom_kpi_hit: boolean; tier: string;
  personal_goods_sen: number; personal_rate_bps: number; personal_commission_sen: number;
  override_rate_bps: number | null; override_commission_sen: number; override_detail: unknown;
  item_kpi_sen: number; kpi_detail: unknown; total_sen: number; sort_index: number;
};

const PAYOUT_ROW_SELECT =
  'staff_id, staff_name, showroom_id, showroom_name, showroom_goods_sen, showroom_kpi_hit, tier, personal_goods_sen, personal_rate_bps, personal_commission_sen, override_rate_bps, override_commission_sen, override_detail, item_kpi_sen, kpi_detail, total_sen, sort_index';

async function loadClosedPeriod(
  c: HrContext,
  companyId: number,
  from: string,
  to: string,
): Promise<{ ok: true; period: PeriodRow | null } | { ok: false; res: Response }> {
  const sb = c.get('supabase');
  const { data, error } = await sb
    .from('hr_payout_periods')
    .select(PERIOD_SELECT)
    .eq('company_id', companyId)
    .eq('period_from', from)
    .eq('period_to', to)
    .eq('status', 'CLOSED')
    .maybeSingle();
  if (error) return { ok: false, res: c.json({ error: 'payout_read_failed', reason: error.message }, 500) };
  return { ok: true, period: (data as PeriodRow | null) ?? null };
}

const toPeriodApi = (p: PeriodRow) => ({
  id: p.id,
  from: p.period_from,
  to: p.period_to,
  revision: p.revision,
  status: p.status,
  engineVersion: p.engine_version,
  totalSen: p.total_sen,
  rowCount: p.row_count,
  closedByName: p.closed_by_name,
  closedAt: p.closed_at,
  reopenedByName: p.reopened_by_name,
  reopenedAt: p.reopened_at,
  reopenReason: p.reopen_reason,
});

function parseRange(from: string, to: string, c: HrContext): { ok: true } | { ok: false; res: Response } {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return { ok: false, res: c.json({ error: 'invalid_range', reason: 'from and to must be YYYY-MM-DD' }, 400) };
  if (from > to) return { ok: false, res: c.json({ error: 'invalid_range', reason: 'from must be <= to' }, 400) };
  return { ok: true };
}

function frozenToShowrooms(rows: PayoutRowRec[]): BuiltShowroom[] {
  const ordered = [...rows].sort((a, b) => a.sort_index - b.sort_index);
  const out: BuiltShowroom[] = [];
  const index = new Map<string, BuiltShowroom>();
  for (const r of ordered) {
    const sid = r.showroom_id ?? '';
    let sr = index.get(sid);
    if (!sr) {
      sr = {
        showroomId: sid,
        showroomName: r.showroom_name,
        showroomGoodsSen: r.showroom_goods_sen,
        showroomKpiHit: r.showroom_kpi_hit,
        rows: [],
      };
      index.set(sid, sr);
      out.push(sr);
    }
    sr.rows.push({
      staffId: r.staff_id,
      staffName: r.staff_name,
      tier: r.tier as 'sales' | 'manager',
      personalGoodsSen: r.personal_goods_sen,
      personalRateBps: r.personal_rate_bps,
      personalCommissionSen: r.personal_commission_sen,
      overrideRateBps: r.override_rate_bps,
      overrideCommissionSen: r.override_commission_sen,
      overrideDetail: (r.override_detail as BuiltRow['overrideDetail']) ?? undefined,
      itemKpiSen: r.item_kpi_sen,
      kpiDetail: (r.kpi_detail as BuiltRow['kpiDetail']) ?? [],
      totalSen: r.total_sen,
    });
  }
  return out;
}

hr.get('/commission', async (c) => {
  if (!hasHouzsPerm(c, HR_READ)) return forbidden(c, HR_READ);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const from = (c.req.query('from') ?? '').trim();
  const to = (c.req.query('to') ?? '').trim();
  const range = parseRange(from, to, c);
  if (!range.ok) return range.res;

  const closed = await loadClosedPeriod(c, co.companyId, from, to);
  if (!closed.ok) return closed.res;
  if (closed.period) {
    const sb = c.get('supabase');
    const rowsRes = await paginateAll<PayoutRowRec>((f, t) => scopeToCompanyId(sb
      .from('hr_payout_rows')
      .select(PAYOUT_ROW_SELECT)
      .eq('period_id', closed.period!.id), co.companyId)
      .order('sort_index')
      .range(f, t),
    );
    if (rowsRes.error) return c.json({ error: 'payout_read_failed', reason: rowsRes.error.message }, 500);
    return c.json({
      from,
      to,
      config: closed.period.config_snapshot,
      overrideMode: closed.period.override_mode,
      overrideLevels: closed.period.override_levels_snapshot,
      closed: toPeriodApi(closed.period),
      showrooms: frozenToShowrooms(rowsRes.data ?? []),
    });
  }

  const built = await buildCommissionLive(c, co.companyId, from, to);
  if (!built.ok) return built.res;
  return c.json({
    from,
    to,
    config: toConfigApi(built.built.configRow),
    overrideMode: built.built.mode,
    overrideLevels: built.built.levels,
    closed: null,
    showrooms: built.built.showrooms,
  });
});

hr.get('/payout/periods', async (c) => {
  if (!hasHouzsPerm(c, HR_READ)) return forbidden(c, HR_READ);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const sb = c.get('supabase');
  const { data, error } = await paginateAll<PeriodRow>((f, t) => sb
    .from('hr_payout_periods')
    .select(PERIOD_SELECT)
    .eq('company_id', co.companyId)
    .neq('status', 'PENDING')
    .order('period_from', { ascending: false })
    .order('revision', { ascending: false })
    .range(f, t),
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ periods: (data ?? []).map(toPeriodApi) });
});

const closeSchema = z.object({
  from: z.string().regex(ISO_DATE),
  to: z.string().regex(ISO_DATE),
});

hr.post('/payout/close', async (c) => {
  if (!hasHouzsPerm(c, 'scm.hr.close')) return forbidden(c, 'scm.hr.close');
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = closeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: issues(parsed.error) }, 400);
  const { from, to } = parsed.data;
  const range = parseRange(from, to, c);
  if (!range.ok) return range.res;

  const sb = c.get('supabase');

  const existing = await loadClosedPeriod(c, co.companyId, from, to);
  if (!existing.ok) return existing.res;
  if (existing.period) {
    return c.json(
      { error: 'already_closed', reason: `This period was already closed on ${existing.period.closed_at} by ${existing.period.closed_by_name || 'an unknown user'}. Reopen it first if it needs to change.` },
      409,
    );
  }

  const built = await buildCommissionLive(c, co.companyId, from, to);
  if (!built.ok) return built.res;
  const { configRow, mode, levels, showrooms } = built.built;

  const revRes = await sb
    .from('hr_payout_periods')
    .select('revision')
    .eq('company_id', co.companyId)
    .eq('period_from', from)
    .eq('period_to', to)
    .order('revision', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (revRes.error) return c.json({ error: 'payout_read_failed', reason: revRes.error.message }, 500);
  const revision = ((revRes.data as { revision?: number } | null)?.revision ?? 0) + 1;

  const flat = showrooms.flatMap((s) => s.rows.map((r) => ({ showroom: s, row: r })));
  const totalSen = flat.reduce((acc, x) => acc + x.row.totalSen, 0);

  const hu = c.get('houzsUser');
  const period = {
    company_id: co.companyId,
    period_from: from,
    period_to: to,
    revision,
    status: 'PENDING',
    engine_version: COMMISSION_ENGINE_VERSION,
    config_snapshot: toConfigApi(configRow),
    override_mode: mode,
    override_levels_snapshot: levels,
    total_sen: totalSen,
    row_count: flat.length,
    closed_by_staff_id: await resolveCallerStaffId(sb, hu?.id),
    closed_by_user_id: hu?.id ?? null,
    closed_by_name: hu?.name ?? '',
    closed_at: new Date().toISOString(),
  };

  const insRes = await sb.from('hr_payout_periods').insert(period).select('id').single();
  if (insRes.error) return c.json({ error: 'close_failed', reason: insRes.error.message }, 500);
  const periodId = (insRes.data as { id: string }).id;

  const abandon = async () => {
    const del = await sb.from('hr_payout_periods').delete().eq('id', periodId);
    if (del.error) console.log(`[hr] abandoned close ${periodId} left behind: ${del.error.message}`);
  };

  const payloads = flat.map(({ showroom, row }, i) => ({
    period_id: periodId,
    company_id: co.companyId,
    staff_id: row.staffId,
    staff_name: row.staffName,
    showroom_id: showroom.showroomId || null,
    showroom_name: showroom.showroomName,
    showroom_goods_sen: showroom.showroomGoodsSen,
    showroom_kpi_hit: showroom.showroomKpiHit,
    tier: row.tier,
    personal_goods_sen: row.personalGoodsSen,
    personal_rate_bps: row.personalRateBps,
    personal_commission_sen: row.personalCommissionSen,
    override_rate_bps: row.overrideRateBps,
    override_commission_sen: row.overrideCommissionSen,
    override_detail: row.overrideDetail ?? null,
    item_kpi_sen: row.itemKpiSen,
    kpi_detail: row.kpiDetail,
    total_sen: row.totalSen,
    sort_index: i, // global order — frozenToShowrooms rebuilds the exact shape
  }));

  for (let i = 0; i < payloads.length; i += 200) {
    const { error } = await sb.from('hr_payout_rows').insert(payloads.slice(i, i + 200));
    if (error) {
      await abandon();
      return c.json({ error: 'close_failed', reason: error.message }, 500);
    }
  }

  const commit = await sb
    .from('hr_payout_periods')
    .update({ status: 'CLOSED' })
    .eq('id', periodId)
    .select(PERIOD_SELECT)
    .maybeSingle();
  if (commit.error) {
    await abandon();
    if (commit.error.code === '23505') {
      return c.json({ error: 'already_closed', reason: 'This period was closed by someone else while this close was running. Reload to see the figures that were saved.' }, 409);
    }
    return c.json({ error: 'close_failed', reason: commit.error.message }, 500);
  }
  if (!commit.data) {
    await abandon();
    return c.json({ error: 'close_failed', reason: 'The period could not be finalised.' }, 500);
  }
  return c.json({ closed: toPeriodApi(commit.data as PeriodRow) }, 201);
});

const reopenSchema = z.object({
  from: z.string().regex(ISO_DATE),
  to: z.string().regex(ISO_DATE),
  reason: z.string().trim().min(1),
});

hr.post('/payout/reopen', async (c) => {
  /* company-scope: scoped INDIRECTLY, which is why an automated check flags it.
     The row is never addressed by a caller-supplied id - loadClosedPeriod
     (hr.ts:1178) resolves it from (company_id, period_from, period_to) with
     `.eq('company_id', companyId)` on the line, and the UPDATE below targets
     `existing.period.id`, an id that only exists because it was already found
     inside this company. Verified 2026-08-13 by reading that function. */
  if (!hasHouzsPerm(c, 'scm.hr.reopen')) return forbidden(c, 'scm.hr.reopen');
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = reopenSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: issues(parsed.error) }, 400);
  const { from, to, reason } = parsed.data;

  const existing = await loadClosedPeriod(c, co.companyId, from, to);
  if (!existing.ok) return existing.res;
  if (!existing.period) return c.json({ error: 'not_closed', reason: 'This period is not closed, so there is nothing to reopen.' }, 409);

  const sb = c.get('supabase');
  const hu = c.get('houzsUser');
  const { data, error } = await sb
    .from('hr_payout_periods')
    .update({
      status: 'REOPENED',
      reopened_by_user_id: hu?.id ?? null,
      reopened_by_name: hu?.name ?? '',
      reopened_at: new Date().toISOString(),
      reopen_reason: reason,
    })
    .eq('id', existing.period.id)
    .eq('company_id', co.companyId)
    .eq('status', 'CLOSED')
    .select(PERIOD_SELECT)
    .maybeSingle();
  if (error) return c.json({ error: 'reopen_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_closed', reason: 'This period was already reopened by someone else.' }, 409);
  return c.json({ reopened: toPeriodApi(data as PeriodRow) });
});
