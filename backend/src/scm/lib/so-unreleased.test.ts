import { describe, expect, it } from 'vitest';
import { unreleasedOrders } from './so-unreleased';

const today = '2026-10-27';
const row = (so_date: string, status = 'CONFIRMED', processing_date: string | null = null, on_hold = false) =>
  ({ doc_no: 'X', so_date, status, processing_date, on_hold });

describe('unreleasedOrders (HC-0159)', () => {
  it('counts a confirmed order with no processing date older than 30 days, and its age', () => {
    expect(unreleasedOrders([row('2026-09-01')], today)).toEqual({ count: 1, oldestDays: 56 });
  });
  it('ignores young orders, dated orders, drafts, cancelled, closed and held orders', () => {
    expect(unreleasedOrders([
      row('2026-10-20'), row('2026-09-01', 'CONFIRMED', '2026-09-05'), row('2026-09-01', 'DRAFT'),
      row('2026-09-01', 'CANCELLED'), row('2026-09-01', 'CLOSED'), row('2026-09-01', 'CONFIRMED', null, true),
    ], today)).toEqual({ count: 0, oldestDays: 0 });
  });
  it('takes the oldest age across orders', () => {
    expect(unreleasedOrders([row('2026-09-20'), row('2026-08-01')], today).oldestDays).toBe(87);
  });
});
