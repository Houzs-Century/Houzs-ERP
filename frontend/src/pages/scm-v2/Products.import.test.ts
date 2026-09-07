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
import { normalizeImportHeader, looksLikeGridExport } from './products-import-headers';

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
