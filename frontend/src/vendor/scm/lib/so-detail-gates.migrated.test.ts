/* THE HALF-APPLIED GATE IS THE BUG CLASS THIS FILE EXISTS FOR.
 *
 * A rule enforced on the desktop and not on mobile (or on the read page and not
 * in the editor) is the recurring defect in this repo — BUG-HISTORY records
 * #600 / #625 / #632 as the same shape three times. The migrated-order lock
 * (owner 2026-09-08, 「只开新单，旧单暂时不能改」) has FOUR surfaces plus a row
 * menu, so it is exactly the shape that has shipped half-applied before.
 *
 * Two kinds of assertion here:
 *   1. BEHAVIOURAL — the pure predicate does what the server's copy does.
 *   2. STRUCTURAL — every surface actually consults it. A behavioural test on a
 *      shared function proves nothing about a screen that never calls it, and
 *      that is precisely how the twin gets missed.
 */
import { describe, expect, test } from 'vitest';
import {
  migratedReadonly,
  migratedReadonlyReason,
  MIGRATED_READONLY_FALLBACK,
  isLocked,
} from './so-detail-gates';

import rawDetailV2 from '../../../pages/scm-v2/SalesOrderDetailV2.tsx?raw';
import rawDetailEditor from '../../../pages/scm-v2/SalesOrderDetail.tsx?raw';
import rawMobileDetail from '../../../mobile/MobileSODetail.tsx?raw';
import rawMobileNewSo from '../../../mobile/MobileNewSO.tsx?raw';
import rawRowMenus from '../../../pages/scm-v2/row-menus.ts?raw';
import rawAuthedFetch from './authed-fetch.ts?raw';

describe('migratedReadonly', () => {
  test('true only when the SERVER said so', () => {
    expect(migratedReadonly({ migrated_readonly: true })).toBe(true);
    expect(migratedReadonly({ migrated_readonly: false })).toBe(false);
  });

  /* A payload from before this shipped, or a cached one, must read as the OLD
     behaviour — not as a lock nobody can explain. */
  test('absent / null / undefined header reads as NOT locked', () => {
    expect(migratedReadonly({})).toBe(false);
    expect(migratedReadonly({ migrated_readonly: null })).toBe(false);
    expect(migratedReadonly(null)).toBe(false);
    expect(migratedReadonly(undefined)).toBe(false);
  });

  /* The browser must never try to decide this for itself: the answer depends on
     an app_config switch and on the caller's bypass, neither of which it can
     see. Anything other than a literal `true` is not a lock. */
  test('a truthy non-true value is not a lock', () => {
    expect(migratedReadonly({ migrated_readonly: 1 as unknown as boolean })).toBe(false);
  });
});

describe('migratedReadonlyReason', () => {
  test('the server sentence wins', () => {
    expect(migratedReadonlyReason({ migrated_readonly: true, migrated_readonly_reason: 'Ask Nick.' }))
      .toBe('Ask Nick.');
  });

  test('never empty — a gate with no sentence is "the button does nothing"', () => {
    expect(migratedReadonlyReason({ migrated_readonly: true })).toBe(MIGRATED_READONLY_FALLBACK);
    expect(migratedReadonlyReason({ migrated_readonly: true, migrated_readonly_reason: '  ' }))
      .toBe(MIGRATED_READONLY_FALLBACK);
    expect(migratedReadonlyReason(null)).toBe(MIGRATED_READONLY_FALLBACK);
  });
});

describe('it is NOT part of isLocked', () => {
  /* The desktop editor's Override button feeds `unlockOverride` into isLocked.
     A salesperson may override OUR paperwork lock; they may not override this
     one, because the reasons are sync-ac-delta and unreconciled AutoCount
     payments and no amount of local certainty settles either. Keeping the term
     out of isLocked is what makes Override unable to reach it — so this test
     pins the SEPARATION, not the combination. */
  test('isLocked knows nothing about migrated', () => {
    expect(isLocked('CONFIRMED', false, false)).toBe(false);
    expect(isLocked('CONFIRMED', false, true)).toBe(false);
  });
});

describe('every SO write surface consults the gate', () => {
  const surfaces: ReadonlyArray<readonly [string, string]> = [
    ['SalesOrderDetailV2 (desktop read page)', rawDetailV2],
    ['SalesOrderDetail (desktop editor)', rawDetailEditor],
    ['MobileSODetail (mobile read page)', rawMobileDetail],
    ['MobileNewSO (mobile editor)', rawMobileNewSo],
  ];

  test.each(surfaces)('%s imports the shared predicate', (_name, src) => {
    expect(src).toContain('migratedReadonly as soMigratedReadonly');
  });

  test.each(surfaces)('%s actually uses it in a gate', (_name, src) => {
    expect(src).toMatch(/migratedLocked/);
  });

  test.each(surfaces)('%s shows the reason, not just a disabled control', (_name, src) => {
    expect(src).toMatch(/soMigratedReadonlyReason|migratedReason/);
  });

  /* The list is the fifth surface and the one with no detail payload to read —
     it gets the flag stamped per row by the list handler instead. */
  test('the SO row menu drops its write entries on a migrated row', () => {
    expect(rawRowMenus).toContain('r.migrated_readonly === true');
  });

  /* Curated so the refusal never falls through to the 409 catch-all ("refresh
     and check"), which on a migrated order is advice that loops. */
  test('the refusal code has a curated operator sentence', () => {
    expect(rawAuthedFetch).toContain('so_migrated_readonly:');
  });
});
