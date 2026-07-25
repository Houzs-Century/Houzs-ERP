// Reconciliation-invariant tests for the HISTORICAL backfill
// (backend/scripts/backfill-fifo-divergence.mjs).
//
// The script does NOT re-implement FIFO — it drives the audited, idempotent DB
// function scm.fn_reconcile_uncosted_out (migration 0154) across every divergent
// bucket. That function's pure, in-memory mirror is planUncostedRetrocost (already
// exercised by oversell-retrocost.test.ts, kept in lockstep with the SQL). These
// tests reconstruct the MAKOTO divergent bucket and prove that driving that
// reconcile over it restores the two ledger invariants the backfill guarantees:
//
//     Σ(inventory_movements, signed)  ==  Σ(inventory_lots.qty_remaining)
//     Σ(OUT qty)                      ==  Σ(inventory_lot_consumptions.qty_consumed)
//
// plus the idempotency the safety story depends on (a second pass is a no-op).
import { describe, expect, test } from 'vitest';
import { planUncostedRetrocost, type RetroOutMovement, type RetroLot } from './oversell-retrocost';

const CUTOFF = '2026-08-01T00:00:00.000Z'; // "now" — after every historical OUT
const lotSum = (lots: RetroLot[]) => lots.reduce((s, l) => s + l.qtyRemaining, 0);

describe('backfill reconciliation invariant — the MAKOTO divergent bucket', () => {
  test('driving fn_reconcile_uncosted_out over the diverged bucket re-converges both ledgers', () => {
    // The as-diverged MAKOTO state (pre-repair):
    //   Movements: IN +3 (GRN-010), IN +2 (GRN-017), OUT -1 (11:47, costed),
    //              OUT -1 (12:22, UNCOSTED — the false short discarded pre-0195).
    //   -> signed movement balance = 3 + 2 - 1 - 1 = 3
    //   Lots: GRN-010 2 remaining, GRN-017 2 remaining -> lot sum = 4
    //   COGS: 1 consumption (the 11:47 OUT). The 12:22 OUT consumed nothing.
    // The two ledgers disagree: balance 3 vs lot sum 4, and Σ OUT qty 2 vs Σ
    // consumed 1. The uncosted OUT is a prior, non-cancelled, non-drop-ship DO OUT.
    const movBalance = 3 + 2 - 1 - 1;
    const openLots: RetroLot[] = [
      { lotId: 'GRN-010', receivedAt: '2026-07-13T00:00:00.000Z', qtyRemaining: 2, unitCostSen: 53000 },
      { lotId: 'GRN-017', receivedAt: '2026-07-20T00:00:00.000Z', qtyRemaining: 2, unitCostSen: 54000 },
    ];
    expect(movBalance).toBe(3);
    expect(lotSum(openLots)).toBe(4);
    expect(lotSum(openLots)).not.toBe(movBalance); // the divergence to repair

    // The uncosted 12:22 OUT: qty 1, nothing consumed yet, RM0 booked.
    const uncostedOut: RetroOutMovement = {
      movementId: 'out-1222', doId: 'do-018', qty: 1,
      createdAt: '2026-07-23T12:22:00.000Z', isDropship: false, doStatus: 'SIGNED',
      alreadyConsumedQty: 0, alreadyCostedSen: 0,
    };

    const plan = planUncostedRetrocost([uncostedOut], openLots, CUTOFF);

    // It retro-costs the 1 short unit from the oldest open lot (GRN-010 @ RM530).
    expect(plan.totalRetroQty).toBe(1);
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].retroQty).toBe(1);
    expect(plan.lines[0].retroCostSen).toBe(53000);
    expect(plan.lines[0].newTotalCostSen).toBe(53000);
    expect(plan.lines[0].stillShortQty).toBe(0);
    expect(plan.affectedDoIds).toEqual(['do-018']);

    // INVARIANT 1: after the repair the lot sum drops to 3 and equals the balance.
    expect(lotSum(plan.lotsAfter)).toBe(3);
    expect(lotSum(plan.lotsAfter)).toBe(movBalance);

    // INVARIANT 2: Σ OUT qty (2) now equals Σ consumed (1 at ship + 1 retro).
    const consumedAtShip = 1;
    const totalConsumed = consumedAtShip + plan.totalRetroQty;
    const totalOutQty = 2;
    expect(totalConsumed).toBe(totalOutQty);
  });

  test('idempotent — re-running the backfill over the now-repaired bucket books nothing', () => {
    // Post-repair state fed back in: the 12:22 OUT now shows 1 consumed, and
    // GRN-010 sits decremented at 1.
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
    expect(plan.totalRetroQty).toBe(0);       // nothing left to cost
    expect(plan.lines).toHaveLength(0);
    expect(lotSum(plan.lotsAfter)).toBe(3);   // lots untouched on the second pass
  });

  test('a bucket with no covering open lots is left for a later receipt (partial / no repair)', () => {
    // Divergence exists but the SKU has zero open stock now — the backfill reports
    // the residual and changes nothing; it catches up on the next receipt.
    const uncostedOut: RetroOutMovement = {
      movementId: 'out-x', doId: 'do-x', qty: 2,
      createdAt: '2026-07-23T00:00:00.000Z', isDropship: false, doStatus: 'SIGNED',
      alreadyConsumedQty: 0, alreadyCostedSen: 0,
    };
    const plan = planUncostedRetrocost([uncostedOut], [], CUTOFF);
    expect(plan.totalRetroQty).toBe(0);
    expect(plan.lines).toHaveLength(0);        // no fabricated cost
  });
});
