// Unit tests for the R2 foreign-rate POST-boundary guard (fx-guard.ts).
// Audit: docs/inventory-costing-integrity-audit.md, R2. The predicate is pure so
// the bulk of the coverage is DB-free; a minimal fake PostgREST client drives the
// DB-aware assertForeignRatePostable over the currencies master read. Route-level
// coverage is not possible in this repo's harness (scm rides Supabase Postgres,
// which the vitest pool does not stand up) — staging validation remains.
import { describe, it, expect } from 'vitest';
import {
  isPositiveFiniteRate,
  isUnratedForeignPost,
  foreignRateBlockBody,
  readMasterRateRaw,
  assertForeignRatePostable,
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
  it('produces an actionable, currency + doc specific 422 payload', () => {
    expect(foreignRateBlockBody('rmb', 'GRN')).toEqual({
      error: 'foreign_rate_unset',
      currency: 'RMB',
      doc: 'GRN',
      message: 'Set the RMB exchange rate before posting this GRN.',
    });
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
      expect(r.body.message).toBe('Set the RMB exchange rate before posting this GRN.');
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
