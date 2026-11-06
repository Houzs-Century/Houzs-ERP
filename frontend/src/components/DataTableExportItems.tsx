// ----------------------------------------------------------------------------
// DataTableExportItems: the export lines of a table header's right-click menu
// (owner 2026-11-06: 「export 出来我觉得可以 right click export」, 「支持pdf?」).
// HeaderExportMenu: that menu for a plain table with no DataTable under it. One
// look for both, because a reader cannot tell which kind they right-clicked.
// ----------------------------------------------------------------------------

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { FileDown, FileSpreadsheet } from "lucide-react";
import { useViewportClampedPos } from "./dataTableHelpers";

export const HEADER_MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-surface-dim disabled:cursor-not-allowed disabled:text-ink-muted disabled:hover:bg-transparent";
const HEADER_MENU_CLASS =
  "fixed z-[120] min-w-[176px] overflow-y-auto overscroll-contain rounded-md border border-border bg-surface py-1 shadow-slab";

/** The sheet line's words say what its press writes. A table with an export of
 *  its own keeps its own words, as its toolbar button does; ticked rows are counted
 *  the way that button counts them. */
export function sheetExportLabel(o: {
  lines: boolean; custom: boolean; xlsx?: boolean; exportLabel: string; picked: number | null;
}): string {
  if (!o.lines && o.custom) return o.exportLabel;
  const label = o.lines || o.xlsx ? "Export to Excel" : "Export to CSV";
  return o.picked != null ? `${label} (${o.picked})` : label;
}

export function DataTableExportItems({ className, disabled, sheetLabel, onSheet, onPdf, divider = true }: {
  className: string;
  disabled?: boolean;
  sheetLabel: string;
  onSheet: () => void;
  /** Only a table that prints passes this; without it there is no PDF line. */
  onPdf?: () => void;
  divider?: boolean;
}) {
  return (
    <>
      <button type="button" className={className} disabled={disabled} onClick={onSheet}>
        <FileSpreadsheet size={13} className="shrink-0 text-ink-muted" />
        {sheetLabel}
      </button>
      {onPdf && (
        <button type="button" className={className} disabled={disabled} onClick={onPdf}>
          <FileDown size={13} className="shrink-0 text-ink-muted" />
          Export to PDF
        </button>
      )}
      {divider && <div className="my-1 border-t border-border-subtle" />}
    </>
  );
}

export function HeaderExportMenu({ at, onClose, onExcel, onPdf }: {
  at: { x: number; y: number };
  onClose: () => void;
  onExcel: () => void;
  onPdf: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const pos = useViewportClampedPos(at, ref) ?? { top: at.y, left: at.x };
  /* Closes the way DataTable's header menu closes: any click away, a scroll, Escape. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("click", onClose);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onClose);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      className={HEADER_MENU_CLASS}
      style={{ top: pos.top, left: pos.left, maxHeight: "calc(100vh - 16px)" }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <DataTableExportItems
        className={HEADER_MENU_ITEM_CLASS}
        divider={false}
        sheetLabel="Export to Excel"
        onSheet={() => { onClose(); onExcel(); }}
        onPdf={() => { onClose(); onPdf(); }}
      />
    </div>,
    document.body,
  );
}
