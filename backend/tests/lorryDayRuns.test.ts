/* Each lorry's run on a day, worked out on the server (owner 2026-11-08). The order must
   match the Last Mile card order (frontend slotSortKey + stop number + SO number), and
   the lorry starts from its own warehouse before any fallback. */
import { describe, expect, it } from 'vitest';
import { buildDayRuns, offPeninsula, windowStartMinutes, type RunStopIn } from '../src/scm/lib/lorry-day-runs';

const row = (over: Partial<RunStopIn>): RunStopIn => ({
  ref: 'HC-SO-1', plate: 'VNB 9058', lorryId: 'l1', companyId: 1, timeRange: null, stopNo: null,
  tripWarehouseId: null, orderWarehouseId: null, point: { lat: 3, lng: 101 }, ...over,
});

describe('the delivery window start, as the Last Mile card sorts it', () => {
  it.each([
    ['9:00-12:00', 540],
    ['TIME AROUND 9AM TO 11AM', 540],
    ['2pm - 6pm', 840],
    ['10.30am', 630],
    ['AM', 0],
    ['PM', 720],
    ['', Number.MAX_SAFE_INTEGER],
    [null, Number.MAX_SAFE_INTEGER],
    ['call first', Number.MAX_SAFE_INTEGER],
  ])('%s -> %s', (t, m) => { expect(windowStartMinutes(t)).toBe(m); });
});

describe('a lorry day', () => {
  it('orders by window start, then stop number, then SO number', () => {
    const [run] = buildDayRuns([
      row({ ref: 'C', timeRange: '2pm-6pm' }),
      row({ ref: 'B', timeRange: '9am-12pm', stopNo: 2 }),
      row({ ref: 'A', timeRange: '9am-12pm', stopNo: 1 }),
      row({ ref: 'D', timeRange: null }),
      row({ ref: 'AA', timeRange: '9am-12pm', stopNo: 2 }),
    ], () => null);
    expect(run!.stops.map((s) => s.ref)).toEqual(['A', 'AA', 'B', 'C', 'D']);
  });

  it('groups by plate whatever its spacing, and counts an SO once', () => {
    const runs = buildDayRuns([row({ ref: 'A', plate: 'VNB9058' }), row({ ref: 'A', plate: 'vnb 9058' }), row({ ref: 'B', plate: 'W 1591 T' })], () => null);
    expect(runs.map((r) => [r.plateKey, r.stops.length])).toEqual([['VNB9058', 1], ['W1591T', 1]]);
  });

  it('lists an order with no location instead of guessing one', () => {
    const [run] = buildDayRuns([row({ ref: 'A' }), row({ ref: 'B', point: null })], () => null);
    expect(run!.stops.map((s) => s.ref)).toEqual(['A']);
    expect(run!.unlocated).toEqual(['B']);
  });

  it("starts from the lorry's own warehouse, else the trip's, else where most orders ship from", () => {
    const rows = [row({ ref: 'A', tripWarehouseId: 'T', orderWarehouseId: 'O1' }), row({ ref: 'B', orderWarehouseId: 'O2' }), row({ ref: 'C', orderWarehouseId: 'O2' })];
    expect(buildDayRuns(rows, () => 'HOME')[0]!.homeWarehouseId).toBe('HOME');
    expect(buildDayRuns(rows, () => null)[0]!.homeWarehouseId).toBe('T');
    expect(buildDayRuns(rows.map((r) => ({ ...r, tripWarehouseId: null })), () => null)[0]!.homeWarehouseId).toBe('O2');
  });

  it('keeps the run under the company most of its orders belong to', () => {
    const [run] = buildDayRuns([row({ ref: 'A', companyId: 2 }), row({ ref: 'B', companyId: 1 }), row({ ref: 'C', companyId: 1 })], () => null);
    expect(run!.companyId).toBe(1);
  });

  it('leaves East Malaysia and Singapore off a peninsula lorry', () => {
    expect(offPeninsula('Sabah', 'Malaysia')).toBe(true);
    expect(offPeninsula(null, 'Singapore')).toBe(true);
    expect(offPeninsula('Selangor', 'Malaysia')).toBe(false);
  });
});
