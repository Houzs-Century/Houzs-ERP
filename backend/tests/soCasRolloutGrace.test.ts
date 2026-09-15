import { describe, expect, test } from 'vitest';
import { soRouterSource } from './lib/so-router-source';
import { soCasGraceOpen, soCasGrace, paymentVersionGuard } from '../src/scm/routes/mfg-sales-orders';
const routeSource = soRouterSource();

/* REGRESSION — mandatory CAS must not 428 every already-open tab the instant it
   deploys (defect 5, 2026-07-22).

   Every browser tab loaded before this ships runs the previous JS bundle and
   never sends `version`. Without a grace path the first Save after deploy is a
   428 for every person mid-edit at the same moment, with no recovery they have
   been told about. The window is opt-in (`SO_CAS_GRACE_UNTIL`), bounded, and
   self-closing; a STALE version is still a 409 inside it. */

const future = new Date(Date.now() + 30 * 60_000).toISOString();
const past = new Date(Date.now() - 60_000).toISOString();

describe('SO CAS rollout grace window', () => {
  test('defaults to strict — no variable, no grace', () => {
    expect(soCasGraceOpen(undefined)).toBe(false);
    expect(soCasGraceOpen({})).toBe(false);
    expect(soCasGraceOpen({ until: null })).toBe(false);
    expect(soCasGraceOpen({ until: '' })).toBe(false);
  });

  test('is open only while the configured instant is still ahead', () => {
    expect(soCasGraceOpen({ until: future })).toBe(true);
    expect(soCasGraceOpen({ until: past })).toBe(false);
  });

  test('closes itself — the same configuration is strict once the instant passes', () => {
    const until = '2026-07-22T12:00:00.000Z';
    expect(soCasGraceOpen({ until, now: Date.parse('2026-07-22T11:59:59.000Z') })).toBe(true);
    expect(soCasGraceOpen({ until, now: Date.parse('2026-07-22T12:00:00.000Z') })).toBe(false);
    expect(soCasGraceOpen({ until, now: Date.parse('2026-07-22T12:00:01.000Z') })).toBe(false);
  });

  test('an unparseable value is treated as strict, never as an open window', () => {
    expect(soCasGraceOpen({ until: 'soon' })).toBe(false);
    expect(soCasGraceOpen({ until: 'never' })).toBe(false);
  });

  test('reads the window off the Worker env and nowhere else', () => {
    expect(soCasGrace({ env: { SO_CAS_GRACE_UNTIL: future } })).toEqual({ until: future });
    expect(soCasGrace({ env: {} })).toEqual({ until: null });
    expect(soCasGrace({})).toEqual({ until: null });
  });

  test('payment mutations accept a version-less pre-CAS client inside the window', () => {
    expect(paymentVersionGuard(undefined, 4)).toMatchObject({ ok: false, status: 428 });
    expect(paymentVersionGuard(undefined, 4, { until: past })).toMatchObject({ ok: false, status: 428 });
    expect(paymentVersionGuard(undefined, 4, { until: future })).toEqual({ ok: true, version: 4, grace: true });
  });

  test('the window never forgives a STALE version — only a missing one', () => {
    expect(paymentVersionGuard(3, 4, { until: future })).toEqual({
      ok: false,
      status: 409,
      body: { error: 'payment_version_conflict', currentVersion: 4 },
    });
    expect(paymentVersionGuard(4, 4, { until: future })).toEqual({ ok: true, version: 4 });
  });

  test('every SO version gate consults the window rather than 428ing outright', () => {
    // Header PATCH, status PATCH and draft DELETE each guard their 428 on the
    // window; a future edit that adds a fourth gate without it is caught here.
    const required = routeSource.split('...SO_VERSION_REQUIRED, currentVersion }, 428').length - 1;
    expect(required).toBe(3);
    const guarded = routeSource.split('&& !soCasGraceOpen(soCasGrace(c))').length - 1;
    expect(guarded).toBe(3);
  });
});
