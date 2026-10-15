// ----------------------------------------------------------------------------
// scm.grn_items has no `qty` column (it has qty_received / qty_accepted), and
// PostgREST refuses the WHOLE read when one selected column is absent.
//
// Seen live on HC-PO-2609-127, 2026-10-15 (HC-0101): the PO is RECEIVED on
// HC-GRN-2610-063, but the relationship map said "GRN: Not created" and the
// response carried degraded: ["grn_items"]. Every PO's GRN line link was empty.
// WIRING pin: no unit test over derivePoGrnCoverage could see a column drift.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import flowSrc from '../src/scm/routes/document-flow.ts?raw';

const SRC = flowSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('document-flow asks grn_items only for columns it has', () => {
  test('no grn_items select names a bare `qty`', () => {
    const selects = [...SRC.matchAll(/from\('grn_items'\)\.select\('([^']*)'\)/g)].map((m) => m[1]);
    expect(selects.length).toBeGreaterThan(0);
    for (const cols of selects) {
      expect(cols.split(',').map((s) => s.trim())).not.toContain('qty');
    }
  });
});
