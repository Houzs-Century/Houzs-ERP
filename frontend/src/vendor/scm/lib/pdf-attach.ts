// pdf-attach — append a voucher's stored files to its rendered PDF.
//
// jsPDF can only DRAW; it cannot absorb an existing PDF's pages, and the
// owner's scanned bills are mostly PDFs (owner 2026-09-03: print pv include
// ocr 的文件一起). pdf-lib does exactly that one job here: load the jsPDF
// output as the base, then, per attachment IN THE ORDER GIVEN (sort_no =
// attach order), copy a PDF's pages across or put an image on its own A4
// page, fitted and centred.
//
// A file that cannot be embedded (corrupt bytes, an encrypted PDF pdf-lib
// cannot open, a webp in a browser with no canvas) must not cost the print:
// the voucher page is the DOCUMENT, the file is its evidence. Such a file
// becomes a notice page naming it — visible failure on paper, never a
// silently missing bill. ASCII-fold on the notice text: pdf-lib's standard
// Helvetica is WinAnsi-only and throws on CJK.

import { PDFDocument, StandardFonts } from 'pdf-lib';

export type PdfAttachment = { fileName: string; mime: string; bytes: ArrayBuffer };

/* A4 in PDF points — pdf-lib speaks pt, jsPDF above speaks mm. */
const A4_W = 595.28;
const A4_H = 841.89;
const MARGIN = 28;

const ascii = (s: string): string => s.replace(/[^\x20-\x7e]/g, '?');

/* webp → png through the browser's own decoder; pdf-lib embeds only JPG/PNG.
   Throws where canvas is unavailable (jsdom) — the caller's notice page is
   the designed fallback there. */
async function webpToPngBytes(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  ctx.drawImage(bmp, 0, 0);
  const png = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, 'image/png'); });
  if (!png) throw new Error('webp could not be re-encoded');
  return png.arrayBuffer();
}

export async function mergePdfWithAttachments(
  base: ArrayBuffer,
  attachments: PdfAttachment[],
): Promise<Uint8Array> {
  const out = await PDFDocument.load(base);
  for (const f of attachments) {
    try {
      if (f.mime === 'application/pdf') {
        /* ignoreEncryption: a bank's protected statement still OPENS for
           copying more often than not; one that truly cannot be read throws
           into the notice path below. */
        const src = await PDFDocument.load(f.bytes, { ignoreEncryption: true });
        const pages = await out.copyPages(src, src.getPageIndices());
        for (const p of pages) out.addPage(p);
      } else {
        const img = f.mime === 'image/png' ? await out.embedPng(f.bytes)
          : f.mime === 'image/jpeg' ? await out.embedJpg(f.bytes)
          : await out.embedPng(await webpToPngBytes(f.bytes));
        const page = out.addPage([A4_W, A4_H]);
        const scale = Math.min((A4_W - MARGIN * 2) / img.width, (A4_H - MARGIN * 2) / img.height, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        page.drawImage(img, { x: (A4_W - w) / 2, y: (A4_H - h) / 2, width: w, height: h });
      }
    } catch (e) {
      const page = out.addPage([A4_W, A4_H]);
      const font = await out.embedFont(StandardFonts.Helvetica);
      page.drawText('Attached file could not be embedded in this print:', { x: MARGIN, y: A4_H - 64, size: 12, font });
      page.drawText(ascii(f.fileName), { x: MARGIN, y: A4_H - 84, size: 11, font });
      page.drawText(ascii(e instanceof Error ? e.message.slice(0, 140) : 'unknown error'), { x: MARGIN, y: A4_H - 102, size: 9, font });
      page.drawText('Open the voucher in the system to view the original file.', { x: MARGIN, y: A4_H - 122, size: 9, font });
    }
  }
  return out.save();
}
