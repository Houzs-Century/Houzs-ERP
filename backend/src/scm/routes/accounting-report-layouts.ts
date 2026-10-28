// ----------------------------------------------------------------------------
// accounting-report-layouts — the layout a Finance report is drawn on
// (owner 2026-09-14: 我要能自己调动排版，然后能自己加大 categories … 做公用然后选要不要，
// 类似 chart of account; docs/bugs/0911). One tree per report, shared by every
// company, each category with a per-company tick; the tree itself is
// acc/report-layout.ts. Editors are whoever may read the statements — the
// owner's Finance and himself (scm.payment_voucher.post, the statements' key).
//
//   GET    /accounting/reports/layout?report=pnl — the stored tree, or the
//          chart's own when nobody has saved one, with the chart union the
//          editor arranges and the companies the ticks name
//   PUT    /accounting/reports/layout?report=pnl  {layout}
//   DELETE /accounting/reports/layout?report=pnl — back to the chart's tree
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import {
  REPORT_BLOCKS, defaultLayout, isReportKey, validateLayout,
  type ChartAccount, type Layout, type LayoutItem, type ReportKey,
} from '../../acc/report-layout';
import { defaultSectionFor } from '../lib/account-sections';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
/* The scm client the middleware attaches — typed off the request variables, never a loose any. */
type Sb = Variables['supabase'];
const requirePerm = (c: Ctx): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
const NO_PERM = { error: "You don't have permission to arrange the financial statements." };
const failed = (e: unknown): string => (e instanceof Error ? e.message : String((e as { message?: string } | null)?.message ?? e));
const who = (c: Ctx): string | null =>
  (c.get('houzsUser') as { name?: string } | undefined)?.name ?? (c.get('user') as { id?: string } | undefined)?.id ?? null;

/** The caller's company allow-list, fail-CLOSED like every scoping helper. */
export const allowedIds = (c: Ctx): number[] => {
  const ids = c.get('allowedCompanyIds');
  if (Array.isArray(ids)) return ids;
  const active = c.get('companyId');
  return typeof active === 'number' ? [active] : [];
};

export type UnionAccount = ChartAccount & { perCompany: Record<number, { active: boolean }> };

/** One definition per code across the caller's companies — the chart page's
    own union (fields prefer the lowest company id, where the accountant's
    import lands), with each company's tick beside it. */
export async function loadChartUnion(sb: Sb, ids: number[]): Promise<{ ok: true; accounts: UnionAccount[] } | { ok: false; reason: string }> {
  if (ids.length === 0) return { ok: true, accounts: [] };
  const { data, error } = await sb
    .from('accounts')
    .select('company_id, is_active, account_code, account_name, account_type, parent_code, section')
    .in('company_id', ids);
  if (error) return { ok: false, reason: failed(error) };
  const byCode = new Map<string, UnionAccount & { definedBy: number }>();
  const rows = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
  for (const raw of rows) {
    const code = String(raw.account_code);
    const companyId = Number(raw.company_id);
    const cur = byCode.get(code);
    if (!cur || companyId < cur.definedBy) {
      byCode.set(code, {
        code,
        name: String(raw.account_name ?? code),
        type: String(raw.account_type ?? ''),
        parentCode: raw.parent_code == null ? null : String(raw.parent_code),
        /* The default shelf for an unsectioned row — the same rule the
           statements file it by, so the editor's Unassigned list agrees with
           the report's. */
        section: raw.section == null ? defaultSectionFor(String(raw.account_type ?? ''), code) : String(raw.section),
        definedBy: companyId,
        perCompany: { ...(cur?.perCompany ?? {}), [companyId]: { active: raw.is_active === true } },
      });
    } else {
      cur.perCompany[companyId] = { active: raw.is_active === true };
    }
  }
  return {
    ok: true,
    accounts: [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code)).map(({ definedBy: _d, ...row }) => row),
  };
}

export type ResolvedLayout = {
  stored: boolean;
  layout: Layout;
  updatedAt: string | null;
  updatedBy: string | null;
};

/** The tree a report draws on: the stored one when it still validates, else
    the chart's own. Needs the union only when nothing is stored. */
export async function resolveLayout(sb: Sb, ids: number[], report: ReportKey): Promise<({ ok: true } & ResolvedLayout) | { ok: false; reason: string }> {
  const { data, error } = await sb
    .from('acc_report_layouts')
    .select('report, tree, updated_at, updated_by')
    .eq('report', report)
    .maybeSingle();
  if (error) return { ok: false, reason: `report layout: ${failed(error)}` };
  if (data) {
    const row = data as { tree: unknown; updated_at?: string | null; updated_by?: string | null };
    const checked = validateLayout(report, row.tree);
    if (checked.ok) {
      return { ok: true, stored: true, layout: checked.layout, updatedAt: row.updated_at ?? null, updatedBy: row.updated_by ?? null };
    }
  }
  const union = await loadChartUnion(sb, ids);
  if (!union.ok) return union;
  return { ok: true, stored: false, layout: defaultLayout(report, union.accounts), updatedAt: null, updatedBy: null };
}

const reportOf = (c: Ctx): ReportKey | null => {
  const raw = String(c.req.query('report') ?? '').trim();
  return isReportKey(raw) ? raw : null;
};
const BAD_REPORT = { error: 'bad_report', message: `report must be one of: ${Object.keys(REPORT_BLOCKS).join(', ')}.` };

const companiesOf = (c: Ctx, ids: number[]): Array<{ id: number; code: string }> =>
  (c.get('companies') ?? []).filter((co) => ids.includes(co.id)).map((co) => ({ id: co.id, code: co.code }));

/* ── GET /accounting/reports/layout?report=pnl ──────────────────────────── */
export const reportLayoutGet = async (c: Ctx): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const report = reportOf(c);
  if (!report) return c.json(BAD_REPORT, 400);
  const ids = allowedIds(c);
  if (ids.length === 0) return c.json({ error: 'no_companies', message: 'No company grants resolve for this session.' }, 409);
  const sb = c.get('supabase');
  const [resolved, union] = await Promise.all([resolveLayout(sb, ids, report), loadChartUnion(sb, ids)]);
  if (!resolved.ok) return c.json({ error: 'load_failed', reason: resolved.reason }, 500);
  if (!union.ok) return c.json({ error: 'load_failed', reason: union.reason }, 500);
  return c.json({
    report,
    blocks: REPORT_BLOCKS[report],
    stored: resolved.stored,
    updatedAt: resolved.updatedAt,
    updatedBy: resolved.updatedBy,
    layout: resolved.layout,
    companies: companiesOf(c, ids),
    accounts: union.accounts,
  });
};

/** Every category of a tree, by id — for carrying ticks across a save. */
const categoriesOf = (items: LayoutItem[], into = new Map<string, number[]>()): Map<string, number[]> => {
  for (const it of items) {
    if (it.kind !== 'category') continue;
    into.set(it.id, it.hiddenFor ?? []);
    categoriesOf(it.children, into);
  }
  return into;
};

/* ── PUT /accounting/reports/layout?report=pnl  {layout} ────────────────── */
export const reportLayoutPut = async (c: Ctx): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const report = reportOf(c);
  if (!report) return c.json(BAD_REPORT, 400);
  const ids = allowedIds(c);
  if (ids.length === 0) return c.json({ error: 'no_companies', message: 'No company grants resolve for this session.' }, 409);
  let body: { layout?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const checked = validateLayout(report, body.layout);
  if (!checked.ok) return c.json({ error: 'bad_layout', message: checked.reason }, 400);
  const sb = c.get('supabase');

  /* A tick belongs to its company: the caller sets the ticks of the
     companies in their grants, and the ticks of any other company ride
     through the save untouched. */
  const before = await resolveLayout(sb, ids, report);
  if (!before.ok) return c.json({ error: 'load_failed', reason: before.reason }, 500);
  const kept = before.stored ? categoriesOf(Object.values(before.layout.blocks).flat()) : new Map<string, number[]>();
  const merge = (items: LayoutItem[]): void => {
    for (const it of items) {
      if (it.kind !== 'category') continue;
      const mine = (it.hiddenFor ?? []).filter((id) => ids.includes(id));
      const theirs = (kept.get(it.id) ?? []).filter((id) => !ids.includes(id));
      const all = [...new Set([...theirs, ...mine])].sort((a, b) => a - b);
      if (all.length > 0) it.hiddenFor = all; else delete it.hiddenFor;
      merge(it.children);
    }
  };
  for (const items of Object.values(checked.layout.blocks)) merge(items);

  const now = new Date().toISOString();
  const { error } = await sb
    .from('acc_report_layouts')
    .upsert({ report, tree: checked.layout, updated_at: now, updated_by: who(c) }, { onConflict: 'report' });
  if (error) return c.json({ error: 'save_failed', reason: failed(error) }, 500);
  return c.json({ ok: true, report, stored: true, layout: checked.layout, updatedAt: now, updatedBy: who(c) });
};

/* ── DELETE /accounting/reports/layout?report=pnl — back to the chart ───── */
export const reportLayoutReset = async (c: Ctx): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const report = reportOf(c);
  if (!report) return c.json(BAD_REPORT, 400);
  const ids = allowedIds(c);
  if (ids.length === 0) return c.json({ error: 'no_companies', message: 'No company grants resolve for this session.' }, 409);
  const sb = c.get('supabase');
  const { error } = await sb.from('acc_report_layouts').delete().eq('report', report);
  if (error) return c.json({ error: 'reset_failed', reason: failed(error) }, 500);
  const union = await loadChartUnion(sb, ids);
  if (!union.ok) return c.json({ error: 'load_failed', reason: union.reason }, 500);
  return c.json({ ok: true, report, stored: false, layout: defaultLayout(report, union.accounts), updatedAt: null, updatedBy: null });
};
