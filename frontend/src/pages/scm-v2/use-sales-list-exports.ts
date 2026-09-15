/* ----------------------------------------------------------------------------
   use-sales-list-exports — the Sales Order and Delivery Order lists' two
   exports, over every document the list's filters match (owner 2026-09-15).

   "Export lines" (one row per line, .xlsx) and the toolbar Export (one row per
   document, .csv, the grid's visible columns) both read the WHOLE filtered
   listing — never the screen page — with the parameters the list itself sends
   (vendor/scm/lib/sales-list-export.ts). The Purchase Order list does the same
   inline; these two screens are at their size ceilings, so the wiring lives
   here and each screen spends a line on it.

   Desktop only: the phone Sales Order and Delivery Order lists have no export
   at all (checked 2026-09-15), so there is no phone twin to keep in step.
   ---------------------------------------------------------------------------- */

import { useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import { downloadCSV, toCSV, type CSVColumn } from "../../lib/csv";
import { todayMyt } from "../../vendor/scm/lib/dates";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import type { MenuItem } from "../../components/RowActionsMenu";
import type { EnrichableSoRow } from "../../lib/soListEnrichment";
import {
  fetchAllDoListRows,
  fetchAllSoListRows,
  fetchDoLineExport,
  fetchSoLineExport,
  writeDoLineExportXlsx,
  writeSoLineExportXlsx,
  type DoListExportFilters,
  type SoListExportFilters,
} from "../../vendor/scm/lib/sales-list-export";

/* The SO list columns whose cells the deferred MRP enrichment heals
   (MRP_DERIVED_LIST_FIELD_MAP): Stock Status reads stock_remark, PO No. reads
   source_po_union. */
const SO_MRP_COLUMN_KEYS = new Set(["stock_status", "po_doc_no"]);

function useExportRunner() {
  const notify = useNotify();
  const [exporting, setExporting] = useState(false);
  const run = async (what: string, work: () => Promise<void>) => {
    if (exporting) return;
    setExporting(true);
    try {
      await work();
    } catch (e) {
      await notify({ title: `${what} failed`, body: (e as Error).message || "The export could not be completed.", tone: "error" });
    } finally {
      setExporting(false);
    }
  };
  return { exporting, run };
}

const linesAction = (exporting: boolean, onClick: () => void): MenuItem => ({
  icon: FileSpreadsheet,
  label: exporting ? "Exporting…" : "Export lines",
  onClick,
});

export function useSoListExports<T extends EnrichableSoRow & { doc_no: string }>(filters: SoListExportFilters) {
  const { exporting, run } = useExportRunner();
  return {
    linesAction: linesAction(exporting, () => void run("Export lines", async () => {
      const body = await fetchSoLineExport(filters);
      await writeSoLineExportXlsx(body, `sales-order-lines-${todayMyt()}.xlsx`);
    })),
    exportHeaders: (cols: CSVColumn<T>[]) => void run("Export", async () => {
      const all = await fetchAllSoListRows<T>(filters, cols.some((c) => SO_MRP_COLUMN_KEYS.has(c.key)));
      downloadCSV(`sales-orders-${todayMyt()}.csv`, toCSV(all, cols));
    }),
  };
}

export function useDoListExports<T extends { id: string }>(filters: DoListExportFilters) {
  const { exporting, run } = useExportRunner();
  return {
    linesAction: linesAction(exporting, () => void run("Export lines", async () => {
      const body = await fetchDoLineExport(filters);
      await writeDoLineExportXlsx(body, `delivery-order-lines-${todayMyt()}.xlsx`);
    })),
    exportHeaders: (cols: CSVColumn<T>[]) => void run("Export", async () => {
      const all = await fetchAllDoListRows<T>(filters);
      downloadCSV(`delivery-orders-${todayMyt()}.csv`, toCSV(all, cols));
    }),
  };
}

/* The status word the list's CSV and the line export both print — re-exported
   so the screen reads it from the same module its exports come from. */
export { soListStatusWord } from "../../vendor/scm/lib/so-line-export-columns";
export { doStatusWord } from "../../vendor/scm/lib/do-line-export-columns";
