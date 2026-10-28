// signalNullWarehouseLines — the PURE half of the "say something" guard.
//
// A goods line written with warehouse_id NULL matches no allocation bucket, so
// it never leaves PENDING and never shows an incoming PO, while its goods may
// already be received into the right bucket. On 2026-08-18 that read to the
// operator as "the system did not capture the data", and three different write
// paths had produced 18 such lines since June — none of which said anything at
// the time, so two had to be attributed by comparing insert timestamps against
// audit rows and one still cannot be.
//
// What is tested here is the DISCRIMINATION, not the logging: it must fire on
// goods and stay silent on service lines (which hold no stock and are skipped
// by allocation by design), because a guard that cries on every delivery-fee
// line is one somebody turns off.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { signalNullWarehouseLines, NULL_WAREHOUSE_TAG } from '../src/scm/lib/null-warehouse-signal';

afterEach(() => vi.restoreAllMocks());
const hush = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('signalNullWarehouseLines', () => {
  it('flags a goods line with no warehouse', () => {
    hush();
    expect(signalNullWarehouseLines('POST /x', 'SO-1', [
      { itemCode: 'LOTTI-2A(RHF)', itemGroup: 'sofa', warehouseId: null },
    ])).toBe(1);
  });

  it('stays silent when every goods line has one', () => {
    const spy = hush();
    expect(signalNullWarehouseLines('POST /x', 'SO-1', [
      { itemCode: 'LOTTI-2A(RHF)', itemGroup: 'sofa', warehouseId: 'wh-1' },
    ])).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores SERVICE lines — they hold no stock and allocation skips them', () => {
    const spy = hush();
    expect(signalNullWarehouseLines('POST /x', 'SO-1', [
      { itemCode: 'SVC-DELIVERY', itemGroup: 'service', warehouseId: null },
      { itemCode: 'SVC-DISPOSE-MATTRESS', itemGroup: 'service', warehouseId: null },
    ])).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('counts only the offenders in a mixed batch', () => {
    hush();
    expect(signalNullWarehouseLines('POST /x', 'SO-1', [
      { itemCode: 'LOTTI-L(LHF)', itemGroup: 'sofa', warehouseId: 'wh-1' },
      { itemCode: 'LOTTI-2A(RHF)', itemGroup: 'sofa', warehouseId: null },
      { itemCode: 'SVC-DELIVERY', itemGroup: 'service', warehouseId: null },
    ])).toBe(1);
  });

  it('names the path, the document and the item — the fields attribution needed', () => {
    const spy = hush();
    signalNullWarehouseLines('PATCH /mfg-sales-orders/:docNo/items (sofa split)', '2990-SO-2607-028', [
      { itemCode: 'LOTTI-2A(RHF)', itemGroup: 'sofa', warehouseId: null },
    ]);
    const msg = String(spy.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain(NULL_WAREHOUSE_TAG);      // greppable, matches the sentinel's hint
    expect(msg).toContain('sofa split');            // WHICH path — the field that was missing
    expect(msg).toContain('2990-SO-2607-028');
    expect(msg).toContain('LOTTI-2A(RHF)');
  });

  it('treats an undefined warehouse the same as null', () => {
    hush();
    expect(signalNullWarehouseLines('POST /x', 'SO-1', [
      { itemCode: 'BARON-(K)', itemGroup: 'bedframe' },
    ])).toBe(1);
  });

  it('is inert on an empty batch', () => {
    const spy = hush();
    expect(signalNullWarehouseLines('POST /x', 'SO-1', [])).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
