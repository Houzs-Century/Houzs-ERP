import { describe, expect, test } from 'vitest';
import {
  slotMinutes,
  slotKindOf,
  slotLabelOf,
  runStatusOf,
  isLate,
  lateReason,
  rollupRun,
  dayStatsFrom,
  progressPct,
} from './fleet-day-cards';
import type { StopStatus } from './delivery-stop-status';

describe('slotMinutes — parse a free-text window', () => {
  test('canonical AM / PM windows', () => {
    expect(slotMinutes('9:00-12:00')).toEqual({ start: 540, end: 720 });
    expect(slotMinutes('2pm-6pm')).toEqual({ start: 840, end: 1080 });
  });
  test('an am/pm hint on one end carries to the other', () => {
    expect(slotMinutes('10 AM-1 PM')).toEqual({ start: 600, end: 780 });
  });
  test('one-sided and empty', () => {
    // A single numeric token is a one-sided start; prose with no numeric lead
    // ("after 3pm") does not parse, which is fine — slotKindOf still calls it CUSTOM.
    expect(slotMinutes('3pm')).toEqual({ start: 900, end: null });
    expect(slotMinutes('after 3pm')).toEqual({ start: null, end: null });
    expect(slotMinutes('')).toEqual({ start: null, end: null });
    expect(slotMinutes(null)).toEqual({ start: null, end: null });
  });
});

describe('slotKindOf — AM / PM / CUSTOM', () => {
  test('canonical windows bucket to AM / PM', () => {
    expect(slotKindOf('9:00-12:00')).toBe('AM');
    expect(slotKindOf('09:00 - 12:00')).toBe('AM');
    expect(slotKindOf('2:00pm-6:00pm')).toBe('PM');
    expect(slotKindOf('am')).toBe('AM');
    expect(slotKindOf('pm')).toBe('PM');
  });
  test('an off-window range is CUSTOM', () => {
    expect(slotKindOf('10 AM-1 PM')).toBe('CUSTOM');
    expect(slotKindOf('11-2')).toBe('CUSTOM');
  });
  test('unparseable-but-present text is CUSTOM; blank is null', () => {
    expect(slotKindOf('call first')).toBe('CUSTOM');
    expect(slotKindOf('')).toBeNull();
    expect(slotKindOf(null)).toBeNull();
  });
});

describe('slotLabelOf', () => {
  test('AM / PM collapse to the tag; custom shows verbatim', () => {
    expect(slotLabelOf('9-12')).toBe('AM');
    expect(slotLabelOf('2pm-6pm')).toBe('PM');
    expect(slotLabelOf('10 AM-1 PM')).toBe('10 AM-1 PM');
    expect(slotLabelOf(null)).toBe('');
  });
});

describe('runStatusOf', () => {
  const s = (...v: StopStatus[]) => v;
  test('empty run is Not departed', () => {
    expect(runStatusOf([])).toBe('NOT_DEPARTED');
  });
  test('two done drops -> COMPLETED', () => {
    expect(runStatusOf(s('done', 'done'))).toBe('COMPLETED');
  });
  test('any started (active or a partial done) is On the way', () => {
    expect(runStatusOf(s('active', 'scheduled'))).toBe('ON_THE_WAY');
    expect(runStatusOf(s('done', 'scheduled'))).toBe('ON_THE_WAY');
    expect(runStatusOf(s('overdue', 'active'))).toBe('ON_THE_WAY');
  });
  test('nothing started is Not departed', () => {
    expect(runStatusOf(s('scheduled', 'overdue'))).toBe('NOT_DEPARTED');
  });
});

describe('isLate / lateReason — the owner non-ETA rule == overdue', () => {
  test('only overdue is late', () => {
    expect(isLate('overdue')).toBe(true);
    expect(isLate('active')).toBe(false);
    expect(isLate('done')).toBe(false);
    expect(isLate('scheduled')).toBe(false);
  });
  test('reason: past its day vs past its slot', () => {
    expect(lateReason('overdue', { day: '2026-11-01', today: '2026-11-02', slotEnd: null }))
      .toBe('Not delivered — its day has passed');
    expect(lateReason('overdue', { day: '2026-11-02', today: '2026-11-02', slotEnd: 720 }))
      .toBe('Past its 12:00 PM slot');
    expect(lateReason('overdue', { day: '2026-11-02', today: '2026-11-02', slotEnd: 1080 }))
      .toBe('Past its 6:00 PM slot');
  });
  test('not-late statuses have no reason', () => {
    expect(lateReason('active', { day: '2026-11-02', today: '2026-11-02', slotEnd: 720 })).toBeNull();
  });
});

describe('rollupRun / dayStatsFrom / podRate', () => {
  const s = (...v: StopStatus[]) => v;
  test('a run folds its statuses', () => {
    expect(rollupRun(s('done', 'done', 'active', 'overdue', 'scheduled'), 50000, 2))
      .toEqual({ drops: 5, delivered: 2, onTheWay: 1, late: 1, totalSen: 50000, withPod: 2 });
  });
  test('day stats sum runs; POD rate rounds delivered-with-evidence / drops', () => {
    const a = rollupRun(s('done', 'done'), 20000, 1);
    const b = rollupRun(s('done', 'active'), 30000, 1);
    const d = dayStatsFrom([a, b]);
    expect(d.lorries).toBe(2);
    expect(d.drops).toBe(4);
    expect(d.delivered).toBe(3);
    expect(d.onTheWay).toBe(1);
    expect(d.totalSen).toBe(50000);
    expect(d.withPod).toBe(2);
    expect(d.podRatePct).toBe(50);
  });
  test('no drops -> POD rate is null, not a divide-by-zero', () => {
    expect(dayStatsFrom([]).podRatePct).toBeNull();
    expect(dayStatsFrom([rollupRun([], 0, 0)]).podRatePct).toBeNull();
  });
});

describe('progressPct', () => {
  test('clamps and rounds', () => {
    expect(progressPct(0, 0)).toBe(0);
    expect(progressPct(5, 8)).toBe(63);
    expect(progressPct(8, 8)).toBe(100);
  });
});
