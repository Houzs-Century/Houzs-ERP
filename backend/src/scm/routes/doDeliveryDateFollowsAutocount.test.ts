// A delivery order's delivery dates FOLLOW ITS OWN do_date (= AutoCount's
// DocDate), never the sales order's customer date — owner 2026-09-11
// 「全部要跟 autocount」 (docs/bugs/0804). This pins both places that set them so
// the reverted 2026-09-08 default (seed from s.customer_delivery_date) cannot
// creep back. A WIRING pin like relinkHeaderColumns: the regression is a value
// source drifting back to the SO, which no behavioural test over one converted
// document would make obvious.
import { describe, expect, test } from 'vitest';
import routeSrc from './delivery-orders-mfg.ts?raw';
import carrySrc from '../../../scripts/lib/customer-block.mjs?raw';

describe('a DO delivery date follows the DO, not the SO', () => {
  test('the SO->DO conversion seeds both date fields from the DO date (today), not the SO', () => {
    // The insert built from the SO header (`head`).
    expect(routeSrc).toMatch(/expected_delivery_at: today,/);
    expect(routeSrc).toMatch(/customer_delivery_date: today,/);
    // The reverted default must be gone.
    expect(routeSrc).not.toMatch(/expected_delivery_at: \(head\.customer_delivery_date/);
    expect(routeSrc).not.toMatch(/customer_delivery_date: \(head\.customer_delivery_date/);
  });

  test('the migrated-DO backfill carries both date fields from d.do_date', () => {
    expect(carrySrc).toContain("['customer_delivery_date', 'd.do_date']");
    expect(carrySrc).toContain("['expected_delivery_at', 'd.do_date']");
    // The SO customer date is no longer a delivery-date SOURCE (the other
    // DO_SALES_CARRY fields still come from `s.`, so we assert on the date rows).
    expect(carrySrc).not.toContain("['customer_delivery_date', 's.customer_delivery_date']");
    expect(carrySrc).not.toContain("COALESCE(s.customer_delivery_date, d.do_date)");
  });
});
