/* pdf-attach — the Worker-side merge that puts a voucher's evidence AFTER its
 * page (see src/scm/lib/pdf-attach.ts for why the merge is not in the
 * browser). Real pdf-lib, no mocks: bases and attachments are built with
 * pdf-lib itself and assertions re-open the merged bytes.
 *
 * Worth pinning:
 *   1. ORDER AND COMPLETENESS — a 2-page bill contributes BOTH pages, after
 *      the voucher page, before the next file.
 *   2. AN IMAGE GETS ITS OWN A4 PAGE.
 *   3. A FILE THAT CANNOT EMBED COSTS A NOTICE PAGE, NEVER THE PRINT — the
 *      merge must not throw; the page count still moves by one so the reader
 *      SEES something failed. webp rides this path on the Worker by design
 *      (no canvas to re-encode it).
 *   4. THE BATCH INTERLEAVES STRICTLY — voucher A, A's files, voucher B,
 *      B's — pinned by page widths, which survive the copy.
 */

import { describe, expect, test } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { assemblePvBatchPdf, mergePdfWithAttachments } from '../src/scm/lib/pdf-attach';

/* `width` marks WHOSE page each one is, so an order assertion can read the
   merged file like a reader would. */
async function pdfBytes(pages: number, width = 595.28): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([width, 841.89]);
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/* A real 1×1 baseline JPEG, so embedJpg exercises the actual decoder. */
const TINY_JPEG = Uint8Array.from(atob(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
), (ch) => ch.charCodeAt(0));
const tinyJpegBuf = (): ArrayBuffer =>
  TINY_JPEG.buffer.slice(TINY_JPEG.byteOffset, TINY_JPEG.byteOffset + TINY_JPEG.byteLength) as ArrayBuffer;

const pageCount = async (bytes: Uint8Array): Promise<number> =>
  (await PDFDocument.load(bytes)).getPageCount();

describe('mergePdfWithAttachments', () => {
  test('a 2-page bill contributes both pages after the voucher page', async () => {
    const merged = await mergePdfWithAttachments(await pdfBytes(1), [
      { fileName: 'bill.pdf', mime: 'application/pdf', bytes: await pdfBytes(2) },
    ]);
    expect(await pageCount(merged)).toBe(3);
  });

  test('an image gets its own page', async () => {
    const merged = await mergePdfWithAttachments(await pdfBytes(1), [
      { fileName: 'photo.jpg', mime: 'image/jpeg', bytes: tinyJpegBuf() },
    ]);
    expect(await pageCount(merged)).toBe(2);
  });

  test('a file that cannot embed becomes a NOTICE page — visible on paper, never a throw', async () => {
    const corrupt = new TextEncoder().encode('this is not a pdf').buffer as ArrayBuffer;
    const merged = await mergePdfWithAttachments(await pdfBytes(1), [
      { fileName: '账单-九月.pdf', mime: 'application/pdf', bytes: corrupt },
      /* webp on the Worker (no canvas) rides the same path by design. */
      { fileName: 'shot.webp', mime: 'image/webp', bytes: tinyJpegBuf() },
    ]);
    expect(await pageCount(merged)).toBe(3);
  });

  test('the batch interleaves strictly: voucher A, A\'s files, voucher B, B\'s files (可选多张 pv + document)', async () => {
    const merged = await assemblePvBatchPdf([
      /* Widths mark ownership: voucher A = 500, A's bill = 600 (2 pages),
         voucher B = 700 (2 pages), no files. */
      { voucher: await pdfBytes(1, 500), files: [{ fileName: 'a.pdf', mime: 'application/pdf', bytes: await pdfBytes(2, 600) }] },
      { voucher: await pdfBytes(2, 700), files: [] },
    ]);
    const out = await PDFDocument.load(merged);
    expect(out.getPages().map((p) => Math.round(p.getWidth()))).toEqual([500, 600, 600, 700, 700]);
  });
});
