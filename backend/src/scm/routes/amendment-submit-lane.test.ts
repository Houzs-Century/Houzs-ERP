/* Who approves an SO amendment is decided ONCE, when it is raised: the submit
 * route (POST /mfg-sales-orders/:docNo/amendments) splits the request into its
 * lanes and stores the lane on the row. An ADDED line has no SO row behind it,
 * so whether it is a SERVICE line can only come from the catalogue.
 *
 * Owner 2026-09-14: 「为什么Service line item还是purchaser approve?」 —
 * HC-SO-012757/A1 added TRANSPORTATION CHARGES (catalogue category SERVICE)
 * and landed on the Purchaser, because the route handed the lane split the new
 * code alone. The rule itself is pinned in shared/amendment-lane.test.ts and the
 * catalogue read in lib/validate-item-codes.test.ts; the handler lives in a
 * 12,000-line router that cannot be driven end to end here, so this pins the
 * WIRING between them on the handler's source. */
import { describe, expect, it } from 'vitest';
/* `?raw`, not node:fs — backend/tsconfig.json types Workers only. */
import rawRoute from './mfg-sales-orders.ts?raw';

const start = rawRoute.indexOf("mfgSalesOrders.post('/:docNo/amendments'");
const handler = start < 0 ? '' : rawRoute.slice(start, rawRoute.indexOf('\nmfgSalesOrders.', start + 10));

describe('the amendment submit route classifies an ADDED line with its catalogue category', () => {
  it('finds the handler (a pin over nothing must not pass)', () => {
    expect(start).toBeGreaterThan(-1);
    expect(handler).toContain('splitAmendmentByLane(');
  });

  it('reads the categories of the added codes in the order\'s company, refusing on a failed read', () => {
    expect(handler).toMatch(/catalogCategoriesByCode\(\s*sb,[^;]*activeCompanyId\(c\)\s*\)/);
    expect(handler).toMatch(/if \(!addedCategory\) return c\.json\(LINE_BUILD_ERRORS\.unreadable, 500\);/);
  });

  it('hands that category to the lane split for a line with no SO row', () => {
    const call = handler.slice(handler.indexOf('splitAmendmentByLane('), handler.indexOf('splitAmendmentByLane(') + 400);
    expect(call).toMatch(/itemCode: l\.newItemCode, category: addedCategory\.get\(/);
  });
});
