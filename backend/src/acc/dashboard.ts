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
