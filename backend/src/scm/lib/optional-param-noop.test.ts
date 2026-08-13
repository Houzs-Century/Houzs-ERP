// ----------------------------------------------------------------------------
// optional-param-noop — the class pins.
//
// THE CLASS: an OPTIONAL parameter that changes a DECISION, so a call site that
// omits it silently keeps the old behaviour with no compile error and no
// failing test. The worked example is `itemCode` on missingVariantAxes /
// missingConfirmVariantAxes (scm/shared/so-variant-rule.ts): PR #1763 added the
// DIVAN ONLY exemption keyed on it and threaded "every desktop + mobile call
// site" — except two, which went on demanding a mattress Gap for a product that
// has none, for four days, with nothing failing.
//
// The remedy is the same everywhere: make the parameter REQUIRED so the
// compiler enumerates the call sites. Where an absent value must still be
// expressible, the caller passes an explicit `null` — which reads as a decision
// instead of an oversight.
//
// These tests are compile-time. Each one names a gate whose scope argument used
// to be optional and asserts, via a directive that goes UNUSED the moment the
// parameter is made optional again, that omitting it no longer compiles. They
// fail through `npm run typecheck` (TS2578), which is the gate this repo already
// runs before every deploy — not through vitest, which erases the types. The
// behavioural half lives with each gate's own suite.
// ----------------------------------------------------------------------------
import { describe, expect, it } from 'vitest';
import { findServiceLineCodes } from './service-line-guard';
import { resolveCandidateDoIds } from './do-line-remaining';

/** A chainable, awaitable PostgREST stand-in that RECORDS whether the caller
 *  narrowed by company — the thing an omitted argument silently skips. */
function fakeSb(rowsByTable: Record<string, Array<Record<string, unknown>>>, seen: { companyId?: unknown }) {
  class Q {
    rows: Array<Record<string, unknown>>;
    constructor(rows: Array<Record<string, unknown>>) { this.rows = [...rows]; }
    select() { return this; }
    in(col: string, vals: unknown[]) {
      this.rows = this.rows.filter((r) => vals.includes(r[col]));
      return this;
    }
    eq(col: string, val: unknown) {
      if (col === 'company_id') seen.companyId = val;
      this.rows = this.rows.filter((r) => r[col] === val);
      return this;
    }
    then<T>(onFulfilled: (v: { data: Array<Record<string, unknown>>; error: null }) => T) {
      return Promise.resolve({ data: this.rows, error: null }).then(onFulfilled);
    }
  }
  return { from: (t: string) => new Q(rowsByTable[t] ?? []) };
}

describe('findServiceLineCodes — the company is what decides, so it cannot be omitted', () => {
  /* `mfg_products.code` is unique per COMPANY, not globally (17 codes collided
     on production 2026-08-01). HOUZS files LIFT-CHARGE as a SERVICE; 2990 sells
     a physical item under the same code. */
  const catalog = {
    mfg_products: [
      { code: 'LIFT-CHARGE', category: 'SERVICE', company_id: 1 },
      { code: 'LIFT-CHARGE', category: 'BEDFRAME', company_id: 2 },
    ],
  };
  const line = [{ itemCode: 'LIFT-CHARGE', itemGroup: 'bedframe' }];

  it('company 1 sees a SERVICE line and refuses the return', async () => {
    const seen: { companyId?: unknown } = {};
    expect(await findServiceLineCodes(fakeSb(catalog, seen), line, 1)).toEqual({ ok: true, codes: ['LIFT-CHARGE'] });
    expect(seen.companyId).toBe(1);
  });

  it('company 2 sees returnable goods and allows it — the SAME payload, the other answer', async () => {
    const seen: { companyId?: unknown } = {};
    expect(await findServiceLineCodes(fakeSb(catalog, seen), line, 2)).toEqual({ ok: true, codes: [] });
    expect(seen.companyId).toBe(2);
  });

  it('so an omitted company is a COMPILE error, not a coin toss', () => {
    // Never invoked — the point is that it does not compile. Make companyId
    // optional again and the directive below goes unused (TS2578).
    // @ts-expect-error
    const omitted = () => findServiceLineCodes(fakeSb(catalog, {}), line);
    expect(omitted).toBeInstanceOf(Function);
  });
});

describe('resolveCandidateDoIds — a leak guard a caller can omit is only a default', () => {
  it('omitting the company is a COMPILE error', () => {
    // Without an explicit company this picker enumerates EVERY company's
    // delivery orders and cascades that id set into the header + line reads.
    // Never invoked; the assertion is that the call does not compile.
    // @ts-expect-error
    const omitted = () => resolveCandidateDoIds({} as never, undefined);
    expect(omitted).toBeInstanceOf(Function);
  });
});
