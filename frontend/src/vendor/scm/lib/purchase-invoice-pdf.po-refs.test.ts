/* A purchase invoice billing lines from several POs prints ALL of them in its
   header (owner 2026-11-10), not only the header FK's first PO. Real jsPDF; the
   drawn text is captured off doc.text. */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_BRANDING, clearBrandingLogoCache, setBrandingCache } from '../../../lib/branding';

type JsPdf = import('jspdf').jsPDF;

function captureText(doc: JsPdf): string[] {
  const out: string[] = [];
  const original = doc.text.bind(doc);
  vi.spyOn(doc, 'text').mockImplementation(((...args: Parameters<typeof doc.text>) => {
    const [value] = args;
    for (const line of Array.isArray(value) ? value.map(String) : [String(value)]) out.push(line.trim());
    return original(...args);
  }) as typeof doc.text);
  return out;
}

async function render(lines: Array<{ source_po_number: string | null }>, headerPo: string | null) {
  setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const drawn = captureText(doc);
  const { renderPurchaseInvoiceInto } = await import('./purchase-invoice-pdf');
  await renderPurchaseInvoiceInto(doc, autoTable, {
    invoice_number: 'HC-PI-2611-001', supplier_invoice_ref: null, status: 'POSTED',
    invoice_date: '2026-11-10', due_date: null, currency: 'MYR',
    subtotal_sen: 0, tax_sen: 0, total_sen: 0, paid_sen: 0, notes: null,
    supplier_id: null, supplier: { code: 'S-1', name: 'Supplier Sdn Bhd' },
    purchase_order: headerPo ? { po_number: headerPo } : null,
  }, lines.map((l, i) => ({
    item_code: `PI-${i}`, material_name: 'Foam', qty: 1, unit_price_sen: 0, line_total_sen: 0,
    supplier_sku: 'S-A', source_po_number: l.source_po_number,
  })));
  return drawn.join('\n');
}

afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
  clearBrandingLogoCache();
  vi.restoreAllMocks();
});

describe('PI PDF — the PO reference lists every PO the lines bill', () => {
  test('lines from two POs print both, not only the header PO', async () => {
    const text = await render(
      [{ source_po_number: 'HC-PO-2610-202' }, { source_po_number: 'HC-PO-2610-125' }, { source_po_number: 'HC-PO-2610-202' }],
      'HC-PO-2610-125',
    );
    expect(text).toContain('PO Refs');
    expect(text).toContain(': HC-PO-2610-125, HC-PO-2610-202');
  });

  test('a long list prints two per line instead of running off the page, and nothing is dropped', async () => {
    const pos = Array.from({ length: 5 }, (_, i) => `HC-PO-2610-${200 + i}`);
    const text = await render(pos.map((p) => ({ source_po_number: p })), pos[0]!);
    expect(text).toContain(': HC-PO-2610-200, HC-PO-2610-201,');
    expect(text).toContain('HC-PO-2610-202, HC-PO-2610-203,');
    expect(text).toMatch(/\n\s*HC-PO-2610-204\n/);
  });

  test('no line names a PO: the header PO still prints, as before', async () => {
    const text = await render([{ source_po_number: null }], 'HC-PO-2610-125');
    expect(text).toContain('PO Ref');
    expect(text).toContain(': HC-PO-2610-125');
  });
});
