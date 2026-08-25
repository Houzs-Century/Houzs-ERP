// State-change warehouse rebind — which bound lines MOVE with the order and
// which BLOCK the change (lib/so-state-warehouse-rebind.ts).
//
// The 2026-07-22 ruling ('supplier 就会发错货给我') protects lines a live
// downstream PO/DO was cut against; the 2026-08-25 narrowing applies it
// literally, because the operator-store create default means every POS
// walk-in is born bound to a showroom and gets its address later — under the
// old blanket rule every one of those orders 409'd on the address fill.
import { describe, expect, it } from 'vitest';
import { planStateWarehouseRebind } from '../src/scm/lib/so-state-warehouse-rebind';

const KL = 'wh-kl';
const PJ_SHOWROOM = 'wh-pj-showroom';

describe('planStateWarehouseRebind', () => {
  it('store-bound lines with no downstream doc move with the order (the POS address-fill flow)', () => {
    const plan = planStateWarehouseRebind(KL, [
      { id: 'l1', itemCode: 'BOOQIT-1B(LHF)', warehouseId: PJ_SHOWROOM, anchored: false },
      { id: 'l2', itemCode: 'BOOQIT-CNR', warehouseId: PJ_SHOWROOM, anchored: false },
    ]);
    expect(plan.offenders).toEqual([]);
    expect(plan.rebindLineIds).toEqual(['l1', 'l2']);
  });

  it('a line with a live PO/DO still blocks the change, named as the offender', () => {
    const plan = planStateWarehouseRebind(KL, [
      { id: 'l1', itemCode: 'XAMMAR-2A(RHF)', warehouseId: PJ_SHOWROOM, anchored: true },
    ]);
    expect(plan.offenders).toEqual([
      { id: 'l1', itemCode: 'XAMMAR-2A(RHF)', currentWarehouseId: PJ_SHOWROOM },
    ]);
    expect(plan.rebindLineIds).toEqual([]);
  });

  it('mixed: ONE anchored line blocks the WHOLE change — nothing half-moves', () => {
    const plan = planStateWarehouseRebind(KL, [
      { id: 'l1', itemCode: 'XAMMAR-2A(RHF)', warehouseId: PJ_SHOWROOM, anchored: true },
      { id: 'l2', itemCode: 'XAMMAR-1A(LHF)', warehouseId: PJ_SHOWROOM, anchored: false },
    ]);
    expect(plan.offenders.map((o) => o.id)).toEqual(['l1']);
    expect(plan.rebindLineIds).toEqual([]);
  });

  it('NULL-warehouse and already-matching lines are never conflicts', () => {
    // NULL lines rebind unconditionally inside the CAS (the pre-0327 clause);
    // matching lines have nothing to move.
    const plan = planStateWarehouseRebind(KL, [
      { id: 'l1', itemCode: 'A', warehouseId: null, anchored: true },
      { id: 'l2', itemCode: 'B', warehouseId: KL, anchored: true },
    ]);
    expect(plan.offenders).toEqual([]);
    expect(plan.rebindLineIds).toEqual([]);
  });

  it('an unreadable anchor lookup fails CLOSED — the caller maps null to anchored=true', () => {
    // The route treats `anchors === null` as every line anchored; this pins
    // that the plan then blocks, i.e. the old blanket behaviour.
    const plan = planStateWarehouseRebind(KL, [
      { id: 'l1', itemCode: 'A', warehouseId: PJ_SHOWROOM, anchored: true },
      { id: 'l2', itemCode: 'B', warehouseId: PJ_SHOWROOM, anchored: true },
    ]);
    expect(plan.offenders).toHaveLength(2);
    expect(plan.rebindLineIds).toEqual([]);
  });

  it('no rebound warehouse (unmapped state) → no plan at all', () => {
    expect(planStateWarehouseRebind(null, [
      { id: 'l1', itemCode: 'A', warehouseId: PJ_SHOWROOM, anchored: false },
    ])).toEqual({ offenders: [], rebindLineIds: [] });
  });
});
