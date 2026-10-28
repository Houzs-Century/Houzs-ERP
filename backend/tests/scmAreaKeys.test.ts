// The write-freeze value parser, pinned.
//
// WHY IT IS WORTH A FILE. `validateFreezeValue` decides who can SAVE. Get the
// company scope wrong and a freeze meant for one company stops both, or a
// freeze meant for everyone silently applies to nobody. The module had no test.
//
// It is also the third copy problem in miniature: the module reads
// src/scm/index.ts at run time precisely so a hardcoded area list cannot drift
// from the routers. That property — reads the real file, rejects a typo'd area
// rather than shrugging — is what these tests hold.
//
// Vitest and not node:test: coverage-ratchet counts a scripts/lib file as
// tested only when it is EXECUTED during the vitest coverage run.
import { describe, expect, test } from 'vitest';

import {
  readScmAreaKeys,
  validateFreezeValue,
  describeFreezeValue,
} from '../scripts/lib/scm-area-keys.mjs';

/* A fixed set, so these assertions do not move when a router is added. The
   "reads the REAL index.ts" property is asserted separately, below. */
const AREAS = new Set(['scm.procurement.po', 'scm.sales.so', 'scm.inventory']);

describe('readScmAreaKeys', () => {
  test('reads the real src/scm/index.ts and finds mounted areas', () => {
    const keys = readScmAreaKeys();
    expect(keys.size).toBeGreaterThan(0);
    for (const k of keys) expect(k.startsWith('scm.')).toBe(true);
  });
});

describe('validateFreezeValue', () => {
  test('the off spellings all mean off, and are ok', () => {
    for (const raw of ['', 'off', '0', 'false', '  OFF  ', null, undefined]) {
      const r = validateFreezeValue(raw, AREAS);
      expect(r.ok, `${JSON.stringify(raw)} should be ok`).toBe(true);
      expect(r.scope).toBe('off');
      expect(r.open).toEqual([]);
    }
  });

  test('all / true freeze every company', () => {
    for (const raw of ['all', 'true', 'ALL']) {
      const r = validateFreezeValue(raw, AREAS);
      expect(r.ok).toBe(true);
      expect(r.scope).toBe('all');
    }
  });

  test('a company-id list is parsed, de-duplicated and numeric', () => {
    const r = validateFreezeValue('1,2,2, 3', AREAS);
    expect(r.ok).toBe(true);
    expect(r.scope).toEqual([1, 2, 3]);
  });

  /* THE ONE THAT MATTERS. A scope it cannot parse must not quietly become a
     narrower freeze — it falls back to `all` (fail-closed) AND reports a
     problem, so the typo is rejected at the door rather than silently freezing
     the wrong set of companies. */
  test('an unparseable scope fails CLOSED to all, and says so', () => {
    const r = validateFreezeValue('acme', AREAS);
    expect(r.scope).toBe('all');
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/not 'all' or a comma-separated list/);
  });

  test('a mixed list is not half-accepted', () => {
    const r = validateFreezeValue('1,acme', AREAS);
    expect(r.ok).toBe(false);
    expect(r.scope).toBe('all');
  });

  test('exception areas are accepted with or without the scm. prefix, and de-duplicated', () => {
    const r = validateFreezeValue('all-sales.so,scm.sales.so', AREAS);
    expect(r.ok).toBe(true);
    expect(r.open).toEqual(['scm.sales.so']);
  });

  test('an area that does not exist is REJECTED, with a did-you-mean', () => {
    const r = validateFreezeValue('all-sales.sooo', AREAS);
    expect(r.ok).toBe(false);
    const msg = r.problems.join(' ');
    expect(msg).toMatch(/does not exist/);
    expect(msg).toMatch(/nearest keys/);
    // The suggestion must name real areas, never the typo back at you.
    expect(msg).toMatch(/scm\./);
  });

  test('a valid company list plus a valid exception parses both halves', () => {
    const r = validateFreezeValue('2-inventory', AREAS);
    expect(r.ok).toBe(true);
    expect(r.scope).toEqual([2]);
    expect(r.open).toEqual(['scm.inventory']);
  });
});

describe('describeFreezeValue', () => {
  test('describes each shape in words an operator can check', () => {
    expect(describeFreezeValue({ scope: 'off', open: [] })).toMatch(/OPEN for every company/);
    expect(describeFreezeValue({ scope: 'all', open: [] })).toMatch(/FROZEN for EVERY company, every area/);
    expect(describeFreezeValue({ scope: [2], open: [] })).toMatch(/company 2 only/);
    const withOpen = describeFreezeValue({ scope: 'all', open: ['scm.inventory'] });
    expect(withOpen).toMatch(/EXCEPT scm\.inventory/);
    expect(withOpen).toMatch(/which can save/);
  });
});
