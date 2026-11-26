// ----------------------------------------------------------------------------
// THE SKU IMPORT MUST RECOGNISE THE FILE IN FRONT OF IT.
//
// The owner exported the SKU page, edited it, imported it back, and got
// "No rows had a code. Every row needs a code, name, and category." (2026-09-07)
// The file was fine — 164 rows parsed — but it came from the page's OTHER
// export, the grid's, whose headers are what a person reads on screen.
//
// He also recognised it: 「这个问题好像之前也是有」. It was. `docs/bugs/0605` gave
// the FABRIC import tolerant header matching on 2026-09-02 and this importer
// never got it, which is the fixed-on-one-surface-only class CLAUDE.md names.
// These tests exist so the third importer cannot repeat it silently.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import {
  normalizeImportHeader, looksLikeGridExport, mapGridHeaders, isGridNoPrice, missingGridFacts,
  gridToSkuRecords, importFailureMessage,
} from './products-import-headers';

const GRID_EXPORT_HEADERS = [
  'Product Code', 'Description', 'Model',
  '24', '26', '28', '30', '32', '35', '37',
  'Flat', 'Barcode', 'Unit (m³)', 'Status',
];

const ROUND_TRIP_HEADERS = [
  'code', 'name', 'category', 'size_label', 'price_tier', 'price_24', 'base_price', 'price1',
];

describe('header matching is tolerant, the way the fabric import already is', () => {
  test('space becomes underscore and case is ignored', () => {
    expect(normalizeImportHeader('Product Code')).toBe('product_code');
    expect(normalizeImportHeader('  Base Price ')).toBe('base_price');
    expect(normalizeImportHeader('PRICE TIER')).toBe('price_tier');
  });

  test('it is identity on every header the export writes', () => {
    for (const h of ROUND_TRIP_HEADERS) expect(normalizeImportHeader(h)).toBe(h);
  });

  test('a run of spaces and underscores collapses to one underscore', () => {
    expect(normalizeImportHeader('unit  _ m3')).toBe('unit_m3');
  });
});

describe('the grid export is RECOGNISED rather than guessed at', () => {
  test('the owner\'s file is identified as the table export', () => {
    expect(looksLikeGridExport(GRID_EXPORT_HEADERS.map(normalizeImportHeader))).toBe(true);
  });

  test('the round-trip export is NOT — it must still import', () => {
    expect(looksLikeGridExport(ROUND_TRIP_HEADERS.map(normalizeImportHeader))).toBe(false);
  });

  test('BOTH halves of the signal are needed', () => {
    expect(looksLikeGridExport(['code', 'name', '24'])).toBe(false);
    expect(looksLikeGridExport(['description', 'model', 'status'])).toBe(false);
    expect(looksLikeGridExport(['description', '24'])).toBe(true);
  });

  test('price_24 is not a bare number', () => {
    expect(looksLikeGridExport(ROUND_TRIP_HEADERS.map(normalizeImportHeader))).toBe(false);
  });
});

describe("the owner's own file is READ, not refused", () => {
  const mapped = mapGridHeaders(GRID_EXPORT_HEADERS.map(normalizeImportHeader));

  test('the code and the name arrive under the keys the importer reads', () => {
    expect(mapped[0]).toBe('code');
    expect(mapped[1]).toBe('name');
    expect(mapped[2]).toBe('base_model');
  });

  test('a bare seat height becomes the SEN price column for that size', () => {
    expect(mapped[3]).toBe('price_24_sen');
    expect(mapped[9]).toBe('price_37_sen');
  });

  test('a column the importer has no use for is left alone, not misfiled', () => {
    expect(mapped[11]).toBe('barcode');
    expect(mapped[12]).not.toMatch(/^(code|name|category|price_)/);
  });

  test('-1 is absence, and only -1', () => {
    expect(isGridNoPrice('-1')).toBe(true);
    expect(isGridNoPrice(' -1 ')).toBe(true);
    expect(isGridNoPrice('0')).toBe(false);
    expect(isGridNoPrice('47250')).toBe(false);
  });
});

describe('what the file cannot say, the export now says', () => {
  test("the owner's old file is missing both facts", () => {
    const m = missingGridFacts(GRID_EXPORT_HEADERS.map(normalizeImportHeader));
    expect(m.needsCategory).toBe(true);
    expect(m.needsTier).toBe(true);
  });

  test('a sheet exported after this change asks for nothing', () => {
    const today = ['product_code', 'description', 'model', 'category', 'price_tier', '24', '26'];
    const m = missingGridFacts(today);
    expect(m.needsCategory).toBe(false);
    expect(m.needsTier).toBe(false);
  });

  test('a sheet with no size columns needs no tier at all', () => {
    expect(missingGridFacts(['product_code', 'description', 'category']).needsTier).toBe(false);
  });
});

/* HC-0141 (2026-10-22): a hand-made sheet headed `Product Code,Description,
   category` has no size column, so it is not the grid export — and it used to
   be read with the raw keys, so every row lacked a `code`. */
describe('a hand-made sheet with label headers and no size column', () => {
  const grid = [['Product Code', 'Description', 'category'], ['MT-001', 'Mattress Queen', 'mattress']];

  test('its labels are translated, so the rows have a code and a name', () => {
    expect(gridToSkuRecords(grid)).toEqual([{ code: 'MT-001', name: 'Mattress Queen', category: 'mattress' }]);
  });

  test('a file that already has `code` keeps its real `description` column', () => {
    expect(gridToSkuRecords([['code', 'name', 'description'], ['A', 'N', 'D']]))
      .toEqual([{ code: 'A', name: 'N', description: 'D' }]);
  });

  test('a label is not mapped onto a key the sheet already has', () => {
    expect(gridToSkuRecords([['Product Code', 'name', 'description'], ['A', 'N', 'D']]))
      .toEqual([{ code: 'A', name: 'N', description: 'D' }]);
  });

  test('with no code column at all, the message says the headers were not recognised', () => {
    const msg = importFailureMessage(['item', 'description']);
    expect(msg).toMatch(/recognised as the product code/);
    expect(msg).not.toMatch(/missing a category/);
  });
});
