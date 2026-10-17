/* Quality Overview summary (owner, 2026-10-17): opened / closed / ongoing,
   the backlog, stage time, and supplier defect rates over a trailing year. */
import { describe, expect, test } from 'vitest';
import { qualityOverview, type QCase } from '../src/routes/lib/assr-quality';

const c = (o: Partial<QCase>): QCase => ({ id: 1, stage: 'pending_solution', openedAt: '2026-10-05', closedAt: null, creditor: null, ...o });

describe('assr quality overview', () => {
  test('opened, closed and ongoing; a completed case with no close date is not open', () => {
    const r = qualityOverview([
      c({ id: 1 }),
      c({ id: 2, stage: 'completed', openedAt: '2026-09-20', closedAt: '2026-10-08' }),
      c({ id: 3, stage: 'completed', openedAt: '2026-01-02', closedAt: null }),
      c({ id: 4, stage: 'voided', openedAt: '2026-10-06' }),
    ], new Map(), [], [], '2026-10-01', '2026-10-17', '2026-10-17', '2025-10-18', new Map());
    expect(r).toMatchObject({ opened: 1, closed: 1, ongoingNow: 1, openedStillOpen: 1, avgResolutionDays: 18 });
    expect(r.trend.at(-1)).toMatchObject({ month: '2026-10', opened: 1, closed: 1, backlog: 1 });
    expect(r.trend.at(-2)).toMatchObject({ month: '2026-09', backlog: 1 });
  });

  test('stage days over the closed cases; supplier rates per item and per order line', () => {
    const r = qualityOverview([
      c({ id: 1, stage: 'completed', openedAt: '2026-10-01', closedAt: '2026-10-11', creditor: '400-A' }),
      c({ id: 2, openedAt: '2026-06-01', creditor: '400-A' }),
    ], new Map([[1, 3], [2, 2]]), [
      { caseId: 1, stage: 'pending_solution', enteredAt: '2026-10-01', exitedAt: '2026-10-04' },
      { caseId: 1, stage: 'pending_delivery_service', enteredAt: '2026-10-04', exitedAt: '2026-10-11' },
    ], [{ creditor: '400-A', name: 'A SDN BHD', qty: 100, lines: 40 }], '2026-10-01', '2026-10-17', '2026-10-17', '2025-10-18', new Map([['400-A', 'A Sofa']]));
    expect(r.stageDays).toEqual({ pending_solution: 3, pending_delivery_service: 7 });
    expect(r.suppliers[0]).toMatchObject({ name: 'A Sofa', cases: 2, items: 5, perItemPct: 5, perOrderPct: 5, open: 1, closed: 1, avgResolutionDays: 10 });
  });
});
