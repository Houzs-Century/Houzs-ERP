import { describe, expect, test } from 'vitest';
import { groupByModel, type GroupableLine } from './stock-take-grouping';

const line = (over: Partial<GroupableLine> & Pick<GroupableLine, 'id' | 'itemCode'>): GroupableLine => ({
  productName: null,
  systemQty: 0,
  countedQtyInput: '',
  ...over,
});

describe('groupByModel', () => {
  test('collapses variant lines under one model header, preserving order', () => {
    const groups = groupByModel([
      line({ id: '1', itemCode: 'CODY', productName: 'Cody sofa', systemQty: 2, countedQtyInput: '2' }),
      line({ id: '2', itemCode: 'CODY', productName: 'Cody sofa', systemQty: 1 }),
      line({ id: '3', itemCode: 'BF-16', productName: 'Bedframe 16', systemQty: 4, countedQtyInput: '0' }),
      line({ id: '4', itemCode: 'CODY', productName: 'Cody sofa', systemQty: 0, countedQtyInput: '5' }),
    ]);
    expect(groups.map((g) => g.itemCode)).toEqual(['CODY', 'BF-16']);
    const cody = groups[0];
    expect(cody.lines.map((l) => l.id)).toEqual(['1', '2', '4']);
    expect(cody.systemTotal).toBe(3);
    expect(cody.countedTotal).toBe(7);
    expect(cody.countedLines).toBe(2);
    const bf = groups[1];
    expect(bf.lines).toHaveLength(1);
    expect(bf.countedLines).toBe(1); // an explicit '0' IS a count
    expect(bf.countedTotal).toBe(0);
  });

  test('a plain SKU is a one-line group — the header math still holds', () => {
    const [g] = groupByModel([
      line({ id: '1', itemCode: 'ACC-01', productName: 'Cushion', systemQty: 9 }),
    ]);
    expect(g.lines).toHaveLength(1);
    expect(g.systemTotal).toBe(9);
    expect(g.countedLines).toBe(0);
  });

  test('blind lines (systemQty null) null the WHOLE group total — no partial leak', () => {
    const [g] = groupByModel([
      line({ id: '1', itemCode: 'CODY', systemQty: 3 }),
      line({ id: '2', itemCode: 'CODY', systemQty: null }),
      line({ id: '3', itemCode: 'CODY', systemQty: 4 }),
    ]);
    expect(g.systemTotal).toBeNull();
    expect(g.lines).toHaveLength(3);
  });

  test('uncounted and garbage inputs contribute nothing to the counted total', () => {
    const [g] = groupByModel([
      line({ id: '1', itemCode: 'X', countedQtyInput: '' }),
      line({ id: '2', itemCode: 'X', countedQtyInput: 'abc' }),
      line({ id: '3', itemCode: 'X', countedQtyInput: '2.9' }), // floors to 2
    ]);
    expect(g.countedTotal).toBe(2);
    expect(g.countedLines).toBe(1);
  });

  test('a later line fills a missing product name on the header', () => {
    const [g] = groupByModel([
      line({ id: '1', itemCode: 'X', productName: null }),
      line({ id: '2', itemCode: 'X', productName: 'Late name' }),
    ]);
    expect(g.productName).toBe('Late name');
  });

  test('empty input folds to no groups', () => {
    expect(groupByModel([])).toEqual([]);
  });
});
