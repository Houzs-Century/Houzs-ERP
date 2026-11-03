/* HC-0204: a PDF of several invoices, cut into one PDF per page — each piece
   the original page, copied, so the AP invoice attaches what the supplier sent. */
import { PDFDocument } from 'pdf-lib';
import { describe, expect, test } from 'vitest';
import { MAX_SPLIT_PAGES, splitPdfPages } from './pdf-split';

const pdfOf = async (sizes: Array<[number, number]>): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  for (const s of sizes) doc.addPage(s);
  return doc.save();
};

describe('splitPdfPages', () => {
  test('one one-page PDF per page, in order', async () => {
    const got = await splitPdfPages(await pdfOf([[100, 200], [300, 400], [500, 600]]));
    if (!got.ok) throw new Error(got.reason);
    const sizes = await Promise.all(got.pages.map(async (b) => {
      const d = await PDFDocument.load(b);
      expect(d.getPageCount()).toBe(1);
      const { width, height } = d.getPage(0).getSize();
      return [width, height];
    }));
    expect(sizes).toEqual([[100, 200], [300, 400], [500, 600]]);
  });

  test('not a PDF is unreadable, not a throw', async () => {
    expect(await splitPdfPages(new TextEncoder().encode('not a pdf'))).toEqual({ ok: false, reason: 'unreadable' });
  });

  test('past the pile size it refuses, with the page count', async () => {
    const big = await pdfOf(Array.from({ length: MAX_SPLIT_PAGES + 1 }, () => [10, 10] as [number, number]));
    expect(await splitPdfPages(big)).toEqual({ ok: false, reason: 'too_many_pages', pageCount: MAX_SPLIT_PAGES + 1 });
  });
});
