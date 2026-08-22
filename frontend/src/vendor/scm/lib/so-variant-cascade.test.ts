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
    expect(seedableMasterVariants([sofa(), sofa({ seatHeight: '21' })])).toEqual({
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
