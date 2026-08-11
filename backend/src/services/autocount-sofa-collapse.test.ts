/**
 * D9 — the sofa shape mismatch, tested against the REAL Desc2 corpus.
 *
 * The ERP models a sofa build as one line per compartment; AutoCount holds ONE
 * line per sofa with the build written into Desc2 as free text. Collapsing the
 * former into the latter is a reconstruction, and a reconstruction that is
 * merely plausible is the worst possible outcome: a side-swapped sofa reads
 * perfectly in the account book and ships the wrong furniture.
 *
 * So these tests are not "does it work". They are:
 *   1. ECHO is byte-exact on every build the cutover actually decomposed.
 *   2. Where the composer must reconstruct, the output either decodes back to
 *      exactly the ERP's compartments or is REFUSED. Never a third outcome.
 *   3. The gate catches every case the composer gets wrong — measured, with the
 *      count printed, not asserted away.
 *
 * The corpus is compiled from the committed AutoCount exports by
 * scripts/gen-sofa-desc2-corpus.mjs (the suite runs in workerd, which has no
 * fs). It carries INPUT ONLY — real ItemCodes and real Desc2 — so the decoder
 * and the collapse under test are the real ones and nothing is asserted against
 * a baked-in expectation.
 */
import { describe, expect, it } from 'vitest';
import { parseSofa } from '../../scripts/lib/parse-sofa.mjs';
import {
  AC_SOFA_CORPUS,
  AC_SOFA_CORPUS_ROWS,
  type AcSofaCorpusRow,
} from './autocount-sofa-corpus';
import {
  AC_DESC2_MAX,
  collapseSofaLines,
  composeSofaDesc2,
  decodesTo,
  splitSofaCode,
  type CollapsibleLine,
} from './autocount-sofa-collapse';
import { AC_ITEM_MAP_TSV } from './autocount-item-map';

const up = (s: string | null | undefined) => String(s ?? '').trim().toUpperCase();
const sameSeq = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => up(v) === up(b[i]));

/**
 * The population any collapse can apply to: AutoCount lines whose Desc2 the
 * shared decoder turns into a confident compartment list, which is what the
 * cutover importer decomposes into per-compartment ERP rows. Anything else
 * became a placeholder on the base model and never had compartments to fold
 * back up.
 *
 * The importer additionally requires every compartment SKU to exist in
 * scm.products. That table is unreachable from workerd, and the one committed
 * file that looks like it (minted-sofa-skus-2026-08.json) is a single batch's
 * DELTA — it holds zero 9028-* compartments, and gating on it silently shrinks
 * this corpus from 551 builds to 43. Left out deliberately: it narrows the
 * population without making any assertion below weaker.
 */
function decoded(row: AcSofaCorpusRow) {
  const ps = parseSofa(row.desc2, row.model, row.recl);
  const codes = ps.pieces.map((c) => `${row.model}-${c}`);
  const ok = codes.length > 0 && ps.conf !== 'low';
  return { ps, codes, ok };
}

/** The compartment rows the importer would have written for this build. */
function erpRows(row: AcSofaCorpusRow, pieces: string[], ps: ReturnType<typeof parseSofa>): CollapsibleLine[] {
  return pieces.map((comp, i) => ({
    item_code: `${row.model}-${comp}`,
    item_group: 'sofa',
    description: `SOFA ${row.model} ${comp}`,
    description2: row.desc2,
    qty: row.qty || 1,
    unit_price_centi: i === 0 ? 123400 : 0,
    location: 'KL',
    variants: { seatHeight: ps.size, colourLabel: ps.color, specials: ps.specials },
  }));
}

const CORPUS = AC_SOFA_CORPUS.map((row) => ({ row, ...decoded(row) }));
const DECODABLE = CORPUS.filter((c) => c.ok);

describe('the corpus itself', () => {
  it('is present and is real AutoCount text', () => {
    // A generator that stops resolving must fail LOUD, not pass on [].
    expect(AC_SOFA_CORPUS_ROWS).toBeGreaterThan(400);
    expect(AC_SOFA_CORPUS.length).toBe(AC_SOFA_CORPUS_ROWS);
    expect(DECODABLE.length).toBeGreaterThan(400);
    // eslint-disable-next-line no-console
    console.log(
      `[D9 corpus] ${AC_SOFA_CORPUS.length} AutoCount sofa lines; `
      + `${DECODABLE.length} the cutover decomposed into compartments; `
      + `${CORPUS.length - DECODABLE.length} were placeholders and never had compartments to fold.`,
    );
  });
});

describe('ECHO — the stored Desc2 is the faithful answer when the build is unchanged', () => {
  /**
   * Verbatim means verbatim, with ONE documented exception: surrounding
   * whitespace. 99 of the 658 real Desc2 values carry a leading space or a
   * trailing newline, the decoder discards it before reading anything, and
   * keeping it would make an otherwise 100-character build overflow AutoCount's
   * field. Nothing INSIDE the text may change.
   */
  it('reproduces the AutoCount text character-for-character on every decomposed build', () => {
    const wrong: string[] = [];
    let echoed = 0;
    for (const { row, ps } of DECODABLE) {
      const res = collapseSofaLines(erpRows(row, ps.pieces, ps));
      if (res.refusals.length || res.lines.length !== 1) {
        wrong.push(`${row.docNo}/${row.dtlKey}: ${res.refusals[0]?.reason ?? `${res.lines.length} lines`}`);
        continue;
      }
      const line = res.lines[0];
      if (line.via !== 'echo' || line.description2 !== row.desc2.trim()) {
        wrong.push(`${row.docNo}/${row.dtlKey}: via=${line.via} desc2=${JSON.stringify(line.description2)}`);
        continue;
      }
      echoed += 1;
    }
    // eslint-disable-next-line no-console
    console.log(`[D9 echo] ${echoed}/${DECODABLE.length} builds echoed verbatim, ${wrong.length} not.`);
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(echoed).toBe(DECODABLE.length);
  });

  it('the only difference from the account book text is surrounding whitespace', () => {
    const padded = AC_SOFA_CORPUS.filter((r) => r.desc2 !== r.desc2.trim());
    // If this ever hits zero the assertion above has quietly stopped meaning anything.
    expect(padded.length).toBeGreaterThan(50);
    for (const row of padded) {
      const { ps, ok } = decoded(row);
      if (!ok) continue;
      const res = collapseSofaLines(erpRows(row, ps.pieces, ps));
      if (res.lines.length !== 1) continue;
      expect(row.desc2).toContain(res.lines[0].description2!);
    }
  });

  it('collapses N compartment rows to ONE AutoCount line carrying the model base code', () => {
    const multi = DECODABLE.filter((c) => c.ps.pieces.length > 1);
    expect(multi.length).toBeGreaterThan(300);
    for (const { row, ps } of multi) {
      const rows = erpRows(row, ps.pieces, ps);
      const res = collapseSofaLines(rows);
      expect(res.lines).toHaveLength(1);
      expect(res.lines[0].item_code).toBe(`${row.model}-1S`);
      expect(res.lines[0].sourceIndexes).toEqual(rows.map((_, i) => i));
      // the importer put the price on the FIRST compartment and zero on the rest
      expect(res.lines[0].unit_price_centi).toBe(123400);
      expect(res.lines[0].qty).toBe(row.qty || 1);
    }
  });

  it('is STABLE: parse -> collapse -> parse again returns the same compartments', () => {
    const drift: string[] = [];
    for (const { row, ps } of DECODABLE) {
      const res = collapseSofaLines(erpRows(row, ps.pieces, ps));
      if (res.lines.length !== 1) continue;
      const again = parseSofa(res.lines[0].description2, row.model, row.recl);
      if (!sameSeq(again.pieces, ps.pieces)) {
        drift.push(`${row.docNo}/${row.dtlKey}: [${ps.pieces}] -> [${again.pieces}]`);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[D9 stability] ${DECODABLE.length - drift.length}/${DECODABLE.length} stable across a second parse.`);
    expect(drift.slice(0, 5)).toEqual([]);
  });
});

describe('COMPOSE — reconstruction is imperfect, and the gate is what makes that safe', () => {
  /**
   * The honest measurement. For every real build, ask the composer to spell the
   * compartment list from scratch and read the result back with the SAME
   * decoder. Three outcomes are possible and only two are acceptable.
   */
  it('never produces text that decodes to a DIFFERENT sofa without the gate catching it', () => {
    let exact = 0;
    let refusedByComposer = 0;
    const misdecoded: string[] = [];
    const missedByGate: string[] = [];

    for (const { row, ps } of DECODABLE) {
      const attrs = { size: ps.size, colour: ps.color, specials: ps.specials };
      const composed = composeSofaDesc2(ps.pieces, attrs);
      if (composed == null) { refusedByComposer += 1; continue; }
      const again = parseSofa(composed, row.model, row.recl);
      if (sameSeq(again.pieces, ps.pieces)) { exact += 1; continue; }
      misdecoded.push(`${row.docNo}/${row.dtlKey}: [${ps.pieces}] -> "${composed}" -> [${again.pieces}]`);
      // THE LOAD-BEARING CLAIM: whatever the composer gets wrong, the gate refuses.
      if (decodesTo(composed, row.model, ps.pieces, attrs).ok) {
        missedByGate.push(`${row.docNo}/${row.dtlKey}: "${composed}" decodes to [${again.pieces}]`);
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[D9 compose] ${DECODABLE.length} builds: ${exact} spelled exactly, `
      + `${refusedByComposer} the composer refused to spell, `
      + `${misdecoded.length} it spelled WRONG — of which ${missedByGate.length} escaped the gate.`
      + (misdecoded.length ? `\n[D9 compose] wrong: ${misdecoded.join(' | ')}` : ''),
    );
    expect(missedByGate).toEqual([]);
    /* The composer is KNOWN to be imperfect and that is the design: the gate,
       not the composer, is what stands between a reconstruction and the account
       book. If this ever reaches zero the gate has stopped being exercised by
       real data and the assertion above proves nothing. */
    expect(misdecoded.length).toBeGreaterThan(0);
  });

  /**
   * THE GATE MUST BE WIRED, NOT MERELY PRESENT. The measurement above calls
   * composeSofaDesc2 and decodesTo directly, so it proves the gate FUNCTION
   * works — it passes just as happily if collapseSofaLines never calls it.
   * Removing the gate from collapseRun left that test green, which is exactly
   * the failure mode the whole module is built against.
   *
   * So drive the real corpus through the REAL entry point on the compose path.
   * Compose only runs when the stored Desc2 no longer decodes to the
   * compartments the ERP holds — i.e. after an operator edits the build, which
   * is the D9 edit case and the only way a reconstruction ever reaches the
   * account book. That is simulated here by editing the compartment list while
   * leaving the imported Desc2 stale, exactly as a real edit does.
   *
   * Reversing the pieces is the deliberate stressor: it inverts handedness, and
   * a side-swapped sofa is the corrupting outcome that reads perfectly.
   */
  it('every line collapseSofaLines EMITS decodes back to the build it was given', () => {
    let composed = 0;
    let refused = 0;
    const corrupt: string[] = [];

    for (const { row, ps } of DECODABLE) {
      if (ps.pieces.length < 2) continue;
      const edits: string[][] = [[...ps.pieces].reverse(), ps.pieces.slice(0, -1)];
      for (const pieces of edits) {
        // the ORIGINAL Desc2 is left on the rows: stale, as a real edit leaves it
        const res = collapseSofaLines(erpRows(row, pieces, ps));
        refused += res.refusals.length;
        for (const line of res.lines) {
          if (line.via !== 'compose') continue;
          composed += 1;
          const again = parseSofa(String(line.description2), row.model, row.recl);
          if (!sameSeq(again.pieces, pieces)) {
            corrupt.push(
              `${row.docNo}/${row.dtlKey}: ERP holds [${pieces}] -> emitted `
              + `"${line.description2}" -> decodes [${again.pieces}]`,
            );
          }
        }
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[D9 wired] ${composed} edited builds composed and emitted, ${refused} refused, `
      + `${corrupt.length} emitted a line decoding to a DIFFERENT sofa.`,
    );
    // Nothing that reaches the account book may decode to another sofa.
    expect(corrupt).toEqual([]);
    // Both paths must be live, or this asserts over an empty set.
    expect(composed).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it('the gate rejects text that decodes to a different build', () => {
    const two = ['1A(LHF)', '2A(RHF)'];
    const good = composeSofaDesc2(two, { size: '28', colour: 'BEIGE' });
    expect(good).not.toBeNull();
    expect(decodesTo(good!, '9028', two, { size: '28', colour: 'BEIGE' }).ok).toBe(true);
    // the same text measured against a build it is not
    const bad = decodesTo(good!, '9028', ['1A(LHF)', 'CNR', '2A(RHF)'], null);
    expect(bad.ok).toBe(false);
    expect('why' in bad && bad.why).toContain('the ERP holds');
  });

  it('the gate rejects a colour or seat size that does not survive', () => {
    const b = ['1A(LHF)', '2A(RHF)'];
    const text = composeSofaDesc2(b, { size: '28', colour: 'BEIGE' })!;
    expect(decodesTo(text, '9028', b, { size: '30', colour: 'BEIGE' }).ok).toBe(false);
    expect(decodesTo(text, '9028', b, { size: '28', colour: 'GREY' }).ok).toBe(false);
  });
});

describe('the two corrections that a naive inverse gets wrong', () => {
  /**
   * A bare digit decodes left-then-right BY POSITION, so an armed pair written
   * "1 + 1" always comes back left-arm-first. A build that is physically
   * right-arm-first therefore round-trips as a MIRRORED sofa — the same money,
   * the same fabric, the wrong furniture. This is the exact failure the naive
   * inverse shipped, and it is why armed ends must be spelled nEL / nER.
   */
  it('an armed pair keeps its handedness (1ER + 1EL does not come back swapped)', () => {
    const rightFirst = ['1A(RHF)', '1A(LHF)'];
    const naive = '1 + 1 (28")';
    expect(parseSofa(naive, '9028', false).pieces).toEqual(['1A(LHF)', '1A(RHF)']);
    expect(sameSeq(parseSofa(naive, '9028', false).pieces, rightFirst)).toBe(false);

    const composed = composeSofaDesc2(rightFirst, { size: '28' });
    expect(composed).not.toBeNull();
    expect(parseSofa(composed!, '9028', false).pieces).toEqual(rightFirst);
    expect(decodesTo(composed!, '9028', rightFirst, { size: '28' }).ok).toBe(true);
  });

  it('an armless piece keeps its spelling (a lone 1NA has no bare-digit form)', () => {
    const solo = ['1NA'];
    const composed = composeSofaDesc2(solo, { size: '28' });
    expect(composed).not.toBeNull();
    expect(parseSofa(composed!, '9028', false).pieces).toEqual(solo);
  });

  /**
   * A BARE DIGIT IS NOT A SEAT. "1 (28\")" and "2 (28\")" decode to NOTHING —
   * so the bare-digit spelling turned every single-seat build into a guaranteed
   * refusal. And a solo 3S has no spelling at all: "3" decodes to nothing and
   * "3S" decodes to the TWO-piece [2A(LHF), 1A(RHF)], which is precisely the
   * plausible-but-wrong answer that must never reach the account book.
   */
  it('a solo seat is spelled 1S / 2S, because a bare digit decodes to nothing', () => {
    expect(parseSofa('1 (28")', '9028', false).pieces).toEqual([]);
    expect(parseSofa('2 (28")', '9028', false).pieces).toEqual([]);

    for (const seat of ['1S', '2S']) {
      const composed = composeSofaDesc2([seat], { size: '28', colour: 'BEIGE' });
      expect(composed, `${seat} must be spellable`).not.toBeNull();
      expect(parseSofa(composed!, '9028', false).pieces).toEqual([seat]);
      expect(decodesTo(composed!, '9028', [seat], { size: '28', colour: 'BEIGE' }).ok).toBe(true);
    }
  });

  it('refuses a solo 3S rather than emitting text that decodes to two pieces', () => {
    expect(parseSofa('3S (28")', '9028', false).pieces).toEqual(['2A(LHF)', '1A(RHF)']);
    expect(composeSofaDesc2(['3S'], { size: '28' })).toBeNull();
  });
});

describe('REFUSAL is the designed outcome, never a plausible guess', () => {
  const build = (over: Partial<CollapsibleLine>[]): CollapsibleLine[] =>
    over.map((o) => ({
      item_code: '9028-1S', item_group: 'sofa', description: 'SOFA 9028',
      description2: '1 (28") / COL: BEIGE', qty: 1, unit_price_centi: 0, ...o,
    }));

  it('refuses a build with no Desc2 at all, and emits no line for it', () => {
    const res = collapseSofaLines(build([{ item_code: '9028-1A(LHF)', description2: '' },
      { item_code: '9028-2A(RHF)', description2: '' }]));
    expect(res.lines).toHaveLength(0);
    expect(res.refusals).toHaveLength(1);
    expect(res.refusals[0].reason).toContain('no Desc2');
    expect(res.refusals[0].sourceIndexes).toEqual([0, 1]);
    expect(res.refusals[0].itemCodes).toEqual(['9028-1A(LHF)', '9028-2A(RHF)']);
  });

  it('refuses rather than truncating a Desc2 longer than AutoCount holds', () => {
    const long = `${'X'.repeat(AC_DESC2_MAX)}Y`;
    expect(long.length).toBe(AC_DESC2_MAX + 1);
    const res = collapseSofaLines(build([{ item_code: '9028-1S', description2: long }]));
    expect(res.lines).toHaveLength(0);
    expect(res.refusals[0].reason).toContain(String(AC_DESC2_MAX));
    expect(res.refusals[0].reason).toContain('truncating');
  });

  it('refuses a compartment list it cannot spell, quoting what the stored text decodes to', () => {
    // A corner cannot stand alone: 'C' on its own is not a build.
    const res = collapseSofaLines(build([
      { item_code: '9028-CNR', description2: '1 + 1 (28")' },
    ]));
    expect(res.lines).toHaveLength(0);
    expect(res.refusals).toHaveLength(1);
    expect(res.refusals[0].reason).toContain('cannot spell');
  });

  it('refuses when the compartments disagree on quantity', () => {
    const res = collapseSofaLines(build([
      { item_code: '9028-1A(LHF)', description2: '1 + 1 (28")', qty: 1 },
      { item_code: '9028-1A(RHF)', description2: '1 + 1 (28")', qty: 2 },
    ]));
    expect(res.lines).toHaveLength(0);
    expect(res.refusals[0].reason).toContain('quantity');
  });

  it('a refusal never leaks a partial line for the same build', () => {
    const res = collapseSofaLines([
      { item_code: 'MATT-K', item_group: 'mattress', description: 'MATTRESS', description2: null, qty: 1, unit_price_centi: 500 },
      ...build([{ item_code: '9028-CNR', description2: '1 + 1 (28")' }]),
    ]);
    expect(res.refusals).toHaveLength(1);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].item_code).toBe('MATT-K');
    expect(res.lines[0].via).toBe('passthrough');
  });
});

describe('grouping — where one sofa ends and the next begins', () => {
  it('passes non-sofa lines through untouched and in order', () => {
    const lines: CollapsibleLine[] = [
      { item_code: 'AKEMI-K', item_group: 'mattress', description: 'A', description2: null, qty: 2, unit_price_centi: 100 },
      { item_code: 'TRANSPORTATION CHARGES', item_group: null, description: 'T', description2: null, qty: 1, unit_price_centi: 50 },
    ];
    const res = collapseSofaLines(lines);
    expect(res.refusals).toEqual([]);
    expect(res.lines.map((l) => l.item_code)).toEqual(['AKEMI-K', 'TRANSPORTATION CHARGES']);
    expect(res.lines.every((l) => l.via === 'passthrough')).toBe(true);
  });

  it('never folds a non-sofa item that happens to be coded like a compartment', () => {
    const res = collapseSofaLines([
      { item_code: 'X-2S', item_group: 'mattress', description: 'not a sofa', description2: null, qty: 1, unit_price_centi: 1 },
    ]);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].via).toBe('passthrough');
  });

  it('keeps two different builds of the same model apart', () => {
    const a = '1 + 1 (28")';
    const b = '2 + 2 (30")';
    const res = collapseSofaLines([
      { item_code: '9028-1A(LHF)', item_group: 'sofa', description: 'S', description2: a, qty: 1, unit_price_centi: 100 },
      { item_code: '9028-1A(RHF)', item_group: 'sofa', description: 'S', description2: a, qty: 1, unit_price_centi: 0 },
      { item_code: '9028-2A(LHF)', item_group: 'sofa', description: 'S', description2: b, qty: 1, unit_price_centi: 200 },
      { item_code: '9028-2A(RHF)', item_group: 'sofa', description: 'S', description2: b, qty: 1, unit_price_centi: 0 },
    ]);
    expect(res.refusals).toEqual([]);
    expect(res.lines).toHaveLength(2);
    expect(res.lines.map((l) => l.description2)).toEqual([a, b]);
    expect(res.lines.map((l) => l.unit_price_centi)).toEqual([100, 200]);
  });

  it('emits N identical lines for an EXACT repeat, and refuses a ragged run', () => {
    const d2 = '1 + 1 (28")';
    const mk = (code: string) => ({
      item_code: code, item_group: 'sofa', description: 'S', description2: d2,
      qty: 1, unit_price_centi: 0,
    });
    const twice = collapseSofaLines([
      mk('9028-1A(LHF)'), mk('9028-1A(RHF)'), mk('9028-1A(LHF)'), mk('9028-1A(RHF)'),
    ]);
    expect(twice.refusals).toEqual([]);
    expect(twice.lines).toHaveLength(2);

    const ragged = collapseSofaLines([mk('9028-1A(LHF)'), mk('9028-1A(RHF)'), mk('9028-1A(LHF)')]);
    // three compartments are not a whole number of "1 + 1" builds; compose is
    // then asked to spell [1A(LHF), 1A(RHF), 1A(LHF)] and refuses.
    expect(ragged.lines).toHaveLength(0);
    expect(ragged.refusals).toHaveLength(1);
  });
});

describe('line identity — one AutoCount line has ONE DtlKey', () => {
  const mk = (code: string, key: number | null) => ({
    item_code: code, item_group: 'sofa', description: 'S', description2: '1 + 1 (28")',
    qty: 1, unit_price_centi: 0, linked_ac_dtlkey: key,
  });

  it('carries the key when every compartment agrees on it', () => {
    const res = collapseSofaLines([mk('9028-1A(LHF)', 4242), mk('9028-1A(RHF)', 4242)]);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].linked_ac_dtlkey).toBe('4242');
  });

  it('drops to null when they disagree — a wrong DtlKey edits somebody else\'s line', () => {
    const res = collapseSofaLines([mk('9028-1A(LHF)', 4242), mk('9028-1A(RHF)', 9999)]);
    expect(res.lines[0].linked_ac_dtlkey).toBeNull();
  });

  it('drops to null when only some compartments have one', () => {
    const res = collapseSofaLines([mk('9028-1A(LHF)', 4242), mk('9028-1A(RHF)', null)]);
    expect(res.lines[0].linked_ac_dtlkey).toBeNull();
  });
});

describe('splitSofaCode', () => {
  it('recognises every compartment the corpus decodes to', () => {
    const unknown = new Set<string>();
    for (const { ok, ps, row } of CORPUS) {
      if (!ok) continue;
      for (const p of ps.pieces) {
        if (!splitSofaCode(`${row.model}-${p}`)) unknown.add(p);
      }
    }
    expect([...unknown]).toEqual([]);
  });

  it('is null for a code with no compartment suffix', () => {
    expect(splitSofaCode('AKEMI-K')).toBeNull();
    expect(splitSofaCode('9028')).toBeNull();
    expect(splitSofaCode('')).toBeNull();
    expect(splitSofaCode('9028-1S')).toEqual({ model: '9028', compartment: '1S' });
  });

  /**
   * THE HOLE THIS CLOSES. collapseSofaLines folds a line when the code parses as
   * a compartment AND item_group is 'sofa' OR NULL. The null branch exists
   * because a hand-built line may not carry a group at all — but it means a
   * NON-sofa product whose code happened to end in '-2S' would be folded into
   * somebody's sofa build and vanish from the document.
   *
   * Measured against the whole cutover map: of 1561 ERP codes, 84 parse as a
   * compartment and ALL 84 are category SOFA. Zero bedframes, mattresses or
   * accessories collide with the compartment vocabulary. Asserted rather than
   * noted, because the day a supplier opens "SLAT-2S" the null branch stops
   * being safe and this is what says so.
   */
  it('no NON-sofa item in the cutover map parses as a compartment', () => {
    const offenders: string[] = [];
    let compartmentLike = 0;
    for (const line of AC_ITEM_MAP_TSV.split('\n')) {
      if (!line) continue;
      const [, erp, category] = line.split('\t');
      if (!erp || !splitSofaCode(erp)) continue;
      compartmentLike += 1;
      if (up(category) !== 'SOFA') offenders.push(`${erp} [${category}]`);
    }
    expect(compartmentLike).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});
