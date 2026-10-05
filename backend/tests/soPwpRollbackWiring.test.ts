import { describe, expect, test } from 'vitest';
import { soRouterSource } from './lib/so-router-source';

/* A rejected Sales Order must not burn a PWP voucher. SO create claims the
   vouchers first (claimedPwpCodes), so every error return after that point has
   to call rollbackPwpClaims() just before it returns. The 422
   delivery_date_needs_address return was the one that forgot: the order was
   refused but its voucher stayed claimed.

   Source-anchored, same style as soLocationGateWiring.test.ts: it fails if any
   return between the rollback helper and the items insert skips the rollback. */
const src = soRouterSource().replace(/\r\n/g, '\n');

describe('SO create rolls back PWP claims on every refusal', () => {
  test('each return after the claim calls rollbackPwpClaims() first', () => {
    const start = src.indexOf('const rollbackPwpClaims = async');
    const end = src.indexOf("error: 'items_insert_failed'", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const lines = src.slice(start, end).split('\n');
    const missing = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.includes('return c.json('))
      .filter(({ i }) => !lines.slice(Math.max(0, i - 6), i + 1).some((l) => l.includes('rollbackPwpClaims()')))
      .map(({ line }) => line.trim());

    expect(missing).toEqual([]);
  });
});
