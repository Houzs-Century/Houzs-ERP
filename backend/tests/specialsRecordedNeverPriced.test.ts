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
