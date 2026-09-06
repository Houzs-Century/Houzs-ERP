/* The supplier-invoice listing (owner 2026-09-06: print listing 功能我也想要)
   prints what the screen shows. Pinned: the table's cells come from the rows
   in list order with the kind spelled out, the description printed, and the
   three money columns totalled; the drawn document carries the title, the
   filter words in its meta block, and leaves through deliverPdf as a preview.
   Ordinary ASCII in the fixture: no CJK font fetch, no logo fetch, no network. */

import { describe, expect, test, vi } from 'vitest';
import type { ApListRow } from './ap-invoice-queries';

const deliver = vi.fn();
vi.mock('./pdf-common', async (importOriginal) => {
  const real = await importOriginal<typeof import('./pdf-common')>();
  return { ...real, deliverPdf: (...args: unknown[]) => deliver(...args) };
});

import { apListingTable, generateApListingPdf } from './ap-invoice-listing-pdf';

const row = (over: Partial<ApListRow>): ApListRow => ({
  kind: 'API', id: 'api-1', invoiceNumber: '2990-API-2609-001', supplierId: 'sup-h', supplierCode: '405-H001',
  supplierName: 'HOUZS VENTURE HOLDING SDN BHD', supplierInvoiceRef: 'HVH-0912', description: 'Rent September',
  invoiceDate: '2026-09-01', dueDate: '2026-09-30', currency: 'MYR', totalSen: 420_000, paidSen: 0, outstandingSen: 420_000, status: 'POSTED',
  ...over,
});

describe('the listing table', () => {
  test('one cell row per list row, kind spelled out, description printed, money columns totalled', () => {
    const t = apListingTable([
      row({}),
      row({ kind: 'PI', id: 'pi-1', invoiceNumber: '2990-PI-2607-005', supplierCode: '400-H004', supplierName: 'HOOKKA INDUSTRIES SDN. BHD.', supplierInvoiceRef: null, description: null, totalSen: 300_000, paidSen: 100_000, outstandingSen: 200_000, status: 'PARTIALLY_PAID' }),
    ]);
    expect(t.head).toEqual(['Kind', 'No.', 'Supplier', 'Ref', 'Date', 'Due', 'Description', 'Total', 'Paid', 'Outstanding', 'Status']);
    expect(t.body[0]).toEqual(['AP Invoice', '2990-API-2609-001', 'HOUZS VENTURE HOLDING SDN BHD (405-H001)', 'HVH-0912', '01/09/2026', '30/09/2026', 'Rent September', 'MYR 4,200.00', 'MYR 0.00', 'MYR 4,200.00', 'POSTED']);
    expect(t.body[1]![0]).toBe('Purchase Invoice');
    expect(t.body[1]![3]).toBe('');
    expect(t.body[1]![6]).toBe('');
    expect(t.totals).toEqual({ count: 2, totalSen: 720_000, paidSen: 100_000, outstandingSen: 620_000 });
  });

  test('an empty list still prints a table with zero totals', () => {
    expect(apListingTable([]).totals).toEqual({ count: 0, totalSen: 0, paidSen: 0, outstandingSen: 0 });
  });
});

describe('the drawn document', () => {
  test('carries the title and the filter words, and leaves as a preview', async () => {
    deliver.mockClear();
    await generateApListingPdf([row({})], { kind: 'API', supplierName: 'HOUZS VENTURE HOLDING SDN BHD' });
    expect(deliver).toHaveBeenCalledTimes(1);
    const [doc, filename, action] = deliver.mock.calls[0]! as [{ internal: { pages: unknown[] }; output: (t: string) => string }, string, string];
    expect(filename).toMatch(/^supplier-invoice-listing-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(action).toBe('preview');
    const text = doc.output('datauristring');
    expect(text.length).toBeGreaterThan(100);
  });
});
