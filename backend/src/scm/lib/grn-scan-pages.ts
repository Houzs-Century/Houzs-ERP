// ---------------------------------------------------------------------------
// grn-scan-pages — a delivery order too long for one answer, read page by page
// and merged back into ONE read: header from page 1, every page's lines in
// order. Only used when the whole-file read stopped at max_tokens; the document
// stays one scan row and one goods-receipt draft (owner 2026-11-13, Hookka
// DO-2611-037: 25 sets over 3 pages).
// ---------------------------------------------------------------------------

import { cutPdf, pdfPageCount } from './scan-split';
import { toBase64, type ContentBlock } from './scan-ocr';
import { mergePageReads, partialReadNote, type GrnExtractCall, type GrnExtracted } from './grn-scan-extract';

export type PagedRead = { parsed: GrnExtracted | null; note: string | null; pagesRead: number; pageCount: number };

/** The PDF bytes of a scan that is one PDF, else null (photos are one page each already). */
export function singlePdf(fileBlocks: ContentBlock[], firstBuffer: ArrayBuffer | null): ArrayBuffer | null {
  if (fileBlocks.length !== 1 || !firstBuffer) return null;
  const src = (fileBlocks[0] as { type?: unknown; source?: { media_type?: unknown } }).source;
  return fileBlocks[0].type === 'document' && src?.media_type === 'application/pdf' ? firstBuffer : null;
}

/**
 * Read each page of `pdf` on its own (in parallel) and merge. `first` is the
 * whole-file read that stopped at max_tokens. Falls back to it when the file
 * cannot be cut or the pages read back fewer lines than it already had.
 */
export async function readPageByPage(
  pdf: ArrayBuffer,
  pageCount: number,
  first: GrnExtractCall,
  read: (blocks: ContentBlock[]) => Promise<GrnExtractCall>,
): Promise<PagedRead> {
  const firstLines = first.parsed?.lines.length ?? 0;
  const keepFirst: PagedRead = { parsed: first.parsed, note: partialReadNote(firstLines, null, null), pagesRead: 0, pageCount };
  if (pageCount < 2) return keepFirst;
  const pages = await cutPdf(pdf, Array.from({ length: pageCount }, (_, i) => ({ startPage: i + 1, endPage: i + 1 })));
  if (pages.length !== pageCount) return keepFirst;
  const calls = await Promise.all(pages.map((p) => read([
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(p.bytes) } },
  ])));
  const { parsed, pagesRead } = mergePageReads(calls.map((c) => c.parsed));
  if (!parsed || parsed.lines.length < firstLines) return keepFirst;
  const complete = pagesRead === pageCount && calls.every((c) => !c.truncated);
  return { parsed, note: complete ? null : partialReadNote(parsed.lines.length, pagesRead, pageCount), pagesRead, pageCount };
}

export type DeliveryOrderRead = {
  parsed: GrnExtracted | null;
  // The model call failed outright (5xx, timeout, network): nothing was read and
  // the scan must fail so it can be read again, never pass as "no lines".
  failed: boolean;
  errorMsg: string | null;
  claudeText: string;
  // Set when the read stopped before the end of the document.
  partialNote: string | null;
};

/**
 * Read a delivery order: the whole file in one call; when that answer is cut at
 * max_tokens and the file is a multi-page PDF, page by page, merged into one
 * read. `beforePages` runs first (the caller keeps its job alive meanwhile).
 */
export async function readDeliveryOrder(
  fileBlocks: ContentBlock[],
  firstBuffer: ArrayBuffer | null,
  read: (blocks: ContentBlock[]) => Promise<GrnExtractCall>,
  beforePages: () => Promise<void>,
): Promise<DeliveryOrderRead> {
  const first = await read(fileBlocks);
  const base = { errorMsg: first.errorMsg, claudeText: first.claudeText };
  if (!first.truncated) return { ...base, parsed: first.parsed, failed: first.parsed == null && first.errorMsg != null, partialNote: null };
  const pdf = singlePdf(fileBlocks, firstBuffer);
  const pageCount = pdf ? await pdfPageCount(pdf) : 0;
  if (!pdf || pageCount < 2) {
    return { ...base, parsed: first.parsed, failed: false, partialNote: partialReadNote(first.parsed?.lines.length ?? 0, null, null) };
  }
  await beforePages();
  const paged = await readPageByPage(pdf, pageCount, first, read);
  return { ...base, parsed: paged.parsed, failed: false, partialNote: paged.note };
}
