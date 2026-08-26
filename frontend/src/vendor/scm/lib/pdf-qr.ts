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

  /* THE REQUESTED SIZE IS A FLOOR TO GROW FROM, NOT A PROMISE TO SHRINK INTO.
     A QR's readability is its MODULE size, not its overall size, and the module
     count is set by the payload — so the same 14mm box is comfortable for a
     short URL and unscannable for a long one. Printing whatever was asked for
     would have made a legacy 64-character token print at 0.311mm per module the
     day the layout shrank, and nothing would have failed: the sheet would look
     right and simply not scan at the lorry.

     0.42mm is the floor, and it is the only number with field evidence behind
     it — Hookka's delivery QR runs at 0.415mm on a warehouse floor today. Below
     that is the owner's own 2026-07-03 complaint, 「上下左右斜角不敏感」.

     So: draw at the asked-for size when the payload allows it, and GROW when it
     does not. Callers are told what was actually drawn (the return value) and
     flow their layout from that, which is why the return has always existed. */
  const MIN_MODULE_MM = 0.42;
  const drawn = Math.max(sizeMm, (count + quiet * 2) * MIN_MODULE_MM);
  const cell = drawn / (count + quiet * 2);
  sizeMm = drawn;

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
