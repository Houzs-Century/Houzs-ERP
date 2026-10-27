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

  it("the new order's fair link is fairLinkOnCreate: scans by slip, the keyer is the logged-in person", () => {
    const link = core.slice(core.indexOf('── FAIR LINK (owner 2026-09-13)'));
    expect(link).toContain('await fairLinkOnCreate({');
    expect(link).toContain("scanned: c.auditSource === 'scan'");
    expect(link).toContain("keyerId: Number(c.get('houzsUser')?.id ?? NaN)");
    expect(link).toContain('bindingProjectId: projectIdToStamp');
  });
});

describe('the DRAFT -> CONFIRMED gate asks about the fair (owner 2026-10-19)', () => {
  const start = raw.indexOf('export const patchMfgSalesOrderStatusHandler');
  const handler = start < 0 ? '' : raw.slice(start, raw.indexOf('const commitStatusChange', start));

  it('adds fairConfirmProblems to the confirm problems, scoped to the active company', () => {
    expect(start).toBeGreaterThan(-1);
    expect(handler).toContain('confirmProblems.push(...await fairConfirmProblems({');
    expect(handler).toContain('scope: (q) => scopeToCompanyId(q, co.companyId)');
    expect(handler).toContain("confirmerId: Number(c.get('houzsUser')?.id ?? NaN)");
  });
});

describe('a header edit can say No fair (owner 2026-10-19)', () => {
  it('writes NO_FAIR, and the venue re-detect leaves it alone', () => {
    expect(raw).toContain("if (body.noFair === true && !fairLink && (beforeRecord.fair_match !== 'NO_FAIR' || beforeRecord.project_id != null)) {");
    expect(raw).toContain("Object.assign(updates, { project_id: null, fair_match: 'NO_FAIR', fair_date: null });");
    expect(raw).toContain('if (!fairLink && body.noFair !== true) {');
  });
});

describe('a header edit re-picking a fair (HC-0161)', () => {
  it("resolves for the order's keyer and tells a DRAFT at Save when it cannot link", () => {
    expect(raw).toContain("keyerId: () => editFairKeyerId({ sb, scope: (q) => scopeToCompany(q, c), docNo, editorId: Number(c.get('houzsUser')?.id ?? NaN) }),");
    expect(raw).toContain("if (fairLink?.problem && beforeRecord.status === 'DRAFT' && companyUsesKeyerFair(c.get('companyCode'))) {");
    expect(raw).toContain('return c.json(validationFailedBody([fairLink.problem]), 422);');
  });
});
