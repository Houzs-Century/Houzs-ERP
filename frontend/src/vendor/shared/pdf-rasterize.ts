// ----------------------------------------------------------------------------
// pdf-rasterize — a scanner PDF whose pages are fax-coded (CCITT G4) or JBIG2
// images is re-drawn in the browser as ordinary JPEG pages, still one PDF with
// the same pages, before it is uploaded for reading.
//
// WHY: the reading model is handed the PDF as-is and could not see those images:
// Hookka DO-2611-037 (Canon office scanner, 3 CCITT pages) came back "no lines"
// on every upload (2026-11-13), and the same pages as JPEG read all 22 rows and
// their racks. pdf.js decodes both codecs, so the browser does the conversion.
// ----------------------------------------------------------------------------

import { PDF_COMPRESS } from '../scm/lib/pdf-options';

const PAGE_EDGE_PX = 2200;
const JPEG_QUALITY = 0.85;
// pdf.js stops drawing in a hidden tab; past this the original goes up unchanged.
const GIVE_UP_MS = 45_000;

/** True when the PDF holds fax-coded or JBIG2 images the reader cannot see. */
export function hasUnreadableImageCodec(bytes: Uint8Array): boolean {
  // Filter names are plain ASCII in the PDF's object dictionaries.
  const text = new TextDecoder('latin1').decode(bytes);
  return /\/(CCITTFaxDecode|JBIG2Decode)\b/.test(text);
}

/**
 * The PDF with every page re-drawn as a JPEG, or the original file when it needs
 * no conversion or the conversion fails (a failed conversion must never block a
 * scan; the reader then sees what it saw before).
 */
export async function rasterizeScannerPdf(file: File): Promise<File> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const giveUp = new Promise<File>((resolve) => { timer = setTimeout(() => resolve(file), GIVE_UP_MS); });
  try {
    return await Promise.race([redraw(file), giveUp]);
  } finally {
    clearTimeout(timer);
  }
}

async function redraw(file: File): Promise<File> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!hasUnreadableImageCodec(bytes)) return file;

    const pdfjs = await import('pdfjs-dist');
    const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const { jsPDF } = await import('jspdf');

    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    let out: InstanceType<typeof jsPDF> | null = null;
    try {
      for (let n = 1; n <= doc.numPages; n += 1) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const scale = PAGE_EDGE_PX / Math.max(base.width, base.height);
        const view = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(view.width);
        canvas.height = Math.round(view.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) return file;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: view }).promise;
        const jpeg = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
        const size: [number, number] = [base.width, base.height];
        const orientation = base.width > base.height ? 'landscape' : 'portrait';
        if (!out) out = new jsPDF({ ...PDF_COMPRESS, unit: 'pt', format: size, orientation });
        else out.addPage(size, orientation);
        out.addImage(jpeg, 'JPEG', 0, 0, base.width, base.height);
        page.cleanup();
      }
    } finally {
      await doc.destroy();
    }
    if (!out) return file;
    return new File([out.output('blob')], file.name, { type: 'application/pdf', lastModified: file.lastModified });
  } catch {
    return file;
  }
}
