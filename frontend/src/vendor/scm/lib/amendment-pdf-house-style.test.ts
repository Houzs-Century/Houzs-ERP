// B30 (sister: Conts #401). The amendment's change table used autoTable's "grid"
// theme and overrode only the header's weight, so the theme's own teal header
// band (fill 26,188,156, white text) was printed on every amendment. Measured
// off the DRAWN page content, not the options object.
import { describe, expect, test, vi } from 'vitest';
import { pdfRawText } from './pdf-raw-text';

type JsPdf = import('jspdf').jsPDF;
const captured: { doc: JsPdf | null } = { doc: null };

vi.mock('./pdf-common', async (orig) => {
  const real = await orig<typeof import('./pdf-common')>();
  return { ...real, deliverPdf: (doc: JsPdf) => { captured.doc = doc; } };
});

// jsPDF writes a fill colour as `r g b rg`, each channel to two decimals.
const fill = (r: number, g: number, b: number) =>
  `${+(r / 255).toFixed(2)} ${+(g / 255).toFixed(2)} ${+(b / 255).toFixed(2)} rg`;

async function drawnContent(): Promise<string> {
  const { generateAmendmentPdf } = await import('./amendment-pdf');
  captured.doc = null;
  await generateAmendmentPdf({
    kind: 'SO',
    amendmentNo: 'SOA-0001',
    issueDate: '2026-11-09',
    status: 'APPROVED',
    docNo: 'SO-2611-001',
    partyLabel: 'Customer',
    partyName: 'Test Customer',
    revisionFrom: 1,
    revisionTo: 2,
    changes: [
      { kind: 'CHANGE', item: 'SOFA-01', field: 'Qty', before: '1', after: '2', department: 'Sales' },
    ],
  });
  const doc = captured.doc as JsPdf | null;
  if (!doc) throw new Error('the PDF was never delivered');
  return pdfRawText(new Uint8Array(doc.output('arraybuffer')));
}

describe('amendment PDF — change table header follows the house print style', () => {
  test('no teal header band is painted', async () => {
    const pdf = await drawnContent();
    expect(pdf).toContain('REQUESTED CHANGES');
    expect(pdf).not.toContain(fill(26, 188, 156));
  });

  test('the before/after meaning fills are still painted', async () => {
    const pdf = await drawnContent();
    expect(pdf).toContain(fill(252, 226, 226));
    expect(pdf).toContain(fill(220, 244, 226));
  });
});
