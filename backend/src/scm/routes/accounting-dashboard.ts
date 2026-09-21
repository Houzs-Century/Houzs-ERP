// ----------------------------------------------------------------------------
// accounting-dashboard — GET /accounting/dashboard (owner 2026-09-21: the
// Hookka Dashboard, trading edition — P&L, performance P&L, Cost structure
// by product group, cash flow; 两个都可以，做).
//
// One payload of PERIODS (months or quarters), each carrying what the cards
// draw: the P&L's totals as ACTUAL, the Forecast P&L's totals for the same
// months as FORECAST, the Performance P&L's groups, the cost structure by
// product group, the Cash Flow's in / out / net and tree, the balance
// sheet's summary and the six ratios.
//
// THE ONE RULE (the Porting Guide's): every actual figure is produced by the
// statements' OWN builders — buildPnl, buildBalanceSheet,
// buildReceiptsPayments, buildPerformance — the same functions the report
// routes answer with. This file never re-derives a figure from raw tables;
// a card that could disagree with its report is worse than no card.
//
// What it does for speed, and only that: the ledger and the stock replay
// are read ONCE for the whole window and handed to the builders as
// in-memory sources (ReportSources / RpSources / PerfSources) instead of
// each period replaying the tables; the payload is cached in the Worker
// for 60 s per company and query. The figures are the builders'. Since
// 2026-09-22 the window's sales orders, supplier vouchers and settings ride
// the same preload, read in two parallel waves — the owner found the page
// slow while every period went back to the tables (~150 round trips a year).
//
// A period not finished today is PARTIAL (the running month, a quarter not
// yet ended, a future one); a future period carries no actuals — null, so a
// chart's line breaks rather than drawing a zero.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';
import type { StockBucket } from '../lib/stock-bucket';
import { countsInTheBooks } from '../../acc/reversal-pairs';
import { resolveRoles, type AccountRole } from '../../acc/rules';
import { bucketByWarehouse, foldStockByBucket, foldStockByItem, loadOwnedMovementsUpTo, type OwnedMovement } from '../../acc/stock-close';
import type { LaidNode, LayoutItem, ReportKey } from '../../acc/report-layout';
import { PERFORMANCE_GROUPS, type PerfLine, type PerfOrder, type PerformanceSettings } from '../../acc/performance-pnl';
import { monthFigures, sortedMonths, type ForecastAccount, type ForecastGrid } from '../shared/forecast-pnl';
import { SO_NOT_AN_ORDER } from '../shared/so-deliverable-states';
import { allowedIds, resolveLayout, type ResolvedLayout } from './accounting-report-layouts';
import { buildBalanceSheet, buildPnl, loadAccounts, sumGlRows, type AccountRow, type PnlReport, type ReportLine, type ReportSources } from './accounting-reports';
import { buildReceiptsPayments, rpDbSources, supplierVouchersOf, type RpGlLine, type RpSources, type RpSplit, type RpTotals } from './accounting-rp';
import { buildPerformance, perfDbSources, type PerfSources, type PerformancePayload } from './accounting-performance';
import { loadForecastAccounts, loadGrid } from './accounting-forecast';
import {
  COST_GROUPS, MONTH_RE, STAFF_COST_CATEGORY_ID, addFigures, costGroupOfItemGroup, costGroupOfPerformance, costStructureList, emptyCostStructure,
  monthsBetween, pct1, periodsFor, ratiosOf,
  type BalanceSummary, type CostGroupKey, type CostStructureGroup, type DashboardPeriod, type Figures, type Granularity, type Ratios,
} from '../../acc/dashboard';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
/* The PostgREST client is untyped throughout the acc layer; borrow its type rather than write any. */
type Sb = Parameters<typeof resolveRoles>[0];
const requirePerm = (c: Ctx): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
const NO_PERM = { error: "You don't have permission to read the financial statements." };
type Fail = { ok: false; reason: string };
const failed = (e: unknown): string => String((e as { message?: string }).message ?? e);

/* ── The query ───────────────────────────────────────────────────────────── */

export type DashboardQuery = { granularity: Granularity; periods: number; from: string | null; to: string | null };
const MAX_MONTHS = 36;
const MAX_QUARTERS = 16;

/** granularity=month|quarter (month), periods=N (12 months / 8 quarters),
    from & to = YYYY-MM together or not at all. Refusals are sentences. */
export function parseDashboardQuery(q: { granularity?: string | null; periods?: string | null; from?: string | null; to?: string | null }): { ok: true; query: DashboardQuery } | { ok: false; message: string } {
  const g = String(q.granularity ?? '').trim() || 'month';
  if (g !== 'month' && g !== 'quarter') return { ok: false, message: 'granularity must be month or quarter.' };
  const max = g === 'quarter' ? MAX_QUARTERS : MAX_MONTHS;
  const pRaw = String(q.periods ?? '').trim();
  const periods = pRaw === '' ? (g === 'quarter' ? 8 : 12) : Number(pRaw);
  if (!Number.isInteger(periods) || periods < 1 || periods > max) return { ok: false, message: `periods must be a whole number from 1 to ${max}.` };
  const from = String(q.from ?? '').trim() || null;
  const to = String(q.to ?? '').trim() || null;
  if ((from === null) !== (to === null)) return { ok: false, message: 'from and to go together (YYYY-MM).' };
  if (from && to) {
    if (!MONTH_RE.test(from) || !MONTH_RE.test(to) || from > to) return { ok: false, message: 'from and to must be YYYY-MM, from on or before to.' };
    if (monthsBetween(from, to) > MAX_MONTHS) return { ok: false, message: `a range spans at most ${MAX_MONTHS} months.` };
  }
  return { ok: true, query: { granularity: g, periods, from, to } };
}

/* ── The payload ─────────────────────────────────────────────────────────── */

export type DashboardPerformance = {
  groups: Array<{ key: string; label: string; salesSen: number; cogsSen: number; gpSen: number; gpPct: number | null }>;
  salesSen: number; cogsSen: number; gpSen: number;
  /** The reference line's figure — the forecast is keyed per account, not per group, so the card compares totals. */
  totalGpPct: number | null;
};
export type DashboardCashFlow = { inSen: number; outSen: number; netSen: number; openingSen: number; closingSen: number; tree: LaidNode[] };
export type DashboardPeriodPayload = DashboardPeriod & {
  actual: Figures | null;
  forecast: Figures | null;
  performance: DashboardPerformance | null;
  costStructure: { groups: CostStructureGroup[] } | null;
  cashFlow: DashboardCashFlow | null;
  balanceSheet: BalanceSummary | null;
  ratios: Ratios;
  /** The period's closing stock is the engine's, provisional until the close books that month-end. */
  stock: { closingProvisional: boolean };
};
export type DashboardPayload = {
  granularity: Granularity;
  today: string;
  window: { from: string; to: string };
  forecastMonths: string[];
  groups: { performance: Array<{ key: string; label: string }>; costStructure: Array<{ key: string; label: string }> };
  periods: DashboardPeriodPayload[];
};

/* ── The preload: the window's ledger and stock, read once ──────────────── */

type GlRow = RpGlLine & { line_id?: string; account_type?: string | null };
const GL_COLS = 'line_id, je_no, entry_date, source_type, source_doc_no, account_code, account_name, account_type, debit_sen, credit_sen, party_type, party_code, party_name, notes, posted, reversed, reversed_by_je';

type Preload = {
  /** Every line the books count, up to the window's end, in line order. */
  gl: GlRow[];
  moves: OwnedMovement[];
  bucketOf: (warehouseId: unknown) => StockBucket;
  accounts: AccountRow[];
  roles: Record<AccountRole, string>;
  /** 'YYYY-MM' → the ledger carries an active STOCKADJ closing for that month. */
  closingBooked: Map<string, boolean>;
  layouts: Partial<Record<ReportKey, { ok: true } & ResolvedLayout>>;
  forecast: { grid: ForecastGrid; accounts: ForecastAccount[] };
  /** The purchase accounts bound to each cost group's item groups — one account counts once, where it was first bound. */
  purchaseAccountsOf: Map<CostGroupKey, Set<string>>;
  /** item code → the product's category, for the closing stock by group. */
  categoryOfItem: Map<string, string | null>;
  /** The Performance P&L's own inputs, read once for the window: the sales orders and their lines, the rate and account, the rate's account row. */
  perf: { settings: PerformanceSettings; orders: PerfOrder[]; lines: PerfLine[]; rateAccount: { code: string; name: string } | null };
  /** The Cash Flow's own inputs, read once: the money accounts and what the window's supplier-payment vouchers settled. */
  rp: { moneyAccounts: Array<{ code: string; name: string }>; splits: Map<string, RpSplit[]> };
};

/* Two waves of parallel reads (2026-09-22, the owner's "loading 很慢": the
   preload read its tables one after another, and the Performance and Cash
   Flow builders went back to the database for every period — a dozen round
   trips a month, some 150 for a year, on a ledger the database answers in
   milliseconds). Wave 1 needs only the window; wave 2 needs what wave 1
   named. The figures are the builders' own either way. */
async function preload(sb: Sb, companyId: number, layoutIds: number[], windowStart: string, windowEnd: string, grid: ForecastGrid): Promise<{ ok: true; pre: Preload } | Fail> {
  const perfDb = perfDbSources(sb, companyId, layoutIds);
  const rpDb = rpDbSources(sb, companyId, layoutIds);
  const readClosings = async (): Promise<{ ok: true; closingBooked: Map<string, boolean> } | Fail> => {
    const { data: adj, error: adjErr } = await sb.from('journal_entries').select('source_doc_no, reversed').eq('company_id', companyId).eq('source_type', 'STOCKADJ');
    if (adjErr) return { ok: false, reason: `closing entries: ${failed(adjErr)}` };
    const closingBooked = new Map<string, boolean>();
    for (const j of (adj ?? []) as Array<{ source_doc_no: string | null; reversed: boolean | null }>) {
      const m = /^STOCKADJ-\d+-(\d{4}-\d{2})$/.exec(String(j.source_doc_no ?? ''));
      if (m && !j.reversed) closingBooked.set(m[1]!, true);
    }
    return { ok: true, closingBooked };
  };
  const readBindings = async (): Promise<{ ok: true; purchaseAccountsOf: Map<CostGroupKey, Set<string>> } | Fail> => {
    const { data: bindings, error: bErr } = await sb.from('acc_item_group_accounts').select('group_code, purchase_account').eq('company_id', companyId);
    if (bErr) return { ok: false, reason: `item groups: ${failed(bErr)}` };
    const purchaseAccountsOf = new Map<CostGroupKey, Set<string>>();
    const taken = new Set<string>();
    for (const b of (bindings ?? []) as Array<{ group_code: string; purchase_account: string | null }>) {
      const key = costGroupOfItemGroup(b.group_code);
      const code = String(b.purchase_account ?? '').trim();
      if (!key || !code || taken.has(code)) continue;
      taken.add(code);
      const set = purchaseAccountsOf.get(key) ?? new Set<string>();
      set.add(code);
      purchaseAccountsOf.set(key, set);
    }
    return { ok: true, purchaseAccountsOf };
  };

  /* Wave 1 — the window's tables. */
  const [gl, moves, wh, accs, roles, closings, laidPnl, laidBs, laidPerf, laidRp, fAccounts, bindings, settings, orders, money] = await Promise.all([
    paginateAll<GlRow>((f, t) => sb.from('v_gl_entries').select(GL_COLS).eq('company_id', companyId).lte('entry_date', windowEnd).order('line_id').range(f, t)),
    loadOwnedMovementsUpTo(sb, companyId, windowEnd),
    bucketByWarehouse(sb, companyId),
    loadAccounts(sb, companyId),
    resolveRoles(sb, companyId),
    readClosings(),
    resolveLayout(sb, layoutIds, 'pnl'),
    resolveLayout(sb, layoutIds, 'balance_sheet'),
    resolveLayout(sb, layoutIds, 'performance'),
    resolveLayout(sb, layoutIds, 'rp'),
    loadForecastAccounts(sb, companyId),
    readBindings(),
    perfDb.settings(),
    perfDb.orders(windowStart, windowEnd),
    rpDb.moneyAccounts(),
  ]);
  if (gl.error) return { ok: false, reason: `ledger: ${failed(gl.error)}` };
  if (!moves.ok) return { ok: false, reason: `stock: ${moves.reason}` };
  if (!wh.ok) return { ok: false, reason: `warehouses: ${wh.reason}` };
  if (!accs.ok) return { ok: false, reason: accs.reason };
  if (!closings.ok) return closings;
  if (!laidPnl.ok) return { ok: false, reason: laidPnl.reason };
  if (!laidBs.ok) return { ok: false, reason: laidBs.reason };
  if (!laidPerf.ok) return { ok: false, reason: laidPerf.reason };
  if (!laidRp.ok) return { ok: false, reason: laidRp.reason };
  if (!fAccounts.ok) return { ok: false, reason: `forecast accounts: ${fAccounts.reason}` };
  if (!bindings.ok) return bindings;
  if (!settings.ok) return { ok: false, reason: `performance settings: ${settings.reason}` };
  if (!orders.ok) return { ok: false, reason: `orders: ${orders.reason}` };
  if (!money.ok) return { ok: false, reason: `money accounts: ${money.reason}` };
  const layouts: Preload['layouts'] = { pnl: laidPnl, balance_sheet: laidBs, performance: laidPerf, rp: laidRp };
  const glRows = (gl.data ?? []).filter((r) => countsInTheBooks(r));

  /* Wave 2 — what wave 1 named: the live orders' lines, the moved items'
     products, the rate's account, and what the window's supplier-payment
     vouchers settled (the report's own rule, over every money account — the
     card asks for every column). */
  const liveDocs = orders.orders.filter((o) => !SO_NOT_AN_ORDER.has(String(o.status))).map((o) => o.doc_no);
  const itemCodes = [...new Set(moves.rows.map((r) => String(r.item_code ?? '')).filter(Boolean))];
  const controlCodes = new Set([roles.AR, roles.AP, roles.AP_OTHER, roles.AR_OTHER].filter(Boolean) as string[]);
  const apControls = new Set([roles.AP, roles.AP_OTHER].filter(Boolean) as string[]);
  const moneySet = new Set(money.accounts.map((a) => a.code));
  const vouchers = supplierVouchersOf(glRows.filter((r) => r.entry_date >= windowStart && r.entry_date <= windowEnd), moneySet, apControls);
  const [lines, prods, rateAccount, splits] = await Promise.all([
    perfDb.lines(liveDocs),
    chunkIn<{ code: string; category: string | null }>(itemCodes, (batch, f, t) =>
      sb.from('mfg_products').select('code, category').eq('company_id', companyId).in('code', batch).range(f, t)),
    perfDb.rateAccount(settings.settings.account),
    rpDb.splits(vouchers, controlCodes),
  ]);
  if (!lines.ok) return { ok: false, reason: `order lines: ${lines.reason}` };
  if (prods.error) return { ok: false, reason: `products: ${prods.error.message}` };
  if (!rateAccount.ok) return { ok: false, reason: `rate account: ${rateAccount.reason}` };
  if (!splits.ok) return { ok: false, reason: `supplier payments: ${splits.reason}` };
  const categoryOfItem = new Map<string, string | null>();
  for (const p of prods.data) categoryOfItem.set(String(p.code), p.category == null ? null : String(p.category));
  return {
    ok: true,
    pre: {
      gl: glRows,
      moves: moves.rows, bucketOf: wh.of, accounts: accs.accounts, roles, closingBooked: closings.closingBooked, layouts,
      forecast: { grid, accounts: fAccounts.accounts }, purchaseAccountsOf: bindings.purchaseAccountsOf, categoryOfItem,
      perf: { settings: settings.settings, orders: orders.orders, lines: lines.lines, rateAccount: rateAccount.account },
      rp: { moneyAccounts: money.accounts, splits: splits.byPv },
    },
  };
}

/** The builders' sources, answered from the preload. */
function sourcesOf(pre: Preload): { report: ReportSources; rp: RpSources; perf: PerfSources } {
  const sums = async (from: string | null, to: string | null) => ({
    ok: true as const,
    sums: sumGlRows(pre.gl.filter((r) => (!from || r.entry_date >= from) && (!to || r.entry_date <= to)) as unknown as Array<Record<string, unknown>>),
  });
  const accounts = async () => ({ ok: true as const, accounts: pre.accounts });
  const layout = async (report: ReportKey) => pre.layouts[report] ?? { ok: false as const, reason: `${report}: no layout` };
  const report: ReportSources = {
    sums, accounts, layout,
    roles: async () => pre.roles,
    stockByBucket: async (date) => ({ ok: true as const, ...foldStockByBucket(pre.moves, pre.bucketOf, date) }),
    closingBooked: async (monthEnd) => ({ ok: true as const, booked: pre.closingBooked.get(monthEnd.slice(0, 7)) === true }),
  };
  const rp: RpSources = {
    lines: async (moneyCodes, from, to) => {
      const money = new Set(moneyCodes);
      return { ok: true as const, money: pre.gl.filter((r) => money.has(r.account_code) && r.entry_date <= to), period: pre.gl.filter((r) => r.entry_date >= from && r.entry_date <= to) };
    },
    layout: () => layout('rp'),
    moneyAccounts: async () => ({ ok: true as const, accounts: pre.rp.moneyAccounts }),
    roles: async () => pre.roles,
    /* The window's map, cut to the vouchers asked for — a voucher with no
       allocation is absent, as the database read leaves it. */
    splits: async (pvNumbers) => {
      const byPv = new Map<string, RpSplit[]>();
      for (const n of pvNumbers) {
        const s = pre.rp.splits.get(n);
        if (s) byPv.set(n, s);
      }
      return { ok: true as const, byPv };
    },
  };
  const perf: PerfSources = {
    sums, accounts, layout: () => layout('performance'),
    settings: async () => ({ ok: true as const, settings: pre.perf.settings }),
    orders: async (from, to) => ({ ok: true as const, orders: pre.perf.orders.filter((o) => o.so_date >= from && o.so_date <= to) }),
    lines: async (docNos) => {
      const want = new Set(docNos);
      return { ok: true as const, lines: pre.perf.lines.filter((l) => want.has(l.doc_no)) };
    },
    rateAccount: async () => ({ ok: true as const, account: pre.perf.rateAccount }),
  };
  return { report, rp, perf };
}

/* ── The figures ─────────────────────────────────────────────────────────── */

/** A laid node's amount by id, anywhere in the tree; null when the tree has no such category. */
const nodeAmount = (nodes: LaidNode[], id: string): number | null => {
  for (const n of nodes) {
    if (n.id === id) return n.amountSen;
    const inner = nodeAmount(n.children, id);
    if (inner != null) return inner;
  }
  return null;
};
/** Every account code under the layout category `id`. */
const codesUnder = (items: LayoutItem[], id: string, inside = false): string[] => {
  const out: string[] = [];
  for (const it of items) {
    if (it.kind === 'account') {
      if (inside) out.push(it.code);
      continue;
    }
    if (it.kind === 'subtotal') continue;
    const hit = inside || it.id === id;
    if (hit && it.code) out.push(it.code);
    out.push(...codesUnder(it.children, id, hit));
  }
  return out;
};

const figuresOf = (t: PnlReport['totals'], staffCostSen: number): Figures => ({
  salesSen: t.tradingIncomeSen, costOfSalesSen: t.costOfSalesSen, grossProfitSen: t.grossProfitSen, otherIncomeSen: t.otherIncomeSen,
  expensesSen: t.expensesSen, staffCostSen, otherExpensesSen: t.expensesSen - staffCostSen,
  profitBeforeTaxSen: t.profitBeforeTaxSen, taxationSen: t.taxationSen, netProfitSen: t.netProfitSen,
});

/** The P&L's totals, staff cost = the layout's Salary & related category. */
const actualOf = (r: PnlReport): Figures => figuresOf(r.totals, nodeAmount(r.layout.expenses, STAFF_COST_CATEGORY_ID) ?? 0);

/** The forecast's totals over the period's months that carry a row; null when none does. */
function forecastOf(pre: Preload, staffCodes: Set<string>, months: string[]): Figures | null {
  const have = months.filter((m) => Object.prototype.hasOwnProperty.call(pre.forecast.grid, m));
  if (have.length === 0) return null;
  return addFigures(have.map((m) => {
    const f = monthFigures(pre.forecast.grid[m] ?? {}, pre.forecast.accounts);
    const staff = f.lines.filter((l) => staffCodes.has(l.code)).reduce((s, l) => s + l.amountSen, 0);
    return figuresOf(f.totals, staff);
  }));
}

/** Spend = the Performance P&L's cost per group; Purchase = the groups' purchase accounts in the period; Closing stock = the engine by product category on the period's last day. */
async function costStructureOf(pre: Preload, src: ReportSources, perf: PerformancePayload, p: DashboardPeriod): Promise<{ ok: true; groups: CostStructureGroup[] } | Fail> {
  const by = emptyCostStructure();
  for (const g of perf.groups) {
    const key = costGroupOfPerformance(g.key);
    if (key) by[key].spendSen += g.cogsSen;
  }
  const sums = await src.sums(p.from, p.to);
  if (!sums.ok) return { ok: false, reason: sums.reason };
  const debitOf = new Map(sums.sums.map((s) => [s.code, s.drSen - s.crSen]));
  for (const [key, codes] of pre.purchaseAccountsOf) for (const code of codes) by[key].purchaseSen += debitOf.get(code) ?? 0;
  for (const [code, at] of foldStockByItem(pre.moves, p.to)) {
    const key = costGroupOfItemGroup(pre.categoryOfItem.get(code) ?? null);
    if (key) by[key].closingStockSen += at.valueSen;
  }
  return { ok: true, groups: costStructureList(by) };
}

const sumSection = (ls: ReportLine[], section: string): number => ls.filter((l) => l.section === section).reduce((s, l) => s + l.amountSen, 0);

/* ── The build ───────────────────────────────────────────────────────────── */

export async function buildDashboard(sb: Sb, companyId: number, layoutIds: number[], q: DashboardQuery, today: string): Promise<{ ok: true; payload: DashboardPayload } | Fail> {
  const grid = await loadGrid(sb, companyId);
  if (!grid.ok) return { ok: false, reason: `forecast: ${grid.reason}` };
  const forecastMonths = sortedMonths(grid.grid);
  const periods = periodsFor({ granularity: q.granularity, periods: q.periods, from: q.from, to: q.to, today, forecastMonths });
  const windowStart = periods[0]!.from;
  const windowEnd = periods[periods.length - 1]!.to;
  const loaded = await preload(sb, companyId, layoutIds, windowStart, windowEnd, grid.grid);
  if (!loaded.ok) return loaded;
  const pre = loaded.pre;
  const src = sourcesOf(pre);
  const staffCodes = new Set(codesUnder(pre.layouts.pnl?.layout.blocks.expenses ?? [], STAFF_COST_CATEGORY_ID));

  const out: DashboardPeriodPayload[] = [];
  for (const p of periods) {
    const forecast = forecastOf(pre, staffCodes, p.months);
    if (p.from > today) {
      out.push({ ...p, actual: null, forecast, performance: null, costStructure: null, cashFlow: null, balanceSheet: null, ratios: ratiosOf(null, null), stock: { closingProvisional: true } });
      continue;
    }
    const pnl = await buildPnl(src.report, companyId, p.from, p.to);
    if (!pnl.ok) return { ok: false, reason: `P&L ${p.key}: ${pnl.reason}` };
    const actual = actualOf(pnl.report);

    const perf = await buildPerformance(companyId, p.from, p.to, src.perf);
    if (!perf.ok) return { ok: false, reason: `Performance ${p.key}: ${perf.reason}` };
    const performance: DashboardPerformance = {
      groups: perf.report.groups.map((g) => ({ key: g.key, label: g.label, salesSen: g.salesSen, cogsSen: g.cogsSen, gpSen: g.gpSen, gpPct: g.gpPct })),
      salesSen: perf.report.totals.salesSen, cogsSen: perf.report.totals.cogsSen, gpSen: perf.report.totals.gpSen, totalGpPct: perf.report.totals.gpPct,
    };
    const cost = await costStructureOf(pre, src.report, perf.report, p);
    if (!cost.ok) return { ok: false, reason: `Cost structure ${p.key}: ${cost.reason}` };

    const cf = await buildReceiptsPayments(companyId, { from: p.from, to: p.to, byParty: false, wanted: [] }, src.rp);
    if (!cf.ok) return { ok: false, reason: `Cash Flow ${p.key}: ${cf.reason}` };
    const t = cf.report.totals as Partial<RpTotals>;
    const inSen = t.receiptsTotalSen ?? 0;
    const outSen = t.paymentsTotalSen ?? 0;
    const cashFlow: DashboardCashFlow = { inSen, outSen, netSen: inSen - outSen, openingSen: t.openingTotalSen ?? 0, closingSen: t.closingTotalSen ?? 0, tree: cf.report.layout?.tree ?? [] };

    const bs = await buildBalanceSheet(src.report, companyId, p.to);
    if (!bs.ok) return { ok: false, reason: `Balance sheet ${p.key}: ${bs.reason}` };
    const bt = bs.report.totals;
    const balanceSheet: BalanceSummary = {
      assetsSen: bt.assetsSen, liabilitiesSen: bt.liabilitiesSen, equitySen: bt.equitySen, earningsSen: bt.earningsSen,
      currentAssetsSen: sumSection(bs.report.assets, 'CURRENT ASSETS'), currentLiabilitiesSen: sumSection(bs.report.liabilities, 'CURRENT LIABILITIES'),
      inventorySen: bs.stockTotalSen, debtToAssetPct: pct1(bt.liabilitiesSen, bt.assetsSen), checkSen: bt.checkSen,
    };

    out.push({
      ...p, actual, forecast, performance, costStructure: { groups: cost.groups }, cashFlow, balanceSheet,
      ratios: ratiosOf(actual, balanceSheet), stock: { closingProvisional: pnl.report.stock.closingProvisional },
    });
  }
  return {
    ok: true,
    payload: {
      granularity: q.granularity, today,
      window: { from: periods[0]!.from, to: windowEnd },
      forecastMonths,
      groups: {
        performance: PERFORMANCE_GROUPS.map((g) => ({ key: g.key, label: g.label })),
        costStructure: COST_GROUPS.map((g) => ({ key: g.key, label: g.label })),
      },
      periods: out,
    },
  };
}

/* ── The door, with its 60-second memory ────────────────────────────────── */

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 64;
const cache = new Map<string, { at: number; payload: DashboardPayload }>();
/** For the tests. */
export const clearDashboardCache = (): void => cache.clear();

export const dashboardHandler = async (c: Ctx): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const parsed = parseDashboardQuery({ granularity: c.req.query('granularity'), periods: c.req.query('periods'), from: c.req.query('from'), to: c.req.query('to') });
  if (!parsed.ok) return c.json({ error: 'bad_query', message: parsed.message }, 400);
  const ids = allowedIds(c);
  const today = todayMyt();
  const key = [co.companyId, ids.join('.'), parsed.query.granularity, parsed.query.periods, parsed.query.from ?? '', parsed.query.to ?? '', today].join('|');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return c.json({ ...hit.payload, cached: true });
  const r = await buildDashboard(c.get('supabase'), co.companyId, ids, parsed.query, today);
  if (!r.ok) return c.json({ error: 'load_failed', reason: r.reason }, 500);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), payload: r.payload });
  return c.json(r.payload);
};
