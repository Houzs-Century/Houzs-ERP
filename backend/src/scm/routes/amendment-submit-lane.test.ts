/* Who approves an SO amendment is decided ONCE, when it is raised: the submit
 * route (POST /mfg-sales-orders/:docNo/amendments) splits the request into its
 * lanes and stores the lane on the row. An ADDED line has no SO row behind it,
 * so whether it is a SERVICE line can only come from the catalogue.
 *
 * Owner 2026-09-14: 「为什么Service line item还是purchaser approve?」 —
 * HC-SO-012757/A1 added TRANSPORTATION CHARGES (catalogue category SERVICE)
 * and landed on the Purchaser, because the route handed the lane split the new
 * code alone. Since 2026-09-15 (option B, the lane PREVIEW) the resolution lives
 * in lib/amendment-lane-resolve, shared by the submit route and the preview
 * route, and THAT module is pinned in amendment-lane-resolve.test.ts. The
 * handler lives in a 12,000-line router that cannot be driven end to end here,
 * so this pins the WIRING: the submit route asks the shared resolver, in the
 * order's company, and refuses when it cannot answer. */
import { describe, expect, it } from 'vitest';
/* `?raw`, not node:fs — backend/tsconfig.json types Workers only. */
import { soRouterSource } from '../../../tests/lib/so-router-source';
import rawPreview from './so-amendment-lane-preview.ts?raw';
const rawRoute = soRouterSource();

const start = rawRoute.indexOf("mfgSalesOrders.post('/:docNo/amendments'");
const handler = start < 0 ? '' : rawRoute.slice(start, rawRoute.indexOf('\nmfgSalesOrders.', start + 10));

describe('the amendment submit route classifies through the shared lane resolver', () => {
  it('finds the handler (a pin over nothing must not pass)', () => {
    expect(start).toBeGreaterThan(-1);
    expect(handler).toContain("from('so_amendments').insert(");
  });

  it('asks the resolver in the order\'s company, refusing on a failed read', () => {
    expect(handler).toMatch(/const split = await resolveAmendmentLaneSplit\(sb, docNo, activeCompanyId\(c\), headerChanges, submittedLines, priceLaneEnabled\);/);
    expect(handler).toMatch(/if \(!split\) return c\.json\(LINE_BUILD_ERRORS\.unreadable, 500\);/);
  });

  it('keeps no private copy of the classification — a second copy is the drift the preview must not have', () => {
    expect(handler).not.toContain('splitAmendmentByLane(');
    expect(handler).not.toContain('catalogCategoriesByCode(');
  });

  it('stores the lane the resolver gave, per created row', () => {
    const insert = handler.slice(handler.indexOf("from('so_amendments').insert("));
    expect(insert).toMatch(/lane:\s+laneKey,/);
  });
});

describe('the lane preview route answers from the SAME resolver', () => {
  it('calls the resolver in the order\'s company and refuses on a failed read', () => {
    expect(rawPreview).toMatch(/resolveAmendmentLaneSplit\(sb, docNo, activeCompanyId\(c\), headerChanges, noopSplit\.kept, priceLaneEnabled\)/);
    expect(rawPreview).toMatch(/if \(!split\) return c\.json\(LINE_BUILD_ERRORS\.unreadable, 500\);/);
    expect(rawPreview).not.toContain('splitAmendmentByLane(');
  });

  it('writes nothing — no insert, no update, no number minted', () => {
    expect(rawPreview).not.toMatch(/\.insert\(|\.update\(|\.delete\(|amendment_no/);
  });
});
