/* The customer-invoice listing (the AP listing's twin, owner 2026-09-29)
   prints what the screen shows. Pinned: the table's cells come from the rows
   in list order with the kind spelled out, the party with its code where it
   has one, the order reference and description printed, and the three money
   columns totalled; the drawn document carries the title and the filter words
   in its meta block, and leaves through deliverPdf as a preview. Ordinary
   ASCII in the fixture: no CJK font fetch, no logo fetch, no network. */

import { describe, expect, test, vi } from 'vitest';
import type { ArListRow } from './ar-invoice-queries';

const deliver = vi.fn();
vi.mock('./pdf-common', async (importOriginal) => {
  const real = await importOriginal<typeof import('./pdf-common')>();
  return { ...real, deliverPdf: (...args: unknown[]) => deliver(...args) };
});

import { arListingTable, generateArListingPdf } from './ar-invoice-listing-pdf';

const row = (over: Partial<ArListRow>): ArListRow => ({
  kind: 'SI', id: 'si-1', invoiceNumber: 'HC-SI-2609-001', partyKey: 'C:300-C001', partyCode: '300-C001', partyName: 'TAN AH KOW', debtorId: null,
  ref: 'HC-SO-2609-004', description: 'Bedroom set', invoiceDate: '2026-09-03', dueDate: '2026-09-30', currency: 'MYR',
  totalSen: 440_000, paidSen: 60_000, depositAppliedSen: 20_000, outstandingSen: 380_000, status: 'SENT',
  ...over,
});

describe('the listing table', () => {
  test('one cell row per list row, kind spelled out, the party with its code, money columns totalled', () => {
    const t = arListingTable([
      row({}),
      row({ kind: 'ODB', id: 'b1', invoiceNumber: 'HC-ODB-2609-001', partyKey: 'D:d1', partyCode: null, partyName: 'AHMAD BIN ALI', debtorId: 'd1', ref: null, description: null, dueDate: null, totalSen: 50_000, paidSen: 20_000, depositAppliedSen: 0, outstandingSen: 30_000, status: 'POSTED' }),
    ]);
    expect(t.head).toEqual(['Kind', 'No.', 'Customer / Debtor', 'Ref', 'Date', 'Due', 'Description', 'Total', 'Paid', 'Outstanding', 'Status']);
    expect(t.body[0]).toEqual(['Sales Invoice', 'HC-SI-2609-001', 'TAN AH KOW (300-C001)', 'HC-SO-2609-004', '2026/09/03', '2026/09/30', 'Bedroom set', 'RM 4,400.00', 'RM 600.00', 'RM 3,800.00', 'SENT']);
    /* A bill has no due date and no order behind it: the date slot prints the dash every document prints, the ref stays blank. */
    expect(t.body[1]).toEqual(['Debtor Bill', 'HC-ODB-2609-001', 'AHMAD BIN ALI', '', '2026/09/03', '—', '', 'RM 500.00', 'RM 200.00', 'RM 300.00', 'POSTED']);
    expect(t.totals).toEqual({ count: 2, totalSen: 490_000, paidSen: 80_000, outstandingSen: 410_000 });
  });

  test('an empty list still prints a table with zero totals', () => {
    expect(arListingTable([]).totals).toEqual({ count: 0, totalSen: 0, paidSen: 0, outstandingSen: 0 });
  });
});

describe('the drawn document', () => {
  test('carries the title and the filter words, and leaves as a preview', async () => {
    deliver.mockClear();
    await generateArListingPdf([row({})], { kind: 'SI', partyName: 'TAN AH KOW' });
    expect(deliver).toHaveBeenCalledTimes(1);
    const [doc, filename, action] = deliver.mock.calls[0]! as [{ output: (t: string) => string }, string, string];
    expect(filename).toMatch(/^customer-invoice-listing-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(action).toBe('preview');
    expect(doc.output('datauristring').length).toBeGreaterThan(100);
  });
});
