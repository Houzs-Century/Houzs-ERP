/* The Count Sheet scrolls in its own box (useFrozenTableHeader pins it under
   the page header). Inside it the header row sticks to the top and the first
   column (SKU by default) to the left, so both stay on screen when the sheet
   scrolls down or sideways (Sim, 2026-11-23). */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync('src/pages/scm-v2/SalesOrderDetail.module.css', 'utf8');
/* Every declaration aimed at `selector`, across all blocks that list it. */
const rule = (selector: string): string => css.split('}')
  .map((block) => block.split('{'))
  .filter(([selectors]) => selectors.split(',').some((part) => part.trim().endsWith(selector)))
  .map(([, body = '']) => body)
  .join(';');

describe('Stock Take count sheet freeze', () => {
  test('the sheet box scrolls both ways', () => {
    expect(rule('.sheetScroll')).toMatch(/overflow:\s*auto/);
  });

  test('the header row sticks to the top of the sheet box', () => {
    const head = rule('.stickyHead thead th');
    expect(head).toContain('position: sticky');
    expect(head).toMatch(/top:\s*0/);
  });

  test('the first column sticks to the left, its header cell above both', () => {
    const first = rule('.freezeFirstCol tbody td:first-child');
    expect(first).toContain('position: sticky');
    expect(first).toMatch(/left:\s*0/);
    expect(Number(/z-index:\s*(\d+)/.exec(rule('.freezeFirstCol thead th:first-child'))?.[1]))
      .toBeGreaterThan(Number(/z-index:\s*(\d+)/.exec(rule('.stickyHead thead th'))?.[1]));
  });
});
