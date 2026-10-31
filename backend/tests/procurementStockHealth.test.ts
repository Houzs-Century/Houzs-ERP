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
