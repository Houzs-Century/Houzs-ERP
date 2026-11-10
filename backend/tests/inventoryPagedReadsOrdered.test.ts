/* Gap review P9: every paged stock read has a total order.

   paginateAll / chunkIn read 1000-row windows with .range(). Without an ORDER
   BY that is unique per row, Postgres may hand back the windows in a different
   order on each request, so a row can appear on two pages or on none: the stock
   list, valuation, COGS export and analytics then double-count or drop rows
   once a company has more than 1000 of them. #4894 fixed GET /inventory/products;
   this pins the rest of the file. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(new URL('../src/scm/routes/inventory.ts', import.meta.url), 'utf8');

/** Each paged factory: the text from `paginateAll(` / `chunkIn(` to its first `.range(`. */
function pagedFactories(src: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const re = /\b(?:paginateAll|chunkIn)\s*(?:<[^(]*?>)?\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const end = src.indexOf('.range(', m.index);
    if (end < 0) continue;
    out.push({ line: src.slice(0, m.index).split('\n').length, text: src.slice(m.index, end) });
  }
  return out;
}

describe('inventory.ts paged reads are totally ordered (P9)', () => {
  const factories = pagedFactories(SRC);

  it('finds the paged reads', () => {
    expect(factories.length).toBeGreaterThanOrEqual(15);
  });

  it('every paged read orders its rows', () => {
    const unordered = factories.filter((f) => !f.text.includes('.order(')).map((f) => `inventory.ts:${f.line}`);
    expect(unordered).toEqual([]);
  });

  it('the reads whose first sort key repeats carry a unique tie-breaker', () => {
    expect(SRC).toContain(".order('consumed_at', { ascending: false }).order('id').range(pFrom, pTo)");
    expect(SRC).toContain("lotsQ.order('received_at').order('id').range(from, to)");
    expect(SRC).toContain("cogsQ.order('id').range(from, to)");
    expect(SRC).toContain(".order('item_code').order('warehouse_id').order('variant_key').order('product_name').order('company_id')");
    expect(SRC).toContain(".order('received_at', { ascending: true }).order('id').range(from, to)");
  });
});
