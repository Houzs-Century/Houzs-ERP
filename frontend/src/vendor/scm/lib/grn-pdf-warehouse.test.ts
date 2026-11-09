/* Conts-ERP #717: the printed GRN names the warehouse the goods were received
   into, read off the GRN detail GET's warehouse_name (code as the fallback). A
   GRN that recorded none prints no Warehouse row rather than a dash. Asserted on
   what the generator DREW, like pdf-status-label.test.ts. */
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_BRANDING, clearBrandingLogoCache, setBrandingCache } from '../../../lib/branding';

type TextDraw = { text: string; x: number; y: number };

async function renderGrn(extra: Record<string, unknown>): Promise<TextDraw[]> {
  setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
  const [{ jsPDF }, { default: autoTable }, { renderGrnInto }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    import('./grn-pdf'),
  ]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const draws: TextDraw[] = [];
  const original = doc.text.bind(doc);
  vi.spyOn(doc, 'text').mockImplementation(((...args: Parameters<typeof doc.text>) => {
    const [value, x, y] = args;
    if (typeof x === 'number' && typeof y === 'number') {
      for (const line of Array.isArray(value) ? value.map(String) : [String(value)]) draws.push({ text: line.trim(), x, y });
    }
    return original(...args);
  }) as typeof doc.text);
  await renderGrnInto(doc, autoTable, {
    grn_number: 'HC-GRN-2611-001', status: 'POSTED', received_at: '2026-11-09',
    delivery_note_ref: null, notes: null, posted_at: null, supplier_id: null,
    supplier: { code: 'S-1', name: 'Supplier Sdn Bhd' },
    ...extra,
  }, [
    { item_code: 'GR-A', material_name: 'Foam', qty_received: 1, qty_accepted: 1, qty_rejected: 0, rejection_reason: null, unit_price_sen: 0, supplier_sku: 'S-A' },
  ]);
  return draws;
}

/* The value drawn on the "Warehouse" label's baseline, to its right. */
function warehouseValue(draws: TextDraw[]): string | null {
  const label = draws.find((d) => d.text === 'Warehouse');
  if (!label) return null;
  const right = draws.filter((d) => d.y === label.y && d.x > label.x && d.text.length > 0);
  if (right.length !== 1) throw new Error(`expected one value beside Warehouse, saw ${right.map((d) => d.text).join(' | ')}`);
  return right[0].text.replace(/^:\s*/, '');
}

afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
  clearBrandingLogoCache();
  vi.restoreAllMocks();
});

describe('GRN PDF: receiving warehouse', () => {
  test('prints the warehouse name in GRN DETAILS', async () => {
    const draws = await renderGrn({ warehouse_name: 'Balakong Warehouse', warehouse_code: 'BLK' });
    expect(warehouseValue(draws)).toBe('Balakong Warehouse');
  });

  test('falls back to the code when the warehouse has no name', async () => {
    const draws = await renderGrn({ warehouse_name: '  ', warehouse_code: 'BLK' });
    expect(warehouseValue(draws)).toBe('BLK');
  });

  test('a GRN with no warehouse prints no Warehouse row', async () => {
    const draws = await renderGrn({});
    expect(draws.some((d) => d.text === 'Warehouse')).toBe(false);
    expect(draws.some((d) => d.text === 'GRN DETAILS')).toBe(true);
  });
});
