// ----------------------------------------------------------------------------
// pdf-split — one PDF holding several bills, as one PDF per page (HC-0204).
//
// Finance gets a supplier's invoices as ONE PDF (Siti 2026-11-02: our
// attachment is a single PDF containing multiple invoices). The bill pile
// reads one file as one bill, so the PDF is cut into its pages and each page
// joins the pile as its own bill. The pages are copied, not redrawn — each
// piece is the supplier's original page, and it is what the AP invoice
// attaches. Done here, not in the browser, for the reason pdf-attach.ts gives:
// pdf-lib is ~200 KB gzip the frontend bundle does not carry.
// ----------------------------------------------------------------------------

import { PDFDocument } from 'pdf-lib';

/* The pile holds 50 files (MAX_PILE_FILES); a PDF longer than that is a
   catalogue, not a stack of bills. */
export const MAX_SPLIT_PAGES = 50;

export type SplitResult =
  | { ok: true; pages: Uint8Array[] }
  | { ok: false; reason: 'unreadable' | 'too_many_pages'; pageCount?: number };

export async function splitPdfPages(bytes: Uint8Array): Promise<SplitResult> {
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(bytes);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const n = src.getPageCount();
  if (n > MAX_SPLIT_PAGES) return { ok: false, reason: 'too_many_pages', pageCount: n };
  const pages: Uint8Array[] = [];
  for (let i = 0; i < n; i += 1) {
    const doc = await PDFDocument.create();
    const [page] = await doc.copyPages(src, [i]);
    doc.addPage(page!);
    pages.push(await doc.save());
  }
  return { ok: true, pages };
}
