/* The GRN line's Rack, on the phone's receipt detail. The phone has no separate
   line editor, so a pick saves at once through the SAME hook and endpoint the
   desktop Save uses (useSetGrnLineRack -> PATCH /grns/:id/items/:itemId/rack).
   Who may change it and which racks are offered come from the shared
   vendor/scm/lib/grn-line-rack.ts; only the presentation is the phone's.
   Scan reads the shelf's rack sticker instead of picking from the list
   (owner 2026-10-01: the storekeeper places the goods, so the storekeeper sets
   the rack); a scan is resolved by the shared vendor/scm/lib/rack-qr.ts.
   On a DRAFT the row is a SPLIT editor (owner 2026-10-02: one delivery of one
   product often fills several shelves): each shelf with its qty, scanned or
   picked, through the shared useGrnLineRackSplit. Posted lines keep the
   one-rack picker; a posted split is shown, and moved on the rack board. */
import { useEffect, useState } from "react";
import { Camera, Flashlight, X } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { canOperateGoodsReceipts } from "../auth/salesAccess";
import { useQrScanner } from "../lib/use-qr-scanner";
import { useGrnItemRacks, useSetGrnLineRack } from "../vendor/scm/lib/grn-queries";
import { grnRackEditable, grnRackSplitEditable, useGrnLineRackSplit, useGrnRackOptions } from "../vendor/scm/lib/grn-line-rack";
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
  return <RackCell grnId={grnId} header={header} line={line} onSaved={onSaved} />;
}

function RackCell({ grnId, header, line, onSaved }: { grnId: string; header: Header; line: Line; onSaved: () => void }) {
  const { can, pageAccess } = useAuth();
  const splitting = grnRackSplitEditable(str(header?.status)) && canOperateGoodsReceipts(can, pageAccess);
  return splitting
    ? <SplitRow grnId={grnId} header={header} line={line} onSaved={onSaved} />
    : <RackRow grnId={grnId} header={header} line={line} onSaved={onSaved} />;
}

const LABEL_STYLE = { fontSize: 9.5, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "#9aa093" } as const;
const SMALL_BTN = { height: 32, padding: "0 10px", borderRadius: 8, border: "1px solid #e3e6e0", background: "#fff", fontFamily: "inherit", fontSize: 12.5 } as const;

function SplitRow({ grnId, header, line, onSaved }: { grnId: string; header: Header; line: Line; onSaved: () => void }) {
  const warehouseId = str(header?.warehouse_id);
  const racksQ = useGrnRackOptions(warehouseId || undefined);
  const racks = racksQ.racks;
  const options = racksQ.options;
  const labelOf = (id: string) => racksQ.labelById.get(id) ?? "?";
  const qtyAccepted = Number(line.qty_accepted ?? 0) || 0;
  const split = useGrnLineRackSplit({ grnId, itemId: str(line.id), lineRackId: str(line.rack_id) || null, qtyAccepted });
  const [scanOpen, setScanOpen] = useState(false);
  const [pending, setPending] = useState<string>("");
  const [qty, setQty] = useState("");

  const choose = (rackId: string) => {
    setScanOpen(false);
    setPending(rackId);
    setQty(String(split.remaining > 0 ? split.remaining : 1));
  };
  const add = () => {
    const n = Number(qty);
    split.add(pending, n, () => { setPending(""); onSaved(); });
  };
  const busy = split.saving || racksQ.isLoading || split.loading;

  return (
    <div style={{ flexBasis: "100%", display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <span style={LABEL_STYLE}>Racks</span>
        {split.splits.map((s) => (
          <span key={s.rackId} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 4px 3px 9px", borderRadius: 999, background: "#e8f1ef", color: "#11140f", fontSize: 12.5 }}>
            {labelOf(s.rackId)} &times; {s.qty}
            <button type="button" aria-label={`Remove ${labelOf(s.rackId)}`} disabled={busy}
              onClick={() => split.remove(s.rackId, onSaved)}
              style={{ display: "inline-flex", border: "none", background: "transparent", padding: 2, color: "#767b6e" }}>
              <X size={12} />
            </button>
          </span>
        ))}
        <span style={{ fontSize: 11.5, color: split.remaining > 0 ? "#8a5a00" : "#16695f" }}>
          {split.remaining > 0 ? `${split.remaining} of ${qtyAccepted} not on a rack yet` : `All ${qtyAccepted} on racks`}
        </span>
      </div>

      {pending ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{labelOf(pending)}</span>
          <input aria-label="Quantity on this rack" inputMode="numeric" value={qty}
            onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))}
            style={{ width: 64, height: 32, padding: "0 8px", borderRadius: 8, border: "1px solid #e3e6e0", fontFamily: "inherit", fontSize: 13 }} />
          <button type="button" onClick={add} disabled={busy || !qty}
            style={{ ...SMALL_BTN, border: "1px solid #16695f", background: "#16695f", color: "#fff", fontWeight: 600 }}>
            Add
          </button>
          <button type="button" onClick={() => setPending("")} style={SMALL_BTN}>Cancel</button>
        </div>
      ) : !scanOpen && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button type="button" onClick={() => setScanOpen(true)} disabled={busy || options.length === 0}
            style={{ ...SMALL_BTN, display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid #16695f", color: "#16695f", fontWeight: 600 }}>
            <Camera size={14} /> Scan
          </button>
          <select aria-label="Pick a rack" value="" disabled={busy || options.length === 0}
            onChange={(e) => e.target.value && choose(e.target.value)}
            style={{ flex: 1, minWidth: 0, height: 32, padding: "0 8px", borderRadius: 8, border: "1px solid #e3e6e0", background: "#fff", fontFamily: "inherit", fontSize: 13 }}>
            <option value="">{racksQ.isLoading ? "Loading racks…" : options.length === 0 ? "No racks in this warehouse" : "Pick a rack"}</option>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      )}
      {scanOpen && <RackScanPanel racks={racks} onClose={() => setScanOpen(false)} onRack={choose} />}
      {split.error && <div role="alert" style={{ fontSize: 11.5, color: "#b23a3a" }}>{split.error}</div>}
    </div>
  );
}

function RackRow({ grnId, header, line, onSaved }: { grnId: string; header: Header; line: Line; onSaved: () => void }) {
  const { can, pageAccess } = useAuth();
  const warehouseId = str(header?.warehouse_id);
  const racksQ = useGrnRackOptions(warehouseId || undefined);
  const setRack = useSetGrnLineRack();
  const splitQ = useGrnItemRacks(grnId);
  const [error, setError] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);

  const options = racksQ.options;
  const postedSplit = (splitQ.data ?? []).filter((r) => r.grnItemId === str(line.id));
  if (postedSplit.length > 1) {
    return (
      <div style={{ flexBasis: "100%", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 6 }}>
        <span style={LABEL_STYLE}>Racks</span>
        <span style={{ fontSize: 12, color: "#11140f" }}>
          {postedSplit.map((r) => `${racksQ.labelById.get(r.rackId) ?? "?"} × ${r.qty}`).join(" · ")}
        </span>
      </div>
    );
  }
  const current = str(line.rack_id);
  const currentLabel = racksQ.labelById.get(current) ?? "";
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
          racks={racksQ.racks}
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
