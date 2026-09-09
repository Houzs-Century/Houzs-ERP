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
import { humanApiError } from './authed-fetch';

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

  /* A gate with no sentence is how this repo produced "the button does nothing".
     Each surface either renders the shared banner component or interpolates the
     server's reason into a lock banner of its own. */
  test.each(surfaces)('%s shows the reason, not just a disabled control', (_name, src) => {
    expect(src).toMatch(/MigratedReadonlyBanner|soMigratedReadonlyReason|soMigratedReason/);
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

  /* ...AND THE CURATED ONE MUST STEP ASIDE FOR A PER-DOCUMENT SENTENCE.
     Since the lock was re-grained onto correctness (2026-09-08) the answer is
     different per order: one still differs from the account book on `document
     total`, its neighbour matches and is open. The curated line — written for
     the whole class — would have overwritten that with "view-only until its
     payments are reconciled", which by then is not even the reason, leaving the
     salesperson a shut order and nothing to act on. */
  test('a PER-DOCUMENT reason wins over the curated class sentence', () => {
    const said = humanApiError(409, JSON.stringify({
      error: 'so_migrated_readonly',
      reason: 'HC-SO-010789 still differs from the AutoCount book on: document total. '
        + 'It opens by itself once that is corrected. Ask IT if it must change today.',
      message: 'HC-SO-010789 still differs from the AutoCount book on: document total. '
        + 'It opens by itself once that is corrected. Ask IT if it must change today.',
      docNo: 'HC-SO-010789',
    }));
    expect(said).toContain('HC-SO-010789');
    expect(said).toContain('document total');
  });

  /* ...without ever rendering WORSE than before. A server that sends nothing
     sayable still gets the curated sentence, never the 409 catch-all. */
  test('the curated sentence is still the fallback when the server says nothing', () => {
    const said = humanApiError(409, JSON.stringify({ error: 'so_migrated_readonly' }));
    expect(said).toContain('AutoCount');
    expect(said).not.toMatch(/refresh and check/i);
  });

  /* FOUND IN THE BROWSER, NOT BY A TEST (2026-09-08). The first cut gated Edit
     and the payments CARD on the desktop read page and left the two buttons in
     the header bar — "Cancel SO" and "Collect payment" — live on a migrated
     order. Both are writes the API refuses, so the operator got a toast instead
     of a greyed control, which is the thing this whole change exists to avoid.
     Pinned here because the header bar is a different place from the gates the
     tests above cover, and nothing pointed at it. */
  test('the desktop read page gates the header bar, not only Edit', () => {
    expect(rawDetailV2).toContain('{!migratedLocked && !["cancelled", "draft"].includes(');
    const cancelBtn = rawDetailV2.slice(rawDetailV2.indexOf('onClick={doCancel}'));
    expect(cancelBtn.slice(0, 200)).toContain('disabled={migratedLocked}');
  });
});
