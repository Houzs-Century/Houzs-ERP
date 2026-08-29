import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared by the SO and PO importers
import { parseSofa } from '../scripts/lib/parse-sofa.mjs';
// @ts-expect-error - plain .mjs, the older sofa backfill's copy of the same ruling
import { RULES } from '../scripts/lib/sofa-special-map.mjs';
import MAP from '../scripts/data/special-order-phrase-map.json';

/* docs/sofa-import-handoff.md section 7: "owner 给的每个新例子都补成金标测试".
   Until now there was none, and that is exactly how #1813 shipped a NOISE class
   ([A-KM-OQ-Z]) that swallowed a bare "C" and a bare "R" before either could
   reach its classification arm — 49 real cutover lines decoded one compartment
   short at HIGH confidence, with no placeholder and no flag.

   Every case below is a rule from the handoff doc's own tables (section 2.2 /
   2.3), quoted in the label. Add the owner's next ruling here, not only to the
   parser. */

const pieces = (d2: string, model = '8030', recl = false): string[] =>
  (parseSofa(d2, model, recl) as { pieces: string[] }).pieces;
const conf = (d2: string, model = '8030', recl = false): string =>
  (parseSofa(d2, model, recl) as { conf: string }).conf;
const specials = (d2: string, model = '8030', recl = false): string[] =>
  (parseSofa(d2, model, recl) as { specials: string[] }).specials;

describe('parse-sofa: the single-letter tokens the grammar owns', () => {
  /* The regression this file exists for. C, L, P and R each have their own
     classification arm, so none of them may be filtered as noise. */
  test('bare C is a corner, not noise (1+C+2)', () => {
    expect(pieces('1+C+2(28"INCH)/COL:KIV')).toEqual(['1A(LHF)', 'CNR', '2A(RHF)']);
  });

  test('2s + C + 1s is a corner set', () => {
    expect(pieces('2s + C + 1s (30")', '9058')).toEqual(['2A(LHF)', 'CNR', '1A(RHF)']);
  });

  test('a corner in the middle of a longer run survives', () => {
    expect(pieces('1EL+C+1NA+1ER/32"/col:TBC')).toEqual(['1A(LHF)', 'CNR', '1NA', '1A(RHF)']);
  });

  test('bare L is still a chaise', () => {
    expect(pieces('2S+L(28")')).toEqual(['2A(LHF)', 'L(RHF)']);
  });

  test('bare R on a recliner model is a recliner seat', () => {
    expect(pieces('R(24"Inch)/Col:BO315-4', '2379', true)).toEqual(['1S(R)']);
  });

  test('R+R on a recliner model is a recliner pair', () => {
    expect(pieces('R+R(24"Inch)/Col:X', '2379', true)).toEqual(['1A(R)(LHF)', '1A(R)(RHF)']);
  });

  /* Owner 2026-08-10: 8030/8060/9058/9028/9050/8069/5535 have no recliner. A
     bare R there is genuinely ambiguous, so it must NOT be guessed - the
     placeholder path is the correct outcome, not a silent drop. */
  test('bare R on a NON-recliner model refuses to guess', () => {
    expect(conf('R(24"Inch)/Col:BO315-4', '8030', false)).toBe('low');
  });
});

describe('parse-sofa: combination rules from the handoff doc section 2.3', () => {
  test('1+1 = 1A + 1A', () => {
    expect(pieces('1+1(28")')).toEqual(['1A(LHF)', '1A(RHF)']);
  });

  test('2L puts the seat left and the chaise right', () => {
    expect(pieces('2L(28")')).toEqual(['2A(LHF)', 'L(RHF)']);
  });

  test('L2 is the mirror of 2L', () => {
    expect(pieces('L2(28")')).toEqual(['L(LHF)', '2A(RHF)']);
  });

  test('the bracket wins over the label (2R(1+1))', () => {
    expect(pieces('2R(1+1)')).toEqual(['1A(LHF)', '1A(RHF)']);
  });

  test('3S splits at a seat depth other than 24 inch', () => {
    expect(pieces('3S(28")')).toEqual(['2A(LHF)', '1A(RHF)']);
  });

  test('3S stays whole at 24 inch', () => {
    expect(pieces('3S(24")')).toEqual(['3S']);
  });

  test('4S = 2A + 2A', () => {
    expect(pieces('4S(28")')).toEqual(['2A(LHF)', '2A(RHF)']);
  });

  test('a console forces the seats apart', () => {
    expect(pieces('2S+CONSOLE(28")')).toEqual(['1A(LHF)', 'Console', '1A(RHF)']);
  });

  test('2G1F is a corner set', () => {
    expect(pieces('2G1F(28")')).toEqual(['2A(LHF)', 'CNR', '1A(RHF)']);
  });

  test('a lone Corner sells the whole set', () => {
    expect(pieces('Corner(28")')).toEqual(['2A(LHF)', 'CNR', '1A(RHF)']);
  });

  test('3RR on a recliner model = 1AR + 1NA + 1AR', () => {
    expect(pieces('3RR(28")', '5071', true)).toEqual(['1A(R)(LHF)', '1NA', '1A(R)(RHF)']);
  });

  test('NA/LT opens an armed box', () => {
    expect(pieces('1NA/LT+C+2ER(28")', '558')).toEqual(['1ABOX(LHF)', 'CNR', '2A(RHF)']);
  });
});

describe('parse-sofa: arms only ever close the run (owner 2026-08-10)', () => {
  test('a mid-row armed piece trades places with an armless end', () => {
    expect(pieces('2NA+1R+L')).toEqual(['1A(LHF)', '2NA', 'L(RHF)']);
  });

  test('two same-side arms are corrected by position', () => {
    expect(pieces('1R+2R(28")', '8060')).toEqual(['1A(LHF)', '2A(RHF)']);
  });
});

describe('parse-sofa: a special order is never deleted', () => {
  /* The second regression this file exists for. `bottom[^\/\n]*` deleted the
     whole segment before specials were collected, so all 53 umbrella-fabric
     instructions in the cutover exports reached the ERP as nothing at all. */
  test('the umbrella-fabric bottom survives, and the structure is unaffected', () => {
    const r = parseSofa('2+L(28")/BOTTOM USE UMBRELLA FABRIC/COL:BO315-21', '9058', false) as
      { pieces: string[]; specials: string[]; conf: string };
    expect(r.pieces).toEqual(['2A(LHF)', 'L(RHF)']);
    expect(r.conf).toBe('high');
    expect(r.specials).toEqual(['BOTTOM USE UMBRELLA FABRIC']);
  });

  test('every wording of the bottom instruction is kept verbatim', () => {
    expect(specials('2S(28")/BOTTOM UPGRADE TO UMBRELLA FABRIC')).toEqual(['BOTTOM UPGRADE TO UMBRELLA FABRIC']);
    expect(specials('2S(28")/WRAP BOTTOM TO UMBRELLA FABRIC')).toEqual(['WRAP BOTTOM TO UMBRELLA FABRIC']);
    expect(specials('2S(28")/BOTTOM WRAP NYLON')).toEqual(['BOTTOM WRAP NYLON']);
  });

  /* A phrase alone in its own slash segment was dropped too: the structure
     loop breaks at the segment that carried the pieces and never visits the
     rest. */
  test('a phrase alone in its own segment is recorded', () => {
    expect(specials('SIZE:3S(28")/*BACK CUSHION CHANGE 8030')).toEqual(['BACK CUSHION CHANGE 8030']);
    expect(specials('2L(28")/AFTER PUSH BACK ALIGN TO SEAT')).toEqual(['AFTER PUSH BACK ALIGN TO SEAT']);
    expect(specials('2L(28")/*FULLY COVERED TO FLOOR NO LEG')).toEqual(['FULLY COVERED TO FLOOR NO LEG']);
    expect(specials('1+1(28")/NO BRACKET')).toEqual(['NO BRACKET']);
  });

  test('one instruction written twice is carried once, in its fullest wording', () => {
    expect(specials('2S(28")/BACKREST CHANGE 8030/BACK REST CHANGE 8030')).toEqual(['BACKREST CHANGE 8030']);
    // "nylon" is the parser's own token for the same request as "NILON"
    expect(specials('2S(28")/WRAP BOTTOM TO NILON')).toEqual(['WRAP BOTTOM TO NILON']);
  });

  test('a fabric colour is not read as an instruction', () => {
    expect(specials('3S(28")/CH141-4 WOOD')).toEqual([]);
    expect(specials('1+C+2(32\'Inch)/Col:HR805-30', '9050')).toEqual([]);
  });

  test('a leg request still rides as a special and never sets the seat size', () => {
    const r = parseSofa('2S(28")/Leg Change 101Middle Leg(8\')', '8030', false) as
      { size: string; specials: string[] };
    expect(r.size).toBe('28');
    expect(r.specials).toEqual(["Leg Change 101Middle Leg(8')"]);
  });
});

describe('parse-sofa: never guess', () => {
  test('an empty Desc2 is low confidence, not an empty build', () => {
    const r = parseSofa('', '8030', false) as { conf: string; pieces: string[] };
    expect(r.conf).toBe('low');
    expect(r.pieces).toEqual([]);
  });

  test('an unreadable token refuses rather than dropping it', () => {
    expect(conf('1AP+2(28")')).toBe('low');
  });
});

/* The nine AutoCount lines that opened model 5526 (owner 2026-08-10: "5526 就是
   5526 啊 ... 8038 原本都不是 5526"). These are the strings the 5526 compartment
   list was DERIVED from, so a parser change that alters any of them changes
   which SKUs that model is supposed to own — pin them. Verbatim from
   ac-outstanding-so / ac-outstanding-po / ac-so-linked-pos. */
describe('parse-sofa: the 5526 cutover builds', () => {
  const p = (d2: string) => pieces(d2, '5526', false);

  test('SO-001112 2S+2.5+C/T splits around the console', () => {
    expect(p('[ 2S(28") + 2.5(35") + C/T / COL: 7# CHARCOAL]')).toEqual(['2A(LHF)', 'Console', '2A(RHF)']);
  });

  test('SO-001526 1EL+2ER', () => {
    expect(p('[ 1EL(35") + 2ER(35") / COL: BEETEX HARRING GD8371 02# BEIGE ]')).toEqual(['1A(LHF)', '2A(RHF)']);
  });

  test('SO-001526 2EL+STOOL', () => {
    expect(p('[ 2EL(28") + STOOL(28")(NO BACK CUSHION) / COL: BEETEX HARRING GD8371 02# BEIGE')).toEqual(['2A(LHF)', 'STOOL']);
  });

  test('SO-001526 bare 2S stays a whole two-seater', () => {
    expect(p('[ 2S(28") / COL: BEETEX HARRING GD8371 02# BEIGE')).toEqual(['2S']);
  });

  test('PO-001662 3S+C/T becomes 2A+Console+1A', () => {
    expect(p('COL: J9883-2-Chic  (PREMIUM) / 3S(35") + C/T')).toEqual(['2A(LHF)', 'Console', '1A(RHF)']);
  });

  test('PO-002425 wooden arm rides as a special, the build is still 2S', () => {
    const r = parseSofa('2S+WOODEN ARM  (28") / COL-HARRING GD 8371 02-BEIGE', '5526', false) as
      { pieces: string[]; specials: string[] };
    expect(r.pieces).toEqual(['2S']);
    /* The sweep carries the request VERBATIM, so the parser's own canonical
       "wooden arm" token is deduped away by the fuller wording that contains
       it. Both spellings map to the same Wooden Arm picker code. */
    expect(r.specials.join(' | ')).toMatch(/wooden arm/i);
  });

  /* Two builds deliberately stay placeholders: "1 ELT / T" is not readable, and
     DAYBED is a word the grammar has no token for (the owner supplied the piece
     by hand: PO-000162 = 5526-DB). Refusing is the correct answer for both. */
  test('SO-000814 / PO-000254 "1 ELT / T + NA + 2ER" refuses', () => {
    expect(conf('[ (1 ELT / T + NA +2ER) (28") / COL: J9883-1-1 PAMA]', '5526')).toBe('low');
  });

  test('PO-000162 DAYBED refuses rather than inventing a piece', () => {
    expect(conf('[DAYBED/COL:J9833-2]', '5526')).toBe('low');
  });
});

/* The phrase -> picker-code map is the second half of the same owner ruling the
   parser's special-order sweep implements, and it exists TWICE: as regexes in
   `backend/scripts/data/special-order-phrase-map.json` (the backfill and the
   price audit read it) and as predicates in `backend/scripts/lib/sofa-special-map.mjs`
   (the older sofa backfill reads that). Two copies of one ruling is exactly the
   drift this repo keeps paying for, and it had already happened: the JSON's
   notch family demanded a stitch/hole word AND a SEPARATE seat/cushion word in
   sequence, so it missed 'NO HOLES ON STICHING' and 'NO STICHING' — two real
   AutoCount slip phrases — while the lib matched them.

   Owner rulings about a phrase belong here, next to the parser rulings. */
describe('special-order phrase map: the notch family', () => {
  const CODE = 'No notch on Seat Cushion';
  const fam = (MAP.families as Array<{ code: string; yes: string; no?: string }>).find((f) => f.code === CODE)!;
  const YES = new RegExp(fam.yes);
  const NO = fam.no ? new RegExp(fam.no) : null;
  const libRule = (RULES as Array<{ code: string; yes: (s: string) => boolean; no?: (s: string) => boolean }>)
    .find((r) => r.code === CODE)!;

  // the normalisation the map declares in its own `_matching` note
  const flat = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const mapped = (phrase: string) => { const s = flat(phrase); return !(NO && NO.test(s)) && YES.test(s); };
  const libMapped = (phrase: string) => { const s = flat(phrase); return !(libRule.no && libRule.no(s)) && libRule.yes(s); };

  /* Verbatim from data/ac-outstanding-so.json.gz. The first two were UNMAPPED
     before 2026-08-11: a stitch word is the seat-cushion detail on its own, and
     demanding a second distinct token dropped them. */
  const SHOULD_MAP = [
    'NO HOLES ON STICHING',
    'No stiching',
    'no stitching on sitting area',
    'no hole or stiching at sitting area',
    'no stiching in sitting area',
    'no hole on sitting area',
    'no holes on sit area',
    'HB straight to wall and cushion no stitching',
  ];

  /* Not this family. 'no line ... plane' is the separate combined code, and a
     bare hole/notch word with no negation is not an instruction to omit one. */
  const SHOULD_NOT_MAP = [
    'seat cushion no line do plane',
    'SEAT CUSHION NO LINE DO PLAIN',
    'AKEMI SLEEP ESSENTIAL 7 HOLES PILLOW',
    'no bracket',
    'Nostiching',
  ];

  for (const phrase of SHOULD_MAP)
    test(`"${phrase}" maps to ${CODE}`, () => { expect(mapped(phrase)).toBe(true); });

  for (const phrase of SHOULD_NOT_MAP)
    test(`"${phrase}" does NOT map to ${CODE}`, () => { expect(mapped(phrase)).toBe(false); });

  test('the JSON map and lib/sofa-special-map.mjs agree on every one of them', () => {
    for (const phrase of [...SHOULD_MAP, ...SHOULD_NOT_MAP])
      expect(`${phrase}: json=${mapped(phrase)} lib=${libMapped(phrase)}`)
        .toBe(`${phrase}: json=${mapped(phrase)} lib=${mapped(phrase)}`);
  });
});

describe('parse-sofa: the 2026-08 new-style spelling (ERP compartment names, colour-first order)', () => {
  /* Staff entries from ~SO-0131xx onward write the ERP's own vocabulary —
     1A(LHF)+C+2A(RHF) — and put the colour FIRST with no COL: label. Every
     case here is a REAL Desc2 from the 2026-08-28 snapshot that the parser
     held before it learned the style (round ledger §4c). */
  const CASES: Array<[string, string, string[], string | null]> = [
    ['TBC/28”/1A(LHF)+C+2A(RHF)', '9028', ['1A(LHF)', 'CNR', '2A(RHF)'], null],
    ['TBC/35”/1A(LHF)+1A(RHF)', '8030', ['1A(LHF)', '1A(RHF)'], null],
    ["2A+1A(28'INCH)/COL:KIV/BOTTOM USE UMBRELLA FABIRC", '8030', ['2A(LHF)', '1A(RHF)'], 'KIV'],
    ["1A+1A(35'INCH)/COL:BOO315-01/BOTTOM USE UMBRELLA FABIRC", '8030', ['1A(LHF)', '1A(RHF)'], 'BOO315-01'],
    // colour-first with no label: pieces decode; the colour stays on the
    // #1998 library-confirmation contract (blank here, no predicate given)
    ['CH141-11 (SILVER)/28”/1A(LHF)+1NA+1A(RHF)', '9028', ['1A(LHF)', '1NA', '1A(RHF)'], null],
    ["1B+C TABLE+1A+WOODEN ARM(28'INCH)/COL:GD2502#20", '8060', ['1B(LHF)', 'Console', '1A(RHF)'], 'GD2502#20'],
    ['2A+L (30”)/Col:B0315-25', '5535', ['2A(LHF)', 'L(RHF)'], 'B0315-25'],
  ];
  for (const [d2, model, pieces, colour] of CASES)
    test(`"${d2}" decodes`, () => {
      const r = parseSofa(d2, model, false);
      expect(r.pieces).toEqual(pieces);
      expect(r.conf).not.toBe('low');
      if (colour) expect(r.color).toBe(colour);
      else expect(r.color).toBeNull();
    });

  test('a bare A-piece in the MIDDLE still holds the line — an arm mid-row is real ambiguity', () => {
    const r = parseSofa('1A(LHF)+1A+1A(RHF)', '9028', false);
    expect(r.pieces).toEqual([]);
    expect(r.conf).toBe('low');
  });

  test('colour-first + new-style pieces: the library-confirmed path still reads the code', () => {
    const known = (c: string) => (/^CH141-11$/i.test(c.trim()) ? 'CH141-11' : null);
    const r = parseSofa('CH141-11 (SILVER)/28”/1A(LHF)+1A(RHF)', '9028', false, { knownColour: known });
    expect(r.pieces).toEqual(['1A(LHF)', '1A(RHF)']);
    expect(r.color).toBe('CH141-11');
  });

  test('colour-first with a code the library does not know decodes its pieces and leaves colour blank', () => {
    const r = parseSofa('MODENZA-03 (BROWN)/28”/1A(LHF)+1A(RHF)', '8060', false);
    expect(r.pieces).toEqual(['1A(LHF)', '1A(RHF)']);
    expect(r.color).toBeNull();
  });
});

/* 2026-08-30 vocabulary sweep — every case below is a REAL Desc2 from the
   re-import round's 103 sofa placeholders (run 33251287997), quoted verbatim.
   Eight of them carry true structure that one unrecognised token was killing;
   the rest pin that digit-bearing INSTRUCTION words now ride as specials with
   an honest "no structure tokens" reason instead of a scary token error. */
describe('parse-sofa: the 2026-08-30 placeholder-sweep vocabulary', () => {
  test('a numbered console is a console — (1P+1Console+1P) (SO-012695)', () => {
    const r = parseSofa('(1P+1Console+1P)32inch/Col:ZL-11\n2Power Incliner', '8038', true);
    expect(r.pieces).toEqual(['1A(P)(LHF)', 'Console', '1A(P)(RHF)']);
    expect(r.conf).not.toBe('low');
  });

  test('1EL+1C+1Console+1NA+1ER keeps corner AND console (SO-013226)', () => {
    const r = parseSofa('(1EL+1C+1Console+1NA+1ER)28inch/Col:ZL-12', '8030', false);
    expect(r.pieces).toEqual(['1A(LHF)', 'CNR', 'Console', '1NA', '1A(RHF)']);
  });

  test('1EFL / 1EFR spell 1EL / 1ER (SO-010324)', () => {
    const r = parseSofa("1EFL+1NA+C+1EFR (32'Inch)/Col:HR805-90/Bottom upgrade to umbrella fabric", '9050', false);
    expect(r.pieces).toEqual(['1A(LHF)', '1NA', 'CNR', '1A(RHF)']);
  });

  test('1R(P)+1R(P) is a power pair, not a held mid-row P (SO-011530)', () => {
    const r = parseSofa('BO315-5 (FOSSIL)/32”/1R(P)+1R(P)', '8051', true);
    expect(r.pieces).toEqual(['1A(P)(LHF)', '1A(P)(RHF)']);
  });

  test('the bracket title may be letter-led — L2L(L+1NA+1NA+L) (SO-008166)', () => {
    const r = parseSofa('L2L(L+1NA+1NA+L)/Col:CH141-2 Beige', '9058', false);
    expect(r.pieces).toEqual(['L(LHF)', '1NA', '1NA', 'L(RHF)']);
  });

  test('an orphan second size number does not kill the chain (SO-010015)', () => {
    const r = parseSofa('1+1NA+L(26/28’Inch)/Col:KIV/Bottom upgrade to umbrella fabric ', '9028', false);
    expect(r.pieces).toEqual(['1A(LHF)', '1NA', 'L(RHF)']);
    expect(r.size).toBe('28');
  });

  test('1B/S seater survives its own label (SO-013329)', () => {
    const r = parseSofa('Size:30”/Col:BO315-4 Sand/Bottom wrap nylon/1B/S seater 26”', '8069', false);
    expect(r.pieces).toEqual(['1B(LHF)']);
  });

  test('a library-confirmed colour token inside the structure segment is consumed, not fatal (SO-013121)', () => {
    const known = (c: string) => (/^B0315[\s-]*PEARL$/i.test(c.trim()) ? 'B0315-PEARL' : null);
    const r = parseSofa('2S[P+P](32”)B0315-Pearl', '8051', true, { knownColour: known });
    expect(r.pieces).toEqual(['1A(P)(LHF)', '1A(P)(RHF)']);
  });

  test('digit-bearing instructions ride as specials instead of reading as unknown structure (SO-011446)', () => {
    const r = parseSofa('headrest change to 8030 \ncolour : CH141-1 \nchange bottom to Nilon ', '9058', false);
    expect(r.pieces).toEqual([]); // the book truly wrote no structure — placeholder is faithful
    expect((r.why as string[]).some((w: string) => w.startsWith('token'))).toBe(false);
    expect(r.specials.join(' ').toLowerCase()).toContain('headrest change to 8030');
  });

  test('ALL SEAT CHANGE 8030 BACK CUSHION is an instruction, never a token error (SO-008542)', () => {
    const r = parseSofa('(30”)/col:tbc/“All Seat Change 8030 Back Cushion”', '9058', false);
    expect(r.pieces).toEqual([]);
    expect((r.why as string[]).some((w: string) => w.startsWith('token'))).toBe(false);
  });

  test('a bare model-number rider (back rest (5540)) stays quiet (SO-013312)', () => {
    const r = parseSofa('32 inch \nback rest  (5540)\nfully cover after push back \nNilon bottom', '9058', false);
    expect(r.pieces).toEqual([]);
    expect((r.why as string[]).some((w: string) => w.startsWith('token'))).toBe(false);
  });
});
