// Money-document layout regression cover for the jsPDF 4 / jspdf-autotable 5
// upgrade.
//
// Eight PDF renderers (SO, SI, PO, GRN, DO, DR, PR, PI) locate their totals
// block with the same expression:
//
//   const lastY = (doc.lastAutoTable?.finalY ?? y) + 6;
//
// `y` there is the line-item table's OWN startY. So if `lastAutoTable.finalY`
// ever stops being published — renamed, moved, or not set because the plugin
// was not applied — the optional chain swallows it and the totals block is
// drawn back at the top of the table, ON TOP of the line items. No exception,
// no failing typecheck: just a customer invoice whose GRAND TOTAL overprints
// the goods. That is the failure this file exists to catch.
//
// The pre-existing dependencySecurity.test.ts smoke covers the Delivery Order,
// which is the one document that deliberately renders no money. These tests
// cover documents that DO render a totals block, and assert position, not just
// that bytes came out.
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_BRANDING,
  clearBrandingLogoCache,
  setBrandingCache,
} from '../../../lib/branding';

type JsPdf = import('jspdf').jsPDF;

/* Every text draw in order, with the y it landed on. autoTable paints its own
   cells through the same doc.text, so one spy sees both the table rows and the
   totals block and they are directly comparable. */
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

/* Fails loudly with the labels that WERE drawn — a renamed label should read as
   a broken test, not as a silently-passing comparison against undefined. */
function yOf(draws: TextDraw[], label: string): number {
  const hit = draws.find((d) => d.text === label);
  if (!hit) {
    throw new Error(
      `"${label}" was never drawn. Drawn labels: ${draws.map((d) => d.text).join(' | ')}`,
    );
  }
  return hit.y;
}

/* Item codes are matched whole-cell, so they MUST be short enough not to wrap
   inside their column — autoTable hands a wrapped cell to doc.text as
   ['SKU-ROW-', 'ONE'] and no fragment would equal the code. Keeping the codes
   tiny is the fix; this throws with the drawn text if one ever wraps anyway,
   so the failure names the cause instead of comparing against an empty list. */
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
  /* Library-level contract. This is the single fact all eight renderers rely
     on, so proving it once protects the five renderers not rendered below.
     The second table also covers sales-order-pdf.ts, which reads finalY twice
     (line items, then the payments ledger) and needs the field REFRESHED per
     table rather than stuck on the first one. */
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
    // Strictly below startY: a table that drew three rows consumed height.
    expect(firstFinalY).toBeGreaterThan(firstStartY);

    const secondStartY = firstFinalY! + 10;
    autoTable(doc, {
      startY: secondStartY,
      head: [['Payment']],
      body: [['1'], ['2']],
    });

    const secondFinalY = readFinalY(doc);
    expect(secondFinalY).toBeGreaterThan(secondStartY);
    // Not stuck on the first table — the SO's second read must move.
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

    // Pure ASCII on purpose: no CJK font fetch, no logo fetch, no fabric
    // catalog lookup (no variants) — this test is about geometry only.
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
        subtotal_centi: 300000,
        discount_centi: 0,
        tax_centi: 0,
        total_centi: 300000,
        paid_centi: 100000,
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
        unit_price_centi: 100000,
        line_total_centi: 100000,
      })),
    );

    // Everything asserted below is on page 1; a page break would reset y and
    // make the comparisons meaningless, so pin it.
    expect(doc.getNumberOfPages()).toBe(1);

    const itemRowYs = rowYsFor(draws, itemCodes);
    const lastItemRowY = Math.max(...itemRowYs);

    const finalY = readFinalY(doc);
    expect(Number.isFinite(finalY)).toBe(true);
    expect(finalY).toBeGreaterThan(lastItemRowY);

    const subtotalY = yOf(draws, 'Subtotal');
    const grandTotalY = yOf(draws, 'GRAND TOTAL');
    const outstandingY = yOf(draws, 'Outstanding');

    // THE assertion. Under the failure this file guards against, `?? y` would
    // put Subtotal back at the table's startY — above every row below — and
    // this comparison flips.
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
        mattress_sofa_centi: 0,
        bedframe_centi: 200000,
        accessories_centi: 0,
        others_centi: 0,
        local_total_centi: 200000,
        line_count: itemCodes.length,
        currency: 'MYR',
        note: null,
        paid_centi_total: 50000,
      },
      itemCodes.map((code, idx) => ({
        id: `item-${idx + 1}`,
        item_group: 'BEDFRAME',
        item_code: code,
        description: `Sales order line ${idx + 1}`,
        uom: 'UNIT',
        qty: 1,
        unit_price_centi: 100000,
        discount_centi: 0,
        total_centi: 100000,
        variants: null,
      })),
      [{
        paid_at: '2026-07-21',
        method: 'cash',
        merchant_provider: null,
        installment_months: null,
        approval_code: 'APPROVAL-XYZ',
        amount_centi: 50000,
        account_sheet: null,
        collected_by_name: 'Cashier One',
        note: null,
      }],
    );

    const itemRowYs = rowYsFor(draws, itemCodes);
    const lastItemRowY = Math.max(...itemRowYs);

    // First finalY read: the PAYMENTS RECEIVED heading sits below the items.
    const paymentsHeadingY = yOf(draws, 'PAYMENTS RECEIVED');
    expect(paymentsHeadingY).toBeGreaterThan(lastItemRowY);

    // Second finalY read: the totals sit below the payments ledger row.
    const paymentRowY = yOf(draws, 'APPROVAL-XYZ');
    expect(paymentRowY).toBeGreaterThan(paymentsHeadingY);

    const subtotalY = yOf(draws, 'Subtotal');
    const balanceDueY = yOf(draws, 'BALANCE DUE');
    expect(subtotalY).toBeGreaterThan(paymentRowY);
    expect(balanceDueY).toBeGreaterThan(subtotalY);
  }, 20_000);
});
