import { describe, expect, test } from 'vitest';
import { planUncostedRetrocost, type RetroOutMovement, type RetroLot } from './oversell-retrocost';

const CUTOFF = '2026-08-01T00:00:00.000Z';
const lotSum = (lots: RetroLot[]) => lots.reduce((s, l) => s + l.qtyRemaining, 0);

describe('backfill reconciliation invariant — the MAKOTO divergent bucket', () => {
  test('driving fn_reconcile_uncosted_out over the diverged bucket re-converges both ledgers', () => {
    const movBalance = 3 + 2 - 1 - 1;
    const openLots: RetroLot[] = [
      { lotId: 'GRN-010', receivedAt: '2026-07-13T00:00:00.000Z', qtyRemaining: 2, unitCostSen: 53000 },
      { lotId: 'GRN-017', receivedAt: '2026-07-20T00:00:00.000Z', qtyRemaining: 2, unitCostSen: 54000 },
    ];
    expect(movBalance).toBe(3);
    expect(lotSum(openLots)).toBe(4);
    expect(lotSum(openLots)).not.toBe(movBalance);

    const uncostedOut: RetroOutMovement = {
      movementId: 'out-1222', doId: 'do-018', qty: 1,
      createdAt: '2026-07-23T12:22:00.000Z', isDropship: false, doStatus: 'SIGNED',
      alreadyConsumedQty: 0, alreadyCostedSen: 0,
    };

    const plan = planUncostedRetrocost([uncostedOut], openLots, CUTOFF);

    expect(plan.totalRetroQty).toBe(1);
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].retroQty).toBe(1);
    expect(plan.lines[0].retroCostSen).toBe(53000);
    expect(plan.lines[0].newTotalCostSen).toBe(53000);
    expect(plan.lines[0].stillShortQty).toBe(0);
    expect(plan.affectedDoIds).toEqual(['do-018']);

    expect(lotSum(plan.lotsAfter)).toBe(3);
    expect(lotSum(plan.lotsAfter)).toBe(movBalance);

    const consumedAtShip = 1;
    const totalConsumed = consumedAtShip + plan.totalRetroQty;
    const totalOutQty = 2;
    expect(totalConsumed).toBe(totalOutQty);
  });

  test('idempotent — re-running the backfill over the now-repaired bucket books nothing', () => {
    const repairedOut: RetroOutMovement = {
      movementId: 'out-1222', doId: 'do-018', qty: 1,
      createdAt: '2026-07-23T12:22:00.000Z', isDropship: false, doStatus: 'SIGNED',
      alreadyConsumedQty: 1, alreadyCostedSen: 53000,
    };
    const lotsNow: RetroLot[] = [
      { lotId: 'GRN-010', receivedAt: '2026-07-13T00:00:00.000Z', qtyRemaining: 1, unitCostSen: 53000 },
      { lotId: 'GRN-017', receivedAt: '2026-07-20T00:00:00.000Z', qtyRemaining: 2, unitCostSen: 54000 },
    ];
    const plan = planUncostedRetrocost([repairedOut], lotsNow, CUTOFF);
    expect(plan.totalRetroQty).toBe(0);
    expect(plan.lines).toHaveLength(0);
    expect(lotSum(plan.lotsAfter)).toBe(3);
  });

  test('a bucket with no covering open lots is left for a later receipt (partial / no repair)', () => {
    const uncostedOut: RetroOutMovement = {
      movementId: 'out-x', doId: 'do-x', qty: 2,
      createdAt: '2026-07-23T00:00:00.000Z', isDropship: false, doStatus: 'SIGNED',
      alreadyConsumedQty: 0, alreadyCostedSen: 0,
    };
    const plan = planUncostedRetrocost([uncostedOut], [], CUTOFF);
    expect(plan.totalRetroQty).toBe(0);
    expect(plan.lines).toHaveLength(0);
  });
});
