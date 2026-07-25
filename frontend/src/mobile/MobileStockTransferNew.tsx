import { useMemo, useState } from "react";
import { lineIdentity } from "@2990s/shared";
import { todayMyt } from "../vendor/scm/lib/dates";
import { useWarehouses } from "../vendor/scm/lib/inventory-queries";
import {
  useInventoryBuckets,
  useCreateStockTransfer,
} from "../vendor/scm/lib/stock-queries";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { useIdempotencyKey } from "../lib/idempotency";
import { MobileSkuPicker, type PickedSku } from "./MobileSkuPicker";

/* ------------------------------------------------------------------ *
 * Mobile New Stock Transfer — From -> To (must differ) + date + notes,
 * item lines with a SKU picker + a per-line VARIANT BUCKET picker (the
 * exact stock, with on-hand qty, the transfer moves — owner 2026-07-20).
 * Same shape as desktop StockTransferNew. Reuses the vendored
 * useCreateStockTransfer + useInventoryBuckets; no backend change.
 * ------------------------------------------------------------------ */

type LineDraft = { _key: string; productCode: string; productName: string; variantKey?: string; qty: number };

// Humanise a variant_key ("fabriccode=bf-16|gap=16|legheight=2") into a compact
// bucket label. '' = the unclassified / plain-SKU bucket.
const humanizeVariantKey = (k: string): string =>
  k ? k.split("|").map((s) => s.replace("=", " ")).join(" · ") : "(unclassified)";

// Sentinel for "no bucket picked yet" — distinct from '' (a real unclassified bucket).
const UNPICKED = "__UNPICKED__";

// One transfer line. Owns its OWN inventory-bucket query so each line offers only
// its SKU's real variant buckets (with on-hand qty) at the From warehouse — the
// operator moves the exact bucket, keeping stock + MRP accurate (owner 2026-07-20).
function MobileTransferLine({
  line, fromWarehouseId, setVariant, setQty, removeLine,
}: {
  line: LineDraft;
  fromWarehouseId: string;
  setVariant: (key: string, variantKey: string | undefined) => void;
  setQty: (key: string, qty: number) => void;
  removeLine: (key: string) => void;
}) {
  const bucketsQ = useInventoryBuckets(line.productCode || null, fromWarehouseId || null);
  const variantBuckets = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of (bucketsQ.data ?? [])) m.set(b.variant_key ?? "", (m.get(b.variant_key ?? "") ?? 0) + b.qty);
    return [...m.entries()].map(([variantKey, qty]) => ({ variantKey, qty })).sort((a, b) => b.qty - a.qty);
  }, [bucketsQ.data]);
  const avail = line.variantKey === undefined
    ? undefined
    : variantBuckets.find((v) => v.variantKey === line.variantKey)?.qty;
  const over = avail != null && line.qty > avail;

  return (
    <div className="st-line">
      <div className="lh">
        <div>
          <div className="sku">{lineIdentity({ code: line.productCode, description: line.productName }).primary}</div>
        </div>
        <button className="x" onClick={() => removeLine(line._key)} aria-label="Remove line">×</button>
      </div>
      <select
        className="cal-sel"
        style={{ marginTop: 8, fontSize: 13 }}
        value={line.variantKey === undefined ? UNPICKED : line.variantKey}
        onChange={(e) => setVariant(line._key, e.target.value === UNPICKED ? undefined : e.target.value)}
        disabled={!fromWarehouseId || !line.productCode}
      >
        <option value={UNPICKED} disabled>
          {!fromWarehouseId ? "Pick source first"
            : bucketsQ.isLoading ? "Loading…"
            : variantBuckets.length === 0 ? "No stock at source"
            : "Pick variant / bucket…"}
        </option>
        {variantBuckets.map((v) => (
          <option key={v.variantKey || "__plain__"} value={v.variantKey}>
            {humanizeVariantKey(v.variantKey)} — {v.qty} avail
          </option>
        ))}
      </select>
      <div className="qtyrow">
        <div className="stepper">
          <button onClick={() => setQty(line._key, line.qty - 1)} aria-label="Decrease">−</button>
          <span className="q tnum">{line.qty}</span>
          <button onClick={() => setQty(line._key, line.qty + 1)} aria-label="Increase">+</button>
        </div>
        <span className={`avail${over ? " over" : ""} tnum`}>
          {!fromWarehouseId ? "pick source"
            : line.variantKey === undefined ? "pick bucket"
            : avail == null ? "avail —"
            : `avail ${avail}`}
        </span>
      </div>
    </div>
  );
}

let seq = 0;
const newKey = () => `l${seq++}`;

export function MobileStockTransferNew({
  onBack,
  onCreated,
}: {
  onBack: () => void;
  onCreated?: () => void;
}) {
  const notify = useNotify();
  const create = useCreateStockTransfer();
  /* One key for the one transfer this screen is open to raise
     (lib/idempotency.ts). MobileApp mounts this behind a screen and onCreated /
     onBack leave it (MobileApp.tsx:457), so the MOUNT is exactly one transfer.
     The desktop twin (StockTransferNew) mints its own — the same document
     protected on both sides in one PR, since a document covered on one side only
     is a new divergence. */
  const idemKey = useIdempotencyKey();
  const warehouses = useWarehouses();

  const [fromWarehouseId, setFromWarehouseId] = useState("");
  const [toWarehouseId, setToWarehouseId] = useState("");
  const [transferDate, setTransferDate] = useState(() => todayMyt());
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Per-line variant buckets (available at the source) are pulled inside
  // <MobileTransferLine> so each line offers only its own SKU's real buckets.

  const whList = warehouses.data ?? [];
  const sameWarehouse = Boolean(fromWarehouseId && toWarehouseId && fromWarehouseId === toWarehouseId);
  // A line is valid only once its variant BUCKET is picked (variantKey set) —
  // moving stock without it would desync the FIFO bucket + MRP.
  const validLines = lines.filter((l) => l.productCode.trim() && l.qty > 0 && l.variantKey !== undefined);
  const needsBucket = lines.some((l) => l.productCode.trim() && l.qty > 0 && l.variantKey === undefined);
  const canCreate =
    !!fromWarehouseId && !!toWarehouseId && !sameWarehouse && !!transferDate &&
    validLines.length > 0 && !needsBucket && !create.isPending;

  // A SKU whose source stock is split across variant buckets (e.g. bf-16 + bf-20)
  // needs ONE line PER bucket — each <MobileTransferLine> owns its own bucket
  // picker and is keyed by _key (not code), so duplicate codes never collide.
  // The old dedup no-op'd the second add of the same code, forcing a
  // split-bucket SKU into SEPARATE transfer documents. Append a fresh line every
  // time (the desktop StockTransferNew has no such dedup either).
  const addSku = (sku: PickedSku) => {
    setPickerOpen(false);
    setLines((prev) => [...prev, { _key: newKey(), productCode: sku.itemCode, productName: sku.name, qty: 1 }]);
  };
  const setVariant = (key: string, variantKey: string | undefined) =>
    setLines((prev) => prev.map((l) => (l._key === key ? { ...l, variantKey } : l)));
  const setQty = (key: string, qty: number) =>
    setLines((prev) => prev.map((l) => (l._key === key ? { ...l, qty: Math.max(1, qty) } : l)));
  const removeLine = (key: string) => setLines((prev) => prev.filter((l) => l._key !== key));

  const submit = () => {
    if (!canCreate) return;
    create.mutate(
      {
        idempotencyKey: idemKey,
        fromWarehouseId,
        toWarehouseId,
        transferDate,
        notes: notes.trim() || undefined,
        items: validLines.map((l) => ({ productCode: l.productCode, productName: l.productName, variantKey: l.variantKey, qty: l.qty })),
      },
      {
        onSuccess: (r) => {
          void notify({ title: `Stock transfer ${r.transferNo} created` });
          onCreated ? onCreated() : onBack();
        },
        onError: (e) =>
          void notify({ title: e instanceof Error ? e.message : "Couldn't create the transfer.", tone: "error" }),
      },
    );
  };

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}><span className="chev">‹</span> Back</button>
          <span className="eyebrow">Warehouse · Move stock</span>
        </div>
        <div className="hdr-row" style={{ marginTop: 2 }}>
          <div className="scr-title">New Stock Transfer</div>
        </div>
      </header>

      <div className="hz-scroll" style={{ flex: 1, overflowY: "auto", padding: 14, paddingBottom: 40, display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="st-whrow">
          <div className="st-fld">
            <span className="st-fl">From</span>
            <select className="cal-sel" value={fromWarehouseId} onChange={(e) => setFromWarehouseId(e.target.value)}>
              <option value="">Select…</option>
              {whList.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
            </select>
          </div>
          <div className="st-arrow">→</div>
          <div className="st-fld">
            <span className="st-fl">To</span>
            <select className="cal-sel" value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)}>
              <option value="">Select…</option>
              {whList.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
            </select>
          </div>
        </div>
        {sameWarehouse && <div className="st-warn">From and To must be different warehouses.</div>}

        <div className="st-whrow">
          <div className="st-fld">
            <span className="st-fl">Date</span>
            <input type="date" className="cal-sel" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} />
          </div>
          <div className="st-fld">
            <span className="st-fl">Notes</span>
            <input className="cal-sel" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
          </div>
        </div>

        <div className="sc-sl"><span className="t">Items</span><span className="ln" /></div>
        {lines.map((l) => (
          <MobileTransferLine
            key={l._key}
            line={l}
            fromWarehouseId={fromWarehouseId}
            setVariant={setVariant}
            setQty={setQty}
            removeLine={removeLine}
          />
        ))}

        {needsBucket && (
          <div className="st-warn">
            Pick the variant bucket on every line — that is the exact stock (fabric / height / special) the transfer moves.
          </div>
        )}

        <button className="st-addln" onClick={() => setPickerOpen(true)}>+ Add item</button>
      </div>

      <div className="actbar">
        <button className="btn" disabled={!canCreate} style={{ opacity: canCreate ? 1 : 0.5 }} onClick={submit}>
          {create.isPending ? "Creating…" : "Create transfer"}
        </button>
      </div>

      {pickerOpen && (
        <MobileSkuPicker onPick={addSku} onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
}

export default MobileStockTransferNew;
