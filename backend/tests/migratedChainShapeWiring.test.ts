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
import chainRaw from '../scripts/lib/ac-chain-shape.mjs?raw';
import hopRaw from '../scripts/lib/ac-source-hop.mjs?raw';
import { NOTE_CHAIN_SHAPE, NOTE_SOURCE_NOT_MIGRATED } from '../scripts/lib/ac-chain-shape.mjs';
import { NOTE_CLASSES } from '../scripts/lib/so-verdict-derive.mjs';
import { DECLARED_LABEL } from '../scripts/lib/so-tally-verdict.mjs';

/* Line endings: these are source-TEXT anchors and a CRLF checkout must not turn
   a wired-up repo red. Same reason soLocationGateWiring.test.ts records. */
const n = (s: string) => s.replace(/\r\n/g, '\n');
const reconcile = n(reconcileRaw);
const splits = n(splitsRaw);
const chain = n(chainRaw);
const hop = n(hopRaw);

/** The one class name. If this string moves, every assertion below moves. */
const KLASS = 'migrated-chain-line-shape';

describe('the migrated-chain shape reaches the per-document verdict', () => {
  test('the reconcile CALLS the module, on both halves, with the recorder', () => {
    expect(reconcile).toContain('import { applyChainShape, recordUnpairedBookLine, reportChainShape, sourceDecisionFor }');
    expect(reconcile).toContain('const { LS, UB, SRC } = applyChainShape({');
    expect(reconcile).toContain('recorder: VERDICT, ...sourceDecisionFor(erp, book, t) });');
    expect(reconcile).toContain('reportChainShape({ t, LS, UB, SRC, log, plain, first, show: SHOW });');
  });

  test('the module reclassifies the LINE COUNT the split cleared', () => {
    expect(NOTE_CHAIN_SHAPE).toBe(KLASS);
    expect(chain).toContain('recorder.reclassify(t, r.key, "line count", NOTE_CHAIN_SHAPE, r.line)');
  });

  test('the module reclassifies the UNPAIRED BOOK LINE the split cleared', () => {
    expect(chain).toContain('splitMigratedChainUnpairedBookLine({ rows: unpairedBookLineRows, facts })');
    expect(chain).toContain('recorder.reclassify(t, r.key, "a book line we do not have", NOTE_CHAIN_SHAPE, r.line)');
  });

  test('both reclassifications are fenced behind the split having APPLIED', () => {
    // A split that could not read its facts reclassifies nothing. Without the
    // guard, `moved` is empty anyway — but the guard is what says so out loud,
    // and it is what a reader checks instead of reasoning about the empty array.
    expect(chain).toContain('if (LS.applied)');
    expect(chain).toContain('if (UB.applied) {');
  });

  test('the unpaired-book-line rows are COLLECTED, never parsed back out of the printed string', () => {
    // A classifier that pattern-matches a human-readable line is the failure the
    // reconcile already avoids for `itemRows` and `moneyRows`.
    expect(reconcile).toContain('const unpairedBookLineRows = [];');
    expect(reconcile).toContain('recordUnpairedBookLine(unpairedBookLineRows,');
  });

  test('one row per DOCUMENT, or the count-preserving check would count one document twice', () => {
    expect(chain).toContain('const already = rows.find((r) => r.key === key);');
  });

  test('EVERY unpaired book line key is kept, not just the first', () => {
    // The second pass judges the document by all of them. Keeping only the
    // first would amnesty a document whose later line is a real defect.
    expect(chain).toContain('if (already) already.bookDtlKeys.push(dtlKey);');
  });
});

/* The SECOND pass over the same axis. It is the one that can hide real work, so
 * everything that makes it honest is anchored here as well as unit-tested:
 * it runs on the rows the shape proof REFUSED, its coverage is READ off the ERP
 * and never off `SCOPE`, and it reclassifies through the recorder. */
describe('the unmigrated source order reaches the per-document verdict', () => {
  test('it runs on the REFUSED rows, so the two lanes cannot both claim a document', () => {
    expect(chain).toContain('rows: UB.refused, decision: sourceDecision, coverage: sourceCoverage, sourceOf,');
  });

  test('it reclassifies, and only when it APPLIED', () => {
    expect(NOTE_SOURCE_NOT_MIGRATED).toBe('chain-source-not-migrated');
    expect(chain).toContain('if (SRC.applied) {');
    expect(chain).toContain('recorder.reclassify(t, r.key, "a book line we do not have", NOTE_SOURCE_NOT_MIGRATED, r.line)');
  });

  test('the coverage is MEASURED off the ERP rows, never taken from the scope', () => {
    expect(hop).toContain('const rows = erp?.[sourceType]?.docs;');
    expect(hop).toContain('if (!Array.isArray(rows) || !rows.length) return null;');
    // SCOPE states the population the migration was DEFINED to carry. Reading
    // it as what we HOLD is how a gap gets read out as a decision (bugs 0668).
    // The word appears in the header, saying why it is NOT used. What must
    // be absent is a READ of it.
    expect(hop).not.toMatch(/SCOPE[.[]/);
    expect(reconcile).not.toContain('sourceCoverage: SCOPE');
  });

  test('the type declares it — no type letter is written into the wiring', () => {
    expect(chain).toContain('const sourceDecision = UNMIGRATED_SOURCE[t] ?? null;');
    expect(reconcile).toContain('...sourceDecisionFor(erp, book, t)');
    expect(chain).not.toMatch(/["'](IV|PI)["']/);
  });

  test('the three arguments are resolved TOGETHER, not assembled at the call site', () => {
    // They are one decision wearing three fields; a caller that pairs them by
    // hand can pair a declaration with the wrong coverage and nothing notices.
    expect(chain).toContain('export function sourceDecisionFor(erp, book, t) {');
  });

  test('an unresolvable hop returns NOTHING, never a bare source', () => {
    // `[]` must read as "unproven". Returning the receipt as the source would
    // answer a different question and the rule would believe it.
    expect(hop).toContain('if (!receiptLines) return [];');
    expect(hop).toContain('if (!ft || !fd) return [];');
  });

  test('the class is declared, and says what still counts as a difference', () => {
    expect(NOTE_CLASSES).toContain(NOTE_SOURCE_NOT_MIGRATED);
    expect(DECLARED_LABEL[NOTE_SOURCE_NOT_MIGRATED]).toBeTruthy();
    expect(DECLARED_LABEL[NOTE_SOURCE_NOT_MIGRATED]).toContain('still counted as a difference');
  });

  test('a document the second pass answered is NOT also printed as still counted', () => {
    expect(chain).toContain('const answered = new Set(SRC.applied ? SRC.moved.map((r) => r.key) : []);');
    expect(chain).toContain('const stillCounted = UB.impostors.filter((i) => !answered.has(i.key));');
  });

  test('a document that stays is printed ONCE, with both reasons on it', () => {
    // Run 34376960030 printed the same 78 purchase invoices twice — once per
    // pass — which reads as 156 documents' worth of work.
    expect(chain).toContain('const srcWhy = new Map(SRC.impostors.map((i) => [i.key, i.why]));');
    expect(chain).toContain('const extra = srcWhy.get(row.key);');
    expect(chain).toContain('${row.why}${extra ? ` — ${extra}` : ""}');
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
    expect(reconcile).toContain('eligible: Boolean(cfg.migratedChainLineShape)');
    expect(chain).not.toMatch(/["'](IV|PI)["']/);
  });
});
