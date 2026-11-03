// ----------------------------------------------------------------------------
// reportParts — what a Finance report uses to sit in the report shell (batch 6
// §4.3) without being restructured, apart from the shell itself so a report
// never loads the report list's dependencies:
//   · <ReportHeaderActions> puts its buttons in the shell's header (they render
//     where they stand when the report is drawn outside a shell, e.g. a test);
//   · useReportSubtitle(text) sets the header's grey line (the period);
//   · <ReportToolbar> is the white card its date range and tools sit in;
//   · <ReportExports> are Layout · Excel · PDF · Print, drawn from the report's
//     sheet the way today's exports are (report-sheet-xlsx / report-sheet-pdf):
//     PDF opens the preview, Print prints that same PDF.
// ----------------------------------------------------------------------------

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FileDown, FileSpreadsheet, Layers, Printer } from 'lucide-react';
import type { ReportSheet } from '../../../vendor/scm/lib/report-sheet';
import s from './ReportShell.module.css';

/** What the shell lends the report inside it: where its header buttons go,
 *  and the setter of its grey line. */
export type ShellSlots = {
  actionsHost: HTMLElement | null;
  setSubtitle: (text: string | null) => void;
};

export const ShellContext = createContext<ShellSlots | null>(null);

/** A report's header buttons: in the shell's header, or where they stand when
 *  the report is drawn on its own. */
export function ReportHeaderActions({ children }: { children: ReactNode }) {
  const slots = useContext(ShellContext);
  if (!slots) return <>{children}</>;
  return slots.actionsHost ? createPortal(children, slots.actionsHost) : null;
}

/** The grey line under the report's title (the period it shows). */
export function useReportSubtitle(text: string | null): void {
  const slots = useContext(ShellContext);
  const set = slots?.setSubtitle;
  useEffect(() => {
    if (!set) return undefined;
    set(text);
    return () => set(null);
  }, [set, text]);
}

/** The white card under the header: the date range first, then the report's own tools. */
export function ReportToolbar({ children, label = 'Report tools' }: { children: ReactNode; label?: string }) {
  return <div className={s.toolbar} role="toolbar" aria-label={label}>{children}</div>;
}

/** Layout (where the report has one) · Excel · PDF · Print, made from the
 *  report's sheet — the screen as shown. PDF opens the preview (with its own
 *  Download and Print); Print prints that same PDF. The builders load on the
 *  press, so a report that never exports never downloads them. */
export function ReportExports({ sheet, fileBase, onLayout, layoutOn = false }: {
  /** The sheet as shown, or null while there is nothing to export. */
  sheet: () => ReportSheet | null;
  /** The file name without its extension: pnl-2026-10-01-to-2026-10-29. */
  fileBase: string;
  onLayout?: () => void;
  layoutOn?: boolean;
}) {
  const excel = async () => {
    const sh = sheet();
    if (!sh) return;
    const { downloadReportXlsx } = await import('../../../vendor/scm/lib/report-sheet-xlsx');
    await downloadReportXlsx(sh, `${fileBase}.xlsx`);
  };
  const pdf = async (action: 'preview' | 'print') => {
    const sh = sheet();
    if (!sh) return;
    const { generateReportPdf } = await import('../../../vendor/scm/lib/report-sheet-pdf');
    await generateReportPdf(sh, { fileName: `${fileBase}.pdf`, action });
  };
  return (
    <>
      {onLayout && (
        <button type="button" className={`${s.btn} ${layoutOn ? s.btnOn : ''}`} aria-pressed={layoutOn} onClick={onLayout}>
          <Layers size={14} strokeWidth={1.75} aria-hidden />Layout
        </button>
      )}
      <button type="button" className={s.btn} onClick={() => { void excel(); }}>
        <FileSpreadsheet size={14} strokeWidth={1.75} aria-hidden />Excel
      </button>
      <button type="button" className={s.btn} onClick={() => { void pdf('preview'); }}>
        <FileDown size={14} strokeWidth={1.75} aria-hidden />PDF
      </button>
      <button type="button" className={s.btn} onClick={() => { void pdf('print'); }}>
        <Printer size={14} strokeWidth={1.75} aria-hidden />Print
      </button>
    </>
  );
}
