// The consignment sales trio gets the cross-company source guards its
// GRN / DR / DO siblings always had.
//
// 2026-08-21 full-flow audit, item A3: on POST /consignment-notes the
// caller-supplied CO line ids resolved the ship-from WAREHOUSE and the unit
// cost with NO company predicate, on the service-role client (no RLS) — a
// HOUZS note carrying 2990 CO line ids deducted stock out of 2990's warehouse
// under HOUZS' company stamp; the free-text consignment_so_doc_no landed
// verbatim and document-flow traced it across tenants; and the shared
// source-cost read resolved the other tenant's stored cost. The returns side
// (POST /consignment-returns and both add-line paths) shared the line-id hole.
//
// Structural pins over bounded source slices — the handlers need a live DB.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
const CN = read('../src/scm/routes/consignment-notes.ts');
const CR = read('../src/scm/routes/consignment-returns.ts');
const COST = read('../src/scm/lib/source-cost.ts');

function slice(src: string, startAnchor: string, endAnchor: string): string {
  const start = src.indexOf(startAnchor);
  expect(start, `${startAnchor} not found`).toBeGreaterThan(-1);
  const end = src.indexOf(endAnchor, start);
  expect(end, `${endAnchor} not found after ${startAnchor}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('source-cost — the company predicate is required, not optional', () => {
  it('takes companyId as a required parameter and applies it to the read', () => {
    expect(COST).toContain('companyId: number | null');
    expect(COST).toContain(".eq('company_id', companyId)");
  });

  it('all six call sites pass the active company', () => {
    /* One import + two calls per router; a call that stops passing the company
       re-opens the cross-tenant cost read. */
    for (const [name, src, expected] of [
      ['consignment-notes', CN, 2],
      ['consignment-returns', CR, 2],
      ['delivery-returns', read('../src/scm/routes/delivery-returns.ts'), 2],
    ] as const) {
      /* The import line carries no paren, so this counts CALLS only. */
      const calls = src.split('sourceUnitCostByItemId(').length - 1;
      expect(calls, `${name}: call count moved — update this pin`).toBe(expected);
      /* TIGHTENED 2026-08-23. This used to count `activeCompanyId(c) ?? null)`
         over the WHOLE file as a proxy for "every call passed the company" — so
         any unrelated helper that also takes the active company inflated the
         count and failed the pin (resolveItemGroups, docs/bugs/0524, did exactly
         that). Read the company argument out of each call's OWN argument list
         instead: narrower, and it now fails for the reason it claims to. */
      const scoped = src
        .split('sourceUnitCostByItemId(')
        .slice(1)
        .filter((tail) => tail.slice(0, tail.indexOf('))') + 2).includes('activeCompanyId(c) ?? null'))
        .length;
      expect(scoped, `${name}: a call dropped the company argument`).toBe(expected);
    }
  });
});

describe('consignment-notes — the create and add-line paths refuse foreign sources', () => {
  it('the create asserts the CO line ids in-company and validates the CO doc_no scoped', () => {
    const seg = slice(CN, "consignmentNotes.post('/', async (c) => {", 'insertWithDocNoRetry');
    expect(seg).toContain("assertSourceLinesInCompany(sb, c, 'consignment_sales_order_items'");
    expect(seg).toContain("from('consignment_sales_orders')");
    expect(seg).toContain("error: 'consignment_order_not_found'");
    // The doc_no read is scoped AND fail-closed.
    expect(seg).toContain('scopeToCompany(');
    expect(seg).toContain("error: 'source_check_failed'");
  });

  it('the add-line path carries the same line guard', () => {
    const seg = slice(CN, "consignmentNotes.post('/:id/items'", 'buildItemRow(id, it');
    expect(seg).toContain("assertSourceLinesInCompany(sb, c, 'consignment_sales_order_items'");
  });

  it('the warehouse resolver read carries the company predicate', () => {
    const seg = slice(CN, 'const soWh = new Map', 'const fallback =');
    expect(seg).toContain(".eq('company_id', companyId ?? -1)");
    expect(seg).toContain('error: soErr');
  });
});

describe('consignment-returns — the create and add-line paths refuse foreign sources', () => {
  it('the create asserts the note line ids in-company', () => {
    const seg = slice(CR, "consignmentReturns.post('/', async (c) => {", 'insertHeader(');
    expect(seg).toContain("assertSourceLinesInCompany(sb, c, 'consignment_delivery_order_items'");
  });

  it('the add-line path carries the same guard', () => {
    const seg = slice(CR, "consignmentReturns.post('/:id/items'", 'buildItemRow(id, it');
    expect(seg).toContain("assertSourceLinesInCompany(sb, c, 'consignment_delivery_order_items'");
  });
});
