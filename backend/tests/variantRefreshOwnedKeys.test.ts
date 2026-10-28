import { describe, expect, it, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared by both refresh sweeps
import {
  OWNED_VARIANT_KEYS,
  OWNED_SIZE_ONLY_KEYS,
  assertOnlyOwnedKeys,
  buildBedframeVariantPatch,
  buildSizeOnlyVariantPatch,
  OWNED_SOFA_KEYS,
  OWNED_BOOK_CORRECTION_KEYS,
  OWNED_PI_SNAPSHOT_KEYS,
  MERGE_TABLES,
} from '../scripts/lib/variant-merge.mjs';
import mergeLibSource from '../scripts/lib/variant-merge.mjs?raw';
import soRefreshSource from '../scripts/refresh-so-variants.mjs?raw';
import poRefreshSource from '../scripts/refresh-po-variants.mjs?raw';
import applyPatchSource from '../scripts/apply-variant-patch.mjs?raw';

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

/* Every postgres.js TAGGED TEMPLATE body in a source, so an assertion about
   what reaches a query PARAMETER cannot be fooled by the same text appearing in
   a log line. Scans to the closing backtick, stepping over `${...}` so an
   interpolation containing a brace or a backtick does not end the scan early. */
function sqlTaggedTemplates(src: string): string[] {
  const out: string[] = [];
  const open = /\b(?:sql|tx|db|verify)`/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(src)) !== null) {
    let i = open.lastIndex;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') { i++; continue; }
      if (c === '$' && src[i + 1] === '{') { depth++; i++; continue; }
      if (c === '}' && depth > 0) { depth--; continue; }
      if (c === '`' && depth === 0) break;
    }
    out.push(src.slice(open.lastIndex, i));
    open.lastIndex = i + 1;
  }
  return out;
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

  test('the reviewed hand-patch path is the same write, in the library', () => {
    /* apply-variant-patch.mjs was the last script in this family merging jsonb
       in JAVASCRIPT: SELECT variants, `{...row.variants, ...p.variants}`, assign
       the whole column back. It preserved keys - which is why it never showed up
       as the "REPLACE the whole variants jsonb" bug - but it had no
       jsonb_typeof guard and no read-back, the two things the colour-sweep COE
       is about. Spreading an ARRAY variants column yields {"0":..,"1":..}, a
       valid object, so the write would have converted a detectably damaged row
       into an undetectably damaged one. Pin the library function it now uses. */
    const [, lib] = sources[0];
    expect(lib).toContain('export async function mergeReviewedVariantPatch');
    // COALESCE geometry, not the sweep's unconditional restamp: a hand patch
    // that says nothing about `gap` must leave gap alone.
    expect(lib).toContain('gap_inches = COALESCE(');
  });

  test('the hand-patch script never merges jsonb in JavaScript again', () => {
    const src = codeOnly(applyPatchSource);
    // the write goes through the library, guarded and counted there
    expect(src).toContain('mergeReviewedVariantPatch');
    // no bare assignment of the column
    for (const at of [...src.matchAll(/\bvariants\s*=[^=]/g)].map((m) => m.index ?? 0))
      expect(`apply-variant-patch.mjs: ${src.slice(at, at + 70).replace(/\s+/g, ' ')}`)
        .toMatch(/variants = COALESCE\(variants, '\{\}'::jsonb\) \|\|/);
    // no JS-side read-modify-write of the column
    expect(src).not.toMatch(/\.\.\.\s*\(?\s*row\.variants/);
    expect(src).not.toMatch(/SELECT\s+variants\s+FROM/i);
    /* the read-back is the other half. A command tag answers "did a row change",
       never "does the row hold what I meant" - the colour sweep reported three
       successful applies while destroying the column. */
    expect(src).toContain('READ-BACK on a fresh connection');
    expect(src).toMatch(/postgres\(DST[\s\S]{0,80}\)/);
  });

  test('the hand patch is bound as a value, never a stringified string', () => {
    /* This script legitimately uses JSON.stringify for LOG lines and for
       comparing read-back values, so the blanket `not.toContain` the sweeps get
       would be wrong here and would only teach the next author to delete the
       assertion. Assert the thing that actually matters: nothing stringified
       reaches a QUERY parameter. postgres.js applies its own JSON.stringify to
       anything the server resolves to jsonb, so a pre-serialized string is
       encoded twice and lands a jsonb STRING scalar
       (docs/jsonb-double-encoding-coe.md). */
    const src = codeOnly(applyPatchSource);
    const templates = sqlTaggedTemplates(src);
    expect(templates.length).toBeGreaterThan(0);   // never pass vacuously
    for (const t of templates)
      expect(`SQL template binds a stringified value: ${t.replace(/\s+/g, ' ').slice(0, 90)}`)
        .not.toContain('JSON.stringify');
    expect(src).toMatch(/sql\.json\(/);
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

/* ---------------------------------------------------------------------------
 * OWNED_BOOK_CORRECTION_KEYS — the reviewed-list writer, not a sweep.
 *
 * `repair-so-variant-from-book.mjs` may own a key the refresh sweeps must not,
 * because it writes a HUMAN-REVIEWED list guarded by `erp_now`, while a sweep
 * recomputes from Desc2 and overwrites every owned key on every run. Keeping
 * them as two lists is the point; merging them would silently arm the sweeps.
 * ------------------------------------------------------------------------ */
describe('OWNED_BOOK_CORRECTION_KEYS', () => {
  it('owns the leg, which the sofa SWEEP list deliberately does not', () => {
    expect(OWNED_BOOK_CORRECTION_KEYS).toContain('legHeight');
    expect(OWNED_SOFA_KEYS).not.toContain('legHeight');
  });

  it('is the sofa sweep list plus the leg, and nothing else', () => {
    expect([...OWNED_BOOK_CORRECTION_KEYS].sort())
      .toEqual([...OWNED_SOFA_KEYS, 'legHeight'].sort());
  });

  it('never carries a bedframe-only axis — a sofa has no divan and no gap', () => {
    for (const k of ['divanHeight', 'gap', 'totalHeight']) {
      expect(OWNED_BOOK_CORRECTION_KEYS).not.toContain(k);
    }
  });

  it('never carries specials, which are money and belong to their own backfill', () => {
    expect(OWNED_BOOK_CORRECTION_KEYS).not.toContain('specials');
    expect(OWNED_BOOK_CORRECTION_KEYS).not.toContain('special');
  });
});

/* ---------------------------------------------------------------------------
 * OWNED_PI_SNAPSHOT_KEYS — the migrated purchase-invoice line taking back the
 * receipt line it was copied from (repair-migrated-invoice-variants-from-
 * receipt.mjs). A THIRD list on purpose: its source is neither a Desc2 re-parse
 * nor the account book, it is our own parent row, and it only ever fills a line
 * whose variants is absent or empty. Merging it into either of the others would
 * silently arm a writer that never asked for these keys (docs/bugs/0755).
 * ------------------------------------------------------------------------ */
describe('OWNED_PI_SNAPSHOT_KEYS', () => {
  it('never carries specials, which are money — the whole guard of this writer', () => {
    for (const k of ['specials', 'special', 'specialsRecorded', 'customSpecials']) {
      expect(OWNED_PI_SNAPSHOT_KEYS).not.toContain(k);
    }
  });

  it('is a SUBSET of what the sweeps already own, so it can invent no key', () => {
    const known = new Set([...OWNED_VARIANT_KEYS, ...OWNED_SOFA_KEYS]);
    for (const k of OWNED_PI_SNAPSHOT_KEYS) expect([...known]).toContain(k);
  });

  it('carries the bedframe axes the tally compares, which the book-correction list does not', () => {
    for (const k of ['divanHeight', 'gap', 'totalHeight']) {
      expect(OWNED_PI_SNAPSHOT_KEYS).toContain(k);
      expect(OWNED_BOOK_CORRECTION_KEYS).not.toContain(k);
    }
  });

  it('is its own list and not an alias of either sweep list', () => {
    expect([...OWNED_PI_SNAPSHOT_KEYS].sort()).not.toEqual([...OWNED_VARIANT_KEYS].sort());
    expect([...OWNED_PI_SNAPSHOT_KEYS].sort()).not.toEqual([...OWNED_BOOK_CORRECTION_KEYS].sort());
  });

  it('refuses a patch carrying a key it does not own', () => {
    expect(() => assertOnlyOwnedKeys({ specials: ['NYLON'] }, OWNED_PI_SNAPSHOT_KEYS))
      .toThrow(/does not own: specials/);
  });
});

describe('the purchase-invoice merge is a FILL, not a merge', () => {
  it('is a table this merger knows', () => {
    expect(MERGE_TABLES).toContain('purchase_invoice_items');
  });

  /* The predicate is the entire safety property of this writer: without it the
     statement would overwrite a line somebody has since filled in. Asserted on
     the SOURCE because there is no Postgres in this suite, the same way the
     rest of this file pins the sweeps' write shape. */
  it("carries `= '{}'::jsonb` on its WHERE so a line with a value is left alone", () => {
    const m = /UPDATE scm\.purchase_invoice_items SET[\s\S]*?RETURNING id/.exec(mergeLibSource);
    expect(m, 'no UPDATE scm.purchase_invoice_items statement in variant-merge.mjs').not.toBeNull();
    expect(m![0]).toContain("COALESCE(variants, '{}'::jsonb) = '{}'::jsonb");
    /* and no OTHER statement may carry it: the fill is this writer's alone */
    expect(mergeLibSource.split("COALESCE(variants, '{}'::jsonb) = '{}'::jsonb").length - 1).toBe(1);
  });

  it('takes no geometry columns — an invoice line mirrors no geometry decision of its own', () => {
    expect(mergeLibSource).toContain('purchase_invoice_items takes no geometry columns');
  });
});
