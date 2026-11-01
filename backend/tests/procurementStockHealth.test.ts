import { describe, expect, test } from 'vitest';
import { forPage } from '../src/scm/routes/procurement-overview';

/* Owner 2026-10-31: the dead / buffer lists showed 40 of 717 rows. The cached
   report now holds every row; the page gets the first 50 plus the totals, and
   GET /stock-health serves the rest. */
describe('procurement overview page payload', () => {
  test('keeps 50 dead and buffer rows and says how many there are', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));
    const out = forPage({ deadStock: { top: rows(717), bufferTop: rows(185), deadSkus: 717 } }) as { deadStock: Record<string, unknown> };
    expect((out.deadStock.top as unknown[]).length).toBe(50);
    expect((out.deadStock.bufferTop as unknown[]).length).toBe(50);
    expect(out.deadStock).toMatchObject({ topCount: 717, bufferCount: 185, deadSkus: 717 });
  });
});

describe('supplier score window (owner 2026-11-01)', () => {
  test('the cron warms the same 90 days the page asks for: today minus 89 days, to today', async () => {
    const { scoreWindowFrom, procurementOverviewParams } = await import('../src/scm/routes/procurement-overview');
    expect(scoreWindowFrom('2026-11-01')).toBe('2026-08-04');
    const p = procurementOverviewParams((k) => (k === 'from' ? scoreWindowFrom('2026-11-01') : k === 'to' || k === 'dueTo' ? '2026-11-01' : undefined), '2026-11-01');
    expect([p.from, p.to, p.dueTo]).toEqual(['2026-08-04', '2026-11-01', '2026-11-01']);
  });
});
