// ----------------------------------------------------------------------------
// ONE RULE, ALL SIX DOCUMENT TYPES: the SET of lines decides.
//
// Owner 2026-09-02, once the old connector's own API had been read off the host:
//
//   「如果只是 edit SKU、换东西或者添加 variants 等等，我们就直接照现在的模式去做。
//     那如果我们有 delete line、add line 导致了它的 line 不平整了，我们就整张重建」
//
// So the axis is not the document TYPE and not the SDK's shape:
//
//   same lines, edited   -> match on the AutoCount key, edit in place. Every
//                           DtlKey survives, which this system needs and the old
//                           connector never did.
//   a line ADDED/REMOVED -> rebuild. The book is cleared and the ERP's list laid
//                           down, so the two sides finish identical.
//
// The first version of this rule keyed off whether the SDK exposes DeleteDetail
// — true for SalesOrder, false for the other five — so one operator action had
// two behaviours decided by a detail nobody outside one file could see. His word
// for that was 「规则变形」. This file exists so it cannot come back.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { rebuildNeededForLineSetChange } from '../src/services/ac-line-gone';
import writebackSrc from '../src/services/autocount-writeback.ts?raw';
import serviceSrc from '../scripts/autocount-service/AcSyncService.cs?raw';
import outboxSrc from '../src/scm/lib/autocount-outbox.ts?raw';

/* Line endings are normalised first. `core.autocrlf` gives the working tree CRLF
   on Windows, so a matcher anchored on a bare newline silently finds nothing and
   the test passes against the very source it was written to reject — which has
   happened three times in one day in this repo. Normalise once, match on LF. */
const lf = (s: string): string => s.split('\r\n').join('\n');
const code = (s: string): string =>
  lf(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const WRITEBACK = code(writebackSrc);
const SERVICE = code(serviceSrc);
const OUTBOX = code(outboxSrc);

describe('the rule is about the line SET, not the document type', () => {
  test('every combination, and there are only four', () => {
    expect(rebuildNeededForLineSetChange(false, false)).toBe(false); // edits only
    expect(rebuildNeededForLineSetChange(true, false)).toBe(true);   // a line added
    expect(rebuildNeededForLineSetChange(false, true)).toBe(true);   // a line removed
    expect(rebuildNeededForLineSetChange(true, true)).toBe(true);    // both
  });

  /* THE REGRESSION THIS FILE IS FOR. A per-type table is what made one action
     behave two ways. The rule takes no document type at all now, and cannot. */
  test('the rule cannot see the document type', () => {
    expect(rebuildNeededForLineSetChange.length).toBe(2);
    expect(WRITEBACK).not.toMatch(/SDK_DELETES_ONE_LINE/);
    expect(WRITEBACK).not.toMatch(/rebuildNeededToRemoveLine/);
  });

  /* An edit that changes no line SET must NOT rebuild: a rebuild destroys and
     reissues every DtlKey, and this system holds those downstream
     (PODTL.FromSODtlKey, the transfer chain, the line photographs). Swapping a
     SKU or adding variants may never cost that. */
  test('editing the same lines never rebuilds', () => {
    expect(rebuildNeededForLineSetChange(false, false)).toBe(false);
  });
});

describe('composeEdit derives it — no caller can forget, none can disagree', () => {
  test('both halves of the set change are read', () => {
    expect(WRITEBACK).toMatch(/rebuildNeededForLineSetChange\(anyAdded, anyDeleted\)/);
    expect(WRITEBACK).toMatch(/retired\.some\(\(r\) => r\.Gone === 'deleted'\)/);
    expect(WRITEBACK).toMatch(/anyAdded = \(opts\.newLineIds\?\.size \?\? 0\) > 0/);
  });

  test('an explicit request still survives the derivation', () => {
    expect(WRITEBACK).toMatch(/\{ \.\.\.opts, rebuild: true \}/);
  });

  test('the parameter is not reassigned', () => {
    expect(WRITEBACK).not.toMatch(/^\s*opts = effOpts;/m);
    expect(WRITEBACK).toMatch(/composeDetails\(lines, effOpts\)/);
  });

  /* Every DELETE route funnels through one reader, so "a line was removed" is
     one fact with one source rather than six flags. */
  test('the deleted stamp has exactly one source', () => {
    expect(OUTBOX.match(/Gone: 'deleted'/g) ?? []).toHaveLength(1);
  });
});

describe('the host carries no per-type special case any more', () => {
  test('the source actually loaded', () => {
    expect(SERVICE.length).toBeGreaterThan(1000);
  });

  /* DeleteDetail was the mechanism that varied by type. Under the set rule it is
     unreachable — a removed line means a rebuild, and a rebuilt document never
     carries the line at all — so it is gone rather than left as dead code that
     reads like a second rule. */
  test('nothing calls DeleteDetail, and nothing collects keys to delete', () => {
    expect(SERVICE).not.toMatch(/doc\.DeleteDetail\(/);
    expect(SERVICE).not.toMatch(/toDelete/);
  });

  test('the retire branch remains, for a line the ERP still HAS but cancelled', () => {
    expect(SERVICE).toMatch(/if \(Bool\(it, "Retire"\)\) \{/);
    expect(SERVICE).toMatch(/d\.Qty = 0;/);
  });

  /* The rebuild itself is untouched by this simplification, and still refuses on
     a document the book says was transferred. */
  test('the rebuild and its guard are still there', () => {
    expect(SERVICE).toMatch(/doc\.ClearDetails\(\);/);
    expect(SERVICE).toMatch(/if \(AnyLineTransferred\(type, docNo\)\)/);
  });
});
