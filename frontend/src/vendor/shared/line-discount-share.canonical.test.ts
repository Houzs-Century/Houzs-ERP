import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { lineDiscountShare } from './line-discount-share';

/* The partial-delivery discount split has ONE rule and two copies: the server
 * writes it onto DO / invoice lines, and the pickers show it in Line Value and
 * hand it to the New DO / New Invoice form. If they drift, the screen shows one
 * total and the saved document holds another. */
describe('the two copies of line-discount-share are the same file', () => {
  const norm = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

  test('backend/src/scm/shared/line-discount-share.ts is byte-identical to this one', () => {
    const here = norm('src/vendor/shared/line-discount-share.ts');
    expect(here).toContain('export function lineDiscountShare');
    expect(norm('../backend/src/scm/shared/line-discount-share.ts')).toBe(here);
  });

  test('2 of 4 units carry half the line discount', () => {
    expect(lineDiscountShare(10000, 4, 0, 2)).toBe(5000);
    expect(lineDiscountShare(10000, 4, 2, 2)).toBe(5000);
  });
});
