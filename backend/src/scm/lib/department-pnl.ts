// ----------------------------------------------------------------------------
// department-pnl — the Department P&L's arithmetic (owner 2026-11-19). Each
// department by its own method, nothing typed (「不要我填」):
//
//   THE SPLIT — every P&L line split across the company's departments as booked
//     (splitLine): what a department's own P&L reads its books from.
//
//   ALL — every department's own P&L side by side, a few figures each (owner
//     2026-11-25: the books split again 「就和我的actual重复了」; 「我会有很多个不同的
//     p&L, 每个的算法和提取的资料不一样」): the Exhibition on its orders, Operation by
//     its sheet, Logistics by the Logistics P&L, G&A against its share. Their total
//     is the departments added up, not the company's profit (the P&L is).
//
//   ONE DEPARTMENT (Exhibition, Showroom) — its column of the split, month by month;
//     the Exhibition's sales and cost of sales are the Performance P&L's own, from
//     the sales orders by SO date, and its commission the month's commission bills
//     in place of the release, as the Performance P&L shows it (owner 2026-11-25).
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
import type { ChargeRates, DeptBasis, MonthCharges } from './department-charges';
import { fmtMoneySen } from '../shared/format';
import type { UnitRow, UnitView } from './department-units';
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

/** One part of a P&L line: the department it counts in and the leg it is — null for
    what the legs do not explain (a stock line, a line read whole). */
export type SplitPart<L extends SplitLeg = SplitLeg> = { dept: DeptKey; sen: number; leg: L | null };

/**
 * What each department took of one P&L line, part by part. `sign` +1 reads a line
 * debit-positive (cost of sales, expenses, taxation), -1 credit-positive (income). A
 * line whose account mixes departments (a payroll or recruitment account, an income
 * account Other Debtor recharges land on) is split leg by leg; any other goes whole
 * to its account's department. A nature the company has no department for counts
 * where its plan folds it. Whatever the legs do not explain goes to the account's own
 * department, so the parts always add up to the line. `itemize`: hand back each leg of
 * a line that goes whole too (the lines a figure opens) — the departments' sums are
 * the same either way.
 */
export function splitLineParts<L extends SplitLeg>(input: {
  amountSen: number; sign: 1 | -1; account: DeptAccount | undefined;
  legs: readonly L[] | undefined; payroll: boolean; recharge: boolean; mixed: boolean;
  fallback: Nature | 'none'; plan: DepartmentPlan; itemize: boolean;
}): SplitPart<L>[] {
  const home = accountHome(input.account).dept;
  const own = resolveDept(home === 'none' || home === 'hire' ? input.fallback : home, input.plan);
  const byLeg = input.mixed || input.recharge;
  const parts: SplitPart<L>[] = [];
  let placed = 0;
  if (input.legs && (byLeg || input.itemize)) {
    for (const l of input.legs) {
      const sen = input.sign * (l.debitSen - l.creditSen);
      if (sen === 0) continue;
      let dept = own;
      if (byLeg) {
        const lh = lineHome(input.account, l.notes, { payroll: input.payroll, recharge: input.recharge }).dept;
        dept = resolveDept(lh === 'none' ? input.fallback : lh, input.plan);
      }
      parts.push({ dept, sen, leg: l });
      placed += sen;
    }
  }
  if (input.amountSen !== placed) parts.push({ dept: own, sen: input.amountSen - placed, leg: null });
  return parts;
}

/** What each department took of one P&L line: its parts added up by department. */
export function splitLine(input: Omit<Parameters<typeof splitLineParts>[0], 'itemize'>): DeptCells {
  const cells = zeroDeptCells(input.plan);
  for (const p of splitLineParts({ ...input, itemize: false })) cells[p.dept] = (cells[p.dept] ?? 0) + p.sen;
  return cells;
}

/** One P&L line of a block as the Department P&L splits it, part by part. */
export function splitPnlLineParts<L extends SplitLeg>(input: {
  block: PnlBlock; code: string; amountSen: number;
  chart: ReadonlyMap<string, DeptAccount>; payroll: ReadonlySet<string>; mixed: ReadonlySet<string>;
  legs: readonly L[] | undefined; plan: DepartmentPlan; itemize: boolean;
}): SplitPart<L>[] {
  const b = PNL_BLOCKS.find((x) => x.block === input.block)!;
  return splitLineParts({
    amountSen: input.amountSen, sign: b.sign, account: input.chart.get(input.code), legs: input.legs,
    payroll: input.block === 'expenses' && input.payroll.has(input.code), recharge: b.recharge,
    mixed: input.block === 'expenses' && input.mixed.has(input.code), fallback: b.fallback, plan: input.plan, itemize: input.itemize,
  });
}

/** Each P&L line of each block, split: the lines the P&L printed, their account, legs. */
export function splitPnlLines(input: {
  lines: Record<PnlBlock, ReadonlyArray<{ code: string; name: string; amountSen: number }>>;
  chart: ReadonlyMap<string, DeptAccount>; payroll: ReadonlySet<string>; mixed: ReadonlySet<string>;
  legsOf: ReadonlyMap<string, readonly SplitLeg[]>; plan: DepartmentPlan;
}): Record<PnlBlock, Array<{ code: string; name: string; amountSen: number; cells: DeptCells }>> {
  const out = {} as Record<PnlBlock, Array<{ code: string; name: string; amountSen: number; cells: DeptCells }>>;
  for (const { block } of PNL_BLOCKS) {
    out[block] = input.lines[block].map((l) => {
      const cells = zeroDeptCells(input.plan);
      const parts = splitPnlLineParts({
        block, code: l.code, amountSen: l.amountSen, chart: input.chart, payroll: input.payroll, mixed: input.mixed,
        legs: input.legsOf.get(l.code), plan: input.plan, itemize: false,
      });
      for (const p of parts) cells[p.dept] = (cells[p.dept] ?? 0) + p.sen;
      return { code: l.code, name: l.name, amountSen: l.amountSen, cells };
    });
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
  fairs: ReadonlyArray<{ id: number; code: string | null; name: string; venue: string | null; region: RegionCode; incomeSen: number; costSen: number }>;
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

/** How an amount behind an Operation figure was arrived at, where it is not simply its line's. */
export type OpHow =
  /** A payroll line naming no region: the whole line, shared by the month's DO value. */
  | { kind: 'shared'; wholeSen: number }
  /** One month's part (`part` of `months`) of an upkeep or insurance bill. */
  | { kind: 'spread'; wholeSen: number; part: number; months: number }
  /** The month's Delivery Orders in the region, as the Logistics cost report counts them. */
  | { kind: 'dos'; count: number }
  /** Operation's rate of the month's DO value in the region. */
  | { kind: 'rate'; baseSen: number; bp: number }
  /** The Logistics cost report's Transport Income (its own % of the DO value). */
  | { kind: 'transport'; baseSen: number }
  /** The Logistics cost report's net, less its fair income. */
  | { kind: 'logistics'; netSen: number; fairIncomeSen: number }
  /** One fair's transport income less its setup and dismantle transport. */
  | { kind: 'fair'; incomeSen: number; costSen: number };

/** One amount behind a figure of the Operation sheet — a ledger line, an Other Debtor
    bill line, a fair or a figure of the Logistics cost report — and what it put in
    which region of which month. Every row but the results (Gross, Total Warehouse
    Expenses, Net, Net after) IS its lines added up. */
export type OpLine = {
  id: string; row: OpRowKey; month: string; cells: OpCells;
  /** A ledger line (a spread bill's month too), an Other Debtor bill line, a fair, a figure of the Logistics cost report. */
  src: 'ledger' | 'bill' | 'fair' | 'figure';
  day: string | null;
  /** The journal entry, the bill or the fair's code. */
  ref: string | null;
  accountCode: string | null; accountName: string | null;
  /** The line's own words: a ledger line's notes, a bill line's description, a fair's name. */
  text: string | null;
  /** Who was billed; a fair's venue. */
  party: string | null;
  how: OpHow | null;
};

export type OperationInput = {
  months: readonly string[];
  incomeBp: number;
  /** The Logistics cost report's months, by Logistics region. */
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
  /** What every row but the results is made of, in the sheet's order. */
  lines: OpLine[];
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
  const doValue = new Map(months.map((m) => [m, fold(input.logistics.get(m)?.doValue ?? {})] as const));
  const only = (region: OpRegion, sen: number): OpCells => ({ ...zeroOp(), [region]: sen });
  /* What every row but the results is made of; the rows are these added up, below. */
  const lines: OpLine[] = [];
  const ledger = (l: Leg, row: OpRowKey, month: string, cells: OpCells, how: OpHow | null, id = `gl:${l.lineId}`): OpLine => ({
    id, row, month, cells, src: 'ledger', day: l.day, ref: l.docNo, accountCode: l.accountCode, accountName: l.accountName, text: l.notes, party: null, how,
  });

  /* The recharges billed: each in the month it names, in the region it names (else KL). */
  const income: OpIncomeLine[] = [];
  for (const b of input.bills) {
    const home = lineHome(undefined, b.description, { payroll: false, recharge: true });
    if (home.dept !== 'operation' || !home.income) continue;
    const month = monthNamed(b.description) ?? monthOf(b.billDate);
    if (!inRange.has(month)) continue;
    const key = home.income === 'warehouse' ? 'income_warehouse' : CHARGES_ROW[incomeRowOf(b.debtorName)];
    const region = home.region ?? 'KL';
    lines.push({
      id: `bill:${b.lineId}`, row: key, month, cells: only(region, b.amountSen), src: 'bill', day: b.billDate, ref: b.billNo,
      accountCode: b.accountCode || null, accountName: b.accountName, text: b.description, party: b.debtorName || null, how: null,
    });
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
      const cells = home.region ? only(home.region, net) : shareByValue(net, doValue.get(month)!);
      lines.push(ledger(l, row, month, cells, home.region ? null : { kind: 'shared', wholeSen: net }));
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
        if (!inRange.has(m) || p === 0) return;
        lines.push(ledger(l, row, m, only(region, p), { kind: 'spread', wholeSen: net, part: i + 1, months: n }, `gl:${l.lineId}:${m}`));
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
    lines.push(ledger(l, row, month, only(region, net), null));
  }

  /* The Logistics cost report's figures, region by region: the DOs, Operation's rate of
     their value, the report's own Transport Income, its net less its fair income, the fairs. */
  for (const m of months) {
    const lg = input.logistics.get(m);
    const dv = doValue.get(m)!;
    const count = fold(lg?.doCount ?? {});
    const ti = fold(lg?.transportIncome ?? {});
    const lNet = fold(lg?.net ?? {});
    const lFair = fold(lg?.fairIncome ?? {});
    for (const r of OP_REGION_CODES) {
      const figure = (row: OpRowKey, sen: number, how: OpHow) => {
        if (sen === 0) return;
        lines.push({ id: `${row}:${m}:${r}`, row, month: m, cells: only(r, sen), src: 'figure', day: null, ref: null, accountCode: null, accountName: null, text: null, party: null, how });
      };
      figure('do_value', dv[r], { kind: 'dos', count: count[r] });
      figure('do_income', Math.round((dv[r] * input.incomeBp) / 10_000), { kind: 'rate', baseSen: dv[r], bp: input.incomeBp });
      figure('logistic_expense', -ti[r], { kind: 'transport', baseSen: dv[r] });
      figure('logistics_net', lNet[r] - lFair[r], { kind: 'logistics', netSen: lNet[r], fairIncomeSen: lFair[r] });
    }
    for (const f of lg?.fairs ?? []) {
      const sen = f.incomeSen - f.costSen;
      if (sen === 0) continue;
      lines.push({
        id: `fair:${m}:${f.id}`, row: 'sd_net', month: m, cells: only(opRegionOf(f.region), sen), src: 'fair', day: null, ref: f.code,
        accountCode: null, accountName: null, text: f.name, party: f.venue, how: { kind: 'fair', incomeSen: f.incomeSen, costSen: f.costSen },
      });
    }
  }

  /* Each month: its lines added up, then the results, region by region. */
  const byMonth = new Map(months.map((m) => [m, emptyRows()] as const));
  for (const l of lines) addInto(byMonth.get(l.month)![l.row], l.cells);
  const perMonth: OperationMonth[] = months.map((m) => {
    const rows = byMonth.get(m)!;
    for (const k of ROWS_OF('gross')) addInto(rows.gross, rows[k]);
    for (const k of ROWS_OF('expense')) addInto(rows.total_expense, rows[k]);
    addInto(rows.net, rows.gross);
    addInto(rows.net, rows.total_expense, -1);
    for (const k of ['net', 'logistics_net', 'sd_net'] as const) addInto(rows.net_after, rows[k]);
    return { month: m, rows, dos: fold(input.logistics.get(m)?.doCount ?? {}) };
  });

  const order = new Map(operationRows(0).map((r, i) => [r.key, i] as const));
  const regionRank = (l: OpLine) => OP_REGION_CODES.findIndex((r) => l.cells[r] !== 0);
  lines.sort((a, b) => order.get(a.row)! - order.get(b.row)! || a.month.localeCompare(b.month) || (a.day ?? '').localeCompare(b.day ?? '')
    || regionRank(a) - regionRank(b) || a.id.localeCompare(b.id));
  manpower.sort((a, b) => a.day.localeCompare(b.day) || a.lineId.localeCompare(b.lineId));
  spreads.sort((a, b) => a.day.localeCompare(b.day) || a.accountCode.localeCompare(b.accountCode));
  income.sort((a, b) => a.month.localeCompare(b.month) || a.billNo.localeCompare(b.billNo));
  return { months, incomeBp: input.incomeBp, perMonth, lines, income, manpower, spreads };
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

/** One leg G&A counts, in its month: on its HQ team's row (a payroll line naming the
    team — key team:<TEAM>) or on its account's (key = the account's code). */
export type GaLine = { leg: Leg; month: string; key: string; team: GaTeam | null; sen: number };

/** The legs G&A counts in the months: the HQ teams' payroll lines and every leg the plan
    puts in G&A on its account (Houzs's showroom too). */
export function gaLines(input: Pick<GaInput, 'months' | 'legs' | 'chart' | 'payroll' | 'plan'>): GaLine[] {
  const inRange = new Set(input.months);
  const out: GaLine[] = [];
  for (const l of input.legs) {
    const month = monthOf(l.day);
    if (!inRange.has(month)) continue;
    const net = l.debitSen - l.creditSen;
    if (net === 0) continue;
    const home = lineHome(input.chart.get(l.accountCode), l.notes, { payroll: input.payroll.has(l.accountCode), recharge: false });
    if (resolveDept(home.dept, input.plan) !== 'ga') continue;
    const team = home.dept === 'ga' && home.team ? home.team : null;
    out.push({ leg: l, month, key: team ? `team:${team}` : l.accountCode, team, sen: net });
  }
  return out;
}

export function buildGaPnl(input: GaInput): GaPnl {
  const months = [...input.months];
  const byAccount = new Map<string, Record<string, number>>();
  const byTeam = new Map<GaTeam, Record<string, number>>();
  const teamLines = new Map<GaTeam, GaPnl['teams'][number]['lines']>();
  const add = (into: Record<string, number>, month: string, sen: number) => { into[month] = (into[month] ?? 0) + sen; };
  for (const { leg: l, month, team, sen: net } of gaLines(input)) {
    if (team) {
      add(byTeam.get(team) ?? (byTeam.set(team, {}), byTeam.get(team)!), month, net);
      const ls = teamLines.get(team) ?? [];
      ls.push({ lineId: l.lineId, day: l.day, accountCode: l.accountCode, notes: l.notes, amountSen: net });
      teamLines.set(team, ls);
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
  expensesSen: number; taxationSen: number;
  /** What it pays the other departments (G&A, Operation, Setup & dismantle), and the sales
      excluding service every rate is of — null for a department that pays none. */
  chargesSen: number;
  baseSen: number | null;
  netSen: number;
};
export type DeptView = {
  dept: DeptKey; basis: DeptBasis; months: string[]; perMonth: DeptViewMonth[]; tree: Record<PnlBlock, LaidNode[]>;
  /** What it pays the other departments, a row each, every month's figure in `cells`. */
  charges: LaidNode[];
  /** By order: the orders counted and how many are not delivered yet. */
  orders: { counted: number; notDelivered: number } | null;
};

/** One month of the Performance P&L as a department on orders reads it: the product
    groups' sales and cost, the orders, and the commission account's bills for the month
    against what the monthly release booked on it (acc/performance-commission.ts). */
export type OrdersMonthIn = {
  month: string;
  groups: ReadonlyArray<{ key: string; label: string; salesSen: number; cogsSen: number }>;
  orders: { counted: number; notDelivered: number };
  commission: { billSen: number; releaseSen: number } | null;
};
export type DeptOrders = {
  months: readonly OrdersMonthIn[];
  /** The commission account when it counts in this department: its line reads each month's
      bills in place of the release, as the Performance P&L does (「要包括commission」). */
  commission: { code: string; name: string; label: string } | null;
};

/** What the selling department pays and what leaves it (department-charges.ts): the charges
    by month and their rates; the fair transport accounts Setup & dismantle carries; in
    Performance, merchandise in place of the terminal charges (`merchandise`, null in Actual). */
export type DeptCharges = {
  months: readonly MonthCharges[];
  rates: ChargeRates;
  moved: ReadonlySet<string>;
  merchandise: { codes: ReadonlySet<string> } | null;
};

/** The product groups as tree rows (no account: a group's figure is the orders'), each
    month's figure in `cells`; a group with nothing in any month is left out. */
function orderGroupNodes(months: readonly OrdersMonthIn[], pick: 'salesSen' | 'cogsSen'): LaidNode[] {
  const byKey = new Map<string, { label: string; cells: Record<string, number> }>();
  for (const m of months) {
    for (const g of m.groups) {
      const cur = byKey.get(g.key) ?? { label: g.label, cells: {} };
      cur.cells[m.month] = (cur.cells[m.month] ?? 0) + g[pick];
      byKey.set(g.key, cur);
    }
  }
  return [...byKey.entries()]
    .filter(([, x]) => Object.values(x.cells).some((v) => v !== 0))
    .map(([key, x]) => ({
      kind: 'account' as const, id: `order:${key}`, key: `order:${key}`, label: x.label, pct: null, children: [],
      cells: x.cells, amountSen: Object.values(x.cells).reduce((a, b) => a + b, 0),
    }));
}

const pctWords = (bp: number): string => `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
/** A row of figures by month (no account behind it: it opens nothing). */
const figureNode = (id: string, label: string, cells: Record<string, number>): LaidNode => ({
  kind: 'account', id, key: id, label, pct: null, children: [], cells, amountSen: Object.values(cells).reduce((a, b) => a + b, 0),
});

/** One department's own P&L (the Exhibition P&L, the Showroom P&L): each block's lines as
    that department took them month by month — the books split as All splits them — laid
    on the P&L's own tree, every node's figure per month in `cells`. By order, sales and
    cost of sales are the product groups' from the orders and the commission account reads
    its bills. With charges, the fair transport leaves (Setup & dismantle carries it), in
    Performance merchandise stands where the terminal charges stood, and what it pays the
    other departments is a block of its own. */
export function buildDeptView(input: {
  dept: DeptKey; basis: DeptBasis; months: readonly string[]; split: readonly DeptMonthSplit[];
  layout: Readonly<Record<string, readonly LayoutItem[]>>; companyId: number;
  orders: DeptOrders | null;
  charges: DeptCharges | null;
}): DeptView {
  const tree = {} as Record<PnlBlock, LaidNode[]>;
  const perBlock = {} as Record<PnlBlock, Record<string, number>>;
  const orders = input.orders;
  const ch = input.charges;
  for (const { block } of PNL_BLOCKS) {
    if (orders && (block === 'tradingIncome' || block === 'costOfSales')) {
      tree[block] = orderGroupNodes(orders.months, block === 'tradingIncome' ? 'salesSen' : 'cogsSen');
      perBlock[block] = Object.fromEntries(input.months.map((m) => [m, tree[block].reduce((s, n) => s + (n.cells?.[m] ?? 0), 0)]));
      continue;
    }
    const byCode = new Map<string, { name: string; label?: string; cells: Record<string, number> }>();
    const total: Record<string, number> = {};
    const add = (code: string, name: string, month: string, v: number) => {
      const cur = byCode.get(code) ?? { name, cells: {} };
      cur.cells[month] = (cur.cells[month] ?? 0) + v;
      byCode.set(code, cur);
      total[month] = (total[month] ?? 0) + v;
    };
    const merch = block === 'expenses' ? ch?.merchandise ?? null : null;
    const replaced: Array<{ code: string; name: string; sen: number }> = [];
    for (const m of input.split) {
      for (const l of m.blocks[block]) {
        const v = l.cells[input.dept] ?? 0;
        if (v === 0) continue;
        if (block === 'expenses' && ch?.moved.has(l.code)) continue;
        if (merch?.codes.has(l.code)) { replaced.push({ code: l.code, name: l.name, sen: v }); continue; }
        add(l.code, l.name, m.month, v);
      }
    }
    const c = block === 'expenses' ? orders?.commission ?? null : null;
    if (c) {
      for (const m of orders!.months) {
        const v = m.commission ? m.commission.billSen - m.commission.releaseSen : 0;
        if (v !== 0) add(c.code, c.name, m.month, v);
      }
      const cur = byCode.get(c.code);
      if (cur) cur.label = c.label;
    }
    /* Merchandise stands where the terminal charges stood, under its own sentence. */
    if (merch && ch) {
      const first = [...merch.codes].sort()[0]!;
      const named = [...new Map(replaced.map((r) => [r.code, r.name] as const)).entries()].map(([code, name]) => `${code} ${name}`).join(', ');
      const bookedSen = replaced.reduce((s, r) => s + r.sen, 0);
      for (const m of ch.months) if (m.merchandise !== 0) add(first, 'Merchandise', m.month, m.merchandise);
      const cur = byCode.get(first);
      if (cur) cur.label = `Merchandise — ${pctWords(ch.rates.merchandiseBp)} of sales excluding service, in place of ${named || 'the terminal charges'} (${fmtMoneySen(bookedSen)} booked)`;
    }
    const lines: LaidLine[] = [...byCode.entries()]
      .map(([code, x]) => ({ code, x, cells: Object.fromEntries(Object.entries(x.cells).filter(([, v]) => v !== 0)) }))
      .filter((l) => Object.keys(l.cells).length > 0)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map(({ code, x, cells }) => ({
        code, name: x.name, ...(x.label ? { label: x.label } : {}), cells, amountSen: Object.values(cells).reduce((a, b) => a + b, 0),
      }));
    tree[block] = layOutBlock([...(input.layout[block] ?? [])] as LayoutItem[], lines, input.companyId, null);
    perBlock[block] = total;
  }
  /* What it pays the other departments: a row each, only for a department it pays. */
  const charges: LaidNode[] = [];
  const chargeTotal: Record<string, number> = {};
  if (ch) {
    const rows: Array<[keyof MonthCharges, string]> = [
      ['ga', `G&A — ${pctWords(ch.rates.gaBp)} of sales excluding service`],
      ['operation', `Operation — ${pctWords(ch.rates.operationBp)} of sales excluding service`],
      ['setupDismantle', `Setup & dismantle — ${pctWords(ch.rates.setupDismantleBp)} of sales excluding service`],
    ];
    for (const [key, label] of rows) {
      const cells = Object.fromEntries(ch.months.map((m) => [m.month, Number(m[key])] as const).filter(([, v]) => v !== 0));
      if (Object.keys(cells).length === 0) continue;
      charges.push(figureNode(`charge:${String(key)}`, label, cells));
      for (const [m, v] of Object.entries(cells)) chargeTotal[m] = (chargeTotal[m] ?? 0) + v;
    }
  }
  const perMonth: DeptViewMonth[] = input.months.map((month) => {
    const v = (b: PnlBlock) => perBlock[b][month] ?? 0;
    const grossSen = v('tradingIncome') - v('costOfSales');
    const chargesSen = chargeTotal[month] ?? 0;
    return {
      month, salesSen: v('tradingIncome'), costOfSalesSen: v('costOfSales'), grossSen, otherIncomeSen: v('otherIncome'),
      expensesSen: v('expenses'), taxationSen: v('taxation'), chargesSen,
      baseSen: ch ? (ch.months.find((m) => m.month === month)?.baseSen ?? 0) : null,
      netSen: grossSen + v('otherIncome') - v('expenses') - v('taxation') - chargesSen,
    };
  });
  const counted = orders ? orders.months.reduce((s, m) => ({ counted: s.counted + m.orders.counted, notDelivered: s.notDelivered + m.orders.notDelivered }), { counted: 0, notDelivered: 0 }) : null;
  return { dept: input.dept, basis: input.basis, months: [...input.months], perMonth, tree, charges, orders: counted };
}

/** Actual's base, month by month: the selling department's sales as booked, less the service
    group's sales accounts. */
export function bookedSalesExService(split: readonly DeptMonthSplit[], service: ReadonlySet<string>, selling: DeptKey): Map<string, number> {
  return new Map(split.map((m) => [
    m.month, m.blocks.tradingIncome.filter((l) => !service.has(l.code)).reduce((s, l) => s + (l.cells[selling] ?? 0), 0),
  ] as const));
}

/** Some accounts as booked, by account and month, whichever department took them: the fair
    transport the Setup & dismantle branch carries. */
export function bookedByAccount(split: readonly DeptMonthSplit[], codes: ReadonlySet<string>): Array<{ code: string; name: string; cells: Record<string, number> }> {
  const by = new Map<string, { code: string; name: string; cells: Record<string, number> }>();
  for (const m of split) {
    for (const l of m.blocks.expenses) {
      if (!codes.has(l.code)) continue;
      const v = Object.values(l.cells).reduce((a, b) => a + b, 0);
      if (v === 0) continue;
      const cur = by.get(l.code) ?? { code: l.code, name: l.name, cells: {} };
      cur.cells[m.month] = (cur.cells[m.month] ?? 0) + v;
      by.set(l.code, cur);
    }
  }
  return [...by.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/* ── ALL: every department's own P&L, side by side ────────────────────────── */

/** A department's own P&L in a few figures (owner 2026-11-25): what it earns — its sales,
    or what the other departments pay it — what that income costs directly, its other
    income, its expenses (with taxation where its P&L has any), what it pays the other
    departments, and its result. */
export type DeptSummary = {
  incomeSen: number; costSen: number; grossSen: number; otherIncomeSen: number; expensesSen: number; chargesSen: number; profitSen: number;
};
const summary = (incomeSen: number, costSen: number, otherIncomeSen: number, expensesSen: number, chargesSen: number): DeptSummary => ({
  incomeSen, costSen, grossSen: incomeSen - costSen, otherIncomeSen, expensesSen, chargesSen,
  profitSen: incomeSen - costSen + otherIncomeSen - expensesSen - chargesSen,
});

/** A department's own P&L (the selling department): its months added up. */
export function summaryOfDept(v: DeptView): DeptSummary {
  const sum = (f: (m: DeptViewMonth) => number) => v.perMonth.reduce((x, m) => x + f(m), 0);
  return summary(sum((m) => m.salesSen), sum((m) => m.costOfSalesSen), sum((m) => m.otherIncomeSen), sum((m) => m.expensesSen + m.taxationSen), sum((m) => m.chargesSen));
}

/** Operation, Logistics or Setup & dismantle (department-units.ts): its income, its real cost,
    what it pays the other departments (Operation's 3% to Logistics). */
export function summaryOfUnit(u: UnitView): DeptSummary {
  const sum = (group: UnitRow['group']) => u.rows.filter((r) => r.group === group).reduce((s, r) => s + Object.values(r.cells).reduce((a, b) => a + b, 0), 0);
  return summary(sum('income'), 0, 0, sum('expense'), sum('paid'));
}

/** G&A: its share of the sales against what it booked. */
export function summaryOfGa(g: GaPnl): DeptSummary {
  const sum = (f: (m: GaMonth) => number) => g.perMonth.reduce((x, m) => x + f(m), 0);
  return summary(sum((m) => m.shareSen), 0, 0, sum((m) => m.expenseSen), 0);
}

export const addSummaries = (xs: readonly DeptSummary[]): DeptSummary => summary(
  xs.reduce((a, x) => a + x.incomeSen, 0), xs.reduce((a, x) => a + x.costSen, 0),
  xs.reduce((a, x) => a + x.otherIncomeSen, 0), xs.reduce((a, x) => a + x.expensesSen, 0), xs.reduce((a, x) => a + x.chargesSen, 0),
);

/** The expense accounts no department claims yet, over the months: named under the table,
    in no department's figures. */
export function unassignedOf(split: readonly DeptMonthSplit[]): Array<{ code: string; name: string; amountSen: number }> {
  const by = new Map<string, { name: string; amountSen: number }>();
  for (const m of split) {
    for (const l of m.blocks.expenses) {
      const v = l.cells.none ?? 0;
      if (v === 0) continue;
      const cur = by.get(l.code) ?? { name: l.name, amountSen: 0 };
      cur.amountSen += v;
      by.set(l.code, cur);
    }
  }
  return [...by.entries()].filter(([, x]) => x.amountSen !== 0).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([code, x]) => ({ code, name: x.name, amountSen: x.amountSen }));
}
