// ----------------------------------------------------------------------------
// The two relink headers are NOT shaped alike, and one common column list asked
// the sales-order header for a column it does not have.
//
// Bought live on HC-SO-013394, 2026-09-02: the owner pressed "Match up lines" —
// the button the held-back screen tells him to press — and the answer was
// "Nothing was matched — the request never got through. column
// mfg_sales_orders.id does not exist". PostgREST refuses the WHOLE read when one
// selected column is absent, so the failure is total, not partial.
//
// This is a WIRING pin, like operatorZeroPriceWiring: the failure mode is not a
// wrong verdict, it is a column list drifting away from the table it is aimed
// at, which no unit test over the planner could see.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import relinkSrc from '../src/scm/routes/autocount-relink.ts?raw';

/* Comments quote the very shape this file forbids. */
const SRC = relinkSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the relink header read asks each table only for columns it has', () => {
  test('the header select is per-document, never a shared literal', () => {
    expect(SRC).toMatch(/\.select\(spec\.headerCols\)/);
    /* The exact regression: a literal list containing `id` handed to both. */
    expect(SRC).not.toMatch(/\.select\(\s*'[^']*\bid\b[^']*'\s*\)\s*\n\s*\.eq\(spec\.headerKey/);
  });

  test('the SALES ORDER header never asks for `id` — scm.mfg_sales_orders has none', () => {
    const so = SRC.slice(SRC.indexOf('SO: {'), SRC.indexOf('PO: {'));
    expect(so).toMatch(/headerCols: 'linked_ac_docno'/);
    expect(so).not.toMatch(/headerCols: '[^']*\bid\b/);
  });

  test('the PURCHASE ORDER header does ask for `id` — its lines are keyed by it', () => {
    const po = SRC.slice(SRC.indexOf('PO: {'));
    expect(po).toMatch(/headerCols: 'id, linked_ac_docno'/);
  });

  /* The same root, one line further down: a per-document fact must be READ off
     the spec, not re-derived by testing a column NAME. A new document type
     would silently take the docNo branch with nothing failing to compile
     (CLAUDE.md — a parameter that DECIDES is required, never inferred). The
     discriminant is `resolve` since the map grew past SO/PO to the four
     conversion documents (docs/bugs/0792). */
  test('which value the lines are looked up by is read off the spec', () => {
    expect(SRC).toMatch(/spec\.resolve === 'docNo'/);
    expect(SRC).not.toMatch(/spec\.parentCol === '/);
  });

  /* Every entry carries every per-document field, so adding one cannot half-land.
     All six document types since the map grew to the conversion documents. */
  test('every document type declares all six per-document facts', () => {
    for (const kind of ['SO', 'PO', 'DO', 'GR', 'IV', 'PI']) {
      const at = SRC.indexOf(`${kind}: {`);
      expect(at, `${kind} entry not found`).toBeGreaterThan(-1);
      const entry = SRC.slice(at, SRC.indexOf('},', at) + 2);
      for (const field of ['lineTable', 'parentCol', 'headerTable', 'headerKey', 'headerCols', 'resolve']) {
        expect(entry, `${kind} is missing ${field}`).toContain(`${field}:`);
      }
    }
  });
});
