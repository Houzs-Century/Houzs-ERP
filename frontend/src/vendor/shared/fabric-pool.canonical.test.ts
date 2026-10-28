import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { fabricAllowedByPool } from './fabric-pool';

/* THE PAIR, REFEREED — same shape as so-deliverable-states.canonical.test.ts.
 *
 * This rule exists in one place so that the save gate, the desktop colour
 * combobox and the phone fabric sheet cannot give three answers to one question
 * (docs/bugs/0889). A browser copy that drifted from the server's would be that
 * defect again, one layer down. */
describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/shared/fabric-pool.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/shared/fabric-pool.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/fabric-pool.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    const a = norm(there);
    const b = norm(here);
    expect(a.length).toBeGreaterThan(500);
    expect(a).toBe(b);
  });

  test('the copy answers the gate\'s question, not a stub', () => {
    expect(fabricAllowedByPool(['BO315'], 'BO315-23', 'BO315')).toBe(true);
    expect(fabricAllowedByPool(['BO315'], 'GD2502-11', 'GD2502')).toBe(false);
    expect(fabricAllowedByPool([], 'GD2502-11', 'GD2502')).toBe(true);
  });
});
