// Reading a counted paper sheet back (owner 2026-10-06) and moving goods to the
// counted rack at post. Both are pure here; the routes only do I/O.
import { describe, expect, test } from 'vitest';
import { matchSheetRows, normalizeSheetRows, normCode, resolveRack } from './stock-take-sheet';
import { planStockTakeRackMoves } from './stock-take-racks';

const LINES = [
  { id: 'a', item_code: 'AK-HP SL MOB MATT (Q) -2F', variant_label: null },
  { id: 'b1', item_code: '1025-(SS)', variant_label: 'fabriccode pc151-01' },
  { id: 'b2', item_code: '1025-(SS)', variant_label: 'fabriccode pc151-02' },
  { id: 'c', item_code: 'PILLOW', variant_label: null },
];
const RACKS = [{ id: 'r1', rack: 'Rack L5.1' }, { id: 'r2', rack: 'Rack R12.2' }];
const row = (over: Partial<{ no: number | null; itemCode: string | null; counted: number | null; rack: string | null; unclear: boolean }>) =>
  ({ no: null, itemCode: null, counted: null, rack: null, unclear: false, ...over });

describe('normalizing what the model read', () => {
  test('rows with nothing written are dropped; a non-integer count is no count, flagged unclear', () => {
    const rows = normalizeSheetRows({ rows: [
      { no: 1, itemCode: 'A', counted: 3, rack: null },
      { no: 2, itemCode: 'B', counted: null, rack: '' },
      { no: 3, itemCode: 'C', counted: 2.5, rack: 'L5.1' },
      { no: 4, itemCode: 'D', counted: '7', rack: null, unclear: true },
    ] });
    expect(rows).toEqual([
      { no: 1, itemCode: 'A', counted: 3, rack: null, unclear: false },
      { no: 3, itemCode: 'C', counted: null, rack: 'L5.1', unclear: true },
      { no: 4, itemCode: 'D', counted: 7, rack: null, unclear: true },
    ]);
    expect(normalizeSheetRows('garbage')).toEqual([]);
  });

  test('codes compare without case or spacing; rack labels without the word "Rack"', () => {
    expect(normCode('ak-hp  sl mob matt (q) -2f')).toBe(normCode('AK-HP SL MOB MATT (Q) -2F'));
    expect(resolveRack('l5.1', RACKS)).toBe('r1');
    expect(resolveRack('Rack R12.2', RACKS)).toBe('r2');
    expect(resolveRack('L9.9', RACKS)).toBeNull();
    expect(resolveRack(null, RACKS)).toBeNull();
  });
});

describe('matching rows to the take', () => {
  test('the printed # names the line when its code agrees; the rack resolves', () => {
    const { proposals, unmatched } = matchSheetRows([row({ no: 3, itemCode: '1025-(SS)', counted: 2, rack: 'L5.1' })], LINES, RACKS);
    expect(unmatched).toEqual([]);
    expect(proposals).toEqual([expect.objectContaining({ lineId: 'b2', counted: 2, rackId: 'r1' })]);
  });

  test('a # shifted by a later-added line falls back to a unique code', () => {
    const { proposals } = matchSheetRows([row({ no: 1, itemCode: 'PILLOW', counted: 4 })], LINES, RACKS);
    expect(proposals[0]!.lineId).toBe('c');
  });

  test('never guesses: a code on two variant lines with a wrong #, a code not on the sheet, a repeated line', () => {
    const { proposals, unmatched } = matchSheetRows([
      row({ no: 1, itemCode: '1025-(SS)', counted: 1 }),
      row({ no: 9, itemCode: 'NOT-HERE', counted: 1 }),
      row({ no: 4, itemCode: 'PILLOW', counted: 1 }),
      row({ no: 4, itemCode: 'PILLOW', counted: 2 }),
      row({ no: null, itemCode: null, counted: 5 }),
    ], LINES, RACKS);
    expect(proposals.map((p) => p.lineId)).toEqual(['c']);
    expect(unmatched.map((u) => u.reason)).toEqual(['ambiguous_code', 'not_on_sheet', 'duplicate_row', 'no_code']);
  });
});

describe('moving goods to the counted rack at post', () => {
  const existing = [
    { id: 'p1', rack_id: 'old', item_code: 'BED', product_name: 'Bed', qty: 3 },
    { id: 'p2', rack_id: 'old', item_code: 'MATT', product_name: 'Matt', qty: 2 },
  ];

  test('a code whose every counted line names a rack: old placements off, counted qty on, per variant', () => {
    const plan = planStockTakeRackMoves([
      { item_code: 'BED', variant_key: 'f=1', product_name: 'Bed', counted_qty: 2, rack_id: 'r1' },
      { item_code: 'BED', variant_key: 'f=2', product_name: 'Bed', counted_qty: 1, rack_id: 'r1' },
    ], existing);
    expect(plan.remove.map((p) => p.id)).toEqual(['p1']);
    expect(plan.place).toEqual([
      { rack_id: 'r1', variant_key: 'f=1', qty: 2, item_code: 'BED', product_name: 'Bed' },
      { rack_id: 'r1', variant_key: 'f=2', qty: 1, item_code: 'BED', product_name: 'Bed' },
    ]);
    expect(plan.skippedCodes).toEqual([]);
  });

  test('a code with a counted line WITHOUT a rack is left alone, and named', () => {
    const plan = planStockTakeRackMoves([
      { item_code: 'BED', variant_key: '', product_name: 'Bed', counted_qty: 2, rack_id: 'r1' },
      { item_code: 'BED', variant_key: 'x', product_name: 'Bed', counted_qty: 1, rack_id: null },
      { item_code: 'MATT', variant_key: '', product_name: 'Matt', counted_qty: 5, rack_id: null },
    ], existing);
    expect(plan.remove).toEqual([]);
    expect(plan.place).toEqual([]);
    expect(plan.skippedCodes).toEqual(['BED']);
  });

  test('a zero count names no placement', () => {
    const plan = planStockTakeRackMoves([
      { item_code: 'BED', variant_key: '', product_name: 'Bed', counted_qty: 0, rack_id: 'r1' },
    ], existing);
    expect(plan.place).toEqual([]);
    expect(plan.remove).toEqual([]);
  });
});
