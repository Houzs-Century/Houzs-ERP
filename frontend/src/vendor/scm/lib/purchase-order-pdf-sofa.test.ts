// Regression guard for the PO PDF's sofa-layout schematic (owner 2026-06-23;
// dropped by #1212 owner 2026-07-24; REINSTATED per owner 2026-07-27 — the
// supplier PO must carry the source SO's sofa layout diagram). Renders a real
// PDF through the real generator with a geometry-less backend sofa (the SO-New
// shape: module-suffix SKUs, no x/y) and asserts the section actually drew —
// jsPDF streams are uncompressed, so the section title is greppable in the
// bytes. If someone removes the section again, this fails loudly instead of
// the diagram silently vanishing from supplier POs.
//
// Set SOFA_PDF_OUT=<path> to also write the rendered PDF for eyeballing.

import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { purchaseOrderPdfBase64 } from './purchase-order-pdf';

const header = {
  po_number: '2990-PO-TEST-001',
  supplier_id: null,
  status: 'SUBMITTED',
  po_date: '2026-07-27',
  expected_at: '2026-08-22',
  currency: 'MYR',
  subtotal_sen: 207900,
  tax_sen: 0,
  total_sen: 207900,
  notes: 'From SOs: 2990-SO-2607-016',
  your_ref_no: '2990-SO-2607-016',
  purchase_location_name: 'KL',
  supplier: {
    code: '400-TEST',
    name: 'TEST SUPPLIER SDN. BHD.',
    address: '1 JALAN TEST, 47000 SUNGAI BULOH',
  },
} as never;

/* Two per-module lines of one build, SO-New style: the module rides in the SKU
   suffix ("XAMMAR-2A(LHF)"), item_group 'sofa', NO stored x/y geometry — the
   reconstruction path (buildDefaultSofaCells) must draw the default layout. */
const sofaLine = (moduleId: string) => ({
  item_code: `XAMMAR-${moduleId}`,
  material_name: `SOFA XAMMAR ${moduleId}`,
  supplier_sku: `5531-${moduleId}`,
  qty: 1,
  unit_price_sen: 103950,
  line_total_sen: 103950,
  uom: 'UNIT',
  item_group: 'sofa',
  so_doc_no: '2990-SO-2607-016',
  variants: {},
});

describe('purchase-order-pdf sofa layout (reinstated 2026-07-27)', () => {
  it('draws the orientation schematic for a geometry-less sofa PO', async () => {
    const b64 = await purchaseOrderPdfBase64(
      header,
      [sofaLine('2A(LHF)'), sofaLine('L(RHF)')] as never,
    );
    const pdf = Buffer.from(b64, 'base64');
    const raw = pdf.toString('latin1');
    // Section title + the TV marker label are literal text ops in the stream.
    expect(raw).toContain('Sofa layout');
    /* Reworded 2026-08-28 — the heading used to end "(orientation / LHF·RHF)",
       which was a note to ourselves in a document a supplier reads. What is
       pinned is the two facts the picture depends on, not the wording around
       them. */
    expect(raw).toContain('viewed from above');
    expect(raw).toContain('front faces the TV');
    expect(raw).not.toContain('LHF·RHF');
    // Caption carries the module list + source SO no. jsPDF escapes parens in
    // text ops ("2A(LHF)" → "2A\(LHF\)"), and the caption wraps to the diagram
    // width, so assert the atomic tokens rather than the joined line.
    expect(raw).toContain('2A\\(LHF\\)');
    expect(raw).toContain('L\\(RHF\\)');
    expect(raw).toContain('2990-SO-2607-016');
    if (process.env.SOFA_PDF_OUT) writeFileSync(process.env.SOFA_PDF_OUT, pdf);
  });

  it('draws nothing sofa-shaped for a non-sofa PO', async () => {
    const b64 = await purchaseOrderPdfBase64(header, [{
      item_code: 'ANGGN-FIRM-K',
      material_name: '2990 ANGGN-FIRM MATTRESS (183X190X35CM)',
      supplier_sku: 'NF-ANGGN-K',
      qty: 1,
      unit_price_sen: 127000,
      line_total_sen: 127000,
      uom: 'UNIT',
      item_group: 'mattress',
      so_doc_no: null,
      variants: {},
    }] as never);
    const raw = Buffer.from(b64, 'base64').toString('latin1');
    expect(raw).not.toContain('Sofa layout');
  });
});
