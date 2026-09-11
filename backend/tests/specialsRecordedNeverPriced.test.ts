/**
 * `variants.specialsRecorded` must stay INVISIBLE to every pricing path.
 *
 * WHY THIS TEST IS THE FIX, NOT A COMMENT. Owner's choice 甲, 2026-09-03:
 * an AutoCount-imported line's slip asks for a PRICED special order, and the ERP
 * line does not carry the code, so the factory cannot see what to build. The
 * imported figure ALREADY contains that option, so recording it must not add the
 * surcharge a second time.
 *
 * The obvious implementation — stamp the code into `variants.specials` and teach
 * the pricing engine to skip it — was rejected because it fails OPEN on money.
 * Eight places price a line off `variants.specials` (the SO server recompute,
 * the SO line-editor preview, `poVariantPricingInput`'s two backend PO callers,
 * and five frontend inline builders), and missing one of them silently reprices
 * a closed document. Measured on prod 2026-09-02 (run 33659562235): the PO half
 * of that is live, not theoretical — the supplier maintenance pool carries
 * `priceSen` for these very codes at master scope and at both supplier scopes.
 *
 * So the codes live in their OWN key, which nothing that computes money reads.
 * That property is only true while it is true, and a future author wiring the
 * key into a price is exactly the mistake this file exists to stop. The
 * allow-list below is DISPLAY surfaces plus the backfill that writes it.
 *
 * If you are here because this test failed: you have not broken a style rule.
 * You have made a historical document's money movable. Render the key, do not
 * price it.
 */
import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..', '..');
const KEY = 'specialsRecorded';

/** Every file allowed to mention the key, repo-relative with forward slashes. */
const ALLOWED = new Set([
  // DISPLAY — Description 2, which carries the option to the factory on every print.
  'backend/src/scm/shared/variant-summary.ts',
  'frontend/src/vendor/shared/variant-summary.ts',
  'frontend/src/vendor/shared/variant-summary.test.ts',
  // DISPLAY — the Special Orders picker, as a ticked and locked row.
  'frontend/src/vendor/scm/components/SpecialOrders.tsx',
  'frontend/src/vendor/scm/components/SpecialOrders.test.tsx',
  // THE WRITER, and this test.
  'backend/scripts/record-priced-specials-on-migrated-lines.mjs',
  'backend/tests/specialsRecordedNeverPriced.test.ts',
  /* DISPLAY — a read-only diagnostic, added 2026-09-09 with its reason because
     this list is the mechanism and not an obstacle.

     WHY IT READS THE KEY. It answers "where did this order's money come from,
     line by line?" for one named document (HC-SO-012312: three bedframes split
     and RM 250 appeared on a line whose two neighbours are FOC). Whether a
     line's option sits in `specials` or in `specialsRecorded` is exactly the
     distinction that question turns on — the recorded half is the half that must
     NOT have added a surcharge, so a probe that could not tell them apart could
     not tell the owner which case he is looking at.

     WHY IT IS SAFE UNDER THIS RULE. It renders and never prices: the key reaches
     one string in a printed SPECIALS column and no arithmetic anywhere. The
     probe's only sum is lines vs header total, computed from `total_sen` alone.
     It is also SELECT-only — it cannot write a price even by accident. */
  'backend/scripts/check-so-line-pricing.mjs',
  /* A SECOND WRITER, and it only ever CLEARS — added 2026-09-09 with the reason,
     because this list is the mechanism for that and not an obstacle to it.

     WHY IT HAS TO TOUCH THE KEY AT ALL. AutoCount refuses a whole document whose
     Description 2 is over nvarchar(100), and that string is the SUM of
     `variants.specials` and `variants.specialsRecorded`. On HC-SO-007678 the
     106-character sentence lives in the RECORDED half, so no value of `specials`
     brings the line under 100 — the field has to be emptied or the document
     never reaches the accounts.

     WHY IT IS SAFE UNDER THE RULE THIS TEST ENFORCES. The rule is that the key
     must never feed a PRICE or a COST, so a historical document's money cannot
     move on its next edit. This script writes `specialsRecorded: []` and touches
     no money column at all; it is plan-by-default, refuses to act on any line
     whose current text is not character-for-character what the owner was shown,
     and re-reads on a fresh connection to assert the RENDERING afterwards.

     THE OWNER WROTE THE REPLACEMENT WORDINGS HIMSELF on 2026-09-09 — the text he
     approved does not contain that sentence — and the plan prints both fields
     before anything is written, so the removal is seen and confirmed rather than
     inferred. */
  'backend/scripts/shorten-specials-to-the-book.mjs',
  /* REPORTING — read-only, and that is the whole reason they are admissible.
     These four open a connection, SELECT, and print; not one of them writes a
     line, and none can reach a price. They were added 2026-09-07 because the
     RECONCILE not knowing about this key was itself a defect (docs/bugs/0668):
     every line closed by the owner's own 2026-09-03 ruling kept reporting as an
     outstanding DIFFER, so work he had already decided was being quoted back to
     him as backlog on go-live day.

     The rule this list encodes is "render the key, do not price it", and a
     report is a render. What is NOT admissible has not changed by one inch: the
     third test below still asserts the four pricing modules never mention it,
     and `variant-reconcile.mjs` keeps `specialsRecorded` OUT of its `carried`
     array on purpose, so a recorded option is never counted as a ticked one. */
  'backend/scripts/lib/variant-reconcile.mjs',
  'backend/scripts/lib/variant-reconcile.test.mjs',
  'backend/scripts/check-ac-erp-reconcile.mjs',
  /* The variant table and its legend, LIFTED OUT of check-ac-erp-reconcile.mjs
     on 2026-09-08 because that file hit its 2,000-line ceiling. It prints the
     `recorded` column's sentence and nothing else: the same render, in a new
     file. It computes no price and reads no money. */
  'backend/scripts/lib/variant-report.mjs',
  'backend/scripts/plan-priced-specials-money.mjs',
  /* The migrated-invoice receipt snapshot names the key only to WITHHOLD it.
     `repair-migrated-invoice-variants-from-receipt.mjs` copies a goods-receipt
     line's variants onto the invoice line raised from it, and its `WITHHELD`
     map lists every key it refuses to carry across with the reason — this one
     among them. Mentioning a key in order not to write it is the opposite of
     pricing it, and the refusal is the safer of the two ways to fail: a parent
     key that is in neither the owned list nor this one makes the row REFUSE. */
  'backend/scripts/repair-migrated-invoice-variants-from-receipt.mjs',
]);

const SCAN = ['backend/src', 'backend/scripts', 'frontend/src'];
const SKIP_DIR = new Set(['node_modules', 'dist', '__snapshots__', 'data']);
const EXT = /\.(ts|tsx|mjs|js|jsx)$/;

const walk = (rel: string, out: string[]): string[] => {
  const abs = resolve(REPO, rel);
  for (const name of readdirSync(abs)) {
    if (SKIP_DIR.has(name)) continue;
    const childRel = `${rel}/${name}`;
    if (statSync(resolve(REPO, childRel)).isDirectory()) walk(childRel, out);
    else if (EXT.test(name)) out.push(childRel);
  }
  return out;
};

describe('variants.specialsRecorded is recorded, never priced', () => {
  const files = SCAN.flatMap((d) => walk(d, []));

  /* A scan that matches nothing must never read as a pass — the repo has been
     burned by exactly that (CLAUDE.md, "a checker that cannot match reports a
     clean run"). Prove the corpus is real and that the needle is findable in it
     before believing any verdict below. */
  test('the scan actually sees the tree, and the needle is findable in it', () => {
    expect(files.length).toBeGreaterThan(500);
    const hits = files.filter((f) => readFileSync(resolve(REPO, f), 'utf8').includes(KEY));
    expect(hits.length).toBeGreaterThan(0);
  });

  test('only display surfaces and the backfill mention it', () => {
    const hits = files.filter((f) => readFileSync(resolve(REPO, f), 'utf8').includes(KEY));
    const unexpected = hits.filter((f) => !ALLOWED.has(f));
    expect(unexpected, `${KEY} reached a file that is not a display surface. If it now feeds a
price or a cost, a historical AutoCount document's money can move on its next
edit — which is the one thing the owner said must not happen.`).toEqual([]);
  });

  test('the pricing modules do not mention it at all', () => {
    const pricing = [
      'backend/src/scm/shared/mfg-pricing.ts',
      'frontend/src/vendor/shared/mfg-pricing.ts',
      'backend/src/scm/lib/mfg-pricing-recompute.ts',
      'backend/src/scm/lib/po-pricing.ts',
    ];
    for (const f of pricing) {
      expect(readFileSync(resolve(REPO, f), 'utf8').includes(KEY), `${f} mentions ${KEY}`).toBe(false);
    }
  });
});
