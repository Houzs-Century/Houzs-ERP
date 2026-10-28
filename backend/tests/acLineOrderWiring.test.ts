// ----------------------------------------------------------------------------
// A LINE'S POSITION IS PART OF THE DOCUMENT.
//
// Owner, 2026-09-02: 「convert 了的 PO 一定要 remain 在同样的 line，就是例如第四个
// item 就是第 4 个 item，不可以高或低」 — and 「这个要查完全套系统」.
//
// Every read whose rows become an AutoCount payload must go through
// `inAcLineOrder`. Four of the six did not order AT ALL, so Postgres was free to
// hand the same document's lines back in a different order after any edit. This
// pins the rule ON THE READS, because no unit test over the composer can see a
// caller that forgot to sort.
//
// NO CONSTRUCTED REGEX HERE, deliberately. The first version of this file built
// its matcher with `new RegExp(\`from\\\\('${t}'\\\\)\`)`; the escaping collapsed,
// the matcher found NOTHING, and the test passed against the very source it was
// written to reject. Plain string scanning cannot mis-escape, and each table is
// asserted to be FOUND before anything is asserted about it — a verdict computed
// over an empty population must never read as a pass (CLAUDE.md).
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import outboxSrc from '../src/scm/lib/autocount-outbox.ts?raw';
import convertSrc from '../src/scm/lib/autocount-convert-lines.ts?raw';

/** Comments quote the shapes this file forbids, so they are stripped. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SOURCES: Array<[string, string]> = [
  ['autocount-outbox.ts', code(outboxSrc)],
  ['autocount-convert-lines.ts', code(convertSrc)],
];

/** Every line table whose rows reach AutoCount, plus the spec-driven read that
 *  covers DO / GR / SI / PI through one variable. Domain knowledge, written out
 *  — and each entry is asserted to EXIST in the source below. */
const READS = [
  "from('mfg_sales_order_items')",
  "from('purchase_order_items')",
  'from(spec.itemTable)',
];

/** Every occurrence of `needle`, with context on BOTH sides.
 *
 *  The `after` half is not padding: `inAcLineOrder(` wraps the read and sits
 *  BEFORE it, while `.select(` — the thing that makes it a payload read — comes
 *  AFTER. A window that reached backwards only never contained `.select(`, so
 *  every site was skipped as out-of-scope and the test passed against source it
 *  was written to reject. That is the second time this file's matcher silently
 *  matched nothing; hence the presence assertions above it. */
function sitesOf(src: string, needle: string): string[] {
  const out: string[] = [];
  for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) {
    out.push(src.slice(Math.max(0, i - 140), i + needle.length + 200));
  }
  return out;
}

describe('every AutoCount line read is ordered, through the one helper', () => {
  /* THE GUARD ON THE GUARD. If a rename makes a needle stop matching, this fails
     instead of the file quietly asserting nothing — which is exactly what the
     regex version did. */
  test.each(READS)('%s is actually present to be checked', (needle) => {
    const total = SOURCES.reduce((n, [, src]) => n + sitesOf(src, needle).length, 0);
    expect(total, `no source contains ${needle} — the matcher is stale`).toBeGreaterThan(0);
  });

  test.each(READS)('%s is never read without the canonical order', (needle) => {
    for (const [name, src] of SOURCES) {
      for (const site of sitesOf(src, needle)) {
        /* A payload read is one that SELECTS columns; anything else (a count, a
           delete) is not building lines and is out of scope. */
        if (!site.includes('.select(')) continue;
        expect(site, `${name}: a ${needle} payload read is not ordered`)
          .toContain('inAcLineOrder(');
      }
    }
  });

  /* The order must live in ONE place. A second hand-written pair beside a
     payload read is the drift this closes. */
  test('no payload read spells the order out by hand any more', () => {
    for (const [name, src] of SOURCES) {
      expect(src, `${name} still orders inline`).not.toContain("order('created_at', { ascending: true }).order('id'");
    }
  });

  test('the helper sorts by created_at THEN id — a total order, not a partial one', async () => {
    const { inAcLineOrder } = await import('../src/scm/lib/ac-line-order');
    const calls: Array<[string, boolean]> = [];
    const stub = {
      order(col: string, o: { ascending: boolean }) { calls.push([col, o.ascending]); return stub; },
    };
    inAcLineOrder(stub);
    /* `created_at` alone is a PARTIAL order — a bulk insert gives several rows
       the same timestamp, and Postgres may then return them in any order. `id`
       is the tiebreak that makes it total. */
    expect(calls).toEqual([['created_at', true], ['id', true]]);
  });
});
