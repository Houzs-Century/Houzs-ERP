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
import { PoPriceReference } from "../vendor/scm/components/PoPriceReference";
import { piPriceDifferenceSummary } from "../vendor/scm/lib/pi-po-price-rule";
import { fmtSen } from "../lib/scm";

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

/* The one slot MobileModuleDetail renders under a GRN / PI line. On a purchase
   invoice it adds the PO price beside the PI price (owner 2026-09-14: 「点开这个
   PI 时，我也能一眼看清：根据 PO 设想的价钱是多少，以及最终开单（PI）又是多少」) —
   the same PoPriceReference the desktop editor and detail use. Reference only. */
type PoFactsLine = LinePoFields & { po_unit_price_sen?: number | null; unit_price_sen?: number | null };

export function MobileLinePoFacts({ moduleKey, line, nav }: { moduleKey: string; line: PoFactsLine; nav?: FlowNav }) {
  const poRef = mobileLinePoRefFor(moduleKey, line);
  return (
    <>
      <MobileLinePoRef poRef={poRef} nav={nav} />
      {moduleKey === "purchase-invoices" && (
        <div style={rowStyle}>
          <span style={eyebrowStyle}>PO price</span>
          <PoPriceReference poUnitPriceSen={line.po_unit_price_sen} piUnitPriceSen={Number(line.unit_price_sen ?? 0) || 0} fmt={(sen) => fmtSen(sen)} />
        </div>
      )}
    </>
  );
}

/** The phone's at-a-glance line on a purchase invoice: how many lines were
 *  billed at a price other than the PO's. null when none differ. */
export const mobilePiPoPriceNotice = (
  items: ReadonlyArray<{ qty?: number | null; unit_price_sen?: number | null; po_unit_price_sen?: number | null }> | null | undefined,
): string | null => {
  const { linesDiffering, totalDiffSen } = piPriceDifferenceSummary((items ?? []).map((it) => ({
    qty: Number(it.qty ?? 0) || 0,
    supplierUnitPriceSen: Number(it.unit_price_sen ?? 0) || 0,
    poUnitPriceSen: it.po_unit_price_sen ?? null,
  })));
  if (linesDiffering === 0) return null;
  const net = `${totalDiffSen >= 0 ? "+" : "−"}${fmtSen(Math.abs(totalDiffSen))}`;
  return `${linesDiffering} ${linesDiffering === 1 ? "line" : "lines"} billed at a different price from the PO (net ${net}). For reference only.`;
};
