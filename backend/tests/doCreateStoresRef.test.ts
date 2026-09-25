import { describe, expect, test } from 'vitest';
import routeRaw from '../src/scm/routes/delivery-orders-mfg.ts?raw';

// The Create-DO form sends the SO reference as `customerSoNo` only, so every
// form-made DO stored an empty `ref` (230 / 474 on 2026-09-25) and needed a
// backfill (scripts/backfill-do-si-ref.mjs). The create route now stores it in
// `ref` too, which is the column the SI copy and the book's Ref read first.
describe('POST /delivery-orders stores the reference in ref', () => {
  test('ref falls back to the form field customerSoNo', () => {
    expect(routeRaw).toContain('ref: (body.ref as string) || (body.customerSoNo as string) || null,');
  });
});
