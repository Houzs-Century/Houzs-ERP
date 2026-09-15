import { describe, expect, test } from 'vitest';
import { soRouterSource } from './lib/so-router-source';
const routeSource = soRouterSource();

/* REGRESSION — a permission refusal must never be reported as a concurrency
   conflict (defect 4, 2026-07-22).

   Making the edit lease mandatory put `requireSoLineWriteLease` at the TOP of
   every SO line-mutation handler, ahead of that handler's authorization gate.
   A caller who is not allowed to touch the order at all therefore received
   409 `so_edit_lease_conflict` — "This order is being saved on another screen.
   Your changes are still here. Wait a moment, then try Save again." That
   sentence is an instruction to RETRY, so the operator retries forever, and the
   true reason (no permission / not your order / admin-only price override)
   never reaches them or the logs.

   The rule this test pins: within a handler, the AUTHORIZATION decision comes
   first and the CONCURRENCY decision second. Authorization does not depend on
   who currently holds the lease, so ordering it first costs nothing and is the
   only ordering that can report the real reason. */

type Guarded = { anchor: string; authz: string };

const guarded: Guarded[] = [
  // Route handlers.
  { anchor: "post('/:docNo/items/:itemId/override'", authz: 'isPriceOverrideCaller(c)' },
  { anchor: "post('/:docNo/items'", authz: 'selfScopedSalesBlocked(c, docNo)' },
  { anchor: "patch('/:docNo/items/:itemId'", authz: 'selfScopedSalesBlocked(c, docNo)' },
  { anchor: "delete('/:docNo/items/:itemId'", authz: 'selfScopedSalesBlocked(c, docNo)' },
  { anchor: "post('/:docNo/items/:itemId/photos'", authz: 'selfScopedSalesBlocked(c, docNo)' },
  { anchor: "delete('/:docNo/items/:itemId/photos/:photoKey'", authz: 'selfScopedSalesBlocked(c, docNo)' },
  { anchor: "patch('/:docNo/items/:itemId/stock-status'", authz: 'selfScopedSalesBlocked(c, docNo)' },
];

const commandHandlers: Guarded[] = [
  { anchor: 'export async function tbcUpdateCommandHandler', authz: 'selfScopedSalesBlocked(c, docNo)' },
  { anchor: 'export async function tbcSwapCommandHandler', authz: 'selfScopedSalesBlocked(c, docNo)' },
  { anchor: 'export async function tbcSwapSofaCommandHandler', authz: 'selfScopedSalesBlocked(c, docNo)' },
];

function blockFor(anchor: string, prefix: string): string {
  const start = routeSource.indexOf(`${prefix}${anchor}`);
  expect(start, `handler not found: ${anchor}`).toBeGreaterThanOrEqual(0);
  const candidates = [
    routeSource.indexOf('\nmfgSalesOrders.', start + 20),
    routeSource.indexOf('\nexport async function ', start + 20),
  ].filter((index) => index > 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : routeSource.length;
  return routeSource.slice(start, end);
}

function assertAuthzFirst(block: string, anchor: string, authz: string): void {
  const authzAt = block.indexOf(authz);
  const leaseAt = block.indexOf('requireSoLineWriteLease(sb, docNo, c)');
  expect(authzAt, `${anchor}: authorization gate ${authz} missing`).toBeGreaterThan(0);
  expect(leaseAt, `${anchor}: lease guard missing`).toBeGreaterThan(0);
  expect(
    authzAt,
    `${anchor}: the lease guard runs before ${authz}, so a permission refusal is reported as 409 so_edit_lease_conflict`,
  ).toBeLessThan(leaseAt);
}

describe('SO line mutations decide authorization before concurrency', () => {
  for (const { anchor, authz } of guarded) {
    test(`${anchor} refuses on permission before it refuses on the lease`, () => {
      assertAuthzFirst(blockFor(anchor, 'mfgSalesOrders.'), anchor, authz);
    });
  }

  for (const { anchor, authz } of commandHandlers) {
    test(`${anchor} refuses on permission before it refuses on the lease`, () => {
      assertAuthzFirst(blockFor(anchor, ''), anchor, authz);
    });
  }

  test('a committed header save is never reported back as a version conflict', () => {
    /* The header CAS commits, then the route releases its edit lease. A 0-row
       release used to return soVersionConflict — telling the operator that
       "someone else updated this order" about a save that had ALREADY
       succeeded, and inviting them to send it again. */
    const marker = routeSource.indexOf('header saved but edit lease was no longer ours to release');
    expect(marker).toBeGreaterThan(0);
    const release = routeSource.indexOf('const { data: releasedLease, error: releaseLeaseError }');
    expect(release).toBeGreaterThan(0);
    const block = routeSource.slice(release, marker + 400);
    expect(block).not.toContain('soVersionConflict(savedVersion)');
  });
});
