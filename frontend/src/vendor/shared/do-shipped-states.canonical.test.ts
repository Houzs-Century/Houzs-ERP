import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { DO_SHIPPED_STATES, SI_TRANSFERABLE_DO_STATES } from './do-shipped-states';

describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/shared/do-shipped-states.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/shared/do-shipped-states.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/do-shipped-states.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });

  test('this pin is not vacuous — both files are real and carry both sets', () => {
    const norm = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
    for (const p of ['src/vendor/shared/do-shipped-states.ts', '../backend/src/scm/shared/do-shipped-states.ts']) {
      const t = norm(p);
      expect(t.length).toBeGreaterThan(500);
      expect(t).toContain('DO_SHIPPED_STATES');
      expect(t).toContain('SI_TRANSFERABLE_DO_STATES');
    }
    expect(DO_SHIPPED_STATES.length).toBeGreaterThan(0);
    expect(SI_TRANSFERABLE_DO_STATES.length).toBeGreaterThan(0);
  });
});
