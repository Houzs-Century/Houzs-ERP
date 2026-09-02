// ----------------------------------------------------------------------------
// "Configured" is not "firing", and a mirrored number is a fact with an expiry.
//
// Owner 2026-09-02, shown that /api/presence + /api/announcements/banner are
// ~90% of every slow request: 「B」 — build the check rather than guess.
//
// Two halves. The SENTENCE is derived from the numbers, so it cannot drift away
// from what was measured; the POLL INTERVALS are mirrored from the frontend, so
// they are pinned against its source. The second half is not hypothetical —
// configCache.ts still reasons "300s (5 polls)" from a 60s banner poll that has
// been 180s for some time, which is 1.67 polls.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  cacheFamilyReading, readingFor, CLIENT_POLL_SECONDS,
} from '../src/services/auth-fastpath-probe';
import { CONFIG_CACHE_TTL_SECONDS } from '../src/services/configCache';

const ok = (ttl: number, poll: number) => cacheFamilyReading(ttl, poll, 'hit');

describe('the sentence follows the numbers', () => {
  test('key OFF is the headline, ahead of any cache reading', () => {
    const r = readingFor(false, 'session-db', { presence: ok(15, 60) });
    expect(r).toContain('OFF');
    expect(r).not.toContain('fast path.');
  });

  /* THE CASE THE PROBE EXISTS FOR. 0593 shipped configured-and-inert, and
     nothing on any screen could tell the two apart. */
  test('ON but still hitting the database says exactly that', () => {
    const r = readingFor(true, 'session-db', { presence: ok(15, 60) });
    expect(r).toContain('configured and not being taken');
  });

  test('a structurally-short TTL is named, not left to arithmetic', () => {
    const r = readingFor(true, 'pass', {
      presence: cacheFamilyReading(15, 60, 'miss'),
      banner: cacheFamilyReading(300, 180, 'hit'),
    });
    expect(r).toContain('presence');
    expect(r).not.toContain('banner');
  });

  /* `unknown` must never collapse onto either answer — the same rule
     coverage-state.tsx applies on the frontend. */
  test('an unrecorded path refuses to answer', () => {
    const r = readingFor(true, 'unknown', { presence: ok(300, 60) });
    expect(r).toContain('cannot say');
  });

  test('all clear says so without inventing a cause', () => {
    const r = readingFor(true, 'pass', { presence: ok(300, 60) });
    expect(r).toContain('not on this page');
  });
});

describe('a TTL at or below the poll is a structural miss', () => {
  test('EQUAL counts — that is the measured 874-984ms case, not a near miss', () => {
    expect(cacheFamilyReading(60, 60, 'miss').ttl_shorter_than_poll).toBe(true);
    expect(cacheFamilyReading(61, 60, 'hit').ttl_shorter_than_poll).toBe(false);
  });
});

describe('the mirrored poll intervals are pinned to the frontend source', () => {
  const read = (p: string) => readFileSync(p, 'utf8');

  test('presence — usePresence.ts HEARTBEAT_MS', () => {
    const src = read('../frontend/src/hooks/usePresence.ts');
    const m = /const HEARTBEAT_MS = ([0-9_]+);/.exec(src);
    expect(m, 'HEARTBEAT_MS moved or was renamed').not.toBeNull();
    expect(Number(m![1].replace(/_/g, '')) / 1000).toBe(CLIENT_POLL_SECONDS.presence);
  });

  test('banner — useAnnouncementBanner.ts POLL_MS', () => {
    const src = read('../frontend/src/components/useAnnouncementBanner.ts');
    const m = /const POLL_MS = ([0-9_]+);/.exec(src);
    expect(m, 'POLL_MS moved or was renamed').not.toBeNull();
    expect(Number(m![1].replace(/_/g, '')) / 1000).toBe(CLIENT_POLL_SECONDS.banner);
  });
});

describe('what the live TTLs actually are', () => {
  /* Not a style preference — presence keeps its copy for a QUARTER of the time
     the browser waits, so one user alone misses every single poll. Asserted so
     the day it is fixed, this test is what says so. */
  test('presence is structurally short today, and banner is not', () => {
    expect(CONFIG_CACHE_TTL_SECONDS.presence).toBeLessThanOrEqual(CLIENT_POLL_SECONDS.presence);
    expect(CONFIG_CACHE_TTL_SECONDS.banner).toBeGreaterThan(CLIENT_POLL_SECONDS.banner);
  });
});
