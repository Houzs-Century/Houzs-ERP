import { describe, expect, it } from 'vitest';
import { bandOfDay, bandOrder, mergeBands, sumDelivered } from './delivery-board-bands';
import { boardUpdatedLabel, stillLoadingMessage } from '../components/BoardLoadStatus';
import type { PlanningOrder, PlanningResponse } from './delivery-planning-queries';

const row = (doc: string, extra: Partial<PlanningOrder> = {}) =>
  ({ row_type: 'so', so_doc_no: doc, regions: ['KL'], delivery_state: 'PENDING_DELIVERY', ...extra }) as unknown as PlanningOrder;

describe('bandOfDay (the server rule, both sides of today)', () => {
  it('puts each day in one band', () => {
    expect(bandOfDay('2026-11-10', '2026-11-10')).toBe(1);
    expect(bandOfDay('2026-10-26', '2026-11-10')).toBe(1);
    expect(bandOfDay('2026-11-26', '2026-11-10')).toBe(2);
    expect(bandOfDay('2026-09-26', '2026-11-10')).toBe(3);
    expect(bandOfDay('2027-01-31', '2026-11-10')).toBe(4);
    expect(bandOfDay('2027-02-09', '2026-11-10')).toBe(5);
    expect(bandOfDay(null, '2026-11-10')).toBe(5);
  });
  it('loads the page\'s own band first, then nearest first', () => {
    expect(bandOrder(1)).toEqual([1, 2, 3, 4, 5]);
    expect(bandOrder(3)).toEqual([3, 1, 2, 4, 5]);
  });
});

describe('mergeBands', () => {
  it('keeps load order and shows a row in two band caches once', () => {
    const merged = mergeBands([[row('A'), row('B')], [row('B'), row('C')], [row('A', { row_type: 'assr' } as Partial<PlanningOrder>)]]);
    expect(merged.map((o) => `${o.row_type}:${o.so_doc_no}`)).toEqual(['so:A', 'so:B', 'so:C', 'assr:A']);
  });
});

describe('sumDelivered', () => {
  it('adds each OPEN band\'s own Delivered tally', () => {
    const part = (n: number, kl: number) => ({ orders: [], regions: [], counts: { ALL: n, PENDING_DELIVERY: 0, PENDING_SCHEDULE: 0, OVERDUE: 0, DELIVERED: n }, delivered_by_region: { KL: kl } }) as PlanningResponse;
    expect(sumDelivered([part(3, 2), part(4, 4)])).toEqual({ total: 7, byRegion: { KL: 6 } });
  });
});

describe('BoardLoadStatus text', () => {
  it('"Updated hh:mm" in Malaysia time', () => {
    expect(boardUpdatedLabel(Date.parse('2026-11-10T06:32:00Z'))).toBe('Updated 14:32');
    expect(boardUpdatedLabel(0)).toBeNull();
  });
  it('an empty search says older orders are still loading, or that a band failed', () => {
    expect(stillLoadingMessage({ loading: null, failed: null }, 'None.')).toBe('None.');
    expect(stillLoadingMessage({ loading: { band: 2, label: '16-30 days' }, failed: null }, 'None.')).toContain('still loading older orders (16-30 days)');
    expect(stillLoadingMessage({ loading: null, failed: { band: 3, label: '31-60 days', error: null, retry: () => {} } }, 'None.')).toContain('could not load');
  });
});
