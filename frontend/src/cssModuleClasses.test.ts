import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/* The 2026-07-16 reskin deleted header / KPI / filter-card classes from shared
   CSS modules while other pages kept reading them, so `styles.x` resolved to
   undefined and those pages rendered as bare text. Every class a file reads
   from a CSS module must still exist in that module. */
const root = __dirname;
const stripCss = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const stripTs = (ts: string) => ts.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [join(dir, e.name)] : [],
  );

describe('CSS module classes', () => {
  it('every styles.x read exists in its module', () => {
    const missing: string[] = [];
    for (const file of walk(root)) {
      const src = stripTs(readFileSync(file, 'utf8'));
      for (const [, name, rel] of src.matchAll(/import\s+(\w+)\s+from\s+['"]([^'"]+\.module\.css)['"]/g)) {
        const cssPath = resolve(dirname(file), rel);
        if (!existsSync(cssPath)) { missing.push(`${relative(root, file)}: ${rel} not found`); continue; }
        const defined = new Set([...stripCss(readFileSync(cssPath, 'utf8')).matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]));
        const read = [
          ...src.matchAll(new RegExp(String.raw`\b${name}\.([A-Za-z_]\w*)`, 'g')),
          ...src.matchAll(new RegExp(String.raw`\b${name}\[['"]([\w-]+)['"]\]`, 'g')),
        ].map((m) => m[1]);
        for (const cls of new Set(read)) if (!defined.has(cls)) missing.push(`${relative(root, file)}: ${name}.${cls}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
