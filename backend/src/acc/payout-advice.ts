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
  adviceNetSen: number;
  batchId: number | null;
  fileName: string | null;
  reportNetSen: number | null;
  differenceSen: number | null;
  /** What the bank deducted from this day's payout and where it was booked
      (docs/bugs/0787) — 0 / null when nothing was. Counted as paid: the money
      left the acquirer's transit, just not into the bank. */
  chargeSen: number;
  chargeAccountCode: string | null;
  chargeNote: string | null;
  chargeJeNo: string | null;
  reportOpenLines: number | null;
  state: 'AGREES' | 'DIFFERS' | 'REPORT_MISSING' | 'REPORT_NOT_RECONCILED';
};

export type PayoutStatus = {
  netSen: number;
  days: PayoutDay[];
  readyToReceive: boolean;
  blockedBy: string | null;
};

/** A merchant report as this comparison needs it. */
export type ReportForPayout = {
  id: number;
  fileName: string;
  periodFrom: string;
  periodTo: string;
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
/** A day as the advice (or its stored day row) hands it over. The charge
    fields ride on the STORED row — a freshly read advice carries none. */
export type AdviceDayInput = {
  settledOn: string;
  netSen: number;
  chargeSen?: number | null;
  chargeAccountCode?: string | null;
  chargeNote?: string | null;
  chargeJeNo?: string | null;
};

type ChargeOnDay = Pick<AdviceDayInput, 'chargeSen' | 'chargeAccountCode' | 'chargeNote' | 'chargeJeNo'>;

export function statusOfPayout(
  advice: { netSen: number; batches: ReadonlyArray<AdviceDayInput> },
  reports: ReportForPayout[],
): PayoutStatus {
  const byDate = new Map<string, { netSen: number; charge: ChargeOnDay }>();
  for (const b of advice.batches) {
    const at = byDate.get(b.settledOn) ?? { netSen: 0, charge: {} };
    at.netSen += b.netSen;
    if (b.chargeSen != null && b.chargeSen > 0) at.charge = b;
    byDate.set(b.settledOn, at);
  }

  const days: PayoutDay[] = [...byDate.entries()].sort().map(([settledOn, { netSen: adviceNetSen, charge }]) => {
    const chargeSen = Number(charge.chargeSen ?? 0);
    const chargeFields = {
      chargeSen,
      chargeAccountCode: chargeSen > 0 ? (charge.chargeAccountCode ?? null) : null,
      chargeNote: chargeSen > 0 ? (charge.chargeNote ?? null) : null,
      chargeJeNo: chargeSen > 0 ? (charge.chargeJeNo ?? null) : null,
    };
    const report = reports.find((r) => settledOn >= r.periodFrom && settledOn <= r.periodTo) ?? null;
    if (!report) {
      return {
        settledOn, adviceNetSen, batchId: null, fileName: null,
        reportNetSen: null, differenceSen: null, reportOpenLines: null,
        ...chargeFields,
        state: 'REPORT_MISSING' as const,
      };
    }
    const differenceSen = report.payableSen - (adviceNetSen + chargeSen);
    return {
      settledOn,
      adviceNetSen,
      batchId: report.id,
      fileName: report.fileName,
      reportNetSen: report.payableSen,
      differenceSen,
      reportOpenLines: report.openLines,
      ...chargeFields,
      state: differenceSen !== 0 ? 'DIFFERS' as const
        : report.openLines > 0 ? 'REPORT_NOT_RECONCILED' as const
          : 'AGREES' as const,
    };
  });

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
