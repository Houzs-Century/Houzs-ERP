// ----------------------------------------------------------------------------
// acc/payout-advice — the document that says which reports one credit pays.
//
// Owner, 2026-08-20: for pbb 就是几份 excel 对一份 pdf.
//
// Public Bank sends a transaction file per settlement date and, when it pays,
// ONE IBG advice covering several of them. This stores that advice and lines it
// up against the reports already uploaded, so three questions get answers:
//
//   · does each day agree?   the advice's figure for a day against that day's
//                            report — a difference is the finding
//   · what is missing?       a day the advice names whose report is not here
//   · what will the bank show? one credit, the advice's own total
//
// Reading the PDF is acc/pbb-advice. This file only stores and compares.
// ----------------------------------------------------------------------------

import type { PbbAdvice } from './pbb-advice';

/** One settlement date of a payout, against the report for that date. */
export type PayoutDay = {
  settledOn: string;
  /** What the advice says that day came to. */
  adviceNetSen: number;
  batchId: number | null;
  fileName: string | null;
  /** What the uploaded report itself nets, when there is one. */
  reportNetSen: number | null;
  /** report − advice. Zero is agreement; anything else is the finding. */
  differenceSen: number | null;
  /** Whether that report has every line decided — a payout cannot be booked
      against a report whose fees are not in the books yet. */
  reportOpenLines: number | null;
  state: 'AGREES' | 'DIFFERS' | 'REPORT_MISSING' | 'REPORT_NOT_RECONCILED';
};

export type PayoutStatus = {
  netSen: number;
  days: PayoutDay[];
  /** Every day has a report, they all agree, and every report is reconciled. */
  readyToReceive: boolean;
  /** One sentence saying what is in the way, or null when nothing is. */
  blockedBy: string | null;
};

/** A merchant report as this comparison needs it. */
export type ReportForPayout = {
  id: number;
  fileName: string;
  periodFrom: string;
  periodTo: string;
  /** stated net when the file states one, else the sum of its lines. */
  payableSen: number;
  openLines: number;
};

const rm = (sen: number) =>
  `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Line the advice up against the reports.
 *
 * One report covers ONE settlement date, so a day is matched to the report
 * whose period contains it. A report spanning several days would match several,
 * which is why the caller must not offer the same report twice — but Public
 * Bank's files are one day each, and the check below would catch anything else
 * as a difference rather than silently double-counting.
 */
export function statusOfPayout(
  advice: Pick<PbbAdvice, 'netSen' | 'batches'>,
  reports: ReportForPayout[],
): PayoutStatus {
  const byDate = new Map<string, number>();
  for (const b of advice.batches) byDate.set(b.settledOn, (byDate.get(b.settledOn) ?? 0) + b.netSen);

  const days: PayoutDay[] = [...byDate.entries()].sort().map(([settledOn, adviceNetSen]) => {
    const report = reports.find((r) => settledOn >= r.periodFrom && settledOn <= r.periodTo) ?? null;
    if (!report) {
      return {
        settledOn, adviceNetSen, batchId: null, fileName: null,
        reportNetSen: null, differenceSen: null, reportOpenLines: null,
        state: 'REPORT_MISSING' as const,
      };
    }
    const differenceSen = report.payableSen - adviceNetSen;
    return {
      settledOn,
      adviceNetSen,
      batchId: report.id,
      fileName: report.fileName,
      reportNetSen: report.payableSen,
      differenceSen,
      reportOpenLines: report.openLines,
      state: differenceSen !== 0 ? 'DIFFERS' as const
        : report.openLines > 0 ? 'REPORT_NOT_RECONCILED' as const
          : 'AGREES' as const,
    };
  });

  /* ONE sentence, naming the first thing in the way — and the order is the
     order they have to be dealt with in: a missing report cannot be checked, a
     report that disagrees cannot be reconciled past, and a reconciled report is
     the last gate. Listing all three at once would be a wall nobody reads. */
  const missing = days.filter((d) => d.state === 'REPORT_MISSING');
  const differs = days.filter((d) => d.state === 'DIFFERS');
  const open = days.filter((d) => d.state === 'REPORT_NOT_RECONCILED');

  const blockedBy = missing.length > 0
    ? `${missing.length} of the ${days.length} day(s) this pays for have no merchant report uploaded yet — `
      + `${missing.map((d) => d.settledOn).join(', ')}.`
    : differs.length > 0
      ? differs.map((d) => `${d.fileName ?? d.settledOn} nets ${rm(d.reportNetSen ?? 0)} but the advice says `
        + `${rm(d.adviceNetSen)} for ${d.settledOn} — a difference of ${rm(d.differenceSen ?? 0)}.`).join(' ')
      : open.length > 0
        ? `${open.length} report(s) still have lines to decide — ${open.map((d) => d.fileName ?? d.settledOn).join(', ')}.`
        : null;

  return {
    netSen: advice.netSen,
    days,
    readyToReceive: blockedBy == null && days.length > 0,
    blockedBy,
  };
}
