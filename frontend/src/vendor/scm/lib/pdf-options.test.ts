/* Sister-ERP gap review G13 + G11.
   - Every jsPDF the app constructs spreads PDF_COMPRESS, and that really shrinks
     the file (the sample batch's sizes are printed for the PR).
   - A batch print numbers each document's own pages: the second GRN in a
     combined file starts at "Page 1", not "Page 2 of 2". */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_BRANDING, clearBrandingLogoCache, setBrandingCache } from '../../../lib/branding';
import { docPageLabel } from './pdf-common';
import { PDF_COMPRESS } from './pdf-options';
import { pdfRawText } from './pdf-raw-text';

const SRC = join(__dirname, '../../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

const grn = (n: string) => ({
  grn_number: n, status: 'POSTED', received_at: '2026-11-09', delivery_note_ref: null, notes: null,
  posted_at: null, supplier_id: null, supplier: { code: 'S-1', name: 'Supplier Sdn Bhd' },
});
const grnLines = (count: number) => Array.from({ length: count }, (_, i) => ({
  item_code: `GR-${i}`, material_name: `Foam block ${i}`, qty_received: 1, qty_accepted: 1, qty_rejected: 0,
  rejection_reason: null, unit_price_sen: 1000, supplier_sku: `S-${i}`,
}));

async function renderBatch(compress: boolean): Promise<{ bytes: number; pageLabels: string[] }> {
  setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
  const [{ jsPDF }, { default: autoTable }, { renderGrnInto }] = await Promise.all([
    import('jspdf'), import('jspdf-autotable'), import('./grn-pdf'),
  ]);
  const doc = new jsPDF(compress ? { ...PDF_COMPRESS, unit: 'mm', format: 'a4' } : { unit: 'mm', format: 'a4' });
  await renderGrnInto(doc, autoTable, grn('HC-GRN-2611-001'), grnLines(60));
  doc.addPage();
  await renderGrnInto(doc, autoTable, grn('HC-GRN-2611-002'), grnLines(3));
  const out = new Uint8Array(doc.output('arraybuffer'));
  const pageLabels = [...pdfRawText(out).matchAll(/\((Page \d+ of \d+)\)/g)].map((m) => m[1]!);
  return { bytes: out.byteLength, pageLabels };
}

afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
  clearBrandingLogoCache();
  vi.restoreAllMocks();
});

describe('PDF compression', () => {
  test('every jsPDF constructed in frontend/src spreads PDF_COMPRESS', () => {
    const missing: string[] = [];
    for (const f of sourceFiles(SRC)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/new jsPDF\(([^)]*)/g)) {
        if (!m[1]!.includes('...PDF_COMPRESS')) missing.push(`${relative(SRC, f)}: ${m[0]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('a compressed batch is smaller than the same batch uncompressed', async () => {
    const plain = await renderBatch(false);
    const packed = await renderBatch(true);
    console.info(`[pdf-size] 2-GRN batch (60 + 3 lines): uncompressed ${plain.bytes} B, compressed ${packed.bytes} B`);
    expect(packed.bytes).toBeLessThan(plain.bytes / 2);
    expect(packed.pageLabels).toEqual(plain.pageLabels);
  });
});

describe('batch page numbers', () => {
  test('docPageLabel counts within the document', () => {
    expect(docPageLabel(3, 3, 4)).toBe('Page 1 of 2');
    expect(docPageLabel(4, 3, 4)).toBe('Page 2 of 2');
    expect(docPageLabel(1, 1, 1)).toBe('Page 1 of 1');
  });

  test('the second GRN in a combined file starts again at Page 1', async () => {
    const { pageLabels } = await renderBatch(true);
    expect(pageLabels.length).toBeGreaterThanOrEqual(3);
    const first = pageLabels.slice(0, -1);
    const firstTotal = first.length;
    expect(first).toEqual(first.map((_, i) => `Page ${i + 1} of ${firstTotal}`));
    expect(pageLabels.at(-1)).toBe('Page 1 of 1');
  });
});
