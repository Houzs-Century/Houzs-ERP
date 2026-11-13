/* 2026-11-13, Hookka DO-2611-037 (25 sets over 3 pages, handwritten racks): the
   read call failed with Anthropic 503 and the scan came back as an empty row,
   "We could not read any lines", which every re-upload then reused. A failed
   call must fail (Read again), a cut answer must keep its lines and say it is
   partial, and a multi-page DO stays ONE read with every page's lines. */
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  callClaudeGrExtract, mergePageReads, normalizeGrnExtract, salvageTruncatedJson,
  type GrnExtractCall, type GrnExtracted, type GrnExtractedLine,
} from './grn-scan-extract';
import { readDeliveryOrder } from './grn-scan-pages';
import { planChunks } from './scan-split';
import { rackKey, resolveRack } from './grn-scan-racks';
import { hasLines } from '../routes/scan-check-shared';
import type { AiUsageTag } from '../../services/aiUsage';

const usage = { env: {}, feature: 'scan_gr', model: 'test', companyId: 1, userId: 1, waitUntil: null } as unknown as AiUsageTag;
const header = { supplierName: 'HOOKKA INDUSTRIES SDN BHD', poNo: null, doNo: 'DO-2611-037', deliveryDate: '2026-11-11' };
const line = (n: number, rack: string | null = null): GrnExtractedLine => ({
  itemCode: `BF-${n}`, barcode: null, description: `Bedframe ${n}`, qty: 1, poNo: `HC-PO-2611-0${n}`, rack,
});
const doc = (lines: GrnExtractedLine[], head = header): GrnExtracted => ({ ...head, lines });
const answer = (text: string, stop: string) => new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: stop }), { status: 200 });

afterEach(() => { vi.unstubAllGlobals(); });

describe('the read call', () => {
  test('an answer cut at max_tokens mid-JSON keeps every complete line and says it was cut', async () => {
    const full = JSON.stringify(doc([line(1), line(2), line(3)]));
    const cut = full.slice(0, full.indexOf('BF-3') + 6);
    vi.stubGlobal('fetch', vi.fn(async () => answer(cut, 'max_tokens')));
    const got = await callClaudeGrExtract('k', [], '', usage);
    expect(got.truncated).toBe(true);
    expect(got.errorMsg).toBeNull();
    expect(got.parsed?.doNo).toBe('DO-2611-037');
    expect(got.parsed?.lines.map((l) => l.itemCode)).toEqual(['BF-1', 'BF-2']);
  });

  test('an Anthropic 503 reads nothing and reports the error, never an empty delivery order', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"credential validation failed"}}', { status: 503 })));
    const got = await callClaudeGrExtract('k', [], '', usage);
    expect(got.parsed).toBeNull();
    expect(got.errorMsg).toMatch(/Anthropic 503/);
  });

  test('a cut before the first line closed still keeps the header', () => {
    expect(salvageTruncatedJson('{"supplierName":"HOOKKA","poNo":null,"doNo":"DO-2611-037","deliveryDate":null,"lines":[{"itemCode":"BF-')).toMatchObject({ doNo: 'DO-2611-037', lines: [] });
    expect(salvageTruncatedJson('not json')).toBeNull();
  });
});

const pdfOf = async (pages: number): Promise<ArrayBuffer> => {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) d.addPage([595, 842]);
  const b = await d.save();
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const call = (parsed: GrnExtracted | null, over: Partial<GrnExtractCall> = {}): GrnExtractCall => ({
  parsed, errorMsg: parsed ? null : 'Anthropic 503: credential validation failed', timedOut: false, claudeText: '', cacheHit: false, truncated: false, ...over,
});
const pdfBlock = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: '' } }];

describe('a delivery order over three pages', () => {
  test('pages repeating the DO-2611-037 header merge into one read with every line, header from page 1', () => {
    const p1 = doc([line(1, 'L9.1'), line(2, 'L8.1')]);
    const p2 = doc([line(3, 'L12.1')], { ...header, deliveryDate: null });
    const p3 = doc([line(4)], { ...header, supplierName: 'HOOKKA' });
    const { parsed, pagesRead } = mergePageReads([p1, p2, p3]);
    expect(pagesRead).toBe(3);
    expect(parsed).toMatchObject(header);
    expect(parsed?.lines.map((l) => l.itemCode)).toEqual(['BF-1', 'BF-2', 'BF-3', 'BF-4']);
  });

  test('a whole-file read cut at max_tokens is read page by page into ONE read, no note when every page read', async () => {
    const pdf = await pdfOf(3);
    const pages = [doc([line(1), line(2)]), doc([line(3), line(4)]), doc([line(5)])];
    let n = 0;
    const read = vi.fn(async () => (n++ === 0 ? call(doc([line(1)]), { truncated: true }) : call(pages[n - 2])));
    const kept = vi.fn(async () => {});
    const got = await readDeliveryOrder(pdfBlock, pdf, read, kept);
    expect(read).toHaveBeenCalledTimes(4);
    expect(kept).toHaveBeenCalledOnce();
    expect(got.failed).toBe(false);
    expect(got.partialNote).toBeNull();
    expect(got.parsed?.doNo).toBe('DO-2611-037');
    expect(got.parsed?.lines).toHaveLength(5);
  });

  test('a page that fails leaves a clear note: read 2 of 3 pages, check the rest', async () => {
    const pdf = await pdfOf(3);
    const pages = [call(doc([line(1), line(2)])), call(null), call(doc([line(5)]))];
    let n = 0;
    const read = vi.fn(async () => (n++ === 0 ? call(doc([line(1)]), { truncated: true }) : pages[n - 2]));
    const got = await readDeliveryOrder(pdfBlock, pdf, read, async () => {});
    expect(got.parsed?.lines).toHaveLength(3);
    expect(got.partialNote).toMatch(/long.*Read 2 of 3 pages.*3 lines read: check the rest/s);
  });

  test('a failed whole-file call is a failure, not an empty delivery order', async () => {
    const got = await readDeliveryOrder(pdfBlock, await pdfOf(3), async () => call(null), async () => {});
    expect(got.failed).toBe(true);
    expect(got.parsed).toBeNull();
  });

  test('the split never cuts pages carrying the same DO number apart', () => {
    const same = { chunks: [1, 2, 3].map((p) => ({ startPage: p, endPage: p, docNo: 'DO-2611-037' })) };
    expect(planChunks(same, 3)).toEqual([{ startPage: 1, endPage: 3 }]);
    const two = { chunks: [{ startPage: 1, endPage: 1, docNo: 'DO-2611-037' }, { startPage: 2, endPage: 2, docNo: 'do 2611 037' }, { startPage: 3, endPage: 3, docNo: 'DO-2611-040' }] };
    expect(planChunks(two, 3)).toEqual([{ startPage: 1, endPage: 2 }, { startPage: 3, endPage: 3 }]);
  });

  test('an empty earlier read of the same file is not reused', () => {
    expect(hasLines({ v: 9, lines: [] })).toBe(false);
    expect(hasLines(null)).toBe(false);
    expect(hasLines({ v: 9, lines: [{}] })).toBe(true);
  });
});

describe('handwritten left-margin racks', () => {
  const racks = ['Rack L8.1', 'Rack L9.1', 'Rack L12.1', 'Rack R9.1'].map((rack, i) => ({ id: `r${i}`, rack }));
  test('L9.1 / L8.1 / L12.1 stay on their own row and map to that rack; a row with none stays blank', () => {
    const read = normalizeGrnExtract({ ...header, lines: [line(1, 'L9.1'), line(2, ' L8.1 '), line(3, 'L12.1'), line(4, null)] });
    expect(read.lines.map((l) => l.rack)).toEqual(['L9.1', 'L8.1', 'L12.1', null]);
    expect(read.lines.map((l) => l.poNo)).toEqual(['HC-PO-2611-01', 'HC-PO-2611-02', 'HC-PO-2611-03', 'HC-PO-2611-04']);
    expect(read.lines.map((l) => (l.rack ? resolveRack(l.rack, racks)?.rack : null))).toEqual(['Rack L9.1', 'Rack L8.1', 'Rack L12.1', null]);
  });
  test('a rack that is not on the shelf list, or order text, is never turned into one', () => {
    expect(resolveRack('L7.1', racks)).toBeNull();
    expect(rackKey('HC-SO-2611-012')).toBeNull();
  });
});
