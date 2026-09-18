// pdf-attach — append a voucher's stored files to its rendered PDF, ON THE
// WORKER (owner 2026-09-03: print pv include ocr 的文件一起).
//
// WHY SERVER-SIDE. jsPDF (the client's renderer) can only draw — it cannot
// absorb an existing PDF's pages, and the owner's scanned bills are mostly
// PDFs. pdf-lib does that one job, but it costs ~200KB gzip and the frontend
// bundle gate allows one change +60KB — and the files this merges ALREADY
// LIVE HERE, in the SLIPS R2 bucket. So the client renders the voucher page
// and posts it up; this module pulls the stored bills off R2 next door and
// hands back one finished PDF. Less JS shipped, and the bill bytes never
// make a pointless round-trip through the browser.
//
// A file that cannot be embedded (corrupt bytes, an encrypted PDF pdf-lib
// cannot open, webp — Workers have no canvas to re-encode it) must not cost
// the print: the voucher page is the DOCUMENT, the file is its evidence.
// Such a file becomes a notice page naming it — visible failure on paper,
// never a silently missing bill. ASCII-fold on the notice text: pdf-lib's
// standard Helvetica is WinAnsi-only and throws on CJK.

import { PDFDocument, StandardFonts } from 'pdf-lib';

export type PdfAttachment = { fileName: string; mime: string; bytes: ArrayBuffer };

/* A4 in PDF points — pdf-lib speaks pt, the jsPDF page above speaks mm. */
const A4_W = 595.28;
const A4_H = 841.89;
const MARGIN = 28;

const ascii = (s: string): string => s.replace(/[^\x20-\x7e]/g, '?');

/* Append ONE attachment to `out` — the shared arm of the single-voucher merge
   and the batch assembly, so a bill embeds (or fails onto its notice page)
   identically in both. */
async function appendAttachment(out: PDFDocument, f: PdfAttachment): Promise<void> {
  try {
    if (f.mime === 'application/pdf') {
      /* ignoreEncryption: a bank's protected statement still OPENS for
         copying more often than not; one that truly cannot be read throws
         into the notice path below. */
      const src = await PDFDocument.load(f.bytes, { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const p of pages) out.addPage(p);
    } else if (f.mime === 'image/png' || f.mime === 'image/jpeg') {
      const img = f.mime === 'image/png' ? await out.embedPng(f.bytes) : await out.embedJpg(f.bytes);
      const page = out.addPage([A4_W, A4_H]);
      const scale = Math.min((A4_W - MARGIN * 2) / img.width, (A4_H - MARGIN * 2) / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: (A4_W - w) / 2, y: (A4_H - h) / 2, width: w, height: h });
    } else {
      /* webp and anything else pdf-lib cannot decode here. */
      throw new Error(`${f.mime} cannot be embedded on the Worker`);
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

export async function mergePdfWithAttachments(
  base: ArrayBuffer,
  attachments: PdfAttachment[],
): Promise<Uint8Array> {
  const out = await PDFDocument.load(base);
  for (const f of attachments) await appendAttachment(out, f);
  return out.save();
}

/* The batch (owner: 可选多张 pv + document, 就 pv+document, pv+document…) —
   ONE PDF, strictly interleaved: voucher A's pages, then A's files, then
   voucher B's, then B's. Each `voucher` is a finished jsPDF output (its own
   page numbering), so the assembly is pure pdf-lib. */
export async function assemblePvBatchPdf(
  parts: Array<{ voucher: ArrayBuffer; files: PdfAttachment[] }>,
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const part of parts) {
    const src = await PDFDocument.load(part.voucher);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
    for (const f of part.files) await appendAttachment(out, f);
  }
  return out.save();
}
