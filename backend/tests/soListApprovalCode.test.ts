/* The Sales Order list's Approval Code column and search reach the route
 * (owner 2026-09-15, docs/bugs/0909).
 *
 * WHY A SOURCE TEST. The list handler is Supabase-backed with no binding in
 * this suite and its search is one PostgREST `.or()` string built in TWO
 * places — the page-rows query and the money-KPI aggregate — that must filter
 * the same set (docs/bugs/0755). The rule itself is pinned in
 * src/scm/lib/so-list-approval-codes.test.ts; what only the source can show
 * is that the payments read carries the code, the row carries the summary,
 * and the search term rides BOTH queries. Same technique as
 * soPaymentAmendRoutes.test.ts.
 */
import { describe, expect, test } from 'vitest';

const sources = import.meta.glob('../src/scm/routes/mfg-sales-orders.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const routeSource = Object.values(sources)[0] ?? '';

const between = (from: string, to: string): string => {
  const a = routeSource.indexOf(from);
  expect(a, `${from} is not in the route`).toBeGreaterThan(-1);
  const b = routeSource.indexOf(to, a);
  expect(b, `${to} does not follow ${from}`).toBeGreaterThan(a);
  return routeSource.slice(a, b);
};

describe('the Sales Order list and the approval codes', () => {
  test('the source loaded (a silent empty glob must not pass)', () => {
    expect(routeSource.length).toBeGreaterThan(1000);
  });

  test('the payments read the list already makes carries the code and the dates the column is ordered by', () => {
    const read = between('const payRowsProm', 'const downstreamProm');
    expect(read).toContain("select('so_doc_no, method, online_type, approval_code, paid_at, created_at')");
  });

  test('every row carries approval_codes_summary from the one helper', () => {
    expect(routeSource).toContain('approvalCodesByOrder(');
    expect(routeSource).toMatch(/\.approval_codes_summary = approvalCodes\.get\(docNo\) \?\? ''/);
  });

  /* The search term is built ONCE and added to BOTH queries. A term on only
     the page query would list orders the KPI strip does not count. */
  test('the code search term rides the page query AND the money-KPI aggregate', () => {
    expect(routeSource).toContain('approvalCodeOrPart(');
    const page = between("const search = c.req.query('q');", "const from = c.req.query('from')");
    expect(page, 'the page query does not admit orders found by approval code').toContain('codePart');
    const money = between('const applyMoneyFilters', 'const moneyProm');
    expect(money, 'the money aggregate does not admit the same orders').toContain('codePart');
  });

  /* Before the list builder, so the header search's own `.or()` still sits
     under the header table; an EXACT match, so no trigram index is owed; and
     its failure refuses the list rather than dropping the matches. */
  test('the lookup runs before the list builder, matches the code exactly, is scoped to the company, capped, and refuses on a failed read', () => {
    const lookup = between('let codePart', "let q = sb.from('mfg_sales_orders_with_payment_totals').select(LIST_COLS, { count: 'exact' })");
    expect(lookup).toContain("from('mfg_sales_order_payments')");
    expect(lookup).toContain("eq('approval_code', code)");
    expect(lookup).not.toContain("ilike('approval_code'");
    expect(lookup).toContain('scopeToCompany(');
    expect(lookup).toContain('APPROVAL_CODE_SEARCH_CAP');
    expect(lookup).toContain('if (error) return c.json(');
  });
});
