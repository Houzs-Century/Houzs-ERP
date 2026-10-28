import { describe, it, expect } from 'vitest';
import { estimateReadyDate, type ReadyDateItem } from './procurement-ready-date';
import { addCalendarDays, type LeadTimeBase, type LeadBuffers } from '../../scm/lib/lead-time';

// Owner's manual base table: a warehouse-specific sofa lead (5) overriding the
// global sofa (7); mattress 10.
const BASE: LeadTimeBase = {
  byWhCat: new Map([['WH1|sofa', 5]]),
  byCat: new Map([
    ['sofa', 7],
    ['mattress', 10],
  ]),
};
// Learned: SUP1 runs 3 days late; December is a 2-day-busy month.
const BUFFERS: LeadBuffers = { supplierBufferDays: { SUP1: 3 }, seasonBufferDays: { '12': 2 } };
const NONE: LeadBuffers = { supplierBufferDays: {}, seasonBufferDays: {} };

const ASOF = '2026-07-25';

describe('addCalendarDays', () => {
  it('pushes a date forward by whole days, inverse of subtract', () => {
    expect(addCalendarDays('2026-07-25', 7)).toBe('2026-08-01');
    expect(addCalendarDays('2026-07-25', 0)).toBe('2026-07-25'); // no-op
    expect(addCalendarDays(null, 7)).toBeNull();
  });
});

describe('estimateReadyDate — pure core', () => {
  it('base only: ready = asOf + base lead', () => {
    const r = estimateReadyDate(BASE, NONE, ASOF, [{ category: 'sofa', warehouseId: null }]);
    expect(r.perItem[0].leadDays).toEqual({ base: 7, supplier: 0, season: 0, total: 7 });
    expect(r.readyDate).toBe('2026-08-01');
    expect(r.leadDaysMax).toBe(7);
  });

  it('adds the learned supplier buffer', () => {
    const r = estimateReadyDate(BASE, BUFFERS, ASOF, [
      { category: 'sofa', warehouseId: null, supplierCode: 'SUP1' },
    ]);
    expect(r.perItem[0].leadDays.total).toBe(10); // 7 + 3
    expect(r.readyDate).toBe('2026-08-04');
  });

  it('adds the season buffer from the customer delivery month', () => {
    const r = estimateReadyDate(BASE, BUFFERS, ASOF, [
      { category: 'sofa', warehouseId: null, deliveryDate: '2026-12-20' },
    ]);
    expect(r.perItem[0].leadDays).toEqual({ base: 7, supplier: 0, season: 2, total: 9 });
  });

  it('stacks all three layers (base + supplier + season)', () => {
    const r = estimateReadyDate(BASE, BUFFERS, ASOF, [
      { category: 'sofa', warehouseId: null, supplierCode: 'SUP1', deliveryDate: '2026-12-01' },
    ]);
    expect(r.perItem[0].leadDays.total).toBe(12); // 7 + 3 + 2
    expect(r.readyDate).toBe('2026-08-06');
  });

  it('a warehouse-specific base overrides the global category lead', () => {
    const r = estimateReadyDate(BASE, NONE, ASOF, [{ category: 'sofa', warehouseId: 'WH1' }]);
    expect(r.perItem[0].leadDays.base).toBe(5);
  });

  it('the SET is ready only when its slowest line lands (latest per-item date)', () => {
    const items: ReadyDateItem[] = [
      { key: 'a', category: 'sofa', warehouseId: null }, // 7d
      { key: 'b', category: 'mattress', warehouseId: null }, // 10d -> critical path
    ];
    const r = estimateReadyDate(BASE, NONE, ASOF, items);
    expect(r.leadDaysMax).toBe(10);
    expect(r.readyDate).toBe('2026-08-04'); // asOf + 10
    expect(r.perItem.map((p) => p.key)).toEqual(['a', 'b']);
  });

  it('an unknown category contributes 0 lead — ready on asOf, never invented', () => {
    const r = estimateReadyDate(BASE, BUFFERS, ASOF, [{ category: 'widget', warehouseId: null }]);
    expect(r.perItem[0].leadDays.total).toBe(0);
    expect(r.readyDate).toBe(ASOF);
  });

  it('no items -> null ready date, zero critical path', () => {
    const r = estimateReadyDate(BASE, BUFFERS, ASOF, []);
    expect(r.readyDate).toBeNull();
    expect(r.leadDaysMax).toBe(0);
    expect(r.perItem).toEqual([]);
  });
});
