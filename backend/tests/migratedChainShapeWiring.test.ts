// A MEASUREMENT THAT NEVER REACHES THE VERDICT IS NOT A MEASUREMENT.
//
// `splitMigratedChainLineShape` has been measuring, since 2026-09-08, which
// sales- and purchase-invoice line-count differences are the line SHAPE the
// migrated chain produces by design. It printed its count in the SUMMARY and
// nothing ever called `reclassify`, so every document it had cleared went on
// being counted as work in the per-document verdict — the owner's report. That
// is docs/bugs/0715's failure with the arrow reversed: there a comparison that
// never ran was counted as a difference; here a split that DID run was thrown
// away.
//
// The unit logic lives in scripts/lib/ac-not-a-difference.mjs and is pinned by
// tests/acNotADifference.test.ts — including the two gates that stop it being an
// amnesty. This file makes sure a refactor cannot quietly unhook it from the
// reconcile again, the same source-anchored way acNotSentWiring.test.ts pins the
// AutoCount refusal.
import { describe, expect, test } from 'vitest';
import reconcileRaw from '../scripts/check-ac-erp-reconcile.mjs?raw';
import splitsRaw from '../scripts/lib/ac-not-a-difference.mjs?raw';
import { NOTE_CLASSES } from '../scripts/lib/so-verdict-derive.mjs';
import { DECLARED_LABEL } from '../scripts/lib/so-tally-verdict.mjs';

/* Line endings: these are source-TEXT anchors and a CRLF checkout must not turn
   a wired-up repo red. Same reason soLocationGateWiring.test.ts records. */
const n = (s: string) => s.replace(/\r\n/g, '\n');
const reconcile = n(reconcileRaw);
const splits = n(splitsRaw);

/** The one class name. If this string moves, every assertion below moves. */
const KLASS = 'migrated-chain-line-shape';

describe('the migrated-chain shape reaches the per-document verdict', () => {
  test('the reconcile reclassifies the LINE COUNT the split cleared', () => {
    expect(reconcile).toContain(
      `for (const r of LS.moved) VERDICT.reclassify(t, r.key, "line count", "${KLASS}", r.line);`,
    );
  });

  test('the reconcile reclassifies the UNPAIRED BOOK LINE the split cleared', () => {
    expect(reconcile).toContain('splitMigratedChainUnpairedBookLine({ rows: unpairedBookLineRows');
    expect(reconcile).toContain(`VERDICT.reclassify(t, r.key, "a book line we do not have", "${KLASS}", r.line);`);
  });

  test('both reclassifications are fenced behind the split having APPLIED', () => {
    // A split that could not read its facts reclassifies nothing. Without the
    // guard, `moved` is empty anyway — but the guard is what says so out loud,
    // and it is what a reader checks instead of reasoning about the empty array.
    expect(reconcile).toContain('if (LS.applied) {');
    expect(reconcile).toContain('if (UB.applied) {');
  });

  test('the unpaired-book-line rows are COLLECTED, never parsed back out of the printed string', () => {
    // A classifier that pattern-matches a human-readable line is the failure the
    // reconcile already avoids for `itemRows` and `moneyRows`.
    expect(reconcile).toContain('const unpairedBookLineRows = [];');
    expect(reconcile).toContain('unpairedBookLineRows.push({ key: ac, erpNo: d.erp_no, line: msgAc });');
  });

  test('one row per DOCUMENT, or the count-preserving check would count one document twice', () => {
    expect(reconcile).toContain('if (!unpairedBookLineRows.some((r) => r.key === ac)) {');
  });

  test('the two axes are split by ONE verdict function, so they cannot disagree about a document', () => {
    expect(splits).toContain('function migratedChainShapeVerdict(f, key) {');
    expect(splits).toContain('function splitOnChainShape({ rows, facts }, what, why, unprovenWhy) {');
  });

  test('the class is declared, and carries a sentence the owner can read', () => {
    expect(NOTE_CLASSES).toContain(KLASS);
    expect(DECLARED_LABEL[KLASS]).toBeTruthy();
    // What it must SAY, because a declaration nobody can check is a suppression
    // (docs/bugs/0668): that the invoice is built from our own document, and
    // that an invoice which does not reconcile is still counted.
    expect(DECLARED_LABEL[KLASS]).toContain('OUR delivery order');
    expect(DECLARED_LABEL[KLASS]).toContain('still counted as a difference');
  });

  test('only the types DECLARED as the migrated chain are eligible', () => {
    // The eligibility is `cfg.migratedChainLineShape`, which lives on the type
    // config in lib/ac-reconcile-erp-sql.mjs — not a list of type letters here.
    expect(reconcile).toContain('const UB = cfg.migratedChainLineShape');
  });
});
