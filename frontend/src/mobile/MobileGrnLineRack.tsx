/* The GRN line's Rack, on the phone's receipt detail. The phone has no separate
   line editor, so a pick saves at once through the SAME hook and endpoint the
   desktop Save uses (useSetGrnLineRack -> PATCH /grns/:id/items/:itemId/rack).
   Who may change it and which racks are offered come from the shared
   vendor/scm/lib/grn-line-rack.ts; only the presentation is the phone's.
   Scan reads the shelf's rack sticker instead of picking from the list
   (owner 2026-10-01: the storekeeper places the goods, so the storekeeper sets
   the rack); a scan is resolved by the shared vendor/scm/lib/rack-qr.ts. */
import { useEffect, useState } from "react";
import { Camera, Flashlight, X } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { canOperateGoodsReceipts } from "../auth/salesAccess";
import { useQrScanner } from "../lib/use-qr-scanner";
import { useRacks } from "../vendor/scm/lib/warehouse-queries";
import { useSetGrnLineRack } from "../vendor/scm/lib/grn-queries";
import { grnRackEditable, grnRackOptions } from "../vendor/scm/lib/grn-line-rack";
import { rackScanRefusal, resolveRackScan } from "../vendor/scm/lib/rack-qr";

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
  const [scanOpen, setScanOpen] = useState(false);

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
      {editable && !scanOpen && (
        <button
          type="button"
          onClick={() => { setError(null); setScanOpen(true); }}
          disabled={setRack.isPending || racksQ.isLoading || options.length === 0}
          style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 34, padding: "0 10px", borderRadius: 8, border: "1px solid #16695f", background: "#fff", color: "#16695f", fontFamily: "inherit", fontSize: 12.5, fontWeight: 600 }}
        >
          <Camera size={14} /> Scan
        </button>
      )}
      {scanOpen && (
        <RackScanPanel
          racks={racksQ.data?.racks ?? []}
          onClose={() => setScanOpen(false)}
          onRack={(rackId) => { setScanOpen(false); onChange(rackId); }}
        />
      )}
      {error && <div role="alert" style={{ flexBasis: "100%", fontSize: 11.5, color: "#b23a3a" }}>{error}</div>}
    </div>
  );
}

/* Opens the camera on mount and stays open until a sticker of THIS receipt's
   warehouse is read; any other QR only explains itself, so the storekeeper can
   just aim at the right shelf. */
function RackScanPanel({ racks, onRack, onClose }: {
  racks: ReadonlyArray<{ id: string; rack: string }>;
  onRack: (rackId: string) => void;
  onClose: () => void;
}) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const scanner = useQrScanner((value) => {
    const hit = resolveRackScan(value, racks);
    if (hit.kind === "ok") {
      scanner.stop();
      onRack(hit.rackId);
    } else {
      setRefusal(rackScanRefusal(hit));
    }
  });
  const { start, stop } = scanner;
  useEffect(() => {
    void start();
    return stop;
  }, [start, stop]);

  return (
    <div style={{ flexBasis: "100%", display: "flex", flexDirection: "column", gap: 6, padding: 8, borderRadius: 10, border: "1px solid #e3e6e0", background: "#f4f6f3" }}>
      <video ref={scanner.videoRef} playsInline muted style={{ width: "100%", borderRadius: 8, background: "#000" }} />
      <div style={{ display: "flex", gap: 6 }}>
        <span style={{ flex: 1, fontSize: 11.5, color: "#767b6e", alignSelf: "center" }}>Aim at the rack sticker</span>
        {scanner.torchSupported && (
          <button type="button" aria-label="Torch" onClick={() => void scanner.toggleTorch()}
            style={{ height: 32, padding: "0 10px", borderRadius: 8, border: "1px solid #e3e6e0", background: "#fff" }}>
            <Flashlight size={14} />
          </button>
        )}
        <button type="button" aria-label="Close scanner" onClick={() => { stop(); onClose(); }}
          style={{ height: 32, padding: "0 10px", borderRadius: 8, border: "1px solid #e3e6e0", background: "#fff" }}>
          <X size={14} />
        </button>
      </div>
      {scanner.cameraError && <div role="alert" style={{ fontSize: 11.5, color: "#b23a3a" }}>{scanner.cameraError}</div>}
      {refusal && <div role="status" style={{ fontSize: 11.5, color: "#8a5a00" }}>{refusal}</div>}
    </div>
  );
}
