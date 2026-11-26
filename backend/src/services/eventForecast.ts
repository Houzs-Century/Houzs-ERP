// ----------------------------------------------------------------------------
// eventForecast.ts — the Financial Snapshot in THREE layers (owner 2026-11-18):
// a future event shows, for every line, the best figure there is so far.
//
//   1. Last event  the ACTUAL figure of the most recent EARLIER event with the
//                  same organiser AND the same venue (same company). Used while
//                  the event has not ended, and after it for events from
//                  2026-11 on (their costs come in the next month).
//   2. Forecast    the figure someone typed on the event for that line
//                  (project_forecast). It beats the last event.
//   3. Actual      the event's own figure (books, typed cost lines, orders,
//                  the rate card on real sales). It beats both, as soon as it
//                  exists for that line.
//
// Lines that move with sales (Transport Fee, Commission, Merchandise) are the
// brand's % in Project Maintenance on the shown Sales; with no % set they are
// not borrowed as amounts: with no real or typed figure they are the shown
// Sales times the last event's own ratio, so a typed Sales forecast carries
// them along (owner 2026-11-19: 跟着我的sales变动就行了). COGS keeps the last
// event's amount (owner 2026-11-19: COGS 就真的要用上一场).
//
// No earlier same-organiser-venue-and-brand event = no Last event layer: nothing is
// borrowed from another venue. The totals (COGS Total, GP, Total Cost, Net
// Profit) are added up from the shown lines and say whether they include an
// estimate; `split` cuts Sales, Cost and Net Profit by layer for the reports.
//
// Pure: no I/O. The reads are services/eventForecastLoad.ts.
// ----------------------------------------------------------------------------

import type { PnlColumn } from './eventPnl';

/** The lines a forecast can be typed for, in the snapshot's order. */
export const FORECAST_LINES = [
  'sales',
  'cogs_matt_sofa',
  'cogs_bedframe',
  'cogs_accessories',
  'rental',
  'setup',
  'transport_fee',
  'transport_setup_dismantle',
  'commission',
  'merchandise',
  'others',
] as const;
export type ForecastLine = (typeof FORECAST_LINES)[number];

export const isForecastLine = (v: unknown): v is ForecastLine =>
  typeof v === 'string' && (FORECAST_LINES as readonly string[]).includes(v);

export type LineSource = 'actual' | 'forecast' | 'last_event';
export type LayeredLine = {
  amount: number;
  source: LineSource;
  forecast: number | null;
  last_event: number | null;
};
export type Split = { actual: number; forecast: number; last_event: number };
export type LayeredTotal = { amount: number; estimated: boolean };

export type ForecastLayers = {
  uses_last_event: boolean;
  lines: Record<ForecastLine, LayeredLine>;
  totals: { cogs_total: LayeredTotal; gross_profit: LayeredTotal; total_cost: LayeredTotal; net_profit: LayeredTotal };
  split: { sales: Split; cost: Split; net: Split };
  estimated: boolean;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Each line's figure in one P&L column, and whether it is a real (actual)
 * figure. A line counts as actual when something real stands behind it:
 *   Sales                 the column has sales (lines, box or orders);
 *   a COGS line           the orders' cost covers it, or it is not zero;
 *   Rental / Setup / Transport S&D / Others
 *                         Finance's books fill the row, or it is not zero;
 *   Transport Fee / Commission / Merchandise
 *                         books, a typed line, or the rate card on real sales.
 */
export function lineActuals(col: PnlColumn, booksRows: ReadonlySet<string>): Record<ForecastLine, { amount: number; actual: boolean }> {
  const fromOrders = col.cogs.from === 'so' || col.cogs.from === 'so_ratio';
  const cogs = (amount: number) => ({ amount, actual: fromOrders || amount !== 0 });
  const shared = (row: string, amount: number) => ({ amount, actual: booksRows.has(row) || amount !== 0 });
  const pct = (r: { amount: number; from: string }) => ({ amount: r.amount, actual: r.from !== 'none' || r.amount !== 0 });
  return {
    sales: { amount: col.sales, actual: col.salesFrom !== 'none' },
    cogs_matt_sofa: cogs(col.cogs.mattSofa),
    cogs_bedframe: cogs(col.cogs.bedframe),
    cogs_accessories: cogs(col.cogs.accessories),
    rental: shared('rental', col.rental),
    setup: shared('setup', col.setup),
    transport_fee: pct(col.transportFee),
    transport_setup_dismantle: shared('transport_setup_dismantle', col.transportSetupDismantle),
    commission: pct(col.commission),
    merchandise: pct(col.merchandise),
    others: shared('others', col.others),
  };
}

/** The last event's ACTUAL figure per line — a line it has no real figure for
 *  is left out, so it never lends a zero. */
export function lastEventValues(col: PnlColumn, booksRows: ReadonlySet<string>): Partial<Record<ForecastLine, number>> {
  const out: Partial<Record<ForecastLine, number>> = {};
  const a = lineActuals(col, booksRows);
  for (const k of FORECAST_LINES) if (a[k].actual) out[k] = a[k].amount;
  return out;
}

const COGS_LINES: readonly ForecastLine[] = ['cogs_matt_sofa', 'cogs_bedframe', 'cogs_accessories'];
const COST_LINES: readonly ForecastLine[] = [
  ...COGS_LINES, 'rental', 'setup', 'transport_fee', 'transport_setup_dismantle', 'commission', 'merchandise', 'others',
];

/**
 * The three layers over one P&L column. Per line: actual if it exists, else the
 * typed forecast, else the last event's actual (only when `useLastEvent`), else
 * the column's own figure (zero) shown as actual.
 */
/** The lines priced as a share of sales. */
export const SALES_DRIVEN_LINES: readonly ForecastLine[] = ['transport_fee', 'commission', 'merchandise'];

const rateOf = (col: PnlColumn, k: ForecastLine): number | null =>
  k === 'transport_fee' ? col.transportFee.pct : k === 'commission' ? col.commission.pct : k === 'merchandise' ? col.merchandise.pct : null;

export function layerPnl(input: {
  col: PnlColumn;
  booksRows: ReadonlySet<string>;
  forecast: Partial<Record<ForecastLine, number>>;
  lastEvent: Partial<Record<ForecastLine, number>> | null;
  useLastEvent: boolean;
}): ForecastLayers {
  const actuals = lineActuals(input.col, input.booksRows);
  const last = input.useLastEvent ? input.lastEvent : null;
  const lines = {} as Record<ForecastLine, LayeredLine>;
  const lastSales = last?.sales ?? 0;
  for (const k of FORECAST_LINES) {
    const a = actuals[k];
    const f = input.forecast[k];
    const l = last?.[k];
    const forecast = f == null ? null : round2(f);
    const lastEvent = l == null ? null : round2(l);
    const sales = k === 'sales' ? null : lines.sales;
    const rate = rateOf(input.col, k);
    if (a.actual) lines[k] = { amount: round2(a.amount), source: 'actual', forecast, last_event: lastEvent };
    else if (forecast != null) lines[k] = { amount: forecast, source: 'forecast', forecast, last_event: lastEvent };
    else if (sales && sales.source !== 'actual' && sales.amount > 0 && rate != null) {
      /* The brand's % in Project Maintenance on the shown (forecast) Sales - it
         wins over the last event's ratio (owner 2026-11-20: 应该是跟着project
         maintenance). */
      lines[k] = { amount: round2((sales.amount * rate) / 100), source: sales.source === 'forecast' ? 'forecast' : 'last_event', forecast, last_event: lastEvent };
    } else if (lastEvent != null && sales && lastSales > 0 && SALES_DRIVEN_LINES.includes(k)) {
      lines[k] = { amount: round2((sales.amount * lastEvent) / lastSales), source: sales.source === 'forecast' ? 'forecast' : 'last_event', forecast, last_event: lastEvent };
    } else if (lastEvent != null) lines[k] = { amount: lastEvent, source: 'last_event', forecast, last_event: lastEvent };
    else lines[k] = { amount: round2(a.amount), source: 'actual', forecast, last_event: lastEvent };
  }

  const cogsOther = round2(input.col.cogs.other);
  const serviceRevenue = round2(input.col.serviceRevenue);
  const sumOf = (keys: readonly ForecastLine[]) => keys.reduce((s, k) => s + lines[k].amount, 0);
  const anyEstimate = (keys: readonly ForecastLine[]) => keys.some((k) => lines[k].source !== 'actual');

  const cogsTotal = round2(sumOf(COGS_LINES) + cogsOther);
  const totalCost = round2(sumOf(COST_LINES) + cogsOther);
  const sales = lines.sales.amount;

  const split = { sales: zero(), cost: zero(), net: zero() };
  split.sales[lines.sales.source] += sales;
  split.cost.actual += cogsOther;
  for (const k of COST_LINES) split.cost[lines[k].source] += lines[k].amount;
  for (const s of ['actual', 'forecast', 'last_event'] as const) {
    split.net[s] = round2(split.sales[s] + (s === 'actual' ? serviceRevenue : 0) - split.cost[s]);
    split.sales[s] = round2(split.sales[s]);
    split.cost[s] = round2(split.cost[s]);
  }

  const estimated = anyEstimate(FORECAST_LINES);
  return {
    uses_last_event: input.useLastEvent,
    lines,
    totals: {
      cogs_total: { amount: cogsTotal, estimated: anyEstimate(COGS_LINES) },
      gross_profit: { amount: round2(sales - cogsTotal), estimated: anyEstimate(['sales', ...COGS_LINES]) },
      total_cost: { amount: totalCost, estimated: anyEstimate(COST_LINES) },
      net_profit: { amount: round2(sales + serviceRevenue - totalCost), estimated },
    },
    split,
    estimated,
  };
}

const zero = (): Split => ({ actual: 0, forecast: 0, last_event: 0 });


export type BaselineCandidate = {
  id: number;
  company_id: number | null;
  organizer: string | null;
  venue: string | null;
  start_date: string | null;
  /** The brand (AKEMI, ZANOTTI...): an earlier event of the SAME brand wins over
   *  one of another brand at the same fair (owner 2026-11-18). */
  brand: string | null;
};

/** A venue / organiser compared the way a project's venue meets the venue
 *  master (scm/lib/project-venue-join.ts): trimmed, case-insensitive. */
export const matchKey = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase();
const day = (v: string | null | undefined): string => String(v ?? '').slice(0, 10);
const isDay = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * The last event for `current`: the candidate of the SAME company, SAME
 * organiser, SAME venue and SAME brand whose start date is the latest one BEFORE
 * the current event's start (a tie goes to the higher id). Brands at one fair
 * sell very differently, so another brand never counts (owner 2026-11-18:
 * "organiser + venue + branding"). Null when the current event has no organiser,
 * venue, brand, start date or company, or no candidate fits.
 */
export function pickLastEvent<T extends BaselineCandidate>(current: BaselineCandidate, candidates: readonly T[]): T | null {
  const org = matchKey(current.organizer);
  const venue = matchKey(current.venue);
  const brand = matchKey(current.brand);
  const start = day(current.start_date);
  if (!org || !venue || !brand || !isDay(start) || current.company_id == null) return null;
  let best: T | null = null;
  for (const c of candidates) {
    if (c.id === current.id || c.company_id !== current.company_id) continue;
    if (matchKey(c.organizer) !== org || matchKey(c.venue) !== venue || matchKey(c.brand) !== brand) continue;
    const s = day(c.start_date);
    if (!isDay(s) || s >= start) continue;
    const b = best ? day(best.start_date) : '';
    if (!best || s > b || (s === b && c.id > best.id)) best = c;
  }
  return best;
}

/** Events starting on or after this day keep the Last event layer after they
 *  end too: their costs are keyed at the start of the next month, so a blank
 *  line is a cost not in yet (owner 2026-11-19: A, 从这个月开始). Earlier
 *  events keep the old rule, so past months' reports do not move. */
export const LAST_EVENT_AFTER_END_FROM = '2026-11-01';

/** The Last event layer is used while the event has not ended (its end date,
 *  else its start date, is today or later), and always for an event starting
 *  on or after LAST_EVENT_AFTER_END_FROM. No date = not used. */
export function usesLastEvent(p: { start_date: string | null; end_date: string | null }, today: string): boolean {
  const start = day(p.start_date);
  if (isDay(start) && start >= LAST_EVENT_AFTER_END_FROM) return true;
  const end = day(p.end_date) || start;
  return isDay(end) && end >= today;
}

/** pickLastEvent for every event of a list at once (Project Overview): the same
 *  rule, grouped by company + organiser + venue instead of one scan per event. */
export function lastEventsOf<T extends BaselineCandidate>(rows: readonly T[]): Map<number, T> {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const org = matchKey(r.organizer);
    const venue = matchKey(r.venue);
    if (!org || !venue || r.company_id == null || !isDay(day(r.start_date))) continue;
    const k = `${r.company_id}|${org}|${venue}`;
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  const out = new Map<number, T>();
  for (const g of groups.values()) {
    for (const r of g) {
      const last = pickLastEvent(r, g);
      if (last) out.set(r.id, last);
    }
  }
  return out;
}
