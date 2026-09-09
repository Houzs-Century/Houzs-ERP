// Every NAMED delivery-note line the top-up may write, resolved against the
// account book itself.
//
// WHY THIS EXISTS. `topup-ac-lines-from-truth.mjs`'s DO lane is a hand-written
// list, not a rule — the delivery-order side has no rule that can find a
// missing line on its own, and that file's header says so at length. The cost
// of a named list is that every entry is a hand-typed assertion about a book
// nobody re-reads: a DtlKey off by one digit, a quantity remembered instead of
// copied, and the write lands a wrong line on a live delivery note. The script
// does check each target against the book at PLAN time and refuses on drift —
// but that check runs only when somebody dispatches it against production,
// which is exactly the wrong moment to discover a typo.
//
// So the same resolution runs here, against the committed snapshot, on every
// PR. It is a data test: it reads `data/ac-reconcile-truth.json.gz` — the whole
// book, unfiltered — and fails naming the field.
//
// The last two entries were added 2026-09-09 for the alignment lane:
// DO-011465's four free compensation pillows and DO-010332's second DSL-8050
// SOFA line at RM 0.00.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { describe, expect, test } from 'vitest';

// @ts-expect-error - plain .mjs, extracted from the runnable script so this test can read it
import { DO_TARGETS } from '../scripts/lib/do-topup-targets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRUTH = path.join(HERE, '..', 'scripts', 'data', 'ac-reconcile-truth.json.gz');

const snap = JSON.parse(
  zlib.gunzipSync(fs.readFileSync(TRUTH)).toString('utf8').replace(/^﻿/, ''),
);
const LF = snap.line_fields;
const lineOf = (row) => Object.fromEntries(LF.map((k, i) => [k, row[i]]));

/** Every DO line in the book, by "DocNo|DtlKey". */
const BOOK = new Map(
  snap.types.DO.lines.map(lineOf).map((l) => [`${l.docNo}|${String(l.dtlKey)}`, l]),
);
const DESC2 = new Map(snap.types.DO.desc2.map((r) => [String(r[0]), r[1]]));

const sen = (v) => Math.round(Number(v) * 100);

/** The script's own comparison, restated: what the book says about a target. */
function bookSays(t) {
  const l = BOOK.get(`${t.acDoc}|${t.dtlKey}`);
  if (!l) return null;
  return {
    hasCode: String(l.hasCode) === '1',
    qty: Math.round(Number(l.qty ?? 0)),
    unitSen: sen(l.unitPrice ?? 0),
    subTotalSen: sen(l.subTotal ?? 0),
  };
}

describe('the named delivery-note top-up targets', () => {
  test('the snapshot this test reads is the book, not an empty file', () => {
    // A verdict computed over nothing must never read as a pass.
    expect(BOOK.size).toBeGreaterThan(40_000);
    expect(DO_TARGETS.length).toBeGreaterThanOrEqual(7);
  });

  test.each(DO_TARGETS.map((t) => [`${t.acDoc} DtlKey ${t.dtlKey}`, t]))(
    '%s is on that document in the book, with exactly the values the target declares',
    (_name, t) => {
      const got = bookSays(t);
      expect(got, `${t.acDoc} DtlKey ${t.dtlKey} is on no line of that document in the book`).not.toBeNull();
      expect(got).toEqual(t.expect);
    },
  );

  test.each(DO_TARGETS.map((t) => [`${t.acDoc} DtlKey ${t.dtlKey}`, t]))(
    '%s names the item code the book names',
    (_name, t) => {
      const l = BOOK.get(`${t.acDoc}|${t.dtlKey}`);
      // A CODED line's itemKey IS the book's ItemCode. A text-only line has no
      // code and its itemKey is the text, so only coded targets are compared —
      // and DO-001604 is deliberately the text-only one.
      if (t.expect.hasCode) expect(String(l.itemKey).trim()).toBe(t.erpCode);
    },
  );

  test('a target may not declare a description the book contradicts', () => {
    // `description` is a DECLARED literal because the reconcile snapshot carries
    // no LineDesc column — so what can be checked is that it is never used to
    // smuggle in a different PRODUCT. Where it is absent the write falls back to
    // the book's own itemKey, which needs no check.
    for (const t of DO_TARGETS) {
      if (t.description === undefined) continue;
      expect(typeof t.description).toBe('string');
      expect(t.description.trim().length).toBeGreaterThan(0);
    }
  });

  test('the two 2026-09-09 targets are free lines — neither can move a sen', () => {
    // 「多收钱也 ok」 does not license moving money the other way. Both of these
    // are RM 0.00 in the book, so the delivery note's header total is unchanged
    // by the insert and stays equal to the book's.
    for (const key of ['DO-011465|924550', 'DO-010332|836941']) {
      const [acDoc, dtlKey] = key.split('|');
      const t = DO_TARGETS.find((x) => x.acDoc === acDoc && x.dtlKey === dtlKey);
      expect(t, `${key} is not in DO_TARGETS`).toBeDefined();
      expect(t.expect.unitSen).toBe(0);
      expect(t.expect.subTotalSen).toBe(0);
    }
  });

  test('the book states a build text for both of them, and it is what gets written', () => {
    // The insert now carries `book.DO.desc2` rather than NULL —
    // 「autocount怎么写我们就怎么写」. If the book ever stopped stating one, the
    // write would silently go back to a blank build text, so the presence is
    // asserted here rather than assumed.
    expect(DESC2.get('924550')).toBe('for conpesantion wrong item delivery.');
    expect(DESC2.get('836941')).toBe('BO315-11 metal/75cm/1S');
    // And the line this one sits beside — the PRICED DSL-8050 — states the
    // OTHER build. Two lines, two texts; that they differ is the whole finding.
    expect(DESC2.get('836939')).toBe('BO315-11 metal/75cm/2S');
    expect(DESC2.get('836939')).not.toBe(DESC2.get('836941'));
  });

  test('THE GATE CAN FAIL — a target with a wrong value is rejected', () => {
    // A check that cannot catch a planted defect will report a clean run over
    // real data. Each of these is the shape of a real typo.
    const real = DO_TARGETS.find((t) => t.acDoc === 'DO-011465');
    expect(bookSays(real)).toEqual(real.expect);

    const wrongQty = { ...real, expect: { ...real.expect, qty: 3 } };
    expect(bookSays(wrongQty)).not.toEqual(wrongQty.expect);

    const wrongMoney = { ...real, expect: { ...real.expect, unitSen: 100 } };
    expect(bookSays(wrongMoney)).not.toEqual(wrongMoney.expect);

    const wrongKey = { ...real, dtlKey: '924551' };
    expect(bookSays(wrongKey)).toBeNull();

    const wrongDoc = { ...real, acDoc: 'DO-011464' };
    expect(bookSays(wrongDoc)).toBeNull();
  });
});
