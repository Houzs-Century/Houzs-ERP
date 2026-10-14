// HC-0003: a file the SKU table exports must import back unchanged.
// The bedframe and mattress views wrote "Product Code" and prices in sen, and
// the importer answered "No rows had a code". This test exports through the
// same CSV path DataTable uses, then imports through the dialog's own parser.
import { describe, expect, test } from 'vitest';
import { toCSV } from '../../lib/csv';
import type { Column } from '../../components/DataTable';
import type { MfgProductRow } from '../../vendor/scm/lib/mfg-products-queries';
import { buildSkuImportRows, parseSkuCsv, withSkuImportHeaders } from './products-import-headers';

type Row = Partial<MfgProductRow> & { code: string };
const col = (key: string, label: string, getValue: (r: Row) => string | number | null | undefined): Column<Row> =>
  ({ key, label, getValue, render: () => null });

/** DataTable.handleExport's CSV branch, plus the BOM downloadCSV adds. */
function exportCsv(rows: Row[], cols: Column<Row>[]): string {
  const csvCols = cols.map((c) => ({
    key: c.key,
    label: c.exportLabel || c.label || c.key,
    getValue: (r: Row) => (c.exportValue ? c.exportValue(r) : c.getValue!(r)),
  }));
  return '﻿' + toCSV(rows, csvCols);
}

const SIZES = ['24', '26'];

describe('the SKU table export imports back', () => {
  test('bedframe view: code found, prices come back to the sen', () => {
    const cols = withSkuImportHeaders([
      col('code', 'Product Code', (r) => r.code),
      col('desc', 'Description', (r) => r.name),
      col('category', 'Category', (r) => r.category),
      col('size', 'Size', (r) => r.size_label),
      col('price2', 'Price 2', (r) => r.base_price_sen ?? -1),
      col('price1', 'Price 1', (r) => r.price1_sen ?? -1),
      col('barcode', 'Barcode', (r) => r.barcode),
      col('status', 'Status', (r) => r.status),
    ]);
    const csv = exportCsv([
      { code: 'BF-1', name: 'Hilton', category: 'BEDFRAME', size_label: 'Queen', base_price_sen: 153550, price1_sen: 120000, status: 'ACTIVE' },
      { code: 'BF-2', name: 'Kara', category: 'BEDFRAME', size_label: 'King', base_price_sen: 99900, price1_sen: null, status: 'ACTIVE' },
    ], cols);
    expect(csv).toContain('1535.50');
    expect(csv).not.toContain('153550');

    const { rows, tierErrors } = buildSkuImportRows(parseSkuCsv(csv), SIZES);
    expect(tierErrors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ code: 'BF-1', name: 'Hilton', category: 'BEDFRAME', base_price_sen: 153550, price1_sen: 120000 });
    expect(rows[1]).toMatchObject({ code: 'BF-2', base_price_sen: 99900 });
    expect(rows[1]).not.toHaveProperty('price1_sen');
  });

  test('mattress view: the single Price column is the base price', () => {
    const cols = withSkuImportHeaders([
      col('code', 'Product Code', (r) => r.code),
      col('desc', 'Description', (r) => r.name),
      col('branding', 'Branding', (r) => r.branding),
      col('size', 'Size', (r) => r.size_label),
      col('price', 'Price', (r) => r.base_price_sen ?? -1),
    ]);
    const csv = exportCsv([{ code: 'MT-1', name: 'Cloud', branding: 'Dreamland', size_label: 'Queen', base_price_sen: 88800 }], cols);
    const { rows } = buildSkuImportRows(parseSkuCsv(csv), SIZES);
    expect(rows).toEqual([expect.objectContaining({ code: 'MT-1', branding: 'Dreamland', base_price_sen: 88800 })]);
  });

  test('sofa view: tier kept, a size with no price stays absent', () => {
    const cols = withSkuImportHeaders([
      col('code', 'Product Code', (r) => r.code),
      col('desc', 'Description', (r) => r.name),
      col('category', 'category', (r) => r.category),
      col('price_tier', 'price_tier', () => 'PRICE_2'),
      col('size-24', '24', () => 47250),
      col('size-26', '26', () => -1),
    ]);
    const csv = exportCsv([{ code: 'SF-1', name: 'Oslo', category: 'SOFA' }], cols);
    const { rows } = buildSkuImportRows(parseSkuCsv(csv), SIZES);
    expect(rows[0]?.seatHeightPrices).toEqual([{ height: '24', priceSen: 47250, tier: 'PRICE_2' }]);
  });

  test('an older sofa table file (bare sizes, sen) still reads as sen', () => {
    const csv = 'Product Code,Description,category,price_tier,24\r\nSF-1,Oslo,SOFA,PRICE_2,47250';
    const { rows } = buildSkuImportRows(parseSkuCsv(csv), SIZES);
    expect(rows[0]?.seatHeightPrices).toEqual([{ height: '24', priceSen: 47250, tier: 'PRICE_2' }]);
  });
});
