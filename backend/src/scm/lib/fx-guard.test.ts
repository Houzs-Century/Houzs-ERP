// Unit tests for the R2 foreign-rate write-boundary guards (fx-guard.ts) — both the
// POST boundary (create) and, since 2026-07-30, the PATCH boundary (a currency FLIP
// on an existing document, which the POST guard never saw).
// Audit: docs/inventory-costing-integrity-audit.md, R2. The predicates are pure so
// the bulk of the coverage is DB-free; a minimal fake PostgREST client drives the
// DB-aware assert* helpers over the currencies master read. Route-level coverage is
// not possible in this repo's harness (scm rides Supabase Postgres, which the vitest
// pool does not stand up) — staging validation remains.
import { describe, it, expect } from 'vitest';
import {
  isPositiveFiniteRate,
  isUnratedForeignPost,
  isUnratedForeignCurrencyFlip,
  foreignRateBlockBody,
  readMasterRateRaw,
  assertForeignRatePostable,
  assertForeignRatePatchable,
} from './fx-guard';

type Row = Record<string, unknown>;

/** Minimal chainable, awaitable PostgREST stand-in for the single
 *  currencies.select().eq().maybeSingle() read the guard performs. */
function fakeSb(currencies: Row[]) {
  class Q {
    rows: Row[];
    constructor(rows: Row[]) { this.rows = [...rows]; }
    select() { return this; }
    eq(col: string, val: unknown) { this.rows = this.rows.filter((r) => r[col] === val); return this; }
    async maybeSingle() { return { data: this.rows[0] ?? null, error: null }; }
  }
  return { from: (_table: string) => new Q(currencies) };
}

/** An sb whose read always throws — exercises the readMasterRateRaw catch. */
function throwingSb() {
  return {
    from: () => ({
      select() { return this; },
      eq() { return this; },
      maybeSingle() { throw new Error('boom'); },
    }),
  };
}

describe('isPositiveFiniteRate', () => {
  it('accepts finite positive numbers and numeric strings', () => {
    expect(isPositiveFiniteRate(0.62)).toBe(true);
    expect(isPositiveFiniteRate(1)).toBe(true);
    expect(isPositiveFiniteRate('4.5')).toBe(true);
  });
  it('rejects missing / zero / negative / non-finite', () => {
    expect(isPositiveFiniteRate(undefined)).toBe(false);
    expect(isPositiveFiniteRate(null)).toBe(false);
    expect(isPositiveFiniteRate('')).toBe(false);
    expect(isPositiveFiniteRate(0)).toBe(false);
    expect(isPositiveFiniteRate(-1)).toBe(false);
    expect(isPositiveFiniteRate(Number.NaN)).toBe(false);
    expect(isPositiveFiniteRate(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isPositiveFiniteRate('abc')).toBe(false);
  });
});

describe('isUnratedForeignPost — the R2 predicate', () => {
  it('BLOCKS a non-MYR doc whose master rate is unset (null) and no operator rate', () => {
    expect(isUnratedForeignPost({ currency: 'RMB', operatorRate: undefined, masterRate: null })).toBe(true);
  });

  it('ALLOWS a non-MYR doc with an operator-entered positive rate, even when the master is unset', () => {
    expect(isUnratedForeignPost({ currency: 'RMB', operatorRate: 0.62, masterRate: null })).toBe(false);
    expect(isUnratedForeignPost({ currency: 'RMB', operatorRate: '0.62', masterRate: null })).toBe(false);
  });

  it('ALLOWS a non-MYR doc when the currency master carries a positive rate', () => {
    expect(isUnratedForeignPost({ currency: 'RMB', operatorRate: undefined, masterRate: 0.62 })).toBe(false);
  });

  it('ALLOWS MYR unconditionally (rate 1 is a definitional no-op)', () => {
    expect(isUnratedForeignPost({ currency: 'MYR', operatorRate: undefined, masterRate: null })).toBe(false);
    expect(isUnratedForeignPost({ currency: '', operatorRate: undefined, masterRate: null })).toBe(false);
    expect(isUnratedForeignPost({ currency: 'myr', operatorRate: undefined, masterRate: 0 })).toBe(false);
  });

  it('BLOCKS on every non-positive master edge when no operator rate is present', () => {
    for (const masterRate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, '']) {
      expect(isUnratedForeignPost({ currency: 'USD', operatorRate: undefined, masterRate })).toBe(true);
    }
  });

  it('BLOCKS when the operator rate itself is non-positive (0 / negative / NaN) and the master is unset', () => {
    for (const operatorRate of [0, -3, Number.NaN]) {
      expect(isUnratedForeignPost({ currency: 'USD', operatorRate, masterRate: null })).toBe(true);
    }
  });

  it('keys on the MASTER being unset, not on the effective rate being 1 — a deliberate operator 1 is honoured', () => {
    // operator deliberately typed 1 (e.g. a currency they treat as par) → allowed
    expect(isUnratedForeignPost({ currency: 'SGD', operatorRate: 1, masterRate: null })).toBe(false);
    // no operator rate + master unset (defaults to 1) → blocked
    expect(isUnratedForeignPost({ currency: 'SGD', operatorRate: undefined, masterRate: null })).toBe(true);
  });
});

describe('foreignRateBlockBody', () => {
  it('produces a currency + doc specific 422 payload', () => {
    const b = foreignRateBlockBody('rmb', 'GRN');
    expect(b.error).toBe('foreign_rate_unset');
    expect(b.currency).toBe('RMB');
    expect(b.doc).toBe('GRN');
  });

  /* The message names all THREE ways out, and the payment one on purpose: Houzs
     pays its China suppliers before the goods and the invoice arrive, so the true
     rate is usually already knowable from a bank transfer, and recording that
     voucher is better than typing a rate — its rate is adopted by the invoice it
     settles and re-costs the GRN (lib/pv-rate-adoption.ts). */
  it('names the currency master, the document field, AND recording the payment', () => {
    const m = foreignRateBlockBody('rmb', 'GRN').message;
    expect(m).toContain('currency master');
    expect(m).toContain('enter the rate on this GRN');
    expect(m).toContain('record the supplier payment first');
    expect(m).toContain('RMB');
  });

  it('says what goes WRONG, not just what to do — the reason a 1:1 post is refused', () => {
    expect(foreignRateBlockBody('RMB', 'purchase invoice').message)
      .toContain('as if RMB were ringgit');
  });
});

describe('readMasterRateRaw', () => {
  it('returns 1 for MYR without touching the DB', async () => {
    await expect(readMasterRateRaw(fakeSb([]), 'MYR')).resolves.toBe(1);
  });
  it('returns the RAW rate_to_myr (not safeRate-coerced) for a foreign currency', async () => {
    await expect(readMasterRateRaw(fakeSb([{ code: 'RMB', rate_to_myr: 0.62 }]), 'RMB')).resolves.toBe(0.62);
  });
  it('returns null when the currency row is missing', async () => {
    await expect(readMasterRateRaw(fakeSb([]), 'RMB')).resolves.toBeNull();
  });
  it('returns the RAW stored 1 for an unrated new currency (so the predicate can catch it)', async () => {
    await expect(readMasterRateRaw(fakeSb([{ code: 'RMB', rate_to_myr: null }]), 'RMB')).resolves.toBeNull();
  });
  it('returns null (safe) when the DB read throws', async () => {
    await expect(readMasterRateRaw(throwingSb(), 'RMB')).resolves.toBeNull();
  });
});

describe('assertForeignRatePostable — DB-aware POST-boundary check', () => {
  it('blocks a foreign GRN whose master rate is unset and no operator rate given', async () => {
    const sb = fakeSb([{ code: 'RMB', rate_to_myr: null }]);
    const r = await assertForeignRatePostable(sb, { currency: 'RMB', operatorRate: undefined, docLabel: 'GRN' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.body.error).toBe('foreign_rate_unset');
      expect(r.body.message).toContain('RMB');
    }
  });

  it('blocks a foreign GRN when the currency row is entirely missing', async () => {
    const sb = fakeSb([]);
    const r = await assertForeignRatePostable(sb, { currency: 'USD', operatorRate: undefined, docLabel: 'GRN' });
    expect(r.ok).toBe(false);
  });

  it('allows a foreign PI with an operator-entered positive rate WITHOUT reading the master', async () => {
    const sb = fakeSb([{ code: 'RMB', rate_to_myr: null }]);
    const r = await assertForeignRatePostable(sb, { currency: 'RMB', operatorRate: 0.62, docLabel: 'purchase invoice' });
    expect(r.ok).toBe(true);
  });

  it('allows a foreign doc when the master carries a positive rate', async () => {
    const sb = fakeSb([{ code: 'RMB', rate_to_myr: 0.62 }]);
    const r = await assertForeignRatePostable(sb, { currency: 'RMB', operatorRate: undefined, docLabel: 'GRN' });
    expect(r.ok).toBe(true);
  });

  it('allows an MYR doc unconditionally (never blocked, never queried)', async () => {
    const sb = fakeSb([]);
    const r = await assertForeignRatePostable(sb, { currency: 'MYR', operatorRate: undefined, docLabel: 'GRN' });
    expect(r.ok).toBe(true);
  });
});

/* ── The EDIT-path hole (2026-07-30) ───────────────────────────────────────────
   The POST guard above closed the create boundary; PATCH /grns/:id and
   PATCH /purchase-invoices/:id both accept `currency` and neither consulted the
   master. Flip an MYR document to RMB with no rate and exchange_rate stays at the 1
   it held for being ringgit — the R2 mis-cost reached by editing. */

describe('isUnratedForeignCurrencyFlip — the EDIT predicate', () => {
  const base = { fromCurrency: 'MYR', toCurrency: 'RMB', operatorRate: undefined, masterRate: null };

  it('blocks a flip from MYR to an unrated foreign currency', () => {
    expect(isUnratedForeignCurrencyFlip(base)).toBe(true);
  });

  it('does NOT fire when the patch does not touch the currency at all', () => {
    // The single most important case: editing notes / warehouse / supplier on an
    // existing foreign document must never be refused.
    expect(isUnratedForeignCurrencyFlip({ ...base, fromCurrency: 'RMB', toCurrency: undefined })).toBe(false);
    expect(isUnratedForeignCurrencyFlip({ ...base, toCurrency: null })).toBe(false);
  });

  it('does NOT fire on a flip TO MYR (the routes pin the rate to 1)', () => {
    expect(isUnratedForeignCurrencyFlip({ ...base, fromCurrency: 'RMB', toCurrency: 'MYR' })).toBe(false);
  });

  it('does NOT fire when the currency is unchanged, however it is spelled', () => {
    expect(isUnratedForeignCurrencyFlip({ ...base, fromCurrency: 'RMB', toCurrency: 'rmb' })).toBe(false);
    expect(isUnratedForeignCurrencyFlip({ ...base, fromCurrency: null, toCurrency: 'MYR' })).toBe(false);
  });

  it('allows the flip when the operator supplies a positive rate', () => {
    expect(isUnratedForeignCurrencyFlip({ ...base, operatorRate: 0.62 })).toBe(false);
    expect(isUnratedForeignCurrencyFlip({ ...base, operatorRate: '0.62' })).toBe(false);
  });

  it('allows the flip when the currency master carries a positive rate', () => {
    expect(isUnratedForeignCurrencyFlip({ ...base, masterRate: 0.62 })).toBe(false);
  });

  it.each([undefined, null, '', 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'a master rate of %p is no rate at all and the flip is blocked',
    (masterRate) => {
      expect(isUnratedForeignCurrencyFlip({ ...base, masterRate })).toBe(true);
    },
  );

  it('blocks a flip between two DIFFERENT foreign currencies — the stored rate now describes the wrong one', () => {
    expect(isUnratedForeignCurrencyFlip({ ...base, fromCurrency: 'USD', toCurrency: 'RMB' })).toBe(true);
  });
});

describe('assertForeignRatePatchable — DB-aware PATCH-boundary check', () => {
  it('blocks an MYR -> RMB flip with no rate anywhere, with the same 422 body', async () => {
    const sb = fakeSb([{ code: 'RMB', rate_to_myr: null }]);
    const r = await assertForeignRatePatchable(sb, { fromCurrency: 'MYR', toCurrency: 'RMB', operatorRate: undefined, docLabel: 'GRN' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.body.error).toBe('foreign_rate_unset');
      expect(r.body.currency).toBe('RMB');
    }
  });

  it('allows a patch that carries no currency (never even reads the master)', async () => {
    const r = await assertForeignRatePatchable(throwingSb(), { fromCurrency: 'RMB', toCurrency: undefined, operatorRate: undefined, docLabel: 'GRN' });
    expect(r.ok).toBe(true);
  });

  it('allows an all-MYR patch', async () => {
    const r = await assertForeignRatePatchable(throwingSb(), { fromCurrency: 'MYR', toCurrency: 'MYR', operatorRate: undefined, docLabel: 'purchase invoice' });
    expect(r.ok).toBe(true);
  });

  it('allows re-sending the SAME foreign currency without a rate', async () => {
    const r = await assertForeignRatePatchable(throwingSb(), { fromCurrency: 'RMB', toCurrency: 'RMB', operatorRate: undefined, docLabel: 'GRN' });
    expect(r.ok).toBe(true);
  });

  it('allows the flip once the master has a rate', async () => {
    const sb = fakeSb([{ code: 'RMB', rate_to_myr: 0.62 }]);
    const r = await assertForeignRatePatchable(sb, { fromCurrency: 'MYR', toCurrency: 'RMB', operatorRate: undefined, docLabel: 'GRN' });
    expect(r.ok).toBe(true);
  });
});
