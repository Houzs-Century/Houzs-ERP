// Mobile twins of the desktop source/delivered chips (phone shell idiom:
// inline styles, display-only — the phone doesn't route on tap). One home so
// MobileModuleDetail (DO / SI / PO / GRN / PI lines) and MobileSODetail (SO
// lines) render the same chips the desktop drill-downs render — the owner's
// one-product rule, and the 2026-08-01 "identical source data on every
// surface" ruling. Detail rows render the FULL list (the "+N" overflow rule is
// for LIST cells; a phone detail line wraps instead).

import type { CSSProperties } from "react";

const rowStyle: CSSProperties = {
  flexBasis: "100%", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 4,
};
const eyebrowStyle: CSSProperties = {
  fontSize: 9.5, fontWeight: 700, letterSpacing: ".3px", textTransform: "uppercase", color: "#9aa093",
};
const solidChip: CSSProperties = {
  fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: "#0c3f39",
  background: "#eef3f1", border: "1px solid #d7e2de", borderRadius: 5, padding: "1px 6px",
};
const mutedChip: CSSProperties = {
  fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: "#5c6357",
  background: "#f4f6f3", border: "1px solid #d9ded4", borderRadius: 5, padding: "1px 6px",
};

/* Mobile stock pill — the SAME rule as the desktop soLineStockPill
   (components/SoSourceChips.tsx), phone-shell colors: fully shipped →
   DELIVERED; on-hand → READY; partially covered → PARTIAL; else PENDING;
   SERVICE always READY (owner 2026-07-24). Keep the two in lockstep. */
export function soStockPillMobile(l: {
  item_group?: string | null;
  stock_status?: string | null;
  stock_state?: string | null;
  delivered_qty?: number | null;
  remaining_qty?: number | null;
}): { label: string; fg: string; bg: string; bd: string } | null {
  if ((l.item_group ?? "").toUpperCase().includes("SERVICE"))
    return { label: "READY", fg: "#16695f", bg: "#e1efed", bd: "#b9d8d2" };
  const shipped = (l.delivered_qty ?? 0) > 0 && (l.remaining_qty ?? null) === 0;
  if (shipped) return { label: "DELIVERED", fg: "#5c6357", bg: "#f4f6f3", bd: "#d9ded4" };
  if (l.stock_state === "stock" || (l.stock_status ?? "").toUpperCase() === "READY")
    return { label: "READY", fg: "#16695f", bg: "#e1efed", bd: "#b9d8d2" };
  if ((l.stock_status ?? "").toUpperCase() === "PARTIAL")
    return { label: "PARTIAL", fg: "#8a6116", bg: "rgba(212,151,40,0.12)", bd: "rgba(212,151,40,0.45)" };
  return { label: "PENDING", fg: "#5c6357", bg: "#f4f6f3", bd: "#d9ded4" };
}

export function StockAdjChipMobile() {
  return (
    <span
      style={mutedChip}
      title="Stock adjustment — these goods entered stock without a purchase order (free gift / cancel add-back). PO-less by design."
    >
      STOCK ADJ
    </span>
  );
}

/* Sales docs (DO / SI / SO): the source PO(s) the goods came from. `ready`
   chips (SO only) carry a qty suffix under the same rule as Delivered: every
   qty on a multi-chip line, qty > 1 on a single chip. */
export function SourcePosRowMobile({
  pos,
  adj,
  ready,
  label = "Source PO",
  showEmpty = false,
}: {
  pos: string[];
  adj?: boolean;
  ready?: Array<{ po: string | null; qty: number; kind: "po" | "adjustment" }>;
  label?: string;
  /* SO lines: the MRP incoming-PO coverage for an un-arrived remainder
     (stock_state === 'po') — "PO-x · ETA dd/mm/yyyy" as muted mono text. */
  incoming?: { po: string; eta: string | null } | null;
  /* true → an unresolved line still renders the row with a dash (the desktop
     drill-down's honest "—"), so a blank is visible, never silent. */
  showEmpty?: boolean;
}) {
  const readyPo = (ready ?? []).filter((r) => r.kind === "po" && r.po && !pos.includes(r.po));
  const anyAdj = Boolean(adj) || (ready ?? []).some((r) => r.kind === "adjustment");
  if (pos.length === 0 && readyPo.length === 0 && !anyAdj && !incoming) {
    if (!showEmpty) return null;
    return (
      <div style={rowStyle}>
        <span style={eyebrowStyle}>{label}</span>
        <span style={{ fontSize: 11, color: "#9aa093" }}>—</span>
      </div>
    );
  }
  const chipCount = pos.length + readyPo.length;
  return (
    <div style={rowStyle}>
      <span style={eyebrowStyle}>{label}</span>
      {pos.map((po) => (
        <span key={`s-${po}`} style={solidChip} title="The shipped goods physically came from this purchase order's batch.">
          {po}
        </span>
      ))}
      {readyPo.map((r) => (
        <span
          key={`r-${r.po}`}
          style={solidChip}
          title="READY — the allocated stock sits in this purchase order's batch (FIFO projection of what the delivery will consume)."
        >
          {r.po}
          {(chipCount > 1 || r.qty > 1) ? ` x${r.qty}` : ""}
        </span>
      ))}
      {anyAdj && <StockAdjChipMobile />}
      {incoming && (
        <span
          className="money"
          style={{ fontSize: 10.5, fontWeight: 700, color: "#a16a2e" }}
          title="Incoming — the purchase order the MRP allocation covers this line with, and its ETA."
        >
          {incoming.po}
          {incoming.eta ? ` · ETA ${incoming.eta}` : ""}
        </span>
      )}
    </div>
  );
}

/* Purchase docs (PO / GRN / PI): the DO(s) that shipped this line's goods.
   Multi-DO lines ALWAYS show each qty — a 1+1 batch split must not read as one
   unit shipped twice (owner 2026-08-01); a single chip shows qty only past 1. */
export function DeliveredRowMobile({ dos }: { dos: Array<{ doNo: string; qty: number }> }) {
  if (dos.length === 0) return null;
  return (
    <div style={rowStyle}>
      <span style={eyebrowStyle}>Delivered</span>
      {dos.map((d) => (
        <span key={d.doNo} style={solidChip} title="A Delivery Order that shipped this line's goods">
          {d.doNo}
          {(dos.length > 1 || d.qty > 1) ? ` x${d.qty}` : ""}
        </span>
      ))}
    </div>
  );
}
