// Unit tests for the canonical inventory identity — computeVariantKey.
//
// The key IS the stock bucket: `inventory_balances.variant_key`, the MRP demand
// and supply buckets, the SO allocator's readiness buckets and the DO/GRN
// movement rows are all keyed byte-for-byte from this function. Two things it
// must never do:
//
//   1. move an EXISTING key. A changed key re-buckets live stock — the goods
//      stay on the shelf and every row that reads them goes blank.
//   2. return a key that says "no identity" while the caller handed it identity.
//      That was the 2026-08-16 hole: `ATTRS_BY_GROUP[group] ?? []` meant a NULL,
//      blank or misspelt `item_group` silently DROPPED the fabric/gap/divan/leg
//      the line carried and keyed '' — the unclassified bucket — so a bedframe
//      written with a null group pooled with goods that share nothing with it.
//
// The first block below pins (1) with fixtures; the rest exercise (2).
import { describe, expect, test } from 'vitest';
import { computeVariantKey, formatVariantKey, UNKNOWN_GROUP_SLUG, type VariantAttrs } from './variant-key';

const BEDFRAME_ATTRS = { fabricCode: 'BF-16', gap: '16', divanHeight: '10', legHeight: '2', totalHeight: '28' };
const SOFA_ATTRS = { fabricCode: 'EZ-002', seatHeight: '28', legHeight: '6' };

describe('computeVariantKey — recognised groups are UNCHANGED (live stock must not move)', () => {
  test.each([
    ['bedframe', BEDFRAME_ATTRS, 'fabriccode=bf-16|gap=16|divanheight=10|legheight=2|totalheight=28'],
    ['sofa', SOFA_ATTRS, 'fabriccode=ez-002|seatheight=28|legheight=6'],
    // Size is baked into the mattress code; accessory/others/service are code-only.
    ['mattress', { fabricCode: 'BF-16' }, ''],
    ['accessory', { legHeight: '2' }, ''],
    ['others', BEDFRAME_ATTRS, ''],
    ['service', BEDFRAME_ATTRS, ''],
    // Case / padding of the group itself is normalised, not quarantined.
    ['BEDFRAME', BEDFRAME_ATTRS, 'fabriccode=bf-16|gap=16|divanheight=10|legheight=2|totalheight=28'],
    ['  Sofa  ', SOFA_ATTRS, 'fabriccode=ez-002|seatheight=28|legheight=6'],
  ])('%s keys exactly as before', (group, attrs, expected) => {
    expect(computeVariantKey(group, attrs)).toBe(expected);
  });

  test('the alias spellings still fold onto the canonical attribute', () => {
    const canonical = computeVariantKey('sofa', { fabricCode: 'EZ-002', seatHeight: '28', legHeight: '6' });
    expect(computeVariantKey('sofa', { colorCode: 'EZ-002', depth: '28', sofaLegHeight: '6' })).toBe(canonical);
    expect(computeVariantKey('sofa', { fabricColor: 'EZ-002', depth: '28', sofaLegHeight: '6' })).toBe(canonical);
  });

  test('specials still key for EVERY group, recognised or not', () => {
    expect(computeVariantKey('mattress', { specials: ['Nylon', 'wooden arm'] }))
      .toBe('special=nylon,wooden arm');
    expect(computeVariantKey(null, { specials: ['Nylon'] })).toBe('special=nylon');
  });
});

describe('computeVariantKey — an UNRECOGNISED item_group is quarantined, not emptied', () => {
  // The latent trap, stated as a test: one PO line written with a null
  // item_group used to key '' no matter what its variants JSON held.
  test('null item_group + a real fabric no longer keys "" ', () => {
    const key = computeVariantKey(null, { fabricCode: 'BF-16', gap: '16' });
    expect(key).not.toBe('');
    expect(key).toBe(`${UNKNOWN_GROUP_SLUG}=none|fabriccode=bf-16|gap=16`);
  });

  test('a misspelt group carries its own spelling into the key', () => {
    expect(computeVariantKey('bedframes', { fabricCode: 'BF-16' }))
      .toBe(`${UNKNOWN_GROUP_SLUG}=bedframes|fabriccode=bf-16`);
    expect(computeVariantKey('bed frame', { fabricCode: 'BF-16' }))
      .toBe(`${UNKNOWN_GROUP_SLUG}=bed frame|fabriccode=bf-16`);
    // Two different misspellings are two different buckets — neither may
    // silently answer for the other.
    expect(computeVariantKey('bedframes', { fabricCode: 'BF-16' }))
      .not.toBe(computeVariantKey('bed frame', { fabricCode: 'BF-16' }));
  });

  test('a quarantined key can collide with NO real bucket, and with no "" bucket', () => {
    const real = computeVariantKey('bedframe', BEDFRAME_ATTRS);
    const quarantined = computeVariantKey(null, BEDFRAME_ATTRS);
    expect(quarantined).not.toBe(real);
    expect(quarantined).not.toBe('');
    // Structural, not incidental: the slug is not one a recognised group emits.
    const legalSlugs = ['fabriccode', 'seatheight', 'gap', 'divanheight', 'legheight', 'totalheight', 'special'];
    expect(legalSlugs).not.toContain(UNKNOWN_GROUP_SLUG);
    expect(quarantined.startsWith(`${UNKNOWN_GROUP_SLUG}=`)).toBe(true);
    for (const group of ['sofa', 'bedframe', 'mattress', 'accessory', 'others', 'service']) {
      expect(computeVariantKey(group, BEDFRAME_ATTRS).startsWith(`${UNKNOWN_GROUP_SLUG}=`)).toBe(false);
    }
  });

  test('quarantine reads the SAME aliases, so it is deterministic across writers', () => {
    const a = computeVariantKey('bed frame', { fabricCode: 'BF-16', legHeight: '2' });
    const b = computeVariantKey('bed frame', { fabricColor: 'BF-16', sofaLegHeight: '2' });
    expect(a).toBe(b);
    expect(a).toBe(`${UNKNOWN_GROUP_SLUG}=bed frame|fabriccode=bf-16|legheight=2`);
  });

  test('specials still append after a quarantined attribute list', () => {
    expect(computeVariantKey('bedframes', { fabricCode: 'BF-16', specials: ['Nylon'] }))
      .toBe(`${UNKNOWN_GROUP_SLUG}=bedframes|fabriccode=bf-16|special=nylon`);
  });
});

describe('computeVariantKey — the "" unclassified bucket is PRESERVED', () => {
  // Quarantine fires only where something was being THROWN AWAY. A row with no
  // identity attributes at all keys '' exactly as it always did — that bucket
  // holds real production stock and re-keying it would hide those goods.
  const cases: Array<[string | null | undefined, VariantAttrs | null | undefined]> = [
    [null, null],
    [undefined, undefined],
    [null, {}],
    ['', {}],
    ['   ', { fabricCode: null, gap: '' }],
    ['not-a-group', { fabricCode: '   ', legHeight: null, specials: [] }],
  ];
  test.each(cases)('group %o + attrs %o still keys ""', (group, attrs) => {
    expect(computeVariantKey(group, attrs)).toBe('');
  });
});

describe('formatVariantKey — a quarantined key reads LOUD, not blank', () => {
  test('the unknown-group segment is labelled in the UI string', () => {
    const key = computeVariantKey('bedframes', { fabricCode: 'BF-16', gap: '16' });
    expect(formatVariantKey(key)).toBe('UNKNOWN GROUP bedframes / BF-16 / GAP 16');
  });

  test('a recognised key formats exactly as before', () => {
    expect(formatVariantKey(computeVariantKey('bedframe', { fabricCode: 'BF-16', gap: '16', legHeight: '2' })))
      .toBe('BF-16 / GAP 16 / LEG 2');
    expect(formatVariantKey('')).toBe('');
  });
});
