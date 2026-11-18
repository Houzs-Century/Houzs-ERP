import { describe, expect, it } from 'vitest';
import { eventPnl, type CostRate, type PnlLine } from './eventPnl';
import {
  FORECAST_LINES, lastEventsOf, lastEventValues, layerPnl, lineActuals, pickLastEvent, usesLastEvent,
  type BaselineCandidate,
} from './eventForecast';
import { parseForecastAmount } from '../routes/lib/forecast-amount';

/* The three-layer Financial Snapshot (owner 2026-11-18): Last event, then the
 * typed Forecast, then the Actual, line by line. */

const RATE: CostRate = { transport_pct: 5, merchandise_pct: 2, commission_normal_pct: 10, commission_boost_pct: null, boost_min_gp_pct: null, boost_min_sales: null };
const col = (lines: PnlLine[], lumpSales: number | null, rate: CostRate | null = RATE, books: string[] = []) =>
  eventPnl({ lines, booksRows: new Set(books), lumpSales, so: null, rate }).by_sales;

/* The last event: RM 100,000 sales, typed COGS, rental and setup, the rate card. */
const LAST = col([
  { kind: 'cost', category: 'cogs_matt_sofa', amount: 30000 },
  { kind: 'cost', category: 'rental', amount: 12000 },
  { kind: 'cost', category: 'setup', amount: 3000 },
], 100000);
/* A future event: nothing in yet. */
const EMPTY = col([], null);

describe('pickLastEvent — the most recent EARLIER event, same company, organiser and venue', () => {
  const cur: BaselineCandidate = { id: 10, company_id: 1, organizer: 'Expo Sdn Bhd', venue: 'MITEC', start_date: '2026-12-05' };
  const c = (o: Partial<BaselineCandidate> & { id: number }): BaselineCandidate =>
    ({ company_id: 1, organizer: 'Expo Sdn Bhd', venue: 'MITEC', start_date: '2026-06-01', ...o });

  it('takes the latest one before, matching case and spaces the way the venue join does', () => {
    const got = pickLastEvent(cur, [
      c({ id: 1, start_date: '2025-12-01' }),
      c({ id: 2, start_date: '2026-06-01', venue: '  mitec ', organizer: 'EXPO SDN BHD' }),
      c({ id: 3, start_date: '2026-03-01' }),
    ]);
    expect(got?.id).toBe(2);
  });

  it('never a later or same-day event, nor itself; a same-day tie between two earlier events goes to the higher id', () => {
    expect(pickLastEvent(cur, [c({ id: 4, start_date: '2027-01-01' }), c({ id: 5, start_date: '2026-12-05' }), c({ id: 10, start_date: '2026-01-01' })])).toBeNull();
    expect(pickLastEvent(cur, [c({ id: 6 }), c({ id: 7 })])?.id).toBe(7);
  });

  it('another company, organiser or venue never counts — no guessing from other venues', () => {
    expect(pickLastEvent(cur, [
      c({ id: 1, company_id: 2 }),
      c({ id: 2, organizer: 'Other Org' }),
      c({ id: 3, venue: 'KLCC' }),
    ])).toBeNull();
  });

  it('none found when the event has no organiser, venue, start or company', () => {
    const cands = [c({ id: 1 })];
    expect(pickLastEvent({ ...cur, organizer: ' ' }, cands)).toBeNull();
    expect(pickLastEvent({ ...cur, venue: null }, cands)).toBeNull();
    expect(pickLastEvent({ ...cur, start_date: null }, cands)).toBeNull();
    expect(pickLastEvent({ ...cur, company_id: null }, cands)).toBeNull();
  });

  it('lastEventsOf (the overview) picks exactly what pickLastEvent picks, for every event', () => {
    const rows: BaselineCandidate[] = [
      c({ id: 1, start_date: '2025-01-10' }), c({ id: 2, start_date: '2025-06-10' }), c({ id: 3, start_date: '2025-06-10' }),
      c({ id: 4, start_date: '2026-01-10', venue: 'mitec' }), c({ id: 5, start_date: '2026-01-10', company_id: 2 }),
      c({ id: 6, start_date: '2026-02-01', company_id: 2 }), c({ id: 7, start_date: '2026-03-01', organizer: 'Other' }),
      c({ id: 8, start_date: null }),
    ];
    const batch = lastEventsOf(rows);
    for (const r of rows) expect(batch.get(r.id)?.id ?? null).toBe(pickLastEvent(r, rows)?.id ?? null);
    expect(batch.get(4)?.id).toBe(3);
  });
});

describe('usesLastEvent — the last event lends figures only until the event ends', () => {
  it('upcoming or running: yes; ended or undated: no', () => {
    expect(usesLastEvent({ start_date: '2026-12-01', end_date: '2026-12-05' }, '2026-11-18')).toBe(true);
    expect(usesLastEvent({ start_date: '2026-11-15', end_date: '2026-11-18' }, '2026-11-18')).toBe(true);
    expect(usesLastEvent({ start_date: '2026-11-01', end_date: '2026-11-05' }, '2026-11-18')).toBe(false);
    expect(usesLastEvent({ start_date: '2026-12-01', end_date: null }, '2026-11-18')).toBe(true);
    expect(usesLastEvent({ start_date: null, end_date: null }, '2026-11-18')).toBe(false);
  });
});

describe('layerPnl — precedence per line: Actual, then Forecast, then Last event', () => {
  const lastValues = lastEventValues(LAST, new Set());

  it('a future event with nothing in shows the last event\'s actuals, tagged', () => {
    const l = layerPnl({ col: EMPTY, booksRows: new Set(), forecast: {}, lastEvent: lastValues, useLastEvent: true });
    expect(l.lines.sales).toMatchObject({ amount: 100000, source: 'last_event' });
    expect(l.lines.rental).toMatchObject({ amount: 12000, source: 'last_event' });
    expect(l.lines.commission).toMatchObject({ amount: 10000, source: 'last_event' });
    /* The last event had no bedframe COGS: it lends nothing for it. */
    expect(l.lines.cogs_bedframe).toMatchObject({ amount: 0, source: 'actual', last_event: null });
    expect(l.estimated).toBe(true);
  });

  it('a typed forecast beats the last event; an actual beats both', () => {
    const own = col([{ kind: 'cost', category: 'rental', amount: 15000 }], null);
    const l = layerPnl({ col: own, booksRows: new Set(), forecast: { sales: 80000, rental: 11000 }, lastEvent: lastValues, useLastEvent: true });
    expect(l.lines.sales).toMatchObject({ amount: 80000, source: 'forecast', forecast: 80000, last_event: 100000 });
    expect(l.lines.rental).toMatchObject({ amount: 15000, source: 'actual', forecast: 11000 });
    expect(l.lines.setup).toMatchObject({ amount: 3000, source: 'last_event' });
  });

  it('a row the books fill is actual even at zero', () => {
    const l = layerPnl({ col: EMPTY, booksRows: new Set(['rental']), forecast: { rental: 9000 }, lastEvent: lastValues, useLastEvent: true });
    expect(l.lines.rental).toMatchObject({ amount: 0, source: 'actual' });
  });

  it('real sales make the rate-card rows actual; with no real sales they fall to forecast / last event', () => {
    const own = col([], 50000);
    const withSales = layerPnl({ col: own, booksRows: new Set(), forecast: { commission: 1 }, lastEvent: lastValues, useLastEvent: true });
    expect(withSales.lines.commission).toMatchObject({ amount: 5000, source: 'actual' });
    expect(withSales.lines.sales).toMatchObject({ amount: 50000, source: 'actual' });
  });

  it('after the event ends the last event lends nothing; a typed forecast still stands', () => {
    const l = layerPnl({ col: EMPTY, booksRows: new Set(), forecast: { rental: 7000 }, lastEvent: lastValues, useLastEvent: false });
    expect(l.lines.sales).toMatchObject({ amount: 0, source: 'actual' });
    expect(l.lines.rental).toMatchObject({ amount: 7000, source: 'forecast' });
  });

  it('no last event: that layer is simply absent', () => {
    const l = layerPnl({ col: EMPTY, booksRows: new Set(), forecast: {}, lastEvent: null, useLastEvent: true });
    for (const k of FORECAST_LINES) expect(l.lines[k].source).toBe('actual');
    expect(l.estimated).toBe(false);
    expect(l.totals.net_profit).toEqual({ amount: 0, estimated: false });
  });
});

describe('layerPnl — totals are added up from the shown lines and say when they hold an estimate', () => {
  it('COGS Total, GP, Total Cost and Net Profit; the split by layer adds back to each total', () => {
    const own = col([{ kind: 'cost', category: 'cogs_bedframe', amount: 4000 }], null, null);
    const l = layerPnl({ col: own, booksRows: new Set(), forecast: { sales: 90000, rental: 10000 }, lastEvent: lastEventValues(LAST, new Set()), useLastEvent: true });
    /* matt/sofa 30,000 (last) + bedframe 4,000 (actual) */
    expect(l.totals.cogs_total).toEqual({ amount: 34000, estimated: true });
    expect(l.totals.gross_profit).toEqual({ amount: 56000, estimated: true });
    /* 34,000 + rental 10,000 (forecast) + setup 3,000 + transport 5,000 + commission 10,000 + merchandise 2,000 (last) */
    expect(l.totals.total_cost).toEqual({ amount: 64000, estimated: true });
    expect(l.totals.net_profit).toEqual({ amount: 26000, estimated: true });
    expect(l.split.sales).toEqual({ actual: 0, forecast: 90000, last_event: 0 });
    expect(l.split.cost).toEqual({ actual: 4000, forecast: 10000, last_event: 50000 });
    expect(l.split.net.actual + l.split.net.forecast + l.split.net.last_event).toBeCloseTo(l.totals.net_profit.amount, 2);
  });

  it('all actual: totals equal the P&L column\'s own and are not estimated', () => {
    const own = col([{ kind: 'cost', category: 'rental', amount: 5000 }, { kind: 'cost', category: 'cogs_matt_sofa', amount: 20000 }], 60000);
    const l = layerPnl({ col: own, booksRows: new Set(), forecast: {}, lastEvent: null, useLastEvent: true });
    expect(l.totals.total_cost).toEqual({ amount: own.totalCost, estimated: false });
    expect(l.totals.net_profit).toEqual({ amount: own.netProfit, estimated: false });
    expect(l.totals.gross_profit.amount).toBe(own.grossProfit);
  });
});

describe('lineActuals / lastEventValues', () => {
  it('a line the last event has no real figure for is left out, never lent as zero', () => {
    const v = lastEventValues(LAST, new Set());
    expect(v).toMatchObject({ sales: 100000, cogs_matt_sofa: 30000, rental: 12000, setup: 3000 });
    expect('cogs_bedframe' in v).toBe(false);
    expect('others' in v).toBe(false);
    expect(lineActuals(EMPTY, new Set()).sales.actual).toBe(false);
  });
});

describe('parseForecastAmount', () => {
  it('RM in, whole sen out; refuses negatives, junk and absurd figures', () => {
    expect(parseForecastAmount(1234.567)).toEqual({ ok: true, sen: 123457 });
    expect(parseForecastAmount('12,000')).toEqual({ ok: true, sen: 1200000 });
    expect(parseForecastAmount(0)).toEqual({ ok: true, sen: 0 });
    expect(parseForecastAmount(-1).ok).toBe(false);
    expect(parseForecastAmount('abc').ok).toBe(false);
    expect(parseForecastAmount(undefined).ok).toBe(false);
    expect(parseForecastAmount(1e9).ok).toBe(false);
  });
});
