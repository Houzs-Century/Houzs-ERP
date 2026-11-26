// ----------------------------------------------------------------------------
// accounting-pnl-views — the Overall P&L's views side by side (owner
// 2026-11-25: 一张表并排, Actual | Performance | Forecast).
//
//   GET /accounting/reports/pnl-views?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// The range's WHOLE months (the Forecast is kept by month, so every view reads
// the same months): the P&L (Actual: the books, buildPnl), the Performance P&L
// (by sales order, buildPerformance) and the Forecast P&L (each month's
// monthFigures) — the last two laid on the P&L's own tree (acc/pnl-views), so
// a row is the same row in every column. `forecast` is null when none of the
// months has a forecast row. Reads only; the statements' key; every read
// carries the active company's predicate — the ledger, the orders, the
// bindings and the grid alike.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { monthFigures, sortedMonths } from '../shared/forecast-pnl';
import { forecastOnPnl, performanceOnPnl, salesAccountOfGroup, type PnlViewSide } from '../../acc/pnl-views';
import { allowedIds } from './accounting-report-layouts';
import { buildPnl, dbSources } from './accounting-reports';
import { buildPerformance, perfDbSources } from './accounting-performance';
import { loadForecastAccounts, loadGrid } from './accounting-forecast';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono's context, typed as the neighbouring accounting routes type it
type Ctx = any;

const READ_PERM = 'scm.payment_voucher.post';
const NO_READ = { error: "You don't have permission to read the P&L." };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type PnlViewsPayload = {
  from: string; to: string;
  months: string[];
  actual: PnlViewSide;
  performance: PnlViewSide;
  forecast: PnlViewSide | null;
};

const monthEndOf = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
const monthsFrom = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let ym = from; ym <= to;) {
    out.push(ym);
    const [y, m] = ym.split('-').map(Number) as [number, number];
    ym = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  return out;
};

export const pnlViewsReport = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, READ_PERM)) return c.json(NO_READ, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const rawFrom = String(c.req.query('from') ?? '').trim();
  const rawTo = String(c.req.query('to') ?? '').trim();
  if (!DAY.test(rawFrom) || !DAY.test(rawTo) || rawFrom > rawTo) {
    return c.json({ error: 'bad_range', message: 'from and to must be YYYY-MM-DD, from on or before to.' }, 400);
  }
  const months = monthsFrom(rawFrom.slice(0, 7), rawTo.slice(0, 7));
  const from = `${months[0]}-01`;
  const to = monthEndOf(months[months.length - 1]!);
  const companyId = co.companyId;
  const sb = c.get('supabase');
  const ids = allowedIds(c);
  const reportSrc = dbSources(sb, companyId, ids);

  const [actual, perf, laid, accs, grid, bindings] = await Promise.all([
    buildPnl(reportSrc, companyId, from, to),
    buildPerformance(companyId, from, to, perfDbSources(sb, companyId, ids)),
    reportSrc.layout('pnl'),
    loadForecastAccounts(sb, companyId),
    loadGrid(sb, companyId),
    sb.from('acc_item_group_accounts').select('group_code, sales_account').eq('company_id', companyId),
  ]);
  if (!actual.ok) return c.json({ error: 'load_failed', reason: actual.reason }, 500);
  if (!perf.ok) return c.json({ error: 'load_failed', reason: perf.reason }, 500);
  if (!laid.ok) return c.json({ error: 'load_failed', reason: laid.reason }, 500);
  if (!accs.ok) return c.json({ error: 'load_failed', reason: accs.reason }, 500);
  if (!grid.ok) return c.json({ error: 'load_failed', reason: grid.reason }, 500);
  if (bindings.error) return c.json({ error: 'load_failed', reason: bindings.error.message }, 500);

  const names = new Map(accs.accounts.map((a) => [a.code, a.name]));
  const nameOf = (code: string): string => names.get(code) ?? code;
  const forecastMonths = sortedMonths(grid.grid).filter((m) => months.includes(m));
  const payload: PnlViewsPayload = {
    from, to, months,
    actual: { layout: actual.report.layout, taxation: actual.report.taxation, totals: actual.report.totals },
    performance: performanceOnPnl(perf.report, laid.layout, companyId, salesAccountOfGroup(bindings.data ?? []), nameOf),
    forecast: forecastOnPnl(forecastMonths.map((m) => monthFigures(grid.grid[m] ?? {}, grid.suppliers[m] ?? {}, accs.accounts)), laid.layout, companyId),
  };
  return c.json(payload);
};
