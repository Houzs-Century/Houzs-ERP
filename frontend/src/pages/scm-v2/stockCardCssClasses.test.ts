import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/* The 2026-07-16 reskin deleted the header and KPI-tile classes from
   Inventory.module.css / SalesOrderDetail.module.css. StockCard kept
   referencing them, so `styles.statGrid` etc. resolved to undefined and the
   page rendered as bare text. Every class StockCard reads must still exist. */
const dir = __dirname;
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const classesIn = (file: string) =>
  new Set([...strip(readFileSync(join(dir, file), 'utf8')).matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]));

describe('StockCard CSS module classes', () => {
  it('reads only classes its modules define', () => {
    const tsx = readFileSync(join(dir, 'StockCard.tsx'), 'utf8');
    const modules = { styles: classesIn('Inventory.module.css'), chrome: classesIn('SalesOrderDetail.module.css') };
    const missing = [...tsx.matchAll(/\b(styles|chrome)\.(\w+)/g)]
      .filter(([, mod, cls]) => !modules[mod as keyof typeof modules].has(cls))
      .map(([ref]) => ref);
    expect([...new Set(missing)]).toEqual([]);
  });
});
