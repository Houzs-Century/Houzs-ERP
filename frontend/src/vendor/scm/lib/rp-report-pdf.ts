// ----------------------------------------------------------------------------
// rp-report-pdf — the Cash Flow's exports. The sheet is WHAT THE SCREEN SHOWS
// (report-sheet: the same columns — Total, plus the accounts ticked on the
// screen — the same rows folded to the same level, the same subtotal names
// and the four balance lines), drawn on paper by report-sheet-pdf and into
// a workbook by report-sheet-xlsx, so paper, workbook and screen can never
// disagree (owner 2026-09-19: 我这页显示什么就要 export 什么).
// ----------------------------------------------------------------------------

import { fmtDate, fmtSenPlain } from '../../shared/format';
import type { PdfAction } from './pdf-common';
import type { RpReport } from './rp-report-queries';
import { cashFlowTable, type CashFlowSheetOptions, type ReportSheet } from './report-sheet';
import { generateReportPdf } from './report-sheet-pdf';
import { downloadReportXlsx } from './report-sheet-xlsx';

/** 1,234.56 with a bracketed negative — the Finance reports' one money dress (fmtSenPlain). */
export const fmtRp = (sen: number): string => fmtSenPlain(sen);

/** The Cash Flow as the screen shows it, ready for paper or Excel. */
export function cashFlowSheet(r: RpReport, opts: CashFlowSheetOptions = {}): ReportSheet {
  const period = `${fmtDate(r.from)} – ${fmtDate(r.to)}`;
  const rows = r.byParty ? 'By debtor / creditor' : "By the owner's accounts";
  return {
    title: 'Cash Flow',
    subtitle: `${period} · every bank and cash account · ${rows.toLowerCase()} · % of the side's total`,
    meta: [
      { label: 'Period', value: period },
      { label: 'Accounts', value: r.columns.map((c) => c.code).join(', ') },
      { label: 'Rows', value: rows },
    ],
    tables: [cashFlowTable(r, opts)],
    fmt: fmtRp,
  };
}

const fileBase = (r: RpReport): string => `cash-flow-${r.from}-to-${r.to}`;

export const generateRpPdf = (r: RpReport, opts: CashFlowSheetOptions & { action?: PdfAction } = {}): Promise<void> =>
  generateReportPdf(cashFlowSheet(r, opts), { fileName: `${fileBase(r)}.pdf`, action: opts.action });

export const downloadRpXlsx = (r: RpReport, opts: CashFlowSheetOptions = {}): Promise<void> =>
  downloadReportXlsx(cashFlowSheet(r, opts), `${fileBase(r)}.xlsx`);
