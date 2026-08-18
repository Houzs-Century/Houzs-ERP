import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/*
 * Six SO child reads in mfg-sales-orders.ts were keyed on the document number
 * ALONE. Document numbers are unique per company by PREFIX convention
 * (`HC-`/bare = HOUZS, `2990-` = 2990), never by a constraint, so the key does
 * not carry the tenant — and the frontend fires these panels off the URL
 * (`enabled: Boolean(docNo)`). Pasting a 2990 order number into a Houzs URL
 * populated the History, Status, Price-override and Payments panels from the
 * other company's books, and `/slip-url` streamed the other company's payment
 * slip OUT OF R2 — the file itself, not a field of it.
 *
 * The in-file precedent was already there: `/:docNo/revisions`, registered
 * between two of the leaking routes, carries `scopeToCompany`. So this was an
 * omission, not a design decision.
 *
 * WHY A SOURCE-SHAPE TEST. These are Supabase builder chains; exercising them
 * needs the PostgREST client, which the light suite does not have. What can be
 * pinned without it is the thing that actually regressed: the predicate being
 * present in the statement.
 *
 * TWO assertions per route, and the pair is the point. A slice taken from one
 * route registration to the next can pick up the NEXT handler's guard and
 * acquit a route that has none — so each case also asserts the slice really
 * does contain the query it is supposed to be judging. A test that cannot fail
 * for the right reason is worse than no test.
 */

const SRC = readFileSync(
  fileURLToPath(new URL('../src/scm/routes/mfg-sales-orders.ts', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n');

/** Source from this route's registration up to the next `mfgSalesOrders.<verb>(`. */
function handlerSlice(registration: string): string {
  const start = SRC.indexOf(registration);
  expect(start, `route registration not found: ${registration}`).toBeGreaterThan(-1);
  const after = SRC.slice(start + registration.length);
  const next = after.search(/\nmfgSalesOrders\.(get|post|patch|put|delete)\(/);
  return next === -1 ? after : after.slice(0, next);
}

const SCOPED = /scopeToCompany\s*\(/;

const CASES: Array<{ route: string; registration: string; mustContain: string }> = [
  {
    route: 'GET /:docNo/audit-log',
    registration: "mfgSalesOrders.get('/:docNo/audit-log'",
    mustContain: "from('mfg_so_audit_log')",
  },
  {
    route: 'GET /:docNo/status-changes',
    registration: "mfgSalesOrders.get('/:docNo/status-changes'",
    mustContain: "from('mfg_so_status_changes')",
  },
  {
    route: 'GET /:docNo/price-overrides',
    registration: "mfgSalesOrders.get('/:docNo/price-overrides'",
    mustContain: "from('mfg_so_price_overrides')",
  },
  {
    route: 'GET /:docNo/payments',
    registration: "mfgSalesOrders.get('/:docNo/payments'",
    mustContain: "from('mfg_sales_order_payments')",
  },
  {
    route: 'GET /:docNo/slip-url',
    registration: "mfgSalesOrders.get('/:docNo/slip-url'",
    mustContain: "from('mfg_sales_orders')",
  },
];

describe('SO child reads are scoped to the caller company', () => {
  test.each(CASES)('$route carries a company predicate', ({ registration, mustContain }) => {
    const slice = handlerSlice(registration);
    // (1) the slice really is judging the query we think it is
    expect(slice).toContain(mustContain);
    // (2) and that query is company-scoped
    expect(slice).toMatch(SCOPED);
  });

  test('/:docNo/revisions — the in-file precedent these five now match', () => {
    const slice = handlerSlice("mfgSalesOrders.get('/:docNo/revisions'");
    expect(slice).toContain("from('so_revisions')");
    expect(slice).toMatch(SCOPED);
  });

  test('the slicer cannot pass vacuously: a route with no such query fails case (1)', () => {
    // Guard the guard. If handlerSlice ever returned the whole file (a changed
    // registration prefix, say), every case above would pass on some other
    // handler's scopeToCompany. This asserts the slice is genuinely bounded.
    const slice = handlerSlice("mfgSalesOrders.get('/:docNo/audit-log'");
    expect(slice).not.toContain("from('mfg_so_price_overrides')");
    expect(slice.length).toBeLessThan(SRC.length / 4);
  });
});

describe('checkCrossCategorySource — the eligibility probe', () => {
  /** The helper body, from its declaration to the next top-level declaration. */
  function helperBody(): string {
    const start = SRC.indexOf('async function checkCrossCategorySource(');
    expect(start).toBeGreaterThan(-1);
    const after = SRC.slice(start);
    const end = after.search(/\n(async function|function|const|mfgSalesOrders\.)/);
    return end === -1 ? after : after.slice(0, end);
  }

  test('both of its doc_no reads are company-scoped', () => {
    const body = helperBody();
    // It answers a public-ish GET keyed only on a doc number and hands back
    // `debtor_name` — a customer identity — so an unscoped read leaked who the
    // other company's customer is.
    expect(body).toContain("from('mfg_sales_orders')");
    expect(body).toContain("select('doc_no, status, phone, debtor_name, customer_id')");
    const scopes = body.match(/scopeToCompany\s*\(/g) ?? [];
    // One for the source lookup, one for the single-use count. If the count is
    // ever left unscoped, "already used" becomes a cross-company fact and the
    // other company's link burns ours.
    expect(scopes).toHaveLength(2);
  });

  test('it takes the request context, so scoping is possible at all', () => {
    expect(SRC).toMatch(/async function checkCrossCategorySource\(\s*\n\s*c: any,/);
    // Every caller must thread it, or the signature change is cosmetic.
    const calls = SRC.match(/checkCrossCategorySource\(\s*\n?\s*c,/g) ?? [];
    const allCalls = SRC.match(/await checkCrossCategorySource\(/g) ?? [];
    expect(calls.length).toBe(allCalls.length);
    expect(allCalls.length).toBeGreaterThanOrEqual(2);
  });
});
