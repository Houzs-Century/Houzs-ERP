// What this file pins about Public Bank's IBG payment advice.
//
// The one that matters: the advice CHECKS ITSELF. Nobody is going to add up 48
// batch rows by hand, so the rows must reach the Grand Total the document
// prints or nothing is returned — and a Grand Total that cannot be found is
// itself a refusal, because an unchecked read of 48 rows is exactly the
// plausible-looking partial answer that would name a payout smaller than the
// money that arrived and leave the difference unexplained for ever.
//
// The reader takes POSITIONED CELLS, not a flattened table, so these tests
// build cells the way the real document lays them out: labels and values as
// separate strings on one line, the batch table anchored on its settlement-date
// column, and TWO PAGES — the real advice has two, and every page restarts its
// coordinates, which is how a batch on page 2 used to land on top of one on
// page 1.

import { describe, it, expect, vi } from 'vitest';
import type { PdfCell } from './settlement-pdf';

const cells: PdfCell[] = [];
vi.mock('./settlement-pdf', () => ({
  pdfCells: async () => (cells.length > 0 ? { ok: true, cells } : { ok: false, reason: 'nothing readable' }),
}));

const { readPbbAdvice } = await import('./pbb-advice');

/** One line of cells at a y, at the x positions the real advice uses. */
const at = (page: number, y: number, ...pairs: Array<[number, string]>): PdfCell[] =>
  pairs.map(([x, text]) => ({ page, x, y, text }));

/* The header block, in the right margin — labels and values as separate cells. */
const header = (grandTotal: string) => [
  ...at(1, -140, [21, 'MAKLUMAN PEMBAYARAN /'], [330, 'PAYMENT ADVICE']),
  ...at(1, -161, [330, 'Nama Bank /'], [390, 'Name of Bank'], [456, ':'], [463, 'MAYBANK ISLAMIC BERHAD']),
  ...at(1, -175, [330, 'Nombor Akaun /'], [390, 'Account Number'], [456, ':'], [463, '564418610346']),
  ...at(1, -189, [330, 'Jumlah Besar /'], [390, 'Grand Total'], [456, ':'], [463, grandTotal]),
  ...at(1, -204, [330, 'Tarikh Penyata /'], [390, 'Statement Date'], [456, ':'], [463, '10AUG26']),
];

/* One batch row: MID, TID, batch no, settlement date, then gross / commission /
   deducted / net at the money columns. */
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
      /* Page 2 restarts its coordinates — this y is identical to the one above,
         and before pages were tracked the two rows became one. */
      batch(2, -375, '6630843126', '50041522', '280806', '07AUG26', '4,000.00', '0.00', '4,000.00'),
    );
    const r = await read();
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.advice.batches).toHaveLength(2);
    expect(r.advice.payeeBank).toBe('MAYBANK ISLAMIC BERHAD');
    expect(r.advice.payeeAccountNo).toBe('564418610346');
    expect(r.advice.statementDate).toBe('2026-08-10');
    /* The trading days it covers — the advice pays for several at once, which
       is the whole reason one bank credit answers to many reports. */
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
  /* THE ONE THAT MATTERS. A row missed by the reader must not become a smaller
     payout that looks fine. */
  it('refuses when the rows do not reach the printed Grand Total', async () => {
    load(
      header('RM12,000.00'),
      batch(1, -375, '333', '400', '000239', '09AUG26', '8,000.00', '0.00', '8,000.00'),
    );
    const r = await read();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    /* BOTH numbers and the difference, so he can see what was missed. */
    expect(r.reason).toMatch(/RM 12,000\.00/);
    expect(r.reason).toMatch(/RM 8,000\.00/);
    expect(r.reason).toMatch(/RM 4,000\.00/);
    expect(r.reason).toMatch(/none of it is offered/);
  });

  /* An unfindable Grand Total is an unRUN check, and an unrun check on 48 rows
     is worth nothing — so it refuses rather than returning a total nothing
     confirms. */
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

  /* The header's own Statement Date sits in the same shape as a settlement
     date. It must not be read as a batch — the batch column is the x that
     carries the most of them. */
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
