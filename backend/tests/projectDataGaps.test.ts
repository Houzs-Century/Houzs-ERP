/* Project data gaps (owner, 2026-10-17): a finished event missing its sales,
   COGS or commission line, and the Sales Orders that size what is missing. */
import { describe, expect, test } from 'vitest';
import { classifyProjectGaps, type GapProject } from '../src/scm/lib/project-data-gaps';

const p = (o: Partial<GapProject>): GapProject => ({
  id: 1, code: 'P1', name: 'Fair', brand: 'AKEMI', end_date: '2026-09-20', income: 0, cogs: 0, commission: 0, cost: 0, soSen: 0, ...o,
});

describe('project data gaps', () => {
  test('no sales, no COGS and no commission are told apart', () => {
    const r = classifyProjectGaps([
      p({ id: 1, cost: 20000, soSen: 5_000_000 }),
      p({ id: 2, income: 80000, commission: 4000 }),
      p({ id: 3, income: 50000, cogs: 20000 }),
      p({ id: 4, income: 90000, cogs: 40000, commission: 5000, end_date: '2026-08-10' }),
    ]);
    expect(r.ended).toBe(4);
    expect(r.noSales).toMatchObject({ count: 1, costBooked: 20000, soSen: 5_000_000 });
    expect(r.noCogs.rows.map((x) => x.id)).toEqual([2]);
    expect(r.noCommission.rows.map((x) => x.id)).toEqual([3]);
    expect(r.byMonth).toEqual([{ month: '2026-08', ended: 1, withSales: 1 }, { month: '2026-09', ended: 3, withSales: 2 }]);
  });

  test('events without sales are listed biggest missing first', () => {
    const r = classifyProjectGaps([p({ id: 1, soSen: 100 }), p({ id: 2, soSen: 900 }), p({ id: 3, soSen: 0, cost: 50 })]);
    expect(r.noSales.rows.map((x) => x.id)).toEqual([2, 1, 3]);
  });
});
