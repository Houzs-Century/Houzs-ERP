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

const GEN = read('./purchase-order-pdf-render.ts');
const BROWSER = read('./purchase-order-pdf.ts');

const CALLERS = [
  ['V2 detail', '../../../pages/scm-v2/PurchaseOrderDetailV2.tsx'],
  ['edit page', '../../../pages/scm-v2/PurchaseOrderDetail.tsx'],
  ['list exports', '../../../pages/scm-v2/PurchaseOrdersListV2.tsx'],
  ['document-chain print', '../../../lib/printDocumentPdf.ts'],
] as const;

describe('one sheet, whichever button raised it', () => {
  test('the GENERATOR loads the artwork itself', () => {
    expect(BROWSER).toContain('sofaArt: (codes) => loadSofaCompartmentArtForPrint(codes),');
    /* The lookup ALWAYS runs; a supplied map only overrides per code. "Supplied
       wins outright" let a partial map (the V2 detail page passed only codes
       with a stored imageKey) blank every other piece: HC-PO-2610-007 printed
       1A / Console / 2S as bare boxes (owner 2026-10-03). */
    expect(GEN).toContain('...await sources.sofaArt(');
    expect(GEN).toContain('...opts?.sofaPhotos,');
    expect(GEN).not.toContain('?? await sources.sofaArt(');
    expect(GEN).toContain('cells.map((c) => c.moduleId)');
    expect(GEN).toContain('DIAGRAM_H, sofaArt)');
    expect(GEN).not.toContain('DIAGRAM_H, opts?.sofaPhotos)');
  });

  test('an EMPTY config still draws artwork — the code IS the artwork name', () => {
    const LOADER = read('./sales-order-queries.ts');
    expect(LOADER).toContain('`sofa-modules/${code}`');
    expect(LOADER).toContain("meta[code]?.imageKey ||");
  });

  test('every caller still compiles without knowing about artwork', () => {
    for (const [name, path] of CALLERS) {
      const src = read(path);
      expect(src, `${name} should raise a PO PDF`).toContain('generatePurchaseOrderPdf');
    }
  });

  test('no caller passes its own artwork map', () => {
    const passing = CALLERS.filter(([, p]) => read(p).includes('sofaPhotos'));
    expect(passing.map(([n]) => n)).toEqual([]);
  });
});
