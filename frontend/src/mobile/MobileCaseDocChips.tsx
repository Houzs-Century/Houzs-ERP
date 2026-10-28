// Mobile twin of components/assr/CaseDocChips.tsx: the Customer card's SO No,
// Ref No., and the order's DO No + Delivery Date (owner 2026-09-28). Both read
// the DO facts through vendor/scm/lib/assr/order-delivery.ts.
import { formatDate } from "../lib/utils";
import { orderDeliveryOf } from "../vendor/scm/lib/assr/order-delivery";
import { cellEllipsis } from "./assr-case-fields";

const INK = "#11140f";
const TEAL_DK = "#0c3f39";
const GREY = "#9aa093";
const DIM = "#e3e6e0";
const FIELD_BG = "#f4f6f3";

function Chip({ label, value, accent }: { label: string; value: string | null; accent?: boolean }) {
  return (
    <div style={{ background: FIELD_BG, border: `1px solid ${DIM}`, borderRadius: 9, padding: "7px 10px", minWidth: 0 }}>
      <div className="money" style={{ fontSize: 8.5, letterSpacing: ".1em", textTransform: "uppercase", color: GREY, fontWeight: 600 }}>{label}</div>
      <div className="money" style={{ fontSize: 12.5, fontWeight: 600, color: accent ? TEAL_DK : INK, marginTop: 3, ...cellEllipsis }}>{value || "—"}</div>
    </div>
  );
}

const first = (c: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (c[k] != null && c[k] !== "") return String(c[k]);
  return null;
};

export function MobileCaseDocChips({ c }: { c: Record<string, unknown> }) {
  const { doNo, deliveryDate } = orderDeliveryOf(c);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 11 }}>
      <Chip label="SO No" value={first(c, "docNo", "doc_no")} accent />
      <Chip label="Ref No." value={first(c, "refNo", "ref_no")} />
      <Chip label="DO No" value={doNo} />
      <Chip label="Delivery Date" value={deliveryDate ? formatDate(deliveryDate) : null} />
    </div>
  );
}
