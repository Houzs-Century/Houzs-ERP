/* BUG-28 — a line remark "AEON RAWANG March 24, 2026 → March 29, 2026" on
   HC-PO-2609-266 refused the whole PO PDF ("a character we cannot print yet"):
   the glyph pre-check scanned the raw "→", which neither Noto subset carries,
   although paperText already folds it to "->" for paper. The check now scans
   the folded text, and the doc folds the same symbols wherever it paints or
   measures, autotable cells included. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { ensurePdfCjkFont } from './pdf-common';

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
