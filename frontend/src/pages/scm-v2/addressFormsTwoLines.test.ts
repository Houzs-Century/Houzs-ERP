/* EVERY ADDRESS FORM SHOWS TWO LINES (owner 2026-11-18: "standardise the whole
 * system like the Sales Order: two lines only, including supplier, project").
 *
 * The tables keep address3 / address4 (the account book has four lines and old
 * rows hold text there), so a form that grows a third or fourth input again is
 * easy to write and nothing else notices. This scans every .tsx under src for
 * an input labelled as a third or fourth address line. Address line 2 shows
 * lines 3 / 4 instead (vendor/shared/address-two-lines.ts).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const findSrc = (): string => {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, 'frontend/src');
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`frontend/src not found above ${process.cwd()}`);
};
const SRC = findSrc();

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  if (statSync(p).isDirectory()) return walk(p);
  return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [p] : [];
});

/* A form label for line 3 / 4, however it is spelled. Grid column headers and
   audit labels are not inputs and are written differently (`label: 'Address 3'`
   in a column list is not matched: no `Line`, and no JSX `label=`). */
const THIRD_LINE_INPUT = /(label=\{?["'`]Address (line |Line )?[34]\b|["'`>]Address (line|Line) [34]\b|Address (line|Line) \$\{)/;

const files = walk(SRC).map((p) => ({ rel: relative(SRC, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }));

describe('address forms show two lines', () => {
  it('scans the forms — a scan that reads nothing must not pass', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => /Address (line|Line) 2/.test(f.text))).toBe(true);
  });

  it('no form has an input for address line 3 or 4', () => {
    const offenders = files.filter((f) => THIRD_LINE_INPUT.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
