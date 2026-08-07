// Mobile twins of the desktop source/delivered chips (phone shell idiom:
// inline styles, display-only — the phone doesn't route on tap). One home so
// MobileModuleDetail (DO / SI / PO / GRN / PI lines) and MobileSODetail (SO
// lines) render the same chips the desktop drill-downs render — the owner's
// one-product rule, and the 2026-08-01 "identical source data on every
// surface" ruling. Detail rows render the FULL list (the "+N" overflow rule is
// for LIST cells; a phone detail line wraps instead).

import type { CSSProperties } from "react";
import { formatDate } from "../lib/utils";

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
/* Floating identity (Decision, docs/modules/purchase-order.md 2026-08-06: soft
   until DO): a live, recomputed-on-every-view allocation wears a dashed border.
   Mobile twin of the desktop dashed chips — keep in lockstep. */
const floatingChip: CSSProperties = {
  ...mutedChip, background: "transparent", border: "1px dashed #b6c6c0",
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
  incoming = null,
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
          style={floatingChip}
          title="READY — a live FIFO projection of the batch the delivery would consume, recomputed on every view; the Delivery Order decides the actual batch."
        >
          {r.po}
          {(chipCount > 1 || r.qty > 1) ? ` x${r.qty}` : ""}
        </span>
      ))}
      {anyAdj && <StockAdjChipMobile />}
      {incoming && (
        <span
          className="money"
          style={{ ...floatingChip, fontSize: 10.5 }}
          title="Incoming — live MRP coverage for the un-arrived remainder, recomputed on every view; it moves as demand moves."
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

/* "STOCK" — a purchase-doc line with NO assignment is surplus stock, not
   missing data (owner 2026-08-02). Mobile twin of the desktop StockTag; MRP
   float-assigns automatically when matching demand appears. */
export function StockTagMobile() {
  return (
    <span
      style={{ ...mutedChip, border: "1px dashed #d9ded4", textTransform: "uppercase", letterSpacing: ".4px", fontSize: 10 }}
      title="Stock replenishment — no open Sales Order demand is assigned to this line. MRP will float-assign it automatically when matching demand appears."
    >
      STOCK
    </span>
  );
}

/* Purchase docs (PO / GRN / PI): the PAIRED per-SO rows (owner 2026-08-02,
   replacing three unaligned stacks): one row per assigned SO =
   [SO chip | delivery date | delivered-DO chips xqty for THAT SO | status].
   An unshipped SO with a future date reads PENDING, never blank; a delivered
   DO whose SO is not among the assignments still renders (extra row). Empty
   both sides → the STOCK tag. Desktop twin: PairedSoCell in
   components/DocumentLinesExpansion.tsx — keep the two in lockstep, including
   the three chip identities (anchored solid / provenance muted / floating
   dashed + "~") from the soft-until-DO Decision. */
export function PairedSoRowsMobile({
  assigned,
  delivered,
  sourceLinked,
}: {
  assigned: Array<{ soDocNo: string; deliveryDate?: string | null; locked?: boolean; source?: string }>;
  delivered: Array<{ doNo: string; qty: number; soDocNo?: string | null }>;
  sourceLinked?: boolean;
  }) {
  const rows: Array<{ soDocNo: string; deliveryDate: string | null; floating: boolean; chip: CSSProperties; title: string; dos: Array<{ doNo: string; qty: number }> }> = [];
  for (const a of assigned) {
    const floating = a.locked === false || a.source === "mrp";
    const anchored = !floating && a.source === "delivered";
    rows.push({
      soDocNo: a.soDocNo,
      deliveryDate: a.deliveryDate ?? null,
      floating,
      chip: floating ? floatingChip : anchored ? solidChip : mutedChip,
      title: floating
        ? "Floating — live MRP allocation, recomputed on every view. It moves as demand moves and can disappear."
        : anchored
          ? "Delivered — this line's goods shipped against this Sales Order (anchored history)"
          : sourceLinked === false
            ? "This Sales Order is an MRP allocation — no stored link on the purchase order line"
            : `Bought for ${a.soDocNo} — procurement provenance, not the live assignment.`,
      dos: [],
    });
  }
  for (const d of delivered) {
    const hit = rows.find((r) => r.soDocNo === (d.soDocNo ?? ""));
    if (hit) hit.dos.push({ doNo: d.doNo, qty: d.qty });
    else {
      let orphan = rows.find((r) => r.soDocNo === (d.soDocNo || "—") && r.title.startsWith("This Delivery"));
      if (!orphan) {
        orphan = {
          soDocNo: d.soDocNo || "—", deliveryDate: null, floating: false, chip: solidChip,
          title: "This Delivery Order's Sales Order is not among this line's assignments — shown so the shipment stays visible.",
          dos: [],
        };
        rows.push(orphan);
      }
      orphan.dos.push({ doNo: d.doNo, qty: d.qty });
    }
  }
  if (rows.length === 0) {
    return (
      <div style={rowStyle}>
        <span style={eyebrowStyle}>Assigned SO</span>
        <StockTagMobile />
      </div>
    );
  }
  return (
    <div style={{ flexBasis: "100%", display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
      {rows.map((r) => {
        const shipped = r.dos.length > 0;
        return (
          <div key={r.soDocNo} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            <span title={r.title} style={r.chip}>
              {r.soDocNo}{r.floating ? " ~" : ""}
            </span>
            <span className="money" style={{ fontSize: 10.5, color: "#9aa093", fontWeight: 600 }}>
              {r.deliveryDate ? formatDate(r.deliveryDate) : "—"}
            </span>
            {r.dos.map((d) => (
              <span key={d.doNo} style={solidChip} title="The Delivery Order that shipped this line's goods for this Sales Order">
                {d.doNo}
                {(r.dos.length > 1 || d.qty > 1) ? ` x${d.qty}` : ""}
              </span>
            ))}
            <span
              style={{
                fontSize: 9, fontWeight: 800, letterSpacing: ".4px", padding: "2px 8px", borderRadius: 20,
                color: shipped ? "#16695f" : "#5c6357",
                background: shipped ? "#e1efed" : "#f4f6f3",
              }}
              title={shipped
                ? "Delivered — at least one Delivery Order has shipped this line's goods for this Sales Order"
                : "Pending — assigned, nothing shipped for this Sales Order yet (delivery date shown)"}
            >
              {shipped ? "DELIVERED" : "PENDING"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
