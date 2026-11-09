/* The Payment vouchers list on paper (owner 2026-11-09: 「我filter 了，right click header
   print 不行？」). Pinned: the header's Export to PDF prints the columns showing, in
   their order, the rows the screen leaves, without the row's buttons; the Amount in RM
   with a foreign voucher's own amount under it, totalled as the screen's footer totals
   (a cancelled voucher listed, not counted); the sentence on top says what the list was
   cut to; one landscape listing, delivered by the action asked. Ordinary ASCII: no font
   fetch, no network. */

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { jsPDF } from 'jspdf';

const deliver = vi.fn();
vi.mock('./pdf-common', async (importOriginal) => {
  const real = await importOriginal<typeof import('./pdf-common')>();
  return { ...real, deliverPdf: (...args: unknown[]) => deliver(...args) };
});

import { generatePvListPdf, pvListCutTo, pvListTable, type PvListView } from './pv-list-pdf';
import { fmtMoneySen, todayMY } from '../../shared/format';

afterEach(() => { deliver.mockClear(); });

/* As the PV list's Excel holds them: the Date is ISO text there (the grid column has no
   export format), the Amount in the voucher's own currency. */
const VIEW: PvListView = {
  keys: ['pv_number', 'voucher_date', 'payee_name', 'total_sen', 'status', 'next_step'],
  matrix: {
    header: ['Voucher', 'Date', 'Payee', 'Amount', 'Stage', 'Next step'],
    formats: ['text', 'text', 'text', 'money', 'text', 'text'],
    body: [
      ['HC-HPV-2611-001', '2026-11-03', 'TNB', 320.5, 'Checked', 'Approve & post'],
      ['HC-HPV-2611-002', '2026-11-04', 'FOSHAN CHAIRS', 1000, 'Approved', ''],
      ['HC-HPV-2611-003', '2026-11-05', 'OLD CO', 50, 'Cancelled', ''],
    ],
  },
  rows: [
    { status: 'DRAFT', currency: 'MYR', total_sen: 32_050, exchange_rate: 1 },
    { status: 'POSTED', currency: 'RMB', total_sen: 100_000, exchange_rate: 0.65 },
    { status: 'CANCELLED', currency: 'MYR', total_sen: 5_000, exchange_rate: 1 },
  ],
};

describe('the Payment vouchers list on paper', () => {
  test('the columns showing, less the row buttons; the Amount in RM, a foreign voucher printing its own amount under it', () => {
    const t = pvListTable(VIEW);
    expect(t.head).toEqual(['Voucher', 'Date', 'Payee', 'Amount (RM)', 'Stage']);
    expect(t.body[0]).toEqual(['HC-HPV-2611-001', '2026/11/03', 'TNB', '320.50', 'Checked']);
    expect(t.body[1]![3]).toBe(`650.00\n${fmtMoneySen(100_000, 'RMB')}`);
    expect(t.body[2]![3]).toBe('50.00');
    expect(t.figures).toEqual([false, false, false, true, false]);
  });

  test('totalled as the screen totals: the cancelled voucher listed, not counted', () => {
    const t = pvListTable(VIEW);
    expect(t.totalSen).toBe(97_050);
    expect(t.cancelled).toBe(1);
    expect(t.foot).toEqual([{ content: 'Total (3 rows, 1 cancelled not counted)', colSpan: 3 }, '970.50', { content: '', colSpan: 1 }]);
  });

  test('a list printed without its Amount prints no total', () => {
    const keep = [0, 1, 2, 4];
    const t = pvListTable({
      keys: keep.map((i) => VIEW.keys[i]!),
      matrix: {
        header: keep.map((i) => VIEW.matrix.header[i]!),
        formats: keep.map((i) => VIEW.matrix.formats[i]!),
        body: VIEW.matrix.body.map((row) => keep.map((i) => row[i] ?? null)),
      },
      rows: VIEW.rows,
    });
    expect(t.head).toEqual(['Voucher', 'Date', 'Payee', 'Stage']);
    expect(t.foot).toBeNull();
    expect(t.totalSen).toBeNull();
  });

  test('the sentence on top says what the list was cut to', () => {
    expect(pvListCutTo({ stage: 'Checked', month: 'November 2026', search: '' }))
      .toBe('Payment vouchers as filtered on the screen. Stage: Checked. Month: November 2026.');
    expect(pvListCutTo({ stage: 'All', month: '', search: '' }))
      .toBe('Payment vouchers as filtered on the screen. Stage: All. Month: All months.');
    expect(pvListCutTo({ stage: 'Checked', month: 'November 2026', search: 'meta' }))
      .toBe('Payment vouchers as filtered on the screen. Search: "meta", any stage and month.');
  });

  test('one landscape listing, delivered by the action asked', async () => {
    await generatePvListPdf(VIEW, { cutTo: pvListCutTo({ stage: 'All', month: '', search: '' }), action: 'preview' });
    expect(deliver).toHaveBeenCalledTimes(1);
    const [doc, name, action] = deliver.mock.calls[0]! as [jsPDF, string, string];
    expect(name).toBe(`payment-vouchers-${todayMY()}.pdf`);
    expect(action).toBe('preview');
    expect(doc.internal.pageSize.getWidth()).toBeGreaterThan(doc.internal.pageSize.getHeight());
  });
});
