import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isDateColumn } from '../src/scm/lib/date-coerce';

/* WHY THIS TEST EXISTS.
   scm/lib/date-coerce.ts decides "is this column a date?" from the column NAME,
   because the generic field-map loops (`updates[to] = body[from]`) move fifty
   columns at a time and a hand-written list of date columns per route is a list
   nobody updates. A name predicate is only safe while it actually recognises the
   date columns the routes write — and nobody re-reads a regex when they add a
   column.

   So it is derived, not trusted: every `date`/`timestamp` column declared in the
   LIVE migration tree (src/db/migrations-pg), intersected with the
   `['camelKey', 'snake_col']` pairs the route files feed to those loops. A
   member of that intersection that isDateColumn does not recognise is a blank
   value away from `invalid input syntax for type date: ""` and a 500 on the
   whole save — which is exactly what PATCH /api/scm/mfg-purchase-orders/<id>
   was doing in production on 2026-08-17 with supplierDeliveryDate2/3/4 = "".

   A failure here is not a test to relax: extend DATE_COLUMN_RE. */

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, '../src/db/migrations-pg');
const ROUTE_DIRS = [
  path.resolve(here, '../src/scm/routes'),
  path.resolve(here, '../src/routes'),
];

function declaredDateColumns(): Set<string> {
  const cols = new Set<string>();
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql'))) {
    const src = readFileSync(path.join(MIGRATIONS, f), 'utf8');
    const re = /(?:^|,|\(|\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?)\s*"?([a-z][a-z0-9_]*)"?\s+(?:date|timestamptz|timestamp)\b/gim;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) cols.add(m[1].toLowerCase());
  }
  return cols;
}

function mappedColumns(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const dir of ROUTE_DIRS) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.includes('.test.')) continue;
      const src = readFileSync(path.join(dir, f), 'utf8');
      const pairRe = /\[\s*'([A-Za-z0-9_]+)'\s*,\s*'([a-z][a-z0-9_]*)'\s*\]/g;
      let m: RegExpExecArray | null;
      while ((m = pairRe.exec(src))) {
        const col = m[2];
        if (!out.has(col)) out.set(col, new Set());
        out.get(col)!.add(f);
      }
    }
  }
  return out;
}

describe('isDateColumn covers every date column the routes actually map', () => {
  /* A verdict computed over nothing must never read as a pass — if either
     scan stops matching, this fails before the real assertion can go green. */
  it('finds both corpora', () => {
    expect(declaredDateColumns().size).toBeGreaterThan(50);
    expect(mappedColumns().size).toBeGreaterThan(100);
  });

  it('recognises every mapped column the migrations declare as a date', () => {
    const dateCols = declaredDateColumns();
    const missed: string[] = [];
    for (const [col, files] of mappedColumns()) {
      if (!dateCols.has(col)) continue;
      if (!isDateColumn(col)) missed.push(`${col} (mapped in ${[...files].join(', ')})`);
    }
    expect(missed).toEqual([]);
  });
});
