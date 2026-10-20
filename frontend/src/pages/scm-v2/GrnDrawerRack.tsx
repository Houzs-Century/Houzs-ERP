/* A GRN line's rack in the Goods Receipt list's side panel (Sim, 2026-10-20:
   "can this page show the rack, any shortcut to add it instead of open full
   page & edit"). A pick saves at once through the same hook and endpoint as the
   phone (useSetGrnLineRack -> PATCH /grns/:id/items/:itemId/rack); who may
   change it and the rack list come from the shared vendor/scm/lib/grn-line-rack.
   A line already split over several racks is shown, and changed on the full page. */
import { useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { canOperateGoodsReceipts } from "../../auth/salesAccess";
import { useGrnItemRacks, useSetGrnLineRack } from "../../vendor/scm/lib/grn-queries";
import { grnRackEditable, lineRackSummary, useGrnRackOptions } from "../../vendor/scm/lib/grn-line-rack";
import { effectiveRackSplit } from "../../vendor/shared/rack-split";

export function GrnDrawerRack({ grnId, status, warehouseId, line }: {
  grnId: string;
  status: string;
  warehouseId: string | null;
  line: { id?: string; item_code?: string | null; rack_id?: string | null; qty_accepted?: number | null; qty_received?: number | null };
}) {
  const { can, pageAccess } = useAuth();
  const racksQ = useGrnRackOptions(warehouseId ?? undefined);
  const splitQ = useGrnItemRacks(grnId);
  const setRack = useSetGrnLineRack();
  const [error, setError] = useState<string | null>(null);
  if (!line.id) return null;
  const itemId = line.id;

  const accepted = Number(line.qty_accepted ?? line.qty_received ?? 0) || 0;
  const rows = (splitQ.data ?? []).filter((r) => r.grnItemId === itemId).map((r) => ({ rackId: r.rackId, qty: r.qty }));
  const summary = lineRackSummary(effectiveRackSplit(line.rack_id ?? null, accepted, rows), accepted, (id) => racksQ.labelById.get(id));
  const editable = grnRackEditable(status) && canOperateGoodsReceipts(can, pageAccess) && rows.length <= 1;

  const onChange = (rackId: string) => {
    setError(null);
    setRack.mutate(
      { grnId, itemId, rackId: rackId || null },
      { onError: (e) => setError(e instanceof Error && e.message ? e.message : "The rack was not saved. Please try again.") },
    );
  };

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      <span className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">Rack</span>
      {editable ? (
        <select
          aria-label={`Rack for ${line.item_code ?? "this line"}`}
          value={rows.length === 1 ? rows[0].rackId : line.rack_id ?? ""}
          disabled={setRack.isPending || racksQ.isLoading || racksQ.options.length === 0}
          onChange={(e) => onChange(e.target.value)}
          className={`h-7 min-w-0 max-w-[220px] flex-1 rounded-md border bg-surface px-2 text-[12px] text-ink ${summary.text ? "border-border" : "border-warning-text/30"}`}
        >
          <option value="">
            {racksQ.isLoading ? "Loading racks…" : racksQ.options.length === 0 ? "No racks in this warehouse" : "Pick a rack"}
          </option>
          {racksQ.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <span className="text-[12px] text-ink-secondary">{summary.text || "—"}</span>
      )}
      {setRack.isPending && <span className="text-[11px] text-ink-muted">Saving…</span>}
      {error && <span role="alert" className="basis-full text-[11.5px] text-danger">{error}</span>}
    </div>
  );
}
