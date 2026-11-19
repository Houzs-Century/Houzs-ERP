// ----------------------------------------------------------------------------
// acc-departments — the Department P&L (owner 2026-11-19: an Operation report =
// his "Operation PNL - Auto" sheet, a G&A report = admin, IT, legal and HQ, and
// 「我要可以看全部的，也要可以看单独部门的」). Registered on the /acc-events router
// beside the Logistics cost report, behind the same Finance › Accounting guard:
//
//   GET /departments/all?from=&to=         the P&L, every line split across G&A |
//                                          Operation | Logistics | no department
//   GET /departments/ga?from=&to=          G&A month by month: its share of the
//                                          Performance sales against what it booked
//   GET /departments/operation?from=&to=   the Operation sheet month by month, by region
//   PUT /departments/rate                  { dept: 'ga' | 'operation', pct } — G&A's
//                                          share (8%) or Operation's income (7%)
//
// Every read is a financial statement: the statements' right
// (scm.payment_voucher.post), as the P&L. The PUT is Finance's money right too.
// Which department an amount belongs to: scm/lib/department-rows.ts; the
// arithmetic: scm/lib/department-pnl.ts.
// ----------------------------------------------------------------------------

import { requireActiveCompanyId } from '../lib/companyScope';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { chunkIn } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';
import { dateOrNull } from '../lib/date-coerce';
import { countsInTheBooks } from '../../acc/reversal-pairs';
import { layOutBlock, type LaidLine, type LaidNode } from '../../acc/report-layout';
import { buildPnl, dbSources, type ReportLine } from './accounting-reports';
import { allowedIds, resolveLayout } from './accounting-report-layouts';
import { PERFORMANCE_MONTHS_MAX, buildPerformanceMonths, perfDbSources } from './accounting-performance';
import { loadLogisticsPnl } from './acc-logistics-pnl';
import { fail } from './acc-logistics';
import { MAX_SPREAD, addMonths, monthsBetween, type Leg } from '../lib/logistics-pnl';
import {
  DEPT_KEYS, DEPT_LABEL, MANPOWER_LABEL, OP_REGIONS, OP_ROW_LABEL, opRowOf, payrollAccounts,
  type DeptAccount, type ManpowerRow, type OpRow,
} from '../lib/department-rows';
import { buildGaPnl, buildOperationPnl, operationRows, splitLine, type LogisticsMonthIn, type SplitLeg } from '../lib/department-pnl';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the acc layer */
type Row = Record<string, any>;

const NO_PERM = { error: "You don't have permission to read the financial statements." };
const NO_RIGHT = "You don't have permission to change the Department P&L's rates.";
const canRead = (c: any): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
const actorOf = (c: any): string | null => (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;

const monthStart = (ymd: string): string => `${ymd.slice(0, 7)}-01`;
const monthEnd = (ymd: string): string => {
  const d = new Date(`${ymd.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};

/** The range asked for, widened to whole months (every view reads whole months). */
function rangeOf(c: any): { ok: true; from: string; to: string; months: string[] } | { ok: false; res: Response } {
  const today = todayMyt();
  const rawFrom = dateOrNull(c.req.query('from')) ?? monthStart(today);
  const rawTo = dateOrNull(c.req.query('to')) ?? monthEnd(today);
  if (rawFrom > rawTo) return { ok: false, res: c.json({ error: 'bad_range', message: 'The From date is after the To date.' }, 400) };
  const from = monthStart(rawFrom);
  const to = monthEnd(rawTo);
  const months = monthsBetween(from, to);
  if (months.length > PERFORMANCE_MONTHS_MAX) {
    return { ok: false, res: c.json({ error: 'bad_range', message: `At most ${PERFORMANCE_MONTHS_MAX} months.` }, 400) };
  }
  return { ok: true, from, to, months };
}

export const DEFAULT_GA_SHARE_BP = 800;
export const DEFAULT_OPERATION_INCOME_BP = 700;

/** The chart (every column, so the Department column reads once its migration is in)
    and the company's two rates. */
async function loadSetup(sb: any, companyId: number): Promise<
  { ok: true; chart: DeptAccount[]; gaShareBp: number; operationIncomeBp: number } | { ok: false; what: string; reason: string }
> {
  const [chartRes, setRes] = await Promise.all([
    sb.from('accounts').select('*').eq('company_id', companyId),
    sb.from('acc_department_settings').select('*').eq('company_id', companyId).maybeSingle(),
  ]);
  if (chartRes.error) return { ok: false, what: 'chart of accounts', reason: chartRes.error.message };
  if (setRes.error) return { ok: false, what: 'Department P&L settings', reason: setRes.error.message };
  const set = setRes.data as { ga_share_bp?: number | null; operation_income_bp?: number | null } | null;
  return {
    ok: true,
    chart: (chartRes.data ?? []) as DeptAccount[],
    gaShareBp: set?.ga_share_bp == null ? DEFAULT_GA_SHARE_BP : Number(set.ga_share_bp),
    operationIncomeBp: set?.operation_income_bp == null ? DEFAULT_OPERATION_INCOME_BP : Number(set.operation_income_bp),
  };
}

/** The legs of some accounts in [from, to] the books count, as the statements count them. */
async function readLegs(sb: any, companyId: number, codes: readonly string[], from: string, to: string): Promise<{ ok: true; legs: Leg[] } | { ok: false; reason: string }> {
  const res = await chunkIn<Row>([...codes], (b, lo, hi) => sb.from('v_gl_entries')
    .select('line_id, account_code, account_name, entry_date, debit_sen, credit_sen, posted, reversed, reversed_by_je, notes, je_no')
    .eq('company_id', companyId).in('account_code', b).gte('entry_date', from).lte('entry_date', to)
    .order('line_id').range(lo, hi));
  if (res.error) return { ok: false, reason: res.error.message };
  return {
    ok: true,
    legs: res.data.filter((l) => countsInTheBooks(l)).map((l) => ({
      lineId: String(l.line_id), accountCode: String(l.account_code), accountName: l.account_name == null ? null : String(l.account_name),
      day: String(l.entry_date).slice(0, 10), debitSen: Number(l.debit_sen ?? 0), creditSen: Number(l.credit_sen ?? 0),
      notes: l.notes == null ? null : String(l.notes), docNo: l.je_no == null ? null : String(l.je_no),
    })),
  };
}

/* ── GET /departments/all ─────────────────────────────────────────────────── */
type Block = 'tradingIncome' | 'costOfSales' | 'otherIncome' | 'expenses' | 'taxation';
const BLOCKS: ReadonlyArray<{ block: Block; sign: 1 | -1; recharge: boolean }> = [
  { block: 'tradingIncome', sign: -1, recharge: false },
  { block: 'costOfSales', sign: 1, recharge: false },
  { block: 'otherIncome', sign: -1, recharge: true },
  { block: 'expenses', sign: 1, recharge: false },
  { block: 'taxation', sign: 1, recharge: false },
];

export const departmentsAllHandler = async (c: any): Promise<Response> => {
  if (!canRead(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const r = rangeOf(c);
  if (!r.ok) return r.res;
  const sb = c.get('supabase');
  const companyId = co.companyId;

  const [pnlRes, setup, laid] = await Promise.all([
    buildPnl(dbSources(sb, companyId, allowedIds(c)), companyId, r.from, r.to),
    loadSetup(sb, companyId),
    resolveLayout(sb, allowedIds(c), 'pnl'),
  ]);
  if (!pnlRes.ok) return c.json({ error: 'load_failed', message: 'The P&L could not be read — try again.', reason: pnlRes.reason }, 500);
  if (!setup.ok) return fail(c, setup.what, setup.reason);
  if (!laid.ok) return fail(c, 'P&L layout', laid.reason);
  const pnl = pnlRes.report;
  const chart = new Map(setup.chart.map((a) => [a.account_code, a] as const));
  const payroll = payrollAccounts(setup.chart);

  /* The lines that mix departments: the payroll accounts' (by team) and other income's (by recharge words). */
  const mixed = new Set<string>([
    ...pnl.expenses.filter((l) => payroll.has(l.code)).map((l) => l.code),
    ...pnl.otherIncome.map((l) => l.code),
  ]);
  const legsRes = await readLegs(sb, companyId, [...mixed], r.from, r.to);
  if (!legsRes.ok) return fail(c, 'ledger', legsRes.reason);
  const legsOf = new Map<string, SplitLeg[]>();
  for (const l of legsRes.legs) legsOf.set(l.accountCode, [...(legsOf.get(l.accountCode) ?? []), l]);

  const baseSen = pnl.layout.baseSen;
  const tree: Record<Block, LaidNode[]> = { tradingIncome: [], costOfSales: [], otherIncome: [], expenses: [], taxation: [] };
  const totals: Record<Block, Record<string, number>> = { tradingIncome: {}, costOfSales: {}, otherIncome: {}, expenses: {}, taxation: {} };
  for (const { block, sign, recharge } of BLOCKS) {
    const lines: LaidLine[] = (pnl[block] as ReportLine[]).map((l) => {
      const isPayroll = block === 'expenses' && payroll.has(l.code);
      const cells = splitLine({ amountSen: l.amountSen, sign, account: chart.get(l.code), legs: legsOf.get(l.code), payroll: isPayroll, recharge });
      return { code: l.code, name: l.name, amountSen: l.amountSen, cells };
    });
    tree[block] = layOutBlock(laid.layout.blocks[block] ?? [], lines, companyId, baseSen);
    for (const k of DEPT_KEYS) totals[block][k] = lines.reduce((s, l) => s + (l.cells?.[k] ?? 0), 0);
  }
  return c.json({
    from: r.from, to: r.to,
    columns: DEPT_KEYS.map((k) => ({ key: k, label: DEPT_LABEL[k] })),
    tree, blockTotals: totals, totals: pnl.totals, baseSen,
    stock: pnl.stock,
  });
};

/* ── GET /departments/ga ──────────────────────────────────────────────────── */
export const departmentsGaHandler = async (c: any): Promise<Response> => {
  if (!canRead(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const r = rangeOf(c);
  if (!r.ok) return r.res;
  const sb = c.get('supabase');
  const companyId = co.companyId;

  const [setup, laid, perf] = await Promise.all([
    loadSetup(sb, companyId),
    resolveLayout(sb, allowedIds(c), 'pnl'),
    buildPerformanceMonths(companyId, r.months[0]!, r.months[r.months.length - 1]!, perfDbSources(sb, companyId, allowedIds(c))),
  ]);
  if (!setup.ok) return fail(c, setup.what, setup.reason);
  if (!laid.ok) return fail(c, 'P&L layout', laid.reason);
  if (!perf.ok) return fail(c, 'Performance P&L', perf.reason);
  const payroll = payrollAccounts(setup.chart);
  const gaCodes = setup.chart.filter((a) => a.department_row === 'ga').map((a) => a.account_code);
  const legsRes = await readLegs(sb, companyId, [...new Set([...payroll, ...gaCodes])], r.from, r.to);
  if (!legsRes.ok) return fail(c, 'ledger', legsRes.reason);

  const g = buildGaPnl({
    months: r.months,
    sales: new Map(perf.months.map((m) => [m.month, m.salesSen] as const)),
    shareBp: setup.gaShareBp,
    legs: legsRes.legs,
    chart: new Map(setup.chart.map((a) => [a.account_code, a] as const)),
    payroll,
    layout: laid.layout.blocks.expenses ?? [],
    companyId,
  });
  return c.json({ from: r.from, to: r.to, ...g });
};

/* ── GET /departments/operation ───────────────────────────────────────────── */
export const departmentsOperationHandler = async (c: any): Promise<Response> => {
  if (!canRead(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const r = rangeOf(c);
  if (!r.ok) return r.res;
  const sb = c.get('supabase');
  const companyId = co.companyId;

  const [setup, lg, spreadRes] = await Promise.all([
    loadSetup(sb, companyId),
    loadLogisticsPnl(c, companyId, r.from, r.to),
    sb.from('acc_logistics_spreads').select('line_id, months').eq('company_id', companyId),
  ]);
  if (!setup.ok) return fail(c, setup.what, setup.reason);
  if (!lg.ok) return lg.res;
  if (spreadRes.error) return fail(c, 'spreads', spreadRes.error.message);
  const payroll = payrollAccounts(setup.chart);
  const opCodes = setup.chart.filter((a) => opRowOf(a.department_row) != null).map((a) => a.account_code);
  /* From far enough back for the longest spread of an upkeep or insurance bill. */
  const spreadFrom = `${addMonths(r.months[0]!, -(MAX_SPREAD - 1))}-01`;
  const legsRes = await readLegs(sb, companyId, [...new Set([...payroll, ...opCodes])], spreadFrom, r.to);
  if (!legsRes.ok) return fail(c, 'ledger', legsRes.reason);

  const sen = (rows: ReadonlyArray<{ key: string; sen: Record<string, number | null> }>, key: string): Record<string, number> => {
    const row = rows.find((x) => x.key === key);
    return Object.fromEntries(Object.entries(row?.sen ?? {}).map(([k, v]) => [k, Number(v ?? 0)]));
  };
  const logistics = new Map<string, LogisticsMonthIn>(lg.body.perMonth.map((m) => [m.month, {
    doValue: sen(m.rows, 'do_value'),
    doCount: { PG: m.dos.PG, KL: m.dos.KL, EM: m.dos.EM, SG: m.dos.SG },
    transportIncome: sen(m.rows, 'do_income'),
    fairIncome: sen(m.rows, 'fair_income'),
    net: sen(m.rows, 'net'),
    fairs: m.fairs.map((f) => ({ region: f.region, incomeSen: f.incomeSen, costSen: f.chargeSen + f.dismantleSen + f.transportSen })),
  }] as const));

  const p = buildOperationPnl({
    months: r.months,
    incomeBp: setup.operationIncomeBp,
    logistics,
    bills: lg.billLines,
    legs: legsRes.legs,
    chart: new Map(setup.chart.map((a) => [a.account_code, a] as const)),
    payroll,
    spreadMonths: new Map(((spreadRes.data ?? []) as Row[]).map((x) => [String(x.line_id), Number(x.months)] as const)),
  });
  const labels: Record<string, string> = { ...MANPOWER_LABEL, ...OP_ROW_LABEL };
  return c.json({
    from: r.from, to: r.to,
    ...p,
    rows: operationRows(setup.operationIncomeBp).map((x) => ({ ...x, label: x.label || labels[x.key as ManpowerRow | OpRow] || x.key })),
    regions: OP_REGIONS,
    logisticsIncomeBp: lg.body.doIncomeBp,
    logisticsProblem: lg.body.fairsProblem ?? lg.body.tripsProblem ?? null,
  });
};

/* ── PUT /departments/rate ────────────────────────────────────────────────── */
export const saveDepartmentRateHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json({ error: NO_RIGHT }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const dept = String(body?.dept ?? '');
  if (dept !== 'ga' && dept !== 'operation') return c.json({ error: 'bad_dept', message: 'The rate is G&A\'s (ga) or Operation\'s (operation).' }, 400);
  const pct = Number(body?.pct);
  if (typeof body?.pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100 || Math.round(pct * 100) !== pct * 100) {
    return c.json({ error: 'bad_pct', message: 'The rate is a percentage from 0 to 100, two decimals at most.' }, 400);
  }
  const bp = Math.round(pct * 100);
  const column = dept === 'ga' ? 'ga_share_bp' : 'operation_income_bp';
  const { error } = await c.get('supabase').from('acc_department_settings').upsert(
    { company_id: co.companyId, [column]: bp, updated_at: new Date().toISOString(), updated_by: actorOf(c) },
    { onConflict: 'company_id' },
  );
  if (error) return c.json({ error: 'save_failed', message: 'The rate could not be saved — try again.', reason: error.message }, 500);
  return c.json({ ok: true, dept, bp });
};
