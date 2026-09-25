import { describe, it, expect } from 'vitest';
import { readDoListParams, filterDoList, type DoListParams } from './do-list-read';

// Recording PostgREST-builder fake: records (method, col, vals), returns itself.
function recorder() {
  const calls: Array<{ m: string; col: string; vals: unknown }> = [];
  const self: Record<string, unknown> = {};
  for (const m of ['in', 'eq', 'or', 'gte', 'lte', 'order'] as const) {
    self[m] = (col: string, vals?: unknown) => {
      calls.push({ m, col, vals });
      return self;
    };
  }
  return { self, calls };
}

const ctx = { get: (k: string) => (k === 'companyId' ? 1 : undefined) } as { get(key: string): unknown };
const base: DoListParams = { status: null, q: null, sort: null, from: null, to: null, debtorNames: null, currencies: null, soRefDocNos: [] };

describe('readDoListParams — server-filterable funnel params', () => {
  it('parses debtorNames / currencies as JSON arrays, commas in names survive', () => {
    const q: Record<string, string> = { debtorNames: JSON.stringify(['ALICE, INC', 'BOB']), currencies: JSON.stringify(['MYR']) };
    const p = readDoListParams((k) => q[k]);
    expect(p.debtorNames).toEqual(['ALICE, INC', 'BOB']);
    expect(p.currencies).toEqual(['MYR']);
    expect(readDoListParams((k) => (k === 'debtorNames' ? 'not json' : undefined)).debtorNames).toBeNull();
  });
});

describe('filterDoList — pushes the server-filterable funnels into the query', () => {
  it('filters by Customer Name (multi-value) and Currency, staying company-scoped', () => {
    const { self, calls } = recorder();
    filterDoList(self, { ...base, debtorNames: ['ALICE, INC', 'BOB'], currencies: ['USD'] }, ctx, null);
    expect(calls.find((c) => c.m === 'in' && c.col === 'debtor_name')?.vals).toEqual(['ALICE, INC', 'BOB']);
    expect(calls.find((c) => c.m === 'in' && c.col === 'currency')?.vals).toEqual(['USD']);
    expect(calls.find((c) => c.m === 'eq' && c.col === 'company_id')?.vals).toBe(1);
  });

  it('applies no customer/currency filter when none are set', () => {
    const { self, calls } = recorder();
    filterDoList(self, base, ctx, null);
    expect(calls.some((c) => c.col === 'debtor_name' || c.col === 'currency')).toBe(false);
  });
});
