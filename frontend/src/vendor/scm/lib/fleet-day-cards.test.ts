import { describe, expect, test } from 'vitest';
import {
  slotMinutes,
  slotKindOf,
  slotLabelOf,
  slotSortKey,
  condenseWindow,
  runStatusOf,
  isLate,
  lateReason,
  rollupRun,
  dayStatsFrom,
  progressPct,
  departureDeltaMin,
  isDepartLate,
} from './fleet-day-cards';
import { groupHistoryByDay, historyPreset, addDays, type HistoryRow } from './fleet-day-cards';
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

describe('slotSortKey — order a lorry\'s drops by delivery time', () => {
  const BIG = Number.MAX_SAFE_INTEGER;
  test('explicit window sorts by its start; bare AM before PM; no slot sinks to the end', () => {
    expect(slotSortKey('9:30am to 11am')).toBe(9 * 60 + 30);
    expect(slotSortKey('12:30pm to 2:30pm')).toBe(12 * 60 + 30);
    expect(slotSortKey('2pm-4pm')).toBe(14 * 60);
    expect(slotSortKey('am')).toBe(0);
    expect(slotSortKey('pm')).toBe(12 * 60);
    expect(slotSortKey('call first')).toBe(BIG); // non-empty but unreadable → last
    expect(slotSortKey(null)).toBe(BIG);
    expect(slotSortKey('')).toBe(BIG);
  });
  test('reads the start through the office\'s "TIME AROUND …" wording (not treated as untimed)', () => {
    expect(slotSortKey('TIME AROUND 9AM TO 11AM')).toBe(9 * 60);   // morning drop, shown as the "AM" tag
    expect(slotSortKey('TIME AROUND 2PM TO 4PM')).toBe(14 * 60);   // must NOT sink to the end
    expect(slotSortKey('TIME AROUND 12:30PM TO 2:30PM')).toBe(12 * 60 + 30);
  });
  test('the keys put a day in earliest-first order', () => {
    const windows = ['2pm-4pm', null, 'am', '9:30am to 11am', '12:30pm to 2:30pm'];
    const sorted = windows.slice().sort((a, b) => slotSortKey(a) - slotSortKey(b));
    expect(sorted).toEqual(['am', '9:30am to 11am', '12:30pm to 2:30pm', '2pm-4pm', null]);
  });
});

describe('condenseWindow — compact the day-map legend window text', () => {
  test('a verbose custom window condenses to start–end (24h, :00 dropped)', () => {
    expect(condenseWindow('10:30AM to 12:30PM')).toBe('10:30–12:30');
    expect(condenseWindow('10 AM-1 PM')).toBe('10–13');
    expect(condenseWindow('2pm-4pm')).toBe('14–16');
  });
  test('a bare AM / PM bucket stays the tag', () => {
    expect(condenseWindow('AM')).toBe('AM');
    expect(condenseWindow('pm')).toBe('PM');
  });
  test('one-sided keeps the start; unreadable-but-present is kept verbatim; blank is empty', () => {
    expect(condenseWindow('3pm')).toBe('15');
    expect(condenseWindow('call first')).toBe('call first');
    expect(condenseWindow('')).toBe('');
    expect(condenseWindow(null)).toBe('');
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

describe('history grouping + presets', () => {
  const r = (over: Partial<HistoryRow>): HistoryRow => ({
    day: '2026-10-30', soDocNo: 'S', doNumber: 'D', customer: 'C', slot: null,
    doneAt: null, amountSen: 10000, hasPod: false, plate: 'VQE9058', driver: 'Sam', ...over,
  });
  test('groups by day (latest first) with a per-day summary', () => {
    const days = groupHistoryByDay([
      r({ day: '2026-10-30', plate: 'A', hasPod: true, amountSen: 10000 }),
      r({ day: '2026-10-30', plate: 'B', hasPod: false, amountSen: 20000 }),
      r({ day: '2026-10-28', plate: 'A', hasPod: true, amountSen: 5000 }),
    ]);
    expect(days.map((d) => d.day)).toEqual(['2026-10-30', '2026-10-28']); // latest first
    expect(days[0]).toMatchObject({ drops: 2, lorries: 2, withPod: 1, podPct: 50, totalSen: 30000 });
    expect(days[1]).toMatchObject({ drops: 1, lorries: 1, podPct: 100, totalSen: 5000 });
  });
  test('empty -> no days', () => {
    expect(groupHistoryByDay([])).toEqual([]);
  });
  test('addDays + historyPreset end yesterday', () => {
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
    expect(historyPreset(7, '2026-11-01')).toEqual({ from: '2026-10-25', to: '2026-10-31' });
  });
});

describe('departureDeltaMin / isDepartLate', () => {
  test('positive = late, negative = early, whole minutes', () => {
    expect(departureDeltaMin('2026-11-01T00:30:00Z', '2026-11-01T00:42:00Z')).toBe(12);
    expect(departureDeltaMin('2026-11-01T00:30:00Z', '2026-11-01T00:25:00Z')).toBe(-5);
  });
  test('null when either side is missing or unparseable', () => {
    expect(departureDeltaMin(null, '2026-11-01T00:00:00Z')).toBeNull();
    expect(departureDeltaMin('2026-11-01T00:00:00Z', null)).toBeNull();
    expect(departureDeltaMin('nope', '2026-11-01T00:00:00Z')).toBeNull();
  });
  test('late only beyond 15 min', () => {
    expect(isDepartLate(15)).toBe(false);
    expect(isDepartLate(16)).toBe(true);
    expect(isDepartLate(-30)).toBe(false);
    expect(isDepartLate(null)).toBe(false);
  });
});
