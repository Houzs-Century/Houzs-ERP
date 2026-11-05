import { describe, expect, test } from 'vitest';
import { breakdownWindows, downDays, type DownCase } from './lorry-down-days';

const bd = (over: Partial<DownCase>): DownCase => ({ lorry_id: 'L1', severity: 'MAJOR', status: 'IN_WORKSHOP', still_drivable: false, breakdown_start: null, occurred_at: '2026-11-03T08:49:00Z', recovery_time: null, ...over });

describe('breakdownWindows', () => {
  test('a lorry that cannot be driven is down until today, whatever the severity', () => {
    expect(breakdownWindows([bd({})], '2026-11-05')).toEqual([{ lorryId: 'L1', from: '2026-11-03', to: '2026-11-05' }]);
  });
  test('a still-drivable case takes no day, unless it is critical', () => {
    expect(breakdownWindows([bd({ still_drivable: true })], '2026-11-05')).toEqual([]);
    expect(breakdownWindows([bd({ still_drivable: true, severity: 'CRITICAL' })], '2026-11-05')).toHaveLength(1);
  });
  test('a recovered case stops on the day it recovered, in Malaysia time', () => {
    expect(breakdownWindows([bd({ status: 'RESOLVED', recovery_time: '2026-11-03T20:00:00Z' })], '2026-11-09')[0].to).toBe('2026-11-04');
  });
});

describe('downDays', () => {
  test('Sundays are off, overlaps count once, and the period clips the window', () => {
    const w = [{ lorryId: 'L1', from: '2026-10-30', to: '2026-11-03' }, { lorryId: 'L1', from: '2026-11-02', to: '2026-11-09' }];
    // 01/11/2026 is a Sunday; the period is 31/10 to 04/11.
    expect(downDays(w, '2026-10-31', '2026-11-04').get('L1')).toBe(4);
  });
});
