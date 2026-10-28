// Tests for the FIFO trigger's OUT-branch consume AFTER the ledger-divergence fix
// (migration 0195). The actual consume runs in PL/pgSQL and cannot run under this
// repo's vitest harness (same limitation as oversell-retrocost / stock-transfer-
// atomic); planOutConsume is the pure, in-memory mirror the SQL is written against.
//
// The scenarios prove exactly what the fix must hold:
//   1. A sofa DO-edit delta OUT whose batch drifted from its open lots now MATCHES
//      via the plain-FIFO fallback, costs correctly, and decrements the lot — the
//      two ledgers reconcile (Σ movements == Σ lot qty, Σ OUT qty == Σ consumed).
//   2. A correctly-matched OUT is byte-identical to before (no fallback, same cost).
//   3. An OUT that genuinely cannot match (no stock at all) is NEVER silently
//      dropped: it returns qtyShort > 0, left for the 0154 retro-cost path.
import { describe, expect, test } from 'vitest';
import { planOutConsume, type OutLot } from './fifo-out-consume';

const lot = (
  lotId: string,
  qtyRemaining: number,
  unitCostSen: number,
  batchNo: string | null,
  receivedAt = '2026-07-13T00:00:00.000Z',
): OutLot => ({ lotId, receivedAt, qtyRemaining, unitCostSen, batchNo });

const lotSum = (lots: OutLot[]) => lots.reduce((s, l) => s + l.qtyRemaining, 0);

describe('planOutConsume — MAKOTO false-short (the divergence the fix closes)', () => {
  test('sofa delta OUT whose batch matches NO open lot falls back to plain FIFO, costs + decrements', () => {
    // MAKOTO RC(S)-FVI BRONZE, KL. After the first ship, 4 units are on hand:
    // GRN-010 lot (2 @ RM530, batch PO_A) + GRN-017 lot (2 @ RM540, batch PO_B).
    // The resync delta OUT of 1 carries the allocator's batch PO_DRIFT, which
    // string-equals NEITHER open lot's batch. Pre-0195 this shorted the whole
    // unit and DISCARDED it: 0 consumed, 0 cost, lots untouched — permanent 3-vs-4
    // divergence. Post-0195 the plain-FIFO fallback consumes the oldest lot.
    const lots = [
      lot('GRN-010', 2, 53000, 'PO_A', '2026-07-13T00:00:00.000Z'),
      lot('GRN-017', 2, 54000, 'PO_B', '2026-07-20T00:00:00.000Z'),
    ];
    const r = planOutConsume(1, 'PO_DRIFT', lots);

    expect(r.usedFallback).toBe(true);
    expect(r.qtyShort).toBe(0);                 // no longer a false short
    expect(r.qtyConsumed).toBe(1);
    expect(r.totalCostSen).toBe(53000);         // oldest lot (GRN-010) @ RM530
    expect(r.unitCostSen).toBe(53000);

    // Ledger reconciliation: the lot the OUT drew from is decremented, so the
    // movement ledger (this OUT of 1) and the FIFO ledger agree going forward.
    expect(lotSum(r.lotsAfter)).toBe(3);        // 4 on hand − 1 consumed
    const byId = Object.fromEntries(r.lotsAfter.map((l) => [l.lotId, l.qtyRemaining]));
    expect(byId['GRN-010']).toBe(1);            // oldest consumed first
    expect(byId['GRN-017']).toBe(2);            // newer lot untouched
  });

  test('reconciliation invariant across the full MAKOTO DO: Σ OUT qty == Σ consumed, balance == lot sum', () => {
    // Two OUTs on the DO. First ship (batch PO_A, matches GRN-010). Resync delta
    // (batch PO_DRIFT, matches nothing → fallback). Received: 5 units total.
    const opening: OutLot[] = [
      lot('GRN-010', 3, 53000, 'PO_A', '2026-07-13T00:00:00.000Z'),
      lot('GRN-017', 2, 54000, 'PO_B', '2026-07-20T00:00:00.000Z'),
    ];
    const receivedQty = 5;

    const ship1 = planOutConsume(1, 'PO_A', opening);       // exact-batch match
    const ship2 = planOutConsume(1, 'PO_DRIFT', ship1.lotsAfter); // fallback

    const totalOutQty = 1 + 1;
    const totalConsumed = ship1.qtyConsumed + ship2.qtyConsumed;
    expect(totalConsumed).toBe(totalOutQty);                 // Σ OUT qty == Σ consumed

    // Signed movement balance = IN − OUT = 5 − 2 = 3; lot sum after both ships = 3.
    const balance = receivedQty - totalOutQty;
    expect(lotSum(ship2.lotsAfter)).toBe(balance);           // ledgers reconcile at 3
    expect(ship1.usedFallback).toBe(false);
    expect(ship2.usedFallback).toBe(true);
  });

  test('fallback spans lots when the shorted qty exceeds the oldest lot', () => {
    const lots = [
      lot('GRN-010', 2, 53000, 'PO_A', '2026-07-13T00:00:00.000Z'),
      lot('GRN-017', 2, 54000, 'PO_B', '2026-07-20T00:00:00.000Z'),
    ];
    const r = planOutConsume(3, 'PO_DRIFT', lots); // batch matches nothing → 3 via plain FIFO
    expect(r.usedFallback).toBe(true);
    expect(r.qtyConsumed).toBe(3);
    expect(r.qtyShort).toBe(0);
    expect(r.totalCostSen).toBe(2 * 53000 + 1 * 54000); // 2 from GRN-010, 1 from GRN-017
    expect(lotSum(r.lotsAfter)).toBe(1);
  });

  test('partial batch match: exact batch covers some, fallback covers the residual', () => {
    // Batch PO_A has only 1 unit left; the OUT needs 2. Batch pass takes 1 @530,
    // fallback takes 1 more from the next lot @540.
    const lots = [
      lot('GRN-010', 1, 53000, 'PO_A', '2026-07-13T00:00:00.000Z'),
      lot('GRN-017', 3, 54000, 'PO_B', '2026-07-20T00:00:00.000Z'),
    ];
    const r = planOutConsume(2, 'PO_A', lots);
    expect(r.usedFallback).toBe(true);
    expect(r.qtyConsumed).toBe(2);
    expect(r.qtyShort).toBe(0);
    expect(r.totalCostSen).toBe(53000 + 54000);
  });
});

describe('planOutConsume — correctly-matched OUTs are UNCHANGED', () => {
  test('exact-batch consume that fully matches never runs the fallback', () => {
    const lots = [
      lot('GRN-010', 5, 53000, 'PO_A'),
      lot('GRN-017', 5, 54000, 'PO_B'),
    ];
    const r = planOutConsume(3, 'PO_A', lots);
    expect(r.usedFallback).toBe(false);          // batch satisfied it entirely
    expect(r.qtyConsumed).toBe(3);
    expect(r.qtyShort).toBe(0);
    expect(r.totalCostSen).toBe(3 * 53000);      // strictly from the matched batch
    const byId = Object.fromEntries(r.lotsAfter.map((l) => [l.lotId, l.qtyRemaining]));
    expect(byId['GRN-010']).toBe(2);
    expect(byId['GRN-017']).toBe(5);             // other batch untouched
  });

  test('plain un-batched OUT is unchanged (no batch → straight plain FIFO)', () => {
    const lots = [
      lot('L1', 4, 10000, null, '2026-07-10T00:00:00.000Z'),
      lot('L2', 4, 11000, null, '2026-07-12T00:00:00.000Z'),
    ];
    const r = planOutConsume(6, null, lots);
    expect(r.usedFallback).toBe(false);
    expect(r.qtyConsumed).toBe(6);
    expect(r.qtyShort).toBe(0);
    expect(r.totalCostSen).toBe(4 * 10000 + 2 * 11000);
    expect(lotSum(r.lotsAfter)).toBe(2);
  });
});

describe('planOutConsume — a GENUINE short is never silently dropped', () => {
  test('no open stock at all: qtyShort reflects the whole qty, left for 0154 retro-cost', () => {
    const r = planOutConsume(4, 'PO_A', []); // batch AND fallback find nothing
    expect(r.qtyConsumed).toBe(0);
    expect(r.qtyShort).toBe(4);               // surfaced, not discarded
    expect(r.totalCostSen).toBe(0);
  });

  test('a real oversell (some stock, not enough) costs what is present and shorts the rest', () => {
    const lots = [lot('L1', 2, 50000, null)];
    const r = planOutConsume(5, 'PO_A', lots); // batch miss → fallback eats the 2 present
    expect(r.usedFallback).toBe(true);
    expect(r.qtyConsumed).toBe(2);
    expect(r.qtyShort).toBe(3);                // genuine shortfall — retro-cost later
    expect(r.totalCostSen).toBe(2 * 50000);
    expect(lotSum(r.lotsAfter)).toBe(0);
  });
});
