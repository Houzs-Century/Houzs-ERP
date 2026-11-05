/* Every paged read behind the statements carries a total order (owner
   2026-11-04: the P&L's stock for 2026-10-31 came back 2,065,954.44,
   2,123,545.08, 2,145,029.07 and 2,384,370.13 on four opens). paginateAll reads
   1,000 rows a page by offset; without an ORDER BY Postgres may hand the same
   row to two pages and none to another, so a total moves on every read. This
   pins the readers of the ledger and the stock replay: backend/src/acc and the
   accounting routes. docs/bugs/README.md, "Silent truncation". */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const files = [
  ...readdirSync(join(SRC, 'acc')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => join(SRC, 'acc', f)),
  ...readdirSync(join(SRC, 'scm', 'routes')).filter((f) => /^accounting.*\.ts$/.test(f) && !f.endsWith('.test.ts')).map((f) => join(SRC, 'scm', 'routes', f)),
];

/** Each paginateAll factory up to its .range( that has no .order( — file:line table. */
function unorderedPagedReads(source: string): string[] {
  const out: string[] = [];
  for (const call of source.matchAll(/paginateAll\s*(?:<[^>]*>)?\s*\(/g)) {
    const i = call.index;
    const end = source.indexOf('.range(', i);
    if (end < 0) continue;
    const block = source.slice(i, end);
    const table = /\.from\('([a-z_]+)'\)/.exec(block)?.[1];
    if (table && !block.includes('.order(')) out.push(`${source.slice(0, i).split('\n').length} ${table}`);
  }
  return out;
}

describe('paged reads behind the statements are ordered', () => {
  it('the scan finds a factory with no order, and passes one with an order', () => {
    expect(unorderedPagedReads("paginateAll((f, t) => sb.from('inventory_movements').select('id').range(f, t))")).toEqual(['1 inventory_movements']);
    expect(unorderedPagedReads("paginateAll((f, t) => sb.from('inventory_movements').select('id').order('id').range(f, t))")).toEqual([]);
  });

  it('no reader in backend/src/acc or the accounting routes pages without an order', () => {
    const found = files.flatMap((f) => unorderedPagedReads(readFileSync(f, 'utf8')).map((hit) => `${f.slice(SRC.length + 1)}:${hit}`));
    expect(found).toEqual([]);
  });
});
