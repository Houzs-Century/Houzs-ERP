/* The GRN line's Rack, on the phone's receipt detail. The phone has no separate
   line editor, so a pick saves at once through the SAME hook and endpoint the
   desktop Save uses (useSetGrnLineRack -> PATCH /grns/:id/items/:itemId/rack).
   Who may change it and which racks are offered come from the shared
   vendor/scm/lib/grn-line-rack.ts; only the presentation is the phone's. */
import { useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { canOperateGoodsReceipts } from "../auth/salesAccess";
import { useRacks } from "../vendor/scm/lib/warehouse-queries";
import { useSetGrnLineRack } from "../vendor/scm/lib/grn-queries";
import { grnRackEditable, grnRackOptions } from "../vendor/scm/lib/grn-line-rack";

type Header = Record<string, unknown> | null;
type Line = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Mount inside a GRN line card. Renders nothing for any other module. */
export function MobileGrnLineRack({ moduleKey, grnId, header, line, onSaved }: {
  moduleKey: string;
  grnId: string;
  header: Header;
  line: Line;
  onSaved: () => void;
}) {
  if (moduleKey !== "grns" || !str(line.id)) return null;
  return <RackRow grnId={grnId} header={header} line={line} onSaved={onSaved} />;
}

function RackRow({ grnId, header, line, onSaved }: { grnId: string; header: Header; line: Line; onSaved: () => void }) {
  const { can, pageAccess } = useAuth();
  const warehouseId = str(header?.warehouse_id);
  const racksQ = useRacks({ warehouseId: warehouseId || undefined });
  const setRack = useSetGrnLineRack();
  const [error, setError] = useState<string | null>(null);

  const options = grnRackOptions(racksQ.data?.racks ?? []);
  const current = str(line.rack_id);
  const currentLabel = options.find((o) => o.value === current)?.label ?? "";
  const editable = grnRackEditable(str(header?.status)) && canOperateGoodsReceipts(can, pageAccess);

  const onChange = (rackId: string) => {
    setError(null);
    setRack.mutate(
      { grnId, itemId: str(line.id), rackId: rackId || null },
      {
        onSuccess: onSaved,
        onError: (e) => setError(e instanceof Error && e.message ? e.message : "The rack was not saved. Please try again."),
      },
    );
  };

  return (
    <div style={{ flexBasis: "100%", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 6 }}>
      <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "#9aa093" }}>Rack</span>
      {editable ? (
        <select
          aria-label="Rack"
          value={current}
          disabled={setRack.isPending || racksQ.isLoading || options.length === 0}
          onChange={(e) => onChange(e.target.value)}
          style={{ flex: 1, minWidth: 0, height: 34, padding: "0 8px", borderRadius: 8, border: "1px solid #e3e6e0", background: "#fff", fontFamily: "inherit", fontSize: 13, color: "var(--ink)" }}
        >
          <option value="">
            {racksQ.isLoading ? "Loading racks…" : options.length === 0 ? "No racks in this warehouse" : "— No rack —"}
          </option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <span style={{ fontSize: 12, color: "#11140f" }}>{currentLabel || "—"}</span>
      )}
      {error && <div role="alert" style={{ flexBasis: "100%", fontSize: 11.5, color: "#b23a3a" }}>{error}</div>}
    </div>
  );
}
