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
import { soRouterSource } from './lib/so-router-source';

const routeSource = soRouterSource();
/* The search predicates moved into lib/so-list-read.ts on 2026-09-15 so the
   page, the money strip and the line export share ONE copy. */
const readSources = import.meta.glob('../src/scm/lib/so-list-read.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
/* The list's row builder (payments read, per-row summary) moved to
   lib/so-list-rows.ts on 2026-09-15. */
const rowSources = import.meta.glob('../src/scm/lib/so-list-rows.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const rowsSource = Object.values(rowSources)[0] ?? '';
const readSource = Object.values(readSources)[0] ?? '';
const betweenIn = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  expect(a, `${from} is not in the source`).toBeGreaterThan(-1);
  const b = src.indexOf(to, a);
  expect(b, `${to} does not follow ${from}`).toBeGreaterThan(a);
  return src.slice(a, b);
};

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
    expect(readSource.length).toBeGreaterThan(1000);
  });

  test('the payments read the list already makes carries the code and the dates the column is ordered by', () => {
    const read = betweenIn(rowsSource, 'const payRowsProm', 'const downstreamProm');
    expect(read).toContain("select('so_doc_no, method, online_type, approval_code, paid_at, created_at')");
  });

  test('every row carries approval_codes_summary from the one helper', () => {
    expect(rowsSource).toContain('approvalCodesByOrder(');
    expect(rowsSource).toMatch(/\.approval_codes_summary = approvalCodes\.get\(docNo\) \?\? ''/);
  });

  /* The search term is built ONCE and added to BOTH queries. A term on only
     the page query would list orders the KPI strip does not count. */
  test('the code search term rides the page query AND the money-KPI aggregate', () => {
    expect(readSource).toContain('approvalCodeOrPart(');
    const search = betweenIn(readSource, 'if (search) {', 'if (p.from)');
    expect(search, 'the list search does not admit orders found by approval code').toContain('codePart');
    const arm = betweenIn(routeSource, 'PAGINATED PATH', 'const moneyProm');
    expect(arm, 'the page query does not read through the shared header').toContain('let q = read.header(');
    expect(arm, 'the money aggregate does not admit the same orders').toContain('const applyMoneyFilters = (moneyQ0: any): any => read.header(moneyQ0)');
  });

  test('the lookup runs before the list builder, matches the code exactly, is scoped to the company, capped, and refuses on a failed read', () => {
    const lookup = betweenIn(readSource, 'async function readApprovalCodePart', 'return { ok: true, part: codePart }');
    expect(lookup).toContain("from('mfg_sales_order_payments')");
    expect(lookup).toContain("eq('approval_code', code)");
    expect(lookup).not.toContain("ilike('approval_code'");
    expect(lookup).toContain('scopeToCompany(');
    expect(lookup).toContain('APPROVAL_CODE_SEARCH_CAP');
    expect(lookup).toContain('if (error) return { ok: false, status: 500');
  });
});
