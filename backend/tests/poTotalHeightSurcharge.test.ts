// The total-height surcharge must survive the trip from a Sales-Order line to
// the Purchase Order raised from it.
//
// THE BUG (2990-PO-2608-003, reported 2026-08-17). `computeMfgPoUnitCost`
// accepts `totalHeight` and the engine prices it for BEDFRAME out of
// `maintenanceConfig.totalHeights`. All five FRONTEND callers passed it; all
// three BACKEND callers did not. So a PO keyed by hand on the PO screen carried
// the surcharge and a PO converted from an SO did not: CODY-(SS) at 18" was
// raised at RM407.50 against the SO line's own RM487.50 cost — exactly the one
// tier, RM80 — while the same order's CODY-(Q) at 22" matched, because that
// tier is priced 0 and the omission was therefore invisible on it.
//
// THREE GROUPS, because the defect had three surfaces: the engine (never
// broken, and so would never have caught this), the shared constructor that now
// owns the argument object, and the call sites — where the bug actually lived,
// a working engine reached through an argument nobody passed. Only the
// structural group fails when a FOURTH caller is added tomorrow and hand-rolls
// the object again.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { computeMfgPoUnitCost, type MaintenanceConfig } from '../src/scm/shared/mfg-pricing';
import { poVariantPricingInput } from '../src/scm/lib/po-pricing';

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
  it('adds the sub-20 inch tier to the supplier base', () => {
    // RM407.50 base + RM80.00 (18") = RM487.50 — the SO line's stored cost.
    expect(cost('18"')).toBe(48750);
  });

  it('adds nothing at 20 inches and above, which is why the bug hid on most lines', () => {
    expect(cost('22"')).toBe(40750);
  });

  it('is the same figure the omission produced — the regression, stated', () => {
    // What every backend caller used to compute: no height passed at all.
    expect(cost(null)).toBe(40750);
    expect(cost('18"') - cost(null)).toBe(8000);
  });
});

describe('poVariantPricingInput is the one place the spec fields are built', () => {
  it('carries totalHeight through from the line variants', () => {
    expect(poVariantPricingInput('BEDFRAME', { totalHeight: '18"' }).totalHeight).toBe('18"');
  });

  it('keeps the category gating each hand-copy had', () => {
    const bed = poVariantPricingInput('BEDFRAME', { legHeight: '2"', seatHeight: '28' });
    expect(bed.legHeight).toBe('2"');
    expect(bed.sofaLegHeight).toBeNull();
    expect(bed.seatSize).toBeNull();

    const sofa = poVariantPricingInput('SOFA', { legHeight: '2"', seatHeight: '28' });
    expect(sofa.sofaLegHeight).toBe('2"');
    expect(sofa.legHeight).toBeNull();
    expect(sofa.seatSize).toBe('28');
  });

  it('defaults every field rather than emitting undefined', () => {
    expect(poVariantPricingInput('BEDFRAME', {})).toEqual({
      seatSize: null, divanHeight: null, legHeight: null,
      totalHeight: null, sofaLegHeight: null, specials: [],
    });
  });
});

describe('every backend computeMfgPoUnitCost caller goes through the constructor', () => {
  /* Source-level, deliberately. The defect was never in the engine — it was
     three hand-copied argument objects, each independently deciding which
     surcharge pools existed, and all three forgetting the same one. Collapsing
     them into poVariantPricingInput fixes today; this assertion is what stops a
     FOURTH caller hand-rolling the object again and quietly dropping a pool.

     COMMENTS ARE STRIPPED FIRST, and that is not tidiness — it is the reason
     the assertion works at all. Written without it, an earlier version of this
     check passed against a probe that DELETED the argument, because the
     explanatory comment above it still contained the word. A guard that reads
     prose instead of code is green while measuring nothing. */
  const CALLERS = ['src/scm/lib/po-pricing.ts', 'src/scm/routes/mfg-purchase-orders.ts'] as const;
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  for (const rel of CALLERS) {
    it(`${rel} spreads poVariantPricingInput at every call`, () => {
      // Each argument object ends at its closing brace; slice from the call to
      // that, and require the constructor spread inside the slice.
      const parts = stripComments(repoFile(rel)).split('computeMfgPoUnitCost(').slice(1);
      expect(parts.length).toBeGreaterThan(0);
      for (const part of parts) {
        const argObject = part.slice(0, part.indexOf('},'));
        expect(argObject, `a computeMfgPoUnitCost call in ${rel} builds its spec args by hand`)
          .toMatch(/\.\.\.poVariantPricingInput\(/);
      }
    });
  }

  it('finds all three known call sites, so a rename cannot make this vacuous', () => {
    const total = CALLERS.reduce(
      (n, rel) => n + repoFile(rel).split('computeMfgPoUnitCost(').length - 1,
      0,
    );
    // 1 in po-pricing.ts + 2 in mfg-purchase-orders.ts. If this number moves, a
    // caller was added or removed — check it uses the constructor, then update.
    expect(total).toBe(3);
  });
});
