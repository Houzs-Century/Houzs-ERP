/* The frontend half of the ONE "PO price vs invoice price" rule.
 *
 * The editor, the detail page, the list marker and the phone all decide when a
 * purchase-invoice line's price "differs" from its purchase order's. The server
 * decides it too, for the list endpoint. Two hand-written copies of that
 * decision drift — this repo's own position (check-shared-mirrors.mjs) — so the
 * rule is ONE byte-identical file in both trees and this test is the referee.
 *
 * The file sits at the top level of vendor/scm/lib on purpose: the mirror
 * checker matches by basename, non-recursively, against backend/src/scm/lib. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { comparePiLinePrice, defaultPiUnitPriceSen } from './pi-po-price-rule';

describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/lib/pi-po-price-rule.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/scm/lib/pi-po-price-rule.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/lib/pi-po-price-rule.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});

describe('the rule, as the screens rely on it', () => {
  test('a PO price of 0 is "the order named no price", never a difference', () => {
    expect(comparePiLinePrice(213_800, 0)).toMatchObject({ differs: false, diffSen: null });
  });
  test('a real difference is reported with its sign', () => {
    expect(comparePiLinePrice(83_000, 80_000)).toMatchObject({ differs: true, diffSen: 3_000 });
    expect(comparePiLinePrice(77_000, 80_000)).toMatchObject({ differs: true, diffSen: -3_000 });
  });
  test('a new line starts at the PO price, or the receipt price when the PO named none', () => {
    expect(defaultPiUnitPriceSen(80_000, 83_000)).toBe(80_000);
    expect(defaultPiUnitPriceSen(0, 21_380)).toBe(21_380);
    expect(defaultPiUnitPriceSen(null, 900)).toBe(900);
  });
});
