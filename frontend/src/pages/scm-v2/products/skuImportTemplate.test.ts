// 2990-0025: the template is only worth handing out if Import SKUs reads back
// every column it writes, so these tests fill it the way a person would and
// push it through the importer's own parser.
import { describe, expect, test } from 'vitest';
import { buildSkuImportRows, gridToSkuRecords } from '../products-import-headers';
import { savedSummary, skuTemplateColumns, skuTemplateSheets } from './skuImportTemplate';

const SIZES = ['24', '26', '28'];

const headerRow = (): string[] => {
  const [skus] = skuTemplateSheets(skuTemplateColumns(SIZES));
  return (skus[0] ?? []).map((c) => String((c as { value: string }).value));
};

describe('the SKU import template', () => {
  test('sheet 1 holds the header row alone, so no example row can be imported', () => {
    const [skus] = skuTemplateSheets(skuTemplateColumns(SIZES));
    expect(skus).toHaveLength(1);
    expect(headerRow()).toEqual([
      'code', 'name', 'category', 'description', 'base_model', 'size_label', 'branding', 'status',
      'base_price', 'price1', 'price_tier', 'price_24', 'price_26', 'price_28',
    ]);
  });

  test('a filled bedframe row imports with every column it carries', () => {
    const grid = [headerRow(), ['BF-NEW-Q', 'NEW BEDFRAME QUEEN', 'Bedframe', 'Solid wood', 'BF-NEW', 'Queen', '', 'active', '1,535.00', '1200', '', '', '', '']];
    const { rows, tierErrors } = buildSkuImportRows(gridToSkuRecords(grid), SIZES);
    expect(tierErrors).toEqual([]);
    expect(rows).toEqual([{
      code: 'BF-NEW-Q', name: 'NEW BEDFRAME QUEEN', category: 'Bedframe', description: 'Solid wood',
      base_model: 'BF-NEW', size_label: 'Queen', status: 'ACTIVE', base_price_sen: 153500, price1_sen: 120000,
    }]);
  });

  test('a sofa repeated per tier becomes one SKU carrying both tiers', () => {
    const grid = [
      headerRow(),
      ['SF-NEW-2S', 'NEW SOFA 2S', 'Sofa', '', 'SF-NEW', '', '', '', '', '', 'P1', '1000', '1100', ''],
      ['SF-NEW-2S', 'NEW SOFA 2S', 'Sofa', '', 'SF-NEW', '', '', '', '', '', 'P2', '900', '', ''],
    ];
    const { rows } = buildSkuImportRows(gridToSkuRecords(grid), SIZES);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seatHeightPrices).toEqual([
      { height: '24', priceSen: 100000, tier: 'PRICE_1' },
      { height: '26', priceSen: 110000, tier: 'PRICE_1' },
      { height: '24', priceSen: 90000, tier: 'PRICE_2' },
    ]);
  });

  test('the guide sheet explains every column of sheet 1', () => {
    const cols = skuTemplateColumns(SIZES);
    const [, guide] = skuTemplateSheets(cols);
    const explained = guide.slice(1, 1 + cols.length).map((r) => (r[0] as { value: string }).value);
    expect(explained).toEqual(headerRow());
  });
});

describe('savedSummary', () => {
  test('splits new codes from edited ones', () => {
    expect(savedSummary({ upserted: 5, created: 2 })).toBe('2 new SKUs · 3 SKUs updated');
    expect(savedSummary({ upserted: 1, created: 1 })).toBe('1 new SKU');
  });

  test('an API without `created` reads as all updated, as it did before', () => {
    expect(savedSummary({ upserted: 4 })).toBe('4 SKUs updated');
  });
});
