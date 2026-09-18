/* wrapAtCommas — the letterhead's address wrap (owner 2026-09-04: 地址整齐
 * 一点, 你看 no 和 2 分两行 — splitTextToSize had cut "No. 2," into
 * "No." / "2,"). The contract worth pinning:
 *   1. a break lands ONLY after a comma — every non-final output line ends
 *      with one, and a chunk like "No. 2," never splits;
 *   2. chunks pack greedily (no premature breaks);
 *   3. a single chunk wider than the measure comes back WHOLE — the caller
 *      word-wraps it as the lesser evil, this function never invents a
 *      mid-chunk break itself.
 * `measure` here is character count, which stands in for text width exactly
 * (monotonic in length for a fixed font). */

import { describe, expect, test } from 'vitest';
import { wrapAtCommas } from './pdf-common';

const byLength = (s: string) => s.length;

const LINE = 'E-28-02 & E-28-03, Menara SUEZCAP 2, KL Gateway, No. 2,';

describe('wrapAtCommas', () => {
  test('breaks only after commas — "No. 2," survives whole on the owner\'s own address', () => {
    /* Width forces several lines; every line must end on a comma boundary
       and no line may end mid-chunk (the "No." failure). */
    const lines = wrapAtCommas(LINE, 22, byLength);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines.slice(0, -1)) expect(l.endsWith(',')).toBe(true);
    expect(lines.some((l) => l.endsWith('No.'))).toBe(false);
    expect(lines.join(' ')).toBe(LINE);
    expect(lines.some((l) => l.includes('No. 2,'))).toBe(true);
  });

  test('packs greedily — a width that fits everything yields one line', () => {
    expect(wrapAtCommas(LINE, 999, byLength)).toEqual([LINE]);
  });

  test('a chunk wider than the measure comes back whole for the caller to word-wrap', () => {
    const lines = wrapAtCommas('Gerbang Kerinchi Lestari, 59200 Kuala Lumpur', 10, byLength);
    expect(lines).toEqual(['Gerbang Kerinchi Lestari,', '59200 Kuala Lumpur']);
  });

  test('a line with no comma is returned as-is', () => {
    expect(wrapAtCommas('Wilayah Persekutuan KL', 10, byLength)).toEqual(['Wilayah Persekutuan KL']);
  });
});
