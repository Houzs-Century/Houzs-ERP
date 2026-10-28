import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs script libs
import { ARMS, VKEY_ARMS, COLOUR_ALIASES } from '../scripts/lib/fabric-write.mjs';
// @ts-expect-error - plain .mjs script libs
import { CARRIERS, COLOUR_KEYS } from '../scripts/lib/colour-carriers.mjs';

/* THE CENSUS AND THE REPAIR MUST KNOW THE SAME TABLES.

   lib/fabric-write.mjs repairs a fabric colour; lib/colour-carriers.mjs counts
   it to prove the repair was complete. Until 2026-08-13 each held its own copy
   of the fifteen line tables, the eight variant_key buckets and the five-key
   alias chain. A census that walks a table the repair does not reach reports a
   miss forever; a census that MISSES one the repair reaches certifies a merge
   that is not finished — and the second failure is the one that keeps happening
   (#1964's unswept GRN arm, #1893's five drifted colour matchers, and the
   series merger that ignored the shared list it was supposed to be reading).

   colour-carriers.mjs now derives both arm lists from fabric-write.mjs. This
   test is what stops someone re-typing them. */

const tablesOfKind = (kind: string, col?: string) =>
  (CARRIERS as Array<{ table: string; kind: string; col: string }>)
    .filter((c) => c.kind === kind && (col === undefined || c.col === col))
    .map((c) => c.table);

describe('colour-carriers derives its arms from fabric-write', () => {
  test('the variants carriers are exactly ARMS, in order', () => {
    expect(tablesOfKind('variants', 'variants')).toEqual(
      (ARMS as Array<{ t: string }>).map((a) => a.t),
    );
  });

  test('every variants arm is also counted for description2', () => {
    expect(tablesOfKind('text', 'description2')).toEqual(
      (ARMS as Array<{ t: string }>).map((a) => a.t),
    );
  });

  test('the variant_key carriers are exactly VKEY_ARMS, table and column', () => {
    expect(
      (CARRIERS as Array<{ table: string; kind: string; col: string }>)
        .filter((c) => c.kind === 'vkey')
        .map((c) => [c.table, c.col]),
    ).toEqual((VKEY_ARMS as Array<{ t: string; c: string }>).map((a) => [a.t, a.c]));
  });

  test('there is ONE colour alias chain', () => {
    expect(COLOUR_KEYS).toBe(COLOUR_ALIASES);
  });
});

describe('the alias chain still covers every writer', () => {
  /* Named individually because each entry was earned: fabricCode is canonical,
     the GRN / purchase-invoice / purchase-return editors write fabricColor, and
     POS writes colorCode / colourCode / colourId. A sweep matching only
     fabricCode reports an arm CLEAN while it is still dirty. */
  test.each(['fabricCode', 'colorCode', 'colourCode', 'fabricColor', 'colourId'])(
    '%s is in the chain',
    (k) => { expect(COLOUR_ALIASES).toContain(k); },
  );
});
