// ----------------------------------------------------------------------------
// EVERY BUTTON THAT PRINTS A PURCHASE ORDER DRAWS THE SAME SHEET.
//
// The owner printed three POs and asked why they did not match
// (2026-08-28: 「为什么感觉不是全部都一样的？」). There is ONE generator and one
// layout; what there were five of is CALLERS — the V2 detail, the edit page, two
// list exports and the right-click document-chain print — and only ONE of them
// passed the `sofaPhotos` map. The other four silently drew the fallback
// schematic, so the same document looked different depending on which button
// raised it.
//
// The fix is not "pass it in four more places": a caller that must remember will
// forget, and a sixth caller would have forgotten too. The generator fetches the
// art itself. This test pins that property from BOTH ends — the generator asks,
// and no caller is required to.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');

const GEN = read('./purchase-order-pdf.ts');

/** Every file that raises a Purchase Order PDF. */
const CALLERS = [
  ['V2 detail', '../../../pages/scm-v2/PurchaseOrderDetailV2.tsx'],
  ['edit page', '../../../pages/scm-v2/PurchaseOrderDetail.tsx'],
  ['list exports', '../../../pages/scm-v2/PurchaseOrdersListV2.tsx'],
  ['document-chain print', '../../../lib/printDocumentPdf.ts'],
] as const;

describe('one sheet, whichever button raised it', () => {
  test('the GENERATOR loads the artwork itself', () => {
    expect(GEN).toContain('loadSofaCompartmentArtForPrint');
    /* Supplied wins, so the caller that already holds the map spends no second
       request — but absence is a fetch, never a blank. */
    expect(GEN).toContain('opts?.sofaPhotos ?? await loadSofaCompartmentArtForPrint()');
    /* And the drawing reads the RESOLVED value, not the raw option — passing
       `opts?.sofaPhotos` straight to the engine is the original bug. */
    expect(GEN).toContain('DIAGRAM_H, sofaArt)');
    expect(GEN).not.toContain('DIAGRAM_H, opts?.sofaPhotos)');
  });

  test('every caller still compiles without knowing about artwork', () => {
    /* THE POINT: four of these pass nothing and must still produce the same
       sheet. If a future edit makes the map required, this is where it shows. */
    for (const [name, path] of CALLERS) {
      const src = read(path);
      expect(src, `${name} should raise a PO PDF`).toContain('generatePurchaseOrderPdf');
    }
  });

  test('the four that pass nothing are not silently a different document', () => {
    /* Asserted as a COUNT so the test fails when a fifth caller appears, which
       is the moment somebody should think about this again rather than the
       moment a supplier gets a different-looking sheet. */
    const passing = CALLERS.filter(([, p]) => read(p).includes('sofaPhotos'));
    expect(passing.map(([n]) => n)).toEqual(['V2 detail']);
  });
});
