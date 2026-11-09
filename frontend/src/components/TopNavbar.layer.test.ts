import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/* B34: the top bar and the DataTable's sticky header were both z-30 in the
   same stacking context. On a tie the later-painted element wins, so the
   table header covered the company / bell / profile dropdowns, which live
   inside the bar's stacking context and cannot out-stack it. The bar must sit
   strictly above every sticky layer a table paints. */
const src = (f: string) => readFileSync(join(__dirname, f), 'utf8');
const z = (cls: string) => {
  const m = /\bz-(?:(\d+)|\[(\d+)\])\b/.exec(cls);
  if (!m) throw new Error(`no z-index in "${cls}"`);
  return Number(m[1] || m[2]);
};

describe('top bar layer', () => {
  it('sits above the DataTable sticky thead and tfoot', () => {
    const bar = /<header className="(sticky top-0[^"]*)"/.exec(src('TopNavbar.tsx'));
    expect(bar).not.toBeNull();
    const table = src('DataTable.tsx');
    const stickies = [...table.matchAll(/<(thead|tfoot) className="(sticky[^"]*)"/g)];
    expect(stickies.map((m) => m[1]).sort()).toEqual(['tfoot', 'thead']);
    for (const m of stickies) expect(z(bar![1])).toBeGreaterThan(z(m[2]));
  });
});
