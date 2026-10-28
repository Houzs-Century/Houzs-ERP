import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared by the PO-arm check and its repair
import {
  classifyPoLine, tally, buildCollidedPoKey, parseAcToErpCsv, asVariantObject, blockFor,
} from '../scripts/lib/po-arm-own-text.mjs';
// @ts-expect-error - plain .mjs
import { parseBedframe } from '../scripts/lib/parse-bedframe.mjs';

/* WHY THIS FILE EXISTS. check-po-arm-own-text.mjs answers a question whose most
   likely answer is ZERO - the outstanding-PO export holds 338 rows against the
   SO export's 13,588, so most PO lines never reached the collided key. A zero
   from a detector nobody tested is indistinguishable from a detector that
   cannot see. So the cases below PLANT each condition and require the
   classifier to name it, and the load-bearing one is
   `a line stamped from another line's text is caught`.

   The collision, restated: pre-#1958 refresh-po-variants.mjs looked its parse up
   by `${linked_ac_docno}|${item_code}`, which is not a line identity. Two
   export rows sharing that pair collapsed onto the LAST one, whose parse was
   then stamped onto every ERP line sharing the key. */

const CSV = [
  'AutoCountCode,ErpCode',
  'CODY (Q),CODY-(Q)',
  'JAGER (Q),JAGER-(Q)',
  'SOLO (K),SOLO-(K)',
].join('\n');

/* Two export rows on ONE purchase order, same SKU, different builds - exactly
   the shape that collides. The SURVIVOR is the last one. */
const EXPORT = [
  { DocNo: 'PO-009722', DtlKey: 884635, ItemCode: 'CODY (Q)', Desc2: `frontdrawer/Col:PC151-01/Div:8"+1"/M'GP:14"` },
  { DocNo: 'PO-009722', DtlKey: 884637, ItemCode: 'CODY (Q)', Desc2: `frontdrawer/Col:PC151-01/Div:8"+1"/M'GP:10"` },
  { DocNo: 'PO-009790', DtlKey: 889846, ItemCode: 'JAGER (Q)', Desc2: 'Divan:10inch+noleg/m.gap:12inch/col:PC151-02' },
];

/* A colour matcher over a tiny library. `findColour` is the one dependency the
   classifier takes from the database, so it is stubbed rather than mocked away
   - the axes it feeds (colourId) must still be exercised. */
const LIBRARY = [
  { fabric_id: 'PC151', colour_id: 'PC151-01', label: 'PC151-01 Ash' },
  { fabric_id: 'PC151', colour_id: 'PC151-02', label: 'PC151-02 Slate' },
];
const findColour = (c: string | null | undefined) =>
  LIBRARY.find((x) => x.colour_id.toUpperCase() === String(c ?? '').trim().toUpperCase()) ?? null;

const acToErp = parseAcToErpCsv(CSV);
const collided = buildCollidedPoKey(EXPORT, acToErp);
const byDtl = new Map(EXPORT.map((r) => [Number(r.DtlKey), r]));
const ctx = { byDtl, collided, findColour };

/** The variant block a given AutoCount text SHOULD produce. */
const blockOf = (text: string) => {
  const b = blockFor(parseBedframe(text), findColour);
  delete (b as Record<string, unknown>)._n;
  return b;
};

const OWN = `frontdrawer/Col:PC151-01/Div:8"+1"/M'GP:14"`;      // dtl 884635, the LOSER
const SURVIVOR = `frontdrawer/Col:PC151-01/Div:8"+1"/M'GP:10"`; // dtl 884637

const line = (over: Record<string, unknown> = {}) => ({
  id: 'row-1', po_number: 'HC-PO-000001', ac: 'PO-009722', item_code: 'CODY-(Q)',
  dtl: 884635, status: 'RECEIVED', d2: OWN, variants: blockOf(OWN), ...over,
});

describe('the collided key is rebuilt exactly as the defect built it', () => {
  test('last write wins, which is what made one line wear another line\'s build', () => {
    expect(collided.get('PO-009722|CODY-(Q)').DtlKey).toBe(884637);
    expect(collided.size).toBe(2);
  });

  test('a row the CSV cannot map is absent, not guessed at', () => {
    const m = buildCollidedPoKey([{ DocNo: 'PO-1', DtlKey: 1, ItemCode: 'NOT IN THE CSV', Desc2: 'x' }], acToErp);
    expect(m.size).toBe(0);
  });
});

describe('classifying one purchase-order line against its own description2', () => {
  test('a healthy line AGREES and is attributed to nothing', () => {
    const v = classifyPoLine(line(), ctx);
    expect(v.verdict).toBe('AGREES');
    expect(v.covered).toBe(true);           // the buggy key did hit it
    expect(v.provenance).toBe('CORROBORATED');
  });

  test('THE LOAD-BEARING CASE: a line stamped from another line\'s text is caught', () => {
    /* The row holds the SURVIVOR's build while its own description2 says
       otherwise. This is the damage the SO arm had 85 of. */
    const v = classifyPoLine(line({ variants: blockOf(SURVIVOR) }), ctx);
    expect(v.verdict).toBe('MISMATCH');
    expect(v.attributable).toBe(true);      // exactly what the collided key produced
    expect(v.axes).toEqual(['gap']);
    expect(v.from).toEqual({ gap: '10"' });
    expect(v.to).toEqual({ gap: '14"' });
  });

  test('a mismatch that is NOT what the collided key would have produced is not attributed', () => {
    /* A human chose this, or something else wrote it. Repairing it from a
       re-parse would overwrite a real decision - which is why attribution is a
       separate flag and not a synonym for "mismatch". */
    const v = classifyPoLine(line({ variants: { ...blockOf(OWN), colourId: 'PC151-02' } }), ctx);
    expect(v.verdict).toBe('MISMATCH');
    expect(v.attributable).toBe(false);
    expect(v.axes).toEqual(['colourId']);
  });

  test('a line the export never named cannot be attributed even when it mismatches', () => {
    /* The fallback path: `parseBedframe(description2)` is line-accurate by
       construction, so a mismatch here has some other cause. */
    const v = classifyPoLine(line({ ac: 'PO-999999', variants: blockOf(SURVIVOR) }), ctx);
    expect(v.covered).toBe(false);
    expect(v.verdict).toBe('MISMATCH');
    expect(v.attributable).toBe(false);
  });

  test('no description2 means NO-TEXT - never a fall back to position', () => {
    const v = classifyPoLine(line({ d2: null }), ctx);
    expect(v.verdict).toBe('NO-TEXT');
    expect(v).not.toHaveProperty('axes');
  });

  test('a damaged variants shape is its own bucket, not silently unwrapped', () => {
    /* #1938's repair owns these. Guessing at element 0 is how a repair writes
       into a column it does not understand.

       THE STRING CASE IS THE SUBTLE ONE, and this assertion is here because the
       first draft of the classifier got it wrong. A jsonb STRING scalar - the
       shape the double-encoding defect leaves behind - JSON.parses into a
       perfectly sensible object, so a helper that unwraps it reports the row as
       AGREES. In the DATABASE `variants->>'colourId'` on that row is NULL and
       every consumer reads nothing. Calling it healthy would be a FALSE CLEAN,
       which is the one result this check must never produce. */
    for (const damaged of [[blockOf(OWN), 'a stringified patch'], JSON.stringify(blockOf(OWN))])
      expect(classifyPoLine(line({ variants: damaged }), ctx).verdict).toBe('BAD-SHAPE');
    expect(asVariantObject([{ a: 1 }])).toBeNull();
    expect(asVariantObject('{"a":1}')).toBeNull();   // parses in JS, unreadable in SQL
    expect(asVariantObject('not json')).toBeNull();
    expect(asVariantObject(null)).toBeNull();
    expect(asVariantObject({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('DtlKey provenance is reported but never used as evidence', () => {
  /* backfill-ac-line-keys.mjs zipped these keys on by line_no under the SAME
     (DocNo | item code) grouping that collided, so a join on one inherits the
     guess. The four outcomes mirror section B so the arms read side by side. */
  test('the four outcomes', () => {
    expect(classifyPoLine(line(), ctx).provenance).toBe('CORROBORATED');
    expect(classifyPoLine(line({ d2: 'text that is not what the export holds' }), ctx).provenance).toBe('CONTRADICTED');
    expect(classifyPoLine(line({ dtl: null }), ctx).provenance).toBe('NO-DTLKEY');
    expect(classifyPoLine(line({ dtl: 999999 }), ctx).provenance).toBe('KEY-NOT-IN-EXPORT');
    expect(classifyPoLine(line({ d2: null }), ctx).provenance).toBe('NO-DESCRIPTION2');
  });

  test('a CONTRADICTED key does not by itself make the row a mismatch', () => {
    /* The row can still agree with its OWN text while the stored key points
       somewhere else - which is precisely why the key is not the authority. */
    const v = classifyPoLine(line({ dtl: 889846 }), ctx);   // a key belonging to another PO
    expect(v.provenance).toBe('CONTRADICTED');
    expect(v.verdict).toBe('AGREES');
  });
});

describe('the tally segments by whether the export covered the line', () => {
  test('a handful of bad rows is not allowed to hide inside the good ones', () => {
    const verdicts = [
      classifyPoLine(line({ id: 'a' }), ctx),                                        // covered, agrees
      classifyPoLine(line({ id: 'b', variants: blockOf(SURVIVOR) }), ctx),           // covered, DAMAGE
      classifyPoLine(line({ id: 'c', ac: 'PO-999999' }), ctx),                       // fell through, agrees
      classifyPoLine(line({ id: 'd', ac: 'PO-999999', d2: null }), ctx),             // fell through, no text
    ];
    const t = tally(verdicts);
    expect(t.covered).toMatchObject({ lines: 2, agrees: 1, mismatch: 1, attributable: 1, noText: 0 });
    expect(t.fellThrough).toMatchObject({ lines: 2, agrees: 1, mismatch: 0, attributable: 0, noText: 1 });
    expect(t.total).toMatchObject({ lines: 4, agrees: 2, mismatch: 1, attributable: 1, noText: 1 });
    // every line lands in exactly one bucket of its segment
    for (const s of [t.covered, t.fellThrough, t.total])
      expect(s.agrees + s.mismatch + s.noText + s.badShape).toBe(s.lines);
  });
});

describe('the parser bug fixed alongside this must not be re-introduced', () => {
  /* `(\d+)` with no left boundary read `PC151 divan` as 151 inches and, worse,
     `PC151-01 divan` as 1 inch - a plausible value invisible to any range
     check. Fixed at 8 sites. A fabric code sitting beside a real measurement is
     COINCIDENCE, not corruption: the line below genuinely has a 1" leg. */
  test('a fabric code is not read as a measurement', () => {
    const bf = parseBedframe(`frontdrawer/Col:PC151-01/Div:8"+1"/M'GP:14"`);
    expect(bf.gap).toBe(14);
    expect(bf.divan).toBe(8);
    expect(bf.leg).toBe(1);        // the real 1-inch leg, not the "-01" of PC151-01
    expect(bf.color).toBe('PC151-01');
  });
});
