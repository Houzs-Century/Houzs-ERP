// ----------------------------------------------------------------------------
// performance-pnl-pdf — the Performance P&L's exports (docs/bugs/0835). The
// sheet is WHAT THE SCREEN SHOWS (report-sheet: the groups table, the summary
// from gross profit to net folded to the same level, the notes), drawn on
// paper by report-sheet-pdf and into a workbook by report-sheet-xlsx, so
// paper, workbook and screen can never disagree (owner 2026-09-19).
// ----------------------------------------------------------------------------

import { fmtDate } from '../../shared/format';
import type { PdfAction } from './pdf-common';
import { fmtPerf, type PerformanceReport } from './performance-report-queries';
import { performanceTables, type PerformanceSheetOptions, type ReportSheet } from './report-sheet';
import { generateReportPdf } from './report-sheet-pdf';
import { downloadReportXlsx } from './report-sheet-xlsx';

/** The Performance P&L as the screen shows it, ready for paper or Excel. */
export function performanceSheet(r: PerformanceReport, opts: PerformanceSheetOptions = {}): ReportSheet {
  const period = `${fmtDate(r.from)} – ${fmtDate(r.to)}`;
  const { tables, notes } = performanceTables(r, opts);
  return {
    title: 'Performance P&L',
    subtitle: `Sales orders dated ${period} · ${r.orders.counted} orders, ${r.orders.notDelivered} not yet delivered · % of sales`,
    meta: [
      { label: 'Period', value: period },
      { label: 'Orders', value: `${r.orders.counted} (${r.orders.notDelivered} not yet delivered)` },
    ],
    tables,
    notes,
    fmt: fmtPerf,
  };
}

const fileBase = (r: PerformanceReport): string => `performance-pnl-${r.from}-to-${r.to}`;

export const generatePerformancePdf = (r: PerformanceReport, opts: PerformanceSheetOptions & { action?: PdfAction } = {}): Promise<void> =>
  generateReportPdf(performanceSheet(r, opts), { fileName: `${fileBase(r)}.pdf`, action: opts.action });

export const downloadPerformanceXlsx = (r: PerformanceReport, opts: PerformanceSheetOptions = {}): Promise<void> =>
  downloadReportXlsx(performanceSheet(r, opts), `${fileBase(r)}.xlsx`);
