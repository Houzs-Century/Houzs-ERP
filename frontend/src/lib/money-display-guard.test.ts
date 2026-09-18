// ----------------------------------------------------------------------------
// Every money amount on screen reads the way AutoCount prints it: ringgit, two
// decimals, thousands separators — "RM 15,000.00" (owner 2026-09-15: 「全部amount
// 需要跟Autocount 的一样」).
//
// The shared formatters already do that (vendor/shared/format.ts fmtSen /
// fmtMoneySen for sen, lib/utils.ts formatCurrency for a ringgit number). What
// drifted were page-local copies: a whole-ringgit "RM 1,235", a "RM 15.0K"
// abbreviation, a `(sen / 100).toFixed(2)` with no separators, and — the export
// bug that started this — a sen integer written out as it is stored. This file
// scans the source for those SHAPES, so a new page-local copy fails here instead
// of reaching the owner. docs/bugs/0926-money-on-some-screens-read-as-whole-ringgit-as-rm-15-0k-or-w.md.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatCurrency } from './utils';

const ROOT = 'src';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT);

type Shape = { name: string; rx: RegExp };

/* Each shape is money-specific on its own line: it names sen, `/ 100`, or the
   RM/MYR prefix. A bare `maximumFractionDigits: 0` is a quantity formatter and
   is not matched. */
const SHAPES: Shape[] = [
  {
    name: 'a sen amount formatted to whole ringgit (0 decimals)',
    rx: /\/\s*100\)?\s*\.toLocaleString\([^)]*maximumFractionDigits:\s*0\b|\/\s*100\)\.toFixed\(0\)|(RM|MYR) \$\{Math\.round\([^`]*\)\.toLocaleString\(\)|(RM|MYR) \$\{[\w.]+\.toFixed\(0\)\}/,
  },
  {
    name: 'a money amount abbreviated to thousands/millions ("RM 15.0K")',
    rx: /(RM|MYR) \$\{[^`]*\/\s*1_?000[^`]*\}[kKM]`|^\s*\}\)\}[kKM]`/,
  },
  {
    name: 'a sen amount divided by 100 and printed with toFixed(2) — no thousands separator',
    rx: /(RM|MYR) ?(\$\{|\{)\s*\(\s*((Math\.abs|Number)\()?[\w.?!]+\)?\s*\/\s*100\)\.toFixed\(2\)/,
  },
  {
    name: 'a ringgit number printed with toFixed(2) behind an RM prefix — no thousands separator',
    rx: /(RM|MYR) ?(\$\{|\{)\s*\(?[\w.?!]+( \?\? 0)?\)?\.toFixed\(2\)\}/,
  },
  {
    name: 'a ringgit number printed with toLocaleString and no decimals behind an RM prefix',
    rx: /(RM|MYR) ?\{\s*\([^{}]*\)\.toLocaleString\('en-MY'\)\s*\}/,
  },
  {
    name: 'a raw *_sen value rendered as a JSX child (shows 1500000 for RM 15,000.00)',
    rx: />\s*\{\s*[\w.?!]+(_sen|Sen)\s*\}|\{\s*[\w.?!]+(_sen|Sen)\s*\}\s*</,
  },
];

describe('money on screen reads like AutoCount', () => {
  test('the scan sees the source tree — a matcher that reads nothing must not pass', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.endsWith('format.ts'))).toBe(true);
  });

  test.each(SHAPES)('no page formats money as: $name', ({ rx }) => {
    const hits: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (rx.test(line)) hits.push(`${f.replace(/\\/g, '/')}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  test('formatCurrency never abbreviates — a large amount reads in full', () => {
    expect(formatCurrency(15000)).toBe('RM 15,000.00');
    expect(formatCurrency(2_345_678.9)).toBe('RM 2,345,678.90');
    expect(formatCurrency(-1234.5)).toBe('RM -1,234.50');
  });
});
