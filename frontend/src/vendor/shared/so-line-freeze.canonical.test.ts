import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SO_LINE_FROZEN_REFUSAL, soDownstreamHardLocked, soItemFrozen } from './so-line-freeze';
import { SO_IDENTITY_LOCK_COLS } from './so-identity-lock';

/* The Sales Order per-line freeze (owner ruling 2026-09-15) and the header
 * identity lock each have ONE rule and two copies: the backend copy is what the
 * SO line routes and the header PATCH refuse on, this copy is what the desktop
 * editor and the phone editor grey out. If they drift, a screen offers a line or
 * a field the server refuses (a refusal after typing), or greys out one the
 * server would take. Same shape as do-header-lock.canonical.test.ts. */
describe('the two copies of the SO freeze rules are the same files', () => {
  const norm = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

  test('backend/src/scm/shared/so-line-freeze.ts is byte-identical to this one', () => {
    expect(norm('../backend/src/scm/shared/so-line-freeze.ts')).toBe(norm('src/vendor/shared/so-line-freeze.ts'));
  });

  test('backend/src/scm/shared/so-identity-lock.ts is byte-identical to this one', () => {
    expect(norm('../backend/src/scm/shared/so-identity-lock.ts')).toBe(norm('src/vendor/shared/so-identity-lock.ts'));
  });

  test('this pin is not vacuous — both pairs are real and carry the rule', () => {
    for (const p of ['src/vendor/shared/so-line-freeze.ts', '../backend/src/scm/shared/so-line-freeze.ts']) {
      const t = norm(p);
      expect(t.length).toBeGreaterThan(1000);
      expect(t).toContain('soLineFreezeFrom');
      expect(t).toContain('soDownstreamHardLocked');
    }
    expect(SO_LINE_FROZEN_REFUSAL.error).toBe('so_line_frozen');
    expect(soItemFrozen({ downstream_frozen: true })).toBe(true);
    expect(soDownstreamHardLocked({ has_children: true, downstream_fully_frozen: false })).toBe(false);
    expect(SO_IDENTITY_LOCK_COLS.has('address1')).toBe(true);
    expect(SO_IDENTITY_LOCK_COLS.has('customer_delivery_date')).toBe(false);
  });
});
