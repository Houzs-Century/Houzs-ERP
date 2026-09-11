// ----------------------------------------------------------------------------
// sku-category — the group is the SKU's, and a group that ignores the line's
// own attributes is a contradiction worth saying out loud.
// ----------------------------------------------------------------------------

import { describe, expect, test } from 'vitest';
import { lineItemGroup, attributesTheGroupWillIgnore, resolveItemGroups } from './sku-category';
import { parsePgrestInList } from './pgrest-in-list';

const SOFA = { fabricCode: 'PC151-12', seatHeight: '30', legHeight: 'Default' };

describe('lineItemGroup — the product master wins', () => {
  const bySku = new Map([['2376-1A(LHF)', 'sofa']]);

  test('the SKU beats whatever the caller sent', () => {
    expect(lineItemGroup(bySku, { itemCode: '2376-1A(LHF)', itemGroup: 'others' })).toBe('sofa');
  });

  /* THE REGRESSION: the caller sent nothing at all. */
  test('the SKU fills a blank the caller left', () => {
    expect(lineItemGroup(bySku, { itemCode: '2376-1A(LHF)' })).toBe('sofa');
    expect(lineItemGroup(bySku, { itemCode: '2376-1A(LHF)', itemGroup: null })).toBe('sofa');
  });

  test('a code with no product row keeps the caller value', () => {
    expect(lineItemGroup(bySku, { itemCode: 'RAW-FOAM', itemGroup: 'others' })).toBe('others');
  });

  test('and resolves to null when neither has one', () => {
    expect(lineItemGroup(bySku, { itemCode: 'RAW-FOAM' })).toBeNull();
    expect(lineItemGroup(bySku, { itemCode: 'RAW-FOAM', itemGroup: '   ' })).toBeNull();
  });

  test('the code is trimmed before lookup', () => {
    expect(lineItemGroup(bySku, { itemCode: '  2376-1A(LHF) ' })).toBe('sofa');
  });
});

describe('attributesTheGroupWillIgnore — the contradiction', () => {
  /* Exactly the shape that made HC-GRN-2608-003 invisible. */
  test('a blank group on a line carrying fabric + seat is reported', () => {
    expect(attributesTheGroupWillIgnore(null, SOFA).sort())
      .toEqual(['fabricCode', 'legHeight', 'seatHeight']);
  });

  test('so is `others`', () => {
    expect(attributesTheGroupWillIgnore('others', SOFA).length).toBe(3);
  });

  test('a sofa group composes them, so there is nothing to report', () => {
    expect(attributesTheGroupWillIgnore('sofa', SOFA)).toEqual([]);
    expect(attributesTheGroupWillIgnore('BEDFRAME', SOFA)).toEqual([]);
  });

  test('an accessory with no attributes is not a contradiction', () => {
    expect(attributesTheGroupWillIgnore('accessory', null)).toEqual([]);
    expect(attributesTheGroupWillIgnore('accessory', {})).toEqual([]);
  });

  /* Blank strings are not attributes — a line that merely HAS the keys, empty,
     must not be reported or the signal drowns. */
  test('empty attribute values are not reported', () => {
    expect(attributesTheGroupWillIgnore(null, { fabricCode: '', seatHeight: '   ' })).toEqual([]);
  });

  test('the POS vocabulary counts too', () => {
    expect(attributesTheGroupWillIgnore(null, { depth: '30', sofaLegHeight: '4"' }).sort())
      .toEqual(['depth', 'sofaLegHeight']);
  });
});

/* ── resolveItemGroups — the OUTBOUND rewrite (docs/bugs/0524) ────────────────
   The inbound helpers above hand a route a lookup it calls where it writes. A
   delivery order reads the group in three places (stock check, commitment
   planner, stored row) and the stored one is what the OUT movement is keyed
   from later, so the rewrite is the guarantee that all three say one thing. */
const fakeSb = (rows: Array<{ code: string; category: string | null }> | null) => ({
  from: () => ({
    select: () => ({
      in: () => ({
        eq: () => Promise.resolve({ data: rows, error: rows ? null : { message: 'boom' } }),
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: rows ? null : { message: 'boom' } }).then(res),
      }),
    }),
  }),
});

describe('resolveItemGroups — one value, before any reader', () => {
  const catalogue = [{ code: 'BF-KING-01', category: 'BEDFRAME' }, { code: 'SPARE-LEG', category: null }];

  test('a wrong group and a missing group both become the SKU\'s', async () => {
    const out = await resolveItemGroups(fakeSb(catalogue), [
      { itemCode: 'BF-KING-01', itemGroup: 'others', qty: 1 },
      { itemCode: 'BF-KING-01', qty: 2 },
    ], 1);
    expect(out.map((l) => l.itemGroup)).toEqual(['bedframe', 'bedframe']);
    /* Everything else on the line rides through untouched — the routes pass
       these same objects on to the row builder. */
    expect(out[1]!.qty).toBe(2);
  });

  test('an unclassified code keeps what the caller sent', async () => {
    const out = await resolveItemGroups(fakeSb(catalogue), [{ itemCode: 'SPARE-LEG', itemGroup: 'accessory' }], 1);
    expect(out[0]!.itemGroup).toBe('accessory');
  });

  test('the input array is not mutated', async () => {
    const input = [{ itemCode: 'BF-KING-01', itemGroup: 'others' }];
    await resolveItemGroups(fakeSb(catalogue), input, 1);
    expect(input[0]!.itemGroup).toBe('others');
  });

  /* FAIL SOFT — a product read that blipped must never be the reason a delivery
     cannot be saved. Same contract skuCategoryMap states. */
  test('a failed catalogue read leaves every line exactly as it arrived', async () => {
    const out = await resolveItemGroups(fakeSb(null), [{ itemCode: 'BF-KING-01', itemGroup: 'others' }], 1);
    expect(out[0]!.itemGroup).toBe('others');
  });
});

/* ── docs/bugs/0819 — the by-code sweep, at a representative site ─────────────
   Model the WIRE, not a convenient stand-in. postgrest-js `.in()` quotes `[,()]`
   but never ESCAPES, so a code carrying `"` (inch mark) closes its own quoted
   value early and the first `)` after it closes the whole `in.(` list — the code
   AND every code after it in the batch silently read as absent, request still
   200. `.filter(_, 'in', pgrestInList(...))` sends the escaped payload that
   survives. This fake reproduces both, so a revert of skuCategoryMap to
   `.in('code', …)` fails these. */
const wireIn = (vs: readonly unknown[]): unknown[] =>
  vs.some((v) => typeof v === 'string' && /["\\]/.test(v))
    ? parsePgrestInList(`(${[...new Set(vs)].map((s) => (typeof s === 'string' && /[,()]/.test(s) ? `"${s}"` : `${s}`)).join(',')})`)
    : [...vs];

const wireSb = (rows: Array<{ code: string; category: string | null; company_id: number }>) => ({
  from: () => {
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    const run = () => ({
      data: rows
        .filter((r) => eqs.every(([col, v]) => (r as Record<string, unknown>)[col] === v))
        .filter((r) => ins.every(([col, vs]) => vs.includes((r as Record<string, unknown>)[col]))),
      error: null,
    });
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, v: unknown) => { eqs.push([col, v]); return builder; },
      in: (col: string, vs: unknown[]) => { ins.push([col, wireIn(vs)]); return builder; },
      filter: (col: string, op: string, payload: string) => {
        if (op === 'in') ins.push([col, parsePgrestInList(payload)]);
        return builder;
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    };
    return builder;
  },
});

describe('skuCategoryMap — an inch-mark code, and every code after it, still resolves (docs/bugs/0819)', () => {
  const INCH = 'DUNLOPILLO GENERASI 5" MATT (SS)';
  const catalogue = [
    { code: INCH, category: 'MATTRESS', company_id: 1 },
    { code: '9058-1NA', category: 'SOFA', company_id: 1 }, // in the same batch, AFTER the inch mark
  ];

  test('the escaped read resolves both categories', async () => {
    const out = await resolveItemGroups(
      wireSb(catalogue),
      [{ itemCode: INCH, itemGroup: null }, { itemCode: '9058-1NA', itemGroup: null }],
      1,
    );
    expect(out.map((l) => l.itemGroup)).toEqual(['mattress', 'sofa']);
  });

  test('proof the wire model bites — a raw .in() drops the inch mark and the code after it', () => {
    // What the raw library emits, read back the way PostgREST parses it: one
    // garbled value, and 9058-1NA gone entirely.
    expect(wireIn([INCH, '9058-1NA'])).toEqual(['DUNLOPILLO GENERASI 5 MATT (SS']);
  });
});
