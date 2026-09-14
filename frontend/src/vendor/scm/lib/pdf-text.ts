// ----------------------------------------------------------------------------
// pdf-text — the text of a PDF with WHERE it was drawn, for the server's
// statement readers (docs/bugs/0869).
//
// A bank's monthly statement PDF is read in the browser by pdf.js: every
// piece of text on every page with its x/y, grouped into lines by y and
// ordered by x. Nothing is interpreted here — which column is the amount,
// what a continuation line is, where the balances sit — that is the bank's
// layout, and it lives on the server (acc/bank-parse-pdf.ts) beside the CSV
// column maps, so a layout rule cannot exist in two spellings.
//
// Loaded on demand, only when a .pdf is picked: pdf.js is a megabyte the
// CSV path never needs.
// ----------------------------------------------------------------------------

export type PdfTextCell = { x: number; t: string };
export type PdfTextLine = { y: number; cells: PdfTextCell[] };
export type PdfTextPage = { lines: PdfTextLine[] };
export type PdfText = { kind: typeof PDF_TEXT_KIND; pages: PdfTextPage[] };

/** The marker the server checks before reading the pages. */
export const PDF_TEXT_KIND = 'houzs-pdf-text/1';

/** Two pieces of text are on one line when their baselines are within this
    many points — pdf.js reports a hair of drift along a printed row. */
const LINE_TOLERANCE = 2;

export async function extractPdfText(data: ArrayBuffer): Promise<PdfText> {
  const pdfjs = await import('pdfjs-dist');
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  try {
    const pages: PdfTextPage[] = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const rows = new Map<number, PdfTextCell[]>();
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const x = Math.round(item.transform[4] ?? 0);
        const y = Math.round(item.transform[5] ?? 0);
        let key = y;
        for (const k of rows.keys()) { if (Math.abs(k - y) <= LINE_TOLERANCE) { key = k; break; } }
        const cell = { x, t: item.str };
        const at = rows.get(key);
        if (at) at.push(cell); else rows.set(key, [cell]);
      }
      /* Top of the page first (pdf.js measures y upwards), left to right. */
      pages.push({
        lines: [...rows.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([y, cells]) => ({ y, cells: [...cells].sort((a, b) => a.x - b.x) })),
      });
    }
    return { kind: PDF_TEXT_KIND, pages };
  } finally {
    await doc.destroy();
  }
}
