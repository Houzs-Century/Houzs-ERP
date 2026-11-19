// ----------------------------------------------------------------------------
// department-pnl — the Department P&L's arithmetic (owner 2026-11-19). Three
// views, each from the books, nothing typed (「不要我填」):
//
//   ALL — the whole P&L, every account on the P&L's own tree, its figure split
//     across G&A | Operation | Logistics | not in a department, the Total being
//     the P&L's own figure (splitLine). Booked amounts only: no shares, no spreads.
//
//   OPERATION — the owner's "Operation PNL - Auto" sheet (Sept26 - Logistic &
//     Operation Cost.xlsx), by region PG | KL (Singapore goes out of KL) | SBH & SWK:
//       Delivery Order; 7% Income from Delivery Order (Finance's rate); Income:
//       Warehouse income ("WAREHOUSE CHARGES - <month>" bills), 2990 income
//       ("OPERATION CHARGES - <month>" bills to 2990), each in the month it names;
//       (-) Logistic Expense = the Logistics P&L's own Transport Income (3% of DO),
//       so the two reports agree; Gross Profit; Warehouse expenses — manpower by
//       the salary journal's team lines (a line naming a region is that region's,
//       else shared by the month's DO value), each Operation row of the Chart of
//       Accounts' Department column in its region, upkeep and insurance bills
//       spread over their months (insurance 12 until Finance says otherwise); Net
//       Profit; Profit From Logistics = the Logistics P&L's net less its fair
//       income; Profit From Setup/Dismantle = each fair's transport income less its
//       in-house charge and outsourced transport; the net after both. Every amount
//       is booked by journal date; a recharge goes by the month it names.
//       The sheet's TOTAL Gross Profit left out the warehouse and 2990 income; here
//       a Total is always its regions added up.
//
//   G&A — admin, IT, legal and HQ (the owner's requirements, §3 Department P&L):
//     its share of the month's Performance sales (8% until Finance changes it)
//     against what G&A booked — the payroll lines of the HQ teams and every account
//     the Department column gives G&A, on the P&L's own tree — and the surplus.
// ----------------------------------------------------------------------------

import { share, type RegionCode } from './logistics-cost';
import { addMonths, incomeRowOf, monthNamed, type BillLine, type IncomeRow, type Leg } from './logistics-pnl';
import { layOutBlock, type LaidLine, type LaidNode, type LayoutItem } from '../../acc/report-layout';
import {
  GA_TEAMS, GA_TEAM_LABEL, MANPOWER_ROWS, OP_REGION_CODES, OP_ROWS, accountHome, lineHome, resolveDept,
  type DepartmentPlan, type DeptAccount, type DeptKey, type GaTeam, type LineHome, type ManpowerRow, type Nature, type OpRegion, type OpRow,
} from './department-rows';

const monthOf = (day: string): string => day.slice(0, 7);

/* ── ALL: one P&L line split across the departments ───────────────────────── */

/** A P&L line's figure per department of the company (and `none`), keyed by DeptKey. */
export type DeptCells = Partial<Record<DeptKey, number>>;
export const zeroDeptCells = (plan: DepartmentPlan): DeptCells =>
  Object.fromEntries([...plan.departments, 'none'].map((k) => [k, 0])) as DeptCells;

export type SplitLeg = { accountCode: string; notes: string | null; debitSen: number; creditSen: number };

/** The P&L's blocks, how each reads (debit- or credit-positive) and the nature of a
    line nothing else places: sales and cost of sales are the selling department's,
    other income and taxation G&A's; an expense nothing places is in no department yet. */
export type PnlBlock = 'tradingIncome' | 'costOfSales' | 'otherIncome' | 'expenses' | 'taxation';
export const PNL_BLOCKS: ReadonlyArray<{ block: PnlBlock; sign: 1 | -1; recharge: boolean; fallback: Nature | 'none' }> = [
  { block: 'tradingIncome', sign: -1, recharge: false, fallback: 'sales' },
  { block: 'costOfSales', sign: 1, recharge: false, fallback: 'sales' },
  { block: 'otherIncome', sign: -1, recharge: true, fallback: 'ga' },
  { block: 'expenses', sign: 1, recharge: false, fallback: 'none' },
  { block: 'taxation', sign: 1, recharge: false, fallback: 'ga' },
];

/**
 * What each department took of one P&L line. `sign` +1 reads a line debit-positive
 * (cost of sales, expenses, taxation), -1 credit-positive (income). A line whose
 * account mixes departments (a payroll or recruitment account, an income account
 * Other Debtor recharges land on) is split leg by leg; any other goes whole to its
 * account's department. A nature the company has no department for counts where
 * its plan folds it. Whatever the legs do not explain goes to the account's own
 * department, so the cells always add up to the line.
 */
export function splitLine(input: {
  amountSen: number; sign: 1 | -1; account: DeptAccount | undefined;
  legs: readonly SplitLeg[] | undefined; payroll: boolean; recharge: boolean; mixed: boolean;
  fallback: Nature | 'none'; plan: DepartmentPlan;
}): DeptCells {
  const cells = zeroDeptCells(input.plan);
  const home = accountHome(input.account).dept;
  const ownNature: Nature | 'none' = home === 'none' || home === 'hire' ? input.fallback : home;
  const add = (nature: Nature | 'none', sen: number) => {
    const k = resolveDept(nature, input.plan);
    cells[k] = (cells[k] ?? 0) + sen;
  };
  let placed = 0;
  if (input.legs && (input.mixed || input.recharge)) {
    for (const l of input.legs) {
      const sen = input.sign * (l.debitSen - l.creditSen);
      if (sen === 0) continue;
      const lh = lineHome(input.account, l.notes, { payroll: input.payroll, recharge: input.recharge }).dept;
      add(lh === 'none' ? input.fallback : lh, sen);
      placed += sen;
    }
  }
  add(ownNature, input.amountSen - placed);
  return cells;
}

/** Each P&L line of each block, split: the lines the P&L printed, their account, legs. */
export function splitPnlLines(input: {
  lines: Record<PnlBlock, ReadonlyArray<{ code: string; name: string; amountSen: number }>>;
  chart: ReadonlyMap<string, DeptAccount>; payroll: ReadonlySet<string>; mixed: ReadonlySet<string>;
  legsOf: ReadonlyMap<string, readonly SplitLeg[]>; plan: DepartmentPlan;
}): Record<PnlBlock, Array<{ code: string; name: string; amountSen: number; cells: DeptCells }>> {
  const out = {} as Record<PnlBlock, Array<{ code: string; name: string; amountSen: number; cells: DeptCells }>>;
  for (const { block, sign, recharge, fallback } of PNL_BLOCKS) {
    out[block] = input.lines[block].map((l) => ({
      code: l.code, name: l.name, amountSen: l.amountSen,
      cells: splitLine({
        amountSen: l.amountSen, sign, account: input.chart.get(l.code), legs: input.legsOf.get(l.code),
        payroll: block === 'expenses' && input.payroll.has(l.code), recharge, mixed: block === 'expenses' && input.mixed.has(l.code),
        fallback, plan: input.plan,
      }),
    }));
  }
  return out;
}

/* ── OPERATION ───────────────────────────────────────────────────────────── */

export type OpCells = Record<OpRegion, number>;
const zeroOp = (): OpCells => ({ PG: 0, KL: 0, EM: 0 });
const opTotal = (c: OpCells): number => c.PG + c.KL + c.EM;
/** A Logistics region in the Operation sheet's columns: Singapore goes out of KL. */
export const opRegionOf = (r: RegionCode): OpRegion => (r === 'SG' ? 'KL' : r);
const fold = (by: Partial<Record<RegionCode, number>>): OpCells => {
  const out = zeroOp();
  for (const [r, v] of Object.entries(by) as Array<[RegionCode, number | null | undefined]>) out[opRegionOf(r)] += Number(v ?? 0);
  return out;
};

export type OpRowKey =
  | 'do_value' | 'do_income' | 'income_warehouse' | 'income_2990' | 'income_other' | 'logistic_expense' | 'gross'
  | ManpowerRow | 'recruitment' | OpRow | 'total_expense' | 'net' | 'logistics_net' | 'sd_net' | 'net_after';

/** The sheet's rows, in its order. `kind`: what the screen draws it as. */
export type OpRowGroup = 'head' | 'gross' | 'expense' | 'expense_total' | 'result';
/** The sheet's rows, in its order: `kind` = how the screen draws it, `group` = which
    rows add up into Gross Profit ('gross'), the warehouse block ('expense', its total
    'expense_total'), and the rows that stand alone. `optional`: drawn only when not nil. */
export function operationRows(incomeBp: number): Array<{ key: OpRowKey; label: string; kind: 'line' | 'strong' | 'final'; group: OpRowGroup; optional?: boolean }> {
  const pct = (bp: number) => (bp / 100).toFixed(2).replace(/\.?0+$/, '');
  return [
    { key: 'do_value', label: 'Delivery Order', kind: 'strong', group: 'head' },
    { key: 'do_income', label: `${pct(incomeBp)}% Income from Delivery Order`, kind: 'line', group: 'gross' },
    { key: 'income_warehouse', label: 'Income:- Warehouse income', kind: 'line', group: 'gross' },
    { key: 'income_2990', label: 'Income:- 2990 income', kind: 'line', group: 'gross' },
    { key: 'income_other', label: 'Income:- Other operation charges', kind: 'line', group: 'gross', optional: true },
    { key: 'logistic_expense', label: '(-) Logistic Expense', kind: 'line', group: 'gross' },
    { key: 'gross', label: 'Gross Profit / (Loss)', kind: 'strong', group: 'result' },
    ...MANPOWER_ROWS.map((key) => ({ key, label: '', kind: 'line' as const, group: 'expense' as const })),
    { key: 'recruitment', label: '', kind: 'line', group: 'expense', optional: true },
    ...OP_ROWS.map((key) => ({ key, label: '', kind: 'line' as const, group: 'expense' as const })),
    { key: 'total_expense', label: 'Total Warehouse Expenses', kind: 'strong', group: 'expense_total' },
    { key: 'net', label: 'Net Profit / (Loss)', kind: 'strong', group: 'result' },
    { key: 'logistics_net', label: 'Profit / (Loss) From Logistics', kind: 'line', group: 'result' },
    { key: 'sd_net', label: 'Profit / (Loss) From Setup/Dismantle', kind: 'line', group: 'result' },
    { key: 'net_after', label: 'Net Profit / (Loss) After Logistics & Setup/Dismantle', kind: 'final', group: 'result' },
  ];
}
const ROWS_OF = (group: OpRowGroup): OpRowKey[] => operationRows(0).filter((r) => r.group === group).map((r) => r.key);

/** One month of the Logistics P&L as the Operation sheet reads it. */
export type LogisticsMonthIn = {
  /** The DOs' value, their count, the P&L's Transport Income (its % of DO), its
      fair income and its net — each by Logistics region. */
  doValue: Partial<Record<RegionCode, number>>;
  doCount: Partial<Record<RegionCode, number>>;
  transportIncome: Partial<Record<RegionCode, number>>;
  fairIncome: Partial<Record<RegionCode, number>>;
  net: Partial<Record<RegionCode, number>>;
  /** Each fair opened in the month: its transport income and its setup / dismantle
      transport cost (the in-house charge and the outsourced lines). */
  fairs: ReadonlyArray<{ region: RegionCode; incomeSen: number; costSen: number }>;
};

/** The sheet's row an OPERATION CHARGES line fills, by who was billed — the Logistics
    P&L's own reading of the debtor (incomeRowOf): the owner's "Income:- 2990 income". */
const CHARGES_ROW: Record<IncomeRow, 'income_2990' | 'income_other'> = { '2990': 'income_2990', houzs: 'income_other', conts: 'income_other', hookka: 'income_other' };

export type OpSpreadKind = 'upkeep' | 'insurance';
export const OP_DEFAULT_SPREAD: Record<OpSpreadKind, number> = { upkeep: 1, insurance: 12 };

export type OpSpreadRow = {
  lineId: string; kind: OpSpreadKind; accountCode: string; accountName: string | null; day: string; docNo: string | null; notes: string | null;
  amountSen: number; region: OpRegion; months: number; isDefault: boolean; perMonthSen: number; inRangeSen: number; lastMonth: string;
};
export type OpIncomeLine = BillLine & { month: string; key: 'income_warehouse' | 'income_2990' | 'income_other'; region: OpRegion };
export type OpManpowerLine = {
  lineId: string; day: string; accountCode: string; accountName: string | null; notes: string | null; amountSen: number;
  row: ManpowerRow; region: OpRegion | null; cells: OpCells;
};

export type OperationInput = {
  months: readonly string[];
  incomeBp: number;
  logistics: ReadonlyMap<string, LogisticsMonthIn>;
  bills: readonly BillLine[];
  /** Every leg on the payroll accounts and the Operation accounts, from far enough
      back for the longest spread; posted, on neither side of a reversal. */
  legs: readonly Leg[];
  chart: ReadonlyMap<string, DeptAccount>;
  payroll: ReadonlySet<string>;
  spreadMonths: ReadonlyMap<string, number>;
};
export type OperationMonth = { month: string; rows: Record<OpRowKey, OpCells>; dos: OpCells };
export type OperationPnl = {
  months: string[];
  incomeBp: number;
  perMonth: OperationMonth[];
  income: OpIncomeLine[];
  manpower: OpManpowerLine[];
  spreads: OpSpreadRow[];
};

/** A month's amount shared by the DOs' value in each region, in whole sen, the
    remainder to the largest shares; a month with no DO keeps it in KL. */
export function shareByValue(amountSen: number, weights: OpCells): OpCells {
  const w = OP_REGION_CODES.map((r) => Math.max(0, weights[r]));
  const sum = w.reduce((a, b) => a + b, 0);
  if (sum <= 0) return { ...zeroOp(), KL: amountSen };
  const raw = w.map((x) => (amountSen * x) / sum);
  const out = raw.map((x) => Math.trunc(x));
  let rest = amountSen - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => ({ i, frac: Math.abs(x - out[i]!) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest === 0) break;
    const step = Math.sign(rest);
    out[i]! += step;
    rest -= step;
  }
  return { PG: out[0]!, KL: out[1]!, EM: out[2]! };
}

const emptyRows = (): Record<OpRowKey, OpCells> =>
  Object.fromEntries(operationRows(0).map((r) => [r.key, zeroOp()])) as Record<OpRowKey, OpCells>;
const addInto = (into: OpCells, x: OpCells, sign = 1): void => { into.PG += sign * x.PG; into.KL += sign * x.KL; into.EM += sign * x.EM; };

export function buildOperationPnl(input: OperationInput): OperationPnl {
  const months = [...input.months];
  const inRange = new Set(months);
  const byMonth = new Map(months.map((m) => [m, emptyRows()] as const));
  const doValue = new Map(months.map((m) => [m, fold(input.logistics.get(m)?.doValue ?? {})] as const));

  /* The recharges billed: each in the month it names, in the region it names (else KL). */
  const income: OpIncomeLine[] = [];
  for (const b of input.bills) {
    const home = lineHome(undefined, b.description, { payroll: false, recharge: true });
    if (home.dept !== 'operation' || !home.income) continue;
    const month = monthNamed(b.description) ?? monthOf(b.billDate);
    if (!inRange.has(month)) continue;
    const key = home.income === 'warehouse' ? 'income_warehouse' : CHARGES_ROW[incomeRowOf(b.debtorName)];
    const region = home.region ?? 'KL';
    byMonth.get(month)![key][region] += b.amountSen;
    income.push({ ...b, month, key, region });
  }

  /* The books: manpower by team line, the Operation accounts by their row and region. */
  const manpower: OpManpowerLine[] = [];
  const spreads: OpSpreadRow[] = [];
  for (const l of input.legs) {
    const net = l.debitSen - l.creditSen;
    if (net === 0) continue;
    const account = input.chart.get(l.accountCode);
    const home: LineHome = lineHome(account, l.notes, { payroll: input.payroll.has(l.accountCode), recharge: false });
    if (home.dept !== 'operation' || home.row == null) continue;
    const month = monthOf(l.day);
    if ((MANPOWER_ROWS as readonly string[]).includes(home.row)) {
      if (!inRange.has(month)) continue;
      const row = home.row as ManpowerRow;
      const cells = home.region ? { ...zeroOp(), [home.region]: net } as OpCells : shareByValue(net, doValue.get(month)!);
      addInto(byMonth.get(month)![row], cells);
      manpower.push({ lineId: l.lineId, day: l.day, accountCode: l.accountCode, accountName: l.accountName, notes: l.notes, amountSen: net, row, region: home.region, cells });
      continue;
    }
    const row = home.row as OpRow | 'recruitment';
    const region = home.region ?? 'KL';
    if (row === 'upkeep' || row === 'insurance') {
      const own = input.spreadMonths.get(l.lineId);
      const n = own ?? OP_DEFAULT_SPREAD[row];
      const parts = share(net, n);
      const lastMonth = addMonths(month, n - 1);
      let mine = 0;
      parts.forEach((p, i) => {
        const m = addMonths(month, i);
        if (!inRange.has(m)) return;
        byMonth.get(m)![row][region] += p;
        mine += p;
      });
      if (lastMonth < months[0]! || month > months[months.length - 1]!) continue;
      spreads.push({
        lineId: l.lineId, kind: row, accountCode: l.accountCode, accountName: l.accountName, day: l.day, docNo: l.docNo, notes: l.notes,
        amountSen: net, region, months: n, isDefault: own == null, perMonthSen: parts[0] ?? 0, inRangeSen: mine, lastMonth,
      });
      continue;
    }
    if (!inRange.has(month)) continue;
    byMonth.get(month)![row][region] += net;
  }

  /* Each month's arithmetic, region by region. */
  const perMonth: OperationMonth[] = months.map((m) => {
    const rows = byMonth.get(m)!;
    const lg = input.logistics.get(m);
    const dv = doValue.get(m)!;
    rows.do_value = { ...dv };
    rows.do_income = { PG: Math.round((dv.PG * input.incomeBp) / 10_000), KL: Math.round((dv.KL * input.incomeBp) / 10_000), EM: Math.round((dv.EM * input.incomeBp) / 10_000) };
    const ti = fold(lg?.transportIncome ?? {});
    rows.logistic_expense = { PG: -ti.PG, KL: -ti.KL, EM: -ti.EM };
    for (const k of ROWS_OF('gross')) addInto(rows.gross, rows[k]);
    for (const k of ROWS_OF('expense')) addInto(rows.total_expense, rows[k]);
    addInto(rows.net, rows.gross);
    addInto(rows.net, rows.total_expense, -1);
    const lNet = fold(lg?.net ?? {});
    const lFair = fold(lg?.fairIncome ?? {});
    rows.logistics_net = { PG: lNet.PG - lFair.PG, KL: lNet.KL - lFair.KL, EM: lNet.EM - lFair.EM };
    for (const f of lg?.fairs ?? []) rows.sd_net[opRegionOf(f.region)] += f.incomeSen - f.costSen;
    for (const k of ['net', 'logistics_net', 'sd_net'] as const) addInto(rows.net_after, rows[k]);
    return { month: m, rows, dos: fold(lg?.doCount ?? {}) };
  });

  manpower.sort((a, b) => a.day.localeCompare(b.day) || a.lineId.localeCompare(b.lineId));
  spreads.sort((a, b) => a.day.localeCompare(b.day) || a.accountCode.localeCompare(b.accountCode));
  income.sort((a, b) => a.month.localeCompare(b.month) || a.billNo.localeCompare(b.billNo));
  return { months, incomeBp: input.incomeBp, perMonth, income, manpower, spreads };
}

/** A row's figure over months and regions — the screen's columns add the same way. */
export const opSum = (p: OperationPnl, key: OpRowKey, months: readonly string[] = p.months, regions: readonly OpRegion[] = OP_REGION_CODES): number =>
  p.perMonth.filter((m) => months.includes(m.month)).reduce((s, m) => s + regions.reduce((t, r) => t + m.rows[key][r], 0), 0);
export { opTotal };

/* ── G&A ─────────────────────────────────────────────────────────────────── */

export type GaInput = {
  months: readonly string[];
  /** Each month's Performance sales (the Performance P&L's own total). */
  sales: ReadonlyMap<string, number>;
  shareBp: number;
  /** Every leg in the months on the payroll accounts and the accounts the Department column gives G&A. */
  legs: readonly Leg[];
  chart: ReadonlyMap<string, DeptAccount>;
  payroll: ReadonlySet<string>;
  /** The company's departments: what folds into G&A (Houzs's showroom). */
  plan: DepartmentPlan;
  /** The P&L's expense tree, which G&A's accounts are laid on. */
  layout: readonly LayoutItem[];
  companyId: number;
};
export type GaMonth = { month: string; salesSen: number; shareSen: number; expenseSen: number; surplusSen: number };
export type GaPnl = {
  months: string[];
  shareBp: number;
  perMonth: GaMonth[];
  /** G&A's accounts on the P&L's tree; every node carries its figure per month in `cells`. */
  tree: LaidNode[];
  /** The payroll lines counted for each team, for the screen to list. */
  teams: Array<{ team: GaTeam; label: string; lines: Array<{ lineId: string; day: string; accountCode: string; notes: string | null; amountSen: number }> }>;
};

export function buildGaPnl(input: GaInput): GaPnl {
  const months = [...input.months];
  const inRange = new Set(months);
  const byAccount = new Map<string, Record<string, number>>();
  const byTeam = new Map<GaTeam, Record<string, number>>();
  const teamLines = new Map<GaTeam, GaPnl['teams'][number]['lines']>();
  const add = (into: Record<string, number>, month: string, sen: number) => { into[month] = (into[month] ?? 0) + sen; };
  for (const l of input.legs) {
    const month = monthOf(l.day);
    if (!inRange.has(month)) continue;
    const net = l.debitSen - l.creditSen;
    if (net === 0) continue;
    const home = lineHome(input.chart.get(l.accountCode), l.notes, { payroll: input.payroll.has(l.accountCode), recharge: false });
    if (resolveDept(home.dept, input.plan) !== 'ga') continue;
    if (home.dept === 'ga' && home.team) {
      add(byTeam.get(home.team) ?? (byTeam.set(home.team, {}), byTeam.get(home.team)!), month, net);
      const ls = teamLines.get(home.team) ?? [];
      ls.push({ lineId: l.lineId, day: l.day, accountCode: l.accountCode, notes: l.notes, amountSen: net });
      teamLines.set(home.team, ls);
    } else {
      add(byAccount.get(l.accountCode) ?? (byAccount.set(l.accountCode, {}), byAccount.get(l.accountCode)!), month, net);
    }
  }

  /* The team rows print where the payroll sits on the P&L's tree: under the first
     payroll account the tree places (Salary & related), else at the foot. */
  const placedCodes = new Set<string>();
  const walk = (items: readonly LayoutItem[]) => {
    for (const it of items) {
      if (it.kind === 'account' && it.code) placedCodes.add(it.code);
      if (it.kind === 'category') walk(it.children);
    }
  };
  walk(input.layout);
  const sortedPayroll = [...input.payroll].sort();
  const payrollOnTree = sortedPayroll.find((c) => placedCodes.has(c)) ?? (sortedPayroll.length > 0 ? sortedPayroll[0]! : 'PAYROLL');
  const sum = (cells: Record<string, number>) => Object.values(cells).reduce((a, b) => a + b, 0);
  const lines: LaidLine[] = [
    ...GA_TEAMS.filter((t) => byTeam.has(t)).map((t) => {
      const cells = byTeam.get(t)!;
      return { code: payrollOnTree, name: GA_TEAM_LABEL[t], key: `team:${t}`, label: `${GA_TEAM_LABEL[t]} · salary, EPF, SOCSO, EIS, allowance`, amountSen: sum(cells), cells };
    }),
    ...[...byAccount.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([code, cells]) => ({
      code, name: input.chart.get(code)?.account_name ?? code, amountSen: sum(cells), cells,
    })),
  ].filter((l) => Object.values(l.cells).some((v) => v !== 0));
  const tree = layOutBlock([...input.layout] as LayoutItem[], lines, input.companyId, null);

  const perMonth: GaMonth[] = months.map((m) => {
    const salesSen = input.sales.get(m) ?? 0;
    const shareSen = Math.round((salesSen * input.shareBp) / 10_000);
    const expenseSen = lines.reduce((s, l) => s + (l.cells?.[m] ?? 0), 0);
    return { month: m, salesSen, shareSen, expenseSen, surplusSen: shareSen - expenseSen };
  });
  const teams = GA_TEAMS.filter((t) => teamLines.has(t)).map((t) => ({
    team: t, label: GA_TEAM_LABEL[t], lines: teamLines.get(t)!.sort((a, b) => a.day.localeCompare(b.day) || a.lineId.localeCompare(b.lineId)),
  }));
  return { months, shareBp: input.shareBp, perMonth, tree, teams };
}

/* ── ONE DEPARTMENT: its column of the P&L, month by month ─────────────────── */

export type DeptMonthSplit = { month: string; blocks: Record<PnlBlock, ReadonlyArray<{ code: string; name: string; cells: DeptCells }>> };
export type DeptViewMonth = {
  month: string; salesSen: number; costOfSalesSen: number; grossSen: number; otherIncomeSen: number;
  expensesSen: number; taxationSen: number; netSen: number;
};
export type DeptView = { dept: DeptKey; months: string[]; perMonth: DeptViewMonth[]; tree: Record<PnlBlock, LaidNode[]> };

/** One department's own P&L (the Exhibition P&L, the Showroom P&L): each block's
    lines as that department took them month by month — the All view's column, by
    month — laid on the P&L's own tree, every node's figure per month in `cells`. */
export function buildDeptView(input: {
  dept: DeptKey; months: readonly string[]; split: readonly DeptMonthSplit[];
  layout: Readonly<Record<string, readonly LayoutItem[]>>; companyId: number;
}): DeptView {
  const tree = {} as Record<PnlBlock, LaidNode[]>;
  const perBlock = {} as Record<PnlBlock, Record<string, number>>;
  for (const { block } of PNL_BLOCKS) {
    const byCode = new Map<string, { name: string; cells: Record<string, number> }>();
    const total: Record<string, number> = {};
    for (const m of input.split) {
      for (const l of m.blocks[block]) {
        const v = l.cells[input.dept] ?? 0;
        if (v === 0) continue;
        const cur = byCode.get(l.code) ?? { name: l.name, cells: {} };
        cur.cells[m.month] = (cur.cells[m.month] ?? 0) + v;
        byCode.set(l.code, cur);
        total[m.month] = (total[m.month] ?? 0) + v;
      }
    }
    const lines: LaidLine[] = [...byCode.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([code, x]) => ({
      code, name: x.name, cells: x.cells, amountSen: Object.values(x.cells).reduce((a, b) => a + b, 0),
    }));
    tree[block] = layOutBlock([...(input.layout[block] ?? [])] as LayoutItem[], lines, input.companyId, null);
    perBlock[block] = total;
  }
  const perMonth: DeptViewMonth[] = input.months.map((month) => {
    const v = (b: PnlBlock) => perBlock[b][month] ?? 0;
    const grossSen = v('tradingIncome') - v('costOfSales');
    return {
      month, salesSen: v('tradingIncome'), costOfSalesSen: v('costOfSales'), grossSen, otherIncomeSen: v('otherIncome'),
      expensesSen: v('expenses'), taxationSen: v('taxation'), netSen: grossSen + v('otherIncome') - v('expenses') - v('taxation'),
    };
  });
  return { dept: input.dept, months: [...input.months], perMonth, tree };
}
