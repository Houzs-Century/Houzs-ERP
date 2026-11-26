// ----------------------------------------------------------------------------
// acc/pbb-advice — Public Bank's IBG payment advice.
//
// The owner, having got the card side working: public bank 不是要对两份东西吗？
// He is right, and it is the one acquirer that sends TWO documents:
//
//   HOUZSCENTURY_CSV_<date>.csv   every card transaction of one settlement date
//                                 — what merchant reconciliation already reads
//   HOUZSCENTURY_IBG_<date>.pdf   MAKLUMAN PEMBAYARAN / PAYMENT ADVICE: "we have
//                                 paid the following into your account", listed
//                                 per EDC BATCH and covering SEVERAL settlement
//                                 dates, with one Grand Total
//
// Why the second one matters. The bank statement shows ONE credit — RM
// 188,955.86 in the file this was written from — and that credit pays dozens of
// EDC batches spanning three trading days. Without the advice the matcher has
// to search for a combination of reconciled reports that adds up, and it caps
// that search at four; a payout covering ten reports would simply never be
// found. The advice is the answer written down: this much money, these batches,
// these dates, into this account.
//
// ── The one thing that makes this trustworthy ──
// Nobody can hand-check 48 batch rows. So the document checks itself: the rows
// must add up to the Grand Total the advice prints, to the sen, or this refuses
// to return them. A partial read that looked plausible would be worse than no
// read at all — it would name a payout smaller than the money that arrived and
// leave the difference unexplained for ever.
//
// It reads POSITIONS, not the flattened CSV, because this document is two pages
// and prints a summary block in the right margin; a row-by-y arrangement folds
// the Grand Total into whichever batch happens to share its line.
// ----------------------------------------------------------------------------

import { pdfCells, type PdfCell } from './settlement-pdf';
import { toIsoDate, toSen } from './settlement-parse';

/** One EDC batch the advice says it is paying for. */
export type AdviceBatch = {
  merchantId: string;
  terminalId: string;
  batchNo: string;
  settledOn: string;
  grossSen: number;
  commissionSen: number;
  deductedSen: number;
  netSen: number;
};

export type PbbAdvice = {
  payeeAccountNo: string | null;
  payeeBank: string | null;
  statementDate: string | null;
  batches: AdviceBatch[];
  settlementDates: string[];
  grossSen: number;
  commissionSen: number;
  deductedSen: number;
  netSen: number;
  printedNetSen: number | null;
};

export type PbbAdviceResult = { ok: true; advice: PbbAdvice } | { ok: false; reason: string };

const DATE_CELL = /^\d{2}[A-Z]{3}\d{2}$/;
const MONEY = /^-?[\d,]+\.\d{2}$/;

const adviceDate = (raw: string): string | null => {
  const m = /^(\d{2})([A-Z]{3})(\d{2})$/.exec(raw.trim().toUpperCase());
  if (!m) return null;
  return toIsoDate(`${m[1]}-${m[2]}-20${m[3]}`);
};

const rm = (sen: number) =>
  `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function labelled(cells: PdfCell[], label: string): string | null {
  const at = cells.find((c) => c.text.includes(label));
  if (!at) return null;
  const row = cells
    .filter((c) => c.page === at.page && Math.abs(c.y - at.y) <= 2 && c.x > at.x)
    .sort((a, b) => a.x - b.x);
  const value = row.filter((c) => c.text !== ':').pop();
  return value ? value.text.trim() || null : null;
}

export async function readPbbAdvice(bytes: Uint8Array): Promise<PbbAdviceResult> {
  const read = await pdfCells(bytes);
  if (!read.ok) return { ok: false, reason: read.reason };
  const cells = read.cells;

  const all = cells.map((c) => c.text).join(' ');
  if (!/PAYMENT ADVICE|MAKLUMAN PEMBAYARAN/i.test(all)) {
    return {
      ok: false,
      reason: 'That PDF is not a Public Bank payment advice — it does not carry the words "PAYMENT ADVICE".'
        + ' The advice is the file named HOUZSCENTURY_IBG_<date>.pdf, not the transaction CSV.',
    };
  }

  const batches: AdviceBatch[] = [];
  for (const a of cells.filter((c) => DATE_CELL.test(c.text))) {
    const row = cells
      .filter((c) => c.page === a.page && Math.abs(c.y - a.y) <= 2)
      .sort((c, d) => c.x - d.x);
    const before = row.filter((c) => c.x < a.x - 3).map((c) => c.text);
    const money = row.filter((c) => c.x > a.x + 3 && MONEY.test(c.text)).map((c) => toSen(c.text));
    if (money.length < 4 || money.some((v) => v == null)) continue;
    const settledOn = adviceDate(a.text);
    if (!settledOn) continue;
    const ids = before.filter((t) => /^\d{4,}$/.test(t));
    batches.push({
      merchantId: ids[0] ?? '',
      terminalId: ids[1] ?? '',
      batchNo: ids[2] ?? '',
      settledOn,
      grossSen: money[0]!,
      commissionSen: money[1]!,
      deductedSen: money[2]!,
      netSen: money[money.length - 1]!,
    });
  }

  if (batches.length === 0) {
    return { ok: false, reason: 'This advice carries no batch rows — nothing in it says what was paid for.' };
  }

  const grossSen = batches.reduce((s, b) => s + b.grossSen, 0);
  const commissionSen = batches.reduce((s, b) => s + b.commissionSen, 0);
  const deductedSen = batches.reduce((s, b) => s + b.deductedSen, 0);
  const netSen = batches.reduce((s, b) => s + b.netSen, 0);

  const printedNetSen = toSen((labelled(cells, 'Grand Total') ?? '').replace(/^RM/i, ''));
  if (printedNetSen == null) {
    return {
      ok: false,
      reason: 'This advice has no readable Grand Total, so the batch rows cannot be checked against it.'
        + ` They come to ${rm(netSen)} across ${batches.length} batches, but nothing in the file confirms that is all of them.`,
    };
  }
  if (printedNetSen !== netSen) {
    return {
      ok: false,
      reason: `This advice prints a Grand Total of ${rm(printedNetSen)}, but its ${batches.length} batch `
        + `rows come to ${rm(netSen)} — a difference of ${rm(printedNetSen - netSen)}. `
        + 'Some of it was not read, so none of it is offered.',
    };
  }

  const payee = labelled(cells, 'Account Number');
  const stamped = labelled(cells, 'Statement Date');

  return {
    ok: true,
    advice: {
      payeeAccountNo: payee ? payee.replace(/\D/g, '') || null : null,
      payeeBank: labelled(cells, 'Name of Bank'),
      statementDate: stamped ? adviceDate(stamped) : null,
      batches,
      settlementDates: [...new Set(batches.map((b) => b.settledOn))].sort(),
      grossSen,
      commissionSen,
      deductedSen,
      netSen,
      printedNetSen,
    },
  };
}
