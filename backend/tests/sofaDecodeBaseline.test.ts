// THE BOOK'S OWN TEXT, DECODED, PINNED.
//
// Seventeen sofa builds cannot be written to AutoCount, and the remedy for most
// of them is to teach `parse-sofa.mjs` a notation it does not have. That is a
// change to the function which reads the 15,950 Desc2 values the account book
// already holds — the same function both cutover importers used to derive every
// sofa's compartments, colour and specials. A change that quietly re-reads one
// of those is not a bug that shows up as a failure; it shows up as a document
// that means something else than it did.
//
// So this pins the CURRENT reading of the whole corpus behind one fingerprint.
// It asserts nothing about whether any particular reading is right — only that
// nobody changes one without noticing. A deliberate improvement updates the
// fingerprint in the same commit, with the reason, and the diff shows how many
// lines moved.
//
// WHY A FINGERPRINT AND NOT 15,950 ASSERTIONS: the corpus is committed data, the
// decode is pure, and the useful signal is "did anything move at all". A hash
// gives that in one line and costs one pass. When it does move, re-run the probe
// in this file's own comment to see WHICH lines.
//
// Written 2026-09-09 after a proposed decoder-adjacent change was measured
// against a shape no document has (bare `3S` instead of `3S (28")`) and had to
// be withdrawn — docs/bugs/0762. A fingerprint over the real corpus is the check
// that a hand-written measurement kept failing to be.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSofa } from '../scripts/lib/parse-sofa.mjs';

/** The reading of every book Desc2, as one value. Deterministic: the corpus is
 *  committed, the decode is pure, and rows are keyed by DtlKey in file order. */
function fingerprint(): { lines: number; threw: number; hash: string } {
  const raw = readFileSync(resolve(__dirname, '../scripts/data/ac-fidelity-so-lines.json.gz'));
  const rows = JSON.parse(gunzipSync(raw).toString('utf8')) as Array<Record<string, unknown>>;
  const h = createHash('sha256');
  let lines = 0;
  let threw = 0;
  for (const r of rows) {
    const desc2 = String(r.Desc2 ?? '');
    if (!desc2) continue;
    lines += 1;
    /* The model is the item code's first segment — the same split
       `splitSofaCode` makes. It only has to be STABLE for the fingerprint to
       mean something. */
    const model = String(r.ItemCode ?? '').split('-')[0] ?? '';
    let out: string;
    try {
      out = JSON.stringify(parseSofa(desc2, model, false));
    } catch (e) {
      threw += 1;
      out = `THREW:${e instanceof Error ? e.message : String(e)}`;
    }
    h.update(`${String(r.DtlKey)}\u0000${out}\n`);
  }
  return { lines, threw, hash: h.digest('hex') };
}

describe('the decoder reads the account book the same way it did', () => {
  it('decodes every Desc2 the book holds, and none of them throws', () => {
    const { lines, threw } = fingerprint();
    /* A corpus that came back EMPTY would make the hash below assert nothing —
       the failure mode CLAUDE.md names: a verdict computed over nothing must
       never read as a pass. */
    expect(lines).toBeGreaterThan(15_000);
    expect(threw).toBe(0);
  });

  it('reads all 15,950 of them EXACTLY as it did on 2026-09-09', () => {
    const { lines, hash } = fingerprint();
    expect(lines).toBe(15_950);
    /* MOVING THIS NUMBER IS THE POINT, not the obstacle. Change the decoder on
       purpose, see this fail, satisfy yourself that every line that moved was
       meant to, and update it in the same commit saying how many and why. What
       must never happen is the corpus being re-read by accident. */
    expect(hash).toBe('75e4b345d3cfad265475e45c6044169fd7c99b753a71c2eb31fbc42a6b5cfe05');
  });
});
