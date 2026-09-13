// ----------------------------------------------------------------------------
// MobileLinePoRef — the purchase order a goods-receipt / purchase-invoice line
// came from, on the phone. Desktop twin: the "PO" column (LinePoRefLink) on
// GoodsReceivedDetailV2 and PurchaseInvoiceDetailV2 (#26). One reading of
// whether a line HAS a PO — `linePoLink` — for both surfaces.
//
// Tapping opens the order through the shell's flow navigation (the same gate
// the Relationship Map uses), so a user who may not open purchase orders sees
// the number without a dead button.
// ----------------------------------------------------------------------------
import type { CSSProperties } from "react";
import { linePoLink, type LinePoFields, type LinePoLink } from "../vendor/scm/lib/line-po-link";
import type { FlowNav } from "./relationship-map-model";

const PO_REF_MODULES = new Set(["grns", "purchase-invoices"]);

/** undefined = this document does not carry the row; null = it does, and this
 *  line has no PO behind it. */
export const mobileLinePoRefFor = (moduleKey: string, line: LinePoFields): LinePoLink | null | undefined =>
  PO_REF_MODULES.has(moduleKey) ? linePoLink(line) : undefined;

const rowStyle: CSSProperties = { flexBasis: "100%", display: "flex", alignItems: "center", gap: 6, marginTop: 4 };
const eyebrowStyle: CSSProperties = { fontSize: 9.5, fontWeight: 700, letterSpacing: ".3px", textTransform: "uppercase", color: "#9aa093" };
const chipStyle: CSSProperties = {
  fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: "#0c3f39",
  background: "#eef3f1", border: "1px solid #d7e2de", borderRadius: 5, padding: "1px 6px",
};

export function MobileLinePoRef({ poRef, nav }: { poRef: LinePoLink | null | undefined; nav?: FlowNav }) {
  if (poRef === undefined) return null;
  if (poRef === null) {
    return <div style={rowStyle}><span style={eyebrowStyle}>PO</span><span style={{ fontSize: 11, color: "#9aa093" }}>—</span></div>;
  }
  const target = { kind: "module" as const, moduleKey: "mfg-purchase-orders", id: poRef.id };
  const canOpen = !!nav && nav.can(target);
  return (
    <div style={rowStyle}>
      <span style={eyebrowStyle}>PO</span>
      {canOpen ? (
        <button type="button" onClick={() => nav.open(target)} style={{ ...chipStyle, cursor: "pointer", textDecoration: "underline" }} aria-label={`Open purchase order ${poRef.number}`}>
          {poRef.number}
        </button>
      ) : (
        <span style={chipStyle}>{poRef.number}</span>
      )}
    </div>
  );
}
