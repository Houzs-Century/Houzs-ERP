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
   Payment status compare columns only the view computes. */
import { describe, expect, test } from 'vitest';
import routeSource from '../src/scm/routes/mfg-sales-orders.ts?raw';

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
  test('prepares the filters once from the repeated f param and returns its refusal', () => {
    const arm = pagedArm();
    expect(arm).toMatch(/prepareSoListFilters\(\s*sb,\s*c\.req\.queries\('f'\)/);
    expect(arm).toMatch(/if \(!soFilter\.ok\) return c\.json\(soFilter\.body, soFilter\.status\)/);
  });

  test('the page query, the money predicates and the count builder all apply it', () => {
    const arm = pagedArm();
    expect(arm).toMatch(/q = soFilter\.apply\(scopeToCompany\(q, c\)\)/);
    expect(arm).toMatch(/moneyQ = soFilter\.apply\(scopeToCompany\(moneyQ, c\)\)/);
    expect(arm).toMatch(/soFilter\.apply\(scopeToCompany\(applySoScope\(q0, scopeIds\), c\)\)/);
  });

  test('the status counts read the relation the prepared filter names, never a hard-coded table', () => {
    const arm = pagedArm();
    const countsStart = arm.indexOf('const scopedCountQ');
    const countsEnd = arm.indexOf('const applyMoneyFilters');
    expect(countsStart).toBeGreaterThan(-1);
    expect(countsEnd).toBeGreaterThan(countsStart);
    const counts = arm.slice(countsStart, countsEnd);
    expect(counts.match(/sb\.from\(soFilter\.countFrom\)/g)?.length).toBe(3);
    expect(counts).not.toMatch(/sb\.from\('mfg_sales_orders'\)/);
  });
});
