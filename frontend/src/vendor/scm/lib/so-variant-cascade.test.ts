// The master-follower variant rule (vendor/scm/lib/so-variant-cascade.ts).
//
// The owner's report this suite exists for: two sofa compartments ticked into
// one Sales Order in a SINGLE multi-add, then the fabric and the seat size
// typed on line 1. Line 2 stayed empty. The multi-add seeds line 2 from a
// master that has no variants YET, so a seed-only inherit can never fill it —
// only a live cascade can, which is what these tests pin.

import { describe, expect, test } from 'vitest';
import {
  cascadeMasterVariants,
  followerVariants,
  masterVariantsByCategory,
  seedableMasterVariants,
  seedFollowerVariants,
  CASCADE_CATEGORIES,
  NEVER_INHERITED_KEYS,
  type CascadeLine,
  type MasterVariantSnapshot,
} from './so-variant-cascade';

const sofa = (variants: Record<string, unknown> = {}): CascadeLine => ({ category: 'sofa', variants });

/** Drive a sequence of edits the way a form does: snapshot in, snapshot out. */
const run = (lines: CascadeLine[], prev: MasterVariantSnapshot, cats: ReadonlySet<string> | null = null) =>
  cascadeMasterVariants(lines, prev, cats);

describe('the owner report — two sofas added together, line 1 typed after', () => {
  test('line 2 follows the master typed AFTER both lines existed', () => {
    // Multi-add: both lines land with nothing on them.
    let lines = [sofa(), sofa()];
    let out = run(lines, {});
    expect(out.variants[1]).toEqual({});

    // Operator types the fabric and the seat size on LINE 1.
    lines = [sofa({ fabricCode: 'AMOR-12', seatHeight: '21' }), sofa(out.variants[1]!)];
    out = run(lines, out.masters);
    expect(out.variants[1]).toEqual({ fabricCode: 'AMOR-12', seatHeight: '21' });
  });

  test('a line added AFTER the master was filled catches up too', () => {
    const master = sofa({ fabricCode: 'AMOR-12', seatHeight: '21' });
    const out = run([master, sofa()], { sofa: master.variants });
    expect(out.variants[1]).toEqual({ fabricCode: 'AMOR-12', seatHeight: '21' });
  });
});

describe("the owner's ruling — the master's LATEST change wins", () => {
  test('a follower changed BY HAND is overwritten when the master moves again', () => {
    // This is the behaviour the old overriddenKeys veto blocked, and the owner
    // was told that before choosing this rule.
    const first = sofa({ seatHeight: '21' });
    let out = run([first, sofa()], {});
    expect(out.variants[1]).toEqual({ seatHeight: '21' });

    // Operator hand-changes line 2 to 23.
    const handEdited = sofa({ seatHeight: '23' });
    out = run([first, handEdited], out.masters);
    expect(out.variants[1]).toBe(handEdited.variants); // untouched — nothing moved

    // Line 1 now moves to 25. The master wins.
    const moved = sofa({ seatHeight: '25' });
    out = run([moved, handEdited], out.masters);
    expect(out.variants[1]).toEqual({ seatHeight: '25' });
  });

  test('a follower edit made after the master last moved is NOT stomped on the next tick', () => {
    // Without the snapshot the master would re-assert on every render and the
    // follower could never be edited at all.
    const master = sofa({ seatHeight: '21' });
    let out = run([master, sofa()], {});
    const handEdited = sofa({ seatHeight: '23' });
    out = run([master, handEdited], out.masters);
    out = run([master, handEdited], out.masters);
    out = run([master, handEdited], out.masters);
    expect(out.variants[1]).toEqual({ seatHeight: '23' });
  });

  test('the master is never itself a follower', () => {
    const master = sofa({ seatHeight: '21' });
    const out = run([master, sofa({ seatHeight: '23' })], {});
    expect(out.variants[0]).toBe(master.variants);
  });
});

describe('what never travels', () => {
  test('buildKey stays put — a follower must not be forged into the master sofa', () => {
    const out = run([sofa({ buildKey: 'B-1', seatHeight: '21' }), sofa()], {});
    expect(out.variants[1]).toEqual({ seatHeight: '21' });
    expect(out.variants[1]).not.toHaveProperty('buildKey');
  });

  test('remark stays per line', () => {
    const out = run([sofa({ remark: 'urgent', seatHeight: '21' }), sofa()], {});
    expect(out.variants[1]).toEqual({ seatHeight: '21' });
  });

  test('the never-inherit list is exactly those two', () => {
    expect([...NEVER_INHERITED_KEYS].sort()).toEqual(['buildKey', 'remark']);
  });

  test('a blank master value does not blank a follower', () => {
    const follower = sofa({ seatHeight: '23' });
    const out = run([sofa({ seatHeight: '' }), follower], { sofa: { seatHeight: '21' } });
    expect(out.variants[1]).toBe(follower.variants);
  });

  test('fabric identity does not cross between two DIFFERENT split sofas', () => {
    const out = run(
      [sofa({ buildKey: 'B-1', fabricCode: 'AMOR-12', seatHeight: '21' }), sofa({ buildKey: 'B-2' })],
      {},
    );
    // Seat size is category-wide; the colour is not.
    expect(out.variants[1]).toEqual({ buildKey: 'B-2', seatHeight: '21' });
  });

  test('fabric identity DOES cross between compartments of the same sofa', () => {
    const out = run(
      [sofa({ buildKey: 'B-1', fabricCode: 'AMOR-12' }), sofa({ buildKey: 'B-1' })],
      {},
    );
    expect(out.variants[1]).toEqual({ buildKey: 'B-1', fabricCode: 'AMOR-12' });
  });
});

describe('categories', () => {
  test('each category has its own master; a bedframe never drives a sofa', () => {
    const lines: CascadeLine[] = [
      { category: 'bedframe', variants: { gap: '2' } },
      sofa({ seatHeight: '21' }),
      { category: 'bedframe', variants: {} },
      sofa(),
    ];
    const out = run(lines, {});
    expect(out.variants[2]).toEqual({ gap: '2' });
    expect(out.variants[3]).toEqual({ seatHeight: '21' });
  });

  test('a line with no SKU picked neither masters nor follows', () => {
    const lines: CascadeLine[] = [{ category: '', variants: {} }, sofa({ seatHeight: '21' }), sofa()];
    const out = run(lines, {});
    expect(out.variants[0]).toEqual({});
    expect(out.variants[2]).toEqual({ seatHeight: '21' });
  });

  test('a restricted category set leaves everything else alone (the mobile surface)', () => {
    const lines: CascadeLine[] = [
      { category: 'mattress', variants: { specials: ['FIRM'] } },
      { category: 'mattress', variants: {} },
    ];
    expect(run(lines, {}, new Set(['sofa', 'bedframe'])).variants[1]).toEqual({});
    expect(run(lines, {}, null).variants[1]).toEqual({ specials: ['FIRM'] });
  });
});

/* THE OWNER'S RULING, 2026-09-09: 「主行改一次，全部跟着改 … 这个只限于 sofa
   item」. A sofa is ONE physical thing assembled from several lines, so its
   modules share a fabric and a leg height by construction. Three bedframes on
   one order are three beds.

   Pinned here because the cost of losing it is silent and was already paid: a
   rep removed a drawer from beds 2 and 3, touched bed 1 again, and the cascade's
   first rule (the master's latest change FORCES the follower) wrote it back —
   「remove 三次才没有」, HC-SO-012312. Widening CASCADE_CATEGORIES again would
   reintroduce that with nothing on screen to say so. */
describe("the sofa-only ruling", () => {
  test('CASCADE_CATEGORIES is sofa, and nothing else', () => {
    expect([...CASCADE_CATEGORIES]).toEqual(['sofa']);
  });

  test('a bedframe master does NOT force its followers', () => {
    const bed = (variants: Record<string, unknown> = {}): CascadeLine =>
      ({ category: 'bedframe', variants });
    /* Bed 1 carries a drawer; beds 2 and 3 do not. Under the ruling they stay
       that way even when bed 1 moves again — which is the exact sequence the
       rep hit. */
    const first = run([bed({ drawer: 'RIGHT' }), bed({}), bed({})], {}, CASCADE_CATEGORIES);
    expect(first.variants[1]).toEqual({});
    expect(first.variants[2]).toEqual({});
    const second = run(
      [bed({ drawer: 'RIGHT', gap: '14' }), bed({}), bed({})],
      first.masters,
      CASCADE_CATEGORIES,
    );
    expect(second.variants[1]).toEqual({});
    expect(second.variants[2]).toEqual({});
  });

  test('a sofa master still drives its followers — the rule it was kept for', () => {
    const out = run([sofa({ seatHeight: '21' }), sofa()], {}, CASCADE_CATEGORIES);
    expect(out.variants[1]).toEqual({ seatHeight: '21' });
  });

  /* The SEED is gated by the same set. Without this a new bedframe line still
     arrives pre-filled from bed 1 and only stops being RE-forced afterwards —
     which fixes the second removal and not the first. */
  test('the seed does not pre-fill a new bedframe line either', () => {
    const lines: CascadeLine[] = [
      { category: 'bedframe', variants: { drawer: 'RIGHT' } },
      { category: 'sofa', variants: { seatHeight: '21' } },
    ];
    expect(seedableMasterVariants(lines, CASCADE_CATEGORIES)).toEqual({
      sofa: { seatHeight: '21' },
    });
  });
});

describe('reference stability', () => {
  test('an unchanged line keeps its SAME variants object, so the form can bail out', () => {
    const master = sofa({ seatHeight: '21' });
    const follower = sofa({ seatHeight: '21' });
    const out = run([master, follower], { sofa: master.variants });
    expect(out.variants[0]).toBe(master.variants);
    expect(out.variants[1]).toBe(follower.variants);
  });

  test('the returned snapshot is what the next run diffs against', () => {
    const out = run([sofa({ seatHeight: '21' }), sofa()], {});
    expect(out.masters).toEqual({ sofa: { seatHeight: '21' } });
  });
});

describe('the seed helpers', () => {
  test('masterVariantsByCategory takes the FIRST line even when it is empty', () => {
    expect(masterVariantsByCategory([sofa(), sofa({ seatHeight: '21' })])).toEqual({ sofa: {} });
  });

  test('seedableMasterVariants skips an empty master — there is nothing to copy', () => {
    expect(seedableMasterVariants([sofa(), sofa({ seatHeight: "21" })], null)).toEqual({
      sofa: { seatHeight: '21' },
    });
  });

  test('seedFollowerVariants strips the never-inherited keys', () => {
    expect(seedFollowerVariants({ buildKey: 'B-1', remark: 'x', seatHeight: '21' })).toEqual({
      seatHeight: '21',
    });
  });

  test('seedFollowerVariants on nothing is an empty line, not a crash', () => {
    expect(seedFollowerVariants(undefined)).toEqual({});
    expect(seedFollowerVariants(null)).toEqual({});
  });
});

describe('followerVariants directly', () => {
  test('fills a blank string, not only a missing key', () => {
    expect(followerVariants({ seatHeight: '21' }, { seatHeight: '   ' }, { seatHeight: '21' }))
      .toEqual({ seatHeight: '21' });
  });
});
