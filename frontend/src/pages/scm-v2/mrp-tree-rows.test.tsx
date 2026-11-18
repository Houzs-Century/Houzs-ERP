import { describe, expect, test } from 'vitest';
import type { MrpLine, MrpSku } from '../../vendor/scm/lib/mrp-queries';
import type { ModelGroup } from './mrp-model-pipeline';
import { buildMrpChildRows, rollupLabel, supplierRollup, type MrpTreeOptions } from './mrp-tree-rows';

const HOOKKA = { supplierId: 's-hookka', code: 'HK', name: 'HOOKKA INDUSTRIES', isMain: true };
const NB = { supplierId: 's-nb', code: 'NB', name: 'NB FURNITURE', isMain: false };

const line = (overrides: Partial<MrpLine>): MrpLine => ({
  soItemId: 'item-1', soDocNo: 'HC-SO-007195', debtorName: 'lim ching Yee', customerState: 'Selangor',
  soDate: '2025-07-09', deliveryDate: '2027-02-27', processingDate: '2027-01-02', orderByDate: null,
  qty: 1, source: 'shortage', poNumber: null, poEta: null, shortageQty: 1,
  poSupplierId: null, poSupplierName: null,
  ...overrides,
});

const sku = (itemCode: string, lines: MrpLine[], overrides: Partial<MrpSku> = {}): MrpSku => ({
  warehouseId: 'W1', warehouseCode: 'KL WAREHOUSE', warehouseName: 'KL WAREHOUSE',
  itemCode, variantKey: '', variantLabel: itemCode, description: null, category: 'SOFA',
  qtyNeeded: 1, stock: 0, poOutstanding: 0, shortage: 1,
  mainSupplierCode: 'HK', mainSupplierName: HOOKKA.name, suppliers: [HOOKKA, NB],
  lines,
  ...overrides,
});

const group = (variants: MrpSku[]): ModelGroup => ({
  groupKey: 'W1|HC-SO-007195', warehouseId: 'W1', warehouseCode: 'KL WAREHOUSE', warehouseName: 'KL WAREHOUSE',
  itemCode: 'HC-SO-007195', description: null, category: 'SOFA', variants,
  qtyNeeded: 0, stock: 0, poOutstanding: 0, shortage: 0,
});

const options = (overrides: Partial<MrpTreeOptions>): MrpTreeOptions => ({
  selected: new Set(), onToggleLine: () => undefined, onSetLinesSelected: () => undefined,
  lineSupplier: {}, onLineSupplierChange: () => undefined,
  shape: 'sofa', expandedVariants: new Set(), onToggleVariant: () => undefined,
  isEveryVariantOpen: false, accessoryRiders: [], poMode: 'combined',
  ...overrides,
});

const filledKeys = (cells: Partial<Record<string, unknown>>): string[] =>
  Object.entries(cells).filter(([, value]) => value != null).map(([key]) => key).sort();

describe('buildMrpChildRows — the lines under an MRP row, in its columns', () => {
  test('a sofa SO: one row per module, SO-header facts left to the parent row', () => {
    const sofaSo = group([
      sku('5562-1A(LHF)', [line({ soItemId: 'a' })]),
      sku('BC05-MF', [line({ soItemId: 'b', qty: 2, shortageQty: 2 })]),
    ]);

    const rows = buildMrpChildRows(sofaSo, options({ shape: 'sofa' }));

    expect(rows).toHaveLength(2);
    expect(filledKeys(rows[0]?.cells ?? {})).toEqual(
      ['deliveryDate', 'description', 'processingDate', 'qtyNeeded', 'select', 'shortage', 'supplier'],
    );
  });

  test('a model pooling two orders shows each line its own SO no and customer', () => {
    const pooled = group([sku('BF-QUEEN', [
      line({ soItemId: 'a' }),
      line({ soItemId: 'b', soDocNo: 'HC-SO-007200', debtorName: 'Tan', soDate: '2025-07-10' }),
    ])]);

    const rows = buildMrpChildRows(pooled, options({ shape: 'model' }));

    expect(rows.map((row) => filledKeys(row.cells))).toEqual([
      expect.arrayContaining(['soNo', 'customer', 'soDate']),
      expect.arrayContaining(['soNo', 'customer', 'soDate']),
    ]);
    expect(rows[0]?.cells.state).toBeNull();
  });

  test('a multi-variant model lists variant rows, and an open variant its lines beneath it', () => {
    const queen = sku('BF-Q', [line({ soItemId: 'q' })], { variantKey: '|grey', variantLabel: 'Grey' });
    const king = sku('BF-Q', [line({ soItemId: 'k' })], { variantKey: '|blue', variantLabel: 'Blue' });
    const model = group([queen, king]);

    const closed = buildMrpChildRows(model, options({ shape: 'model' }));
    const greyOpen = buildMrpChildRows(model, options({ shape: 'model', expandedVariants: new Set(['W1|BF-Q|grey']) }));

    expect(closed.map((row) => row.key)).toEqual(['variant|W1|BF-Q|grey', 'variant|W1|BF-Q|blue']);
    expect(greyOpen.map((row) => row.key)).toEqual(['variant|W1|BF-Q|grey', 'W1|BF-Q|grey|q|0', 'variant|W1|BF-Q|blue']);
  });

  test('cover / pillow riders follow the sofa lines behind a caption', () => {
    const coverLine = line({ soItemId: 'c' });
    const cover = sku('COVER-01', [coverLine], { category: 'ACCESSORY' });
    const rows = buildMrpChildRows(
      group([sku('5562-1A(LHF)', [line({ soItemId: 'a' })])]),
      options({ shape: 'sofa', accessoryRiders: [{ sku: cover, line: coverLine }] }),
    );

    expect(rows.map((row) => row.key)).toEqual([expect.any(String), 'accessory-caption', 'accessory|COVER-01|c|0']);
    expect(rows[1]?.caption).toBeTruthy();
  });
});

describe('parent-row rollups', () => {
  test('one value reads as itself, several as the first plus a count, none as empty', () => {
    expect(rollupLabel(['lim ching Yee'])).toBe('lim ching Yee');
    expect(rollupLabel(['lim ching Yee', 'Tan', 'Lee'])).toBe('lim ching Yee +2');
    expect(rollupLabel([])).toBeNull();
  });

  test('supplier rollup follows each shortage line\'s chosen supplier', () => {
    const so = group([sku('A', [line({ soItemId: 'a' })]), sku('B', [line({ soItemId: 'b' })])]);

    expect(supplierRollup(so, options({}))).toBe('HOOKKA INDUSTRIES');
    expect(supplierRollup(so, options({ lineSupplier: { b: NB.supplierId } }))).toBe('2 suppliers');
  });
});
