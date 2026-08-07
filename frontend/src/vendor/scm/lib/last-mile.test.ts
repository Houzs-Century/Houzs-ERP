import { describe, expect, test } from 'vitest';
import { isLastMileRow, lastMileSideOf, LAST_MILE_SIDE_LABEL } from './last-mile';

/* The Last Mile page's row derivation (owner pipeline 2026-08-07/08). The rows
 * are the SO rows whose server-stamped live trip sits on the picked day — the
 * page derives NOTHING itself. Worth pinning: the day filter, the SO-only rule,
 * and the two-sided split (to-run vs delivered) including the fold rule for a
 * day-row whose stage stamp is absent. */

const DAY = '2026-08-10';

const row = (over: Partial<Parameters<typeof isLastMileRow>[0]> = {}) => ({
  row_type: 'so' as const,
  trip_date: DAY,
  delivery_state: 'PENDING_SCHEDULE' as const,
  arrangement_stage: 'TIME_ARRANGED' as const,
  ...over,
});

describe('isLastMileRow — the picked day owns the board', () => {
  test('an SO row on a live trip that day is in', () => {
    expect(isLastMileRow(row(), DAY)).toBe(true);
  });

  test('no trip, another day, or a timestamped same-day value', () => {
    expect(isLastMileRow(row({ trip_date: null }), DAY)).toBe(false);
    expect(isLastMileRow(row({ trip_date: '2026-08-11' }), DAY)).toBe(false);
    /* A stray timestamp still matches its calendar day. */
    expect(isLastMileRow(row({ trip_date: `${DAY}T00:00:00Z` }), DAY)).toBe(true);
  });

  test('non-SO rows never join — their scheduling lives on their own documents', () => {
    expect(isLastMileRow(row({ row_type: 'assr' }), DAY)).toBe(false);
    expect(isLastMileRow(row({ row_type: 'dp' }), DAY)).toBe(false);
    expect(isLastMileRow(row({ row_type: 'project' }), DAY)).toBe(false);
  });
});

describe('lastMileSideOf — to-run vs delivered', () => {
  test('a time-arranged order is the to-run side', () => {
    expect(lastMileSideOf(row(), DAY)).toBe('TIME_ARRANGED');
  });

  test('a DELIVERED order with a trip that day is the done side (stage stamp is null there)', () => {
    expect(lastMileSideOf(row({ delivery_state: 'DELIVERED', arrangement_stage: null }), DAY)).toBe('DELIVERED');
  });

  test('a day-row with no stage stamp still folds into to-run — never invisible on its own day', () => {
    expect(lastMileSideOf(row({ arrangement_stage: undefined, delivery_state: 'PENDING_DELIVERY' }), DAY)).toBe('TIME_ARRANGED');
  });

  test('off-day rows are nobody\'s side', () => {
    expect(lastMileSideOf(row({ trip_date: null }), DAY)).toBeNull();
    expect(lastMileSideOf(row({ trip_date: '2026-08-11' }), DAY)).toBeNull();
  });

  test('labels', () => {
    expect(LAST_MILE_SIDE_LABEL.TIME_ARRANGED).toBe('Time arranged');
    expect(LAST_MILE_SIDE_LABEL.DELIVERED).toBe('Delivered');
  });
});
