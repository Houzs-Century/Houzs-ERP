import { describe, it, expect } from 'vitest';
import { readPiListFilters, piListSelect, filterPiList, type PiListFilters } from './pi-list-read';

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
const base: PiListFilters = { status: null, q: null, from: null, to: null, sort: null, creditorNames: null, creditorCodes: null, currencies: null };

describe('readPiListFilters — server-filterable funnel params', () => {
  it('parses creditor names/codes/currencies as JSON arrays, commas in names survive', () => {
    const q: Record<string, string> = { creditorNames: JSON.stringify(['DIGLANT, INC']), creditorCodes: JSON.stringify(['400-D001']), currencies: JSON.stringify(['MYR']) };
    const p = readPiListFilters((k) => q[k]);
    expect(p.creditorNames).toEqual(['DIGLANT, INC']);
    expect(p.creditorCodes).toEqual(['400-D001']);
    expect(p.currencies).toEqual(['MYR']);
  });
});

describe('piListSelect — inner supplier embed only under a creditor filter', () => {
  it('is a plain embed with no creditor filter, !inner when names or codes present', () => {
    expect(piListSelect(base)).toContain('supplier:suppliers(');
    expect(piListSelect(base)).not.toContain('suppliers!inner');
    expect(piListSelect({ ...base, creditorNames: ['DIGLANT'] })).toContain('supplier:suppliers!inner(');
    expect(piListSelect({ ...base, creditorCodes: ['400-D001'] })).toContain('supplier:suppliers!inner(');
  });
});

describe('filterPiList — pushes the server-filterable funnels into the query', () => {
  it('filters by creditor name/code on the supplier embed and currency, staying company-scoped', () => {
    const { self, calls } = recorder();
    filterPiList(self, { ...base, creditorNames: ['DIGLANT, INC'], creditorCodes: ['400-D001'], currencies: ['USD'] }, ctx);
    expect(calls.find((c) => c.m === 'in' && c.col === 'supplier.name')?.vals).toEqual(['DIGLANT, INC']);
    expect(calls.find((c) => c.m === 'in' && c.col === 'supplier.code')?.vals).toEqual(['400-D001']);
    expect(calls.find((c) => c.m === 'in' && c.col === 'currency')?.vals).toEqual(['USD']);
    expect(calls.find((c) => c.m === 'eq' && c.col === 'company_id')?.vals).toBe(1);
  });

  it('applies no creditor/currency filter when none are set', () => {
    const { self, calls } = recorder();
    filterPiList(self, base, ctx);
    expect(calls.some((c) => c.col === 'supplier.name' || c.col === 'supplier.code' || c.col === 'currency')).toBe(false);
  });
});
