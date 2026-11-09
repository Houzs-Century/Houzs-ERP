/* "Delivered with issue": the problem kinds the crew can tick must be the ones
 * the server accepts — this file and the server's copy are the same bytes. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const norm = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

describe('one list of delivery problem kinds for the server and the screens', () => {
  test('backend/src/scm/shared/delivery-issue-kinds.ts is byte-identical to this one', () => {
    expect(norm('../backend/src/scm/shared/delivery-issue-kinds.ts')).toBe(norm('src/vendor/scm/lib/delivery-issue-kinds.ts'));
  });
});
