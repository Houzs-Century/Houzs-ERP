import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { gradeCorrectionsAgainstBook, modelOfErpCode } from '../scripts/lib/sofa-corrections-book-grade.mjs';
import { readMappingCsv, normCode } from '../scripts/lib/ac-mapping-csv.mjs';
import { loadCorrections } from '../scripts/lib/sofa-corrections-source.mjs';
import { desc2Contains } from '../scripts/lib/sofa-desc2-match.mjs';
import { SOFA_MODEL_ALIAS } from '../scripts/lib/parse-sofa.mjs';

/* WHAT THIS PINS, AND WHY IT IS A TEST RATHER THAN A REPORT.

   sofa-compartment-corrections-2026-08.json states a `model` per build, and
   apply-sofa-compartment-corrections.mjs writes that model onto the live
   documents. Nothing compared it to the item code AutoCount carries on the same
   line, so three builds carried a hand-typed model that overwrote the correct
   one and the ERP disagreed with the book for a month (docs/bugs/0693-a-hand-
   typed-model-in-the-sofa-corrections-file-outranked.md).

   The owner's ruling is that the book wins. A file that re-asserts a model the
   book does not name is therefore a DEFECT, and the cheapest place to catch it
   is before it merges - a stale corrections entry silently re-applying is a
   cost this cutover has already paid. Hence the integration case below: it
   reads the REAL files against the REAL book cut and requires zero
   disagreements. */

const ALIAS = { 5530: '9028', 5536: '9058', 5537: '8030', 5540: '8030' };

/** A book index over a plain fixture: { doc: [ [dtlKey, itemKey, desc2], ... ] } */
const fixtureBook = (docs) => (doc) => {
  const key = String(doc).replace(/^HC-/, '');
  const rows = docs[key];
  if (!rows) return { present: false, lines: [] };
  return { present: true, lines: rows.map(([dtlKey, itemKey, desc2]) => ({ dtlKey, itemKey, desc2 })) };
};

const grade = (builds, docs, map = {}) =>
  gradeCorrectionsAgainstBook({
    builds,
    bookLines: fixtureBook(docs),
    erpCodeFor: (ac) => map[ac] ?? null,
    desc2Contains,
    alias: ALIAS,
  });

describe('modelOfErpCode', () => {
  it('takes the model half and folds it through the alias', () => {
    expect(modelOfErpCode('8030-1A(LHF)', ALIAS)).toEqual({ raw: '8030', folded: '8030' });
    expect(modelOfErpCode('5536-1S', ALIAS)).toEqual({ raw: '5536', folded: '9058' });
    expect(modelOfErpCode('divan only', ALIAS)).toEqual({ raw: 'DIVAN ONLY', folded: 'DIVAN ONLY' });
  });

  it('never folds 5535 - the owner has ruled twice that it is its own model', () => {
    expect(modelOfErpCode('5535-1S', ALIAS)).toEqual({ raw: '5535', folded: '5535' });
    expect(SOFA_MODEL_ALIAS['5535']).toBeUndefined();
  });

  it('is null for an empty code rather than inventing one', () => {
    expect(modelOfErpCode('', ALIAS)).toBeNull();
    expect(modelOfErpCode(null, ALIAS)).toBeNull();
  });
});

describe('grading one correction against the book', () => {
  const docs = { 'SO-1': [['11', 'DSL-8030 SOFA', 'BEIGE/32"/1R+C+2R']] };
  const map = { 'DSL-8030 SOFA': '8030-1S' };

  it('AGREE when the file names the model the book names', () => {
    const { tally } = grade([{ docs: ['HC-SO-1'], model: '8030', desc2Match: '32"/1R+C+2R' }], docs, map);
    expect(tally).toEqual({ AGREE: 1 });
  });

  it('DIFFER when it names another one - and says which', () => {
    const { rows, tally } = grade([{ docs: ['HC-SO-1'], model: '9058', desc2Match: '32"/1R+C+2R' }], docs, map);
    expect(tally).toEqual({ DIFFER: 1 });
    expect(rows[0].bookRaw).toEqual(['8030']);
    expect(rows[0].fileModel).toBe('9058');
  });

  it('AGREE-VIA-ALIAS is its own verdict, not agreement and not a defect', () => {
    const { rows, tally } = grade(
      [{ docs: ['HC-SO-2'], model: '9058', desc2Match: 'L shape' }],
      { 'SO-2': [['21', 'HOK-5536 SOFA', 'L shape / bottom Nilon']] },
      { 'HOK-5536 SOFA': '5536-1S' },
    );
    expect(tally).toEqual({ 'AGREE-VIA-ALIAS': 1 });
    expect(rows[0].bookRaw).toEqual(['5536']);
    expect(rows[0].bookFolded).toEqual(['9058']);
  });

  it('a 5535 build graded as 8030 is a DIFFER, because 5535 does not fold', () => {
    const { tally } = grade(
      [{ docs: ['HC-SO-3'], model: '8030', desc2Match: '1R+C+2R' }],
      { 'SO-3': [['31', 'HOK-5535 SOFA', '1R+C+2R (30")']] },
      { 'HOK-5535 SOFA': '5535-1S' },
    );
    expect(tally).toEqual({ DIFFER: 1 });
  });

  it('matches the file\'s written \\n against the book\'s real whitespace', () => {
    /* The corrections file writes a line break as the two characters
       backslash-n; the book cut holds real whitespace. desc2Contains is the one
       normaliser both readers use - see lib/sofa-desc2-match.mjs. */
    const { tally } = grade(
      [{ docs: ['HC-SO-4'], model: '9058', desc2Match: 'colour : HR 805-9\\nwrap bottom to Nilon ' }],
      { 'SO-4': [['41', 'DSL-9058 SOFA', 'colour : HR 805-9 wrap bottom to Nilon  30 inch per seat']] },
      { 'DSL-9058 SOFA': '9058-1S' },
    );
    expect(tally).toEqual({ AGREE: 1 });
  });

  it('NO-BOOK-LINE names the document and why, rather than shrugging', () => {
    const { rows, tally } = grade([{ docs: ['HC-SO-1', 'HC-PO-9'], model: '8030', desc2Match: 'NOT ON THIS DOCUMENT' }], docs, map);
    expect(tally).toEqual({ 'NO-BOOK-LINE': 1 });
    expect(rows[0].missing).toEqual([
      'HC-SO-1: 1 book line(s), none carries this Desc2',
      'HC-PO-9: not in the book cut',
    ]);
  });

  it('an entry with no model is not graded, and is not counted as agreement', () => {
    const { tally } = grade([{ docs: ['HC-SO-1'], pieces: ['1A(LHF)'], desc2Match: '32"/1R+C+2R' }], docs, map);
    expect(tally).toEqual({ 'NO-MODEL-IN-FILE': 1 });
  });

  it('an unmapped book code is reported, never guessed at', () => {
    const { rows, tally } = grade([{ docs: ['HC-SO-1'], model: '8030', desc2Match: '32"/1R+C+2R' }], docs, {});
    expect(tally).toEqual({ 'UNMAPPED-BOOK-CODE': 1 });
    expect(rows[0].unmapped).toEqual(['DSL-8030 SOFA']);
  });

  it('BOOK-SPLIT when one needle reaches two models - refused, not picked between', () => {
    const { tally } = grade(
      [{ docs: ['HC-SO-5'], model: '8030', desc2Match: 'BEIGE' }],
      { 'SO-5': [['51', 'DSL-8030 SOFA', 'BEIGE/32"'], ['52', 'AMN-SF9058 SOFA', 'BEIGE/30"']] },
      { 'DSL-8030 SOFA': '8030-1S', 'AMN-SF9058 SOFA': '9058-1S' },
    );
    expect(tally).toEqual({ 'BOOK-SPLIT': 1 });
  });
});

describe('the corrections files that ship, against the book cut that ships', () => {
  const DATA = path.join(__dirname, '..', 'scripts', 'data');

  const realGrade = () => {
    const truth = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(path.join(DATA, 'ac-reconcile-truth.json.gz'))).toString('utf8'),
    );
    const F = Object.fromEntries(truth.line_fields.map((n, i) => [n, i]));
    const byType = {};
    for (const type of ['SO', 'PO']) {
      const t = truth.types[type];
      const d2 = new Map(t.desc2.map((r) => [String(r[0]), r[1]]));
      const byDoc = new Map();
      for (const r of t.lines) {
        const d = String(r[F.docNo]);
        if (!byDoc.has(d)) byDoc.set(d, []);
        byDoc.get(d).push({ dtlKey: String(r[F.dtlKey]), itemKey: String(r[F.itemKey]), desc2: d2.get(String(r[F.dtlKey])) ?? '' });
      }
      byType[type] = byDoc;
    }
    const mapping = readMappingCsv(fs.readFileSync(path.join(DATA, 'autocount-erp-mapping-1561.csv'), 'utf8'));
    const { builds } = loadCorrections(DATA);
    return gradeCorrectionsAgainstBook({
      builds,
      bookLines: (doc) => {
        const key = String(doc).replace(/^HC-/, '');
        const byDoc = byType[key.startsWith('SO') ? 'SO' : 'PO'];
        return { present: byDoc.has(key), lines: byDoc.get(key) ?? [] };
      },
      erpCodeFor: (ac) => mapping.get(normCode(ac))?.erp || null,
      desc2Contains,
      alias: SOFA_MODEL_ALIAS,
    });
  };

  it('NO entry names a model the account book does not name', () => {
    const { rows, tally } = realGrade();
    const differ = rows.filter((r) => r.verdict === 'DIFFER');
    /* The message matters more than the count: whoever trips this needs the
       document and both models, not a bare "expected 0". */
    expect(
      differ.map((r) => `${r.docs.join('+')} file=${r.fileModel} book=${r.bookRaw.join('|')}`),
    ).toEqual([]);
    expect(tally.DIFFER ?? 0).toBe(0);
  });

  it('grades every build in both files, so a new one cannot arrive ungraded', () => {
    const { rows } = realGrade();
    const { builds } = loadCorrections(path.join(__dirname, '..', 'scripts', 'data'));
    expect(rows.length).toBe(builds.length);
    expect(rows.length).toBeGreaterThanOrEqual(53);
  });

  it('the three the owner ruled on now carry the book\'s model', () => {
    const { rows } = realGrade();
    const of = (doc) => rows.find((r) => r.docs.includes(doc));
    expect(of('HC-SO-010882').fileModel).toBe('8030');   // Tee, book DSL-8030 SOFA
    expect(of('HC-SO-011660').fileModel).toBe('9058');   // Sulaiman, book AMN-SF9058 SOFA
    expect(of('HC-SO-012629').fileModel).toBe('5535');   // KONG KIT YING, book HOK-5535 SOFA
    for (const d of ['HC-SO-010882', 'HC-SO-011660', 'HC-SO-012629']) expect(of(d).verdict).toBe('AGREE');
  });
});
