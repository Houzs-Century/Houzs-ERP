/* The CREATE path's half of the keyer's fair (owner 2026-10-19). The 12,000-line
 * router cannot be driven end to end here, so this pins the WIRING; the rules
 * are pinned in lib/fair-options.test.ts and lib/fair-binding.test.ts.
 *
 *   1. A confirmed create with neither a fair nor No fair is refused, worded by
 *      why the keyer got none — inside the confirm gate, so drafts (scan, Save as
 *      draft) skip it and a refusal burns no PWP claim. Never the POS.
 *   2. The fair link on a new order takes the keyer's booth where the brand
 *      cannot decide, keyed on the LOGGED-IN person, not the salesperson. */
import { describe, expect, it } from 'vitest';
import { soRouterSource } from '../../../tests/lib/so-router-source';

const raw = soRouterSource();
const coreStart = raw.indexOf('async function createSalesOrderCore(');
const core = coreStart < 0 ? '' : raw.slice(coreStart, raw.indexOf('\nmfgSalesOrders.post(\'/\'', coreStart));
const gateStart = core.indexOf('const confirmProblems = collectSoConfirmProblems({');
const gate = gateStart < 0 ? '' : core.slice(gateStart, core.indexOf('// Compute totals', gateStart));

describe('the create path refuses a typed order with no fair', () => {
  it('finds the core and its confirm gate (a pin over nothing must not pass)', () => {
    expect(coreStart).toBeGreaterThan(-1);
    expect(gateStart).toBeGreaterThan(-1);
  });

  it('asks fairRequiredProblem inside the confirm gate, and never for the POS', () => {
    expect(gate).toContain('await fairRequiredProblem({');
    expect(gate).toContain('(await isPosTabletCaller(c)) ? null');
    expect(gate).toContain('confirmProblems.push(fairProblem)');
  });

  it('the keyer is the logged-in person, on the order date the fair is resolved against', () => {
    expect(gate).toContain("keyerId: Number(c.get('houzsUser')?.id ?? NaN)");
    expect(gate).toContain('orderDate: soDateForVenue');
  });

  it("the new order's fair link takes the keyer's booth where the brand cannot decide", () => {
    const link = core.slice(core.indexOf('── FAIR LINK (owner 2026-09-13)'));
    expect(link).toContain('await resolveFairForCreate({');
    expect(link).toContain("keyerId: Number(c.get('houzsUser')?.id ?? NaN)");
  });
});
