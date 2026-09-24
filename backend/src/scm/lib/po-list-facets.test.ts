import { describe, it, expect } from 'vitest';
import { buildPoFacets, countFacet } from './po-list-facets';
import type { PoListFilters } from './po-list-read';

/* DEV-13: the PO funnels counted only the loaded page (Doc Date 34 before the
   click, 42 after). The server now counts every matching order, each column
   under every OTHER filter but not its own. */

const base: PoListFilters = {
  status: null, supplierId: null, q: null, from: null, to: null, sort: null,
  creditorNames: null, creditorCodes: null, currencies: null, docDates: null,
};
const ctx = { get: (k: string) => (k === 'companyId' ? 1 : undefined) } as { get(key: string): unknown };
const VALID = new Set(['SUBMITTED']);

const row = (name: string, date: string) => ({ supplier_id: 's', po_date: date, currency: 'MYR', supplier: { name, code: name.slice(0, 3) } });

describe('countFacet', () => {
  it('counts every order per value, with a missing value as "—"', () => {
    const rows = [row('HOOKKA', '2026-09-22'), row('HOOKKA', '2026-09-22'), row('ZOE', '2026-09-23'), { supplier_id: null, po_date: null, currency: 'MYR', supplier: null }];
    expect(countFacet(rows, 'supplier')).toEqual([['HOOKKA', 2], ['ZOE', 1], ['—', 1]]);
    expect(countFacet(rows, 'po_date')).toEqual([['2026-09-22', 2], ['2026-09-23', 1], ['—', 1]]);
  });
});

describe('buildPoFacets — each column ignores its own filter only', () => {
  it('reads Doc Date without the date filter but with the creditor filter, company-scoped', async () => {
    const reads: Array<{ select: string; calls: Array<[string, string, unknown]> }> = [];
    const sb = {
      from: () => ({
        select: (select: string) => {
          const read = { select, calls: [] as Array<[string, string, unknown]> };
          reads.push(read);
          const b: Record<string, unknown> = {};
          for (const m of ['in', 'eq', 'or', 'gte', 'lte', 'order']) b[m] = (col: string, v: unknown) => { read.calls.push([m, col, v]); return b; };
          b.range = () => Promise.resolve({ data: [row('HOOKKA', '2026-09-22')], error: null });
          return b;
        },
      }),
    };
    const out = await buildPoFacets(sb, ctx, { ...base, creditorNames: ['HOOKKA'], docDates: ['2026-09-22'] }, VALID);
    expect(out.error).toBeNull();
    // Reads run in PO_FACET_COLS order: supplier, creditor_code, currency, po_date.
    const [supplierRead, , , dateRead] = reads;
    expect(supplierRead!.calls.some(([, col]) => col === 'supplier.name')).toBe(false);
    expect(supplierRead!.calls.some(([, col, v]) => col === 'po_date' && JSON.stringify(v) === '["2026-09-22"]')).toBe(true);
    expect(dateRead!.calls.some(([, col]) => col === 'po_date')).toBe(false);
    expect(dateRead!.calls.some(([, col]) => col === 'supplier.name')).toBe(true);
    expect(dateRead!.select).toContain('suppliers!inner');
    for (const r of reads) expect(r.calls.some(([m, col, v]) => m === 'eq' && col === 'company_id' && v === 1)).toBe(true);
  });
});
