import { describe, expect, test } from 'vitest';
import { shiftYmd, deriveProjectFleetDates } from './project-fleet-dates';

describe('shiftYmd', () => {
  test('shifts by whole days, date-only output', () => {
    expect(shiftYmd('2026-11-10', -1)).toBe('2026-11-09');
    expect(shiftYmd('2026-11-10', 1)).toBe('2026-11-11');
  });
  test('crosses month and year boundaries', () => {
    expect(shiftYmd('2026-11-01', -1)).toBe('2026-10-31');
    expect(shiftYmd('2026-12-31', 1)).toBe('2027-01-01');
  });
  test('ignores a trailing time component', () => {
    expect(shiftYmd('2026-07-02T12:00', -1)).toBe('2026-07-01');
  });
  test('null / empty / unparseable → null', () => {
    expect(shiftYmd(null, -1)).toBeNull();
    expect(shiftYmd('', 1)).toBeNull();
    expect(shiftYmd('not-a-date', 1)).toBeNull();
  });
});

const base = {
  status: 'confirmed',
  archived_at: null,
  start_date: '2026-11-10',
  end_date: '2026-11-12',
  setup_start_at: null,
  dismantle_start_at: null,
};

describe('deriveProjectFleetDates', () => {
  test('confirmed with event window and no fleet dates → setup=start-1, dismantle=end+1', () => {
    expect(deriveProjectFleetDates(base)).toEqual({
      setup_start_at: '2026-11-09',
      dismantle_start_at: '2026-11-13',
    });
  });

  test('pending → nothing (not on the board yet)', () => {
    expect(deriveProjectFleetDates({ ...base, status: 'pending' })).toEqual({});
  });

  test('cancelled → nothing', () => {
    expect(deriveProjectFleetDates({ ...base, status: 'cancelled' })).toEqual({});
  });

  test('archived → nothing', () => {
    expect(deriveProjectFleetDates({ ...base, archived_at: '2026-10-01' })).toEqual({});
  });

  test('fill-only: a hand-set setup is kept, only dismantle is filled', () => {
    expect(deriveProjectFleetDates({ ...base, setup_start_at: '2026-11-08T09:00' })).toEqual({
      dismantle_start_at: '2026-11-13',
    });
  });

  test('no end_date → setup only', () => {
    expect(deriveProjectFleetDates({ ...base, end_date: null })).toEqual({
      setup_start_at: '2026-11-09',
    });
  });

  test('no event dates at all → nothing', () => {
    expect(deriveProjectFleetDates({ ...base, start_date: null, end_date: null })).toEqual({});
  });
});
