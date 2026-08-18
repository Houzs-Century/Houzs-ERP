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
    expect(SO).toMatch(/!posTablet/);
  });

  /* isPosTabletCaller must survive as the one hinge. If a later edit deletes it
     as "unused", every drift check silently becomes unreachable. */
  test('the POS-session hinge is still read', () => {
    expect(SO).toMatch(/isPosTabletCaller\(c\)/);
  });
});
