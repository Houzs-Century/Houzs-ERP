/* The two list exports' shared page plumbing — the "Export lines" button and
   the run-one-export-at-a-time wrapper that reports a failure instead of
   swallowing it. Used by the Goods Received, Purchase Invoices and Sales
   Invoices lists (owner 2026-09-15: one row per line, the whole filtered
   listing). The Purchase Orders list carries its own copy from #3915. */

import { useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import { Button } from "../../components/Button";

type Notify = (n: { title: string; body: string; tone: "error" }) => unknown;

export function useListExportRunner(notify: Notify) {
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

export function ExportLinesButton({ exporting, onClick }: { exporting: boolean; onClick: () => void }) {
  return (
    <Button
      variant="secondary"
      icon={<FileSpreadsheet size={14} />}
      onClick={onClick}
      disabled={exporting}
      className="hidden md:inline-flex"
    >
      {exporting ? "Exporting…" : "Export lines"}
    </Button>
  );
}
