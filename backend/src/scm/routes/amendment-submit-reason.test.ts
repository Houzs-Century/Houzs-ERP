/* Owner 2026-09-15: 「SO amendment reason 换成一定 fill in」— an SO amendment
 * cannot be raised without a reason. The submit handler lives in a 12,000-line
 * router that cannot be driven end to end here (see amendment-submit-lane.test.ts
 * for the same constraint), so this pins the guard on the handler's SOURCE: it
 * runs BEFORE the SO is even read, trims the reason, and refuses 400
 * `reason_required` on a blank one. */
import { describe, expect, it } from 'vitest';
/* `?raw`, not node:fs — backend/tsconfig.json types Workers only. */
import { soRouterSource } from '../../../tests/lib/so-router-source';
const rawRoute = soRouterSource();

const start = rawRoute.indexOf("mfgSalesOrders.post('/:docNo/amendments'");
const handler = start < 0 ? '' : rawRoute.slice(start, rawRoute.indexOf('\nmfgSalesOrders.', start + 10));

describe('the amendment submit route requires a reason', () => {
  it('finds the handler (a pin over nothing must not pass)', () => {
    expect(start).toBeGreaterThan(-1);
    expect(handler).toContain('so_amendments');
  });

  it('trims the reason and refuses 400 reason_required when it is blank', () => {
    expect(handler).toMatch(/body\.reason = typeof body\.reason === 'string' \? body\.reason\.trim\(\) : '';/);
    expect(handler).toMatch(/if \(!body\.reason\) \{\s*return c\.json\(\{\s*error: 'reason_required'/);
  });

  it('checks the reason before the SO row is read, so a blank request costs no lookup', () => {
    const guard = handler.indexOf("error: 'reason_required'");
    const soRead = handler.indexOf("from('mfg_sales_orders')");
    expect(guard).toBeGreaterThan(-1);
    expect(soRead).toBeGreaterThan(guard);
  });

  it('stores the trimmed reason, never a NULL fallback, on the amendment row', () => {
    const insert = handler.slice(handler.indexOf("from('so_amendments').insert("));
    expect(insert).toMatch(/reason:\s+body\.reason,/);
  });
});
