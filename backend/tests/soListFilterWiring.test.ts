/* ── The SO list's second-level filters must reach ALL THREE reads ──────────
   GET /mfg-sales-orders (paginated) answers one screen with three independent
   reads: the page of rows, the money aggregate (the header's revenue /
   outstanding), and the status counts (the pills / the phone sheet's numbers).
   A filter applied to the rows alone gives a page of 12 orders under a header
   saying "2949 orders · RM 4.1m" and pills that still count the whole company —
   the owner asked for exactly the opposite ("the counts reflect the filters").

   The handler is registered inline (not exported), so this is a structural test
   in the mineBoardViewAllTier.test.ts idiom: the list block must prepare the
   filters once, answer an invalid row, and apply the SAME prepared filter to
   the page query, the money predicate set and the count builder — and the
   counts must read the relation the prepared filter names, because Balance and
   Payment status compare columns only the view computes.

   Since 2026-09-15 the predicates live in lib/so-list-read.ts (the line export
   reads through them too), so the list block is asserted to use its ONE
   prepared read for all three, and the module to apply the filter inside it. */
import { describe, expect, test } from 'vitest';
import { soRouterSource } from './lib/so-router-source';
import readSource from '../src/scm/lib/so-list-read.ts?raw';
const routeSource = soRouterSource();

const listBlock = (): string => {
  const start = routeSource.indexOf("mfgSalesOrders.get('/',");
  expect(start).toBeGreaterThan(-1);
  const rest = routeSource.slice(start + 1);
  const next = rest.search(/\nmfgSalesOrders\.(get|post|patch|put|delete)\(/);
  return routeSource.slice(start, next === -1 ? undefined : start + 1 + next);
};
/* The paginated arm only — the legacy arm is left byte-identical on purpose. */
const pagedArm = (): string => {
  const block = listBlock();
  const at = block.indexOf('PAGINATED PATH');
  expect(at).toBeGreaterThan(-1);
  return block.slice(at);
};

describe('SO list second-level filter wiring', () => {
  test('prepares the one read from the repeated f param and returns its refusal', () => {
    const arm = pagedArm();
    expect(arm).toContain('prepareSoListRead(sb, c, readSoListParams((k) => c.req.query(k), (k) => c.req.queries(k))');
    expect(arm).toContain('if (!read.ok) return c.json(read.body, read.status)');
    expect(readSource).toContain('prepareSoListFilters(sb, p.f, houzsUserId, now)');
    expect(readSource).toContain('if (!soFilter.ok) return soFilter;');
  });

  test('the page query, the money predicates and the count builder all apply it', () => {
    const arm = pagedArm();
    expect(arm).toContain('let q = read.header(orderSoList(');
    expect(arm).toContain('const applyMoneyFilters = (moneyQ0: any): any => read.header(moneyQ0)');
    expect(arm).toContain('const scopedCountQ = (q0: any): any => read.scoped(q0)');
    expect(readSource).toContain('soFilter.apply(scopeToCompany(applySoScope(q, scopeIds), c))');
    expect(readSource).toContain('let q = scoped(q0)');
  });

  test('the status counts read the relation the prepared filter names, never a hard-coded table', () => {
    const arm = pagedArm();
    const countsStart = arm.indexOf('const scopedCountQ');
    const countsEnd = arm.indexOf('const applyMoneyFilters');
    expect(countsStart).toBeGreaterThan(-1);
    expect(countsEnd).toBeGreaterThan(countsStart);
    const counts = arm.slice(countsStart, countsEnd);
    expect(counts.split('sb.from(read.countFrom)').length - 1).toBe(3);
    expect(counts).not.toContain("sb.from('mfg_sales_orders')");
    expect(readSource).toContain('countFrom: soFilter.countFrom');
  });
});
