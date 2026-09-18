/* Money in the words the server writes reads the way AutoCount prints it.
 *
 * Owner 2026-09-15: 「全部amount需要跟Autocount 的一样」 — ringgit, two decimals,
 * thousands separators: "RM 15,000.00". The server writes money into refusal
 * messages, warnings, journal narrations, audit notes and print pages that staff
 * read. Those had drifted into page-local shapes: a raw sen integer ("a
 * difference of 1250 sen"), whole ringgit (`toFixed(0)`, `fmtRM(Math.round(..))`),
 * and `(sen / 100).toFixed(2)` with no separators ("15000.00"). The one formatter
 * is scm/shared/format.ts `fmtSen` / `fmtMoneySen`.
 *
 * It lives in tests/ because it reads the source tree (backend/src is typechecked
 * against the Workers runtime, where node:fs does not exist). Lines that only
 * reach a server log (console.*) are not staff-facing and are skipped.
 * docs/bugs/0926-money-in-server-written-messages-read-as-raw-sen-whole-ringg.md
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fmtSen, fmtMoneySen } from '../src/scm/shared/format';

const SRC = join(__dirname, '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts') && !/\.test\.ts$|\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);

const SHAPES: Array<{ name: string; rx: RegExp }> = [
  {
    name: 'sen divided by 100 and printed with toFixed(2) (no thousands separator)',
    rx: /\$\{\s*\(\s*((Math\.abs|Number)\()?[\w.?!]+\)?\s*\/\s*100\)\.toFixed\(2\)\s*\}(?!%)/,
  },
  {
    name: 'sen divided by 100 and printed bare (no decimals)',
    rx: /\$\{\s*[\w.?!]+(Sen|_sen)\s*\/\s*100\s*\}/,
  },
  {
    name: 'money rounded to whole ringgit',
    rx: /\/\s*100\)\.toFixed\(0\)|fmtRM\(\s*Math\.round\(|fmtRM\([^)]*\/\s*100\)|(RM|MYR) \$\{Math\.round\(|(RM|MYR) \$\{[\w.]+\.toLocaleString\('en-MY'\)\}/,
  },
  {
    name: 'a ringgit number printed with toFixed(2) behind an RM prefix (no thousands separator)',
    rx: /(RM|MYR) \$\{\s*\(?[\w.?!]+( \+ [\w.?!]+)?\)?\.toFixed\(2\)\s*\}/,
  },
  {
    name: 'a raw sen integer written into text ("1250 sen")',
    rx: /\$\{[^}]+\} sen\b/,
  },
];

describe('money written by the server reads like AutoCount', () => {
  it('the scan reads the source tree — a verdict over nothing must not pass', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.endsWith(join('scm', 'shared', 'format.ts')))).toBe(true);
  });

  it.each(SHAPES)('no server text formats money as: $name', ({ rx }) => {
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line) || /console\.(log|warn|error|info)/.test(line)) return;
        if (rx.test(line)) hits.push(`${relative(SRC, f).replace(/\\/g, '/')}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('the shared formatter prints the AutoCount shape', () => {
    expect(fmtSen(1_500_000)).toBe('RM 15,000.00');
    expect(fmtSen(-125)).toBe('RM -1.25');
    expect(fmtMoneySen(123_456_7, 'SGD')).toBe('SGD 12,345.67');
  });
});
