/* A delivery order with no Sales Order (2990-PO-2610-019, KABBIN): the set ships
 * straight from stock when ONE batch in the warehouse holds all of it. */
import { describe, expect, test } from 'vitest';
import { oneBatchCovers } from './sofa-batch-guard';
import { sofaStockKey } from './sofa-set-coverage';

const LEG = 'fabriccode=brownie-01|seatheight=28|legheight=default';
const picks = [
  { itemCode: 'KABBIN-2A(LHF)', variantKey: LEG, qty: 1 },
  { itemCode: 'KABBIN-L(RHF)', variantKey: LEG, qty: 1 },
];
const stockOf = (rows: Array<[string, string, string, number]>) => ({
  remaining: new Map(rows.map(([wh, batch, code, qty]) => [sofaStockKey(wh, batch, code, LEG), qty])),
  batches: new Set(rows.map((r) => r[1])),
});

describe('a sofa set picked straight from stock', () => {
  test('ships when one batch in the warehouse holds the whole set', () => {
    const stock = stockOf([['KL', 'B1', 'KABBIN-2A(LHF)', 1], ['KL', 'B1', 'KABBIN-L(RHF)', 1]]);
    expect(oneBatchCovers(picks, 'KL', stock, ['KL'])).toBe(true);
  });
  test('stays refused when the pieces sit in two batches', () => {
    const stock = stockOf([['KL', 'B1', 'KABBIN-2A(LHF)', 1], ['KL', 'B2', 'KABBIN-L(RHF)', 1]]);
    expect(oneBatchCovers(picks, 'KL', stock, ['KL'])).toBe(false);
  });
  test('stays refused when the batch stands in another warehouse', () => {
    const stock = stockOf([['PG', 'B1', 'KABBIN-2A(LHF)', 1], ['PG', 'B1', 'KABBIN-L(RHF)', 1]]);
    expect(oneBatchCovers(picks, 'KL', stock, ['PG'])).toBe(false);
  });
  test('no warehouse keyed: any one warehouse holding the whole set will do', () => {
    const stock = stockOf([['PG', 'B1', 'KABBIN-2A(LHF)', 1], ['PG', 'B1', 'KABBIN-L(RHF)', 1]]);
    expect(oneBatchCovers(picks, null, stock, ['KL', 'PG'])).toBe(true);
  });
  test('two lines of one piece add up against the batch', () => {
    const stock = stockOf([['KL', 'B1', 'KABBIN-2A(LHF)', 1]]);
    expect(oneBatchCovers([picks[0]!, picks[0]!], 'KL', stock, ['KL'])).toBe(false);
  });
});
