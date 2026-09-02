// ----------------------------------------------------------------------------
// The total floor is gone; the drift gate is NOT.
//
// `so_total_below_original` (Loo 2026-06-11) refused any POS-session edit that
// lowered a line — five sites, one per verb. Removed 2026-08-18 on the owner's
// ruling: a salesperson may lower or cancel a line.
//
// Both halves matter, and they hang off the SAME expression, `isPosTabletCaller`:
//   · the five money FLOORS      — removed
//   · the pricing_drift REJECTS  — kept. Different rule: it refuses a client
//     price that disagrees with the server's own recompute, which is what stops
//     a tampered POS submitting a doctored total. Deleting the floors must not
//     take these with them, and a later "tidy up the posTablet branches" must
//     not either.
//
// Structural, in the soProceedRefusalWiring idiom: the risk is a whole class of
// refusal disappearing, which no unit test over one handler would notice.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import soRoutes from '../src/scm/routes/mfg-sales-orders.ts?raw';
import recomputeSrc from '../src/scm/lib/mfg-pricing-recompute.ts?raw';
const RECOMPUTE_SRC = recomputeSrc;

/** Source with comments stripped — the comments below deliberately name the
 *  very string this file asserts is absent from the code. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SO = code(soRoutes);

describe('SO total floor removed', () => {
  test('no handler still refuses an edit for lowering the bill', () => {
    expect(SO).not.toContain('so_total_below_original');
  });

  /* The drift rejects are the reason this file exists. If they go, a POS can
     submit any price it likes and the server takes it. */
  test('the pricing_drift rejects are still there, still gated on the POS session', () => {
    const drift = SO.match(/posTablet\s*&&\s*recompute[A-Za-z]*\.drift/g) ?? [];
    expect(drift.length).toBeGreaterThanOrEqual(3);
  });

  test('trustOperatorSelling is still withheld from a POS session', () => {
    /* 2026-08-19 — the route no longer spells `!posTablet` inline: both line
       writes ask `erpLineTrust`, which owns the negation (mfg-pricing-recompute).
       The invariant is unchanged and the assertion follows it to its new home —
       every call must still HAND it the POS flag, or the withholding is gone.
       2026-08-20 — SO CREATE joined them as the THIRD caller. It used to compute
       one boolean for the whole request and so never read a line's zero-price
       claim; see zeroPriceCreatePath.test.ts. */
    const calls = SO.match(/erpLineTrust\([A-Za-z]*[Pp]osTablet\b/g) ?? [];
    expect(calls.length, 'a line-pricing path stopped passing the POS flag').toBe(3);
    /* 2026-09-02 — the helper stopped spelling the negation as `!posTablet` when
       the migrated arm made it three guarded returns; the POS is now withheld by
       a leading early return, which is the same invariant said more strictly. */
    expect(RECOMPUTE_SRC).toMatch(/if \(posTablet\) return false;/);
  });

  /* isPosTabletCaller must survive as the one hinge. If a later edit deletes it
     as "unused", every drift check silently becomes unreachable. */
  test('the POS-session hinge is still read', () => {
    expect(SO).toMatch(/isPosTabletCaller\(c\)/);
  });
});
