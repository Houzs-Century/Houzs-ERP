// The pure half of check-hard-bound-cost-vs-lot.mjs, on the shape of the
// 2026-11-10 cutover no-spec repair: a company-1 bedframe line bound to its own
// PO, costed by the uncosted-OUT reconcile from a cutover layer of another PO.
import { describe, expect, test } from 'vitest';
import {
  parseAcDoc, originCandidates, lotPos, classifyLine, expectedUnitCost, costRatio, sameCost, parseDocNos,
} from '../scripts/lib/hard-bound-cost-check.mjs';
import { isHardBoundLine } from '../src/scm/lib/so-stock-allocation.ts';
import { redactMoney } from '../scripts/lib/public-log-redact.mjs';

describe('parseAcDoc', () => {
  test('reads the AutoCount document a cutover layer was relayered from', () => {
    expect(parseAcDoc('AC GR GR-004679 2026-05-28')).toEqual({ src: 'GR', doc: 'GR-004679' });
    expect(parseAcDoc('AC PI PI-000123 2026-04-01')).toEqual({ src: 'PI', doc: 'PI-000123' });
  });
  test('a layer with no receipt history and other notes name no document', () => {
    expect(parseAcDoc('AC layer uncovered (no receipt history)')).toBeNull();
    expect(parseAcDoc('Cutover no-spec stock moved to the shipped spec')).toBeNull();
    expect(parseAcDoc(null)).toBeNull();
  });
});

describe('originCandidates', () => {
  const minted = { warehouseId: 'kl', itemCode: 'CODY-(K)', refDocNo: 'CUTOVER-NOSPEC-2026-11-10', qtyReceived: 1, unitCostSen: 50000, receivedUs: '1748390400000001' };
  const src = (over) => ({ warehouseId: 'kl', itemCode: 'CODY-(K)', refDocNo: 'CUTOVER-NOSPEC-2026-11-10', qtyConsumed: 1, unitCostSen: 50000, receivedUs: '1748390400000000', lotId: 'L1', ...over });
  test('pairs the repair lot with the source lot it copied (+i microseconds)', () => {
    expect(originCandidates(minted, [src()]).map((c) => c.lotId)).toEqual(['L1']);
  });
  test('refuses a different cost, qty, item, warehouse, repair document or time', () => {
    expect(originCandidates(minted, [
      src({ lotId: 'cost', unitCostSen: 49999 }),
      src({ lotId: 'qty', qtyConsumed: 2 }),
      src({ lotId: 'item', itemCode: 'CODY-(Q)' }),
      src({ lotId: 'wh', warehouseId: 'pg' }),
      src({ lotId: 'ref', refDocNo: 'CUTOVER-NOSPEC-2026-11-11' }),
      src({ lotId: 'later', receivedUs: '1748390400000002' }),
      src({ lotId: 'far', receivedUs: '1748390399999000' }),
    ])).toEqual([]);
  });
});

describe('lotPos', () => {
  const poByGrnId = new Map([['grn-1', 'HC-PO-2609-187']]);
  const poByAcDoc = new Map([['GR-004679', ['HC-PO-009812']]]);
  test('a GRN lot names its batch, else its GRN header PO', () => {
    expect(lotPos({ sourceDocType: 'GRN', batchNo: 'HC-PO-2610-010', sourceDocId: 'grn-1' }, poByGrnId, poByAcDoc)).toEqual(['HC-PO-2609-187', 'HC-PO-2610-010']);
    expect(lotPos({ sourceDocType: 'GRN', batchNo: null, sourceDocId: 'grn-1' }, poByGrnId, poByAcDoc)).toEqual(['HC-PO-2609-187']);
  });
  test('a cutover layer names the PO of the migrated GRN mirroring its AC document', () => {
    expect(lotPos({ sourceDocType: 'AC_CUTOVER', movementNotes: 'AC GR GR-004679 2026-05-28' }, poByGrnId, poByAcDoc)).toEqual(['HC-PO-009812']);
    expect(lotPos({ sourceDocType: 'AC_CUTOVER', movementNotes: 'AC layer uncovered (no receipt history)' }, poByGrnId, poByAcDoc)).toEqual([]);
  });
  test('a stock-take adjustment names no PO', () => {
    expect(lotPos({ sourceDocType: 'ADJUSTMENT', sourceDocNo: 'ST-1' }, poByGrnId, poByAcDoc)).toEqual([]);
  });
});

describe('classifyLine', () => {
  const bound = ['HC-PO-2610-010'];
  test('a pooled line has no binding to check', () => {
    expect(classifyLine({ hardBound: false, boundPoNos: bound, costing: [{ qty: 1, pos: ['X'] }] }).verdict).toBe('pooled-fifo');
  });
  test('match, partial, mismatch, unknown', () => {
    expect(classifyLine({ hardBound: true, boundPoNos: bound, costing: [{ qty: 2, pos: bound }] }).verdict).toBe('match');
    expect(classifyLine({ hardBound: true, boundPoNos: bound, costing: [{ qty: 1, pos: bound }, { qty: 1, pos: ['HC-PO-009812'] }] }))
      .toEqual({ verdict: 'partial', matchQty: 1, otherQty: 1, unknownQty: 0 });
    expect(classifyLine({ hardBound: true, boundPoNos: bound, costing: [{ qty: 1, pos: ['HC-PO-009812'] }] }).verdict).toBe('mismatch');
    expect(classifyLine({ hardBound: true, boundPoNos: bound, costing: [{ qty: 1, pos: [] }] }).verdict).toBe('lot-po-unknown');
  });
  test('no bound PO, or nothing consumed', () => {
    expect(classifyLine({ hardBound: true, boundPoNos: [], costing: [{ qty: 1, pos: ['X'] }] }).verdict).toBe('no-bound-po');
    expect(classifyLine({ hardBound: true, boundPoNos: bound, costing: [] }).verdict).toBe('uncosted');
  });
  test('uses the allocator predicate: company-1 bedframe and (SP) mattress bind, a plain mattress pools', () => {
    expect(isHardBoundLine('bedframe', 'CODY-(K)')).toBe(true);
    expect(isHardBoundLine('mattress', 'ORTHO (SP)')).toBe(true);
    expect(isHardBoundLine('mattress', 'ORTHO')).toBe(false);
  });
});

describe('expectedUnitCost and costRatio', () => {
  test('the bound GRN lot wins, then the cutover layer, then the PO price; zero prices are skipped', () => {
    expect(expectedUnitCost({ grnLots: [{ qty: 1, unitCostSen: 0 }], cutoverLayers: [{ qty: 2, unitCostSen: 300 }], poLines: [{ qty: 1, unitCostSen: 999 }] }))
      .toEqual({ source: 'cutover-layer', unitSen: 300 });
    expect(expectedUnitCost({ grnLots: [{ qty: 1, unitCostSen: 100 }, { qty: 3, unitCostSen: 200 }], cutoverLayers: [], poLines: [] }))
      .toEqual({ source: 'grn-lot', unitSen: 175 });
    expect(expectedUnitCost({ grnLots: [], cutoverLayers: [], poLines: [] })).toEqual({ source: 'none', unitSen: null });
  });
  test('ratio is a one-decimal percentage and survives the public-log guard; amounts do not', () => {
    expect(costRatio(1700, 2, 1000)).toBe('85.0%');
    expect(costRatio(0, 0, 1000)).toBe('-');
    expect(costRatio(100, 1, null)).toBe('-');
    expect(sameCost('100.2%')).toBe(true);
    expect(sameCost('85.0%')).toBe(false);
    expect(sameCost('-')).toBeNull();
    expect(redactMoney('ratio actual/expected 85.0% (grn-lot)')).toBe('ratio actual/expected 85.0% (grn-lot)');
  });
});

test('parseDocNos keeps document numbers only', () => {
  expect(parseDocNos("hc-do-2609-204, HC-DO-2610-001 x';drop HC-DO-2609-204")).toEqual(['HC-DO-2609-204', 'HC-DO-2610-001']);
});
