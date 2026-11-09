/* The AI fallback for invoice rows the rules left untied (owner 2026-11-09: "if it's
 * similar it should AI-match"): what it is asked, and which answers are kept. */
import { describe, expect, test } from 'vitest';
import { buildAiMatchPrompt, parseAiMatches, rowSize, type AiRow, type AiSku } from './pi-scan-ai-match';

const rows: AiRow[] = [
  { n: 1, code: '2137-(K)', description: 'BREEVA BEDFRAME (6FT)', size: 'K', unitPrice: 520 },
  { n: 2, code: '1013-(Q)', description: 'JAGER BEDFRAME (5FT) (152X190CM)', size: 'Q', unitPrice: 480 },
  { n: 3, code: '1005', description: 'BEDFRAME 5FT', size: 'Q', unitPrice: 300 },
];
const skus: AiSku[] = [
  { itemCode: 'BREEVA-(K)', description: 'BREEVA BED FRAME KING', supplierSku: null, grns: 'HC-GRN-2610-044 (left 2)' },
  { itemCode: 'JAGER-(Q)', description: 'JAGER BED FRAME QUEEN', supplierSku: '1013-(Q)', grns: 'HC-GRN-2610-012 (left 1)' },
  { itemCode: 'JAGER-(K)', description: 'JAGER BED FRAME KING', supplierSku: null, grns: 'HC-GRN-2610-012 (left 1)' },
];
const answer = (matches: unknown[]) => JSON.stringify({ matches });

describe('the prompt', () => {
  test('carries every row and every open SKU with its receipts, and asks for JSON with a confidence', () => {
    const p = buildAiMatchPrompt(rows, skus);
    expect(p).toContain('1. code: 2137-(K) | description: BREEVA BEDFRAME (6FT) | size: K | unit price: 520');
    expect(p).toContain('JAGER-(Q) | JAGER BED FRAME QUEEN | supplier code: 1013-(Q) | open on: HC-GRN-2610-012 (left 1)');
    expect(p).toContain('"confidence"');
    expect(p).toContain('answer null');
  });
  test('the size a row prints: its code tag first, then its name', () => {
    expect(rowSize('1013-(Q)', 'JAGER (6FT)')).toBe('Q');
    expect(rowSize('1005', 'BEDFRAME 152X190CM')).toBe('Q');
    expect(rowSize('1005', 'BEDFRAME')).toBeNull();
  });
});

describe('the answer', () => {
  test('a high-confidence answer naming a listed SKU of the row\'s size is kept, in a fence or not', () => {
    const text = '```json\n' + answer([{ row: 1, sku: 'BREEVA-(K)', confidence: 'high' }, { row: 2, sku: 'jager-(q)', confidence: 0.95 }]) + '\n```';
    expect(Object.fromEntries(parseAiMatches(text, rows, skus))).toEqual({ 1: 'BREEVA-(K)', 2: 'JAGER-(Q)' });
  });
  test('bad JSON, no answer or the wrong shape: nothing', () => {
    expect(parseAiMatches('not json at all', rows, skus).size).toBe(0);
    expect(parseAiMatches(null, rows, skus).size).toBe(0);
    expect(parseAiMatches('{"matches": "BREEVA-(K)"}', rows, skus).size).toBe(0);
  });
  test('a SKU we did not list, a row we did not send, or a guess below high: dropped', () => {
    const text = answer([
      { row: 1, sku: 'BREEVA-(SK)', confidence: 'high' },
      { row: 9, sku: 'JAGER-(Q)', confidence: 'high' },
      { row: 2, sku: 'JAGER-(Q)', confidence: 'medium' },
      { row: 3, sku: null, confidence: 'high' },
    ]);
    expect(parseAiMatches(text, rows, skus).size).toBe(0);
  });
  test('a SKU of another size than the row prints is dropped, by its code or by its name', () => {
    expect(parseAiMatches(answer([{ row: 2, sku: 'JAGER-(K)', confidence: 'high' }]), rows, skus).size).toBe(0);
    expect(parseAiMatches(answer([{ row: 3, sku: 'JAGER-(K)', confidence: 'high' }]), rows, skus).size).toBe(0);
  });
});
