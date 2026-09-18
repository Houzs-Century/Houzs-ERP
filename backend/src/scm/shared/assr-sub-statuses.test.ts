/* docs/bugs/0890 — the service-case save kept its own list of allowed
   sub-statuses, and that copy never learned Pending Customer Pickup (added for
   the Pickup / Return stage on 2026-09-01). The screens offered it and the
   stage entry seeded it, so the save refused a value the system itself chose.
   These pin what the one list answers; backend/tests/assrSubStatusOneHome.test.ts
   pins that the server's files read it instead of keeping copies. */

import { describe, expect, test } from 'vitest';
import {
  ASSR_SUB_STATUSES,
  ASSR_SUB_STATUS_KEYS,
  assrSubStatusLabelOf,
  assrSubStatusSeed,
} from './assr-sub-statuses';

const offered = Object.values(ASSR_SUB_STATUSES).flat().map((o) => o.key);

describe('the one service-case sub-status list', () => {
  test('a save accepts each sub-status a screen offers, the customer-pickup leg included', () => {
    expect(offered).toContain('pending_customer_pickup');
    for (const key of offered) expect(ASSR_SUB_STATUS_KEYS.has(key), key).toBe(true);
    expect(ASSR_SUB_STATUS_KEYS.size).toBe(offered.length);
  });

  test('a value no screen offers is still refused', () => {
    expect(ASSR_SUB_STATUS_KEYS.has('pending_item_pickup')).toBe(false);
    expect(ASSR_SUB_STATUS_KEYS.has('pending_review')).toBe(false);
    expect(ASSR_SUB_STATUS_KEYS.has('')).toBe(false);
  });

  test('entering a stage seeds its first leg, and a stage without legs seeds nothing', () => {
    expect(assrSubStatusSeed('pending_supplier_pickup')).toBe('pending_customer_pickup');
    expect(assrSubStatusSeed('under_verification')).toBe('pending_inspection');
    expect(assrSubStatusSeed('pending_review')).toBeNull();
    expect(assrSubStatusSeed(null)).toBeNull();
  });

  test('the label a screen shows, and null for anything that is not a sub-status', () => {
    expect(assrSubStatusLabelOf('pending_customer_pickup')).toBe('Pending Customer Pickup');
    expect(assrSubStatusLabelOf('pending_supplier_return')).toBe('Pending Supplier Return');
    expect(assrSubStatusLabelOf('pending_review')).toBeNull();
    expect(assrSubStatusLabelOf(undefined)).toBeNull();
  });
});
