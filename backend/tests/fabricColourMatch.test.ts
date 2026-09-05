import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared by the importers and the refresh scripts
import { buildFabricColourIndex, colourForms, foldColour, isPendingColour, pendingColourKind } from '../scripts/lib/fabric-colour-match.mjs';

/* Golden test for the ONE fabric-colour matcher. Every string below is a real
   colour written on a real AutoCount document; every library row below is a
   real row of scm.fabric_colours on company 1, taken from the 2026-08-10 prod
   dump (probe-fabric-colours.yml, target=prod, dump=1 -> 133 series / 724
   colours). Five scripts used to carry five hand-copied matchers and they had
   drifted; this file is the reason the next edit cannot drift silently. */

type Row = { fabric_id: string; colour_id: string; label: string };
const row = (fabric_id: string, colour_id: string, label = colour_id): Row => ({ fabric_id, colour_id, label });

// A faithful slice of the live library - the series every case below needs.
const LIBRARY: Row[] = [
  row('BO315', 'BO315-1'), row('BO315', 'BO315-1-PEARL'), row('BO315', 'BO315-2'),
  row('BO315', 'BO315-2-FEATHER'), row('BO315', 'BO315-3'), row('BO315', 'BO315-3-BEIGE'),
  row('BO315', 'BO315-4'), row('BO315', 'BO315-4-SAND'), row('BO315', 'BO315-5'),
  row('BO315', 'BO315-5-FOSSIL'), row('BO315', 'BO315-9', 'Mint'), row('BO315', 'BO315-10-SILVER'),
  row('BO315', 'BO315-11'), row('BO315', 'BO315-21'), row('BO315', 'BO315-22'),
  row('BO315', 'BO315-23', 'LITE-01'), row('BO315', 'BO315-25'), row('BO315', 'BO315-31'),
  row('MODENZA', 'MODENZA-01', 'MODENZA-01 HOUSTON CREAM'), row('MODENZA', 'MODENZA-02', 'MODENZA-02 BARLEY'),
  row('MODENZA', 'MODENZA-05'), row('MODENZA', 'MODENZA-06'),
  row('HR805', 'HR805-10'), row('HR805', 'HR805-31'), row('HR805', 'HR805-40'), row('HR805', 'HR805-90'),
  row('GD2502', 'GD2502-04', 'GD2502#04 OAK'), row('GD2502', 'GD2502-09', 'GD2502#09 SANDY'),
  row('GD2502', 'GD2502-18', 'GD2502#18 GREY'),
  row('HIRRING GD8371', 'HIRRING GD8371-02# BEIGE', 'GD8371-02# BEIGE'),
  row('HIRRING GD8371', 'HIRRING GD8371-03# STRAW', 'GD8371-03# STRAW'),
  row('HIRRING GD8371', 'HIRRING GD8371-15# DARK GREY', 'GD8371-15# DARK GREY'),
  row('HIVE GD2034', 'HIVE GD2034-03# STRAW', 'GD2034-03# STRAW'),
  row('GARFIELD', 'GARFIELD-1', 'GARFIELD-1 SOFT LINEN'),
  row('ARMANI J9226', 'ARMANI J9226-01 SAND', 'J9226-01 SAND'),
  row('ARMANI J9226', 'ARMANI J9226-13 WARM GREY', 'J9226-13 WARM GREY'),
  row('GIRONA J9047', 'GIRONA J9047-01 BEUNETTE', 'J9047-01 BEUNETTE'),
  row('GIRONA J9047', 'GIRONA J9047-02 AMBER', 'J9047-02 AMBER'),
  row('J9883', 'J9883-2', 'J9883-2 CHIC'),
  row('CHANTIC', 'CHANTIC-141-2', 'CHANTIC 141-2'),
  row('WOWSONS', 'WOWSONS-8877-3', 'WOWSONS 8877-3 HAZELNUT'),
  row('ZL', 'ZL-3'), row('ZL', 'ZL-6', 'ZL-6 (ZANO LEATHER)'), row('ZL', 'ZL-20', 'ZL-20 BLACK (ZANO LEATHER)'),
  row('NX', 'NX007'), row('NX', 'NX010', 'NX010 IVORY'), row('NX', 'NX011', 'NX011 BEIGE'),
  row('PC151', 'PC151-01'), row('PC151', 'PC151-02'), row('PC151', 'PC151-03'),
  row('PC151', 'PC151-10'), row('PC151', 'PC151-11'), row('PC151', 'PC151-17'),
  row('STAR', 'STAR-10 NAVY', 'NAVY'), row('STAR 01', 'STAR 01'), row('STAR 02', 'STAR 02'),
  row('SF', 'SF-AT 03', '03'), row('SF', 'SF-AT 07', '07'),
  row('CH141', 'CH141-1'), row('CH141', 'CH141-1-CREAM'),
  row('CH141', 'CH141-13', 'GREY'), row('CH141', 'CH141-13-CHARCOAL'),
  row('PHOENIX', 'PHOENIX-1', 'PHOENIX-1 OYSTER'),
  row('NINJA 02', 'NINJA 02'), row('NINJA 03', 'NINJA 03'),
  row('ORION', 'ORION-01'), row('ORION', 'ORION-1'), row('ORION', 'ORION-5'),
];

const { findColour } = buildFabricColourIndex(LIBRARY);
const hit = (s: string): string | null => { const h = findColour(s) as Row | null; return h ? h.colour_id : null; };

describe('the ladder: every rung on a string a document really carries', () => {
  test('rung 1 - a parenthesised name is not part of the code', () => {
    expect(hit('BO315-3(Beige)')).toBe('BO315-3-BEIGE');
    expect(hit('BO315-5 fossil (booboo fabric)')).toBe('BO315-5-FOSSIL');
    expect(hit('ZL-20 BLACK (ZANO LEATHER)')).toBe('ZL-20');
  });

  test('rung 2 + 3 - "#" separates, and the trailing colour NAME is dropped', () => {
    expect(hit('GD2502#09-SANDY')).toBe('GD2502-09');
    expect(hit('GD 2502#09- sandy')).toBe('GD2502-09');
    expect(hit('GD2502# 18- GREY')).toBe('GD2502-18');
    expect(hit('GD2034-03#')).toBe('HIVE GD2034-03# STRAW');
    expect(hit('CH141-13 deep grey')).toBe('CH141-13');
  });

  test('rung 4 - the code survives being written with spaces in it', () => {
    expect(hit('HR 805-40')).toBe('HR805-40');
    expect(hit('HR805-40')).toBe('HR805-40');
  });

  test('rung 5 - the code is buried in prose', () => {
    expect(hit('BEETEX HARRING GD8371 02# BEIGE')).toBe('HIRRING GD8371-02# BEIGE');
    expect(hit('HARRING GD 8371 02-BEIGE')).toBe('HIRRING GD8371-02# BEIGE');
    expect(hit('HARRING GD8371 15#DARIL GREY')).toBe('HIRRING GD8371-15# DARK GREY');
    expect(hit('HUGYP MADE WOWSON 8877-3')).toBe('WOWSONS-8877-3');
    expect(hit('Modenza 01*Bottom wrap Nylon Fabric *L Shape total length Cut 1Feet')).toBe('MODENZA-01');
  });

  test('rung 6 - a one-digit tail means the zero-padded colour', () => {
    expect(hit('Modenza 5')).toBe('MODENZA-05');
    expect(hit('J9226-1-Sand')).toBe('ARMANI J9226-01 SAND');
    expect(hit('J9047-1-Brunette')).toBe('GIRONA J9047-01 BEUNETTE');
    expect(hit('J9047-2 Amber')).toBe('GIRONA J9047-02 AMBER');
    expect(hit('151-03')).toBe('PC151-03');
  });
});

describe('rung 7: doubled letters collapse BEFORE letter-O becomes zero', () => {
  /* The order is the whole point. O->0 first turns BOO315 into B00315, whose
     doubled character is a ZERO, and the letter-collapse then leaves B0315 -
     so every BOO* spelling misses. Assert the order at the fold itself. */
  test('the fold puts BOO315, BO315 and B0315 on one key', () => {
    expect(foldColour('BOO315-23')).toBe(foldColour('BO315-23'));
    expect(foldColour('B0315-23')).toBe(foldColour('BO315-23'));
    expect(foldColour('BOOBOO315-1')).toBe(foldColour('BO315-1'));
  });

  test('every real spelling of the BO315 series lands on its own colour', () => {
    expect(hit('BOO315-23')).toBe('BO315-23');
    expect(hit('B0315-21')).toBe('BO315-21');
    expect(hit('BOO315-11')).toBe('BO315-11');
    expect(hit('BOO315-25')).toBe('BO315-25');
    expect(hit('BOOBOO315-1')).toBe('BO315-1');
    expect(hit('B0315-2 feather')).toBe('BO315-2-FEATHER');
  });

  test('a letter typo is corrected, a doubled code is de-duplicated', () => {
    expect(hit('Mordenza 06')).toBe('MODENZA-06');
    expect(hit('grafield1-softlinen')).toBe('GARFIELD-1');
    expect(hit('ZL-6 Lether')).toBe('ZL-6');
    expect(hit('HC151-17')).toBe('PC151-17');
  });
});

describe('the digit guard: a colour NUMBER is an identity, never a spelling', () => {
  /* Each of these bound to a DIFFERENT real fabric before the guard existed.
     Refusing is the correct answer: an unbound line is fixed by a human, a
     wrongly bound one is upholstered in the wrong cloth. */
  test('a number is never truncated to reach a shorter colour', () => {
    expect(hit('B0315-27')).toBeNull(); // was BO315-2
    expect(hit('B0315-29')).toBeNull(); // was BO315-2
  });

  test('a number is never transposed or substituted to reach a neighbour', () => {
    expect(hit('STAR-10')).toBe('STAR-10 NAVY'); // was "STAR 01"
    expect(hit('HR805-20')).toBeNull(); // was HR805-40
    expect(hit('HR805-30')).toBeNull(); // genuinely absent
    expect(hit('Chantic141-5')).toBeNull(); // was CHANTIC-141-2
    expect(hit('J9833-2')).toBeNull(); // was J9883-2 - the digits differ
  });

  test('a two-character label is not a code, so a bare number cannot claim it', () => {
    expect(hit('03#Straw')).toBeNull(); // was SF-AT 03, whose LABEL is "03"
    expect(hit('7# CHARCOAL')).toBeNull(); // was SF-AT 07
  });

  /* A comma list is the one place the matcher still answers from part of the
     string: "B0315-9, 7, 8,12" yields the FIRST code, because that is the only
     complete one written. "ninja - 02,03,07,09" names no complete code at all
     and the prefix guard refuses to cut "NINJA02" out of "NINJA0203..." mid
     number, so it stays null. Documented, not accidental. */
  test('a line that names several colours takes the first COMPLETE code, or none', () => {
    expect(hit('B0315-9, 7, 8,12')).toBe('BO315-9');
    expect(hit('ninja - 02,03,07,09')).toBeNull();
  });
});

describe('what must stay unresolved', () => {
  test('an incomplete code is not a colour', () => {
    for (const s of ['PC151-', 'PC 151-', 'PC-151', 'pc151', 'P151-', 'NB-', 'BO315', 'HD']) {
      expect(hit(s)).toBeNull();
    }
  });

  test('free text is not a colour', () => {
    for (const s of ['random', 'ramdon', 'SAME SERIES', 'Bottom Use Nylon Fabric', 'tbc']) {
      expect(hit(s)).toBeNull();
    }
  });

  test('a colour the library genuinely lacks stays null rather than guessing', () => {
    for (const s of ['CHINO -12', 'MODENZA 04-MUSTARD', 'GD2502#14', 'Nicca 06-Fog', 'ORION 4)', 'HR 805-9']) {
      expect(hit(s)).toBeNull();
    }
  });

  test('a name with no code cannot LEXICALLY pick a numbered colour out of its series', () => {
    /* These two now resolve, but through COLOUR_ALIAS, not through a rung -
       see the alias block below. What must stay true is that no rung reaches
       them, which is what these folds assert: the document string and the
       library key share no common form. */
    expect(foldColour('Modenza-Houston Cream')).not.toBe(foldColour('MODENZA-01 HOUSTON CREAM'));
    expect(foldColour('Harring 02# beige')).not.toBe(foldColour('HIRRING GD8371-02# BEIGE'));
  });
});

describe('COLOUR_ALIAS: the last-resort table', () => {
  /* Five document spellings that name a colour the library REALLY HOLDS, which
     no rung can reach because the miss is not a typo - the document writes the
     identity a different way. Widening a rung to catch them would have to let a
     query match a key it shares no number with, which is the door the digit
     guard closes. Each case below is a live migrated sofa line. */
  test('the number is absent from the document', () => {
    expect(hit('Modenza-Houston Cream')).toBe('MODENZA-01'); // 10 live lines
  });

  test('the series letters are absent from the document', () => {
    expect(hit('141-1')).toBe('CH141-1'); // 2 live lines
    expect(hit('9226-13')).toBe('ARMANI J9226-13 WARM GREY'); // 2 live lines
  });

  test('the brand is written instead of the series code', () => {
    // one alias entry covers both spellings, because it is keyed by the fold
    expect(hit('Harring 02# Beige')).toBe('HIRRING GD8371-02# BEIGE');
    expect(hit('Harring 02# beige')).toBe('HIRRING GD8371-02# BEIGE');
  });

  test('the number trails the colour NAME instead of leading it', () => {
    /* The sharpest case: PHOENIX-1 OYSTER was CREATED by
       create-missing-sofa-fabrics and the string was still unresolved
       afterwards, so creating a row had never been the fix. */
    expect(hit('Phoenix-oyster1')).toBe('PHOENIX-1');
  });

  test('an alias whose row is not in the library goes inert, never invents it', () => {
    const bare = buildFabricColourIndex([row('MODENZA', 'MODENZA-05')]);
    expect(bare.findColour('Modenza-Houston Cream')).toBeNull();
    expect(bare.aliasUnresolved.length).toBeGreaterThan(0);
  });

  test('the alias runs LAST, so it cannot displace a lexical answer', () => {
    /* Same fold key as the "141-1" alias, but this library resolves it
       lexically to a different row - the lexical answer must win. */
    const other = buildFabricColourIndex([row('CH141', 'CH141-1'), row('AM275', '141-1', 'AM275 141-1')]);
    expect((other.findColour('141-1') as Row).colour_id).toBe('141-1');
  });

  test('the alias does not rescue what is genuinely ambiguous or not a colour', () => {
    expect(hit('03#Straw')).toBeNull(); // HIRRING GD8371-03# STRAW vs HIVE GD2034-03# STRAW
    expect(hit('J9833-2')).toBeNull(); // J9883-2 with two digits transposed
    expect(hit('Bottom Use Nylon Fabric')).toBeNull();
    expect(hit('ninja - 02,03,07,09')).toBeNull();
  });
});

describe('colourForms keeps the untouched original first', () => {
  test('the faithful spelling always leads, so it always wins', () => {
    expect(colourForms('BO315-1 PEARL')[0]).toBe('BO315-1 PEARL');
    expect(hit('BO315-1 PEARL')).toBe('BO315-1-PEARL'); // not the bare BO315-1
  });
});

/* ---------------------------------------------------------------------------
   THE 2026-09-04 CLASSES. The owner's instruction was "同类问题也解决" after
   seeing four rows where the book and the library plainly name the same fabric.
   Every library row below is real: SELECT fabric_id, colour_id, label, active
   FROM scm.fabric_colours WHERE company_id = 1, run on 2026-09-04, returned 949
   rows - 849 active and 100 superseded by the 2026-08-11 renumbering.
   --------------------------------------------------------------------------- */
type ARow = Row & { active: boolean };
const arow = (fabric_id: string, colour_id: string, label: string, active = true): ARow =>
  ({ fabric_id, colour_id, label, active });

/* The renumbering pairs, the two labels that genuinely collide, and the series
   whose numbers must never be confused with each other. */
const LIVE: ARow[] = [
  arow('CH141', 'CH141-08', 'CH141-08 ARMY'),
  arow('CH141', 'CH141-8', 'CH141-8 [superseded by CH141-08 on 2026-08-11]', false),
  arow('GARFIELD', 'GARFIELD-01', 'GARFIELD-01'),
  arow('GARFIELD', 'GARFIELD-1-SOFT LINEN', 'LINEN [superseded by GARFIELD-01 on 2026-08-11]', false),
  arow('NV', 'NV-01', 'NV-01 WP'),
  arow('NV', 'NV-01 WP', 'WP [superseded by NV-01 on 2026-08-11]', false),
  arow('BO315', 'BO315-21', 'BO315-21 PEARL'),
  arow('PC151', 'PC151-01', 'PC151-01'),
  arow('PC151', 'PC151-13', 'PC151-13'),
  arow('WOWSONS-8877', 'WOWSONS-8877-03', 'WOWSONS-8877-03'),
  arow('STAR', 'STAR-01', 'STAR-01'),
  arow('STAR', 'STAR-10', 'STAR-10 NAVY'),
  // the REAL collision: two LIVE rows whose whole label is the word CREAM
  arow('CASSNYE', 'CASSNYE-04', 'CREAM'),
  arow('TARONI', 'TARONI-01', 'CREAM'),
];
const live = buildFabricColourIndex(LIVE);
const lhit = (s: string): string | null => {
  const h = live.findColour(s) as ARow | null;
  return h ? h.colour_id : null;
};

describe('the four classes the owner named on 2026-09-04', () => {
  test('a bad extraction is still the same code - "COL: " is not part of it', () => {
    expect(lhit('COL: PC151-01')).toBe('PC151-01');
    expect(lhit('Col:PC151-01')).toBe('PC151-01');
  });

  test('a dash in the wrong place is the same code', () => {
    /* The book writes "COL:PC-151-01". The DECODER strips the COL: marker
       (parse-bedframe.mjs) and hands the matcher what is left - so this is the
       string the matcher is actually asked, and the marker case is asserted
       one test above where colourForms can lift a code out of prose. */
    expect(lhit('PC-151-01')).toBe('PC151-01');
    expect(lhit('PC 151-01')).toBe('PC151-01');
    expect(lhit('PC151 - 01')).toBe('PC151-01');
  });

  test('a missing zero is the same code, and it resolves to the LIVE row', () => {
    // the book says "CH141-8 army"; CH141-8 was superseded by CH141-08 ARMY
    expect(lhit('CH141-8 army')).toBe('CH141-08');
    expect(lhit('CH141-8')).toBe('CH141-08');
    expect(lhit('grafield1-softlinen')).toBe('GARFIELD-01');
    expect(lhit('NV-1WP')).toBe('NV-01');
    expect(lhit('HUGYP MADE WOWSON 8877-3')).toBe('WOWSONS-8877-03');
  });

  test('case alone is not a difference', () => {
    expect(lhit('BO315-21 pearl')).toBe('BO315-21');
    expect(lhit('bo315-21 PEARL')).toBe('BO315-21');
  });
});

describe('the widening REFUSES a collision - it never picks one of two', () => {
  /* This is the whole design constraint. CASSNYE-04 and TARONI-01 both carry
     the label CREAM, both live, and the bedframe decoder reads a bare
     "Cream/Divan10/Gap13" as a colour. Before 2026-09-04 the exact index was
     first-wins, so it answered CASSNYE-04 with a coin toss's confidence. */
  test('two LIVE rows on one key resolve to neither', () => {
    expect(lhit('CREAM')).toBeNull();
    expect(lhit('Cream')).toBeNull();
    expect(live.exactRefused.has('CREAM')).toBe(true);
    expect(live.paddedRefused.has('CREAM')).toBe(true);
  });

  test('a superseded predecessor is NOT a second identity - the live row takes the key', () => {
    // CH141-8 and CH141-08 pad to the same key; one of the two is active = false
    expect(live.paddedRefused.has('CH14108')).toBe(false);
    expect(lhit('CH141-08')).toBe('CH141-08');
  });

  test('without the active fact, a two-row key is refused - absence is STRICTER', () => {
    const noFlag = buildFabricColourIndex([
      row('CH141', 'CH141-08', 'CH141-08 ARMY'),
      row('CH141', 'CH141-8', 'CH141-8 [superseded by CH141-08 on 2026-08-11]'),
    ]);
    expect(noFlag.paddedRefused.has('CH14108')).toBe(true);
    // the faithful spelling still resolves through the exact index
    expect((noFlag.findColour('CH141-8') as Row).colour_id).toBe('CH141-8');
  });

  test('padding never moves a number onto its neighbour', () => {
    expect(lhit('STAR-1')).toBe('STAR-01');
    expect(lhit('STAR-10')).toBe('STAR-10');
  });

  test('padding may not manufacture a two-character key', () => {
    const sf = buildFabricColourIndex([arow('SF', 'SF-AT 07', '07'), arow('SF', 'SF-AT 03', '03')]);
    expect(sf.findColour('7# CHARCOAL')).toBeNull();
    expect(sf.findColour('03#Straw')).toBeNull();
  });
});

describe('pendingColourKind names the two things TBC means', () => {
  const find = live.findColour as (s: string) => unknown;
  test('a bare marker is the colour NOT being chosen', () => {
    expect(pendingColourKind('COL: TBC', find)).toBe('only');
    expect(pendingColourKind('KIV', find)).toBe('only');
    expect(pendingColourKind('PC151- TBC', find)).toBe('only'); // no number written
  });

  test('a marker BESIDE a library colour is a different fact', () => {
    expect(pendingColourKind('BO315-21Pearl(TBC)', find)).toBe('qualified');
    expect(pendingColourKind('PC151-01TBC', find)).toBe('qualified');
    expect(pendingColourKind('PC151-13 tbc', find)).toBe('qualified');
  });

  test('no marker at all is neither', () => {
    expect(pendingColourKind('PC151-01', find)).toBe('none');
  });

  test('the library lookup is REQUIRED, not optional', () => {
    // @ts-expect-error - deliberately calling it the way a forgetful caller would
    expect(() => pendingColourKind('BO315-21 (TBC)')).toThrow(/required/);
  });

  test('isPendingColour itself is UNCHANGED - no existing caller moves', () => {
    expect(isPendingColour('BO315-21Pearl(TBC)')).toBe(true);
    expect(isPendingColour('COL: TBC')).toBe(true);
    expect(isPendingColour('PC151-01')).toBe(false);
  });
});

describe('explainColour says WHICH mechanism answered', () => {
  test('a faithful spelling reports the exact pass and no widening', () => {
    const e = live.explainColour('PC151-01') as { via: string; padded: boolean; redirected: boolean };
    expect(e.via).toBe('exact');
    expect(e.padded).toBe(false);
    expect(e.redirected).toBe(false);
  });

  test('a superseded answer reports the redirect, so a probe can count it', () => {
    const e = live.explainColour('CH141-8') as { redirected: boolean };
    expect(e.redirected).toBe(true);
  });
});
