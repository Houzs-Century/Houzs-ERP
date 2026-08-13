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
  unitKpiCenti,
  unitKpiExcludedCenti,
  type CommissionConfig,
  type CommissionRow,
  type OverrideLevel,
  type SalespersonInput,
} from '../shared/hr-commission';
import { MFG_PRODUCT_CATEGORIES } from './mfg-products';
import { loadKpiUnitsByDoc } from '../lib/kpi-units';
import { supabaseAuth } from '../middleware/auth';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { activeCompanyId } from '../lib/companyScope';
import { resolveCallerStaffId } from '../lib/salesScope';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { uplineChainSteps } from '../../services/orgScope';
import type { Env, Variables } from '../env';

export const hr = new Hono<{ Bindings: Env; Variables: Variables }>();

hr.use('*', supabaseAuth);

type HrContext = Context<{ Bindings: Env; Variables: Variables }>;

const HR_READ = 'scm.hr.read';
const HR_MANAGE = 'scm.hr.manage';

const forbidden = (c: HrContext, perm: string) =>
  c.json({ error: 'forbidden', reason: `missing ${perm}` }, 403);

/* The active company, or a refusal. See COMPANY SCOPE above — HR does not
   degrade to unscoped like the rest of SCM. 503 (not 500): the usual cause is a
   Hyperdrive/companies-master cold start, which self-heals on retry. */
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

// ── config ───────────────────────────────────────────────────────────────
const CONFIG_SELECT =
  'base_bps, personal_kpi_threshold_centi, personal_kpi_bonus_bps, showroom_kpi_threshold_centi, showroom_kpi_bonus_bps, override_base_bps, override_kpi_bonus_bps, override_mode, updated_at';

type ConfigRow = {
  base_bps: number;
  personal_kpi_threshold_centi: number;
  personal_kpi_bonus_bps: number;
  showroom_kpi_threshold_centi: number;
  showroom_kpi_bonus_bps: number;
  override_base_bps: number;
  override_kpi_bonus_bps: number;
  override_mode: string;
  updated_at?: string;
};

/* Which override model this company pays (migration 0124). 'showroom' is 2990's
   flat-per-showroom override, 'chain' is the owner's recursive reporting-line
   one. NEVER BOTH — running them together pays a manager twice on overlapping
   goods. An unrecognised value is refused rather than defaulted: a typo'd mode
   silently falling back to a payout model is the whole class of bug this module
   is written against. */
type OverrideMode = 'showroom' | 'chain';
const isOverrideMode = (v: unknown): v is OverrideMode => v === 'showroom' || v === 'chain';

const toConfigApi = (r: ConfigRow) => ({
  baseBps: r.base_bps,
  personalKpiThresholdCenti: r.personal_kpi_threshold_centi,
  personalKpiBonusBps: r.personal_kpi_bonus_bps,
  showroomKpiThresholdCenti: r.showroom_kpi_threshold_centi,
  showroomKpiBonusBps: r.showroom_kpi_bonus_bps,
  overrideBaseBps: r.override_base_bps,
  overrideKpiBonusBps: r.override_kpi_bonus_bps,
  overrideMode: r.override_mode,
  updatedAt: r.updated_at,
});

const toConfig = (r: ConfigRow): CommissionConfig => ({
  baseBps: r.base_bps,
  personalKpiThresholdCenti: r.personal_kpi_threshold_centi,
  personalKpiBonusBps: r.personal_kpi_bonus_bps,
  showroomKpiThresholdCenti: r.showroom_kpi_threshold_centi,
  showroomKpiBonusBps: r.showroom_kpi_bonus_bps,
  overrideBaseBps: r.override_base_bps,
  overrideKpiBonusBps: r.override_kpi_bonus_bps,
});

/* Load THIS company's config row. 2990 keys the singleton `.eq('id', 1)`;
   Houzs keys on company_id (migration 0123 retired the singleton, because a
   HOUZS-stamped row is invisible to a 2990-scoped read — and an invisible
   config must not become a 0% rate). A missing row is an explicit error: the
   module cannot honestly compute anything without it. */
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
  personalKpiThresholdCenti: z.number().int().nonnegative().optional(),
  personalKpiBonusBps: z.number().int().nonnegative().optional(),
  showroomKpiThresholdCenti: z.number().int().nonnegative().optional(),
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
  /* 2990 stamps updated_by with the Supabase auth uid, which IS its staff id.
     In Houzs the real caller is a public.users INTEGER (houzsUser.id) and the
     column is uuid, so we map through the mig-0066 staff link. Not c.get('user')
     .id — that is the bridge's pinned system row, and attributing every rate
     change on a PAYROLL table to "system" is an audit lie. null when the caller
     has no staff row: unattributed is honest, wrongly-attributed is not. */
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: await resolveCallerStaffId(sb, c.get('houzsUser')?.id),
  };
  const d = parsed.data;
  if (d.baseBps !== undefined) patch.base_bps = d.baseBps;
  if (d.personalKpiThresholdCenti !== undefined) patch.personal_kpi_threshold_centi = d.personalKpiThresholdCenti;
  if (d.personalKpiBonusBps !== undefined) patch.personal_kpi_bonus_bps = d.personalKpiBonusBps;
  if (d.showroomKpiThresholdCenti !== undefined) patch.showroom_kpi_threshold_centi = d.showroomKpiThresholdCenti;
  if (d.showroomKpiBonusBps !== undefined) patch.showroom_kpi_bonus_bps = d.showroomKpiBonusBps;
  if (d.overrideBaseBps !== undefined) patch.override_base_bps = d.overrideBaseBps;
  if (d.overrideKpiBonusBps !== undefined) patch.override_kpi_bonus_bps = d.overrideKpiBonusBps;
  if (d.overrideMode !== undefined) patch.override_mode = d.overrideMode;

  /* Switching TO chain with no levels configured would pay every manager a
     RM 0 override on the next run. Refuse the switch at the door — the report
     refuses too, but failing here means the config can never be left in a state
     that the report cannot honour. */
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

// ── salesperson profiles ───────────────────────────────────────────────────
const PROFILE_SELECT = 'id, staff_id, tier, showroom_id, active, created_at, updated_at';

type ProfileRow = {
  id: string; staff_id: string; tier: string; showroom_id: string; active: boolean;
  created_at: string; updated_at: string;
};

type StaffLite = { name: string; staffCode: string };

/* Staff labels for a set of profiles.
 *
 * 2990 pulls these with a PostgREST embed (`staff:staff(name, staff_code)`).
 * Not ported, for two reasons:
 *   · an embed needs PostgREST to KNOW the hr_salesperson_profiles.staff_id ->
 *     staff.id FK from its schema cache. These tables were applied out-of-band
 *     and migration 0123 may be the thing that creates them, in which case the
 *     cache is stale until a reload — the embed would 400 while a plain read
 *     works fine. Payroll should not depend on the cache being warm.
 *   · supabase-js types a to-one embed as an ARRAY without generated DB types;
 *     2990 hides that with `data as ProfileRow[]`, which is a cast over a shape
 *     the compiler actively disagrees with.
 * A keyed lookup is one extra query on a table with a handful of rows. */
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
    // 23505 is now the COMPOSITE (company_id, staff_id) key — migration 0089
    // converted 2990's bare UNIQUE(staff_id) so both companies can profile the
    // same shared staff row (scm.staff is deliberately not company-scoped).
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
  // company_id on the WHERE, not just the read: an id alone would let one
  // company edit the other's profile (404 is also what a wrong-company id
  // should look like).
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

// ── item KPIs ───────────────────────────────────────────────────────────────
const ITEM_KPI_SELECT = 'id, flag_type, ref, label, bonus_centi, active, created_at, updated_at';

type ItemKpiRow = {
  id: string; flag_type: 'product' | 'category' | 'fabric' | 'special'; ref: string;
  label: string; bonus_centi: number; active: boolean;
};

const toItemKpiApi = (r: ItemKpiRow) => ({
  id: r.id,
  flagType: r.flag_type,
  ref: r.ref,
  label: r.label,
  bonusCenti: r.bonus_centi,
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
  bonusCenti: z.number().int().nonnegative(),
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
      bonus_centi: parsed.data.bonusCenti,
      active: parsed.data.active,
      company_id: co.companyId,
    })
    .select(ITEM_KPI_SELECT)
    .single();
  if (error) return c.json({ error: 'create_failed', reason: error.message }, 500);
  return c.json({ item: toItemKpiApi(data as ItemKpiRow) }, 201);
});

const itemKpiPatchSchema = z.object({
  label: z.string().optional(),
  bonusCenti: z.number().int().nonnegative().optional(),
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
  if (parsed.data.bonusCenti !== undefined) patch.bonus_centi = parsed.data.bonusCenti;
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

/* This company's ACTIVE override levels. An empty list is a legitimate answer
   ("none configured"), NOT a failure — the CALLER decides whether empty is
   acceptable for what it is doing (fatal in chain mode, irrelevant in showroom
   mode). A read failure stays an explicit error and never collapses into the
   empty list: those two must not look alike, or a transient PostgREST error
   silently zeroes every override in the company. */
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
  // Unlike loadOverrideLevels this lists INACTIVE rows too — the settings screen
  // must show a switched-off level, not pretend it was never configured.
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
    // UNIQUE (company_id, level) — one rate per level. Two rows for level 2
    // would make "the level 2 rate" ambiguous, i.e. a payout nobody can predict.
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

/* `level` itself is NOT patchable — renumbering a level in place silently
   repoints an existing rate at a different set of people. Delete and re-add. */
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

// ── pickers: assignable staff + showrooms + products/fabrics/specials to flag ──
hr.get('/pickers', async (c) => {
  if (!hasHouzsPerm(c, HR_READ)) return forbidden(c, HR_READ);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const sb = c.get('supabase');

  /* scm.staff is deliberately NOT company-scoped (0089: "Deliberately NOT
     stamped — staff, currencies, ..."), so the staff picker is unscoped by
     design; every other picker feeds a company-scoped ref and is scoped. */
  const [staffRes, showroomRes, productRes, fabricRes, specialRes] = await Promise.all([
    paginateAll<{ id: string; name: string; staff_code: string; role: string }>((from, to) =>
      sb.from('staff').select('id, name, staff_code, role, active').eq('active', true).order('name').range(from, to)),
    paginateAll<{ id: string; name: string }>((from, to) =>
      sb.from('showrooms').select('id, name').eq('active', true).eq('company_id', co.companyId).order('sort_order').range(from, to)),
    paginateAll<{ code: string; name: string }>((from, to) =>
      sb.from('mfg_products').select('code, name').eq('pos_active', true).eq('company_id', co.companyId).order('code').range(from, to)),
    paginateAll<{ id: string; label: string }>((from, to) =>
      sb.from('fabric_library').select('id, label').eq('company_id', co.companyId).order('label').range(from, to)),
    paginateAll<{ code: string; label: string }>((from, to) =>
      sb.from('special_addons').select('code, label').eq('company_id', co.companyId).order('label').range(from, to)),
  ]);
  const firstErr = staffRes.error || showroomRes.error || productRes.error || fabricRes.error || specialRes.error;
  if (firstErr) return c.json({ error: 'fetch_failed', reason: firstErr.message }, 500);

  return c.json({
    staff: (staffRes.data ?? []).map((s) => ({ id: s.id, name: s.name, staffCode: s.staff_code, role: s.role })),
    showrooms: (showroomRes.data ?? []).map((s) => ({ id: s.id, name: s.name })),
    products: (productRes.data ?? []).map((p) => ({ ref: p.code, label: `${p.code} — ${p.name}` })),
    /* Categories are the mfg_product_category ENUM, not a table — there is no
       row to read and no company scoping to apply. Imported from mfg-products so
       the picker cannot offer a value mfg_products.category could not hold; a
       category rule is matched against exactly that column (kpi-units.ts). */
    categories: MFG_PRODUCT_CATEGORIES.map((code) => ({ ref: code, label: code })),
    fabrics: (fabricRes.data ?? []).map((f) => ({ ref: f.id, label: f.label })),
    specials: (specialRes.data ?? []).map((s) => ({ ref: s.code, label: s.label })),
  });
});

// ── commission computation ──────────────────────────────────────────────────
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/* The PostgREST rendering of the shared COMMISSION_EXCLUDED_STATUSES rule. The
   LIST lives in ../shared/hr-commission (it is a commission rule, and a rule in
   a route file is a rule no test can reach); this is only its wire format, so
   the query and the tested predicate cannot drift.

   WHAT THIS FILTER TOUCHES, checked rather than assumed (it is wider than "draft
   people don't get paid"):
     · The item-KPI pass is driven by docToSalesperson, which is built FROM this
       query's survivors, so a DRAFT's fixed bonuses and its goods exclusion drop
       out with it automatically. There is exactly ONE status predicate in this
       module and this is it — kpi-units.ts deliberately has none.
     · The showroom total is Σ of its profiled members' goods, so dropping DRAFTs
       LOWERS it, which can push a showroom back under the RM 400k gate and cut
       the rate for EVERY member of that room, not just the DRAFT's owner. That
       is the correct direction (a DRAFT is not a sale) and it is why this is not
       a one-person change.
     · scan-so lands every OCR'd slip as a DRAFT for an operator to review
       ("The whole point: land as DRAFT" — scan-so.ts). Those unreviewed,
       machine-read slips have been paying commission. That is the live bite.
   The `(CANCELLED,ON_HOLD)` string appears nowhere else in the codebase — no
   other route shares this predicate, so nothing else moves. mfg-sales-orders'
   /mine board already excludes exactly these three, which is the precedent this
   now matches. */
const COMMISSION_EXCLUDED_STATUS_FILTER = `(${COMMISSION_EXCLUDED_STATUSES.join(',')})`;

type OrderRow = {
  doc_no: string;
  salesperson_id: string | null;
  mattress_sofa_centi: number | null;
  bedframe_centi: number | null;
  accessories_centi: number | null;
  others_centi: number | null;
};

/* Goods that drive commission = the four GOODS category buckets only. Delivery
 * fee + SERVICE-category lines (SVC-DELIVERY* / dispose / lift) live in their own
 * `service_centi` bucket (recomputeTotals routes them there FIRST so they can
 * never leak into goods) and `delivery_fee_centi` is a separate header column —
 * neither is summed here. So delivery + service are ALREADY excluded from both
 * the % commission and the 100k/400k thresholds (Loo 2026-06-20). The item-KPI
 * add-on exclusion below removes the remaining flagged-add-on amounts.
 *
 * The `?? 0` here is 2990's and is CORRECT — these four columns are NOT NULL
 * DEFAULT 0 in the schema, so the coalesce is a type narrowing, not a guess
 * about an unknown. Contrast the config/read paths above, where a missing value
 * genuinely means "unknown" and is an explicit error. */
const goodsOf = (o: OrderRow): number =>
  (o.mattress_sofa_centi ?? 0) + (o.bedframe_centi ?? 0) + (o.accessories_centi ?? 0) + (o.others_centi ?? 0);

// display order within a showroom: managers (tier 2) first, then sales (tier 1).
const TIER_RANK: Record<string, number> = { manager: 0, sales: 1 };

type ProfileLite = { staff_id: string; tier: string; showroom_id: string };

/**
 * Roll each profiled seller's commissionable goods UP their reporting line, so
 * every earner ends up with "Σ goods of my downline, per level".
 *
 * ── THE ID BRIDGE (the only link between the two id spaces) ─────────────────
 *   SO.salesperson_id → scm.staff.id → staff.user_id → public.users.id → walk
 *   up users.manager_id. Migration 0066 gives every non-disabled user a
 *   deterministic staff row and is what makes this join exist at all
 *   (scm/lib/salesScope.ts resolves the same bridge in the other direction).
 *
 * ── THE DOUBLE-PAY GUARD ────────────────────────────────────────────────────
 * 2990's flat model pays the FULL showroom override to EVERY manager in a
 * showroom, so two managers in one room bill the company twice for one room —
 * a live 2990 bug. Nothing here can reproduce it:
 *   · d=0 (the seller) is never emitted by uplineChainSteps, so nobody earns an
 *     override on their own sale on top of their personal commission.
 *   · the walk's visited-set means each ancestor is reached at most ONCE per
 *     seller, at exactly one distance — so one seller's goods enter one
 *     earner's base exactly once, at one level.
 *   · two managers stacked in one line (A → M1 → M2) both earn on A's goods,
 *     but at DIFFERENT levels with DIFFERENT rates, once each. That is the
 *     pyramid the owner asked for, not the bug.
 *
 * ── WHO IS DELIBERATELY LEFT OUT (each one under-pays, never over-pays) ─────
 *   · a seller with no active HR profile — their goods roll up to nobody. They
 *     are already invisible to the report and to every showroom total, so the
 *     scheme does not know them.
 *   · an ancestor with no active HR profile — a real manager in the org tree who
 *     is not on the commission scheme earns nothing. The profile IS the scheme.
 *   · a seller or ancestor whose staff row has no user_id link — unbridgeable,
 *     so unwalkable. This is the one that most deserves a staging check: it is
 *     silent, and it looks exactly like "has no downline".
 *
 * Cost: one walk per profiled seller, each up to maxLevel single-row lookups.
 * A payroll screen opened a few times a month over tens of profiles — reusing
 * orgScope's cycle-guarded walk is worth more here than a bespoke bulk query
 * with a second copy of the guard.
 */
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
  /* A failed bridge read must NOT degrade into "nobody has a manager" — that
     pays every override as RM 0 while looking like a correct org chart. */
  if (linkRes.error) {
    return { ok: false, res: c.json({ error: 'chain_link_failed', reason: linkRes.error.message }, 500) };
  }

  const userIdOfStaff = new Map<string, number>();
  const staffIdOfUser = new Map<number, string>();
  for (const r of linkRes.data) {
    const uid = Number(r.user_id);
    if (!r.user_id || !Number.isFinite(uid)) continue; // unbridgeable — see above
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
    if (sellerGoods <= 0) continue; // nothing to roll up
    const sellerUserId = userIdOfStaff.get(p.staff_id);
    if (sellerUserId === undefined) continue; // unbridgeable seller
    const steps = await uplineChainSteps(c.env, sellerUserId, maxLevel);
    for (const step of steps) {
      const earnerStaffId = staffIdOfUser.get(step.userId);
      if (earnerStaffId === undefined) continue; // ancestor not on the scheme
      const byLevel = goods.get(earnerStaffId) ?? new Map<number, number>();
      byLevel.set(step.level, (byLevel.get(step.level) ?? 0) + sellerGoods);
      goods.set(earnerStaffId, byLevel);
    }
  }
  return { ok: true, goods };
}

type BuiltRow = CommissionRow & {
  staffName: string;
  kpiDetail: Array<{ label: string; qty: number; bonusCenti: number; lineCenti: number }>;
};
type BuiltShowroom = {
  showroomId: string;
  showroomName: string;
  showroomGoodsCenti: number;
  showroomKpiHit: boolean;
  rows: BuiltRow[];
};
type BuiltCommission = {
  configRow: ConfigRow;
  mode: OverrideMode;
  levels: OverrideLevel[];
  showrooms: BuiltShowroom[];
};

/**
 * Compute one period's commission LIVE from the current config.
 *
 * Factored out of the GET handler so that GET /commission and POST
 * /payout/close run the SAME engine over the SAME inputs. Two call paths each
 * computing "the payout" their own way is how a closed period stops matching the
 * report it was closed from — the frozen figure MUST be the figure the owner was
 * looking at when he approved it.
 */
async function buildCommissionLive(
  c: HrContext,
  companyId: number,
  from: string,
  to: string,
): Promise<{ ok: true; built: BuiltCommission } | { ok: false; res: Response }> {
  const co = { companyId };
  const sb = c.get('supabase');

  // config
  const cfgRes = await loadConfigRow(c, companyId);
  if (!cfgRes.ok) return { ok: false, res: cfgRes.res };
  const config = toConfig(cfgRes.row);

  /* An unrecognised override_mode is REFUSED, never defaulted. The CHECK
     constraint in 0124 makes this near-unreachable — but "near-unreachable" and
     "silently pays the other model" is not a trade worth taking on payroll. */
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

  /* Chain mode with zero configured levels would hand every manager in the
     company a RM 0 override and look exactly like a correct answer. PATCH
     /config refuses the switch, so reaching here means the levels were deleted
     AFTER the switch — still refuse. This is the module's "missing data is an
     error, not a zero" rule applied to the one input that has no safe default. */
  if (mode === 'chain' && levels.length === 0) {
    return {
      ok: false,
      res: c.json(
        { error: 'no_override_levels', reason: 'Commission is set to chain override mode but no override levels are configured, so every manager would earn RM 0 override. Add the levels in HR Settings, or switch back to showroom mode.' },
        409,
      ),
    };
  }

  // active profiles (tier + HR-assigned showroom + staff name for labels).
  // The HR-assigned showroom is the SINGLE source of truth for the showroom
  // dimension: a salesperson's goods, their grouping, and the whole-showroom
  // total all key off the profile, so they can never diverge.
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
  // Labels via a keyed lookup rather than 2990's embed — see loadStaffLite.
  const staffLite = await loadStaffLite(sb, profiles.map((p) => p.staff_id));
  if (staffLite.error) return { ok: false, res: c.json({ error: 'profiles_failed', reason: staffLite.error.message }, 500) };
  const staffName = new Map<string, string>(profiles.map((p) => [p.staff_id, staffLite.data.get(p.staff_id)?.name ?? '']));

  const showroomRes = await paginateAll<{ id: string; name: string }>((f, t) => sb
    .from('showrooms').select('id, name').eq('company_id', co.companyId).order('id').range(f, t));
  if (showroomRes.error) return { ok: false, res: c.json({ error: 'showrooms_failed', reason: showroomRes.error.message }, 500) };
  const showroomName = new Map<string, string>((showroomRes.data ?? []).map((s) => [s.id, s.name]));

  // orders in range, excluding cancelled/on-hold/draft. Header columns only.
  const ordRes = await paginateAll<OrderRow>((f, t) => sb
    .from('mfg_sales_orders')
    .select('doc_no, salesperson_id, mattress_sofa_centi, bedframe_centi, accessories_centi, others_centi')
    .gte('so_date', from)
    .lte('so_date', to)
    .not('status', 'in', COMMISSION_EXCLUDED_STATUS_FILTER)
    .eq('company_id', co.companyId)
    .order('doc_no')
    .range(f, t),
  );
  if (ordRes.error) return { ok: false, res: c.json({ error: 'orders_failed', reason: ordRes.error.message }, 500) };
  const orders = ordRes.data ?? [];

  const personalGoods = new Map<string, number>(); // salesperson_id → goods centi
  const docToSalesperson = new Map<string, string>();
  for (const o of orders) {
    if (!o.salesperson_id) continue;
    personalGoods.set(o.salesperson_id, (personalGoods.get(o.salesperson_id) ?? 0) + goodsOf(o));
    docToSalesperson.set(o.doc_no, o.salesperson_id);
  }

  // item-KPI — a flagged purchase earns the FIXED bonus INSTEAD of % commission
  // on the flagged add-on, so that amount leaves goods (kpi-units.ts is the
  // single source).
  const itemKpiCenti = new Map<string, number>();       // salesperson_id → fixed bonus centi
  const kpiExcludedGoods = new Map<string, number>();   // salesperson_id → goods to remove
  const kpiDetail = new Map<string, Map<string, { label: string; qty: number; bonusCenti: number; lineCenti: number }>>();
  if (docToSalesperson.size > 0) {
    let kpi;
    try {
      kpi = await loadKpiUnitsByDoc(sb, [...docToSalesperson.keys()], co.companyId);
    } catch (e) {
      // A KPI read failure must NOT fall through to "no flags" — that would pay
      // every bonus as RM 0 and silently stop excluding flagged goods.
      return { ok: false, res: c.json({ error: 'kpi_failed', reason: e instanceof Error ? e.message : String(e) }, 500) };
    }
    const { flags, flagLabel, unitsByDoc } = kpi;
    for (const [docNo, units] of unitsByDoc) {
      const sp = docToSalesperson.get(docNo);
      if (!sp) continue;
      for (const u of units) {
        const bonus = unitKpiCenti(u, flags);
        const excluded = unitKpiExcludedCenti(u, flags);
        if (bonus > 0) itemKpiCenti.set(sp, (itemKpiCenti.get(sp) ?? 0) + bonus);
        if (excluded > 0) kpiExcludedGoods.set(sp, (kpiExcludedGoods.get(sp) ?? 0) + excluded);
        if (bonus <= 0) continue;
        for (const f of flags) {
          // The WHOLE flag list is load-bearing: a category rule suppressed by a
          // product rule on this unit paid nothing, so it must not appear in the
          // breakdown either — the detail lines have to sum back to `bonus`.
          if (!kpiFlagFiresOnUnit(f, u, flags)) continue;
          const key = `${f.flagType}:${f.ref}`;
          if (!kpiDetail.has(sp)) kpiDetail.set(sp, new Map());
          const m = kpiDetail.get(sp)!;
          const prev = m.get(key) ?? { label: flagLabel.get(key) ?? f.ref, qty: 0, bonusCenti: f.bonusCenti, lineCenti: 0 };
          prev.qty += u.qty;
          prev.lineCenti += u.qty * f.bonusCenti;
          m.set(key, prev);
        }
      }
    }
  }

  /* Each profiled person's COMMISSIONABLE goods: their SO goods less the item-KPI
     add-on exclusion, clamped >= 0. A flagged add-on earns the fixed bonus above
     INSTEAD of % commission, and is dropped from the goods the % rate + the
     100k/400k thresholds run on (Loo 2026-06-20).
     Both `?? 0`s are 2990's and are CORRECT: these Maps are accumulators this
     function just built, so a miss means "this person had no such rows in this
     period" — a known zero, not an unknown. Contrast the config reads above. */
  const commissionableGoods = new Map<string, number>();
  for (const p of profiles) {
    commissionableGoods.set(
      p.staff_id,
      Math.max(0, (personalGoods.get(p.staff_id) ?? 0) - (kpiExcludedGoods.get(p.staff_id) ?? 0)),
    );
  }

  /* CHAIN MODE: roll each seller's goods UP their reporting line.
     Skipped entirely in showroom mode — no chain walk, no staff/user lookups,
     so the 2990-parity path costs exactly what it costs today. */
  const chainGoods = new Map<string, Map<number, number>>(); // earner staffId → level → goods
  if (mode === 'chain') {
    const rolled = await rollUpChainGoods(c, companyId, profiles, commissionableGoods, levels);
    if (!rolled.ok) return { ok: false, res: rolled.res };
    for (const [k, v] of rolled.goods) chainGoods.set(k, v);
  }

  // group profiles by their HR-assigned showroom, then compute.
  const byShowroom = new Map<string, SalespersonInput[]>();
  for (const p of profiles) {
    const sid = p.showroom_id;
    if (!byShowroom.has(sid)) byShowroom.set(sid, []);
    byShowroom.get(sid)!.push({
      staffId: p.staff_id,
      tier: p.tier as 'sales' | 'manager',
      personalGoodsCenti: commissionableGoods.get(p.staff_id) ?? 0,
      itemKpiCenti: itemKpiCenti.get(p.staff_id) ?? 0,
    });
  }

  const showrooms: BuiltShowroom[] = [...byShowroom.entries()].map(([sid, people]) => {
    /* whole-showroom total = sum of this showroom's profiled members' personal
       goods. Both the 400k gate and (in showroom mode) the manager override base
       use it.

       CHAIN-MODE CAVEAT, stated rather than hidden: in showroom mode the rows on
       screen always add up to this figure. In chain mode they do not have to —
       a manager in Showroom A whose downline sells in Showroom B earns override
       on B's goods while sitting in A's group. That is inherent to overriding a
       reporting line instead of a room, not a bug, and this number keeps its
       meaning either way: it is what the RM 400k gate reads. */
    const sg = people.reduce((acc, m) => acc + m.personalGoodsCenti, 0);
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
    // managers first, then sales; stable within tier (preserves existing order).
    rows.sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9));
    return {
      showroomId: sid,
      showroomName: showroomName.get(sid) ?? sid,
      showroomGoodsCenti: sg,
      showroomKpiHit: sg >= config.showroomKpiThresholdCenti,
      rows,
    };
  });

  return { ok: true, built: { configRow: cfgRes.row, mode, levels, showrooms } };
}

// ── payout close / period lock ──────────────────────────────────────────────
// See migration 0125 for the full rationale. In one line: the report recomputes
// from CURRENT config on every load, so editing a rate silently rewrites every
// past period's payout and no figure the owner has approved is reproducible.
// Closing a period freezes its computed rows. An OPEN period still recomputes
// live — the freeze is opt-in, per period, and dated.

const PERIOD_SELECT =
  'id, company_id, period_from, period_to, revision, status, engine_version, config_snapshot, override_mode, override_levels_snapshot, total_centi, row_count, closed_by_name, closed_at, reopened_by_name, reopened_at, reopen_reason';

type PeriodRow = {
  id: string; period_from: string; period_to: string; revision: number; status: string;
  engine_version: string; config_snapshot: unknown; override_mode: string;
  override_levels_snapshot: unknown; total_centi: number; row_count: number;
  closed_by_name: string; closed_at: string;
  reopened_by_name: string | null; reopened_at: string | null; reopen_reason: string | null;
};

type PayoutRowRec = {
  staff_id: string; staff_name: string; showroom_id: string | null; showroom_name: string;
  showroom_goods_centi: number; showroom_kpi_hit: boolean; tier: string;
  personal_goods_centi: number; personal_rate_bps: number; personal_commission_centi: number;
  override_rate_bps: number | null; override_commission_centi: number; override_detail: unknown;
  item_kpi_centi: number; kpi_detail: unknown; total_centi: number; sort_index: number;
};

const PAYOUT_ROW_SELECT =
  'staff_id, staff_name, showroom_id, showroom_name, showroom_goods_centi, showroom_kpi_hit, tier, personal_goods_centi, personal_rate_bps, personal_commission_centi, override_rate_bps, override_commission_centi, override_detail, item_kpi_centi, kpi_detail, total_centi, sort_index';

/* The LIVE closed snapshot for this exact period, or null. status='CLOSED' only:
   a PENDING row is a half-written close (see 0125) and a REOPENED one has been
   deliberately un-frozen — serving either as authoritative would be a payout
   claim we cannot stand behind. */
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
  totalCenti: p.total_centi,
  rowCount: p.row_count,
  closedByName: p.closed_by_name,
  closedAt: p.closed_at,
  reopenedByName: p.reopened_by_name,
  reopenedAt: p.reopened_at,
  reopenReason: p.reopen_reason,
});

/* Rebuild the report response from FROZEN rows — the engine is NOT re-run. This
   is what makes a closed period reproducible across a code change: if this
   function called computeShowroomCommission again, tomorrow's engine would
   answer today's approved question, and the guarantee would be worth nothing.
   The showroom grouping is reconstructed from each row's stored showroom fields
   and sort_index, so the shape matches the live response exactly and callers
   never branch on closed-vs-open to read it. */
/* Shared range parse for every period-scoped endpoint. */
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
        showroomGoodsCenti: r.showroom_goods_centi,
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
      personalGoodsCenti: r.personal_goods_centi,
      personalRateBps: r.personal_rate_bps,
      personalCommissionCenti: r.personal_commission_centi,
      overrideRateBps: r.override_rate_bps,
      overrideCommissionCenti: r.override_commission_centi,
      overrideDetail: (r.override_detail as BuiltRow['overrideDetail']) ?? undefined,
      itemKpiCenti: r.item_kpi_centi,
      kpiDetail: (r.kpi_detail as BuiltRow['kpiDetail']) ?? [],
      totalCenti: r.total_centi,
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

  /* A CLOSED period is served from its frozen rows — no recompute, so a rate
     edit (or an engine change) after the close cannot move it. An OPEN period
     recomputes live, exactly as before. */
  const closed = await loadClosedPeriod(c, co.companyId, from, to);
  if (!closed.ok) return closed.res;
  if (closed.period) {
    const sb = c.get('supabase');
    const rowsRes = await paginateAll<PayoutRowRec>((f, t) => sb
      .from('hr_payout_rows')
      .select(PAYOUT_ROW_SELECT)
      .eq('period_id', closed.period!.id)
      .order('sort_index')
      .range(f, t),
    );
    if (rowsRes.error) return c.json({ error: 'payout_read_failed', reason: rowsRes.error.message }, 500);
    /* The SNAPSHOT config, never the live one. Returning the live config
       alongside frozen rows would print rates that do not explain the figures
       underneath them — the report would contradict itself and look like a
       rounding bug. */
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

/* List the closed/reopened periods (audit view). Every revision is kept, so this
   answers "what did we approve, when, who moved it, and what did it become". */
hr.get('/payout/periods', async (c) => {
  if (!hasHouzsPerm(c, HR_READ)) return forbidden(c, HR_READ);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const sb = c.get('supabase');
  const { data, error } = await paginateAll<PeriodRow>((f, t) => sb
    .from('hr_payout_periods')
    .select(PERIOD_SELECT)
    .eq('company_id', co.companyId)
    .neq('status', 'PENDING') // half-written closes are garbage, not history
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

/**
 * Close (freeze) a period. Gated on scm.hr.close — NOT scm.hr.manage: whoever
 * tunes the rates should not thereby be able to approve a payroll run against
 * the rates they just set.
 *
 * TWO-PHASE (PostgREST has no transaction — see 0125): insert the header
 * PENDING, write every row, then flip to CLOSED. An interrupted close leaves an
 * inert PENDING row that no read serves, and is safe to simply retry. The
 * alternative — writing the header CLOSED first — would leave a LIVE period with
 * only some of its rows, which reads as authoritative and is a corrupt payout.
 */
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

  // Freeze EXACTLY what the report shows — same builder, same inputs.
  const built = await buildCommissionLive(c, co.companyId, from, to);
  if (!built.ok) return built.res;
  const { configRow, mode, levels, showrooms } = built.built;

  /* revision = one past the highest this period has ever had, INCLUDING
     reopened ones. History is append-only: a re-close never reuses a number. */
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
  const totalCenti = flat.reduce((acc, x) => acc + x.row.totalCenti, 0);

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
    total_centi: totalCenti,
    row_count: flat.length,
    // Attribute to the REAL caller. `user.id` is the bridge's pinned system
    // staff row — stamping it on a payroll approval is an audit lie.
    closed_by_staff_id: await resolveCallerStaffId(sb, hu?.id),
    closed_by_user_id: hu?.id ?? null,
    closed_by_name: hu?.name ?? '',
    closed_at: new Date().toISOString(),
  };

  const insRes = await sb.from('hr_payout_periods').insert(period).select('id').single();
  if (insRes.error) return c.json({ error: 'close_failed', reason: insRes.error.message }, 500);
  const periodId = (insRes.data as { id: string }).id;

  /* Abandon a half-written close rather than leave it lying around. Best-effort:
     correctness does not depend on it (a PENDING row is never served), so a
     failure to clean up is logged, not surfaced over the real error. */
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
    showroom_goods_centi: showroom.showroomGoodsCenti,
    showroom_kpi_hit: showroom.showroomKpiHit,
    tier: row.tier,
    personal_goods_centi: row.personalGoodsCenti,
    personal_rate_bps: row.personalRateBps,
    personal_commission_centi: row.personalCommissionCenti,
    override_rate_bps: row.overrideRateBps, // null in chain mode — deliberate
    override_commission_centi: row.overrideCommissionCenti,
    override_detail: row.overrideDetail ?? null,
    item_kpi_centi: row.itemKpiCenti,
    kpi_detail: row.kpiDetail,
    total_centi: row.totalCenti,
    sort_index: i, // global order — frozenToShowrooms rebuilds the exact shape
  }));

  // Chunked: one PostgREST insert of every row in a big company-period could
  // outgrow the request body limit, and a rejected close is a blocked payroll.
  for (let i = 0; i < payloads.length; i += 200) {
    const { error } = await sb.from('hr_payout_rows').insert(payloads.slice(i, i + 200));
    if (error) {
      await abandon();
      return c.json({ error: 'close_failed', reason: error.message }, 500);
    }
  }

  // The commit. Until this lands, no read serves this period.
  const commit = await sb
    .from('hr_payout_periods')
    .update({ status: 'CLOSED' })
    .eq('id', periodId)
    .select(PERIOD_SELECT)
    .maybeSingle();
  if (commit.error) {
    await abandon();
    // 23505 on the partial unique index = someone else closed this period while
    // we were writing. Theirs won, ours is abandoned — say so plainly.
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
  // A reopen reverses a figure the owner already approved. Requiring a reason is
  // the cheapest possible check on that, and the DB enforces it too (0125).
  reason: z.string().trim().min(1),
});

/**
 * Reopen a closed period so it recomputes live again.
 *
 * WHY REOPEN EXISTS AT ALL: forbidding it is the tempting answer and the wrong
 * one — real corrections happen (a missed SO, a wrong tier), and a system with
 * no legitimate correction path gets corrected in the database by hand, with no
 * name and no reason attached. So it is allowed, and made expensive and visible
 * instead of impossible: its own permission key, a mandatory reason, and the
 * frozen rows are NEVER deleted. The period flips to REOPENED and its snapshot
 * stays readable forever; a later re-close appends revision+1 beside it.
 */
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
    .eq('status', 'CLOSED') // lost race → 0 rows, never a double-reopen
    .select(PERIOD_SELECT)
    .maybeSingle();
  if (error) return c.json({ error: 'reopen_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_closed', reason: 'This period was already reopened by someone else.' }, 409);
  return c.json({ reopened: toPeriodApi(data as PeriodRow) });
});
