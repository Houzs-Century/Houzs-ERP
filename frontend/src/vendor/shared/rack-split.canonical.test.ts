import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { rackSplitError, rackSplitPostError } from './rack-split';

/* The referee for this vendored pair. The phone and desktop split editors
   refuse from this copy; the server refuses (and the post checks) from the
   other. Drift would let an editor offer a split the server rejects. */
describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/shared/rack-split.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/shared/rack-split.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/rack-split.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });

  test('this copy actually decides', () => {
    expect(rackSplitError(10, [{ rackId: 'A', qty: 11 }])).toBe('The racks hold 11 but only 10 were accepted.');
    expect(rackSplitPostError(10, [{ rackId: 'A', qty: 6 }])).toBe('The racks hold 6 of the 10 accepted.');
  });
});
