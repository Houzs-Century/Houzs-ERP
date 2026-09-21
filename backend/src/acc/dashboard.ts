// ----------------------------------------------------------------------------
// acc/dashboard — the Financial Dashboard's own arithmetic (owner 2026-09-21:
// P&L, performance P&L, Cost structure by product group, cash flow; 两个都
// 可以，做). Pure: the periods a window is cut into, the product groups the
// cost structure is told in, and the ratios — no reads, no clock (the caller
// hands in "today").
//
// The one rule that matters (the Porting Guide's): every ACTUAL figure on
// the Dashboard is produced by the statements' own builders (buildPnl,
// buildBalanceSheet, buildReceiptsPayments, buildPerformance) — this file
// never re-derives a figure from raw tables; it only decides the periods,
// adds months up, maps groups and divides.
// ----------------------------------------------------------------------------

import type { PerformanceGroupKey } from './performance-pnl';

export type Granularity = 'month' | 'quarter';

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 'YYYY-MM' plus n months (n may be negative). */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = idx - ny * 12 + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/** Whole months from a to b inclusive (0 when b is before a). */
export const monthsBetween = (a: string, b: string): number => {
  const [ay, am] = a.split('-').map(Number) as [number, number];
  const [by, bm] = b.split('-').map(Number) as [number, number];
  return Math.max(0, (by * 12 + bm) - (ay * 12 + am) + 1);
};

/** The last day of a month, YYYY-MM-DD. */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/** The first month of the quarter a month falls in. */
export function quarterStart(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const q0 = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(q0).padStart(2, '0')}`;
}

export type DashboardPeriod = {
  /** '2026-09' | '2026-Q3' */
  key: string;
  /** '09/2026' | 'Q3 2026' — the house numeric spelling; the screen appends ' *' when partial. */
  label: string;
  from: string;
  to: string;
  months: string[];
  /** Not finished as of today — the running month, a quarter not yet ended, or a future period. */
  partial: boolean;
};

const monthPeriod = (month: string, today: string): DashboardPeriod => {
  const to = monthEnd(month);
  return { key: month, label: `${month.slice(5, 7)}/${month.slice(0, 4)}`, from: `${month}-01`, to, months: [month], partial: today <= to };
};
const quarterPeriod = (first: string, today: string): DashboardPeriod => {
  const months = [first, addMonths(first, 1), addMonths(first, 2)];
  const to = monthEnd(months[2]!);
  const q = Math.floor((Number(first.slice(5, 7)) - 1) / 3) + 1;
  return { key: `${first.slice(0, 4)}-Q${q}`, label: `Q${q} ${first.slice(0, 4)}`, from: `${first}-01`, to, months, partial: today <= to };
};

export type PeriodWindow = {
  granularity: Granularity;
  /** How many periods back from today's when no range is named. */
  periods: number;
  /** An explicit range of months, inclusive — both or neither. */
  from?: string | null;
  to?: string | null;
  /** YYYY-MM-DD, the Malaysian day. */
  today: string;
  /** Every month that carries a forecast row — a future one extends the default window. */
  forecastMonths?: string[];
};

/**
 * The periods a Dashboard shows, oldest first. Without a range: the last N
 * periods ending on today's, plus every later period a forecast month falls
 * in, so a keyed target is visible before its month arrives. With a range:
 * exactly the months named (a quarter view rounds to whole quarters).
 */
export function periodsFor(w: PeriodWindow): DashboardPeriod[] {
  const thisMonth = w.today.slice(0, 7);
  let start: string;
  let end: string;
  if (w.from && w.to) {
    start = w.from;
    end = w.to;
  } else {
    const lastForecast = [...(w.forecastMonths ?? [])].filter((m) => MONTH_RE.test(m)).sort().pop() ?? null;
    end = lastForecast && lastForecast > thisMonth ? lastForecast : thisMonth;
    const n = Math.max(1, w.periods);
    start = w.granularity === 'quarter' ? addMonths(quarterStart(thisMonth), -3 * (n - 1)) : addMonths(thisMonth, -(n - 1));
  }
  if (w.granularity === 'quarter') {
    start = quarterStart(start);
    end = quarterStart(end);
  }
  if (end < start) end = start;
  const out: DashboardPeriod[] = [];
  if (w.granularity === 'quarter') {
    for (let m = start; m <= end; m = addMonths(m, 3)) out.push(quarterPeriod(m, w.today));
  } else {
    for (let m = start; m <= end; m = addMonths(m, 1)) out.push(monthPeriod(m, w.today));
  }
  return out;
}

/* ── The figures a period carries ───────────────────────────────────────── */

/** The P&L's totals as the Dashboard's Income Statement card reads them —
    the same eight the statement prints, with staff cost split out of the
    expenses (the P&L layout's "Salary & related" group). */
export type Figures = {
  salesSen: number; costOfSalesSen: number; grossProfitSen: number; otherIncomeSen: number;
  expensesSen: number; staffCostSen: number; otherExpensesSen: number;
  profitBeforeTaxSen: number; taxationSen: number; netProfitSen: number;
};

export const emptyFigures = (): Figures => ({
  salesSen: 0, costOfSalesSen: 0, grossProfitSen: 0, otherIncomeSen: 0, expensesSen: 0, staffCostSen: 0, otherExpensesSen: 0,
  profitBeforeTaxSen: 0, taxationSen: 0, netProfitSen: 0,
});

/** Months of a period added up — the forecast side of a quarter. */
export function addFigures(list: Figures[]): Figures {
  const out = emptyFigures();
  for (const f of list) for (const k of Object.keys(out) as Array<keyof Figures>) out[k] += f[k];
  return out;
}

/** The P&L layout's staff-cost category — the seed's own id (backend/scripts/lib/pnl-tree.mjs). */
export const STAFF_COST_CATEGORY_ID = 'pl:general:salary';

/** A %, one decimal, null when there is nothing to divide by. */
export const pct1 = (part: number, whole: number): number | null => (whole !== 0 ? Math.round((part / whole) * 1000) / 10 : null);
/** A ratio, two decimals, null when there is nothing to divide by. */
export const ratio2 = (part: number, whole: number): number | null => (whole !== 0 ? Math.round((part / whole) * 100) / 100 : null);

/* ── Cost structure by product group ────────────────────────────────────── */

/** The owner's four (2026-09-21: Sofa / Bedding / Accessories / Dining) —
    Bedding is mattress + bedframe — and Others for a line the four do not
    name, so a total still ties. Service has no stock and no purchase
    account: it is no group here. */
export const COST_GROUPS = [
  { key: 'sofa', label: 'Sofa' },
  { key: 'bedding', label: 'Bedding' },
  { key: 'accessories', label: 'Accessories' },
  { key: 'dining', label: 'Dining' },
  { key: 'others', label: 'Others' },
] as const;
export type CostGroupKey = (typeof COST_GROUPS)[number]['key'];

/** Which cost group an item group (the product's category: SOFA, MATTRESS,
    BEDFRAME, DINING, BEDLINES, ACCESSORY, DIFFUSER, CARPET, SERVICE) files under;
    null for service — nothing is bought or stocked for it. */
export function costGroupOfItemGroup(itemGroup: string | null | undefined): CostGroupKey | null {
  const g = String(itemGroup ?? '').trim().toUpperCase();
  if (!g) return 'others';
  if (g.includes('SERVICE') || g.startsWith('SVC')) return null;
  if (g.includes('SOFA')) return 'sofa';
  if (g.includes('MATTRESS') || g.includes('BEDFRAME')) return 'bedding';
  if (g.includes('DINING')) return 'dining';
  if (g.includes('BEDLINE') || g.includes('ACCESSOR') || g.includes('DIFFUSER') || g.includes('CARPET')) return 'accessories';
  return 'others';
}

/** The Performance P&L's group → the cost group (its cost is the Spend measure). */
export function costGroupOfPerformance(key: PerformanceGroupKey): CostGroupKey | null {
  switch (key) {
    case 'sofa': return 'sofa';
    case 'mattress': case 'bedframe': return 'bedding';
    case 'accessory': return 'accessories';
    case 'dining': return 'dining';
    case 'service': return null;
    default: return 'others';
  }
}

export type CostStructureGroup = { key: CostGroupKey; label: string; spendSen: number; purchaseSen: number; closingStockSen: number };

export const emptyCostStructure = (): Record<CostGroupKey, CostStructureGroup> =>
  Object.fromEntries(COST_GROUPS.map((g) => [g.key, { key: g.key, label: g.label, spendSen: 0, purchaseSen: 0, closingStockSen: 0 }])) as Record<CostGroupKey, CostStructureGroup>;

/** The groups in the owner's order; Others only when something landed there. */
export const costStructureList = (by: Record<CostGroupKey, CostStructureGroup>): CostStructureGroup[] =>
  COST_GROUPS.map((g) => by[g.key]).filter((g) => g.key !== 'others' || g.spendSen !== 0 || g.purchaseSen !== 0 || g.closingStockSen !== 0);

/* ── The balance sheet's summary and the ratios ─────────────────────────── */

export type BalanceSummary = {
  assetsSen: number; liabilitiesSen: number; equitySen: number; earningsSen: number;
  currentAssetsSen: number; currentLiabilitiesSen: number; inventorySen: number;
  /** liabilities / assets, %, null with no assets. */
  debtToAssetPct: number | null;
  /** The statement's own self-check: 0 or the ledger is broken. */
  checkSen: number;
};

export type Ratios = {
  grossMarginPct: number | null; netMarginPct: number | null;
  currentRatio: number | null; quickRatio: number | null;
  roePct: number | null; roaPct: number | null;
};

/** The six the Ratios card shows — margins off the period's P&L, liquidity
    and returns off the balance sheet at the period's end. */
export function ratiosOf(actual: Figures | null, bs: BalanceSummary | null): Ratios {
  return {
    grossMarginPct: actual ? pct1(actual.grossProfitSen, actual.salesSen) : null,
    netMarginPct: actual ? pct1(actual.netProfitSen, actual.salesSen) : null,
    currentRatio: bs ? ratio2(bs.currentAssetsSen, bs.currentLiabilitiesSen) : null,
    quickRatio: bs ? ratio2(bs.currentAssetsSen - bs.inventorySen, bs.currentLiabilitiesSen) : null,
    roePct: actual && bs ? pct1(actual.netProfitSen, bs.equitySen + bs.earningsSen) : null,
    roaPct: actual && bs ? pct1(actual.netProfitSen, bs.assetsSen) : null,
  };
}

/* ── Performance vs forecast, per product group (owner 2026-09-22) ──────── */

/** The card's groups: the Performance P&L's six with Bedding = mattress +
    bedframe, in the owner's order (Sofa / Bedding / Dining / Accessories /
    Service / Others), Others for what none of the five names. Three
    readings per group, one grammar: the ledger's ACTUAL through the item
    groups' sales accounts, the PERFORMANCE P&L's sales by SO date, and the
    FORECAST through the same accounts — so the six add up to the P&L's
    revenue, the Performance P&L's total and the Forecast P&L's sales. */
export const COMPARE_GROUPS = [
  { key: 'sofa', label: 'Sofa' },
  { key: 'bedding', label: 'Bedding' },
  { key: 'dining', label: 'Dining' },
  { key: 'accessories', label: 'Accessories' },
  { key: 'service', label: 'Service' },
  { key: 'others', label: 'Others' },
] as const;
export type CompareGroupKey = (typeof COMPARE_GROUPS)[number]['key'];

/** An item group's compare group — the cost groups' rule, with Service its own group. */
export function compareGroupOfItemGroup(itemGroup: string | null | undefined): CompareGroupKey {
  const g = String(itemGroup ?? '').trim().toUpperCase();
  if (g.includes('SERVICE') || g.startsWith('SVC')) return 'service';
  return costGroupOfItemGroup(g) ?? 'others';
}

/** The Performance P&L's group → the compare group. */
export function compareGroupOfPerformance(key: PerformanceGroupKey): CompareGroupKey {
  switch (key) {
    case 'sofa': return 'sofa';
    case 'mattress': case 'bedframe': return 'bedding';
    case 'accessory': return 'accessories';
    case 'dining': return 'dining';
    case 'service': return 'service';
    default: return 'others';
  }
}

/** One binding of an item group to its accounts, as scm.acc_item_group_accounts carries it. */
export type GroupAccountBinding = { group_code: string; sales_account: string | null; sales_return_account: string | null; purchase_account: string | null };
/** The accounts each compare group owns: an account counts ONCE, under the
    group it was first bound to (HOUZS binds OTHERS to 502-0000 beside the
    accessories — the binding's doing, not this file's). */
export type CompareAccounts = { sales: Map<CompareGroupKey, Set<string>>; purchase: Map<CompareGroupKey, Set<string>> };
export function compareAccountsOf(bindings: GroupAccountBinding[]): CompareAccounts {
  const sales = new Map<CompareGroupKey, Set<string>>();
  const purchase = new Map<CompareGroupKey, Set<string>>();
  const takenSales = new Set<string>();
  const takenPurchase = new Set<string>();
  const put = (map: Map<CompareGroupKey, Set<string>>, taken: Set<string>, key: CompareGroupKey, raw: string | null | undefined) => {
    const code = String(raw ?? '').trim();
    if (!code || taken.has(code)) return;
    taken.add(code);
    const set = map.get(key) ?? new Set<string>();
    set.add(code);
    map.set(key, set);
  };
  for (const b of bindings) {
    const key = compareGroupOfItemGroup(b.group_code);
    put(sales, takenSales, key, b.sales_account);
    put(sales, takenSales, key, b.sales_return_account);
    put(purchase, takenPurchase, key, b.purchase_account);
  }
  return { sales, purchase };
}

/** A trading-income account no group claims files under Others, so the six add up to the P&L's revenue. */
export const compareGroupOfSalesAccount = (code: string, accounts: CompareAccounts): CompareGroupKey => {
  for (const [key, set] of accounts.sales) if (set.has(code)) return key;
  return 'others';
};
/** A cost-of-sales account no group claims files under Others the same way. */
export const compareGroupOfPurchaseAccount = (code: string, accounts: CompareAccounts): CompareGroupKey => {
  for (const [key, set] of accounts.purchase) if (set.has(code)) return key;
  return 'others';
};

/** What a period adds up per group before the sides are read. */
export type CompareAcc = { actualSalesSen: number; performanceSalesSen: number; performanceCostSen: number; forecastSalesSen: number; forecastCostSen: number };
export const emptyCompare = (): Record<CompareGroupKey, CompareAcc> =>
  Object.fromEntries(COMPARE_GROUPS.map((g) => [g.key, { actualSalesSen: 0, performanceSalesSen: 0, performanceCostSen: 0, forecastSalesSen: 0, forecastCostSen: 0 }])) as Record<CompareGroupKey, CompareAcc>;

/** Which sides a period has: a future period has no actual and no
    performance (null, never 0); a period whose months carry no forecast row
    has no forecast. */
export type CompareHas = { actual: boolean; forecast: boolean };

export type CompareTotals = {
  /** The ledger: the group's sales accounts, credit-positive (a sales return keyed there reduces it). */
  actualSalesSen: number | null;
  /** The Performance P&L: the orders' sales and cost for the group, by SO date. */
  performanceSalesSen: number | null; performanceCostSen: number | null; performanceGpSen: number | null; performanceGpPct: number | null;
  /** The Forecast P&L: the group's accounts. */
  forecastSalesSen: number | null; forecastCostSen: number | null; forecastGpSen: number | null; forecastGpPct: number | null;
};
export type CompareGroup = CompareTotals & { key: CompareGroupKey; label: string };

const sidesOf = (a: CompareAcc, has: CompareHas): CompareTotals => ({
  actualSalesSen: has.actual ? a.actualSalesSen : null,
  performanceSalesSen: has.actual ? a.performanceSalesSen : null,
  performanceCostSen: has.actual ? a.performanceCostSen : null,
  performanceGpSen: has.actual ? a.performanceSalesSen - a.performanceCostSen : null,
  performanceGpPct: has.actual ? pct1(a.performanceSalesSen - a.performanceCostSen, a.performanceSalesSen) : null,
  forecastSalesSen: has.forecast ? a.forecastSalesSen : null,
  forecastCostSen: has.forecast ? a.forecastCostSen : null,
  forecastGpSen: has.forecast ? a.forecastSalesSen - a.forecastCostSen : null,
  forecastGpPct: has.forecast ? pct1(a.forecastSalesSen - a.forecastCostSen, a.forecastSalesSen) : null,
});

/** The groups in the owner's order, each side read; Others only when something landed there. */
export function compareList(by: Record<CompareGroupKey, CompareAcc>, has: CompareHas): CompareGroup[] {
  return COMPARE_GROUPS
    .filter((g) => g.key !== 'others' || Object.values(by.others).some((v) => v !== 0))
    .map((g) => ({ key: g.key, label: g.label, ...sidesOf(by[g.key], has) }));
}

/** The totals over every group, Others included whether shown or not. */
export function compareTotals(by: Record<CompareGroupKey, CompareAcc>, has: CompareHas): CompareTotals {
  const sum = (f: keyof CompareAcc): number => Object.values(by).reduce((s, a) => s + a[f], 0);
  return sidesOf({ actualSalesSen: sum('actualSalesSen'), performanceSalesSen: sum('performanceSalesSen'), performanceCostSen: sum('performanceCostSen'), forecastSalesSen: sum('forecastSalesSen'), forecastCostSen: sum('forecastCostSen') }, has);
}
