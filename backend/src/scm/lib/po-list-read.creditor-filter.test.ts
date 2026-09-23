import { describe, it, expect } from 'vitest';
import { readPoListFilters, poListSelect, filterPoList, type PoListFilters } from './po-list-read';

// A recording PostgREST-builder fake: every filter method records (col, vals)
// and returns itself, so a test can read back exactly which server-side filters
// filterPoList applied.
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

// companyId resolved to 1 → scopeToCompany adds eq(company_id, 1).
const ctx = { get: (k: string) => (k === 'companyId' ? 1 : undefined) } as { get(key: string): unknown };
const VALID = new Set(['SUBMITTED', 'PARTIALLY_RECEIVED', 'DRAFT', 'RECEIVED', 'CANCELLED']);

const base: PoListFilters = {
  status: null, supplierId: null, q: null, from: null, to: null, sort: null,
  creditorNames: null, creditorCodes: null, currencies: null, docDates: null,
};

describe('readPoListFilters — server-filterable funnel params', () => {
  it('parses creditor names/codes/currencies from JSON-array params, tolerating commas in names', () => {
    const q: Record<string, string> = {
      creditorNames: JSON.stringify(['DIGLANT SDN BHD', 'FOO, INC']),
      creditorCodes: JSON.stringify(['400-D001']),
      currencies: JSON.stringify(['MYR', 'USD']),
    };
    const f = readPoListFilters((k) => q[k]);
    expect(f.creditorNames).toEqual(['DIGLANT SDN BHD', 'FOO, INC']);
    expect(f.creditorCodes).toEqual(['400-D001']);
    expect(f.currencies).toEqual(['MYR', 'USD']);
  });

  it('reads a malformed or empty value as no filter (null), never a crash', () => {
    expect(readPoListFilters(() => 'not json').creditorNames).toBeNull();
    expect(readPoListFilters(() => '[]').creditorNames).toBeNull();
    expect(readPoListFilters(() => undefined).creditorNames).toBeNull();
  });
});

describe('poListSelect — inner supplier embed only when a creditor filter is active', () => {
  it('is a plain embed with no creditor filter', () => {
    expect(poListSelect(base)).toContain('supplier:suppliers(');
    expect(poListSelect(base)).not.toContain('suppliers!inner');
  });
  it('becomes !inner when creditor names or codes are present, so the parent PO is removed', () => {
    expect(poListSelect({ ...base, creditorNames: ['DIGLANT'] })).toContain('supplier:suppliers!inner(');
    expect(poListSelect({ ...base, creditorCodes: ['400-D001'] })).toContain('supplier:suppliers!inner(');
  });
});

describe('filterPoList — pushes the server-filterable funnels into the query', () => {
  it('filters by creditor name on the embedded supplier column (multi-value)', () => {
    const { self, calls } = recorder();
    filterPoList(self, { ...base, creditorNames: ['DIGLANT SDN BHD', 'FOO, INC'] }, ctx, VALID);
    const hit = calls.find((c) => c.m === 'in' && c.col === 'supplier.name');
    expect(hit?.vals).toEqual(['DIGLANT SDN BHD', 'FOO, INC']);
  });

  it('filters by creditor code and currency, and stays company-scoped', () => {
    const { self, calls } = recorder();
    filterPoList(self, { ...base, creditorCodes: ['400-D001'], currencies: ['USD'] }, ctx, VALID);
    expect(calls.find((c) => c.m === 'in' && c.col === 'supplier.code')?.vals).toEqual(['400-D001']);
    expect(calls.find((c) => c.m === 'in' && c.col === 'currency')?.vals).toEqual(['USD']);
    expect(calls.find((c) => c.m === 'eq' && c.col === 'company_id')?.vals).toBe(1);
  });

  it('filters by Doc Date on the base po_date column, so paging runs over every matching PO', () => {
    const { self, calls } = recorder();
    filterPoList(self, { ...base, docDates: ['2026-09-15', '2026-09-16'] }, ctx, VALID);
    expect(calls.find((c) => c.m === 'in' && c.col === 'po_date')?.vals).toEqual(['2026-09-15', '2026-09-16']);
    expect(readPoListFilters((k) => (k === 'docDates' ? '["2026-09-15"]' : undefined)).docDates).toEqual(['2026-09-15']);
  });

  it('applies no creditor/currency filter when none are set', () => {
    const { self, calls } = recorder();
    filterPoList(self, base, ctx, VALID);
    expect(calls.some((c) => c.col === 'supplier.name' || c.col === 'supplier.code' || c.col === 'currency')).toBe(false);
  });
});
