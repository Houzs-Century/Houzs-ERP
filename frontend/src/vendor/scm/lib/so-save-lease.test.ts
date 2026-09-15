// HC-SO-2609-071: a save that reported success left the order's lease behind,
// and the owner's next Save met their own lock for a minute.
// docs/bugs/0936-a-save-that-reported-success-left-the-order-s-lock-behind-so.md
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { soSaveEndFields, soVersionAfter } from './so-save-lease';

describe('soSaveEndFields — a save that took a lease always says it is done', () => {
  test('with a lease: the token AND the end flag, whatever else the header carries', () => {
    expect(soSaveEndFields('lease-token-0123456789')).toEqual({
      lineWriteLeaseToken: 'lease-token-0123456789',
      completeLineWrites: true,
    });
  });

  test('without a lease: nothing — a header-only save is not a lease step', () => {
    expect(soSaveEndFields(null)).toEqual({});
  });
});

describe('soVersionAfter — never adopts a version the server did not name', () => {
  test('a named version wins', () => {
    expect(soVersionAfter({ ok: true, version: 16 }, 15)).toBe(16);
  });

  test('"nothing changed" without a version keeps the one the screen had', () => {
    expect(soVersionAfter({ ok: true, changed: 0 }, 15)).toBe(15);
    expect(soVersionAfter(undefined, 15)).toBe(15);
    expect(soVersionAfter({ version: 'x' }, 15)).toBe(15);
    expect(soVersionAfter({ version: 0 }, 15)).toBe(15);
  });
});

/* Both screens end a save through this module. The bug was the SAME conditional
   written twice — `completeLineWrites` only when the diff is empty, and
   `version` adopted as-is — so a copy creeping back into either file is the
   regression. */
describe('the desktop editor and the phone both end a save here', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const surfaces = {
    desktop: read('../../../pages/scm-v2/SalesOrderDetail.tsx'),
    phone: read('../../../mobile/MobileNewSO.tsx'),
  };

  for (const [name, src] of Object.entries(surfaces)) {
    test(`${name}: the end-of-save fields come from soSaveEndFields`, () => {
      expect(src).toContain('soSaveEndFields(');
      expect(src).not.toMatch(/\?\s*\{\s*completeLineWrites:\s*true\s*\}\s*:\s*\{\}/);
    });

    test(`${name}: no header answer's version is adopted unchecked`, () => {
      expect(src).not.toMatch(/loadedVersionRef\.current\s*=\s*(?:result|headerResult|reserved)\.version/);
    });
  }
});
