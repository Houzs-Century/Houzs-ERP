/* docs/bugs/0893 (the fabric-search entry): the route must not cap the query
   at the typeahead limit before the on-offer rules run. coloursOnOffer's own
   behaviour is pinned beside it in src/scm/routes/fabricColoursOnOffer.test.ts;
   this pins the WIRING, which a behaviour test of the helper cannot see.
   Lives in tests/ because backend/tsconfig.json gives src/ no node:fs. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(resolve(HERE, '../src/scm/routes/fabric-colours.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

describe('GET /fabric-colours caps after the rules', () => {
  it('the query reads the PostgREST page, never the typeahead limit', () => {
    expect(code).not.toMatch(/q\s*=\s*q\.limit\(limit\)/);
    expect(code).toMatch(/q\s*=\s*q\.limit\(OFFER_SCAN_ROWS\)/);
  });

  it('the response goes through coloursOnOffer with the limit applied last', () => {
    expect(code).toMatch(/coloursOnOffer\(\s*\(data \?\? \[\]\)/);
    expect(code).toMatch(/rawQ \? limit : null/);
  });

  it("a named item's Model pool is read through the save gate's own loader", () => {
    expect(code).toContain('loadProductAndModel(supabase, itemCode, activeCompanyId(c))');
  });
});
