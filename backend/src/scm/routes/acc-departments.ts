// ----------------------------------------------------------------------------
// acc-departments — the Department P&L (owner 2026-11-19: an Operation report =
// his "Operation PNL - Auto" sheet, a G&A report = admin, IT, legal and HQ, and
// 「我要可以看全部的，也要可以看单独部门的」; 2026-11-25: his three categories — Actual
// by sales invoice, Performance by sales order, Forecast — each Overall and by
// Department, the departments charging each other, scm/lib/department-charges.ts).
// Registered on the /acc-events router beside the Logistics cost report, behind the
// same Finance › Accounting guard. `dbasis` = actual | performance (absent: performance):
//
//   GET /departments/plan                    the company's departments (its plan) and
//                                            Logistics' branch, Setup & dismantle
//   GET /departments/all?dbasis=&from=&to=   every department's own P&L in a few figures,
//                                            side by side, and their total
//   GET /departments/ga?dbasis=&from=&to=    G&A month by month: its share of the sales
//                                            excluding service against what it booked
//   GET /departments/dept?d=&dbasis=&…       one department's own P&L month by month: the
//                                            selling department's sales (the orders' in
//                                            Performance), its expenses, what it pays
//   GET /departments/unit?u=&dbasis=&…       Operation, Logistics or Setup & dismantle:
//                                            what it is paid less its real cost
//                                            (scm/lib/department-units.ts)
//   GET /departments/operation?from=&to=     the Operation sheet month by month, by region (by DO)
//   GET /departments/lines?view=&keys=…      the lines behind one figure of a department's
//                                            own P&L, G&A or Setup & dismantle's fair transport
//   PUT /departments/rate                    { dept: 'ga' | 'operation' | 'merchandise', pct }
//   PUT /departments/rebates                 { rules } — the company's supplier rebate rules, the
//                                            selling department's estimate in Performance
//                                            (scm/lib/supplier-rebates.ts; owner 2026-11-27: 「做设定框」)
//
// Logistics' own report by DO is the Logistics cost report's (GET /logistics/pnl), which the
// units read. Every read is a financial statement: the statements' right
// (scm.payment_voucher.post), as the P&L. The PUT is Finance's money right too.
// Which department an amount belongs to: scm/lib/department-rows.ts; the
// arithmetic: scm/lib/department-pnl.ts.
// ----------------------------------------------------------------------------

import { requireActiveCompanyId } from '../lib/companyScope';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { chunkIn } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';
import { dateOrNull } from '../lib/date-coerce';
import { fmtMoneySen } from '../shared/format';
import { countsInTheBooks } from '../../acc/reversal-pairs';
import { commissionLabel } from '../../acc/performance-pnl';
import { RELEASE_SOURCE, loadPrepaidLines, type PrepaidLedgerLine } from '../../acc/commission-bills';
import { resolveRoles } from '../../acc/rules';
import type { LayoutItem } from '../../acc/report-layout';
import { buildPnl, dbSources, pnlStockLines, type PnlReport } from './accounting-reports';
import { allowedIds, resolveLayout } from './accounting-report-layouts';
import { PERFORMANCE_MONTHS_MAX, buildPerformanceMonths, perfDbSources, type PerformanceMonth } from './accounting-performance';
import { loadLogisticsPnl, type LogisticsPnlLoad } from './acc-logistics-pnl';
import { DEFAULT_DO_INCOME_BP, DEFAULT_FAIR_INCOME_BP, fail } from './acc-logistics';
import { MAX_SPREAD, addMonths, monthsBetween, type Leg } from '../lib/logistics-pnl';
import {
  DEPARTMENT_LABEL, MANPOWER_LABEL, NONE_LABEL, OP_REGIONS, OP_ROW_LABEL, RECRUITMENT_LABEL, accountHome, isMixedAccount,
  parsePlan, payrollAccounts, resolveDept,
  type Department, type DepartmentPlan, type DeptAccount, type DeptKey, type GaTeam, type ManpowerRow, type OpRow,
} from '../lib/department-rows';
import {
  PNL_BLOCKS, addSummaries, bookedByAccount, bookedSalesExService, buildDeptView, buildGaPnl, buildOperationPnl, gaLines, opTotal, operationRows,
  splitPnlLineParts, splitPnlLines, summaryOfDept, summaryOfGa, summaryOfUnit, unassignedOf,
  type DeptCharges, type DeptMonthSplit, type DeptOrders, type DeptSummary, type GaPnl, type LogisticsMonthIn, type OperationPnl, type PnlBlock, type SplitLeg,
} from '../lib/department-pnl';
import {
  chargesOf, isDeptBasis, parseChargeAccounts, serviceAccountsOf,
  type ChargeAccounts, type ChargeRates, type DeptBasis, type MonthCharges, type Payees,
} from '../lib/department-charges';
import { buildLogisticsUnit, buildOperationUnit, buildSetupDismantleUnit, type UnitKind, type UnitView } from '../lib/department-units';
import {
  parseSupplierRebates, readSupplierRebateRules, rebateFigures, rebateKey, rebateMonths, rebateWorking,
  type RebateFigure, type RebateMonth, type SupplierRebateRule,
} from '../lib/supplier-rebates';
import { loadRebateInputs } from '../lib/supplier-rebates-load';

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

type Range = { from: string; to: string; months: string[] };
function rangeOf(c: any): ({ ok: true } & Range) | { ok: false; res: Response } {
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

function basisOf(c: any): { ok: true; basis: DeptBasis } | { ok: false; res: Response } {
  const raw = c.req.query('dbasis');
  if (raw == null || raw === '') return { ok: true, basis: 'performance' };
  return isDeptBasis(raw) ? { ok: true, basis: raw } : { ok: false, res: c.json({ error: 'bad_basis', message: 'dbasis is actual or performance.' }, 400) };
}

export const DEFAULT_GA_SHARE_BP = 800;
export const DEFAULT_OPERATION_INCOME_BP = 700;

type Failed = { ok: false; what: string; reason: string };

async function loadSetup(sb: any, companyId: number): Promise<
  {
    ok: true; chart: DeptAccount[]; gaShareBp: number; operationIncomeBp: number; plan: DepartmentPlan;
    logisticsBp: number; setupDismantleBp: number; chargeAccounts: ChargeAccounts; service: ReadonlySet<string>;
    supplierRebates: SupplierRebateRule[];
  } | Failed
> {
  const [chartRes, setRes, lgRes, groupRes] = await Promise.all([
    sb.from('accounts').select('*').eq('company_id', companyId),
    sb.from('acc_department_settings').select('*').eq('company_id', companyId).maybeSingle(),
    sb.from('acc_logistics_settings').select('*').eq('company_id', companyId).maybeSingle(),
    sb.from('acc_item_group_accounts').select('group_code, sales_account, sales_return_account').eq('company_id', companyId),
  ]);
  if (chartRes.error) return { ok: false, what: 'chart of accounts', reason: chartRes.error.message };
  if (setRes.error) return { ok: false, what: 'Department P&L settings', reason: setRes.error.message };
  if (lgRes.error) return { ok: false, what: 'Logistics cost settings', reason: lgRes.error.message };
  if (groupRes.error) return { ok: false, what: 'item groups', reason: groupRes.error.message };
  const set = setRes.data as { ga_share_bp?: number | null; operation_income_bp?: number | null; plan?: unknown; charges?: unknown; supplier_rebates?: unknown } | null;
  const lg = lgRes.data as { do_income_bp?: number | null; fair_income_bp?: number | null } | null;
  return {
    ok: true,
    chart: (chartRes.data ?? []) as DeptAccount[],
    gaShareBp: set?.ga_share_bp == null ? DEFAULT_GA_SHARE_BP : Number(set.ga_share_bp),
    operationIncomeBp: set?.operation_income_bp == null ? DEFAULT_OPERATION_INCOME_BP : Number(set.operation_income_bp),
    plan: parsePlan(set?.plan),
    logisticsBp: lg?.do_income_bp == null ? DEFAULT_DO_INCOME_BP : Number(lg.do_income_bp),
    setupDismantleBp: lg?.fair_income_bp == null ? DEFAULT_FAIR_INCOME_BP : Number(lg.fair_income_bp),
    chargeAccounts: parseChargeAccounts(set?.charges),
    service: serviceAccountsOf((groupRes.data ?? []) as Row[]),
    supplierRebates: parseSupplierRebates(set?.supplier_rebates),
  };
}
type Setup = Extract<Awaited<ReturnType<typeof loadSetup>>, { ok: true }>;

type ViewKind = 'ga' | 'operation' | 'logistics' | 'dept';
const viewOf = (d: Department): ViewKind => (d === 'ga' || d === 'operation' || d === 'logistics' ? d : 'dept');
export const SETUP_DISMANTLE_LABEL = 'Setup & dismantle';
/** Setup & dismantle — a branch of Logistics (「logistics report 的再分支」): a company with a
    Logistics department and the fair transport accounts the branch carries. */
const hasSetupDismantle = (setup: Pick<Setup, 'plan' | 'chargeAccounts'>): boolean =>
  setup.plan.departments.includes('logistics') && setup.chargeAccounts.setupDismantle.length > 0;
const planBody = (setup: Setup) => ({
  departments: setup.plan.departments.map((key) => ({ key, label: DEPARTMENT_LABEL[key], view: viewOf(key) })),
  selling: setup.plan.selling,
  branches: hasSetupDismantle(setup) ? [{ key: 'setupDismantle' as const, label: SETUP_DISMANTLE_LABEL, under: 'logistics' as const }] : [],
});

const ratesOf = (setup: Setup): ChargeRates => ({
  gaBp: setup.gaShareBp, operationBp: setup.operationIncomeBp, logisticsBp: setup.logisticsBp,
  setupDismantleBp: setup.setupDismantleBp, merchandiseBp: setup.chargeAccounts.merchandiseBp,
});
const payeesOf = (setup: Setup): Payees => {
  const has = (d: Department) => setup.plan.departments.includes(d);
  return { ga: has('ga'), operation: has('operation'), logistics: has('logistics'), setupDismantle: hasSetupDismantle(setup) };
};
const chargesFor = (setup: Setup, basis: DeptBasis, months: readonly string[], split: readonly DeptMonthSplit[] | null, perf: readonly PerformanceMonth[] | null): MonthCharges[] =>
  chargesOf({
    months, rates: ratesOf(setup), payees: payeesOf(setup), basis,
    base: basis === 'performance'
      ? new Map((perf ?? []).map((m) => [m.month, m.salesExServiceSen] as const))
      : bookedSalesExService(split ?? [], setup.service, setup.plan.selling),
  });
const baseMap = (charges: readonly MonthCharges[]): Map<string, number> => new Map(charges.map((m) => [m.month, m.baseSen] as const));
/** What the selling department's own P&L carries of the charges: what it pays, the fair
    transport that leaves it for Setup & dismantle, in Performance merchandise in place of the
    terminal charges (「merchant charge … 以percentage算」). */
const deptChargesOf = (setup: Setup, basis: DeptBasis, charges: readonly MonthCharges[]): DeptCharges => {
  const a = setup.chargeAccounts;
  return {
    months: charges, rates: ratesOf(setup),
    moved: new Set(hasSetupDismantle(setup) ? a.setupDismantle : []),
    merchandise: basis === 'performance' && a.merchandise.length > 0 && a.merchandiseBp > 0 ? { codes: new Set(a.merchandise) } : null,
  };
};

const chartOf = (chart: readonly DeptAccount[]) => {
  const byCode = new Map(chart.map((a) => [a.account_code, a] as const));
  const payroll = payrollAccounts(chart);
  const mixed = new Set(chart.filter((a) => isMixedAccount(a, payroll)).map((a) => a.account_code));
  return { byCode, payroll, mixed };
};

const deptOfAccount = (a: DeptAccount | undefined, plan: DepartmentPlan): DeptKey | null => {
  const home = accountHome(a).dept;
  return home === 'none' || home === 'hire' ? null : resolveDept(home, plan);
};

async function splitPeriod(sb: any, companyId: number, pnl: PnlReport, setup: { chart: DeptAccount[]; plan: DepartmentPlan }, legs: readonly SplitLeg[] | null) {
  const { byCode, payroll, mixed } = chartOf(setup.chart);
  const needed = new Set<string>([...pnl.expenses.filter((l) => mixed.has(l.code)).map((l) => l.code), ...pnl.otherIncome.map((l) => l.code)]);
  let read: readonly SplitLeg[] = legs ?? [];
  if (!legs) {
    const r = await readLegs(sb, companyId, [...needed], pnl.from, pnl.to);
    if (!r.ok) return { ok: false as const, reason: r.reason };
    read = r.legs;
  }
  const legsOf = new Map<string, SplitLeg[]>();
  for (const l of read) if (needed.has(l.accountCode)) legsOf.set(l.accountCode, [...(legsOf.get(l.accountCode) ?? []), l]);
  return {
    ok: true as const,
    blocks: splitPnlLines({
      lines: { tradingIncome: pnl.tradingIncome, costOfSales: pnl.costOfSales, otherIncome: pnl.otherIncome, expenses: pnl.expenses, taxation: pnl.taxation },
      chart: byCode, payroll, mixed, legsOf, plan: setup.plan,
    }),
  };
}

async function splitMonths(sb: any, companyId: number, ids: number[], setup: Setup, r: Range): Promise<{ ok: true; split: DeptMonthSplit[] } | Failed> {
  const src = dbSources(sb, companyId, ids);
  const { mixed } = chartOf(setup.chart);
  const incomeCodes = setup.chart.filter((a) => ['OTHER INCOMES', 'EXTRA-ORDINARY INCOME'].includes(String(a.section ?? '').toUpperCase())).map((a) => a.account_code);
  const legsRes = await readLegs(sb, companyId, [...new Set([...mixed, ...incomeCodes])], r.from, r.to);
  if (!legsRes.ok) return { ok: false, what: 'ledger', reason: legsRes.reason };
  const split: DeptMonthSplit[] = [];
  for (const m of r.months) {
    const from = `${m}-01`;
    const to = monthEnd(from);
    const p = await buildPnl(src, companyId, from, to);
    if (!p.ok) return { ok: false, what: 'P&L', reason: `${m}: ${p.reason}` };
    const sp = await splitPeriod(sb, companyId, p.report, setup, legsRes.legs.filter((l) => l.day >= from && l.day <= to));
    if (!sp.ok) return { ok: false, what: 'ledger', reason: sp.reason };
    split.push({ month: m, blocks: sp.blocks });
  }
  return { ok: true, split };
}

const performanceOf = (sb: any, companyId: number, ids: number[], r: Range) =>
  buildPerformanceMonths(companyId, r.months[0]!, r.months[r.months.length - 1]!, perfDbSources(sb, companyId, ids));

function deptOrders(dept: DeptKey, months: readonly PerformanceMonth[], setup: Setup): DeptOrders {
  const bills = months.flatMap((m) => (m.commission ? [m.commission] : []));
  const first = bills.at(0);
  const account = first ? setup.chart.find((a) => a.account_code === first.code) : undefined;
  const here = first !== undefined && deptOfAccount(account, setup.plan) === dept;
  return {
    months: months.map((m) => ({
      month: m.month, groups: m.groups, orders: { counted: m.orders.counted, notDelivered: m.orders.notDelivered },
      commission: here && m.commission ? { billSen: m.commission.billSen, releaseSen: m.commission.releaseSen } : null,
    })),
    commission: here ? {
      code: first.code,
      name: account?.account_name ?? first.name ?? first.code,
      label: commissionLabel({
        code: first.code, name: first.name, months: [...new Set(bills.flatMap((b) => b.months))].sort(),
        billSen: bills.reduce((s, b) => s + b.billSen, 0), releaseSen: bills.reduce((s, b) => s + b.releaseSen, 0),
      }),
    } : null,
  };
}

const expenseCodesOf = (chart: readonly DeptAccount[]): string[] =>
  [...new Set(chart.filter((a) => String(a.section ?? '').toUpperCase() === 'EXPENSES').map((a) => a.account_code))];

async function gaOf(sb: any, companyId: number, setup: Setup, layout: readonly LayoutItem[], r: Range, base: ReadonlyMap<string, number>): Promise<{ ok: true; g: GaPnl } | Failed> {
  const legsRes = await readLegs(sb, companyId, expenseCodesOf(setup.chart), r.from, r.to);
  if (!legsRes.ok) return { ok: false, what: 'ledger', reason: legsRes.reason };
  return {
    ok: true,
    g: buildGaPnl({
      months: r.months,
      sales: base,
      shareBp: setup.gaShareBp,
      legs: legsRes.legs,
      chart: new Map(setup.chart.map((a) => [a.account_code, a] as const)),
      payroll: payrollAccounts(setup.chart),
      plan: setup.plan,
      layout,
      companyId,
    }),
  };
}
const expenseLayout = (blocks: unknown): LayoutItem[] => (blocks as Partial<Record<string, LayoutItem[]>>).expenses ?? [];

async function operationOf(sb: any, companyId: number, setup: Setup, r: Range, lg: Extract<LogisticsPnlLoad, { ok: true }>): Promise<{ ok: true; p: OperationPnl } | Failed> {
  const spreadRes = await sb.from('acc_logistics_spreads').select('line_id, months').eq('company_id', companyId);
  if (spreadRes.error) return { ok: false, what: 'spreads', reason: spreadRes.error.message };
  const payroll = payrollAccounts(setup.chart);
  const opCodes = setup.chart.filter((a) => { const h = accountHome(a).dept; return h === 'operation' || h === 'hire'; }).map((a) => a.account_code);
  const spreadFrom = `${addMonths(r.months[0]!, -(MAX_SPREAD - 1))}-01`;
  const legsRes = await readLegs(sb, companyId, [...new Set([...payroll, ...opCodes])], spreadFrom, r.to);
  if (!legsRes.ok) return { ok: false, what: 'ledger', reason: legsRes.reason };

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
    fairs: m.fairs.map((f) => ({ id: f.id, code: f.code, name: f.name, venue: f.venue, region: f.region, incomeSen: f.incomeSen, costSen: f.chargeSen + f.dismantleSen + f.transportSen })),
  }] as const));
  return {
    ok: true,
    p: buildOperationPnl({
      months: r.months,
      incomeBp: setup.operationIncomeBp,
      logistics,
      bills: lg.billLines,
      legs: legsRes.legs,
      chart: new Map(setup.chart.map((a) => [a.account_code, a] as const)),
      payroll,
      spreadMonths: new Map(((spreadRes.data ?? []) as Row[]).map((x) => [String(x.line_id), Number(x.months)] as const)),
    }),
  };
}


type LogisticsOk = Extract<LogisticsPnlLoad, { ok: true }>;
const logisticsRowsOf = (lg: LogisticsOk): Map<string, Map<string, number>> =>
  new Map(lg.body.perMonth.map((m) => [m.month, new Map(m.rows.map((x) => [String(x.key), Number(x.totalSen ?? 0)] as const))] as const));

const OP_UNIT_INCOME = ['income_warehouse', 'income_2990', 'income_other'] as const;
const opLabelOf = (setup: Setup) => {
  const labels: Record<string, string> = { ...MANPOWER_LABEL, ...OP_ROW_LABEL, recruitment: RECRUITMENT_LABEL };
  const sheet = operationRows(setup.operationIncomeBp);
  return { sheet, label: (k: string): string => sheet.find((x) => x.key === k)?.label || labels[k] || k };
};
function operationUnitOf(setup: Setup, r: Range, charges: readonly MonthCharges[], op: OperationPnl): UnitView {
  const { sheet, label } = opLabelOf(setup);
  return buildOperationUnit({
    months: r.months, charges, operationBp: setup.operationIncomeBp, logisticsBp: setup.logisticsBp,
    income: OP_UNIT_INCOME.map((key) => ({ key, label: label(key) })),
    expenses: sheet.filter((x) => x.group === 'expense').map((x) => ({ key: x.key, label: label(x.key) })),
    rows: new Map(op.perMonth.map((m) => [m.month, new Map(Object.entries(m.rows).map(([k, cells]) => [k, opTotal(cells)] as const))] as const)),
  });
}
const logisticsUnitOf = (setup: Setup, r: Range, charges: readonly MonthCharges[], lg: LogisticsOk): UnitView =>
  buildLogisticsUnit({ months: r.months, charges, logisticsBp: setup.logisticsBp, rows: logisticsRowsOf(lg), trips: hasSetupDismantle(setup) });
const setupDismantleUnitOf = (setup: Setup, r: Range, charges: readonly MonthCharges[], split: readonly DeptMonthSplit[], lg: LogisticsOk): UnitView => {
  const rows = logisticsRowsOf(lg);
  return buildSetupDismantleUnit({
    months: r.months, charges, setupDismantleBp: setup.setupDismantleBp,
    fairTransport: bookedByAccount(split, new Set(setup.chargeAccounts.setupDismantle)),
    inHouse: new Map(r.months.map((m) => [m, rows.get(m)?.get('sd_income') ?? 0] as const)),
  });
};

/** Each supplier rebate rule of the company, read and estimated month by month
    (owner 2026-11-27: only for the selling department in Performance). */
type RebateRead = { rule: SupplierRebateRule; months: RebateMonth[] };
async function rebatesOf(sb: any, companyId: number, setup: Setup, r: Range): Promise<{ ok: true; reads: RebateRead[] } | Failed> {
  const reads: RebateRead[] = [];
  for (const rule of setup.supplierRebates) {
    const got = await loadRebateInputs(sb, companyId, rule, r.from, r.to);
    if (!got.ok) return { ok: false, what: `${rule.label} rebates`, reason: got.reason };
    reads.push({ rule, months: rebateMonths(rule, r.months, got.inputs.lines, got.inputs.notes) });
  }
  return { ok: true, reads };
}
const wantsRebates = (setup: Setup, dept: Department, basis: DeptBasis): boolean =>
  basis === 'performance' && dept === setup.plan.selling && setup.supplierRebates.length > 0;

function deptViewOf(input: {
  dept: Department; basis: DeptBasis; setup: Setup; r: Range; split: readonly DeptMonthSplit[]; perf: readonly PerformanceMonth[] | null;
  charges: readonly MonthCharges[]; layout: Readonly<Record<string, readonly LayoutItem[]>>; companyId: number;
  rebates: readonly RebateRead[] | null;
}) {
  const { dept, basis, setup } = input;
  const selling = dept === setup.plan.selling;
  return buildDeptView({
    dept, basis, months: input.r.months, split: input.split, layout: input.layout, companyId: input.companyId,
    orders: selling && basis === 'performance' && input.perf ? deptOrders(dept, input.perf, setup) : null,
    charges: selling ? deptChargesOf(setup, basis, input.charges) : null,
    rebates: wantsRebates(setup, dept, basis) && input.rebates ? input.rebates.flatMap((x): RebateFigure[] => rebateFigures(x.rule, x.months)) : null,
  });
}

export const departmentsPlanHandler = async (c: any): Promise<Response> => {
  if (!canRead(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const setup = await loadSetup(c.get('supabase'), co.companyId);
  if (!setup.ok) return fail(c, setup.what, setup.reason);
  return c.json(planBody(setup));
};

async function readLegs(sb: any, companyId: number, codes: readonly string[], from: string, to: string): Promise<{ ok: true; legs: Leg[] } | { ok: false; reason: string }> {
  const res = await chunkIn<Row>([...codes], (b, lo, hi) => sb.from('v_gl_entries')
    .select('line_id, account_code, account_name, entry_date, debit_sen, credit_sen, posted, reversed, reversed_by_je, notes, je_no, source_type')
    .eq('company_id', companyId).in('account_code', b).gte('entry_date', from).lte('entry_date', to)
    .order('line_id').range(lo, hi));
  if (res.error) return { ok: false, reason: res.error.message };
  return {
    ok: true,
    legs: res.data.filter((l) => countsInTheBooks(l)).map((l) => ({
      lineId: String(l.line_id), accountCode: String(l.account_code), accountName: l.account_name == null ? null : String(l.account_name),
      day: String(l.entry_date).slice(0, 10), debitSen: Number(l.debit_sen ?? 0), creditSen: Number(l.credit_sen ?? 0),
      notes: l.notes == null ? null : String(l.notes), docNo: l.je_no == null ? null : String(l.je_no),
      sourceType: l.source_type == null ? null : String(l.source_type),
    })),
  };
}

/** Every department's own P&L in a few figures, side by side (owner 2026-11-25), on the
    basis's sales: the selling department paying the others, G&A, Operation, Logistics and
    Setup & dismantle what they are paid less their real cost — and their total, in which
    what the departments pay each other comes out even. */
export const departmentsAllHandler = async (c: any): Promise<Response> => {
  if (!canRead(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const r = rangeOf(c);
  if (!r.ok) return r.res;
  const b = basisOf(c);
  if (!b.ok) return b.res;
  const basis = b.basis;
  const sb = c.get('supabase');
  const companyId = co.companyId;
  const ids = allowedIds(c);

  const [setup, laid] = await Promise.all([loadSetup(sb, companyId), resolveLayout(sb, ids, 'pnl')]);
  if (!setup.ok) return fail(c, setup.what, setup.reason);
  if (!laid.ok) return fail(c, 'P&L layout', laid.reason);
  const depts = setup.plan.departments;
  const has = (v: ViewKind) => depts.some((d) => viewOf(d) === v);
  const sd = hasSetupDismantle(setup);
  const [split, perf, lg, reb] = await Promise.all([
    splitMonths(sb, companyId, ids, setup, r),
    basis === 'performance' ? performanceOf(sb, companyId, ids, r) : Promise.resolve(null),
    has('operation') || has('logistics') || sd ? loadLogisticsPnl(c, companyId, r.from, r.to) : Promise.resolve(null),
    wantsRebates(setup, setup.plan.selling, basis) ? rebatesOf(sb, companyId, setup, r) : Promise.resolve(null),
  ]);
  if (!split.ok) return fail(c, split.what, split.reason);
  if (perf && !perf.ok) return fail(c, 'Performance P&L', perf.reason);
  if (lg && !lg.ok) return lg.res;
  if (reb && !reb.ok) return fail(c, reb.what, reb.reason);
  const perfMonths = perf?.ok ? perf.months : null;
  const charges = chargesFor(setup, basis, r.months, split.split, perfMonths);
  const [ga, op] = await Promise.all([
    has('ga') ? gaOf(sb, companyId, setup, expenseLayout(laid.layout.blocks), r, baseMap(charges)) : Promise.resolve(null),
    has('operation') && lg ? operationOf(sb, companyId, setup, r, lg) : Promise.resolve(null),
  ]);
  if (ga && !ga.ok) return fail(c, ga.what, ga.reason);
  if (op && !op.ok) return fail(c, op.what, op.reason);

  const summary: Partial<Record<Department | 'setupDismantle', DeptSummary>> = {};
  for (const d of depts) {
    const v = viewOf(d);
    if (v === 'ga' && ga?.ok) summary[d] = summaryOfGa(ga.g);
    else if (v === 'operation' && op?.ok) summary[d] = summaryOfUnit(operationUnitOf(setup, r, charges, op.p));
    else if (v === 'logistics' && lg?.ok) summary[d] = summaryOfUnit(logisticsUnitOf(setup, r, charges, lg));
    else if (v === 'dept') {
      summary[d] = summaryOfDept(deptViewOf({
        dept: d, basis, setup, r, split: split.split, perf: perfMonths, charges, layout: laid.layout.blocks, companyId, rebates: reb?.ok ? reb.reads : null,
      }));
    }
  }
  if (sd && lg?.ok) summary.setupDismantle = summaryOfUnit(setupDismantleUnitOf(setup, r, charges, split.split, lg));
  return c.json({
    from: r.from, to: r.to, basis,
    ...planBody(setup),
    rates: ratesOf(setup),
    summary,
    total: addSummaries(Object.values(summary)),
    unassigned: { label: NONE_LABEL, lines: unassignedOf(split.split) },
    logisticsProblem: lg?.ok ? (lg.body.fairsProblem ?? lg.body.tripsProblem ?? null) : null,
  });
};

export const departmentsGaHandler = async (c: any): Promise<Response> => {
  if (!canRead(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const r = rangeOf(c);
  if (!r.ok) return r.res;
  const b = basisOf(c);
  if (!b.ok) return b.res;
  const sb = c.get('supabase');
  const companyId = co.companyId;
  const ids = allowedIds(c);

  const [setup, laid] = await Promise.all([loadSetup(sb, companyId), resolveLayout(sb, ids, 'pnl')]);
  if (!setup.ok) return fail(c, setup.what, setup.reason);
  if (!laid.ok) return fail(c, 'P&L layout', laid.reason);
  const [split, perf] = await Promise.all([
    b.basis === 'actual' ? splitMonths(sb, companyId, ids, setup, r) : Promise.resolve(null),
    b.basis === 'performance' ? performanceOf(sb, companyId, ids, r) : Promise.resolve(null),
  ]);
  if (split && !split.ok) return fail(c, split.what, split.reason);
  if (perf && !perf.ok) return fail(c, 'Performance P&L', perf.reason);
  const charges = chargesFor(setup, b.basis, r.months, split?.ok ? split.split : null, perf?.ok ? perf.months : null);
  const ga = await gaOf(sb, companyId, setup, expenseLayout(laid.layout.blocks), r, baseMap(charges));
  if (!ga.ok) return fail(c, ga.what, ga.reason);
  return c.json({ from: r.from, to: r.to, basis: b.basis, ...ga.g });
};

export const departmentViewHandler = async (c: any): Promise<Response> => {
  if (!canRead(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const r = rangeOf(c);
  if (!r.ok) return r.res;
  const b = basisOf(c);
  if (!b.ok) return b.res;
  const sb = c.get('supabase');
  const companyId = co.companyId;
  const ids = allowedIds(c);
  const [setup, laid] = await Promise.all([loadSetup(sb, companyId), resolveLayout(sb, ids, 'pnl')]);
  if (!setup.ok) return fail(c, setup.what, setup.reason);
  if (!laid.ok) return fail(c, 'P&L layout', laid.reason);
  const d = String(c.req.query('d') ?? '');
  const dept = setup.plan.departments.find((x) => x === d);
  if (!dept) return c.json({ error: 'bad_department', message: `${d || '(none)'} is not one of this company's departments.` }, 400);

  const selling = dept === setup.plan.selling;
  const [split, perf, reb] = await Promise.all([
    splitMonths(sb, companyId, ids, setup, r),
    selling && b.basis === 'performance' ? performanceOf(sb, companyId, ids, r) : Promise.resolve(null),
    wantsRebates(setup, dept, b.basis) ? rebatesOf(sb, companyId, setup, r) : Promise.resolve(null),
  ]);
  if (!split.ok) return fail(c, split.what, split.reason);
  if (perf && !perf.ok) return fail(c, 'Performance P&L', perf.reason);
  if (reb && !reb.ok) return fail(c, reb.what, reb.reason);
  const perfMonths = perf?.ok ? perf.months : null;
  const charges = selling ? chargesFor(setup, b.basis, r.months, split.split, perfMonths) : [];
  const view = deptViewOf({
    dept, basis: b.basis, setup, r, split: split.split, perf: perfMonths, charges, layout: laid.layout.blocks, companyId, rebates: reb?.ok ? reb.reads : null,
  });
  return c.json({
    from: r.from, to: r.to, label: DEPARTMENT_LABEL[dept], rates: ratesOf(setup), ...view,
    merchandiseAccounts: selling ? setup.chargeAccounts.merchandise : [],
    rebateRules: selling ? setup.supplierRebates : null,
  });
};

const unitLabel = (u: UnitKind): string => (u === 'setupDismantle' ? SETUP_DISMANTLE_LABEL : DEPARTMENT_LABEL[u]);
const isUnit = (v: string): v is UnitKind => v === 'operation' || v === 'logistics' || v === 'setupDismantle';
/** Operation, Logistics or Setup & dismantle month by month on the basis's sales: what it is
    paid, less its real cost. Operation brings the sheet's lines (what a figure opens). */
export const departmentUnitHandler = async (c: any): Promise<Response> => {
  if (!canRead(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const r = rangeOf(c);
  if (!r.ok) return r.res;
  const b = basisOf(c);
  if (!b.ok) return b.res;
  const u = String(c.req.query('u') ?? '');
  if (!isUnit(u)) return c.json({ error: 'bad_unit', message: 'u is operation, logistics or setupDismantle.' }, 400);
  const sb = c.get('supabase');
  const companyId = co.companyId;
  const ids = allowedIds(c);
  const setup = await loadSetup(sb, companyId);
  if (!setup.ok) return fail(c, setup.what, setup.reason);
  const offered = u === 'setupDismantle' ? hasSetupDismantle(setup) : setup.plan.departments.includes(u);
  if (!offered) return c.json({ error: 'bad_department', message: `This company has no ${unitLabel(u)} P&L — its costs count in another department.` }, 400);

  const [split, perf, lg] = await Promise.all([
    b.basis === 'actual' || u === 'setupDismantle' ? splitMonths(sb, companyId, ids, setup, r) : Promise.resolve(null),
    b.basis === 'performance' ? performanceOf(sb, companyId, ids, r) : Promise.resolve(null),
    loadLogisticsPnl(c, companyId, r.from, r.to),
  ]);
  if (split && !split.ok) return fail(c, split.what, split.reason);
  if (perf && !perf.ok) return fail(c, 'Performance P&L', perf.reason);
  if (!lg.ok) return lg.res;
  const splitMonthsRead = split?.ok ? split.split : null;
  const charges = chargesFor(setup, b.basis, r.months, splitMonthsRead, perf?.ok ? perf.months : null);
  const common = {
    from: r.from, to: r.to, basis: b.basis, label: unitLabel(u), rates: ratesOf(setup),
    base: Object.fromEntries(charges.map((m) => [m.month, m.baseSen])),
    logisticsProblem: lg.body.fairsProblem ?? lg.body.tripsProblem ?? null,
  };
  if (u === 'operation') {
    const op = await operationOf(sb, companyId, setup, r, lg);
    if (!op.ok) return fail(c, op.what, op.reason);
    const view = operationUnitOf(setup, r, charges, op.p);
    const keys = new Set(view.rows.map((x) => x.key));
    return c.json({ ...common, ...view, regions: OP_REGIONS, lines: op.p.lines.filter((l) => keys.has(l.row)) });
  }
  const view = u === 'logistics' ? logisticsUnitOf(setup, r, charges, lg) : setupDismantleUnitOf(setup, r, charges, splitMonthsRead ?? [], lg);
  return c.json({ ...common, ...view, regions: OP_REGIONS, lines: [] });
};

export const departmentsOperationHandler = async (c: any): Promise<Response> => {
  if (!canRead(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const r = rangeOf(c);
  if (!r.ok) return r.res;
  const sb = c.get('supabase');
  const companyId = co.companyId;

  const [setup, lg] = await Promise.all([loadSetup(sb, companyId), loadLogisticsPnl(c, companyId, r.from, r.to)]);
  if (!setup.ok) return fail(c, setup.what, setup.reason);
  if (!lg.ok) return lg.res;
  if (!setup.plan.departments.includes('operation')) {
    return c.json({ error: 'bad_department', message: "This company has no Operation department — its operation costs count in another." }, 400);
  }
  const op = await operationOf(sb, companyId, setup, r, lg);
  if (!op.ok) return fail(c, op.what, op.reason);
  const labels: Record<string, string> = { ...MANPOWER_LABEL, ...OP_ROW_LABEL, recruitment: RECRUITMENT_LABEL };
  return c.json({
    from: r.from, to: r.to,
    ...op.p,
    rows: operationRows(setup.operationIncomeBp).map((x) => ({ ...x, label: x.label || labels[x.key as ManpowerRow | OpRow] || x.key })),
    regions: OP_REGIONS,
    logisticsIncomeBp: lg.body.doIncomeBp,
    logisticsProblem: lg.body.fairsProblem ?? lg.body.tripsProblem ?? null,
  });
};


/** The most accounts one read names (a block's every account). */
export const LINES_KEYS_MAX = 2000;

/** One line behind a figure: a ledger line, the stock engine's opening or closing stock
    (the P&L's own, not a journal line), the commission on orders — a commission bill on
    the prepayment, in the month it pays for — or a month's merchandise at its rate. `sen`
    in the figure's sign. */
export type DeptEntry = {
  id: string; month: string; day: string | null;
  accountCode: string; accountName: string | null;
  ref: string | null; text: string | null;
  dept: DeptKey; team: GaTeam | null;
  sen: number;
  source: 'ledger' | 'stock_opening' | 'stock_closing' | 'rest' | 'bill' | 'rate';
};
const linesBody = (lines: DeptEntry[]) => {
  lines.sort((a, b) => (a.day ?? '').localeCompare(b.day ?? '') || a.accountCode.localeCompare(b.accountCode) || a.id.localeCompare(b.id));
  return { lines, totalSen: lines.reduce((x, l) => x + l.sen, 0) };
};
const isRelease = (sourceType: string | null | undefined): boolean => String(sourceType ?? '').replace(/_REVERSAL$/, '') === RELEASE_SOURCE;

/**
 * GET /departments/lines?view=dept|ga|sd&dbasis=&from=&to=&keys=…[&block=][&d=]
 * The lines behind one figure of a department's own P&L, G&A or Setup & dismantle —
 * read and split by the rules that made the figure, so they add up to it:
 *   view=dept  `block`; the department `d`; the column's months, each month read
 *              as the view reads it (its own opening and closing stock). The selling
 *              department in Performance has no lines behind its sales and cost of
 *              sales (they are the orders'), its commission account's are its bills,
 *              not the release, and its merchandise is each month's at its rate; the
 *              fair transport Setup & dismantle carries is not its;
 *   view=ga    the column's months; a key is an account's code or team:<TEAM>;
 *   view=sd    Setup & dismantle's fair transport accounts, as booked.
 * `keys`: the accounts under the figure's row (one account, a category's, a block's).
 */
export const departmentLinesHandler = async (c: any): Promise<Response> => {
  if (!canRead(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const r = rangeOf(c);
  if (!r.ok) return r.res;
  const b = basisOf(c);
  if (!b.ok) return b.res;
  const view = String(c.req.query('view') ?? '');
  if (view !== 'dept' && view !== 'ga' && view !== 'sd') return c.json({ error: 'bad_view', message: 'view is dept, ga or sd.' }, 400);
  const keys = [...new Set(String(c.req.query('keys') ?? '').split(',').map((k) => k.trim()).filter(Boolean))];
  if (keys.length === 0 || keys.length > LINES_KEYS_MAX) return c.json({ error: 'bad_keys', message: `Name from 1 to ${LINES_KEYS_MAX} accounts.` }, 400);
  const sb = c.get('supabase');
  const companyId = co.companyId;
  const setup = await loadSetup(sb, companyId);
  if (!setup.ok) return fail(c, setup.what, setup.reason);
  const { byCode, payroll, mixed } = chartOf(setup.chart);
  const nameOf = (code: string): string | null => byCode.get(code)?.account_name ?? null;

  if (view === 'ga') {
    const asked = new Set(keys);
    const expense = new Set(expenseCodesOf(setup.chart));
    const codes = [...new Set([...keys.filter((k) => !k.startsWith('team:')), ...(keys.some((k) => k.startsWith('team:')) ? payroll : [])])].filter((k) => expense.has(k));
    const legs = await readLegs(sb, companyId, codes, r.from, r.to);
    if (!legs.ok) return fail(c, 'ledger', legs.reason);
    const lines = gaLines({ months: r.months, legs: legs.legs, chart: byCode, payroll, plan: setup.plan })
      .filter((g) => asked.has(g.key))
      .map((g): DeptEntry => ({
        id: g.leg.lineId, month: g.month, day: g.leg.day, accountCode: g.leg.accountCode, accountName: g.leg.accountName ?? nameOf(g.leg.accountCode),
        ref: g.leg.docNo, text: g.leg.notes, dept: 'ga', team: g.team, sen: g.sen, source: 'ledger',
      }));
    return c.json(linesBody(lines));
  }

  if (view === 'sd') {
    const moved = new Set(hasSetupDismantle(setup) ? setup.chargeAccounts.setupDismantle : []);
    const codes = keys.filter((k) => moved.has(k));
    if (codes.length === 0) return c.json({ error: 'bad_keys', message: "Name Setup & dismantle's fair transport accounts." }, 400);
    const legs = await readLegs(sb, companyId, codes, r.from, r.to);
    if (!legs.ok) return fail(c, 'ledger', legs.reason);
    return c.json(linesBody(legs.legs.filter((l) => l.debitSen !== l.creditSen).map((l): DeptEntry => ({
      id: l.lineId, month: l.day.slice(0, 7), day: l.day, accountCode: l.accountCode, accountName: l.accountName ?? nameOf(l.accountCode),
      ref: l.docNo, text: l.notes, dept: setup.plan.selling, team: null, sen: l.debitSen - l.creditSen, source: 'ledger',
    }))));
  }

  const blockArg = String(c.req.query('block') ?? '');
  const blockDef = PNL_BLOCKS.find((b) => b.block === blockArg);
  if (!blockDef) return c.json({ error: 'bad_block', message: `block is one of ${PNL_BLOCKS.map((b) => b.block).join(', ')}.` }, 400);
  const block = blockDef.block;
  const d = String(c.req.query('d') ?? '');
  const dept = setup.plan.departments.find((x) => x === d);
  if (!dept) return c.json({ error: 'bad_department', message: `${d || '(none)'} is not one of this company's departments.` }, 400);
  const selling = dept === setup.plan.selling;
  const onOrders = selling && b.basis === 'performance';
  if (onOrders && (block === 'tradingIncome' || block === 'costOfSales')) {
    return c.json({ error: 'from_orders', message: "These figures are the sales orders' (the Performance P&L's), not ledger lines." }, 400);
  }
  const dc = selling && block === 'expenses' ? deptChargesOf(setup, b.basis, []) : null;
  const merch = dc?.merchandise ? [...dc.merchandise.codes].sort() : [];
  const asked = keys.filter((k) => !dc?.moved.has(k) && !merch.includes(k) && !k.startsWith('rebate:'));
  const rateLines: DeptEntry[] = [];
  if (onOrders && block === 'otherIncome' && wantsRebates(setup, dept, b.basis) && keys.some((k) => k.startsWith('rebate:'))) {
    const reb = await rebatesOf(sb, companyId, setup, r);
    if (!reb.ok) return fail(c, reb.what, reb.reason);
    for (const { rule, months } of reb.reads) {
      for (const kind of ['sponsor', 'sales'] as const) {
        const key = rebateKey(rule.supplierCode, kind);
        if (!keys.includes(key)) continue;
        for (const m of months) {
          const sen = kind === 'sponsor' ? m.sponsorSen : m.salesSen;
          if (sen === 0) continue;
          rateLines.push({
            id: `${key}:${m.month}`, month: m.month, day: null, accountCode: rule.supplierCode, accountName: `${rule.label} ${kind} rebate (estimate)`,
            ref: null, text: rebateWorking(rule, m, kind), dept, team: null, sen, source: 'rate',
          });
        }
      }
    }
  }
  if (merch.length > 0 && keys.includes(merch[0]!)) {
    const perf = await performanceOf(sb, companyId, allowedIds(c), r);
    if (!perf.ok) return fail(c, 'Performance P&L', perf.reason);
    const rate = (setup.chargeAccounts.merchandiseBp / 100).toFixed(2).replace(/\.?0+$/, '');
    for (const m of chargesFor(setup, b.basis, r.months, null, perf.months)) {
      if (m.merchandise === 0) continue;
      rateLines.push({
        id: `rate:${m.month}`, month: m.month, day: null, accountCode: merch[0]!, accountName: 'Merchandise', ref: null,
        text: `${rate}% of the month's sales excluding service (${fmtMoneySen(m.baseSen)})`, dept, team: null, sen: m.merchandise, source: 'rate',
      });
    }
  }

  let commission: { code: string; prepaid: string; bills: PrepaidLedgerLine[] } | null = null;
  if (onOrders && block === 'expenses') {
    const roles = await resolveRoles(sb, companyId);
    const code = roles.COMMISSION_EXPENSE;
    if (keys.includes(code) && deptOfAccount(byCode.get(code), setup.plan) === dept) {
      const pre = await loadPrepaidLines(sb, companyId, roles.COMMISSION_PREPAID);
      if (!pre.ok) return fail(c, 'commission bills', pre.reason);
      commission = { code, prepaid: roles.COMMISSION_PREPAID, bills: pre.lines.filter((l) => l.month != null) };
    }
  }

  const periods = r.months.map((m) => ({ from: `${m}-01`, to: monthEnd(`${m}-01`) }));
  const stock: Array<Awaited<ReturnType<typeof pnlStockLines>> & { ok: true }> = [];
  if (block === 'costOfSales') {
    const src = dbSources(sb, companyId, allowedIds(c));
    for (const p of periods) {
      const s = await pnlStockLines(src, p.from, p.to);
      if (!s.ok) return fail(c, 'stock', s.reason);
      stock.push(s);
    }
  }
  const stockCodes = new Set(stock.flatMap((s) => [...s.codes]));
  const legsRes = await readLegs(sb, companyId, asked.filter((k) => !stockCodes.has(k)), r.from, r.to);
  if (!legsRes.ok) return fail(c, 'ledger', legsRes.reason);

  const lines: DeptEntry[] = [...rateLines];
  periods.forEach((p, i) => {
    const legsOf = new Map<string, typeof legsRes.legs>();
    for (const l of legsRes.legs) if (l.day >= p.from && l.day <= p.to) legsOf.set(l.accountCode, [...(legsOf.get(l.accountCode) ?? []), l]);
    for (const code of asked) {
      const billed = commission != null && code === commission.code;
      const engine = stockCodes.has(code) ? (stock[i]?.lines ?? []).filter((x) => x.code === code) : null;
      const legs = engine ? undefined : (legsOf.get(code) ?? []).filter((l) => !billed || !isRelease(l.sourceType));
      const amountSen = engine ? engine.reduce((x, l) => x + l.amountSen, 0) : legs!.reduce((x, l) => x + blockDef.sign * (l.debitSen - l.creditSen), 0);
      const parts = amountSen === 0 ? [] : splitPnlLineParts({ block, code, amountSen, chart: byCode, payroll, mixed, legs, plan: setup.plan, itemize: true });
      for (const part of parts) {
        if (part.dept !== dept) continue;
        if (part.leg) {
          lines.push({
            id: part.leg.lineId, month: part.leg.day.slice(0, 7), day: part.leg.day, accountCode: code, accountName: part.leg.accountName ?? nameOf(code),
            ref: part.leg.docNo, text: part.leg.notes, dept: part.dept, team: null, sen: part.sen, source: 'ledger',
          });
        } else if (engine) {
          for (const e of engine) {
            const opening = e.stock === 'opening';
            lines.push({
              id: `stock:${p.from}:${code}:${e.stock}`, month: (opening ? p.from : p.to).slice(0, 7), day: opening ? p.from : p.to,
              accountCode: code, accountName: e.name, ref: null,
              text: opening ? 'Opening stock (the stock engine)' : `Closing stock (the stock engine)${stock[i]!.closingProvisional ? ' — provisional until the month is closed' : ''}`,
              dept: part.dept, team: null, sen: e.amountSen, source: opening ? 'stock_opening' : 'stock_closing',
            });
          }
        } else {
          lines.push({
            id: `rest:${p.from}:${code}`, month: p.to.slice(0, 7), day: null, accountCode: code, accountName: nameOf(code), ref: null,
            text: 'Not on a ledger line', dept: part.dept, team: null, sen: part.sen, source: 'rest',
          });
        }
      }
      if (billed) {
        const month = p.from.slice(0, 7);
        commission!.bills.filter((b) => b.month === month).forEach((b, k) => lines.push({
          id: `bill:${month}:${b.jeNo}:${k}`, month, day: b.entryDate, accountCode: commission!.prepaid, accountName: nameOf(commission!.prepaid),
          ref: b.docNo || b.jeNo, text: b.notes, dept, team: null, sen: b.amountSen, source: 'bill',
        }));
      }
    }
  });
  return c.json(linesBody(lines));
};

export const saveDepartmentRateHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json({ error: NO_RIGHT }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const dept = String(body?.dept ?? '');
  if (dept !== 'ga' && dept !== 'operation' && dept !== 'merchandise') {
    return c.json({ error: 'bad_dept', message: "The rate is G&A's (ga), Operation's (operation) or merchandise's (merchandise)." }, 400);
  }
  const pct = Number(body?.pct);
  if (typeof body?.pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100 || Math.round(pct * 100) !== pct * 100) {
    return c.json({ error: 'bad_pct', message: 'The rate is a percentage from 0 to 100, two decimals at most.' }, 400);
  }
  const bp = Math.round(pct * 100);
  const sb = c.get('supabase');
  let change: Record<string, unknown>;
  if (dept === 'merchandise') {
    const cur = await sb.from('acc_department_settings').select('charges').eq('company_id', co.companyId).maybeSingle();
    if (cur.error) return c.json({ error: 'save_failed', message: 'The rate could not be saved — try again.', reason: cur.error.message }, 500);
    const raw = (cur.data as { charges?: unknown } | null)?.charges;
    change = { charges: { ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}), merchandiseBp: bp } };
  } else {
    change = { [dept === 'ga' ? 'ga_share_bp' : 'operation_income_bp']: bp };
  }
  const { error } = await sb.from('acc_department_settings').upsert(
    { company_id: co.companyId, ...change, updated_at: new Date().toISOString(), updated_by: actorOf(c) },
    { onConflict: 'company_id' },
  );
  if (error) return c.json({ error: 'save_failed', message: 'The rate could not be saved — try again.', reason: error.message }, 500);
  return c.json({ ok: true, dept, bp });
};

/** The company's supplier rebate rules, replaced whole (owner 2026-11-27: 「做设定框」 —
    Finance types the supplier's terms once; they live in the settings, never in the code).
    Finance's money right, like the rates; each rule's supplier is one of the company's. */
export const saveSupplierRebatesHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json({ error: NO_RIGHT }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const read = readSupplierRebateRules(body?.rules);
  if (!read.ok) return c.json({ error: 'bad_rules', message: read.message }, 400);
  const sb = c.get('supabase');
  const codes = read.rules.map((r) => r.supplierCode);
  if (codes.length > 0) {
    const found = await sb.from('suppliers').select('code').eq('company_id', co.companyId).in('code', codes);
    if (found.error) return c.json({ error: 'save_failed', message: 'The rules could not be checked — try again.', reason: found.error.message }, 500);
    const known = new Set(((found.data ?? []) as Row[]).map((x) => String(x.code ?? '').trim().toUpperCase()));
    const missing = codes.filter((k) => !known.has(k));
    if (missing.length > 0) return c.json({ error: 'unknown_supplier', message: `${missing.join(', ')} is not a supplier of this company.` }, 400);
  }
  const { error } = await sb.from('acc_department_settings').upsert(
    { company_id: co.companyId, supplier_rebates: read.rules.length > 0 ? read.rules : null, updated_at: new Date().toISOString(), updated_by: actorOf(c) },
    { onConflict: 'company_id' },
  );
  if (error) return c.json({ error: 'save_failed', message: 'The rules could not be saved — try again.', reason: error.message }, 500);
  return c.json({ ok: true, rules: read.rules });
};
