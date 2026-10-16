/* BUG-28 — a line remark "AEON RAWANG March 24, 2026 → March 29, 2026" on
   HC-PO-2609-266 refused the whole PO PDF ("a character we cannot print yet"):
   the glyph pre-check scanned the raw "→", which neither Noto subset carries,
   although paperText already folds it to "->" for paper. The check now scans
   the folded text, and the doc folds the same symbols wherever it paints or
   measures, autotable cells included. */
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

/* HC-PCO-2610-001 — nine lines of the AKEMI KŌRI range: "Ō" (U+014C) is in
   neither WinAnsi nor the Noto subsets, so the whole PCO PDF was refused. */
describe('accented Latin outside WinAnsi prints as its base letter', () => {
  it('a KŌRI line passes the glyph check with no font fetch and paints KORI', async () => {
    const fetchSpy = vi.fn();
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
    expect(fetchSpy).not.toHaveBeenCalled();

    autoTable(doc, { body: [['AK-KŌRI ISHI-K', 'AKEMI KŌRI ISHI MATT (K)']] });
    const flat = painted.flat().map(String);
    expect(flat).toEqual(expect.arrayContaining(['AK-KORI ISHI-K', 'AKEMI KORI ISHI MATT (K)']));
    expect(flat.some((s) => s.includes('Ō'))).toBe(false);
  });

  it('keeps what already prints: Latin-1, the WinAnsi extras, CJK and Hangul', () => {
    expect(paperText('Ōōāēīū Ūrūmqi Łódź')).toBe('Ooaeiu Urumqi Łódz');
    expect(paperText('Café Müller Š Ž Œ')).toBe('Café Müller Š Ž Œ');
    expect(paperText('陈大文 豈 한')).toBe('陈大文 豈 한');
  });
});
