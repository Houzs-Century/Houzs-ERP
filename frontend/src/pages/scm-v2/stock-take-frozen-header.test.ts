/* The Count Sheet header row is pinned while the page scrolls. At top: 0 it sat
   under the pinned app bar and page title bar, so it was never seen. It must
   park where those end (--page-header-offset, published by Layout.tsx). */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('Stock Take count sheet frozen header', () => {
  test('parks under the pinned page header, not at the top of the scroll area', () => {
    const css = readFileSync('src/pages/scm-v2/SalesOrderDetail.module.css', 'utf8');
    const rule = /\.stickyHead thead th\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('position: sticky');
    expect(rule).toMatch(/top:\s*var\(--page-header-offset/);
  });
});
