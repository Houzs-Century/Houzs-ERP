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
} from './products-import-headers';

/** The owner's actual file, header row verbatim (sku-master-2026-09-07). */
const GRID_EXPORT_HEADERS = [
  'Product Code', 'Description', 'Model',
  '24', '26', '28', '30', '32', '35', '37',
  'Flat', 'Barcode', 'Unit (m³)', 'Status',
];

/** What the round-trip export writes — `code`, never `Product Code`. */
const ROUND_TRIP_HEADERS = [
  'code', 'name', 'category', 'size_label', 'price_tier', 'price_24', 'base_price', 'price1',
];

describe('header matching is tolerant, the way the fabric import already is', () => {
  test('space becomes underscore and case is ignored', () => {
    expect(normalizeImportHeader('Product Code')).toBe('product_code');
    expect(normalizeImportHeader('  Base Price ')).toBe('base_price');
    expect(normalizeImportHeader('PRICE TIER')).toBe('price_tier');
  });

  /* It may only ever LOOSEN. An exported file's headers are already lower
     snake_case, so the normaliser has to be identity on every one of them —
     otherwise loosening the match would break the file that used to work. */
  test('it is identity on every header the export writes', () => {
    for (const h of ROUND_TRIP_HEADERS) expect(normalizeImportHeader(h)).toBe(h);
  });

  test('a run of spaces and underscores collapses to one underscore', () => {
    expect(normalizeImportHeader('unit  _ m3')).toBe('unit_m3');
  });
});

describe('the grid export is RECOGNISED rather than guessed at', () => {
  /* Aliasing the grid's headers would be the dangerous fix, not the kind one:
     it writes one column per sofa SIZE for the tier that happened to be on
     screen, and carries NO tier column. A price imported from it would have no
     tier, and a price filed under the wrong tier is worse than one not filed. */
  test('the owner\'s file is identified as the table export', () => {
    expect(looksLikeGridExport(GRID_EXPORT_HEADERS.map(normalizeImportHeader))).toBe(true);
  });

  test('the round-trip export is NOT — it must still import', () => {
    expect(looksLikeGridExport(ROUND_TRIP_HEADERS.map(normalizeImportHeader))).toBe(false);
  });

  /* The signal is SHAPE, not one label: no `code` column, and at least one
     header that is a bare number. Pinning it to the grid's own code-column
     heading would have been the obvious test and the worse one — that spelling
     is retired vocabulary, and a detector tied to one label breaks the day
     somebody renames a column. */
  test('BOTH halves of the signal are needed', () => {
    // a bare-number column but a `code` column too -> still the round-trip file
    expect(looksLikeGridExport(['code', 'name', '24'])).toBe(false);
    // no `code` column but no bare-number column either -> not the grid export
    expect(looksLikeGridExport(['description', 'model', 'status'])).toBe(false);
    // both -> the grid export
    expect(looksLikeGridExport(['description', '24'])).toBe(true);
  });

  /* The round-trip export's size columns are `price_24`, never a bare `24`, so
     it can never trip the number half of the rule. */
  test('price_24 is not a bare number', () => {
    expect(looksLikeGridExport(ROUND_TRIP_HEADERS.map(normalizeImportHeader))).toBe(false);
  });
});

describe("the owner's own file is READ, not refused", () => {
  const mapped = mapGridHeaders(GRID_EXPORT_HEADERS.map(normalizeImportHeader));

  test('the code and the name arrive under the keys the importer reads', () => {
    expect(mapped[0]).toBe('code');   // "Product Code"
    expect(mapped[1]).toBe('name');   // "Description" IS the name on this grid
    expect(mapped[2]).toBe('base_model');
  });

  /* The grid's numbers are already SEN (47250 = RM 472.50), so they map to the
     `_sen` column and no conversion runs — a rounding step that never happens
     cannot lose half a ringgit. */
  test('a bare seat height becomes the SEN price column for that size', () => {
    expect(mapped[3]).toBe('price_24_sen');
    expect(mapped[9]).toBe('price_37_sen');
  });

  /* A heading with no meaning to the importer passes through untouched — it is
     never bent onto a key it does not mean. The row builder reads the keys it
     knows and ignores the rest, so passing through costs nothing and blanking
     would have destroyed `category` and `price_tier`, which the export now
     writes under the importer's own names. */
  test('a column the importer has no use for is left alone, not misfiled', () => {
    expect(mapped[11]).toBe('barcode');
    expect(mapped[12]).not.toMatch(/^(code|name|category|price_)/);
  });

  /* -1 is the grid's "this size has no price for the shown tier". Read as a
     number it would create a SKU priced at minus one sen. */
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

  /* The sofa grid now carries `category` and `price_tier`, so a file exported
     from today on answers both by itself and nothing is asked. */
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
