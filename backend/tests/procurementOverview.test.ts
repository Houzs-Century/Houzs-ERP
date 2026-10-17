/* Procurement Overview arithmetic (owner, 2026-10-16): the PO chasing sheet's
   four lateness buckets, the category mapping, and the lead-time suggestion. */
import { describe, expect, test } from 'vitest';
import {
  overdueBucket, procurementCategory, promisedDate, percentile, overdueMatrix, leadStats, suggestedLeadDays, type OpenLine,
} from '../src/scm/lib/procurement-overview';

const line = (o: Partial<OpenLine>): OpenLine => ({
  poId: 'p1', poNumber: 'PO-1', supplier: 'HOOKKA', category: 'BEDFRAME', itemCode: 'BF', itemDesc: null, location: 'KL', soDocNo: null,
  poDate: '2026-09-01', remainingQty: 2, unitPriceSen: 10000, originalDue: '2026-10-01', promised: '2026-10-01', revised: [], ...o,
});

describe('procurement overview', () => {
  test('the sheet buckets: late 5+, late 4 to due now, due in 2-7, due in 8+', () => {
    expect(overdueBucket(5)).toBe('late5');
    expect(overdueBucket(4)).toBe('late0to4');
    expect(overdueBucket(-1)).toBe('late0to4');
    expect(overdueBucket(-2)).toBe('due2to7');
    expect(overdueBucket(-7)).toBe('due2to7');
    expect(overdueBucket(-8)).toBe('due8plus');
  });

  test('category comes from the product master first, then the line item group', () => {
    expect(procurementCategory('MATTRESS', 'ACC')).toBe('MATTRESS');
    expect(procurementCategory(null, 'ACC')).toBe('ACCESSORY');
    expect(procurementCategory('BEDLINES', null)).toBe('ACCESSORY');
    expect(procurementCategory(null, 'Bed Frame')).toBe('BEDFRAME');
    expect(procurementCategory(null, 'DINING SET')).toBe('DINING');
    expect(procurementCategory(null, null)).toBe('OTHERS');
  });

  test('the promised date is the latest revised date', () => {
    expect(promisedDate(['2026-10-01', '2026-10-20', null, '2026-10-05'])).toBe('2026-10-20');
    expect(promisedDate([null, undefined])).toBeNull();
  });

  test('lateness against the first or the latest promised date', () => {
    const lines = [line({ promised: '2026-10-25', revised: ['2026-10-25'] }), line({ supplier: 'DIGLANT' })];
    const first = overdueMatrix(lines, '2026-10-16', 'supplier', 'original');
    const latest = overdueMatrix(lines, '2026-10-16', 'supplier', 'promised');
    expect(first.find((r) => r.key === 'HOOKKA')!.buckets.late5).toBe(1);
    expect(latest.find((r) => r.key === 'HOOKKA')!.buckets.due8plus).toBe(1);
    expect(first.find((r) => r.key === 'HOOKKA')!.remainingSen).toBe(20000);
  });

  test('lead time: 80th percentile, on time against the first promised date, suggestion', () => {
    expect(percentile([10, 20, 30, 40, 50], 0.8)).toBe(40);
    const receipts = Array.from({ length: 10 }, (_, i) => ({
      supplier: 'HOOKKA', category: 'BEDFRAME' as const, poDate: '2026-09-01', originalDue: '2026-09-20',
      receivedAt: i < 8 ? '2026-09-18' : '2026-10-10', qtyReceived: 10, qtyRejected: i === 0 ? 1 : 0,
    }));
    const [s] = leadStats(receipts, 'category');
    expect(s).toMatchObject({ receipts: 10, onTimePct: 80, rejectPct: 1, p80Days: 17 });
    expect(suggestedLeadDays(s!, 30).verdict).toBe('can_shorten');
    expect(suggestedLeadDays(s!, 10).verdict).toBe('too_short');
    expect(suggestedLeadDays({ ...s!, receipts: 3 }, 30).verdict).toBe('not_enough_data');
  });
});
