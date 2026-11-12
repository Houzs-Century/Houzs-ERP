import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { transportFeeRegion } from './so-transport-fee';

/* The transport-fee rule has ONE text and two copies: the server refuses on it
 * and the New SO forms show the Transport fee box from it. If they drift, the
 * box is missing where the server demands a fee. */
describe('the two copies of so-transport-fee are the same file', () => {
  const norm = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

  test('backend/src/scm/shared/so-transport-fee.ts is byte-identical to this one', () => {
    const here = norm('src/vendor/shared/so-transport-fee.ts');
    expect(here).toContain('export function transportFeeProblem');
    expect(norm('../backend/src/scm/shared/so-transport-fee.ts')).toBe(here);
  });

  test('Labuan and Singapore need a fee; Selangor does not', () => {
    expect(transportFeeRegion('Labuan', 'Malaysia')).toBe('Labuan');
    expect(transportFeeRegion('Central', 'Singapore')).toBe('Singapore');
    expect(transportFeeRegion('Selangor', 'Malaysia')).toBeNull();
  });
});
