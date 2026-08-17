/* ── /mine gated view-all on the flat key alone, unlike every other sales read ──
   GET /mfg-sales-orders/mine honours `?salesperson=all` only for a view-all
   caller. Every other gate in the file grants that tier via canViewAllSales
   (`scm.so.view_all` OR a director position); /mine alone checked the bare
   flat key. A Sales Director whose position matrix lacked the key therefore
   saw every order on the SO list but a silently self-scoped "All salespeople"
   board — 1 row under a KPI card counting 28 (2990, July 2026). Silent is the
   sting: the param is ignored, not refused, so nothing said why.

   The handler is registered inline (not exported), so this is a structural
   test in the consignmentOrderSalesScope.test.ts layer-3 idiom: assert the
   /mine block gates on canViewAllSales, so a revert to the bare key cannot
   land silently. */
import { describe, expect, test } from 'vitest';
import routeSource from '../src/scm/routes/mfg-sales-orders.ts?raw';

/* The /mine handler: from its registration to the next route registration. */
const mineBlock = (): string => {
  const start = routeSource.indexOf("mfgSalesOrders.get('/mine'");
  expect(start).toBeGreaterThan(-1);
  const rest = routeSource.slice(start + 1);
  const next = rest.search(/mfgSalesOrders\.(get|post|patch|put|delete)\(/);
  return routeSource.slice(start, next === -1 ? undefined : start + 1 + next);
};

describe('/mine view-all tier', () => {
  test('gates ?salesperson on canViewAllSales, the same tier as the rest of the file', () => {
    expect(mineBlock()).toContain('canViewAllSales(c)');
  });

  test('never regresses to the bare flat-key check that self-scoped directors', () => {
    expect(mineBlock()).not.toMatch(/hasHouzsPerm\(\s*c\s*,\s*'scm\.so\.view_all'\s*\)/);
  });

  /* The ported 2990 view-all branch built its own createClient() for RLS
     bypass. In Houzs that is not just redundant (`sb` is already the
     service-role client) — it is WRONG: a raw createClient defaults to the
     PUBLIC schema, where mfg_sales_orders has no company_id, so the first
     caller ever to pass the widened gate got
     `column mfg_sales_orders.company_id does not exist` (500) instead of a
     board. Every query in /mine must ride `sb` (scm schema). */
  test('builds no client of its own — a raw createClient defaults to the public schema', () => {
    // `=\s*createClient(` — the assignment shape of a real call. A bare
    // substring match would trip on the comment explaining this very bug.
    expect(mineBlock()).not.toMatch(/=\s*createClient\(/);
  });
});
