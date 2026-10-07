import { describe, expect, it } from 'vitest';
import {
  linesFromBody,
  parseAdjustmentLines,
  bucketDeltas,
  bucketKeyOf,
  writtenOffUnitCostSen,
} from './stock-adjustment-doc';

const row = (item_code: string, qty: number, variant_key = '', batch_no: string | null = null) =>
  ({ item_code, qty, variant_key, batch_no });

describe('linesFromBody', () => {
  it('reads the document shape', () => {
    expect(linesFromBody({ lines: [{ itemCode: 'A', qty: 1 }] })).toEqual([{ itemCode: 'A', qty: 1 }]);
  });
  it('still accepts the pre-document single-row body as one line', () => {
    const lines = linesFromBody({ warehouseId: 'w', itemCode: 'A', qtyDelta: -2, reasonCode: 'DAMAGE' });
    expect(lines).toHaveLength(1);
    expect((lines![0] as { qty: number }).qty).toBe(-2);
  });
  it('is null when neither shape is present', () => {
    expect(linesFromBody({ warehouseId: 'w' })).toBeNull();
  });
});

describe('parseAdjustmentLines', () => {
  it('refuses an empty document, a zero / fractional qty and a missing reason', () => {
    expect(parseAdjustmentLines([]).ok).toBe(false);
    expect(parseAdjustmentLines([{ itemCode: 'A', qty: 0, reasonCode: 'DAMAGE' }])).toMatchObject({ ok: false, error: 'invalid_qty_delta' });
    expect(parseAdjustmentLines([{ itemCode: 'A', qty: 1.5, reasonCode: 'DAMAGE' }])).toMatchObject({ ok: false, error: 'invalid_qty_delta' });
    expect(parseAdjustmentLines([{ itemCode: 'A', qty: -1, reasonCode: '' }])).toMatchObject({ ok: false, error: 'reason_required' });
  });

  it('numbers lines in order and keeps an explicit variant key on both signs', () => {
    const r = parseAdjustmentLines([
      { itemCode: 'A', qty: -3, reasonCode: 'DAMAGE', variantKey: 'v1', batchNo: ' B1 ' },
      { itemCode: 'B', qty: 2, reasonCode: 'DAMAGE', variantKey: 'legacy-key' },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines.map((l) => [l.line_no, l.item_code, l.variant_key, l.batch_no])).toEqual([
      [1, 'A', 'v1', 'B1'],
      [2, 'B', 'legacy-key', null],
    ]);
  });

  it('flags a sofa increase without a batch, but leaves the decision to the caller', () => {
    const r = parseAdjustmentLines([{ itemCode: 'S-1', qty: 1, reasonCode: 'DAMAGE', itemGroup: 'sofa', variants: {} }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lines[0]!.increase_errors.length).toBeGreaterThan(0);
  });
});

describe('bucketDeltas — what an edit moves', () => {
  it('a new document moves every line (create)', () => {
    const d = bucketDeltas([], [row('A', -3), row('B', 5)]);
    expect(d.map((x) => [x.bucket.item_code, x.delta])).toEqual([['A', -3], ['B', 5]]);
  });

  it('only the difference: -3 edited to -12 takes out 9 more', () => {
    const d = bucketDeltas([row('A', -3)], [row('A', -12)]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ oldNet: -3, newNet: -12, delta: -9 });
  });

  it('removing a found-stock line takes that stock back out', () => {
    const d = bucketDeltas([row('A', 5)], []);
    expect(d[0]).toMatchObject({ oldNet: 5, newNet: 0, delta: -5 });
  });

  it('an unchanged bucket gets no movement, even when the ledger holds an earlier edit', () => {
    // created -3, edited to -5 (a -2 correction), now only the notes change
    expect(bucketDeltas([row('A', -3), row('A', -2)], [row('A', -5)])).toEqual([]);
  });

  it('a different batch or variant is a different bucket', () => {
    const d = bucketDeltas([row('A', -2, 'v', 'B1')], [row('A', -2, 'v', 'B2')]);
    expect(d.map((x) => [x.bucket.batch_no, x.delta])).toEqual([['B2', -2], ['B1', 2]]);
  });

  it('a null batch and an empty one are the same bucket', () => {
    expect(bucketKeyOf(row('A', 1, '', null))).toBe(bucketKeyOf({ item_code: 'A', variant_key: null, batch_no: null }));
  });
});

describe('writtenOffUnitCostSen', () => {
  it('averages what the document wrote the bucket off at, by qty', () => {
    const moved = [
      { ...row('A', -1), unit_cost_sen: 1000 },
      { ...row('A', -3), unit_cost_sen: 2000 },
      { ...row('A', 4), unit_cost_sen: 9999 },
      { ...row('B', -1), unit_cost_sen: 5 },
    ];
    expect(writtenOffUnitCostSen(moved, bucketKeyOf(row('A', 0)))).toBe(1750);
    expect(writtenOffUnitCostSen(moved, bucketKeyOf(row('C', 0)))).toBe(0);
  });
});
