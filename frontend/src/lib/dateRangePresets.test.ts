// The date-range presets and the day arithmetic behind DateRangeButton.
import { describe, expect, test } from 'vitest';
import {
  OUTSTANDING_DEFAULT_PRESET, OUTSTANDING_RANGE_PRESETS, REPORT_RANGE_PRESETS,
  addDays, dayDiff, daysInRange, isIsoDay, monthEnd, monthStart, presetLabel, presetOf, presetRange, quarterStart,
} from './dateRangePresets';

const TODAY = '2026-11-03';

describe('presetRange — each preset counted back from today', () => {
  test.each([
    ['today', '2026-11-03', '2026-11-03'],
    ['last7', '2026-10-28', '2026-11-03'],
    ['thisMonth', '2026-11-01', '2026-11-03'],
    ['lastMonth', '2026-10-01', '2026-10-31'],
    ['last3Months', '2026-09-01', '2026-11-03'],
    ['last12Months', '2025-11-03', '2026-11-03'],
    ['thisYear', '2026-01-01', '2026-11-03'],
    ['all', '', ''],
  ] as const)('%s → %s – %s', (key, from, to) => {
    expect(presetRange(key, TODAY)).toEqual({ from, to });
  });

  test('Last 12 months is the window Outstanding always opened on (a year back to the day)', () => {
    // The page used to read todayMyt(-365): the same 365 days back.
    expect(presetRange('last12Months', TODAY).from).toBe(addDays(TODAY, -365));
    expect(OUTSTANDING_DEFAULT_PRESET).toBe('last12Months');
  });

  test.each([
    ['thisQuarter', '2026-10-01', '2026-11-03'],
    ['lastQuarter', '2026-07-01', '2026-09-30'],
    ['yearToDate', '2026-01-01', '2026-11-03'],
    ['lastYear', '2025-01-01', '2025-12-31'],
  ] as const)('the reports’ %s → %s – %s', (key, from, to) => {
    expect(presetRange(key, TODAY)).toEqual({ from, to });
  });

  test('the reports offer the design’s seven, in order; a quarter back crosses the year', () => {
    expect(REPORT_RANGE_PRESETS.map(presetLabel)).toEqual([
      'This month', 'Last month', 'This quarter', 'Last quarter', 'Year to date', 'Last 12 months', 'Last year',
    ]);
    expect(presetRange('lastQuarter', '2026-02-10')).toEqual({ from: '2025-10-01', to: '2025-12-31' });
    expect(quarterStart('2026-12-31')).toBe('2026-10-01');
  });

  test('Last month crosses a year boundary', () => {
    expect(presetRange('lastMonth', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(presetRange('last3Months', '2026-02-10')).toEqual({ from: '2025-12-01', to: '2026-02-10' });
  });
});

describe('presetOf', () => {
  test('names the preset a range is, or none', () => {
    expect(presetOf({ from: '2026-10-01', to: '2026-10-31' }, OUTSTANDING_RANGE_PRESETS, TODAY)).toBe('lastMonth');
    expect(presetOf({ from: '', to: '' }, OUTSTANDING_RANGE_PRESETS, TODAY)).toBe('all');
    expect(presetOf({ from: '2026-10-02', to: '2026-10-31' }, OUTSTANDING_RANGE_PRESETS, TODAY)).toBeNull();
  });

  test('offers the design’s seven presets plus Last 12 months, in order', () => {
    expect(OUTSTANDING_RANGE_PRESETS.map(presetLabel)).toEqual([
      'Today', 'Last 7 days', 'This month', 'Last month', 'Last 3 months', 'Last 12 months', 'This year', 'All dates',
    ]);
  });
});

describe('day arithmetic', () => {
  test('month starts and ends, leap years included', () => {
    expect(monthStart('2026-11-03')).toBe('2026-11-01');
    expect(monthStart('2026-11-03', -11)).toBe('2025-12-01');
    expect(monthEnd('2028-02-10')).toBe('2028-02-29');
    expect(monthEnd('2026-02-10')).toBe('2026-02-28');
  });

  test('counts days both ends included, and the gap between two days', () => {
    expect(daysInRange('2026-10-01', '2026-10-01')).toBe(1);
    expect(daysInRange('2026-10-01', '2026-10-31')).toBe(31);
    expect(dayDiff('2026-10-01', '2026-11-03')).toBe(33);
    expect(dayDiff('2026-11-03', '2026-10-01')).toBe(-33);
  });

  test('isIsoDay accepts real days only', () => {
    expect(isIsoDay('2026-02-28')).toBe(true);
    expect(isIsoDay('2026-02-30')).toBe(false);
    expect(isIsoDay('2026/02/28')).toBe(false);
    expect(isIsoDay('')).toBe(false);
  });
});
