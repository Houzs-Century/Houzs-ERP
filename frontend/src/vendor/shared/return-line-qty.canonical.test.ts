import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseReturnLineQty } from './return-line-qty';

describe('the two copies of return-line-qty are the same file', () => {
  const norm = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

  test('backend/src/scm/shared/return-line-qty.ts is byte-identical to this one', () => {
    const here = norm('src/vendor/shared/return-line-qty.ts');
    expect(here).toContain('export function parseReturnLineQty');
    expect(norm('../backend/src/scm/shared/return-line-qty.ts')).toBe(here);
  });

  test('blank, 0 and negative are refused; a positive qty passes', () => {
    expect(parseReturnLineQty(undefined)).toBeNull();
    expect(parseReturnLineQty(0)).toBeNull();
    expect(parseReturnLineQty(-2)).toBeNull();
    expect(parseReturnLineQty(2)).toBe(2);
  });
});
