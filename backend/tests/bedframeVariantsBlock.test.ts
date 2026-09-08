import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared by both importers, the PO top-up and the truth top-up
import { bedframeVariants, parseBedframe } from '../scripts/lib/parse-bedframe.mjs';

/* `bedframeVariants` was EXTRACTED, not written: the same ten-key object was
   spelled out in import-ac-outstanding-so.mjs, import-ac-outstanding-po.mjs and
   topup-ac-po-lines.mjs, byte-for-byte identical in all three, and a fourth
   writer (topup-ac-lines-from-truth.mjs) was about to add a fourth copy.
   parseBedframe itself was in exactly that state once and drifted TWICE before
   anyone noticed (a808bf36, 60125216), so the copies are the risk, not the
   sharing.

   This test is what makes the extraction checkable. `LITERAL_BLOCK` below is the
   expression those three files carried, transcribed verbatim; the module must
   agree with it on every field, for a plain bed, a hydraulic one, a
   TBC ("not chosen yet") colour and a bed with specials. If someone changes the
   shared block, this fails and names the field — which is the whole point,
   because the key names are a CONTRACT with the UI: the Fabrics picker reads
   `fabricCode` and the form shows `totalHeight` as "Total height (auto)". */

type Bf = {
  color?: string | null; gap?: number; divan?: number; leg?: number; specials?: string[];
};
type Colour = { fabric_id: string; colour_id: string; label: string } | null;

/** The three importers' own expression, transcribed. isPendingColour is
 *  /(TBC|KIV)/i (lib/fabric-colour-match.mjs) — restated here so this test does
 *  not verify the module against itself. */
const LITERAL_BLOCK = (bf: Bf, findColour: (c: string | null | undefined) => Colour) => {
  const pending = /(TBC|KIV)/i.test(bf.color || '');
  const fcHit = pending ? null : findColour(bf.color);
  const tot = (Number(bf.gap) || 0) + (Number(bf.divan) || 0) + (Number(bf.leg) || 0);
  return {
    fabricId: fcHit ? fcHit.fabric_id : null,
    colourId: fcHit ? fcHit.colour_id : null,
    fabricCode: fcHit ? fcHit.colour_id : null,
    colourLabel: fcHit ? fcHit.label : null,
    fabricLabel: fcHit ? fcHit.fabric_id : null,
    gap: bf.gap != null ? bf.gap + '"' : null,
    divanHeight: bf.divan != null ? bf.divan + '"' : null,
    legHeight: bf.leg != null ? bf.leg + '"' : null,
    totalHeight: tot ? tot + '"' : null,
    specials: bf.specials || [],
  };
};

/* A stand-in for lib/fabric-colour-match.mjs's resolver: it answers for the two
   codes these fixtures use and null for everything else, which is what an
   unknown colour looks like to a writer. */
const findColour = (c: string | null | undefined): Colour => {
  const k = String(c ?? '').trim().toUpperCase();
  if (k === 'PC151-01') return { fabric_id: 'PC151', colour_id: 'PC151-01', label: 'Ivory' };
  if (k === 'PC-151-02') return { fabric_id: 'PC151', colour_id: 'PC151-02', label: 'Sand' };
  return null;
};

/* Verbatim Desc2 from ac-reconcile-truth.json.gz, 2026-09-08 08:03 cut — the
   five section-B lines this extraction was made for, plus two shapes that
   exercise the branches those five do not. */
const DESC2 = [
  'Col:PC-151-02/Divan:8"+NoLeg/Gap:14"',                         // SO-011752 DtlKey 917574
  'Divan:8"+NoLeg/Col:PC-151-01/Gap:14"',                         // SO-011752 DtlKey 806472
  "COL:151-03/DIVAN:10'INCH NO LEG/BOTTOM DIVAN FULLY COVER",     // SO-010602 DtlKey 919061
  'divan:8inch+4inchleg/m.gap:10inch/col:pc151-01',               // SO-007362 DtlKey 918904
  'Clr:TBC/Divan:8"+TBC"legs/Gap:14"',                            // a colour not chosen yet
  'Col:PC151-01(hydraulic 16”/Inner 14”/4Pump)',                  // the hydraulic branch
  'HB straight to wall/ DIVAN: 8"/ GAP: 12"/ COL: PC151-01',      // specials
];

describe('bedframeVariants is the importers\' own block, stated once', () => {
  for (const d2 of DESC2) {
    test(`agrees with the transcribed literal: ${d2.slice(0, 42)}`, () => {
      const bf = parseBedframe(d2);
      expect(bedframeVariants(bf, findColour)).toEqual(LITERAL_BLOCK(bf, findColour));
    });
  }

  test('the ten keys the UI reads are all present, and no eleventh', () => {
    const b = bedframeVariants(parseBedframe(DESC2[0]), findColour);
    expect(Object.keys(b).sort()).toEqual([
      'colourId', 'colourLabel', 'divanHeight', 'fabricCode', 'fabricId',
      'fabricLabel', 'gap', 'legHeight', 'specials', 'totalHeight',
    ]);
  });

  test('a colour the library knows resolves; totalHeight is gap + divan + leg', () => {
    const b = bedframeVariants(parseBedframe('divan:8inch+4inchleg/m.gap:10inch/col:pc151-01'), findColour);
    expect(b.colourId).toBe('PC151-01');
    expect(b.fabricCode).toBe('PC151-01');   // the Fabrics picker reads THIS key
    expect(b.colourLabel).toBe('Ivory');
    expect(b.gap).toBe('10"');
    expect(b.divanHeight).toBe('8"');
    expect(b.legHeight).toBe('4"');
    expect(b.totalHeight).toBe('22"');
  });

  test('TBC is not a miss — the colour is simply not chosen yet, so it is blank', () => {
    const b = bedframeVariants(parseBedframe('Clr:TBC/Divan:8"+TBC"legs/Gap:14"'), findColour);
    expect(b.colourId).toBeNull();
    expect(b.colourLabel).toBeNull();
    expect(b.divanHeight).toBe('8"');
  });

  test('specials ride in the block, never as undefined', () => {
    const b = bedframeVariants(parseBedframe('HB straight to wall/ DIVAN: 8"/ GAP: 12"/ COL: PC151-01'), findColour);
    expect(Array.isArray(b.specials)).toBe(true);
    expect(b.specials).toContain('HB Straight');
    expect(bedframeVariants(parseBedframe('Col:PC151-01'), findColour).specials).toEqual([]);
  });

  test('a height that was never stated stays null — it is not zero', () => {
    const b = bedframeVariants(parseBedframe('Col:PC151-01'), findColour);
    expect(b.gap).toBeNull();
    expect(b.divanHeight).toBeNull();
    expect(b.totalHeight).toBeNull();
  });
});
