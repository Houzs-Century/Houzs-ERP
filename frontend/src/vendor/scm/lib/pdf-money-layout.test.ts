import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_BRANDING,
  clearBrandingLogoCache,
  setBrandingCache,
} from '../../../lib/branding';

type JsPdf = import('jspdf').jsPDF;

type TextDraw = { text: string; y: number };

function captureTextDraws(doc: JsPdf): TextDraw[] {
  const draws: TextDraw[] = [];
  const original = doc.text.bind(doc);
  vi.spyOn(doc, 'text').mockImplementation(((...args: Parameters<typeof doc.text>) => {
    const [value, , y] = args;
    if (typeof y === 'number') {
      const lines = Array.isArray(value) ? value.map(String) : [String(value)];
      for (const line of lines) draws.push({ text: line.trim(), y });
    }
    return original(...args);
  }) as typeof doc.text);
  return draws;
}

function yOf(draws: TextDraw[], label: string): number {
  const hit = draws.find((d) => d.text === label);
  if (!hit) {
    throw new Error(
      `"${label}" was never drawn. Drawn labels: ${draws.map((d) => d.text).join(' | ')}`,
    );
  }
  return hit.y;
}

function rowYsFor(draws: TextDraw[], codes: string[]): number[] {
  const ys = codes.map((code) => {
    const hit = draws.find((d) => d.text === code);
    if (!hit) {
      throw new Error(
        `Line-item code "${code}" was never drawn as a whole cell (did it wrap?). `
        + `Drawn text: ${draws.map((d) => d.text).join(' | ')}`,
      );
    }
    return hit.y;
  });
  return ys;
}

function readFinalY(doc: JsPdf): number | undefined {
  return (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY;
}

afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
  clearBrandingLogoCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('money PDFs place the totals block below the line items', () => {
  test('jspdf-autotable publishes lastAutoTable.finalY and refreshes it per table', async () => {
    const { jsPDF } = await import('jspdf');
    const autoTable = (await import('jspdf-autotable')).default;

    expect(typeof autoTable).toBe('function');

    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    expect(readFinalY(doc)).toBeUndefined();

    const firstStartY = 40;
    autoTable(doc, {
      startY: firstStartY,
      head: [['#', 'Item']],
      body: [['1', 'A'], ['2', 'B'], ['3', 'C']],
    });

    const firstFinalY = readFinalY(doc);
    expect(typeof firstFinalY).toBe('number');
    expect(Number.isFinite(firstFinalY)).toBe(true);
    expect(firstFinalY).toBeGreaterThan(firstStartY);

    const secondStartY = firstFinalY! + 10;
    autoTable(doc, {
      startY: secondStartY,
      head: [['Payment']],
      body: [['1'], ['2']],
    });

    const secondFinalY = readFinalY(doc);
    expect(secondFinalY).toBeGreaterThan(secondStartY);
    expect(secondFinalY).toBeGreaterThan(firstFinalY!);
  });

  test('a real Sales Invoice draws Subtotal / GRAND TOTAL below the last line item', async () => {
    setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');

    const [{ jsPDF }, { default: autoTable }, { renderSalesInvoiceInto }] =
      await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
        import('./sales-invoice-pdf'),
      ]);

    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const draws = captureTextDraws(doc);

    const itemCodes = ['SKU-A', 'SKU-B', 'SKU-C'];
    await renderSalesInvoiceInto(
      doc,
      autoTable,
      {
        invoice_number: 'SI-MONEY-001',
        status: 'issued',
        so_doc_no: 'SO-MONEY-001',
        debtor_code: 'CUST-001',
        debtor_name: 'Money Layout Sdn Bhd',
        invoice_date: '2026-07-21',
        due_date: '2026-08-21',
        currency: 'MYR',
        subtotal_sen: 300000,
        discount_sen: 0,
        tax_sen: 0,
        total_sen: 300000,
        paid_sen: 100000,
        notes: null,
        address1: '1 Jalan Test',
        city: 'Seri Kembangan',
        state: 'Selangor',
        postcode: '43300',
      },
      itemCodes.map((code, idx) => ({
        item_code: code,
        description: `Line item ${idx + 1}`,
        qty: 1,
        unit_price_sen: 100000,
        line_total_sen: 100000,
      })),
    );

    expect(doc.getNumberOfPages()).toBe(1);

    const itemRowYs = rowYsFor(draws, itemCodes);
    const lastItemRowY = Math.max(...itemRowYs);

    const finalY = readFinalY(doc);
    expect(Number.isFinite(finalY)).toBe(true);
    expect(finalY).toBeGreaterThan(lastItemRowY);

    const subtotalY = yOf(draws, 'Subtotal');
    const grandTotalY = yOf(draws, 'GRAND TOTAL');
    const outstandingY = yOf(draws, 'Outstanding');

    expect(subtotalY).toBeGreaterThan(lastItemRowY);
    expect(subtotalY).toBeGreaterThan(finalY!);
    expect(grandTotalY).toBeGreaterThan(subtotalY);
    expect(outstandingY).toBeGreaterThan(grandTotalY);
  }, 20_000);

  test('a real Sales Order draws BALANCE DUE below both the items and payments tables', async () => {
    setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');

    const [{ jsPDF }, { default: autoTable }, { renderSalesOrderInto }] =
      await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
        import('./sales-order-pdf'),
      ]);

    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const draws = captureTextDraws(doc);

    const itemCodes = ['SO-A', 'SO-B'];
    await renderSalesOrderInto(
      doc,
      autoTable,
      {
        doc_no: 'SO-MONEY-002',
        so_date: '2026-07-21',
        status: 'processing',
        debtor_code: 'CUST-002',
        debtor_name: 'Double Table Sdn Bhd',
        agent: null,
        branding: null,
        venue: null,
        ref: null,
        po_doc_no: null,
        phone: null,
        address1: '2 Jalan Test',
        address2: null,
        address3: null,
        address4: null,
        mattress_sofa_sen: 0,
        bedframe_sen: 200000,
        accessories_sen: 0,
        others_sen: 0,
        local_total_sen: 200000,
        line_count: itemCodes.length,
        currency: 'MYR',
        note: null,
        paid_sen_total: 50000,
      },
      itemCodes.map((code, idx) => ({
        id: `item-${idx + 1}`,
        item_group: 'BEDFRAME',
        item_code: code,
        description: `Sales order line ${idx + 1}`,
        uom: 'UNIT',
        qty: 1,
        unit_price_sen: 100000,
        discount_sen: 0,
        total_sen: 100000,
        variants: null,
      })),
      [{
        paid_at: '2026-07-21',
        method: 'cash',
        merchant_provider: null,
        installment_months: null,
        approval_code: 'APPROVAL-XYZ',
        amount_sen: 50000,
        account_sheet: null,
        collected_by_name: 'Cashier One',
        note: null,
      }],
    );

    const itemRowYs = rowYsFor(draws, itemCodes);
    const lastItemRowY = Math.max(...itemRowYs);

    const paymentsHeadingY = yOf(draws, 'PAYMENTS RECEIVED');
    expect(paymentsHeadingY).toBeGreaterThan(lastItemRowY);

    const paymentRowY = yOf(draws, 'APPROVAL-XYZ');
    expect(paymentRowY).toBeGreaterThan(paymentsHeadingY);

    const subtotalY = yOf(draws, 'Subtotal');
    const balanceDueY = yOf(draws, 'BALANCE DUE');
    expect(subtotalY).toBeGreaterThan(paymentRowY);
    expect(balanceDueY).toBeGreaterThan(subtotalY);
  }, 20_000);
});
