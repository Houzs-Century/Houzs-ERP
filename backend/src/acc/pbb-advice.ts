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
  /** The acquirer's own batch number — what ties this back to a terminal. */
  batchNo: string;
  /** YYYY-MM-DD. The day that batch SETTLED, not the day of this advice. */
  settledOn: string;
  grossSen: number;
  commissionSen: number;
  /** Anything the bank deducted beyond commission. Usually zero. */
  deductedSen: number;
  netSen: number;
};

export type PbbAdvice = {
  /** The account the money went into, as the advice prints it. */
  payeeAccountNo: string | null;
  payeeBank: string | null;
  /** The advice's own date — usually the day the GIRO credit appears. */
  statementDate: string | null;
  batches: AdviceBatch[];
  /** The settlement dates this advice covers, oldest first. */
  settlementDates: string[];
  grossSen: number;
  commissionSen: number;
  deductedSen: number;
  /** What the bank statement will show as ONE credit. */
  netSen: number;
  /** The Grand Total the advice PRINTS, which the rows above were checked
      against. Kept so a screen can show both and never have to be believed. */
  printedNetSen: number | null;
};

export type PbbAdviceResult = { ok: true; advice: PbbAdvice } | { ok: false; reason: string };

const DATE_CELL = /^\d{2}[A-Z]{3}\d{2}$/;
const MONEY = /^-?[\d,]+\.\d{2}$/;

/** 10AUG26 -> 2026-08-10. The advice writes every date this way. */
const adviceDate = (raw: string): string | null => {
  const m = /^(\d{2})([A-Z]{3})(\d{2})$/.exec(raw.trim().toUpperCase());
  if (!m) return null;
  return toIsoDate(`${m[1]}-${m[2]}-20${m[3]}`);
};

const rm = (sen: number) =>
  `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The value printed against a label, read by POSITION.
 *
 * The advice writes `[Nombor Akaun /] [Account Number] [:] [564418610346]` as
 * four separate cells on one line, so the value is the last cell of the label's
 * own row. A regular expression over the joined text finds the label and then
 * has to guess how much of what follows is the value — here there is nothing to
 * guess: the row ends where the value ends.
 */
function labelled(cells: PdfCell[], label: string): string | null {
  const at = cells.find((c) => c.text.includes(label));
  if (!at) return null;
  const row = cells
    .filter((c) => c.page === at.page && Math.abs(c.y - at.y) <= 2 && c.x > at.x)
    .sort((a, b) => a.x - b.x);
  /* Past the colon the advice puts between label and value. */
  const value = row.filter((c) => c.text !== ':').pop();
  return value ? value.text.trim() || null : null;
}

export async function readPbbAdvice(bytes: Uint8Array): Promise<PbbAdviceResult> {
  const read = await pdfCells(bytes);
  if (!read.ok) return { ok: false, reason: read.reason };
  const cells = read.cells;

  const all = cells.map((c) => c.text).join(' ');
  /* Refuse the wrong document by NAME. Uploading last month's transaction CSV
     here, or another bank's advice, must not read as an advice paying nothing. */
  if (!/PAYMENT ADVICE|MAKLUMAN PEMBAYARAN/i.test(all)) {
    return {
      ok: false,
      reason: 'That PDF is not a Public Bank payment advice — it does not carry the words "PAYMENT ADVICE".'
        + ' The advice is the file named HOUZSCENTURY_IBG_<date>.pdf, not the transaction CSV.',
    };
  }

  /* ── the batch table ──────────────────────────────────────────────────────
     A batch row is anchored on its SETTLEMENT DATE, which sits in a column of
     its own. Everything on that row, on that page, in x order, is the record;
     the four money figures at the end are gross, commission, deducted and net.
     Read that way rather than by counting columns, because the advice leaves
     the terminal column blank on some rows and counting would shift them. */
  /* WHAT A BATCH ROW IS, rather than which column is most popular: a
     settlement date with four money figures to the right of it — gross,
     commission, deducted, net. The advice prints its own Statement Date in the
     same shape in the header block, and an earlier version of this elected a
     column by counting dates, which on a one-batch advice is a tie the header
     can win. Asking what the row CONTAINS cannot tie. */
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

  /* ── THE SELF-CHECK ───────────────────────────────────────────────────────
     Nobody is going to add up 48 rows by hand, so the document does it. The
     Grand Total is printed in the right margin as `Grand Total : RM188,955.86`;
     the rows must reach it exactly or this refuses. A partial read that looked
     plausible is the dangerous outcome — it would name a payout smaller than
     the money that actually arrived and leave the difference unexplained. */
  const printedNetSen = toSen((labelled(cells, 'Grand Total') ?? '').replace(/^RM/i, ''));
  /* The check must RUN. A Grand Total this could not find is a Grand Total this
     could not check against, and an unchecked read of 48 rows is exactly the
     plausible-looking partial answer the header warns about. */
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
