import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { DO_HEADER_LOCK_COLS, DO_HEADER_OPEN_COLS } from './do-header-lock';

/* The Delivery Order header lock (owner ruling 2026-09-14) has ONE rule and two
 * copies: backend/src/scm/shared/do-header-lock.ts is what the server's
 * PATCH /delivery-orders-mfg/:id refuses on, and this one is what the desktop edit
 * form and the phone's edit sheet DISABLE. If they drift, a screen offers a field
 * the server refuses (a refusal after typing) or greys out a field the server
 * would take. Same shape as do-shipped-states.canonical.test.ts. */
describe('the two copies of do-header-lock are the same file', () => {
  const norm = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

  test('backend/src/scm/shared/do-header-lock.ts is byte-identical to this one', () => {
    expect(norm('../backend/src/scm/shared/do-header-lock.ts')).toBe(norm('src/vendor/shared/do-header-lock.ts'));
  });

  test('this pin is not vacuous — both files are real and carry the rule', () => {
    for (const p of ['src/vendor/shared/do-header-lock.ts', '../backend/src/scm/shared/do-header-lock.ts']) {
      const t = norm(p);
      expect(t.length).toBeGreaterThan(1000);
      expect(t).toContain('DO_HEADER_LOCKED_FIELDS');
      expect(t).toContain('DO_HEADER_OPEN_COLS');
    }
    expect(DO_HEADER_LOCK_COLS.size).toBeGreaterThan(15);
    expect(DO_HEADER_OPEN_COLS.has('driver_name')).toBe(true);
  });
});
