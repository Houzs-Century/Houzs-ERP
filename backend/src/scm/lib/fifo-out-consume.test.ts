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
    const lots = [
      lot('GRN-010', 2, 53000, 'PO_A', '2026-07-13T00:00:00.000Z'),
      lot('GRN-017', 2, 54000, 'PO_B', '2026-07-20T00:00:00.000Z'),
    ];
    const r = planOutConsume(1, 'PO_DRIFT', lots);

    expect(r.usedFallback).toBe(true);
    expect(r.qtyShort).toBe(0);
    expect(r.qtyConsumed).toBe(1);
    expect(r.totalCostSen).toBe(53000);
    expect(r.unitCostSen).toBe(53000);

    expect(lotSum(r.lotsAfter)).toBe(3);
    const byId = Object.fromEntries(r.lotsAfter.map((l) => [l.lotId, l.qtyRemaining]));
    expect(byId['GRN-010']).toBe(1);
    expect(byId['GRN-017']).toBe(2);
  });

  test('reconciliation invariant across the full MAKOTO DO: Σ OUT qty == Σ consumed, balance == lot sum', () => {
    const opening: OutLot[] = [
      lot('GRN-010', 3, 53000, 'PO_A', '2026-07-13T00:00:00.000Z'),
      lot('GRN-017', 2, 54000, 'PO_B', '2026-07-20T00:00:00.000Z'),
    ];
    const receivedQty = 5;

    const ship1 = planOutConsume(1, 'PO_A', opening);
    const ship2 = planOutConsume(1, 'PO_DRIFT', ship1.lotsAfter);

    const totalOutQty = 1 + 1;
    const totalConsumed = ship1.qtyConsumed + ship2.qtyConsumed;
    expect(totalConsumed).toBe(totalOutQty);

    const balance = receivedQty - totalOutQty;
    expect(lotSum(ship2.lotsAfter)).toBe(balance);
    expect(ship1.usedFallback).toBe(false);
    expect(ship2.usedFallback).toBe(true);
  });

  test('fallback spans lots when the shorted qty exceeds the oldest lot', () => {
    const lots = [
      lot('GRN-010', 2, 53000, 'PO_A', '2026-07-13T00:00:00.000Z'),
      lot('GRN-017', 2, 54000, 'PO_B', '2026-07-20T00:00:00.000Z'),
    ];
    const r = planOutConsume(3, 'PO_DRIFT', lots);
    expect(r.usedFallback).toBe(true);
    expect(r.qtyConsumed).toBe(3);
    expect(r.qtyShort).toBe(0);
    expect(r.totalCostSen).toBe(2 * 53000 + 1 * 54000);
    expect(lotSum(r.lotsAfter)).toBe(1);
  });

  test('partial batch match: exact batch covers some, fallback covers the residual', () => {
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
    expect(r.usedFallback).toBe(false);
    expect(r.qtyConsumed).toBe(3);
    expect(r.qtyShort).toBe(0);
    expect(r.totalCostSen).toBe(3 * 53000);
    const byId = Object.fromEntries(r.lotsAfter.map((l) => [l.lotId, l.qtyRemaining]));
    expect(byId['GRN-010']).toBe(2);
    expect(byId['GRN-017']).toBe(5);
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
    const r = planOutConsume(4, 'PO_A', []);
    expect(r.qtyConsumed).toBe(0);
    expect(r.qtyShort).toBe(4);
    expect(r.totalCostSen).toBe(0);
  });

  test('a real oversell (some stock, not enough) costs what is present and shorts the rest', () => {
    const lots = [lot('L1', 2, 50000, null)];
    const r = planOutConsume(5, 'PO_A', lots);
    expect(r.usedFallback).toBe(true);
    expect(r.qtyConsumed).toBe(2);
    expect(r.qtyShort).toBe(3);
    expect(r.totalCostSen).toBe(2 * 50000);
    expect(lotSum(r.lotsAfter)).toBe(0);
  });
});
