// Tests for the R3 write-path guard: force a real unit cost onto a POSITIVE
// ADJUSTMENT / STOCK_TAKE so the FIFO trigger never opens a permanent RM0 lot
// (docs/inventory-costing-integrity-audit.md R3; detector check-costless-stock.mjs).
//
// The trigger firing on real Postgres is NOT exercised here (the vitest pool binds
// no PG — same limitation as fifo-out-consume / stock-transfer-atomic). These cover
// the PURE decision the callers feed the trigger: the weighted-avg derivation, the
// last-known fallback, consignment exclusion, and the no-priced-lot 422 path.
import { describe, expect, test } from 'vitest';
import {
  weightedAvgOpenCostSen,
  lastKnownCostSen,
  resolveForcedUnitCostSen,
  type LotCostRow,
} from './adjustment-cost';

const lot = (
  unit_cost_sen: number | null,
  qty_remaining: number | null,
  source_doc_type: string | null = 'GRN',
  received_at = '2026-07-13T00:00:00.000Z',
): LotCostRow => ({ unit_cost_sen, qty_remaining, source_doc_type, received_at });

describe('weightedAvgOpenCostSen — refAvgCost basis (Sigma qty*cost / Sigma qty)', () => {
  test('averages priced open lots, weighted by remaining qty', () => {
    // 2 @ RM5.30 + 3 @ RM5.40 = (2*530 + 3*540) / 5 = 2680 / 5 = 536
    expect(weightedAvgOpenCostSen([lot(530, 2), lot(540, 3)])).toBe(536);
  });

  test('rounds to integer sen', () => {
    // (1*100 + 1*101) / 2 = 100.5 -> 101 (Math.round)
    expect(weightedAvgOpenCostSen([lot(100, 1), lot(101, 1)])).toBe(101);
  });

  test('ignores lots with no remaining qty and non-positive cost', () => {
    expect(weightedAvgOpenCostSen([lot(530, 0), lot(0, 5), lot(600, 4)])).toBe(600);
  });

  test('returns null when NO priced open lot exists (the genuine RM0 case)', () => {
    expect(weightedAvgOpenCostSen([])).toBeNull();
    expect(weightedAvgOpenCostSen([lot(0, 5), lot(530, 0)])).toBeNull();
  });

  test('EXCLUDES consignment (PC_RECEIVE) lots from the average', () => {
    // Only the RM6.00 owned lot counts; the supplier-owned PC_RECEIVE lot is out.
    expect(weightedAvgOpenCostSen([lot(600, 4), lot(9999, 10, 'PC_RECEIVE')])).toBe(600);
    // With ONLY a consignment priced lot, there is no owned basis -> null.
    expect(weightedAvgOpenCostSen([lot(9999, 10, 'PC_RECEIVE')])).toBeNull();
  });
});

describe('lastKnownCostSen — heal the all-consumed SKU', () => {
  test('picks the most-recently received priced lot regardless of remaining qty', () => {
    const rows = [
      lot(500, 0, 'GRN', '2026-01-01T00:00:00.000Z'),
      lot(700, 0, 'GRN', '2026-06-01T00:00:00.000Z'), // newest priced, fully consumed
      lot(600, 0, 'GRN', '2026-03-01T00:00:00.000Z'),
    ];
    expect(lastKnownCostSen(rows)).toBe(700);
  });

  test('excludes consignment and non-priced lots; null when never priced', () => {
    expect(lastKnownCostSen([lot(9999, 0, 'PC_RECEIVE', '2026-06-01T00:00:00.000Z')])).toBeNull();
    expect(lastKnownCostSen([lot(0, 0), lot(null, 0)])).toBeNull();
  });
});

describe('resolveForcedUnitCostSen — never returns 0', () => {
  test('SKU with priced open lots -> carries the weighted avg', () => {
    const r = resolveForcedUnitCostSen({ lots: [lot(530, 2), lot(540, 3)] });
    expect(r).toEqual({ ok: true, unitCostSen: 536, basis: 'weighted-avg' });
  });

  test('operator-entered positive cost is honoured over any derived basis', () => {
    const r = resolveForcedUnitCostSen({ operatorCostSen: 1234, lots: [lot(530, 2)] });
    expect(r).toEqual({ ok: true, unitCostSen: 1234, basis: 'operator' });
  });

  test('operator cost of 0 / blank does NOT count as entered — falls through to derivation', () => {
    expect(resolveForcedUnitCostSen({ operatorCostSen: 0, lots: [lot(600, 4)] }))
      .toEqual({ ok: true, unitCostSen: 600, basis: 'weighted-avg' });
    expect(resolveForcedUnitCostSen({ operatorCostSen: null, lots: [lot(600, 4)] }))
      .toEqual({ ok: true, unitCostSen: 600, basis: 'weighted-avg' });
  });

  test('no open priced lot but a consumed priced lot exists -> last-known', () => {
    const r = resolveForcedUnitCostSen({
      lots: [lot(0, 0), lot(720, 0, 'GRN', '2026-05-01T00:00:00.000Z')],
    });
    expect(r).toEqual({ ok: true, unitCostSen: 720, basis: 'last-known' });
  });

  test('genuine RM0 case (no priced lot anywhere, no operator cost) -> 422 cost_required', () => {
    expect(resolveForcedUnitCostSen({ lots: [] }))
      .toEqual({ ok: false, reason: 'cost_required' });
    expect(resolveForcedUnitCostSen({ lots: [lot(0, 5)] }))
      .toEqual({ ok: false, reason: 'cost_required' });
  });

  test('consignment-only stock does NOT satisfy the basis -> 422 (owned cost still unknown)', () => {
    const r = resolveForcedUnitCostSen({ lots: [lot(9999, 10, 'PC_RECEIVE')] });
    expect(r).toEqual({ ok: false, reason: 'cost_required' });
  });
});
