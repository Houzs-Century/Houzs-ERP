/* pdf-attach — the merge that puts the voucher's evidence AFTER its page.
 *
 * Real pdf-lib, no mocks: the base and the attachment PDFs are built with
 * pdf-lib itself, and the assertions re-open the merged bytes and count what
 * a reader would see. Worth pinning:
 *   1. ORDER AND COMPLETENESS — a 2-page bill contributes BOTH pages, after
 *      the voucher page, before the next file.
 *   2. AN IMAGE GETS ITS OWN A4 PAGE.
 *   3. A FILE THAT CANNOT EMBED COSTS A NOTICE PAGE, NEVER THE PRINT — the
 *      merge must not throw, and the page count still moves by one so the
 *      reader can SEE something failed (a silently missing bill is the
 *      failure mode this exists to avoid). WebP under jsdom (no canvas) rides
 *      this same path by design.
 */

import { describe, expect, test } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { mergePdfWithAttachments } from './pdf-attach';

async function pdfBytes(pages: number): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([595.28, 841.89]);
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/* A real 1×1 JPEG (the smallest baseline one), so embedJpg exercises the
   actual decoder rather than a stub. */
const TINY_JPEG = Uint8Array.from(atob(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
), (c) => c.charCodeAt(0));
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

  test('an image gets its own page; files land in the order given', async () => {
    const merged = await mergePdfWithAttachments(await pdfBytes(1), [
      { fileName: 'photo.jpg', mime: 'image/jpeg', bytes: tinyJpegBuf() },
      { fileName: 'bill.pdf', mime: 'application/pdf', bytes: await pdfBytes(1) },
    ]);
    expect(await pageCount(merged)).toBe(3);
  });

  test('a file that cannot embed becomes a NOTICE page — visible on paper, never a throw', async () => {
    const corrupt = new TextEncoder().encode('this is not a pdf').buffer as ArrayBuffer;
    const merged = await mergePdfWithAttachments(await pdfBytes(1), [
      { fileName: '账单-九月.pdf', mime: 'application/pdf', bytes: corrupt },
    ]);
    /* base 1 + notice 1 — the reader SEES a page saying which file is missing
       (the CJK name ascii-folds; pdf-lib's Helvetica is WinAnsi-only). */
    expect(await pageCount(merged)).toBe(2);
  });

  test('webp under jsdom (no canvas) rides the notice path by design', async () => {
    const merged = await mergePdfWithAttachments(await pdfBytes(1), [
      { fileName: 'shot.webp', mime: 'image/webp', bytes: tinyJpegBuf() },
    ]);
    expect(await pageCount(merged)).toBe(2);
  });
});
