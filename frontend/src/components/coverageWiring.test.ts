import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'src/pages/scm-v2';
const files = readdirSync(DIR).filter((f) => f.endsWith('.tsx') && !f.includes('.test.'));

const SECOND_QUERY = /usePoSoCoverage\(|useSoLineCoverage\(/;

describe('a second query is always declared to the cells that depend on it', () => {
  const withSecond = files.filter((f) => SECOND_QUERY.test(readFileSync(join(DIR, f), 'utf8')));

  test('the population is not empty — a matcher that finds nothing must not pass', () => {
    expect(withSecond.length).toBeGreaterThan(0);
  });

  test.each(['PurchaseOrdersListV2.tsx', 'GoodsReceivedListV2.tsx', 'PurchaseInvoicesListV2.tsx',
             'MfgSalesOrdersListV2.tsx', 'SalesOrderDetailV2.tsx'])(
    '%s is known to fetch coverage separately', (f) => {
      expect(withSecond).toContain(f);
    });

  test.each(files)('%s never passes a CONSTANT coverage while fetching one', (f) => {
    const src = readFileSync(join(DIR, f), 'utf8');
    if (!SECOND_QUERY.test(src)) return;
    expect(src, `${f} fetches coverage but hard-codes coverage="ready"`)
      .not.toMatch(/coverage="ready"/);
    expect(src, `${f} fetches coverage but never derives its state`)
      .toMatch(/coverageStateOf\(/);
  });

  test('a surface with NO second query says "ready" explicitly, never by omission', () => {
    for (const f of files) {
      const src = readFileSync(join(DIR, f), 'utf8');
      if (SECOND_QUERY.test(src) || !src.includes('<DocumentLinesExpansion')) continue;
      expect(src, `${f} renders the expansion without stating coverage`)
        .toMatch(/coverage="ready"/);
    }
  });
});
