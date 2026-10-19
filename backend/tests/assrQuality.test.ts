/* Quality Overview summary (owner, 2026-10-17): opened / closed / ongoing, the
   backlog, average to close over the cases opened in the period, stage time
   over stages finished in it, the overdue list, and supplier rates against
   goods received in the same period. */
import { describe, expect, test } from 'vitest';
import { qualityOverview, type QCase } from '../src/routes/lib/assr-quality';

const c = (o: Partial<QCase>): QCase => ({ id: 1, stage: 'pending_solution', openedAt: '2026-10-05', closedAt: null, creditor: null, assrNo: null, customer: null, ...o });

describe('assr quality overview', () => {
  test('opened, closed and ongoing; average to close over the last 30 days and per month', () => {
    const r = qualityOverview([
      c({ id: 1 }),
      c({ id: 2, stage: 'completed', openedAt: '2026-09-20', closedAt: '2026-10-08' }),
      c({ id: 3, stage: 'completed', openedAt: '2026-01-02', closedAt: null }),
      c({ id: 4, stage: 'voided', openedAt: '2026-10-06' }),
      c({ id: 5, stage: 'completed', openedAt: '2026-10-02', closedAt: '2026-10-06' }),
    ], new Map(), [], [], '2026-10-01', '2026-10-17', '2026-10-17', new Map());
    /* Last 30 days: case 2 (18 days) and case 5 (4 days) closed in them. */
    expect(r).toMatchObject({ opened: 2, closed: 2, ongoingNow: 1, openedStillOpen: 1, avgDaysToClose: 11, avgDaysToCloseCases: 2, avgDaysToClosePrev30: null });
    expect(r.trend.at(-1)).toMatchObject({ month: '2026-10', opened: 2, closed: 2, backlog: 1, avgDaysToClose: 11 });
    expect(r.trend.at(-2)).toMatchObject({ month: '2026-09', backlog: 1 });
    /* The drill-down list: opened in the period, open now, or closed in the last 30 days; never the voided one. */
    expect(r.caseList.map((x) => x.id).sort()).toEqual([1, 2, 5]);
  });

  test('stage days over stages finished in the last 30 days; overdue against target days; supplier rate per item received', () => {
    const r = qualityOverview([
      c({ id: 1, stage: 'completed', openedAt: '2026-10-01', closedAt: '2026-10-11', creditor: '400-A' }),
      c({ id: 2, openedAt: '2026-10-03', creditor: '400-A', assrNo: 'ASSR-2', customer: 'Tan' }),
    ], new Map([[1, 3], [2, 2]]), [
      { caseId: 1, stage: 'pending_solution', enteredAt: '2026-10-01', exitedAt: '2026-10-04', targetDays: 3 },
      { caseId: 1, stage: 'pending_delivery_service', enteredAt: '2026-10-04', exitedAt: '2026-10-11', targetDays: 5 },
      { caseId: 1, stage: 'pending_review', enteredAt: '2026-09-01', exitedAt: '2026-09-10', targetDays: 2 },
      { caseId: 2, stage: 'pending_solution', enteredAt: '2026-10-07', exitedAt: null, targetDays: 3 },
    ], [{ creditor: '400-A', name: 'A SDN BHD', month: '2026-10', qty: 60, lines: 20 }, { creditor: '400-A', name: 'A SDN BHD', month: '2026-10', qty: 40, lines: 20 }], '2026-10-01', '2026-10-17', '2026-10-17', new Map([['400-A', 'A Sofa']]));
    expect(r.stageDays).toEqual({ pending_solution: { avgDays: 3, cases: 1 }, pending_delivery_service: { avgDays: 7, cases: 1 } });
    expect(r.overdue).toEqual([expect.objectContaining({ id: 2, assrNo: 'ASSR-2', customer: 'Tan', supplier: 'A Sofa', stage: 'pending_solution', daysInStage: 10, daysOver: 7, caseAgeDays: 14 })]);
    expect(r.suppliers[0]).toMatchObject({ name: 'A Sofa', receivedQty: 100, cases: 2, items: 5, ratePct: 5, open: 1, overdue: 1, closed: 1, avgDaysToClose: 10 });
    expect(r.suppliers[0]?.months).toEqual([{ month: '2026-10', receivedQty: 100, items: 5, ratePct: 5 }]);
  });
});
