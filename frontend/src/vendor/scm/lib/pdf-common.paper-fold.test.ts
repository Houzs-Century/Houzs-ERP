/* BUG-28 — a line remark "AEON RAWANG March 24, 2026 → March 29, 2026" on
   HC-PO-2609-266 refused the whole PO PDF ("a character we cannot print yet"):
   the glyph pre-check scanned the raw "→", which neither Noto subset carries,
   although paperText already folds it to "->" for paper. The check now scans
   the folded text, and the doc folds the same symbols wherever it paints or
   measures, autotable cells included. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { ensurePdfCjkFont, paperText } from './pdf-common';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const REMARK = 'KL - Akemi - SOLO  - AEON RAWANG March 24, 2026 → March 29, 2026';

describe('paper folds (→ ← − ≈) never block a PDF', () => {
  it('a remark carrying "→" passes the glyph check with no font fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const doc = new jsPDF();
    await expect(
      ensurePdfCjkFont(doc, [{ po_number: 'HC-PO-2609-266' }, [{ notes: REMARK }]]),
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('paints and measures the folded text, in direct draws and autotable cells', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const doc = new jsPDF();
    const painted: unknown[] = [];
    const inner = doc.text.bind(doc);
    doc.text = ((t: string | string[], ...rest: unknown[]) => {
      painted.push(t);
      return (inner as (...a: unknown[]) => unknown)(t, ...rest);
    }) as typeof doc.text;
    await ensurePdfCjkFont(doc, { notes: REMARK });

    doc.text(`Remark: ${REMARK}`, 10, 10);
    doc.text(['a ← b', 'x ≈ 1', '−5'], 10, 20);
    expect(doc.splitTextToSize('p → q', 200)).toEqual(['p -> q']);
    expect(doc.getTextWidth('p → q')).toBe(doc.getTextWidth('p -> q'));
    autoTable(doc, { body: [[REMARK]] });

    const flat = painted.flat().map(String);
    expect(flat).toContain('Remark: KL - Akemi - SOLO  - AEON RAWANG March 24, 2026 -> March 29, 2026');
    expect(flat).toEqual(expect.arrayContaining(['a <- b', 'x ~ 1', '-5']));
    expect(flat.some((s) => s.includes('March 24, 2026 -> March 29, 2026') && !s.startsWith('Remark'))).toBe(true);
    expect(flat.some((s) => /[→←−≈]/.test(s))).toBe(false);
  });

  it('a second call on the same doc (combined export) does not fold twice or throw', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const doc = new jsPDF();
    await ensurePdfCjkFont(doc, { notes: REMARK });
    const textAfterFirst = doc.text;
    await ensurePdfCjkFont(doc, { notes: 'next → doc' });
    expect(doc.text).toBe(textAfterFirst);
  });
});

/* HC-PCO-2610-001 — nine lines of the "AKEMI KŌRI" range. Owner's call
   (2026-10-16) reversed the earlier fold (#4697): "Ō" (U+014C) must PRINT with
   its macron, not collapse to "KORI". The punct + hanzi Noto subsets now carry
   Latin Extended-A, so a macron name embeds and prints, while real Chinese and
   plain WinAnsi documents are unchanged. These load the COMMITTED subsets through
   the real jsPDF cmap guard, so they also fail if a future font drops the macrons. */
describe('romaji macron letters embed in the Noto subset (no fold)', () => {
  // vitest runs with cwd at the frontend root, where the committed subsets live.
  const faceFetch = () =>
    vi.fn((url: string) => {
      const name = String(url).split('/').pop() ?? '';
      const buf = readFileSync(join(process.cwd(), 'public', 'fonts', name));
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(ab) } as Response);
    });

  it('a KŌRI line passes the glyph guard and paints the macron through Noto', async () => {
    const fetchSpy = faceFetch();
    vi.stubGlobal('fetch', fetchSpy);
    const doc = new jsPDF();
    const painted: unknown[] = [];
    const inner = doc.text.bind(doc);
    doc.text = ((t: string | string[], ...rest: unknown[]) => {
      painted.push(t);
      return (inner as (...a: unknown[]) => unknown)(t, ...rest);
    }) as typeof doc.text;
    await expect(ensurePdfCjkFont(doc, [
      { po_number: 'HC-PCO-2610-001' },
      [{ item_code: 'AKEMI KŌRI ISHI MATT (K)', supplier_sku: 'AK-KŌRI ISHI-K' }],
    ])).resolves.toBeUndefined();
    // A macron letter is not isHanzi -> the cheap PUNCT tier, both weights.
    const urls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes('noto-sans-sc-punct-400'))).toBe(true);
    expect(urls.some((u) => u.includes('noto-sans-sc-punct-700'))).toBe(true);
    expect(urls.some((u) => u.includes('hanzi'))).toBe(false);
    expect(Object.keys(doc.getFontList())).toContain('NotoSansSC');

    // The macron survives to paper (NOT folded to "KORI"), autotable cells too.
    autoTable(doc, { body: [['AK-KŌRI ISHI-K', 'AKEMI KŌRI ISHI MATT (K)']] });
    const flat = painted.flat().map(String);
    expect(flat).toEqual(expect.arrayContaining(['AK-KŌRI ISHI-K', 'AKEMI KŌRI ISHI MATT (K)']));
    expect(flat.some((s) => s.includes('KORI'))).toBe(false);
  });

  it('a document with real Chinese still routes to the hanzi subset', async () => {
    const fetchSpy = faceFetch();
    vi.stubGlobal('fetch', fetchSpy);
    const doc = new jsPDF();
    // Resolve or throw by glyph, but the tier is chosen and fetched before the
    // cmap guard — that routing is what this pins.
    await ensurePdfCjkFont(doc, { customer: '大文 Sdn Bhd' }).catch(() => undefined);
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes('noto-sans-sc-hanzi'))).toBe(true);
  });

  it('paperText folds its symbols but no longer strips the macron; Latin-1/CJK/Hangul intact', () => {
    expect(paperText('AKEMI KŌRI → x')).toBe('AKEMI KŌRI -> x');
    expect(paperText('Ōōāēīū Café Müller Š Ž Œ')).toBe('Ōōāēīū Café Müller Š Ž Œ');
    expect(paperText('陈大文 豈 한')).toBe('陈大文 豈 한');
  });

  it('a pure-WinAnsi document still fetches no font', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const doc = new jsPDF();
    await expect(
      ensurePdfCjkFont(doc, { supplier: 'Cafe Sdn Bhd', notes: 'plain ascii only' }),
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
