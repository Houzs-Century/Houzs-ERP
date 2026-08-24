// ----------------------------------------------------------------------------
// pdf-qr — draw a QR code into a jsPDF document as VECTOR rects.
//
// Frontend twin of backend/src/services/printQr.ts (the ASSR print's qrSvg):
// same library (qrcode-generator), same error-correction trade-off ('M'), same
// hand-built module walk. Rects instead of an embedded image because jsPDF
// rasterises images at addImage time — a vector QR prints crisp at any size
// and survives the print dialog's own scaling, which is exactly why the ASSR
// print chose inline SVG over a data URI.
//
// First consumer: the Delivery Order print's "scan to mark loaded" block
// (2026-08-21) — the warehouse scans the paper that travels with the goods,
// and the scan lands on /scm/do-load. Keep this helper document-agnostic; the
// URL is the caller's business.
// ----------------------------------------------------------------------------
// @ts-ignore — qrcode-generator ships its own .d.ts but the typings don't
// always resolve cleanly under the bundler resolver. Library is pure JS and
// stable; the backend twin carries the same pragma for the same reason.
import qrcode from 'qrcode-generator';

type Doc = {
  setFillColor: (r: number, g: number, b: number) => void;
  rect: (x: number, y: number, w: number, h: number, style?: string) => void;
};

/**
 * Draw `text` as a QR at (x, y), `sizeMm` square. Draws a white quiet-zone
 * backing first (the spec's margin is what keeps phone cameras locking on),
 * then the dark modules in ink. Returns the drawn size so callers can flow
 * layout below it.
 */
export function drawQrIntoPdf(doc: Doc, text: string, x: number, y: number, sizeMm: number): number {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 2; // modules of quiet zone on each side
  const cell = sizeMm / (count + quiet * 2);

  doc.setFillColor(255, 255, 255);
  doc.rect(x, y, sizeMm, sizeMm, 'F');
  doc.setFillColor(0, 0, 0);
  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) {
      if (qr.isDark(r, c)) {
        doc.rect(x + (c + quiet) * cell, y + (r + quiet) * cell, cell, cell, 'F');
      }
    }
  }
  return sizeMm;
}
