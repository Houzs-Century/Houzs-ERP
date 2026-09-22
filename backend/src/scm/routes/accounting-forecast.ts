// ----------------------------------------------------------------------------
// accounting-forecast — the Forecast P&L's doors (owner 2026-09-21: 我也需要这
// 个功能 — the Hookka Forecast P&L, trading edition; 做).
//
//   GET /accounting/forecast                       the grid, the P&L accounts a line may name
//                                                  (active leaves, sectioned as the statement
//                                                  sections them) and the P&L layout tree the
//                                                  page lays the rows on
//   PUT /accounting/forecast  { months }           the WHOLE grid: validated cell by cell (the
//                                                  first bad cell is named, nothing is kept), months
//                                                  absent from the body are removed
//   GET /accounting/forecast/figures?from&to       each month's figures — the Dashboard's forecast
//                                                  side, the same arithmetic the page shows
//
// scm.acc_forecast_pnl is a planning table, one row per month per company;
// nothing here posts. The rules — one of amount / percent, a sales line an
// amount, the blocks' totals — live in scm/shared/forecast-pnl.ts, vendored
// byte-identical to the page. Reading takes the statements' key, writing the
// vouchers' write key.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { defaultSectionFor } from '../lib/account-sections';
import { allowedIds, resolveLayout } from './accounting-report-layouts';
import {
  FORECAST_MONTH_RE, blockOfSection, monthFigures, sortedMonths, validateGrid,
  type ForecastAccount, type ForecastGrid, type ForecastLines,
} from '../shared/forecast-pnl';

type Ctx = any;
type Row = Record<string, unknown>;

const READ_PERM = 'scm.payment_voucher.post';
const WRITE_PERM = 'scm.payment_voucher.write';
const NO_READ = { error: "You don't have permission to read the forecast." };
const NO_WRITE = { error: "You don't have permission to change the forecast." };
const who = (c: Ctx): string => String((c.get('houzsUser') as { name?: string } | undefined)?.name ?? (c.get('user') as { id?: string } | undefined)?.id ?? '');

/** The P&L's own accounts a forecast line may name: active leaves of the five
    blocks, sectioned as the statement sections them (the stored section, else
    the default shelf for the type — the P&L's own rule). */
export async function loadForecastAccounts(sb: any, companyId: number): Promise<{ ok: true; accounts: ForecastAccount[] } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('accounts')
    .select('account_code, account_name, account_type, parent_code, section, is_active')
    .eq('company_id', companyId);
  if (error) return { ok: false, reason: String((error as { message?: string }).message ?? error) };
  const rows = (data ?? []) as Array<{ account_code: string; account_name: string | null; account_type: string; parent_code: string | null; section: string | null; is_active: boolean | null }>;
  const parents = new Set(rows.map((r) => r.parent_code).filter((p): p is string => p != null && p !== ''));
  const accounts = rows
    .filter((r) => r.is_active !== false && !parents.has(r.account_code))
    .map((r) => ({
      code: r.account_code,
      name: r.account_name ?? r.account_code,
      type: r.account_type,
      section: r.section ?? defaultSectionFor(r.account_type, r.account_code),
    }))
    .filter((a) => blockOfSection(a.section) !== null)
    .sort((a, b) => a.code.localeCompare(b.code));
  return { ok: true, accounts };
}

export async function loadGrid(sb: any, companyId: number): Promise<{ ok: true; grid: ForecastGrid } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('acc_forecast_pnl').select('month, lines').eq('company_id', companyId);
  if (error) return { ok: false, reason: String((error as { message?: string }).message ?? error) };
  const grid: ForecastGrid = {};
  for (const r of (data ?? []) as Array<{ month: string; lines: ForecastLines | null }>) grid[String(r.month)] = (r.lines ?? {}) as ForecastLines;
  return { ok: true, grid };
}

export const forecastGetHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, READ_PERM)) return c.json(NO_READ, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const [accs, grid, laid] = await Promise.all([
    loadForecastAccounts(sb, co.companyId),
    loadGrid(sb, co.companyId),
    resolveLayout(sb, allowedIds(c), 'pnl'),
  ]);
  if (!accs.ok) return c.json({ error: 'load_failed', reason: accs.reason }, 500);
  if (!grid.ok) return c.json({ error: 'load_failed', reason: grid.reason }, 500);
  if (!laid.ok) return c.json({ error: 'load_failed', reason: laid.reason }, 500);
  return c.json({ months: grid.grid, accounts: accs.accounts, layout: { stored: laid.stored, blocks: laid.layout.blocks } });
};

export const forecastPutHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, WRITE_PERM)) return c.json(NO_WRITE, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: { months?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const accs = await loadForecastAccounts(sb, co.companyId);
  if (!accs.ok) return c.json({ error: 'load_failed', reason: accs.reason }, 500);
  const checked = validateGrid(body?.months, accs.accounts);
  if (!checked.ok) return c.json({ error: 'bad_cell', cell: checked.cell, message: `${checked.cell}: ${checked.reason}` }, 400);
  const current = await loadGrid(sb, co.companyId);
  if (!current.ok) return c.json({ error: 'load_failed', reason: current.reason }, 500);
  const months = sortedMonths(checked.grid);
  const removed = Object.keys(current.grid).filter((m) => !(m in checked.grid)).sort();
  if (removed.length > 0) {
    const { error } = await sb.from('acc_forecast_pnl').delete().eq('company_id', co.companyId).in('month', removed);
    if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  }
  if (months.length > 0) {
    const rows: Row[] = months.map((m) => ({ company_id: co.companyId, month: m, lines: checked.grid[m], updated_at: new Date().toISOString(), updated_by: who(c) }));
    const { error } = await sb.from('acc_forecast_pnl').upsert(rows, { onConflict: 'company_id,month' });
    if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  }
  return c.json({ ok: true, months: checked.grid, removed });
};

export const forecastFiguresHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, READ_PERM)) return c.json(NO_READ, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const from = String(c.req.query('from') ?? '').trim();
  const to = String(c.req.query('to') ?? '').trim();
  if (!FORECAST_MONTH_RE.test(from) || !FORECAST_MONTH_RE.test(to) || from > to) {
    return c.json({ error: 'bad_range', message: 'from and to must be YYYY-MM, from on or before to.' }, 400);
  }
  const sb = c.get('supabase');
  const [accs, grid] = await Promise.all([loadForecastAccounts(sb, co.companyId), loadGrid(sb, co.companyId)]);
  if (!accs.ok) return c.json({ error: 'load_failed', reason: accs.reason }, 500);
  if (!grid.ok) return c.json({ error: 'load_failed', reason: grid.reason }, 500);
  const months = sortedMonths(grid.grid).filter((m) => m >= from && m <= to);
  return c.json({ from, to, months: months.map((m) => ({ month: m, ...monthFigures(grid.grid[m] ?? {}, accs.accounts) })) });
};
