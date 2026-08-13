import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared by both refresh sweeps
import {
  OWNED_VARIANT_KEYS,
  OWNED_SIZE_ONLY_KEYS,
  assertOnlyOwnedKeys,
  buildBedframeVariantPatch,
  buildSizeOnlyVariantPatch,
} from '../scripts/lib/variant-merge.mjs';
import mergeLibSource from '../scripts/lib/variant-merge.mjs?raw';
import soRefreshSource from '../scripts/refresh-so-variants.mjs?raw';
import poRefreshSource from '../scripts/refresh-po-variants.mjs?raw';

/* The guard for BUG-HISTORY.md "The variant refresh scripts REPLACE the whole
   variants jsonb, so any key they do not know about is dropped".

   Both sweeps used to rebuild `variants` from a fixed list of keys and write the
   WHOLE column. `variants` has at least six writers, so every key outside that
   list - `variants.special`, the HOOKKA-compatible singular the picker reads
   (SpecialOrders.tsx:91), whatever the POS configurator stores, whatever is
   added next month - was deleted on each run, silently.

   This file fails if that comes back. It pins the two halves of the fix:
     1. a patch may only carry keys the sweep DECLARED it owns, and
     2. the WRITE is a merge (`variants || patch`), never an assignment,
   because together those make an unknown key survive BY CONSTRUCTION. A
   thirteenth key added next month needs nobody to remember this bug. */

const bf = (over: Record<string, unknown> = {}) => ({
  color: 'GIRONA J9047-01', gap: 2, divan: 10, leg: 4, size: '6x8', specials: [], ...over,
});
const fc = { fabric_id: 'GIRONA J9047', colour_id: 'GIRONA J9047-01 BRUNETTE', label: 'J9047-1-Brunette' };

/* Source-shape assertions must read the CODE, not the comments that describe
   the old shape. Both files quote `SET variants = <fresh object>` while
   explaining what they stopped doing. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

describe('variant refresh: the sweep declares the keys it owns', () => {
  test('the declared set is the parse-derived block, and nothing about specials', () => {
    expect([...OWNED_VARIANT_KEYS].sort()).toEqual([
      'colourId', 'colourLabel', 'divanHeight', 'fabricCode', 'fabricId', 'fabricLabel',
      'gap', 'legHeight', 'size', 'totalHeight',
    ]);
    /* `specials` belongs to the money-guarded backfill (a priced add-on's
       surcharge is folded into the authoritative unit price, so re-stamping it
       reprices a historical document); `special` is the picker's HOOKKA
       singular and belongs to whoever set it. Neither is this sweep's. */
    for (const forbidden of ['specials', 'special', 'custom_specials'])
      expect(OWNED_VARIANT_KEYS).not.toContain(forbidden);
  });

  test('the bedframe patch never emits a key outside the declared set', () => {
    for (const input of [
      bf(), bf({ gap: null, divan: null, leg: null }), bf({ size: null }),
      bf({ specials: ['HB FULLY COVER', 'FRONT DRAWER'] }),
    ]) {
      for (const colour of [fc, null]) {
        const patch = buildBedframeVariantPatch(input, colour);
        for (const k of Object.keys(patch)) expect(OWNED_VARIANT_KEYS).toContain(k);
      }
    }
  });

  test('the (SP) size-only patch touches size and nothing else', () => {
    expect(Object.keys(buildSizeOnlyVariantPatch(bf({ size: '5x7' })))).toEqual(['size']);
    expect([...OWNED_SIZE_ONLY_KEYS]).toEqual(['size']);
  });

  test('a key that creeps into a patch is a crash, not a silent widening', () => {
    expect(() => assertOnlyOwnedKeys({ size: '6x8', specials: ['X'] })).toThrow(/does not own: specials/);
    expect(() => assertOnlyOwnedKeys({ size: '6x8', seatHeight: '28' })).toThrow(/does not own: seatHeight/);
    expect(() => assertOnlyOwnedKeys({ size: '6x8' })).not.toThrow();
    expect(() => assertOnlyOwnedKeys({ gap: '2"' }, OWNED_SIZE_ONLY_KEYS)).toThrow(/does not own: gap/);
    expect(() => assertOnlyOwnedKeys(['not', 'an', 'object'])).toThrow(/plain object/);
  });
});

describe('variant refresh: an unknown key survives the rebuild', () => {
  /* `jsonb_object || jsonb_object` overwrites exactly the right-hand keys and
     leaves every other left-hand key alone - the same semantics as an object
     spread. The SQL is asserted to BE that merge below, and proved against a
     real PostgreSQL in tests-pg/variantMergePreservesKeys.pg.test.ts. Here the
     semantics are pinned against a row carrying keys no sweep has heard of,
     including the one BUG-HISTORY names as the real casualty. */
  const existing = {
    fabricId: 'OLD FABRIC', colourId: 'OLD COLOUR', size: '5x7',
    special: ['No bracket'],                   // the picker's HOOKKA singular
    specials: ['Nylon Fabric', 'HB Straight'], // landed by the money-guarded backfill
    seatHeight: '28',                          // seen in production (probe run 31416469998)
    aThirteenthKeyAddedNextMonth: { anything: true },
  };

  test('the merge keeps every key the patch does not name', () => {
    const patch = buildBedframeVariantPatch(bf(), fc);
    const merged = { ...existing, ...patch };

    expect(merged.special).toEqual(['No bracket']);
    expect(merged.specials).toEqual(['Nylon Fabric', 'HB Straight']);
    expect(merged.seatHeight).toBe('28');
    expect(merged.aThirteenthKeyAddedNextMonth).toEqual({ anything: true });

    expect(merged.fabricId).toBe('GIRONA J9047');
    expect(merged.colourId).toBe('GIRONA J9047-01 BRUNETTE');
    expect(merged.gap).toBe('2"');
    expect(merged.totalHeight).toBe('16"');
    expect(merged.size).toBe('6x8');
  });

  test('a whole-object rebuild would have dropped them - this is the regression', () => {
    const rebuilt: Record<string, unknown> = { ...buildBedframeVariantPatch(bf(), fc) };
    for (const lost of ['special', 'specials', 'seatHeight', 'aThirteenthKeyAddedNextMonth'])
      expect(rebuilt[lost]).toBeUndefined();
  });
});

describe('variant refresh: the WRITE is a merge, in the source', () => {
  const sources: Array<[string, string]> = [
    ['lib/variant-merge.mjs', codeOnly(mergeLibSource)],
    ['refresh-so-variants.mjs', codeOnly(soRefreshSource)],
    ['refresh-po-variants.mjs', codeOnly(poRefreshSource)],
  ];

  test('no script assigns the whole variants column', () => {
    for (const [name, src] of sources) {
      const assignments = [...src.matchAll(/\bvariants\s*=[^=]/g)].map((m) => m.index ?? 0);
      for (const at of assignments) {
        const stmt = src.slice(at, at + 70).replace(/\s+/g, ' ');
        expect(`${name}: ${stmt}`).toMatch(/variants = COALESCE\(variants, '\{\}'::jsonb\) \|\|/);
      }
    }
  });

  test('every merge is guarded on the column already being an object, and counted by RETURNING', () => {
    /* jsonb object || non-object CONCATENATES into an array instead of merging
       (docs/jsonb-double-encoding-coe.md). The guard is what stops that, and
       RETURNING is what stops a command tag being read as proof. */
    const [, lib] = sources[0];
    const merges = lib.match(/COALESCE\(variants, '\{\}'::jsonb\) \|\|/g) ?? [];
    const guards = lib.match(/jsonb_typeof\(COALESCE\(variants, '\{\}'::jsonb\)\) = 'object'/g) ?? [];
    const returning = lib.match(/RETURNING id/g) ?? [];
    expect(merges.length).toBeGreaterThan(0);
    expect(guards.length).toBe(merges.length);
    expect(returning.length).toBe(merges.length);
  });

  test('the patch reaches the parameter as a value, never as a stringified string', () => {
    expect(sources[0][1]).toContain('db.json(patch)');
    for (const [, src] of sources) expect(src).not.toContain('JSON.stringify');
  });

  test('neither sweep writes custom_specials any more', () => {
    /* custom_specials is a DERIVED output of the pricing recompute; PR #1944
       nulled 478 of them for exactly that reason, and a refresh run must not
       refill it from an unpriced-unaware mapping. */
    for (const [name, src] of [sources[1], sources[2]])
      expect(`${name} writes custom_specials: ${/custom_specials\s*=/.test(src)}`)
        .toBe(`${name} writes custom_specials: false`);
  });
});
