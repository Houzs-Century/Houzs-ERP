
import { describe, it, expect, vi } from 'vitest';
import type { PdfCell } from './settlement-pdf';

const cells: PdfCell[] = [];
vi.mock('./settlement-pdf', () => ({
  pdfCells: async () => (cells.length > 0 ? { ok: true, cells } : { ok: false, reason: 'nothing readable' }),
}));

const { readPbbAdvice } = await import('./pbb-advice');

const at = (page: number, y: number, ...pairs: Array<[number, string]>): PdfCell[] =>
  pairs.map(([x, text]) => ({ page, x, y, text }));

const header = (grandTotal: string) => [
  ...at(1, -140, [21, 'MAKLUMAN PEMBAYARAN /'], [330, 'PAYMENT ADVICE']),
  ...at(1, -161, [330, 'Nama Bank /'], [390, 'Name of Bank'], [456, ':'], [463, 'MAYBANK ISLAMIC BERHAD']),
  ...at(1, -175, [330, 'Nombor Akaun /'], [390, 'Account Number'], [456, ':'], [463, '564418610346']),
  ...at(1, -189, [330, 'Jumlah Besar /'], [390, 'Grand Total'], [456, ':'], [463, grandTotal]),
  ...at(1, -204, [330, 'Tarikh Penyata /'], [390, 'Statement Date'], [456, ':'], [463, '10AUG26']),
];

const batch = (
  page: number, y: number, mid: string, tid: string, no: string, date: string,
  gross: string, comm: string, net: string,
) => at(page, y,
  [76, mid], [131, tid], [181, no], [232, date],
  [321, gross], [402, comm], [485, '0.00'], [547, net]);

const load = (...rows: PdfCell[][]) => {
  cells.length = 0;
  for (const r of rows) cells.push(...r);
};

const read = () => readPbbAdvice(new Uint8Array([1]));

describe('reading the advice', () => {
  it('reads the payee, the date, and every batch across BOTH pages', async () => {
    load(
      header('RM12,000.00'),
      batch(1, -375, '3331183709', '40054975', '000239', '09AUG26', '8,000.00', '0.00', '8,000.00'),
      batch(2, -375, '6630843126', '50041522', '280806', '07AUG26', '4,000.00', '0.00', '4,000.00'),
    );
    const r = await read();
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.advice.batches).toHaveLength(2);
    expect(r.advice.payeeBank).toBe('MAYBANK ISLAMIC BERHAD');
    expect(r.advice.payeeAccountNo).toBe('564418610346');
    expect(r.advice.statementDate).toBe('2026-08-10');
    expect(r.advice.settlementDates).toEqual(['2026-08-07', '2026-08-09']);
    expect(r.advice.netSen).toBe(1200000);
    expect(r.advice.printedNetSen).toBe(1200000);
  });

  it('carries the commission, so the fee side can be checked too', async () => {
    load(
      header('RM9,882.00'),
      batch(1, -375, '333', '400', '000239', '09AUG26', '10,000.00', '118.00', '9,882.00'),
    );
    const r = await read();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.advice.grossSen).toBe(1000000);
    expect(r.advice.commissionSen).toBe(11800);
    expect(r.advice.netSen).toBe(988200);
  });
});

describe('the self-check', () => {
  it('refuses when the rows do not reach the printed Grand Total', async () => {
    load(
      header('RM12,000.00'),
      batch(1, -375, '333', '400', '000239', '09AUG26', '8,000.00', '0.00', '8,000.00'),
    );
    const r = await read();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/RM 12,000\.00/);
    expect(r.reason).toMatch(/RM 8,000\.00/);
    expect(r.reason).toMatch(/RM 4,000\.00/);
    expect(r.reason).toMatch(/none of it is offered/);
  });

  it('refuses when there is no Grand Total to check against', async () => {
    load(
      ...[at(1, -140, [21, 'PAYMENT ADVICE'])],
      batch(1, -375, '333', '400', '000239', '09AUG26', '8,000.00', '0.00', '8,000.00'),
    );
    const r = await read();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no readable Grand Total/);
  });
});

describe('the wrong document', () => {
  it('refuses a PDF that is not a payment advice, and says which file is', async () => {
    load(at(1, -100, [21, 'MERCHANT SETTLEMENT REPORT'], [321, '1,000.00']));
    const r = await read();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/not a Public Bank payment advice/);
    expect(r.reason).toMatch(/HOUZSCENTURY_IBG/);
  });

  it('refuses an advice with no batch rows rather than reporting a payout of nothing', async () => {
    load(header('RM0.00'));
    const r = await read();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no batch rows/);
  });

  it('does not mistake the header date for a batch', async () => {
    load(
      header('RM8,000.00'),
      batch(1, -375, '333', '400', '000239', '09AUG26', '8,000.00', '0.00', '8,000.00'),
    );
    const r = await read();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.advice.batches).toHaveLength(1);
  });
});
