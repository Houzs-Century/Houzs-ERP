import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared by the SO and PO importers
import { parseSofa } from '../scripts/lib/parse-sofa.mjs';

/* Two reader defects on the account book's sofa text, both measured over all
   9,029 sofa Desc2 in the committed cut and on all six document types:
   `docs/bugs/0740` (the colour label `Clr:`) and `docs/bugs/0741` (the leg).
   In BOTH the ERP is right and only our reader of the book was wrong, so every
   expectation below is the value the BOOK states — never "whatever the ERP
   happens to hold", which is the shape that let the TBC-divan bug read 12" on
   both sides and pass.

   The third block is the regression fence. Teaching the label a fourth spelling
   reaches three strings the colour-end rule had never been asked about, and all
   three decoded WORSE. Those three are pinned here as gold cases so a later
   widening of `splitColourValue` cannot quietly reopen them. */

type Parsed = {
  pieces: string[];
  size: string | null;
  color: string | null;
  leg: number | null;
  specials: string[];
  conf: string;
};
const P = (d2: string, model = '8030', recl = false): Parsed =>
  parseSofa(d2, model, recl) as Parsed;
/* The live reader consults scm.fabric_colours. A test must not, so the oracle
   is explicit: recognise anything code-shaped. Every case below is chosen so
   the answer does not depend on it — the labelled-colour path never asks. */
const anyCode = (c: string) =>
  /^[A-Z]{1,8}\s?[-#]?\s?\d/i.test(String(c).trim()) ? String(c).trim().toUpperCase() : null;
const PK = (d2: string, model = '8030', recl = false): Parsed =>
  parseSofa(d2, model, recl, { knownColour: anyCode }) as Parsed;

describe('parse-sofa: `Clr:` is the colour label (owner 2026-09-09 -- CLR 应该是colour)', () => {
  /* THE DOCUMENT THIS WAS FOUND ON. The book's whole build text is four words.
     The ERP holds 9028-2A(LHF) + 9028-L(RHF) -- a two-seater and a chaise --
     which is what that says. An unmatched label is not skipped: it stays in the
     text and the structure pass glues it to the token in front of it, so the
     chaise `L` was eaten and re-emerged as an invented special `LCLR`. */
  test('HC-SO-007293: "2S+L Clr: B0315-21 Pearl" is a two-seater and a chaise', () => {
    const o = P('2S+L Clr: B0315-21 Pearl', '9028');
    expect(o.pieces).toEqual(['2A(LHF)', 'L(RHF)']);
    expect(o.color).toBe('B0315-21 Pearl');
    expect(o.specials).toEqual([]);
  });

  test('the phantom `LCLR` special the label used to invent is gone', () => {
    expect(P('2S+ L clr: FG300-07', '9028').specials).toEqual([]);
    expect(P('2S+L Clr: Ninja 02', '9028').pieces).toEqual(['2A(LHF)', 'L(RHF)']);
  });

  test('a bare `CLR` left over in the structure is no longer a special order', () => {
    expect(P('1R(30")+ C + 2R (30") Clr: HR805-90', '9028').specials).toEqual([]);
  });

  /* CENSUSED, NOT GUESSED: every token in front of a ':' or '-' across all
     9,029 sofa Desc2 on all six document types. The colour vocabulary of this
     book is exactly these four spellings -- COL 5,613, COLOUR 705, COLOR 153,
     CLR 59 -- and a fifth must be measured the same way before it is added. */
  test('all four spellings the book actually uses reach the colour', () => {
    for (const label of ['COL', 'Colour', 'color', 'Clr']) {
      expect(P(`2S(30") ${label}: B0315-21`, '9028').color).toBe('B0315-21');
    }
  });
});

describe('parse-sofa: the colour label must not eat what comes after the shade', () => {
  /* REGRESSION 1. "-Wrap bottom to nylon" is an INSTRUCTION written as a
     bullet, and the naive fix put it inside the shade name. */
  test('SO-013475: an instruction opened by " -" ends the colour and stays a special', () => {
    const o = P('2S(35") Clr: HR805-30 -Wrap bottom to nylon  -Fully covered to bottom (replace legs)', '8030');
    expect(o.color).toBe('HR805-30');
    expect(o.specials.some((s) => /wrap bottom to nylon/i.test(s))).toBe(true);
    expect(o.specials.some((s) => /fully covered to bottom/i.test(s))).toBe(true);
  });

  /* REGRESSION 2. A seat size is never part of a shade's name. */
  test('SO-006807: a trailing seat size ends the colour and is still read as the size', () => {
    const o = P('1S+1L Clr: Garfield 1-soft linen 44" per seat including handle', '9028');
    expect(o.size).toBe('44');
    expect(o.color).toBe('Garfield 1-soft linen');
  });

  /* THE OTHER DIRECTION, and it is the one that costs a colour. A shade
     CONTINUES after its own dash -- with a space or with a digit -- so the cut
     fires only where a letter follows the dash immediately. Without this,
     five shades lost their number and "M2402 -18 LIGHT GREY" also took its
     three correct pieces down to none. */
  test('a shade that continues after its own dash keeps its number', () => {
    expect(P('colour : ninja - 02,03,07,09  wrap bottom to umbrella fabric', '8030').color)
      .toBe('ninja - 02,03,07,09');
    expect(P('colour : GD2502#22 - INK  wrap bottom to Nilon', '8030').color).toBe('GD2502#22 - INK');
    expect(P('22 " per seat (L+1na+1ER) colour :M2402 -18 LIGHT GREY  wrap bottom to Nilon (umbrella fabric)', '8030').pieces)
      .toEqual(['L(LHF)', '1NA', '1A(RHF)']);
  });

  /* A size with a '+' still to come is a PER-PIECE size inside a build, not the
     end of a colour. Cutting there ended the colour mid piece-list and moved a
     seat size onto a total LENGTH. */
  test('a per-piece size inside a build does not end the colour', () => {
    const o = P('(L+2)26inch/Col:Modenza 01*Bottom wrap Nylon Fabric *L Shape total length Cut 1Feet Total 170cm+-', '8030');
    expect(o.size).toBe('26');
  });
});

describe('parse-sofa: "1EL/T" is the chaise, not a slash the splitter may cut', () => {
  /* REGRESSION 3, and the reason it is a defect in its own right. The
     slash-SPLITTER cuts "1EL/T(35")+ 2ER(35")" into a bare "1EL" and a
     "T(35")+ 2ER(35")"; the second half then decodes to a whole sofa on its own
     and the chaise is gone. The leftover-segment guard cannot see it, because
     that guard only inspects segments containing a '+'. */
  test('SO-003951: "1EL/T(35\\")+ 2ER(35\\") Clr- J9226-3 Mocassin" keeps its chaise', () => {
    const o = P('1EL/T(35")+ 2ER(35") Clr- J9226-3 Mocassin', '5527');
    expect(o.pieces).toEqual(['L(LHF)', '2A(RHF)']);
    expect(o.color).toBe('J9226-3 Mocassin');
  });

  test('a build read one piece short at HIGH confidence is corrected', () => {
    expect(P('[ 1EL/T(32") + 2ER(32") / COL: GD2034-03# STRAW', '5526').pieces)
      .toEqual(['L(LHF)', '2A(RHF)']);
    expect(P('(2EL+1EL/T) / COL: Y9883-2-CHIC', '5526').pieces)
      .toEqual(['2A(LHF)', 'L(RHF)']);
  });

  /* ONLY EL. The owner named ELT and 2ER on 2026-09-04 and no "ERT" arm is
     invented here, so "1ER/T" keeps exactly the reading it has today (["2S"],
     measured on the committed cut) rather than gaining a chaise this repo has
     no ruling for. Pinned so a later widening to `E[LR]/T` has to come with
     his word. */
  test('"1ER/T" is untouched -- no ERT arm is invented', () => {
    expect(P("[1ER/T (32'') + 2EL (32'') / COL: GD8371-13#]", '5526').pieces).toEqual(['2S']);
  });
});

describe('parse-sofa: a leg height is a height, not a special order', () => {
  /* THE DOCUMENT THIS WAS FOUND ON, and it is PROCEEDED. The ERP holds
     legHeight "1\"" on all three compartment rows and its specials list is
     correctly EMPTY; the reader had no leg axis, filed the leg under specials,
     and the report said the book asked for a special the line does not tick. */
  test('HC-SO-010284: "LEG 1\\"" is the leg axis and the specials list is empty', () => {
    const o = PK('1ER + 1NA + 1EL (35") / COL: M2402-04 SAND / LEG 1"', '9058');
    expect(o.leg).toBe(1);
    expect(o.specials).toEqual([]);
    expect(o.pieces).toEqual(['1A(RHF)', '1NA', '1A(LHF)']);
    expect(o.size).toBe('35');
  });

  test('the height is read whichever side of the word it is written', () => {
    expect(PK('2R+1R/Size:28"/Col:CH141-Deep Grey/Add 1inch leg', '9058').leg).toBe(1);
    expect(PK('1EL + 1NA + 1ER  ( 30 inch )  colour : B0315-3  2 inch leg', '9058').leg).toBe(2);
    expect(PK('3S/ Size: 28"/ Col: BO315-23 Beige/ 4inch leg', '9058').leg).toBe(4);
    expect(PK('ZL-12Tan/28"/2s/3"leg (without Recliner)', '9058').leg).toBe(3);
  });

  /* AN INSTRUCTION IS NOT A MEASUREMENT. None of these states a height, so the
     leg axis stays unanswered and the sentence stays the request it is. */
  test('a leg named without a height answers nothing', () => {
    expect(PK('2S(30")/Col:BO315-21/Use iron leg', '9058').leg).toBeNull();
    expect(PK('2S(30")/Col:BO315-21/Leg refer photos', '9058').leg).toBeNull();
    expect(PK('2S(30")/Col:BO315-21/*Leg must use 5527*', '9058').leg).toBeNull();
  });

  /* 8030 IS A MODEL NUMBER, NOT EIGHT THOUSAND INCHES. The guard is the UNIT:
     a number with no unit beside the word `leg` is not a height. */
  test('a model number beside the word leg is not a leg height', () => {
    expect(PK('COL:BO315-21/back cushion+leg 8030', '9058').leg).toBeNull();
  });

  /* MEASURED AND LEFT, on purpose. A bare "NO LEG" is 44 rows in the committed
     cut and every one of them sits inside a COVERING instruction ("fully cover
     to floor", "extend wood to floor") whose leg is a consequence rather than a
     pick. Reading it as 0 would state a leg on lines the leg-default backfill
     deliberately left for a human, so it is not done here. `docs/bugs/0741`
     carries the count and the reason. */
  test('a bare "NO LEG" is not read as zero by this change', () => {
    expect(PK("2+C+1(35'INCH)FULLY COVER NO LEG/COL:BOOBOO315-1/25", '9058').leg).toBeNull();
  });

  /* ABSENT IS NOT ZERO (docs/bugs/0732). A sofa whose book text says nothing
     about a leg answers null, so the axis reports nothing rather than asserting
     a leg nobody chose. */
  test('a sofa with no leg in its text answers null, never 0', () => {
    expect(PK('1EL+1NA+C+1NA+1ER/32"/Col:BO315-21', '8050').leg).toBeNull();
  });
});
