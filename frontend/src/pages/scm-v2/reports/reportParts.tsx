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
//     PDF opens the preview, Print prints that same PDF;
//   · <InPlaceOfReport> stands in for the report while it is open (the Layout
//     editor, batch 6 §5.12): the report and its header buttons step aside.
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
  /** Where a part that stands in for the report draws, and the switch that sets the report aside. */
  inPlaceHost: HTMLElement | null;
  setInPlace: (on: boolean) => void;
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

/** Draws its children in place of the report (the Layout editor, batch 6
 *  §5.12): while it is mounted the report below the header and the header's
 *  buttons step aside — hidden, not unmounted, so the report keeps its state —
 *  and come back when it closes. Outside a shell it renders where it stands. */
export function InPlaceOfReport({ children }: { children: ReactNode }) {
  const slots = useContext(ShellContext);
  const set = slots?.setInPlace;
  useEffect(() => {
    if (!set) return undefined;
    set(true);
    return () => set(false);
  }, [set]);
  if (!slots) return <>{children}</>;
  return slots.inPlaceHost ? createPortal(children, slots.inPlaceHost) : null;
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

/** A labelled tool in the toolbar card: a small grey name, then its control. */
export function ReportTool({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className={s.tool}>
      {label && <span className={s.toolLabel}>{label}</span>}
      {children}
    </div>
  );
}

/** A segmented control: one of a few, the one in use white on the grey track. */
export function Segmented<T extends string | number>({ options, value, onChange, label }: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className={s.segs} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" className={`${s.seg} ${o.value === value ? s.segOn : ''}`}
          aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** An on / off switch with its words beside it. */
export function ReportSwitch({ on, onChange, children }: { on: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={s.switch} onClick={() => onChange(!on)}>
      <span className={`${s.switchTrack} ${on ? s.switchOn : ''}`} aria-hidden><span className={s.switchKnob} /></span>
      {children}
    </button>
  );
}

export type ReportTileTone = 'plain' | 'good' | 'late';
export type ReportTile = {
  key: string;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: ReportTileTone;
  /** The small square before the label (a bucket's colour). */
  dot?: string;
  /** A tile that filters what is below it: pressed while it does. */
  onClick?: () => void;
  on?: boolean;
};

/** The figures over a report: label, figure, a line under it. `pending` shows
 *  each figure as a shimmer, never a zero that reads as a fact. */
export function ReportTiles({ tiles, label, pending = false }: { tiles: ReportTile[]; label: string; pending?: boolean }) {
  return (
    <div className={s.tiles} role="group" aria-label={label} style={{ '--tile-cols': String(Math.min(tiles.length, 6)) } as React.CSSProperties}>
      {tiles.map((t) => {
        const body = (
          <>
            <span className={s.tileLabel}>{t.dot && <span className={s.tileDot} style={{ background: t.dot }} aria-hidden />}{t.label}</span>
            <span className={s.tileValue}>{pending ? <span className={`skeleton ${s.tileSkel}`} aria-hidden /> : t.value}</span>
            {t.sub != null && t.sub !== '' && <span className={s.tileSub}>{pending ? '' : t.sub}</span>}
          </>
        );
        const cls = [s.tile, t.tone === 'late' ? s.tileLate : t.tone === 'good' ? s.tileGood : '', t.on ? s.tileOn : ''].join(' ');
        return t.onClick ? (
          <button key={t.key} type="button" className={cls} aria-pressed={Boolean(t.on)} onClick={t.onClick}>{body}</button>
        ) : (
          <div key={t.key} className={cls}>{body}</div>
        );
      })}
    </div>
  );
}

/** A line in place of the report: what is needed before it can show, or what failed. */
export function ReportMessage({ tone = 'calm', children }: { tone?: 'calm' | 'error'; children: ReactNode }) {
  return <p className={tone === 'error' ? s.error : s.message} role={tone === 'error' ? 'alert' : 'status'}>{children}</p>;
}
