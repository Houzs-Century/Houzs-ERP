import { useMemo, useState } from "react";
import { siDepositAppliedSen, siOutstandingSen } from "../vendor/scm/lib/si-outstanding";
import { visibleFields, canOperateDeliveryOrders, canOperateSalesInvoices } from "../auth/salesAccess";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lineIdentity, orderLineIdentity } from "@2990s/shared";
import { buildVariantSummary } from "../vendor/shared/variant-summary";
import { formatPhone } from "@2990s/shared/phone";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { usePoSoCoverage, originsByCode, provenanceByCode, storedLinkSkus, deliveredByCode, type OriginAssignment } from "../vendor/scm/lib/flow-queries";
import { CommittedBatchRowMobile, PairedSoRowsMobile, SourcePosRowMobile } from "./source-chips";
import { MobileRelationshipMap } from "./MobileRelationshipMap";
import { useGrnZeroCostRemedy } from "./MobileGrnZeroCost";
import { flowAnchorForModule, type FlowNav } from "./relationship-map-model";
import { idempotentInit, useIdempotencyKey } from "../lib/idempotency";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { MODULE_CONFIGS } from "./MobileModuleList";
import { invalidateModuleShared } from "./sharedInvalidate";
import { todayMyt } from "../vendor/scm/lib/dates";
import {
  SI_TRANSFER_MOBILE_ROUTE_HINT,
  siTransferBlockReason,
} from "../vendor/scm/lib/do-next-step";
import { fmtSen } from "../lib/scm";
import { formatDate } from "../lib/utils";
import { PAYMENT_METHOD_CODES, PAYMENT_METHOD_DEFAULT_LABELS } from "../vendor/scm/lib/payment-methods";
import { PrintPreviewModal, usePrintPreview } from "../components/scm-v2/PrintPreviewModal";
import type { PdfAction } from "../vendor/scm/lib/pdf-common";
import "./mobile.css";

// ---------------------------------------------------------------------------
// MobileModuleDetail — ONE generic, read-only DETAIL screen behind the generic
// MobileModuleList. Given the module key + the already-loaded list `row`, it
// renders a clean full detail: a header card (doc number, party, status pill,
// date, money stats) plus — for document modules — a line-items list fetched by
// id. Simple (non-document) modules just render a tidy key/value dump of the
// row already handed in. Header + card idiom is a 1:1 match of MobileSODetail /
// MobilePMS (safe-area header, hz-scroll paddingBottom:120, status pill via
// color-mix, kv grid, .money numerals). Everything degrades: a missing field is
// an em-dash, never undefined / null / NaN.
//
// Document `:id` (or `:docNo`) endpoints + shapes wired (backend/src/scm/routes):
//   delivery-orders-mfg          GET /delivery-orders-mfg/:id           → { deliveryOrder,          items }
//   sales-invoices               GET /sales-invoices/:id                → { salesInvoice,           items }
//   grns                         GET /grns/:id                          → { grn,                    items }
//   mfg-purchase-orders          GET /mfg-purchase-orders/:id           → { purchaseOrder,          items }
//   purchase-invoices            GET /purchase-invoices/:id             → { purchaseInvoice,        items }
//   purchase-returns             GET /purchase-returns/:id              → { purchaseReturn,         items }
//   delivery-returns             GET /delivery-returns/:id              → { deliveryReturn,         items }
//   consignment-orders           GET /consignment-orders/:docNo         → { salesOrder,             items }
//   consignment-notes            GET /consignment-notes/:id             → { deliveryOrder,          items }
//   consignment-returns          GET /consignment-returns/:id           → { deliveryReturn,         items }
//   purchase-consignment-orders  GET /purchase-consignment-orders/:id   → { purchaseOrder,          items }
//   purchase-consignment-receives GET /purchase-consignment-receives/:id → { grn,                   items }
//   purchase-consignment-returns GET /purchase-consignment-returns/:id  → { purchaseReturn,         items }
// ---------------------------------------------------------------------------

// Money is stored as integer *_sen — delegate display to the shared SCM
// formatter (fmtSen). The local Number() coercion is what this adds: the
// callers hand in `unknown` (raw payload fields), which fmtSen does not take.
// The non-finite guard now also lives INSIDE fmtSen/fmtAmt, so this one is
// belt-and-braces — do not read it as the only thing standing between a stray
// NaN and the user.
const money = (centi: unknown) => {
  const n = Number(centi);
  return fmtSen(Number.isFinite(n) ? n : 0);
};

/** DD/MM/YYYY (TZ-aware via the shared helper), or em-dash when absent / unparseable. */
const dmy = (d: unknown) => (d == null || d === "" ? "—" : formatDate(String(d)));

/** Coerce anything to a safe display string; blanks / nullish → "". */
const s = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string") return v;
  return "";
};

const join = (...parts: unknown[]) => parts.map(s).map((p) => p.trim()).filter(Boolean).join(" · ");

/** Run a config accessor (primary / pill) against a row, swallowing throws. */
const safeCall = (fn: ((row: any) => string) | undefined, row: any): string => {
  if (!fn) return "";
  try { return fn(row) ?? ""; } catch { return ""; }
};

/** first non-empty string of the candidates, else "—". */
const firstOf = (...vals: unknown[]): string => {
  for (const v of vals) {
    const str = s(v).trim();
    if (str) return str;
  }
  return "—";
};

const pct = (basis: unknown) => {
  const n = Number(basis);
  if (!Number.isFinite(n)) return "—";
  return `${(n / 100).toLocaleString("en-MY", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
};

// ── Status → three-phase pill (mirror MobileSODetail phase()) ────────────────
function phase(status: unknown): "draft" | "cancelled" | "live" {
  const st = s(status).toUpperCase();
  if (st === "DRAFT") return "draft";
  if (st === "CANCELLED" || st === "VOID" || st === "VOIDED") return "cancelled";
  return "live";
}

/** A cancelled / voided document renders greyed + a "Cancelled {date}" ribbon
 *  and drops its action bar (spec §lifecycle: CANCELLED = read-only forever). */
function isCancelledDoc(status: unknown): boolean {
  return phase(status) === "cancelled";
}

/** Ribbon shown at the top of a cancelled document's scroll area. Dual-reads
 *  the cancel timestamp (camelCase ?? snake_case), degrading to a bare label. */
function CancelledRibbon({ header }: { header: any }) {
  const when = dmy(header?.cancelledAt ?? header?.cancelled_at ?? header?.voidedAt ?? header?.voided_at ?? header?.updatedAt ?? header?.updated_at);
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 7, marginBottom: 13, padding: "9px 12px",
        background: "#f8eaea", border: "1px solid #f0d4d4", borderRadius: 11,
        fontSize: 12, fontWeight: 700, color: "#b23a3a",
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#b23a3a" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M15 9l-6 6M9 9l6 6" /></svg>
      <span>Cancelled{when !== "—" ? ` ${when}` : ""}</span>
    </div>
  );
}

function StatusPill({ status }: { status: unknown }) {
  const raw = s(status).trim();
  if (!raw) return null;
  const p = phase(status);
  // VERBATIM from MobileSODetail's soPill: Submitted [#e1efed,#0c3f39,none] ·
  // Draft [#f4f6f3,#767b6e,border] · Cancelled [#f8eaea,#b23a3a,none].
  const map: Record<string, [string, string, string]> = {
    live: ["#e1efed", "#0c3f39", "none"],
    draft: ["#f4f6f3", "#767b6e", "1px solid #e3e6e0"],
    cancelled: ["#f8eaea", "#b23a3a", "none"],
  };
  const [bg, fg, border] = map[p];
  const label = raw
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());
  return (
    <span className="spill" style={{ background: bg, color: fg, border }}>
      {label}
    </span>
  );
}

// ── Shared little presentational bits (design classes from MobileSODetail) ───
/** One key/value cell as it sits inside a `.pgrid2` grid — `.pkv-l` label over
 *  a `.pkv-v` value (money-monospaced when `mono`). Verbatim SO-detail idiom. */
function Kv({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="pkv-l">{label}</div>
      <div className={mono ? "pkv-v money" : "pkv-v"} style={{ wordBreak: "break-word" }}>{value || "—"}</div>
    </div>
  );
}

/** Money stat card — one of the 3 white cards under the header, `.ey` label. */
function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e3e6e0", borderRadius: 11, padding: 10, textAlign: "center" }}>
      <div className="money" style={{ fontSize: 13, fontWeight: 800, color }}>{value}</div>
      <div className="ey" style={{ color: "#9aa093", marginTop: 3 }}>{label}</div>
    </div>
  );
}

function Eyebrow({ children }: { children: string }) {
  return <div className="ey" style={{ color: "#767b6e", margin: "4px 2px 6px" }}>{children}</div>;
}

/** One `.docrow` line item: name + qty on top, unit price + amount below. */
function LineItem({ name, sub, qty, unitSen, amountSen, assigned, sourceLinked, provenance, allocations, poNumber, sourcePos, sourceAdj, delivered, committedBatch }: {
  name: string; sub?: string; qty: unknown; unitSen: unknown; amountSen: unknown;
  // Present (even if empty) only for purchase docs (PO/GRN/PI): the REAL origin
  // Sales Order(s) this line was raised from + that SO's effective delivery
  // date, matched by SKU. Empty array → dash, mirroring the desktop columns.
  // Display-only on mobile (the phone shell doesn't route to the SO).
  assigned?: OriginAssignment[];
  // PR-3 (2026-08-07): the coverage wire's PARALLEL stored-origin slot — the
  // "bought for" SO(s), rendered muted BESIDE the precedence rows above
  // (deduped by soDocNo inside PairedSoRowsMobile). Desktop twin: the
  // DocumentLinesExpansion provenance chips — one product.
  provenance?: OriginAssignment[];
  // Sales docs (DO / SI): the source PO(s) the shipped goods actually came from
  // (batch trail, GRN-healed) + the PO-less adjustment flag — the mobile twin
  // of the desktop drill-down's Source PO cell (owner 2026-08-01: identical
  // data on every surface).
  sourcePos?: string[];
  sourceAdj?: boolean;
  // DO lines only (mig 0230): the incoming PO batch this line committed to at
  // DO creation — the hard-from-DO anchor. Rendered as an anchored solid chip
  // (CommittedBatchRowMobile); absent → nothing. Display-only.
  committedBatch?: string | null;
  // Purchase docs (PO / GRN / PI): the DO(s) that shipped this line's goods,
  // with per-DO qty + the DO's own SO (soDocNo) so each chip pairs with its
  // Assigned-SO row — the mobile twin of the desktop per-SO sub-table.
  delivered?: Array<{ doNo: string; qty: number; soDocNo?: string | null }>;
  // false = no stored so_item_id behind the chip above; it is an MRP allocation
  // only. Desktop and mobile say this the same way (one-product rule): in the
  // chip's tooltip, since the owner removed the visible caption (2026-08-01).
  sourceLinked?: boolean;
  // mig 0235 — PO lines only: the line's sub-numbered allocations (which
  // customer / STOCK each slice of a consolidated purchase serves). Display-
  // only on mobile, matching the documented precedent (the phone PO surface
  // has no per-line editor at all); the split editor is the desktop detail's.
  // Rendered only when the line actually has slices — an unsplit line stays
  // exactly as it always was.
  allocations?: Array<{ seq: number; qty: number; so_doc_no: string | null }>;
  poNumber?: string;
}) {
  const q = Number(qty);
  const qtyLabel = Number.isFinite(q) ? q : 0;
  return (
    <div className="docrow" style={{ flexWrap: "wrap" }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: "#11140f" }}>
        {name || "—"} <span style={{ color: "#9aa093", fontWeight: 600 }}>{"×"}{qtyLabel}</span>
      </span>
      <span className="money" style={{ fontSize: 12.5, fontWeight: 800, color: "#11140f", flex: "none" }}>{money(amountSen)}</span>
      <div className="money" style={{ flexBasis: "100%", fontSize: 10.5, color: "#9aa093" }}>
        {sub ? <span style={{ marginRight: 8 }}>{sub}</span> : null}
        <span>@ {money(unitSen)}</span>
      </div>
      {assigned && (
        /* Purchase docs — the per-SO PAIRED rows (owner 2026-08-02): one row
           per assigned SO = [SO chip | date | that SO's delivered DOs xqty |
           DELIVERED/PENDING]. Empty = the STOCK tag, never a bare dash. The
           three separate stacks this replaces made "which SO has shipped"
           unreadable on multi-SO lines (the PO-2606-021 pillow case). */
        <PairedSoRowsMobile
          assigned={assigned}
          delivered={delivered ?? []}
          sourceLinked={sourceLinked}
          provenance={provenance}
        />
      )}
      {sourcePos !== undefined && (
        <SourcePosRowMobile pos={sourcePos} adj={sourceAdj} showEmpty />
      )}
      <CommittedBatchRowMobile poNo={committedBatch} />

      {(allocations?.length ?? 0) > 0 && (
        <div style={{ flexBasis: "100%", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 4 }}>
          <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".3px", textTransform: "uppercase", color: "#9aa093" }}>Allocations</span>
          {allocations!.map((a) => {
            const subNo = `${poNumber ?? ""}-${String(a.seq).padStart(2, "0")}`;
            const stock = !a.so_doc_no;
            /* Slices are procurement provenance (soft-until-DO Decision,
               docs/modules/purchase-order.md 2026-08-06) — muted like the
               desktop PurchaseOrderDetailV2 twin, "bought for", never
               "assigned". Stock slices keep the dashed look. */
            return (
              <span
                key={a.seq}
                title={stock
                  ? `${subNo} — ${a.qty} of this line bought for stock (no customer)`
                  : `${subNo} — ${a.qty} of this line bought for ${a.so_doc_no}. Procurement provenance, not the live assignment.`}
                style={{ fontFamily: "monospace", fontSize: 10.5, fontWeight: 700, color: "#5c6357", background: stock ? "transparent" : "#f4f6f3", border: stock ? "1px dashed #b6c6c0" : "1px solid #d9ded4", borderRadius: 5, padding: "1px 6px" }}
              >
                {subNo}{" -> "}{a.so_doc_no ?? "STOCK"} (qty {a.qty})
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Header card (shared by every module) ────────────────────────────────────
function DetailHeader({ eyebrow, title, subtitle, status, onBack, onEdit, onPdf, onMap }: {
  eyebrow: string; title: string; subtitle?: string; status?: unknown; onBack: () => void; onEdit?: () => void; onPdf?: () => void;
  /** Opens the mobile Relationship Map (document modules with a flow anchor). */
  onMap?: () => void;
}) {
  return (
    <header className="hdr">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 12.5, fontWeight: 600, color: "#16695f", cursor: "pointer" }}>
          <span style={{ fontSize: 17, lineHeight: 1 }}>{"‹"}</span> Back
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <StatusPill status={status} />
          {onMap && (
            <button className="tinybtn" onClick={onMap} style={{ background: "#f4f6f3", border: "1px solid var(--line2)", color: "var(--ink)" }}>
              Map
            </button>
          )}
          {onPdf && (
            <button className="tinybtn" onClick={onPdf} style={{ background: "#f4f6f3", border: "1px solid var(--line2)", color: "var(--ink)" }}>
              PDF
            </button>
          )}
          {onEdit && (
            <button className="tinybtn" onClick={onEdit} style={{ background: "#e1efed", border: "1px solid #16695f", color: "#0c3f39" }}>
              Edit
            </button>
          )}
        </div>
      </div>
      {eyebrow ? <div className="money" style={{ fontSize: 11.5, fontWeight: 700, color: "#a16a2e", marginTop: 7 }}>{eyebrow}</div> : null}
      <div style={{ fontSize: 19, fontWeight: 800, color: "#11140f", marginTop: 2, wordBreak: "break-word" }}>{title || "—"}</div>
      {subtitle ? <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>{subtitle}</div> : null}
    </header>
  );
}

const scrollStyle: React.CSSProperties = { padding: 14, paddingBottom: 120 };
const wrapStyle: React.CSSProperties = { display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" };
// Line-items / list card — same white rounded shell as MobileSODetail's item card.
const cardStyle: React.CSSProperties = { background: "#fff", border: "1px solid #e3e6e0", borderRadius: 12, padding: "2px 12px", marginBottom: 13 };

// ---------------------------------------------------------------------------
// Document detail — fetches header + line items by id, per module.
// ---------------------------------------------------------------------------

type DocMap = {
  path: string;
  headerKey: string;
  eyebrow: (h: any) => string;
  title: (h: any) => string;
  subtitle?: (h: any) => string;
  status: (h: any) => unknown;
  /** KV grid rows: [label, value]. */
  meta: (h: any) => Array<[string, string]>;
  /** [Total, Secondary, Tertiary] stats — each [label, value, color] or null. */
  stats: (h: any) => Array<[string, string, string] | null>;
  line: (it: any) => { name: string; sub?: string; qty: unknown; unitSen: unknown; amountSen: unknown };
  /** Optional amber warning bar between the stats and the line items —
   *  computed from the SAME detail payload (header + items), so no extra
   *  fetch. Return null for "nothing to warn about". */
  notice?: (h: any, items: any[]) => string | null;
};

const nested = (v: any) => (Array.isArray(v) ? v[0] : v) ?? null;

const DOC_MODULES: Record<string, DocMap> = {
  "delivery-orders-mfg": {
    path: "/delivery-orders-mfg",
    headerKey: "deliveryOrder",
    eyebrow: (h) => firstOf(h.do_number),
    title: (h) => firstOf(h.debtor_name, h.debtor_code),
    subtitle: (h) => (s(h.so_doc_no).trim() ? `SO ${s(h.so_doc_no)}` : ""),
    status: (h) => h.status,
    meta: (h) => [
      ["DO Date", dmy(h.do_date)],
      ["Delivery", dmy(h.customer_delivery_date ?? h.expected_delivery_at)],
      ["Phone", formatPhone(firstOf(h.phone))],
      ["Location", firstOf(h.sales_location, h.customer_state, h.state)],
      ["Reference", firstOf(h.ref, h.po_doc_no)],
      ["Salesperson", firstOf(h.agent)],
    ],
    /* Owner 2026-07-17: Cost + Margin stat tiles removed from the mobile DO
       document view for EVERYONE (desktop parity — the DO detail Totals·Margin
       card was removed too). Costing moves to the separate Finance module. */
    stats: (h) => [
      ["Total", money(h.local_total_sen), "var(--ink)"],
    ],
    /* Description ONCE, code NOT displayed — the shared rule
       (vendor/shared/line-identity.ts). `name` already preferred the
       description; the code was then repeated on `sub`, which is the reported
       shape. WAREHOUSE and DELIVERY DATE are NOT duplicates and stay on `sub`. */
    line: (it) => ({
      name: lineIdentity({ code: it.item_code, description: it.description }).primary,
      sub: join(it.warehouse_code, dmy(it.line_delivery_date) !== "—" ? dmy(it.line_delivery_date) : ""),
      qty: it.qty,
      unitSen: it.unit_price_sen,
      amountSen: it.line_total_sen,
    }),
  },

  "sales-invoices": {
    path: "/sales-invoices",
    headerKey: "salesInvoice",
    eyebrow: (h) => firstOf(h.invoice_number),
    title: (h) => firstOf(h.debtor_name, h.debtor_code),
    subtitle: (h) => (s(h.so_doc_no).trim() ? `SO ${s(h.so_doc_no)}` : ""),
    status: (h) => h.status,
    meta: (h) => [
      ["Invoice Date", dmy(h.invoice_date)],
      ["Due Date", dmy(h.due_date)],
      ["Phone", formatPhone(firstOf(h.phone))],
      ["Location", firstOf(h.sales_location, h.customer_state, h.state)],
      ["Reference", firstOf(h.ref, h.po_doc_no)],
      ["Salesperson", firstOf(h.agent)],
    ],
    stats: (h) => {
      const depositSen = siDepositAppliedSen(h); // own stat, never folded into Paid
      const bal = siOutstandingSen(Number(h.total_sen ?? h.local_total_sen ?? 0), Number(h.paid_sen ?? 0), depositSen);
      return [
        ["Total", money(h.total_sen ?? h.local_total_sen), "var(--ink)"],
        ["Paid", money(h.paid_sen), "#2f8a5b"],
        ...(depositSen > 0 ? [["SO deposit", money(depositSen), "#2f8a5b"] as [string, string, string]] : []),
        ["Balance", money(bal), bal > 0 ? "#a16a2e" : "var(--ink)"],
      ];
    },
    /* Item CODE first, then the variant subtitle; description dropped (owner 2026-07-24) — the shared order-line rule
       (vendor/shared/line-identity.ts). This adapter is the one place in the
       mobile set where the code and the VARIANT shared a line
       (`join(it.item_code, it.description2)`), so dropping `sub` wholesale would
       have deleted the variant — the row's only display of fabric / divan / leg
       / seat — rather than a duplicate. The helper splits them: code out,
       description2 stays. */
    line: (it) => {
      const { primary, secondary } = orderLineIdentity({
        code: it.item_code,
        description: it.description,
        variant: it.description2,
      });
      return {
        name: primary,
        sub: secondary ?? "",
        qty: it.qty,
        unitSen: it.unit_price_sen,
        amountSen: it.line_total_sen,
      };
    },
  },

  grns: {
    path: "/grns",
    headerKey: "grn",
    eyebrow: (h) => firstOf(h.grn_number),
    title: (h) => firstOf(nested(h.supplier)?.name, h.grn_number),
    subtitle: (h) => {
      const code = s(nested(h.supplier)?.code).trim();
      const po = s(nested(h.purchase_order)?.po_number).trim();
      return join(code, po ? `PO ${po}` : "");
    },
    status: (h) => h.status,
    meta: (h) => [
      ["Received", dmy(h.received_at)],
      ["Delivery Note", firstOf(h.delivery_note_ref)],
      ["Supplier", firstOf(nested(h.supplier)?.code)],
      ["Currency", firstOf(h.currency)],
    ],
    stats: (h) => [
      ["Subtotal", money(h.subtotal_sen), "var(--ink)"],
      ["Tax", money(h.tax_sen), "#767b6e"],
      ["Total", money(h.total_sen), "var(--ink)"],
    ],
    line: (it) => ({
      name: firstOf(it.material_name, it.description, it.item_code),
      sub: join(it.item_code, s(it.qty_accepted).trim() ? `Accepted ${s(it.qty_accepted)}` : ""),
      qty: it.qty_received ?? it.qty_accepted,
      unitSen: it.unit_price_sen,
      amountSen: it.line_total_sen,
    }),
  },

  "mfg-purchase-orders": {
    path: "/mfg-purchase-orders",
    headerKey: "purchaseOrder",
    eyebrow: (h) => firstOf(h.po_number),
    title: (h) => firstOf(nested(h.supplier)?.name, h.po_number),
    subtitle: (h) => firstOf(nested(h.supplier)?.code) === "—" ? "" : firstOf(nested(h.supplier)?.code),
    status: (h) => h.status,
    meta: (h) => [
      ["PO Date", dmy(h.po_date)],
      ["Expected", dmy(h.expected_at)],
      ["Supplier", firstOf(nested(h.supplier)?.code)],
      ["Contact", firstOf(nested(h.supplier)?.contact_person, nested(h.supplier)?.phone)],
      ["Currency", firstOf(h.currency)],
      ["Submitted", dmy(h.submitted_at)],
    ],
    stats: (h) => [
      ["Subtotal", money(h.subtotal_sen), "var(--ink)"],
      ["Tax", money(h.tax_sen), "#767b6e"],
      ["Total", money(h.total_sen), "var(--ink)"],
    ],
    line: (it) => ({
      name: firstOf(it.material_name, it.description, it.item_code),
      /* variant summary FIRST (item #1 of the mobile UI audit — every doc line
         surfaces the sofa/bedframe colour+composition), then item_code +
         cumulative received_qty. buildVariantSummary returns "" when the row
         has no variants, so a bare material line still reads correctly. */
      sub: join(
        buildVariantSummary(it.item_group, it.variants) || (it.description2 ?? ""),
        it.item_code,
        s(it.received_qty).trim() ? `Received ${s(it.received_qty)}` : "",
      ),
      qty: it.qty,
      unitSen: it.unit_price_sen,
      amountSen: it.line_total_sen,
    }),
    /* SO→PO drift (desktop parity, Commander 2026-06-16) — the detail payload's
       items already carry so_drift; same status gate as the desktop banner
       (only an order that is with the supplier can be stale). The phone gets
       the warning, the sync/re-send workflow stays on desktop. */
    notice: (h, items) => {
      const st = s(h?.status);
      if (st !== "SUBMITTED" && st !== "PARTIALLY_RECEIVED") return null;
      const n = (items ?? []).filter((it) => it?.so_drift).length;
      if (n === 0) return null;
      return `⚠ ${n} line${n === 1 ? "'s" : "s'"} source SO changed after this PO was raised — sync the specs and re-send to the supplier from desktop, otherwise the factory keeps building to the old spec.`;
    },
  },

  /* Purchase Invoice — supplier + PI number in the header, supplier code +
     supplier_invoice_ref (their invoice) as subtitle, PO + GRN in the meta
     grid. Balance = total_sen − paid_sen (mirrors the SI stat trio). */
  "purchase-invoices": {
    path: "/purchase-invoices",
    headerKey: "purchaseInvoice",
    eyebrow: (h) => firstOf(h.invoice_number),
    title: (h) => firstOf(nested(h.supplier)?.name, h.invoice_number),
    subtitle: (h) => join(
      firstOf(nested(h.supplier)?.code) === "—" ? "" : firstOf(nested(h.supplier)?.code),
      s(h.supplier_invoice_ref).trim() ? `Ref ${s(h.supplier_invoice_ref)}` : "",
    ),
    status: (h) => h.status,
    meta: (h) => [
      ["Invoice Date", dmy(h.invoice_date)],
      ["Due Date", dmy(h.due_date)],
      ["Supplier", firstOf(nested(h.supplier)?.code)],
      ["PO", firstOf(nested(h.purchase_order)?.po_number)],
      ["GRN", firstOf(nested(h.grn)?.grn_number)],
      ["Currency", firstOf(h.currency)],
      ["Posted", dmy(h.posted_at)],
    ],
    stats: (h) => {
      const totalSen = Number(h.total_sen ?? 0);
      const paidSen = Number(h.paid_sen ?? 0);
      const bal = Math.max(0, (Number.isFinite(totalSen) ? totalSen : 0) - (Number.isFinite(paidSen) ? paidSen : 0));
      return [
        ["Total", money(h.total_sen), "var(--ink)"],
        ["Paid", money(h.paid_sen), "#2f8a5b"],
        ["Balance", money(bal), bal > 0 ? "#a16a2e" : "var(--ink)"],
      ];
    },
    /* line: PI items key on item_code (PC/PO family) rather than item_code —
       hand it to lineIdentity as the code, description = material_name, and put
       the variant summary in secondary so the sofa/bedframe spec shows on every
       row. Falls back to the server-stamped description2 for pre-variant rows. */
    line: (it) => {
      const { primary } = lineIdentity({
        code: it.item_code,
        description: it.material_name ?? it.description,
      });
      return {
        name: primary,
        sub: buildVariantSummary(it.item_group, it.variants) || (it.description2 ?? ""),
        qty: it.qty,
        unitSen: it.unit_price_sen,
        amountSen: it.line_total_sen,
      };
    },
  },

  /* Purchase Return — supplier + return number, source PO/GRN in subtitle so
     the operator sees which supplier goods this reverses. Only stat is the
     refund total. Warehouse resolves per-line (backend stamps warehouse_code). */
  "purchase-returns": {
    path: "/purchase-returns",
    headerKey: "purchaseReturn",
    eyebrow: (h) => firstOf(h.return_number),
    title: (h) => firstOf(nested(h.supplier)?.name, h.return_number),
    subtitle: (h) => {
      const grn = s(nested(h.grn)?.grn_number).trim();
      const po = s(nested(h.purchase_order)?.po_number).trim();
      return join(grn ? `GRN ${grn}` : "", po ? `PO ${po}` : "");
    },
    status: (h) => h.status,
    meta: (h) => [
      ["Return Date", dmy(h.return_date)],
      ["Reason", firstOf(h.reason)],
      ["Supplier", firstOf(nested(h.supplier)?.code)],
      ["GRN", firstOf(nested(h.grn)?.grn_number)],
      ["PO", firstOf(nested(h.purchase_order)?.po_number)],
      ["Credit Note", firstOf(h.credit_note_ref)],
      ["Posted", dmy(h.posted_at)],
      ["Completed", dmy(h.completed_at)],
    ],
    stats: (h) => [
      ["Refund", money(h.refund_sen), "var(--ink)"],
    ],
    line: (it) => {
      const { primary } = lineIdentity({
        code: it.item_code,
        description: it.material_name,
      });
      return {
        name: primary,
        sub: join(
          buildVariantSummary(it.item_group, it.variants),
          it.warehouse_code,
        ),
        qty: it.qty_returned,
        unitSen: it.unit_price_sen,
        amountSen: it.line_refund_sen,
      };
    },
  },

  /* Delivery Return — the SO-side twin of purchase-returns. Customer + return
     number in the header, source DO number as subtitle. Total + Refund stats
     because the header carries both local_total_sen (line sum) and
     refund_sen (payable-out); the customer sees both on the printed slip. */
  "delivery-returns": {
    path: "/delivery-returns",
    headerKey: "deliveryReturn",
    eyebrow: (h) => firstOf(h.return_number),
    title: (h) => firstOf(h.debtor_name, h.return_number),
    subtitle: (h) => (s(h.do_doc_no).trim() ? `DO ${s(h.do_doc_no)}` : ""),
    status: (h) => h.status,
    meta: (h) => [
      ["Return Date", dmy(h.return_date)],
      ["Reason", firstOf(h.reason)],
      ["DO", firstOf(h.do_doc_no)],
      ["Phone", formatPhone(firstOf(h.phone))],
      ["Location", firstOf(h.sales_location, h.customer_state, h.state)],
      ["Received", dmy(h.received_at)],
      ["Inspected", dmy(h.inspected_at)],
      ["Refunded", dmy(h.refunded_at)],
      ["Reference", firstOf(h.ref)],
    ],
    stats: (h) => [
      ["Total", money(h.local_total_sen), "var(--ink)"],
      ["Refund", money(h.refund_sen), "#a16a2e"],
    ],
    line: (it) => {
      const { primary } = lineIdentity({
        code: it.item_code,
        description: it.description,
      });
      return {
        name: primary,
        sub: join(
          buildVariantSummary(it.item_group, it.variants) || (it.description2 ?? ""),
          it.condition,
          it.warehouse_code,
        ),
        qty: it.qty_returned,
        unitSen: it.unit_price_sen,
        amountSen: it.line_total_sen,
      };
    },
  },

  /* Consignment Order — the CO is a clone of the SO for loaner goods; the URL
     key is doc_no (endpoint /consignment-orders/:docNo, NOT /:id — see
     backend/src/scm/routes/consignment-orders.ts). docId() falls back to
     row.doc_no so the DocumentDetail fetch hits the right URL. */
  "consignment-orders": {
    path: "/consignment-orders",
    headerKey: "salesOrder",
    eyebrow: (h) => firstOf(h.doc_no),
    title: (h) => firstOf(h.debtor_name, h.doc_no),
    subtitle: (h) => join(
      s(h.agent).trim(),
      s(h.ref).trim() ? `Ref ${s(h.ref)}` : "",
      s(h.po_doc_no).trim() ? `PO ${s(h.po_doc_no)}` : "",
    ),
    status: (h) => h.status,
    meta: (h) => [
      ["Order Date", dmy(h.so_date)],
      ["Delivery", dmy(h.customer_delivery_date ?? h.processing_date)],
      ["Phone", formatPhone(firstOf(h.phone))],
      ["Location", firstOf(h.sales_location, h.customer_state, h.customer_country)],
      ["Reference", firstOf(h.ref, h.po_doc_no)],
      ["Salesperson", firstOf(h.agent)],
    ],
    stats: (h) => {
      const totalSen = Number(h.local_total_sen ?? 0);
      const paidSen = Number(h.paid_sen ?? 0);
      const bal = Math.max(0, (Number.isFinite(totalSen) ? totalSen : 0) - (Number.isFinite(paidSen) ? paidSen : 0));
      return [
        ["Total", money(h.local_total_sen), "var(--ink)"],
        ["Paid", money(h.paid_sen), "#2f8a5b"],
        ["Balance", money(bal), bal > 0 ? "#a16a2e" : "var(--ink)"],
      ];
    },
    line: (it) => {
      const { primary } = lineIdentity({
        code: it.item_code,
        description: it.description,
      });
      return {
        name: primary,
        sub: buildVariantSummary(it.item_group, it.variants) || (it.description2 ?? ""),
        qty: it.qty,
        unitSen: it.unit_price_sen,
        amountSen: it.total_sen,
      };
    },
  },

  /* Consignment Note — the CN is the CO's delivery twin (a shipped loaner).
     Endpoint /consignment-notes/:id returns { deliveryOrder, items }. Header
     carries local_total_sen (line sum); no paid/balance because payment on
     a consignment happens against the CO, not the note. */
  "consignment-notes": {
    path: "/consignment-notes",
    headerKey: "deliveryOrder",
    eyebrow: (h) => firstOf(h.do_number),
    title: (h) => firstOf(h.debtor_name, h.do_number),
    subtitle: (h) => (s(h.consignment_so_doc_no).trim() ? `CO ${s(h.consignment_so_doc_no)}` : ""),
    status: (h) => h.status,
    meta: (h) => [
      ["Note Date", dmy(h.do_date)],
      ["Delivery", dmy(h.customer_delivery_date ?? h.expected_delivery_at)],
      ["Phone", formatPhone(firstOf(h.phone))],
      ["Location", firstOf(h.sales_location, h.customer_state, h.state)],
      ["Reference", firstOf(h.ref, h.po_doc_no)],
      ["Driver", firstOf(h.driver_name)],
    ],
    stats: (h) => [
      ["Total", money(h.local_total_sen), "var(--ink)"],
    ],
    line: (it) => {
      const { primary } = lineIdentity({
        code: it.item_code,
        description: it.description,
      });
      return {
        name: primary,
        sub: join(
          buildVariantSummary(it.item_group, it.variants) || (it.description2 ?? ""),
          it.warehouse_code,
          dmy(it.line_delivery_date) !== "—" ? dmy(it.line_delivery_date) : "",
        ),
        qty: it.qty,
        unitSen: it.unit_price_sen,
        amountSen: it.line_total_sen,
      };
    },
  },

  /* Consignment Return — the CN's reverse. Endpoint /consignment-returns/:id
     returns { deliveryReturn, items }. Same two-money stats as delivery-returns
     (Total = local_total_sen, Refund = refund_sen). */
  "consignment-returns": {
    path: "/consignment-returns",
    headerKey: "deliveryReturn",
    eyebrow: (h) => firstOf(h.return_number),
    title: (h) => firstOf(h.debtor_name, h.return_number),
    subtitle: (h) => (s(h.do_doc_no).trim() ? `CN ${s(h.do_doc_no)}` : ""),
    status: (h) => h.status,
    meta: (h) => [
      ["Return Date", dmy(h.return_date)],
      ["Reason", firstOf(h.reason)],
      ["CN", firstOf(h.do_doc_no)],
      ["Phone", formatPhone(firstOf(h.phone))],
      ["Location", firstOf(h.sales_location, h.customer_state, h.state)],
      ["Received", dmy(h.received_at)],
      ["Inspected", dmy(h.inspected_at)],
      ["Refunded", dmy(h.refunded_at)],
    ],
    stats: (h) => [
      ["Total", money(h.local_total_sen), "var(--ink)"],
      ["Refund", money(h.refund_sen), "#a16a2e"],
    ],
    line: (it) => {
      const { primary } = lineIdentity({
        code: it.item_code,
        description: it.description,
      });
      return {
        name: primary,
        sub: join(
          buildVariantSummary(it.item_group, it.variants) || (it.description2 ?? ""),
          it.condition,
        ),
        qty: it.qty_returned,
        unitSen: it.unit_price_sen,
        amountSen: it.line_total_sen,
      };
    },
  },

  /* Purchase Consignment Order — the supplier-side PC family clone of a PO.
     Same shape as mfg-purchase-orders: supplier + pc_number, Subtotal/Tax/Total
     tiles. Endpoint returns { purchaseOrder, items } keyed by uuid :id. */
  "purchase-consignment-orders": {
    path: "/purchase-consignment-orders",
    headerKey: "purchaseOrder",
    eyebrow: (h) => firstOf(h.pc_number),
    title: (h) => firstOf(nested(h.supplier)?.name, h.pc_number),
    subtitle: (h) => firstOf(nested(h.supplier)?.code) === "—" ? "" : firstOf(nested(h.supplier)?.code),
    status: (h) => h.status,
    meta: (h) => [
      ["PC Date", dmy(h.po_date)],
      ["Expected", dmy(h.expected_at)],
      ["Supplier", firstOf(nested(h.supplier)?.code)],
      ["Contact", firstOf(nested(h.supplier)?.contact_person, nested(h.supplier)?.phone)],
      ["Currency", firstOf(h.currency)],
      ["Submitted", dmy(h.submitted_at)],
    ],
    stats: (h) => [
      ["Subtotal", money(h.subtotal_sen), "var(--ink)"],
      ["Tax", money(h.tax_sen), "#767b6e"],
      ["Total", money(h.total_sen), "var(--ink)"],
    ],
    line: (it) => {
      const { primary } = lineIdentity({
        code: it.item_code,
        description: it.material_name ?? it.description,
      });
      return {
        name: primary,
        sub: join(
          buildVariantSummary(it.item_group, it.variants) || (it.description2 ?? ""),
          it.item_code,
          s(it.received_qty).trim() ? `Received ${s(it.received_qty)}` : "",
        ),
        qty: it.qty,
        unitSen: it.unit_price_sen,
        amountSen: it.line_total_sen,
      };
    },
  },

  /* Purchase Consignment Receive — the PC family's GRN. Endpoint returns
     { grn, items } (same headerKey as regular GRN by design — the desktop
     clones the GRN screen). pc_order_no is the source PC Order's pc_number. */
  "purchase-consignment-receives": {
    path: "/purchase-consignment-receives",
    headerKey: "grn",
    eyebrow: (h) => firstOf(h.receive_number),
    title: (h) => firstOf(nested(h.supplier)?.name, h.receive_number),
    subtitle: (h) => {
      const code = s(nested(h.supplier)?.code).trim();
      const pc = s(nested(h.purchase_consignment_order)?.pc_number ?? h.pc_order_no).trim();
      return join(code, pc ? `PC ${pc}` : "");
    },
    status: (h) => h.status,
    meta: (h) => [
      ["Received", dmy(h.received_at)],
      ["Delivery Note", firstOf(h.delivery_note_ref)],
      ["Supplier", firstOf(nested(h.supplier)?.code)],
      ["PC Order", firstOf(nested(h.purchase_consignment_order)?.pc_number, h.pc_order_no)],
      ["Currency", firstOf(h.currency)],
      ["Posted", dmy(h.posted_at)],
    ],
    stats: (h) => [
      ["Subtotal", money(h.subtotal_sen), "var(--ink)"],
      ["Tax", money(h.tax_sen), "#767b6e"],
      ["Total", money(h.total_sen), "var(--ink)"],
    ],
    line: (it) => {
      const { primary } = lineIdentity({
        code: it.item_code,
        description: it.material_name ?? it.description,
      });
      return {
        name: primary,
        sub: join(
          buildVariantSummary(it.item_group, it.variants) || (it.description2 ?? ""),
          it.item_code,
          s(it.qty_accepted).trim() ? `Accepted ${s(it.qty_accepted)}` : "",
        ),
        qty: it.qty_received ?? it.qty_accepted,
        unitSen: it.unit_price_sen,
        amountSen: it.line_total_sen,
      };
    },
  },

  /* Purchase Consignment Return — the reverse of a PC Receive. Endpoint
     returns { purchaseReturn, items }. Only stat is refund_sen (a supplier
     credit); no per-line warehouse column on this doc's ITEM select. */
  "purchase-consignment-returns": {
    path: "/purchase-consignment-returns",
    headerKey: "purchaseReturn",
    eyebrow: (h) => firstOf(h.return_number),
    title: (h) => firstOf(nested(h.supplier)?.name, h.return_number),
    subtitle: (h) => {
      const pc = s(nested(h.purchase_consignment_order)?.pc_number).trim();
      const recv = s(nested(h.pc_receive)?.receive_number).trim();
      return join(pc ? `PC ${pc}` : "", recv ? `Receive ${recv}` : "");
    },
    status: (h) => h.status,
    meta: (h) => [
      ["Return Date", dmy(h.return_date)],
      ["Reason", firstOf(h.reason)],
      ["Supplier", firstOf(nested(h.supplier)?.code)],
      ["PC Order", firstOf(nested(h.purchase_consignment_order)?.pc_number)],
      ["PC Receive", firstOf(nested(h.pc_receive)?.receive_number)],
      ["Credit Note", firstOf(h.credit_note_ref)],
      ["Posted", dmy(h.posted_at)],
      ["Completed", dmy(h.completed_at)],
    ],
    stats: (h) => [
      ["Refund", money(h.refund_sen), "var(--ink)"],
    ],
    line: (it) => {
      const { primary } = lineIdentity({
        code: it.item_code,
        description: it.material_name,
      });
      return {
        name: primary,
        sub: buildVariantSummary(it.item_group, it.variants),
        qty: it.qty_returned,
        unitSen: it.unit_price_sen,
        amountSen: it.line_refund_sen,
      };
    },
  },
};

/** Derive the id to fetch by from the list row. Most detail routes key on the
 *  uuid `id`; consignment-orders keys on `doc_no` (its list HEADER doesn't even
 *  select `id`), and the PC family adds `pc_number` / `receive_number`. Fall
 *  back through every human key so a row that arrived without `id` still
 *  resolves to the right URL segment. */
function docId(row: any): string {
  return s(
    row?.id ??
      row?.doc_no ??
      row?.do_number ??
      row?.invoice_number ??
      row?.grn_number ??
      row?.po_number ??
      row?.pc_number ??
      row?.receive_number ??
      row?.return_number,
  );
}

// ---------------------------------------------------------------------------
// Per-document ACTIONS — status transitions + Record Payment, rendered as a
// sticky footer over the detail. Every action's transition set is read from the
// backend route's state machine (backend/src/scm/routes/*.ts): only transitions
// VALID from the doc's CURRENT status are offered, so no button ever 409s.
// Destructive actions (Cancel / Void) go through the in-app confirm (danger).
// ---------------------------------------------------------------------------

type ActVariant = "solid" | "outline" | "danger";

/** One footer action button descriptor. */
type DocAction = {
  key: string;
  label: string;
  variant: ActVariant;
  /** POST/PATCH/DELETE request, relative to /api/scm. */
  request: { path: string; method: "PATCH" | "POST" | "DELETE"; body?: unknown };
  /** In-app danger confirm before firing (Cancel / Void). */
  confirm?: { title: string; body?: string; confirmLabel: string };
  /** When true, the record no longer exists after this action → navigate back
   *  to the list instead of staying on a now-deleted detail.
   *
   *  NO action sets this today. The last one that did was the mobile Delete PO
   *  (removed 2026-08-11 with its endpoint — owner rule 不可以删只可以 cancel).
   *  Kept because a legitimate `removes` action can still exist — discarding a
   *  DRAFT that was never confirmed, the shape SO `DELETE /:docNo` has. It is
   *  NOT the hook for re-adding a document delete; see
   *  docs/hard-delete-inventory.md. */
  removes?: boolean;
};

/** true when total − paid still leaves a balance (Record Payment worth offering). */
function hasBalance(h: any): boolean {
  const total = Number(h?.total_sen ?? h?.local_total_sen ?? 0);
  const paid = Number(h?.paid_sen ?? 0);
  const t = Number.isFinite(total) ? total : 0;
  const p = Number.isFinite(paid) ? paid : 0;
  return t > 0 && t - p > 0;
}

/** Whether a module's Record Payment sheet should be offered for `status`, and
 *  which payment endpoint + payload shape it uses. Returns null when payments
 *  don't apply (module has no payment route, or status/balance forbids it). */
type PayKind = "si" | "pi";
function paymentKind(moduleKey: string, header: any): PayKind | null {
  const st = s(header?.status).toUpperCase();
  if (st === "CANCELLED" || st === "DRAFT") return null;
  if (!hasBalance(header)) return null;
  if (moduleKey === "sales-invoices") return "si";
  if (moduleKey === "purchase-invoices") return "pi";
  return null;
}

/**
 * May this user OPERATE the document behind `moduleKey` (advance its status,
 * cancel it), as opposed to merely reading + printing it?
 *
 * Owner 2026-07-17: Office operates DO and SI, Sales only looks — and on parity,
 * "電話電腦的權限應該一樣的". Mobile's status footer was status-only, so a
 * salesperson who could open a Delivery Order was offered Dispatch / In Transit /
 * Signed / Cancel; the backend now 403s all four. Resolving through the SAME
 * helpers the desktop uses is what keeps the two platforms one decision rather
 * than two implementations. Every other module is unaffected (returns true).
 */
function useMayOperateDoc(moduleKey: string): boolean {
  const { user, can, pageAccess } = useAuth();
  if (moduleKey === "delivery-orders-mfg") return canOperateDeliveryOrders(user, can, pageAccess);
  if (moduleKey === "sales-invoices") return canOperateSalesInvoices(user, can, pageAccess);
  return true;
}

/** Build the valid status actions for a doc from its CURRENT status. Empty when
 *  the doc is terminal, the module has no status route, or the caller may only
 *  view it (`mayOperate` false → the footer renders nothing at all). */
function statusActionsFor(moduleKey: string, id: string, header: any, mayOperate: boolean): DocAction[] {
  if (!mayOperate) return [];
  const st = s(header?.status).toUpperCase();
  const enc = encodeURIComponent(id);
  const out: DocAction[] = [];
  const cancel = (path: string, docLabel: string): DocAction => ({
    key: "cancel", label: "Cancel", variant: "danger",
    request: { path, method: "PATCH", body: { status: "CANCELLED" } },
    confirm: { title: `Cancel this ${docLabel}?`, body: "This voids the document and cannot be undone via the app.", confirmLabel: "Cancel Document" },
  });

  switch (moduleKey) {
    // DO — PATCH /:id/status. A fresh DO is DRAFT (confirm = DRAFT→LOADED) or
    // LOADED; the driver may mark it IN_TRANSIT ("On the way"). SIGNED and
    // DELIVERED are the Proof-of-Delivery screen's job (it closes the delivery
    // WITH a signature), so they are never offered here. The "Mark Signed" rung
    // was REMOVED 2026-08-21 (owner) — a bare status button is not how a delivery
    // gets signed off. CANCELLED is final. Offer the NEXT step + Cancel.
    case "delivery-orders-mfg": {
      if (st === "CANCELLED" || st === "DELIVERED" || st === "INVOICED") return out;
      const path = `/delivery-orders-mfg/${enc}/status`;
      /* CONFIRM LANDS ON LOADED, not DISPATCHED — corrected 2026-08-22 with the
         desktop's identical fault. This rung said `DRAFT: ["DISPATCHED",
         "Confirm"]`: labelled Confirm, writing the status every screen renders
         as "Loaded" (it read "Shipped" until 2026-08-26), so the phone's
         Confirm skipped Confirmed exactly the way
         the office button did. LOADED is where the stock leaves now (owner:
         「once confirmed就代表出货了 就是直接扣库存」), so this is the same
         event under its right name. The LOADED→DISPATCHED rung stays: that is a
         real, separate step — the goods actually going on the road. */
      const next: Record<string, [string, string]> = {
        "": ["DISPATCHED", "Confirm Loaded"],
        DRAFT: ["LOADED", "Confirm"],
        LOADED: ["DISPATCHED", "Confirm Loaded"],
        DISPATCHED: ["IN_TRANSIT", "Mark In Transit"],
      };
      const step = next[st];
      if (step) out.push({ key: "next", label: step[1], variant: "solid", request: { path, method: "PATCH", body: { status: step[0] } } });
      out.push({ ...cancel(path, "delivery order"), confirm: { title: "Cancel this delivery order?", body: "This voids the DO and returns any shipped stock to the shelf.", confirmLabel: "Cancel DO" } });
      return out;
    }

    // Sales Invoice — PATCH /:id/status. DRAFT→SENT (Confirm) or Cancel; active
    // (SENT/PARTIALLY_PAID/PAID/OVERDUE)→Cancel; CANCELLED→Reopen (to SENT).
    case "sales-invoices": {
      const path = `/sales-invoices/${enc}/status`;
      if (st === "DRAFT") {
        out.push({ key: "confirm", label: "Confirm Invoice", variant: "solid", request: { path, method: "PATCH", body: { status: "SENT" } } });
        out.push(cancel(path, "invoice"));
        return out;
      }
      if (st === "CANCELLED") {
        out.push({ key: "reopen", label: "Reopen", variant: "outline", request: { path, method: "PATCH", body: { status: "SENT" } } });
        return out;
      }
      out.push(cancel(path, "invoice"));
      return out;
    }

    // Purchase Order — /confirm (DRAFT→SUBMITTED), /cancel, /reopen. RECEIVED is
    // terminal. Receiving into a GRN is a separate flow — not offered here.
    case "mfg-purchase-orders": {
      if (st === "RECEIVED") return out;
      if (st === "DRAFT") {
        out.push({ key: "submit", label: "Submit", variant: "solid", request: { path: `/mfg-purchase-orders/${enc}/confirm`, method: "PATCH" } });
        out.push({ key: "cancel", label: "Cancel", variant: "danger", request: { path: `/mfg-purchase-orders/${enc}/cancel`, method: "PATCH" }, confirm: { title: "Cancel this purchase order?", body: "This voids the PO and releases its SO lines back to the picker.", confirmLabel: "Cancel PO" } });
        return out;
      }
      if (st === "CANCELLED") {
        out.push({ key: "reopen", label: "Reopen", variant: "outline", request: { path: `/mfg-purchase-orders/${enc}/reopen`, method: "PATCH" } });
        // A hard Delete used to sit here for desktop parity. Both are gone
        // (owner rule 2026-08-11: 不可以删只可以 cancel) — CANCELLED is the
        // terminal state and the record stays. Reopen is the only way back.
        return out;
      }
      // SUBMITTED / PARTIALLY_RECEIVED
      out.push({ key: "cancel", label: "Cancel", variant: "danger", request: { path: `/mfg-purchase-orders/${enc}/cancel`, method: "PATCH" }, confirm: { title: "Cancel this purchase order?", body: "This voids the PO and releases its SO lines back to the picker.", confirmLabel: "Cancel PO" } });
      return out;
    }

    // GRN — /post (DRAFT→POSTED), /cancel. CANCELLED / CLOSED are terminal.
    case "grns": {
      if (st === "CANCELLED" || st === "CLOSED") return out;
      if (st === "DRAFT") {
        out.push({ key: "post", label: "Post", variant: "solid", request: { path: `/grns/${enc}/post`, method: "PATCH" } });
      }
      out.push({ key: "cancel", label: "Cancel", variant: "danger", request: { path: `/grns/${enc}/cancel`, method: "PATCH" }, confirm: { title: "Cancel this goods receipt?", body: "This voids the GRN and reverses any posted stock.", confirmLabel: "Cancel GRN" } });
      return out;
    }

    // Sales Return (delivery-returns) — PATCH /:id/status. RECEIVED→INSPECTED→
    // REFUNDED; CANCELLED is final. Offer the next hand-walk step + Cancel.
    case "delivery-returns": {
      if (st === "CANCELLED" || st === "REFUNDED") return out;
      const path = `/delivery-returns/${enc}/status`;
      const next: Record<string, [string, string]> = {
        RECEIVED: ["INSPECTED", "Mark Inspected"],
        INSPECTED: ["REFUNDED", "Mark Refunded"],
      };
      const step = next[st];
      if (step) out.push({ key: "next", label: step[1], variant: "solid", request: { path, method: "PATCH", body: { status: step[0] } } });
      out.push({ ...cancel(path, "return"), confirm: { title: "Cancel this sales return?", body: "This voids the return and re-drains its restocked goods.", confirmLabel: "Cancel Return" } });
      return out;
    }

    // Purchase Return — /complete (POSTED→COMPLETED), /cancel. COMPLETED /
    // CANCELLED are terminal. (POST /:id/post only echoes — not a real action.)
    case "purchase-returns": {
      if (st === "COMPLETED" || st === "CANCELLED") return out;
      if (st === "POSTED") {
        out.push({ key: "complete", label: "Mark Completed", variant: "solid", request: { path: `/purchase-returns/${enc}/complete`, method: "PATCH" } });
      }
      out.push({ key: "cancel", label: "Cancel", variant: "danger", request: { path: `/purchase-returns/${enc}/cancel`, method: "PATCH" }, confirm: { title: "Cancel this purchase return?", body: "This voids the return and reverses its stock movement.", confirmLabel: "Cancel Return" } });
      return out;
    }

    // Purchase Invoice — /post (DRAFT→POSTED), /cancel (blocked once paid).
    // Payment is a separate action (see paymentKind → PI sheet).
    case "purchase-invoices": {
      if (st === "CANCELLED" || st === "PAID") return out;
      if (st === "DRAFT") {
        out.push({ key: "post", label: "Post", variant: "solid", request: { path: `/purchase-invoices/${enc}/post`, method: "PATCH" } });
        out.push({ key: "cancel", label: "Cancel", variant: "danger", request: { path: `/purchase-invoices/${enc}/cancel`, method: "PATCH" }, confirm: { title: "Cancel this purchase invoice?", body: "This voids the PI and reverses its accounting.", confirmLabel: "Cancel PI" } });
        return out;
      }
      // POSTED / PARTIALLY_PAID — cancel allowed only while unpaid; the backend
      // rejects a cancel once paid_sen > 0, so hide Cancel then.
      const paid = Number(header?.paid_sen ?? 0);
      if (!(Number.isFinite(paid) && paid > 0)) {
        out.push({ key: "cancel", label: "Cancel", variant: "danger", request: { path: `/purchase-invoices/${enc}/cancel`, method: "PATCH" }, confirm: { title: "Cancel this purchase invoice?", body: "This voids the PI and reverses its accounting.", confirmLabel: "Cancel PI" } });
      }
      return out;
    }

    default:
      return out;
  }
}

// Payment-method options, single-sourced from the canonical payment-methods lib
// (vendor/scm/lib/payment-methods.ts) so the picker reads identically to desktop
// and never drifts. The option VALUE is the canonical CODE the payment endpoints
// store + expect (desktop reads back method === 'cash' | 'transfer' | 'merchant';
// SalesInvoiceDetail.tsx), and the LABEL is the canonical friendly label.
const SI_METHODS: Array<{ value: string; label: string }> = PAYMENT_METHOD_CODES.map(
  (code) => ({ value: code, label: PAYMENT_METHOD_DEFAULT_LABELS[code] }),
);

// Footer action buttons ride the design's `.btn` (teal solid) and re-skin per
// variant, mirroring the SO-detail actbar (Edit / Cancel = white outline).
function actSkin(variant: ActVariant, disabled: boolean): React.CSSProperties {
  const skin: React.CSSProperties =
    variant === "solid" ? { background: "#16695f", color: "#fff", border: "none" }
    : variant === "danger" ? { background: "#fff", color: "#b23a3a", border: "1.5px solid #f0d4d4" }
    : { background: "#fff", color: "#16695f", border: "1.5px solid #16695f" };
  // white-space:nowrap per spec — labels never wrap; the row lets buttons flex.
  return { flex: 1, padding: 12, borderRadius: 11, fontSize: 13.5, whiteSpace: "nowrap", ...skin, opacity: disabled ? 0.55 : 1 };
}

/** Record-Payment bottom sheet. `kind` picks the endpoint + payload:
 *  si → POST /sales-invoices/:id/payments { paidAt, method, amountSen, ... }
 *  pi → PATCH /purchase-invoices/:id/payment { amountSen, notes }. */
function PaymentSheet({ kind, id, header, onClose, onDone }: {
  kind: PayKind; id: string; header: any; onClose: () => void; onDone: () => void;
}) {
  const notify = useNotify();
  const total = Number(header?.total_sen ?? header?.local_total_sen ?? 0);
  const paid = Number(header?.paid_sen ?? 0);
  // Gated on `kind`, not on the key being absent: this pre-fills an amount to COLLECT.
  const balance = siOutstandingSen(total, paid, kind === "si" ? siDepositAppliedSen(header) : 0);

  const [amount, setAmount] = useState(() => (balance > 0 ? (balance / 100).toFixed(2) : ""));
  const [method, setMethod] = useState("cash");
  const [date, setDate] = useState(() => todayMyt());
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  /* One key for the one payment this sheet is open to record (lib/idempotency.ts).
     The parent mounts the sheet behind `payOpen` and onSuccess closes it, so the
     MOUNT is the intent: every retry of THIS submit reuses this key, and
     recording a second payment means re-opening, i.e. a new mount and a new key. */
  const idemKey = useIdempotencyKey();

  const mutation = useMutation({
    mutationFn: async () => {
      const amountSen = Math.round(Number(amount) * 100);
      if (!Number.isFinite(amountSen) || amountSen <= 0) throw new Error("Enter a valid amount greater than zero.");
      if (kind === "si") {
        const body: Record<string, unknown> = { paidAt: date, method, amountSen };
        if (ref.trim()) body.approvalCode = ref.trim();
        await authedFetch(`/sales-invoices/${encodeURIComponent(id)}/payments`,
          idempotentInit(idemKey, { method: "POST", body: JSON.stringify(body) }));
      } else {
        const body: Record<string, unknown> = { amountSen };
        if (ref.trim()) body.notes = ref.trim();
        /* The PI payment PATCH is ADDITIVE — purchase-invoices.ts:644 computes
           `newPaid = c0.paid_sen + amount`, so a double-fire pays the supplier
           twice on paper. Its optimistic-concurrency loop gates on the paid_sen
           it just read, which stops a concurrent write from being LOST; it does
           nothing about the same payment arriving twice. Hence the key. */
        await authedFetch(`/purchase-invoices/${encodeURIComponent(id)}/payment`,
          idempotentInit(idemKey, { method: "PATCH", body: JSON.stringify(body) }));
      }
    },
    onSuccess: () => { onDone(); onClose(); void notify({ title: "Payment recorded" }); },
    onError: (e) => setError(e instanceof Error ? e.message : "Couldn't record the payment. Please try again."),
  });

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", height: 42, padding: "0 12px", borderRadius: 10,
    border: "1px solid #e3e6e0", background: "#fff", fontFamily: "inherit", fontSize: 14, color: "var(--ink)",
  };
  const labelStyle: React.CSSProperties = { fontSize: 9.5, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "#9aa093", marginBottom: 5, display: "block" };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 2500, background: "rgba(0,0,0,0.32)", display: "flex", alignItems: "flex-end" }}>
      <div onClick={(e) => e.stopPropagation()} className="hz-m" style={{ width: "100%", background: "#fff", borderRadius: "18px 18px 0 0", padding: "18px 16px calc(env(safe-area-inset-bottom) + 16px)", boxShadow: "0 -8px 28px rgba(0,0,0,0.16)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--ink)" }}>Record Payment</div>
          <button onClick={onClose} style={{ border: "none", background: "transparent", fontSize: 15, fontWeight: 700, color: "var(--teal)", cursor: "pointer", fontFamily: "inherit" }}>Close</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
          <Stat label="Total" value={money(total)} color="var(--ink)" />
          <Stat label="Paid" value={money(paid)} color="#2f8a5b" />
          <Stat label="Balance" value={money(balance)} color={balance > 0 ? "#a16a2e" : "var(--ink)"} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Amount (RM)</label>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" style={inputStyle} />
        </div>

        {kind === "si" && (
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Method</label>
            <select value={method} onChange={(e) => setMethod(e.target.value)} style={{ ...inputStyle, appearance: "none", WebkitAppearance: "none" }}>
              {SI_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
        )}

        {kind === "si" && (
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Date</label>
            <DateField value={date} onChange={(iso) => setDate(iso)} style={inputStyle}/>
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>{kind === "si" ? "Reference" : "Note"}</label>
          <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={kind === "si" ? "Approval / reference" : "Optional note"} style={inputStyle} />
        </div>

        {error && <div style={{ fontSize: 11.5, color: "#b23a3a", marginBottom: 12, textAlign: "center" }}>{error}</div>}

        <button
          className="btn"
          disabled={mutation.isPending}
          onClick={() => { setError(null); mutation.mutate(); }}
          style={{ opacity: mutation.isPending ? 0.6 : 1 }}
        >
          {mutation.isPending ? "Recording…" : "Record Payment"}
        </button>
      </div>
    </div>
  );
}

/** Sticky action footer for a document detail: status transition buttons +
 *  (for SI/PI) a Record Payment action opening the PaymentSheet. Invalidates
 *  the detail + list queries on success; surfaces errors inline. Renders
 *  nothing when there is no valid action from the current status. */
function DocActionFooter({ moduleKey, id, header, invalidate, onPOD, onDeleted }: {
  moduleKey: string; id: string; header: any; invalidate: () => void; onPOD?: () => void;
  /** Called after a `removes` action succeeds — navigate back to the list since
   *  the detail's record no longer exists. No action sets `removes` today (the
   *  Delete PO that used to be the example is gone, 2026-08-11); this stays
   *  wired for a future draft-discard. */
  onDeleted?: () => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const notify = useNotify();
  const [error, setError] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [runningKey, setRunningKey] = useState<string | null>(null);

  const mayOperate = useMayOperateDoc(moduleKey);
  /* POD confirms a delivery (stock + SO sync) → an operate action, gated on the
     SAME helper as the status actions (mirrors DeliveryOrderDetailV2's
     canWriteDo). MobileApp already withholds onPOD for a view-only user; this is
     defence-in-depth so the button, the early-return, the error offset and the
     scroll padding all agree. */
  const podEnabled = !!onPOD && mayOperate;
  const statusActions = useMemo(() => statusActionsFor(moduleKey, id, header, mayOperate), [moduleKey, id, header, mayOperate]);
  const payKind = paymentKind(moduleKey, header);

  const refresh = () => {
    invalidate();
    void qc.invalidateQueries({ queryKey: ["mobile-module"] });
    /* ["mobile-module"] is this screen's own key — the desktop lists these same
       documents under their vendored roots, and a GRN post / return completion
       also moves stock, so the shared roots for this module must refetch too. */
    invalidateModuleShared(qc, moduleKey);
  };

  const zeroCost = useGrnZeroCostRemedy({ grnId: id, onPosted: refresh });

  const mutation = useMutation({
    mutationFn: (action: DocAction) =>
      authedFetch(action.request.path, {
        method: action.request.method,
        ...(action.request.body !== undefined ? { body: JSON.stringify(action.request.body) } : {}),
      }),
    onSuccess: (_data, action) => {
      setRunningKey(null);
      // A `removes` action drops the record → refresh the list and pop back to
      // it; every other action stays on the (now-updated) detail. Nothing sets
      // `removes` today — see the field's note on DocAction.
      if (action.removes) {
        void qc.invalidateQueries({ queryKey: ["mobile-module"] });
        invalidateModuleShared(qc, moduleKey);
        void notify({ title: "Deleted" });
        onDeleted?.();
        return;
      }
      refresh();
      void notify({ title: "Done" });
    },
    /* A zero-cost receipt refusal is the one error here that CAN be answered on
       this screen: the sheet carries the same sentence plus the two remedies the
       refusal names (a unit price, or a per-line "Received free"). Mobile had
       neither and sent the receiver to a PC. Everything else keeps the inline
       line. */
    onError: (e) => {
      setRunningKey(null);
      if (zeroCost.capture(e)) { setError(null); return; }
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    },
  });

  const run = async (action: DocAction) => {
    if (mutation.isPending) return;
    setError(null);
    if (action.confirm && !(await confirm({ title: action.confirm.title, body: action.confirm.body, confirmLabel: action.confirm.confirmLabel, danger: true }))) return;
    setRunningKey(action.key);
    mutation.mutate(action);
  };

  /* ── THE DELIVERY ORDER'S NEXT STEP, SAID OUT LOUD ───────────────────────
     A SIGNED or DELIVERED delivery order used to reach this footer with NOTHING
     to show — `statusActionsFor` has no entry for SIGNED and returns early on
     DELIVERED — so on the phone the document simply looked finished and its
     Sales Invoice was never raised. The desktop offered the transfer in the same
     state, which is the "我又不是两套系统" reading moved from company-vs-company
     to phone-vs-desktop.

     This screen is a screen machine, not a router, so it does not host the
     convert wizard itself; the sentence therefore names the route that DOES
     work here (Sales Invoices → "+"), which MobileApp's MODULE_TO_CONVERT and
     MobileConvertWizard's META.si both confirm exists. Wording comes from
     vendor/scm/lib/do-next-step.ts — the same module the desktop detail page and
     the list drawer read, so the three cannot drift apart again.

     The driver ladder above is deliberately UNCHANGED. Its extra rung
     (DISPATCHED → IN_TRANSIT, "Mark In Transit") is not drift: IN_TRANSIT is the
     departure marker MobileDeliveryPlanning writes for "On the way"
     (MobileDeliveryPlanning.tsx:1280), so deleting it to match the desktop's
     single jump would have removed a step drivers actually use. ── */
  /* The status guard is not defensive noise: `header` falls back to `{}` when
     this screen is reached with a synthetic { id } row (the Relationship Map's
     flowNav does exactly that), and an absent status would otherwise render the
     GENERIC sentence for a second and then swap it for the real one. Saying the
     wrong thing briefly is its own version of the bug this note exists to fix. */
  const doNextStepNote =
    moduleKey === "delivery-orders-mfg" && mayOperate && s(header?.status)
      ? (siTransferBlockReason(header?.status) ?? SI_TRANSFER_MOBILE_ROUTE_HINT)
      : null;

  const hasRow = statusActions.length > 0 || !!payKind;
  if (!hasRow && !podEnabled && !doNextStepNote) return null;
  const busy = mutation.isPending;

  return (
    <>
      {error && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: hasRow && podEnabled ? 130 : 76, padding: "0 16px", textAlign: "center", fontSize: 11.5, color: "#b23a3a", zIndex: 1, maxWidth: "calc(100% - 32px)" }}>{error}</div>
      )}
      <footer className="actbar" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
        {doNextStepNote && (
          <p style={{ margin: "0 0 8px", fontSize: 11.5, lineHeight: 1.35, color: "#6b7280" }}>
            {doNextStepNote}
          </p>
        )}
        {podEnabled && (
          <button className="btn" onClick={onPOD} style={{ marginBottom: hasRow ? 9 : 0 }}>Proof of Delivery</button>
        )}
        {hasRow && (
          <div style={{ display: "flex", gap: 9 }}>
            {payKind && (
              <button className="btn" disabled={busy} onClick={() => { setError(null); setPayOpen(true); }} style={actSkin("solid", busy)}>Record Payment</button>
            )}
            {statusActions.map((a) => (
              <button className="btn" key={a.key} disabled={busy} onClick={() => run(a)} style={actSkin(a.variant, busy)}>{busy && runningKey === a.key ? "Working…" : a.label}</button>
            ))}
          </div>
        )}
      </footer>
      {payOpen && payKind && (
        <PaymentSheet kind={payKind} id={id} header={header} onClose={() => setPayOpen(false)} onDone={refresh} />
      )}
      {zeroCost.sheet}
    </>
  );
}

/* Purchase docs (PO / GRN / PI) show the REAL origin Sales Order per line,
   matched by SKU — see PoSoCoverageMobile's replacement: the assignment now
   rides each line row (LineItem `assigned`), fed from the same
   /po-so-coverage/:type/:id read. Display-only on mobile (the phone shell is a
   screen machine, not a router). */
const COVERAGE_TYPE: Record<string, "po" | "grn" | "pi"> = {
  "mfg-purchase-orders": "po",
  grns: "grn",
  "purchase-invoices": "pi",
};

function DocumentDetail({ map, row, moduleKey, onBack, onEdit, onPOD, flowNav }: { map: DocMap; row: any; moduleKey: string; onBack: () => void; onEdit?: () => void; onPOD?: () => void; flowNav?: FlowNav }) {
  const id = docId(row);
  const qc = useQueryClient();
  const detailNotify = useNotify();
  /* Relationship Map — the mobile twin of the desktop DocumentFlowModal /
     DocumentRelationshipMapModal (PO / GRN / PI / DO anchors here; the SO
     anchor lives on MobileSODetail). Zero added backend load: the map reads
     the same useDocumentFlow query the desktop modal reads and, for purchase
     docs, the SAME usePoSoCoverage key covQ below already fetched. */
  const [mapOpen, setMapOpen] = useState(false);
  const mapAnchor = flowAnchorForModule(moduleKey);
  // Purchase docs only: the real per-SKU origin SO(s) for each line.
  const coverageType = COVERAGE_TYPE[moduleKey] ?? null;
  const covQ = usePoSoCoverage(coverageType, coverageType && id ? id : null);
  const originByCode = originsByCode(covQ.data);
  // PR-3: the parallel stored-origin "bought for" slot, per SKU.
  const provByCode = provenanceByCode(covQ.data);
  const linkedSkus = storedLinkSkus(covQ.data);
  // Per-SKU Delivered (DO + qty) — same resolver payload the desktop lists read.
  const deliveredMap = deliveredByCode(covQ.data);
  const { data, isLoading, error } = useQuery({
    queryKey: ["mobile-module-detail", map.path, id],
    queryFn: () => authedFetch<Record<string, unknown>>(`${map.path}/${encodeURIComponent(id)}`),
    enabled: !!id,
    staleTime: 15_000,
  });

  // While loading / on error, keep the header populated from the list `row` so
  // the screen never flashes empty.
  const header = (data?.[map.headerKey] as any) ?? row ?? {};
  const items = (data?.items as any[]) ?? [];
  const meta = map.meta(header).filter(([, v]) => v && v !== "—");
  const stats = map.stats(header);

  const cancelled = isCancelledDoc(map.status(header));

  /* Download the DO / SI PDF — reuses the SAME desktop generators so phone output
     is byte-identical. Only wired for the two doc types with a mobile-relevant PDF.

     The screen already says "Couldn't load line items" when the detail read
     fails (see below), but the PDF button stayed live and `items` fell back to
     `[]` — so tapping it produced a Delivery Order or Sales Invoice PDF with an
     EMPTY line table. That is not a degraded document, it is a false one: it
     reads as a complete record of a delivery of nothing, and unlike a screen it
     is durable and leaves the phone. Refuse instead, and say why. */
  const canPdf = !error && !isLoading;
  const refusePdf = async () => {
    void detailNotify({
      title: "Can't make the PDF yet",
      body: isLoading
        ? "The line items are still loading. Please try again in a moment."
        : "We couldn't load the line items for this document. Making the PDF now would produce one with no items on it. Please refresh and try again.",
    });
  };
  /* One deliver step per printable doc type; the preview dialog picks which of
     its three exits (view / print / download) runs. Phone and desktop now open
     the SAME Print preview — see components/scm-v2/PrintPreviewModal. */
  const printableDocTitle =
    moduleKey === "delivery-orders-mfg"
      ? "Delivery Order"
      : moduleKey === "sales-invoices"
        ? "Sales Invoice"
        : null;
  const deliverPdf = async (action: PdfAction) => {
    try {
      if (moduleKey === "delivery-orders-mfg") {
        const { generateDeliveryOrderPdf } = await import("../vendor/scm/lib/delivery-order-pdf");
        // armDoScanToken puts the PUBLIC scan token on the header (desktop parity).
        const { armDoScanToken } = await import("../vendor/scm/lib/do-scan-token-arm");
        const doId = (header as { id?: string }).id ?? "";
        await generateDeliveryOrderPdf(await armDoScanToken(header as Record<string, unknown>, doId) as never, items as never, { action });
      } else {
        const { generateSalesInvoicePdf } = await import("../vendor/scm/lib/sales-invoice-pdf");
        await generateSalesInvoicePdf(header as never, items as never, { action });
      }
    } catch (e) {
      void detailNotify({ title: "Couldn't generate the PDF", body: e instanceof Error ? e.message : "Please try again." });
    }
  };
  const print = usePrintPreview(deliverPdf);
  /* The refusal path stays AHEAD of the preview: a document whose lines failed
     to load must not even reach a dialog offering to print it. */
  const onPdf = !printableDocTitle
    ? undefined
    : !canPdf
      ? refusePdf
      : print.openPreview;

  // Whether a sticky footer will render — used to reserve scroll padding so it
  // never covers the last line item. A POD button (delivery orders) also counts.
  const mayOperate = useMayOperateDoc(moduleKey);
  // POD entry is gated on the operate helper (same as DocActionFooter) so a
  // view-only user gets no POD button — and the footer/scroll padding agree.
  const podEnabled = !!onPOD && mayOperate;
  const hasStatusActions = !!id && (statusActionsFor(moduleKey, id, header, mayOperate).length > 0 || paymentKind(moduleKey, header) !== null);
  const hasFooter = hasStatusActions || podEnabled;
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["mobile-module-detail", map.path, id] }); };

  return (
    <div className="hz-m" style={{ ...wrapStyle, position: "relative" }}>
      <DetailHeader
        eyebrow={map.eyebrow(header)}
        title={map.title(header)}
        subtitle={map.subtitle?.(header)}
        status={map.status(header)}
        onBack={onBack}
        onEdit={onEdit}
        onPdf={onPdf}
        onMap={mapAnchor && id ? () => setMapOpen(true) : undefined}
      />
      {printableDocTitle && (
        /* Summary rows come off the SAME DocMap the screen renders from
           (eyebrow = doc no, title = party, meta = the KV grid), so the
           preview can never disagree with the page behind it. */
        <PrintPreviewModal
          open={print.open}
          onClose={print.close}
          docTitle={printableDocTitle}
          docNo={map.eyebrow(header)}
          rows={[
            { label: "Customer", value: map.title(header) },
            ...meta.slice(0, 4).map(([label, value]) => ({ label, value })),
            { label: "Items", value: `${items.length} line${items.length === 1 ? "" : "s"}` },
          ]}
          {...print.handlers}
        />
      )}
      <div className="scroll hz-scroll" style={hasFooter ? { ...scrollStyle, paddingBottom: podEnabled && hasStatusActions ? 150 : 96 } : scrollStyle}>
        {!id && <div style={{ textAlign: "center", color: "#b23a3a", fontSize: 12, padding: "26px 0" }}>Couldn't identify this record.</div>}

        {!!id && cancelled && <CancelledRibbon header={header} />}
        {!!id && (
          <div style={cancelled ? { opacity: 0.55, pointerEvents: "none" } : undefined}>
            {meta.length > 0 && (
              <div className="pgrid2" style={{ marginBottom: 13 }}>
                {meta.map(([label, value]) => (
                  <Kv key={label} label={label} value={value} mono={/date|phone|reference|currency|received|expected|submitted|due/i.test(label)} />
                ))}
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 13 }}>
              {stats.map((st, i) => (st ? <Stat key={st[0]} label={st[0]} value={st[1]} color={st[2]} /> : <div key={i} />))}
            </div>

            {/* Module-declared warning bar (e.g. PO SO→drift) — amber is the
                intentional warning slot; computed off the loaded payload, so it
                can only appear once the items are actually here. */}
            {!isLoading && !error && (() => {
              const notice = map.notice?.(header, items) ?? null;
              return notice ? (
                <div style={{
                  background: "rgba(212,151,40,0.12)",
                  border: "1px solid rgba(212,151,40,0.45)",
                  color: "#8a6116",
                  borderRadius: 10,
                  padding: "9px 11px",
                  fontSize: 11.5,
                  fontWeight: 600,
                  lineHeight: 1.45,
                  marginBottom: 13,
                }}>
                  {notice}
                </div>
              ) : null;
            })()}

            <Eyebrow>Line items</Eyebrow>
            <div style={cardStyle}>
              {isLoading && <div style={{ fontSize: 11.5, color: "#9aa093", padding: "9px 0" }}>Loading{"…"}</div>}
              {!!error && !isLoading && <div style={{ fontSize: 11.5, color: "#b23a3a", padding: "9px 0" }}>Couldn't load line items. Please try again.</div>}
              {!isLoading && !error && (items.length ? items.map((it, i) => {
                const l = map.line(it);
                const code = String(((it?.item_code ?? it?.item_code) ?? "")).trim();
                const assigned = coverageType ? (originByCode.get(code) ?? []) : undefined;
                /* mig 0235 — PO lines carry their sub-numbered allocations off
                   the same detail read (display-only twin of the desktop
                   Allocations column; one-product rule). */
                const allocations = moduleKey === "mfg-purchase-orders"
                  ? ((it?.allocations as Array<{ seq: number; qty: number; so_doc_no: string | null }> | undefined) ?? undefined)
                  : undefined;
                /* Sales docs (DO / SI): Source PO chips off the SAME per-line
                   source_pos / source_adj the desktop drill-down reads.
                   Purchase docs: Delivered chips off the SAME per-SKU delivered
                   the desktop drill-down reads (owner 2026-08-01: identical
                   source data on every surface, desktop + mobile pair rule). */
                const isSalesDoc = moduleKey === "delivery-orders-mfg" || moduleKey === "sales-invoices";
                const sourcePos = isSalesDoc
                  ? (((it?.source_pos as string[] | null | undefined) ?? []) as string[])
                  : undefined;
                const sourceAdj = isSalesDoc ? Boolean(it?.source_adj) : undefined;
                /* DO lines only (mig 0230): the committed batch — the
                   hard-from-DO anchor the detail GET already returns
                   (committed_po_batch_no). Same field the desktop detail's
                   CommittedBatchCell reads (one-product rule). */
                const committedBatch = moduleKey === "delivery-orders-mfg"
                  ? ((it?.committed_po_batch_no as string | null | undefined) ?? null)
                  : null;
                const delivered = coverageType ? (deliveredMap.get(code) ?? []) : undefined;
                const provenance = coverageType ? (provByCode.get(code) ?? []) : undefined;
                return <LineItem key={s(it?.id) || i} name={l.name} sub={l.sub} qty={l.qty} unitSen={l.unitSen} amountSen={l.amountSen} assigned={assigned} sourceLinked={coverageType ? linkedSkus.has(code) : undefined} provenance={provenance} allocations={allocations} poNumber={s(header?.po_number)} sourcePos={sourcePos} sourceAdj={sourceAdj} delivered={delivered} committedBatch={committedBatch} />;
              }) : <div style={{ fontSize: 11.5, color: "#9aa093", padding: "9px 0" }}>No line items.</div>)}
            </div>
          </div>
        )}
      </div>
      {/* CANCELLED = no lifecycle bar (spec); only the desktop-parity recovery
          actions (Reopen / Delete, the sole actions statusActionsFor returns for
          a cancelled doc) survive so a mis-cancel is still recoverable. */}
      {hasFooter && <DocActionFooter moduleKey={moduleKey} id={id} header={header} invalidate={invalidate} onPOD={onPOD} onDeleted={onBack} />}
      {mapOpen && mapAnchor && !!id && (
        <MobileRelationshipMap
          type={mapAnchor}
          id={id}
          label={map.eyebrow(header) || map.title(header)}
          onClose={() => setMapOpen(false)}
          nav={flowNav}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Simple detail — a tidy key/value dump of the row already provided. No fetch.
// ---------------------------------------------------------------------------

/** Humanize a snake_case / camelCase key into a Title-Case label. */
function humanize(key: string): string {
  return key
    .replace(/_sen$|_sen$/i, "")
    .replace(/_id$/i, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

/** Keys we never surface in a simple dump (internal / noisy). Raw foreign-key
 *  ids (*_id) and color hex are hidden — the joined *_name carries the meaning. */
const HIDDEN_KEYS = /^(id|created_by|updated_by|.*_by|.*_id|.*_color|color|.*_json|variants|custom_specials|password|token)$/i;

type Field = { label: string; value: string; mono: boolean; wide: boolean };

function rowToFields(row: any): Field[] {
  if (!row || typeof row !== "object") return [];
  const out: Field[] = [];
  for (const [key, raw] of Object.entries(row)) {
    if (HIDDEN_KEYS.test(key)) continue;
    if (raw == null || raw === "") continue;
    if (typeof raw === "object") continue; // skip nested objects / arrays
    let value: string;
    let mono = false;
    let wide = false;
    if (/_sen$|_sen$/i.test(key)) {
      value = money(raw);
      mono = true;
    } else if (/_date$|_at$|^date$/i.test(key)) {
      const d = dmy(raw);
      if (d === "—") continue;
      value = d;
      mono = true;
    } else if (typeof raw === "boolean") {
      value = raw ? "Yes" : "No";
    } else {
      value = s(raw);
      if (!value.trim()) continue;
      if (/phone|whatsapp|mobile|email|fax|code|number|no$/i.test(key)) mono = true;
      if (/address|note|remark|website|nature|description/i.test(key) || value.length > 28) wide = true;
    }
    out.push({ label: humanize(key), value, mono, wide });
  }
  return out;
}

const SIMPLE_META: Record<string, { eyebrow: (r: any) => string; title: (r: any) => string; status: (r: any) => unknown }> = {
  suppliers: {
    eyebrow: (r) => firstOf(r.code),
    title: (r) => firstOf(r.name),
    status: (r) => r.status,
  },
  warehouse: {
    eyebrow: (r) => firstOf(r.code),
    title: (r) => firstOf(r.name),
    status: () => "",
  },
  inventory: {
    eyebrow: (r) => firstOf(r.item_code),
    title: (r) => firstOf(r.product_name, r.item_code),
    status: () => "",
  },
  drivers: {
    eyebrow: (r) => firstOf(r.driver_code),
    title: (r) => firstOf(r.name),
    status: (r) => (r.in_house ? "In-house" : "Outsource"),
  },
  helpers: {
    eyebrow: (r) => firstOf(r.helper_code),
    title: (r) => firstOf(r.name),
    status: (r) => (r.in_house ? "In-house" : "Outsource"),
  },
};

/* Doc-like simple modules used to sit here (PI / PR / DR) — a stub that pulled
   the full header into SimpleDetail's KV dump. Item #8 of the 2026-07-23 mobile
   UI audit promoted all three to first-class DOC_MODULES adapters (meta rows +
   money-stat tiles + variant-aware line items), so this table is empty by
   design. Adding a new "doc-like simple" module here still works — SimpleDetail
   reads it — but any doc worth its own header/stats belongs in DOC_MODULES. */
const SIMPLE_DOC_PATHS: Record<string, { path: string; headerKey: string }> = {};

// Member account actions (Team → Members). Desktop Team.tsx exposes Reset
// password / Resend invitation in the member detail; this mirrors them 1:1 on
// mobile (single-logic-layer rule) against the SAME endpoints — no new backend.
// Gated on users.manage (the manage tier the desktop actions use); the endpoints
// enforce it too, so a stray render still 403s. A pending (status "invited")
// member gets Resend invitation (+ the returned invite link copied); an active
// member gets Reset password (link emailed + copied).
function MemberActions({ row, onDone }: { row: any; onDone: () => void }) {
  const { can } = useAuth();
  const notify = useNotify();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<null | "reset" | "resend">(null);
  const id = s(row?.id);
  const email = s(row?.email);
  const status = String(row?.status ?? "").toLowerCase();
  if (!can("users.manage") || !id) return null;

  const copyLink = async (link: string): Promise<boolean> => {
    if (!link) return false;
    try {
      await navigator.clipboard.writeText(link);
      return true;
    } catch {
      return false;
    }
  };

  const resendInvite = async () => {
    setBusy("resend");
    try {
      const res = await api.post<{
        ok: boolean;
        invite_url?: string;
        email_sent?: boolean;
        email_status?: string;
      }>(`/api/users/${id}/resend-invite`);
      const copied = await copyLink(res.invite_url ?? "");
      if (res.email_sent) {
        await notify({ title: "Invitation sent", body: copied ? `Emailed to ${email} — the invite link is also copied.` : `Emailed to ${email}.` });
      } else if (copied) {
        await notify({ title: "Invite link copied", body: `Email not sent (${res.email_status || "check Settings, Email"}) — paste the copied link to the member.` });
      } else {
        await notify({ title: "Couldn't send", body: `Email not sent (${res.email_status || "check Settings, Email"}).` });
      }
      onDone();
    } catch (e) {
      await notify({ title: "Couldn't resend", body: e instanceof Error ? e.message : "Please try again." });
    } finally {
      setBusy(null);
    }
  };

  // Mirrors Team.tsx sendReset against the SAME endpoint — sending the link is
  // a no-op on the account, and the link itself is never surfaced to the admin.
  const resetPassword = async () => {
    if (!(await confirm({ title: "Send reset link?", body: `Email a password reset link to ${email}? Nothing changes until they click it — their password and active sessions keep working. The link expires in 1 hour.`, confirmLabel: "Send link" }))) return;
    setBusy("reset");
    try {
      const res = await api.post<{
        ok: boolean;
        email_sent?: boolean;
        email_status?: string;
      }>(`/api/users/${id}/reset-password`);
      if (res.email_sent) {
        await notify({ title: "Reset link sent", body: `Emailed to ${email} — expires in 1 hour.` });
      } else {
        await notify({ title: "Couldn't send", body: `Email not sent (${res.email_status || "check Settings, Email"}). Nothing was changed on the account.` });
      }
    } catch (e) {
      await notify({ title: "Couldn't send", body: e instanceof Error ? e.message : "Please try again." });
    } finally {
      setBusy(null);
    }
  };

  const isInvited = status === "invited";
  return (
    <>
      <Eyebrow>Actions</Eyebrow>
      <div style={{ display: "grid", gap: 8, marginBottom: 13 }}>
        {isInvited ? (
          <button className="btn" disabled={busy !== null} onClick={resendInvite} style={{ opacity: busy !== null ? 0.6 : 1 }}>
            {busy === "resend" ? "Working…" : "Resend invitation"}
          </button>
        ) : (
          <button className="btn" disabled={busy !== null} onClick={resetPassword} style={{ opacity: busy !== null ? 0.6 : 1 }}>
            {busy === "reset" ? "Working…" : "Reset password"}
          </button>
        )}
      </div>
    </>
  );
}

function SimpleDetail({ moduleKey, row, title, onBack, onEdit }: { moduleKey: string; row: any; title: string; onBack: () => void; onEdit?: () => void }) {
  /* Owner 2026-07-17 — cost is director-only. Its own useAuth: the costing gate
     further up this file lives in a DIFFERENT component, so there is nothing to
     borrow here. */
  const { user: detailUser } = useAuth();
  // Suppliers carries a richer GET /suppliers/:id ({ supplier, bindings }).
  // Merge that over the list row when available; every other simple module just
  // dumps the row it was handed.
  const wantSupplier = moduleKey === "suppliers";
  const id = s(row?.id);
  const supplierQ = useQuery({
    queryKey: ["mobile-supplier-detail", id],
    queryFn: () => authedFetch<{ supplier: any; bindings: any[] }>(`/suppliers/${encodeURIComponent(id)}`),
    enabled: wantSupplier && !!id,
    staleTime: 30_000,
  });

  // Doc-like simple modules (PI / PR / DR) fetch their full header so the
  // read-only detail shows the richer fields the list row lacks (paid_sen /
  // notes / dates). The 4 richer doc types (DO/SI/GRN/PO) never reach here —
  // they use DocumentDetail.
  const docCfg = SIMPLE_DOC_PATHS[moduleKey];
  const wantDoc = !!docCfg && !!id;
  const docQ = useQuery({
    queryKey: ["mobile-module-detail", docCfg?.path ?? moduleKey, id],
    queryFn: () => authedFetch<Record<string, unknown>>(`${docCfg!.path}/${encodeURIComponent(id)}`),
    enabled: wantDoc,
    staleTime: 15_000,
  });
  const docHeader = (docQ.data?.[docCfg?.headerKey ?? ""] as any) ?? row ?? {};

  const effectiveRow = useMemo(() => {
    if (wantSupplier && supplierQ.data?.supplier) return { ...row, ...supplierQ.data.supplier };
    if (wantDoc && docQ.data?.[docCfg!.headerKey]) return { ...row, ...(docQ.data[docCfg!.headerKey] as any) };
    return row ?? {};
  }, [wantSupplier, supplierQ.data, wantDoc, docQ.data, docCfg, row]);

  const meta = SIMPLE_META[moduleKey];
  const config = MODULE_CONFIGS[moduleKey];
  // Design-style detail: when the module config declares `fields`, render those
  // labelled rows (so-k / so-v pairs) exactly like the prototype's openDetail;
  // else fall back to the humanized full-row dump.
  const configFields = useMemo(() => {
    /* Owner 2026-07-17 — cost is director-only. This grid renders the SAME
       MODULE_CONFIGS.fields as MobileModuleList's ListCard, so it needs the
       same filter: gating the list and not the detail would just move the leak
       one tap deeper. */
    const fields = visibleFields(config?.fields, detailUser);
    if (!fields.length) return null;
    return fields.map(([accessor, label]) => {
      let value = "—";
      try { value = accessor(effectiveRow) || "—"; } catch { value = "—"; }
      return { label, value };
    });
  }, [config, effectiveRow, detailUser]);

  const eyebrow = meta ? meta.eyebrow(effectiveRow) : (config?.eyebrow ?? "");
  const heading =
    (meta ? meta.title(effectiveRow) : "") ||
    (config ? safeCall(config.primary, effectiveRow) : "") ||
    title ||
    "—";
  const status = meta
    ? meta.status(effectiveRow)
    : config?.pill
      ? safeCall(config.pill, effectiveRow)
      : "";
  // A cancelled doc-like module (PI / PR / DR) greys its body + shows the ribbon.
  // Non-doc simple modules (suppliers / drivers) never reach a cancelled state.
  const cancelled = wantDoc && isCancelledDoc(status);
  const dumpFields = rowToFields(effectiveRow);

  // Status action bar for the DOC-like simple modules (Sales/Purchase Returns,
  // Purchase Invoices) — driven off the list row's id + status. Other simple
  // modules (suppliers, drivers, …) have no status route → no footer.
  const qc = useQueryClient();
  const actionRow = row ?? {};
  const actionId = s(row?.id);
  const mayOperate = useMayOperateDoc(moduleKey);
  const hasFooter = !!actionId && (statusActionsFor(moduleKey, actionId, actionRow, mayOperate).length > 0 || paymentKind(moduleKey, actionRow) !== null);
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["mobile-module"] }); };

  return (
    <div className="hz-m" style={{ ...wrapStyle, position: "relative" }}>
      <DetailHeader
        eyebrow={eyebrow === "—" ? "" : eyebrow}
        title={heading}
        status={status}
        onBack={onBack}
        onEdit={onEdit}
      />
      <div className="scroll hz-scroll" style={hasFooter ? { ...scrollStyle, paddingBottom: 96 } : scrollStyle}>
        {cancelled && <CancelledRibbon header={docHeader} />}
        <div style={cancelled ? { opacity: 0.55, pointerEvents: "none" } : undefined}>
        <Eyebrow>Details</Eyebrow>
        {configFields ? (
          // Designer MobileDetail.tsx: a single titled .card whose body is a list
          // of .row label/value pairs (row-l muted label, row-v money value).
          <div className="card" style={{ marginBottom: 13 }}>
            {configFields.map((f) => (
              <div className="row" key={f.label}>
                <span className="row-l">{f.label}</span>
                <span className="row-v money" style={{ wordBreak: "break-word" }}>{f.value}</span>
              </div>
            ))}
          </div>
        ) : dumpFields.length ? (
          <div className="pgrid2" style={{ marginBottom: 13 }}>
            {dumpFields.map((f) => (
              <div key={f.label} style={f.wide ? { gridColumn: "1 / -1" } : undefined}>
                <Kv label={f.label} value={f.value} mono={f.mono} />
              </div>
            ))}
          </div>
        ) : (
          <div style={{ ...cardStyle, padding: 13 }}>
            <div style={{ fontSize: 11.5, color: "#9aa093", padding: "9px 0" }}>No details to show.</div>
          </div>
        )}

        {moduleKey === "members" && (
          <MemberActions row={effectiveRow} onDone={() => { void qc.invalidateQueries({ queryKey: ["mobile-module"] }); }} />
        )}

        </div>
      </div>
      {hasFooter && <DocActionFooter moduleKey={moduleKey} id={actionId} header={actionRow} invalidate={invalidate} onDeleted={onBack} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public entry — routes by moduleKey to the document or the simple detail.
// ---------------------------------------------------------------------------

export function MobileModuleDetail({ moduleKey, row, title, onBack, onPOD, onEdit, flowNav }: {
  moduleKey: string; row: any; title: string; onBack: () => void; onPOD?: () => void;
  /** Wired by the parent when the module's form supports edit (updatePath).
   *  The header "Edit" button calls this. MobileApp passes the current row's
   *  id + the module's FormSchema through to MobileModuleForm. */
  onEdit?: () => void;
  /** Relationship-Map node navigation (MobileApp). Absent → map nodes inert. */
  flowNav?: FlowNav;
}) {
  // Only offer Edit for modules whose form declares an updatePath (create-only
  // modules like Warehouse show no Edit button even when onEdit is passed).
  const editable = !!MODULE_CONFIGS[moduleKey]?.form?.updatePath;
  const editHandler = editable ? onEdit : undefined;
  const doc = DOC_MODULES[moduleKey];
  // Document modules host their own sticky footer (status actions + Record
  // Payment, plus the Proof-of-Delivery entry for Delivery Orders). Simple
  // modules (Sales/Purchase Returns, Purchase Invoices) get a status action bar
  // driven off the list row's id + status.
  if (doc) {
    return <DocumentDetail map={doc} row={row} moduleKey={moduleKey} onBack={onBack} onEdit={editHandler} onPOD={onPOD} flowNav={flowNav} />;
  }
  return <SimpleDetail moduleKey={moduleKey} row={row} title={title} onBack={onBack} onEdit={editHandler} />;
}

import { DateField } from "../vendor/scm/components/DateField";