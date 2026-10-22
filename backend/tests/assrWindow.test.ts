/* Quality Overview period (owner, 2026-10-17): a date range when given, the
   older last-N-days otherwise. */
import { describe, expect, test } from 'vitest';
import { assrWindow } from '../src/routes/lib/assr-window';

describe('assr dashboard window', () => {
  test('a date range keeps both days and counts them', () => {
    const w = assrWindow({ from: '2026-10-01', to: '2026-10-17' });
    expect(w.days).toBe(17);
    expect(w.sql('closed_at')).toBe("closed_at >= '2026-10-01' AND closed_at < '2026-10-18'");
  });

  test('no range, or a bad one, falls back to since_days', () => {
    expect(assrWindow({ since_days: '30' }).sql('x')).toBe("x >= date('now', '-30 days')");
    expect(assrWindow({ from: "2026-10-01'; drop", to: '2026-10-17' }).days).toBe(90);
    expect(assrWindow({ from: '2026-10-17', to: '2026-10-01' }).from).toBeNull();
  });
});
