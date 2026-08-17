// The total-height surcharge must survive the trip from a Sales-Order line to
// the Purchase Order raised from it.
//
// THE BUG (2990-PO-2608-003, reported 2026-08-17). `computeMfgPoUnitCost`
// accepts `totalHeight` and `computeMfgLineCost` prices it for BEDFRAME out of
// `maintenanceConfig.totalHeights`. All five FRONTEND callers passed it; all
// three BACKEND callers did not. So a PO keyed by hand on the PO screen carried
// the surcharge and a PO converted from an SO did not: CODY-(SS) at 18" was
// raised at RM407.50 against the SO line's own RM487.50 cost — exactly the one
// tier, RM80 — while the same order's CODY-(Q) at 22" matched, because that
// tier is priced 0 and the omission was therefore invisible on it.
//
// TWO TESTS, because the defect had two halves. The first pins the ENGINE:
// given the height, the surcharge lands. That half was never broken and would
// not have caught this. The second pins the CALL SITES, which is where the bug
// actually lived — a passing engine reached through an argument nobody passed.
// A structural assertion is the only kind that fails when a FOURTH caller is
// added tomorrow and forgets it again.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { computeMfgPoUnitCost, type MaintenanceConfig } from '../src/scm/shared/mfg-pricing';

const here = dirname(fileURLToPath(import.meta.url));
const repoFile = (rel: string) => readFileSync(resolve(here, '..', rel), 'utf8');

/* The live 2990 table as of 2026-08-17: sub-20" heights carry a surcharge that
   tapers to 0 at 20". Only the two tiers this test needs are listed. */
const MAINT: MaintenanceConfig = {
  divanHeights: [],
  legHeights: [],
  totalHeights: [
    { value: '18"', priceSen: 8000 },
    { value: '22"', priceSen: 0 },
  ],
  gaps: [],
  specials: [],
  sofaLegHeights: [],
  sofaSpecials: [],
  sofaSizes: [],
};

const cost = (totalHeight: string | null) => computeMfgPoUnitCost(
  {
    category: 'BEDFRAME',
    priceMatrix: null,
    unitPriceCenti: 40750, // the supplier binding's flat base for CODY-(SS)
    totalHeight,
  },
  MAINT,
).unitPriceSen;

describe('total-height surcharge on a server-derived PO cost', () => {
  it('adds the sub-20" tier to the supplier base', () => {
    // RM407.50 base + RM80.00 (18") = RM487.50 — the SO line's stored cost.
    expect(cost('18"')).toBe(48750);
  });

  it('adds nothing at 20" and above, which is why the bug hid on most lines', () => {
    expect(cost('22"')).toBe(40750);
  });

  it('is the same figure the omission produced — the regression, stated', () => {
    // What every backend caller used to compute: no height passed at all.
    expect(cost(null)).toBe(40750);
    expect(cost('18"') - cost(null)).toBe(8000);
  });
});

describe('every backend computeMfgPoUnitCost caller passes totalHeight', () => {
  /* Source-level, deliberately. The three call sites live in two files and each
     builds its argument object by hand; there is no shared constructor to test
     instead. Scanning the source is what makes a fourth, future caller that
     drops the field fail HERE rather than in a customer's PO. */
  const CALLERS = ['src/scm/lib/po-pricing.ts', 'src/scm/routes/mfg-purchase-orders.ts'] as const;

  /* COMMENTS ARE STRIPPED FIRST, and that is not tidiness — it is the whole
     reason this assertion works. Written without it, the check passed against a
     probe that DELETED the `totalHeight:` argument, because the explanatory
     comment sitting right above it still contains the word. A guard that reads
     prose instead of code is the "check that stops running" shape: green, and
     measuring nothing. It is asserted on the KEY (`totalHeight:`), in
     comment-free source, and proven to fail when the argument is removed. */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  for (const rel of CALLERS) {
    it(`${rel} passes totalHeight at every call`, () => {
      // Each argument object ends at the `specials` field every caller closes
      // with; slice from call to that, and require the key inside each slice.
      const parts = stripComments(repoFile(rel)).split('computeMfgPoUnitCost(').slice(1);
      expect(parts.length).toBeGreaterThan(0);
      for (const part of parts) {
        const argObject = part.slice(0, part.indexOf('specials'));
        expect(argObject, `a computeMfgPoUnitCost call in ${rel} omits totalHeight`).toMatch(/\btotalHeight\s*:/);
      }
    });
  }

  it('finds all three known call sites, so a rename cannot make this vacuous', () => {
    const total = CALLERS.reduce(
      (n, rel) => n + repoFile(rel).split('computeMfgPoUnitCost(').length - 1,
      0,
    );
    // 1 in po-pricing.ts + 2 in mfg-purchase-orders.ts. If this number moves, a
    // caller was added or removed — check it passes totalHeight, then update.
    expect(total).toBe(3);
  });
});
