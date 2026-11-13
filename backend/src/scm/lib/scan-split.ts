// ---------------------------------------------------------------------------
// scan-split — one uploaded PDF may carry many documents (twenty delivery
// orders printed into one file). Ask a small model where each document starts
// and ends, then cut the PDF into one file per document, so each becomes its
// own scan (owner 2026-11-03, after Hookka's detectSupplierDocBoundaries).
//
// A failed or doubtful answer never loses pages: the file is kept whole as one
// document (planChunks), the same as before the split existed.
// ---------------------------------------------------------------------------

import { recordAi, type AiUsageTag } from '../../services/aiUsage';
import { anthropicFetchWithRetry, stripJsonFences, toBase64, type AnthropicResponse } from './scan-ocr';

export const BOUNDARY_MODEL = 'claude-haiku-4-5';

export type PageChunk = { startPage: number; endPage: number };

const docNoKey = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : null);

const BOUNDARY_PROMPT = `You receive a PDF that may bundle several separate supplier documents (delivery orders, delivery notes, invoices) one after another.

Return ONLY where each document starts and ends. Do not read line items.

Output valid JSON only: {"chunks": [{"startPage": 1, "endPage": 2, "docNo": "DO-2611-037"}, {"startPage": 3, "endPage": 3, "docNo": "DO-2611-040"}]}

Rules:
- Pages are numbered from 1.
- One chunk = one document. A document continued over several pages ("Page 1 of 2", "Page 2 of 2", same document number) is one chunk.
- A new chunk starts when the document number changes, or the supplier letterhead changes.
- Cover every page exactly once; the last chunk ends on the last page.
- If the whole PDF is one document, return one chunk covering every page.
- docNo is the document number printed on that chunk's first page (D.O. No / Invoice No), else null.`;

/** The chunks to scan for a PDF of `pageCount` pages, from the model's answer.
 *  Anything that does not cover every page exactly once, in order, falls back
 *  to the whole file as one document: a wrong split would mix two documents or
 *  drop a page, both worse than one scan of the whole file. */
export function planChunks(answer: unknown, pageCount: number): PageChunk[] {
  const whole = [{ startPage: 1, endPage: Math.max(1, pageCount) }];
  if (pageCount <= 1) return whole;
  const raw = (answer as { chunks?: unknown } | null)?.chunks;
  if (!Array.isArray(raw) || raw.length === 0) return whole;
  const chunks: PageChunk[] = [];
  let next = 1;
  let lastDocNo: string | null = null;
  for (const c of raw) {
    const start = Number((c as { startPage?: unknown }).startPage);
    const end = Number((c as { endPage?: unknown }).endPage);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start !== next || end < start || end > pageCount) return whole;
    // Pages that carry the same document number are one document printed over
    // several pages (Hookka DO-2611-037, 3 pages): never split them apart.
    const docNo = docNoKey((c as { docNo?: unknown }).docNo);
    if (docNo && docNo === lastDocNo) chunks[chunks.length - 1].endPage = end;
    else chunks.push({ startPage: start, endPage: end });
    lastDocNo = docNo;
    next = end + 1;
  }
  return next === pageCount + 1 ? chunks : whole;
}

export async function pdfPageCount(bytes: ArrayBuffer): Promise<number> {
  try {
    const { PDFDocument } = await import('pdf-lib');
    return (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount();
  } catch {
    return 0;
  }
}

/** Ask the model for the chunks of a multi-page PDF; null when it could not answer. */
export async function askBoundaries(apiKey: string, bytes: ArrayBuffer, usage: AiUsageTag): Promise<unknown> {
  try {
    const resp = await recordAi(usage, anthropicFetchWithRetry({
      method: 'POST',
      signal: AbortSignal.timeout(90_000),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: BOUNDARY_MODEL,
        max_tokens: 2048,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: BOUNDARY_PROMPT },
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(bytes) } },
            { type: 'text', text: 'Return the chunks JSON only. First character "{", last "}".' },
          ],
        }],
      }),
    }));
    if (!resp.ok) { console.warn('[scan-split] boundary call failed:', resp.status); return null; }
    const body = (await resp.json()) as AnthropicResponse;
    const text = body.content?.find((b) => b.type === 'text')?.text ?? '';
    return JSON.parse(stripJsonFences(text)) as unknown;
  } catch (e) {
    console.warn('[scan-split] boundary call threw:', (e as Error).message);
    return null;
  }
}

/** One PDF per chunk. A chunk that cannot be cut is dropped from the split by
 *  returning the whole file instead, so no page is ever lost. */
export async function cutPdf(bytes: ArrayBuffer, chunks: PageChunk[]): Promise<Array<{ chunk: PageChunk; bytes: ArrayBuffer }>> {
  if (chunks.length <= 1) return [{ chunk: chunks[0] ?? { startPage: 1, endPage: 1 }, bytes }];
  try {
    const { PDFDocument } = await import('pdf-lib');
    const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const out: Array<{ chunk: PageChunk; bytes: ArrayBuffer }> = [];
    for (const chunk of chunks) {
      const child = await PDFDocument.create();
      const idx = Array.from({ length: chunk.endPage - chunk.startPage + 1 }, (_, i) => chunk.startPage - 1 + i);
      for (const p of await child.copyPages(source, idx)) child.addPage(p);
      const saved = await child.save();
      out.push({ chunk, bytes: saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer });
    }
    return out;
  } catch (e) {
    console.warn('[scan-split] cut failed, scanning the whole file:', (e as Error).message);
    return [{ chunk: { startPage: 1, endPage: chunks[chunks.length - 1].endPage }, bytes }];
  }
}
