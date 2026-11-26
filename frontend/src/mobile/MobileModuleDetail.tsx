import { useMemo, useState } from "react";
import { siCreditNotesSen, siDepositAppliedSen, siOutstandingSen } from "../vendor/scm/lib/si-outstanding";
import { offersRecordPayment, piPaymentHint } from "./doc-payment";
import { visibleFields, canOperateDeliveryOrders, canOperateSalesInvoices, canPostGoodsReceipts } from "../auth/salesAccess";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lineIdentity, orderLineIdentity } from "@2990s/shared";
import { buildVariantSummary } from "../vendor/shared/variant-summary";
import { formatPhone } from "@2990s/shared/phone";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { usePoSoCoverage, originsByCode, provenanceByCode, storedLinkSkus, deliveredByCode, type OriginAssignment } from "../vendor/scm/lib/flow-queries";
import { CommittedBatchRowMobile, PairedSoRowsMobile, SourcePosRowMobile, SubstitutedRowMobile } from "./source-chips"; import { MobileLinePoFacts, mobilePiPoPriceNotice } from "./MobileLinePoRef";
import { MobileRelationshipMap } from "./MobileRelationshipMap";
import { piPoNumbers } from "../vendor/scm/lib/pi-header-pos";
import { MobileLineRemark } from "./MobileLineRemark";
import { useGrnZeroCostRemedy } from "./MobileGrnZeroCost"; import { MobileGrnLineRack } from "./MobileGrnLineRack";
import { flowAnchorForModule, type FlowNav } from "./relationship-map-model";
import { idempotentInit, useIdempotencyKey } from "../lib/idempotency";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useStaffLookup } from "../hooks/useStaffLookup";
import { MobileAddLine } from "./MobileAddLine";
import { FlowDocFilesCard } from "../vendor/scm/components/FlowDocFilesCard"; import { FLOW_DOC_KIND_BY_MODULE } from "../vendor/scm/lib/flow-doc-files";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { usePrompt } from "../vendor/scm/components/PromptDialog";
import { actionDoneNotice, askActionReason, DO_CANCEL_PROMPT, PO_CANCEL_PROMPT, type ActVariant, type DocAction } from "./doc-actions";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { MemberAccountActions } from "./MemberAccountActions";
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
import { humaniseStatusKey, statusLabel, type StatusDocType } from "../vendor/scm/lib/status-pill";
import "./mobile.css";


const money = (centi: unknown) => {
  const n = Number(centi);
  return fmtSen(Number.isFinite(n) ? n : 0);
};

const dmy = (d: unknown) => (d == null || d === "" ? "—" : formatDate(String(d)));

const s = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string") return v;
  return "";
};

const join = (...parts: unknown[]) => parts.map(s).map((p) => p.trim()).filter(Boolean).join(" · ");

const safeCall = (fn: ((row: any) => string) | undefined, row: any): string => {
  if (!fn) return "";
  try { return fn(row) ?? ""; } catch { return ""; }
};

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

function phase(status: unknown): "draft" | "cancelled" | "live" {
  const st = s(status).toUpperCase();
  if (st === "DRAFT") return "draft";
  if (st === "CANCELLED" || st === "VOID" || st === "VOIDED") return "cancelled";
  return "live";
}

function isCancelledDoc(status: unknown): boolean {
  return phase(status) === "cancelled";
}

function CancelledRibbon({ header }: { header: any }) {
  const when = dmy(header?.cancelledAt ?? header?.cancelled_at ?? header?.voidedAt ?? header?.voided_at ?? header?.updatedAt ?? header?.updated_at);
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 7, marginBottom: 13, padding: "9px 12px",
        background: "var(--hz-c-err-bg)", border: "1px solid #f0d4d4", borderRadius: 11,
        fontSize: 12, fontWeight: 700, color: "var(--hz-c-err)",
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#b23a3a" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M15 9l-6 6M9 9l6 6" /></svg>
      <span>Cancelled{when !== "—" ? ` ${when}` : ""}</span>
    </div>
  );
}

function StatusPill({ status, statusDoc }: { status: unknown; statusDoc: StatusDocType | null }) {
  const raw = s(status).trim();
  if (!raw) return null;
  const p = phase(status);
  const map: Record<string, [string, string, string]> = {
    live: ["#e1efed", "#0c3f39", "none"],
    draft: ["#f4f6f3", "#767b6e", "1px solid #e3e6e0"],
    cancelled: ["#f8eaea", "#b23a3a", "none"],
  };
  const [bg, fg, border] = map[p];
  /* Word from status-pill.ts; title-casing the stored value made a LOADED delivery order read "Loaded"
     (docs/bugs/0868). null = no canonical map: humaniseStatusKey is that same old title-casing. */
  const label = statusDoc ? statusLabel(statusDoc, raw) : humaniseStatusKey(raw);
  return (
    <span className="spill" style={{ background: bg, color: fg, border }}>
      {label}
    </span>
  );
}

function Kv({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="pkv-l">{label}</div>
      <div className={mono ? "pkv-v money" : "pkv-v"} style={{ wordBreak: "break-word" }}>{value || "—"}</div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: "var(--hz-c-surface)", border: "1px solid var(--hz-c-border-subtle)", borderRadius: 11, padding: 10, textAlign: "center" }}>
      <div className="money" style={{ fontSize: 13, fontWeight: 800, color }}>{value}</div>
      <div className="ey" style={{ color: "var(--hz-c-ink-soft)", marginTop: 3 }}>{label}</div>
    </div>
  );
}

function Eyebrow({ children }: { children: string }) {
  return <div className="ey" style={{ color: "var(--hz-c-ink-muted)", margin: "4px 2px 6px" }}>{children}</div>;
}

function LineItem({ name, sub, remark, qty, unitSen, amountSen, assigned, sourceLinked, provenance, allocations, poNumber, sourcePos, sourceAdj, racks, sourceState, delivered, committedBatch, substituted, poRef }: {
  name: string; sub?: string; qty: unknown; unitSen: unknown; amountSen: unknown; remark?: string | null;
  assigned?: OriginAssignment[];
  provenance?: OriginAssignment[];
  // Sales docs (DO / SI): the source PO(s) the shipped goods actually came from
  // (batch trail, GRN-healed) + the PO-less adjustment flag — the mobile twin
  // of the desktop drill-down's Source PO cell (owner 2026-08-01: identical
  // data on every surface).
  sourcePos?: string[];
  sourceAdj?: boolean;
  racks?: string[];
  sourceState?: "locked" | "worked_out" | null;
  committedBatch?: string | null;
  delivered?: Array<{ doNo: string; qty: number; soDocNo?: string | null }>;
  // false = no stored so_item_id behind the chip above; it is an MRP allocation
  // only. Desktop and mobile say this the same way (one-product rule): in the
  // chip's tooltip, since the owner removed the visible caption (2026-08-01).
  sourceLinked?: boolean;
  allocations?: Array<{ seq: number; qty: number; so_doc_no: string | null }>;
  poNumber?: string;
 substituted?: boolean;
 poRef?: React.ReactNode;
}) {
  const q = Number(qty);
  const qtyLabel = Number.isFinite(q) ? q : 0;
  return (
    <div className="docrow" style={{ flexWrap: "wrap" }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: "var(--hz-c-ink)" }}>
        {name || "—"} <span style={{ color: "var(--hz-c-ink-soft)", fontWeight: 600 }}>{"×"}{qtyLabel}</span>
      </span>
      <span className="money" style={{ fontSize: 12.5, fontWeight: 800, color: "var(--hz-c-ink)", flex: "none" }}>{money(amountSen)}</span>
      <div className="money" style={{ flexBasis: "100%", fontSize: 10.5, color: "var(--hz-c-ink-soft)" }}>
        {sub ? <span style={{ marginRight: 8 }}>{sub}</span> : null}
        <span>@ {money(unitSen)}</span>
      </div>
      <SubstitutedRowMobile on={substituted} /><MobileLineRemark text={remark} />{poRef}
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
      {sourceState != null && ((racks?.length ?? 0) > 0 || sourceState === "worked_out") && (
        <div style={{ flexBasis: "100%", fontSize: 10.5, color: "#7d8476", marginTop: 3 }}>
          {(racks?.length ?? 0) > 0 ? `Rack: ${shortRackLabels(racks).join(", ")}` : "Rack: —"}
          {sourceState === "locked" ? " · locked at dispatch" : <i> · worked out</i>}
        </div>
      )}
      <CommittedBatchRowMobile poNo={committedBatch} />

      {(allocations?.length ?? 0) > 0 && (
        <div style={{ flexBasis: "100%", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 4 }}>
          <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".3px", textTransform: "uppercase", color: "var(--hz-c-ink-soft)" }}>Allocations</span>
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
                style={{ fontFamily: "monospace", fontSize: 10.5, fontWeight: 700, color: "#5c6357", background: stock ? "transparent" : "var(--hz-c-surface-2)", border: stock ? "1px dashed #b6c6c0" : "1px solid #d9ded4", borderRadius: 5, padding: "1px 6px" }}
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

function DetailHeader({ eyebrow, title, subtitle, status, statusDoc, onBack, onEdit, onPdf, onMap }: {
  eyebrow: string; title: string; subtitle?: string; status?: unknown; statusDoc: StatusDocType | null; onBack: () => void; onEdit?: () => void; onPdf?: () => void;
  onMap?: () => void;
}) {
  return (
    <header className="hdr">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 12.5, fontWeight: 600, color: "var(--hz-c-primary)", cursor: "pointer" }}>
          <span style={{ fontSize: 17, lineHeight: 1 }}>{"‹"}</span> Back
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <StatusPill status={status} statusDoc={statusDoc} />
          {onMap && (
            <button className="tinybtn" onClick={onMap} style={{ background: "var(--hz-c-surface-2)", border: "1px solid var(--line2)", color: "var(--ink)" }}>
              Map
            </button>
          )}
          {onPdf && (
            <button className="tinybtn" onClick={onPdf} style={{ background: "var(--hz-c-surface-2)", border: "1px solid var(--line2)", color: "var(--ink)" }}>
              PDF
            </button>
          )}
          {onEdit && (
            <button className="tinybtn" onClick={() => onEdit()} style={{ background: "var(--hz-c-primary-soft)", border: "1px solid var(--hz-c-primary)", color: "var(--hz-c-primary-ink)" }}>
              Edit
            </button>
          )}
        </div>
      </div>
      {eyebrow ? <div className="money" style={{ fontSize: 11.5, fontWeight: 700, color: "var(--hz-c-accent)", marginTop: 7 }}>{eyebrow}</div> : null}
      <div style={{ fontSize: 19, fontWeight: 800, color: "var(--hz-c-ink)", marginTop: 2, wordBreak: "break-word" }}>{title || "—"}</div>
      {subtitle ? <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>{subtitle}</div> : null}
    </header>
  );
}

const scrollStyle: React.CSSProperties = { padding: 14, paddingBottom: 120 };
const wrapStyle: React.CSSProperties = { display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" };
const cardStyle: React.CSSProperties = { background: "var(--hz-c-surface)", border: "1px solid var(--hz-c-border-subtle)", borderRadius: 12, padding: "2px 12px", marginBottom: 13 };


type DocMap = {
  path: string;
  headerKey: string;
  eyebrow: (h: any) => string;
  title: (h: any) => string;
  subtitle?: (h: any) => string;
  status: (h: any) => unknown;
  statusDoc: StatusDocType | null;
  meta: (h: any, items: any[]) => Array<[string, string]>;
  stats: (h: any) => Array<[string, string, string] | null>;
  line: (it: any) => { name: string; sub?: string; remark?: string | null; qty: unknown; unitSen: unknown; amountSen: unknown };
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
    status: (h) => h.status, statusDoc: "do",
    meta: (h) => [
      ["DO Date", dmy(h.do_date)],
      ["Delivery", dmy(h.customer_delivery_date ?? h.expected_delivery_at)],
      ["Phone", formatPhone(firstOf(h.phone))],
      // The DO's own warehouse (stored at create), else the order's branch text for an older DO (owner 2026-09-07, header-level).
      ["Ship-from", firstOf(h.warehouse_code, h.sales_location)],
      ["Ref No.", firstOf(h.ref, h.po_doc_no)],
      ["Salesperson", firstOf(h.agent)],
    ],
    /* Owner 2026-07-17: Cost + Margin stat tiles removed from the mobile DO
       document view for EVERYONE (desktop parity — the DO detail Totals·Margin
       card was removed too). Costing moves to the separate Finance module. */
    stats: (h) => [
      ["Total", money(h.local_total_sen), "var(--ink)"],
    ],
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
    status: (h) => h.status, statusDoc: "si",
    meta: (h) => [
      ["Invoice Date", dmy(h.invoice_date)],
      ["Due Date", dmy(h.due_date)],
      ["Phone", formatPhone(firstOf(h.phone))],
      ["Location", firstOf(h.sales_location, h.customer_state, h.state)],
      ["Ref No.", firstOf(h.ref, h.po_doc_no)],
      ["Salesperson", firstOf(h.agent)],
    ],
    stats: (h) => {
      const depositSen = siDepositAppliedSen(h);
      const creditSen = siCreditNotesSen(h);
      const bal = siOutstandingSen(Number(h.total_sen ?? h.local_total_sen ?? 0), Number(h.paid_sen ?? 0), depositSen, creditSen);
      return [
        ["Total", money(h.total_sen ?? h.local_total_sen), "var(--ink)"],
        ["Paid", money(h.paid_sen), "#2f8a5b"],
        ...(depositSen > 0 ? [["SO deposit", money(depositSen), "#2f8a5b"] as [string, string, string]] : []),
        ...(creditSen > 0 ? [["Credit notes", money(creditSen), "#2f8a5b"] as [string, string, string]] : []),
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
    status: (h) => h.status, statusDoc: "grn",
    meta: (h) => [
      ["Received", dmy(h.received_at)],
      ["Delivery Note", firstOf(h.delivery_note_ref)],
      ["Warehouse", firstOf(h.warehouse_code)],
      ["Supplier", firstOf(nested(h.supplier)?.code)],
      ["Currency", firstOf(h.currency)],
    ],
    stats: (h) => [
      ["Subtotal", money(h.subtotal_sen), "var(--ink)"],
      ["Tax", money(h.tax_sen), "#767b6e"],
      ["Total", money(h.total_sen), "var(--ink)"],
    ],
    notice: (h) => (h.status === "DRAFT" && s(h.notes).trim() ? s(h.notes).trim() : null),
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
    status: (h) => h.status, statusDoc: "po",
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
      sub: join(buildVariantSummary(it.item_group, it.variants) || (it.description2 ?? ""), it.item_code, s(it.received_qty).trim() ? `Received ${s(it.received_qty)}` : ""),
      remark: it.notes ?? null,
      qty: it.qty,
      unitSen: it.unit_price_sen,
      amountSen: it.line_total_sen,
    }),
    notice: (h, items) => {
      const st = s(h?.status);
      const mode = poDriftMode(st);
      if (!mode) return null;
      const n = (items ?? []).filter((it) => it?.so_drift).length;
      if (n === 0) return null;
      if (mode === "received") return `⚠ ${n} line${n === 1 ? "'s" : "s'"} source SO changed after this PO was raised, and the goods were received to this PO's spec. Check them against the SO before delivery.`;
      return `⚠ ${n} line${n === 1 ? "'s" : "s'"} source SO changed after this PO was raised — sync the specs and re-send to the supplier from desktop, otherwise the factory keeps building to the old spec.`;
    },
  },

  "purchase-invoices": {
    path: "/purchase-invoices",
    headerKey: "purchaseInvoice",
    eyebrow: (h) => firstOf(h.invoice_number),
    title: (h) => firstOf(nested(h.supplier)?.name, h.invoice_number),
    subtitle: (h) => join(
      firstOf(nested(h.supplier)?.code) === "—" ? "" : firstOf(nested(h.supplier)?.code),
      s(h.supplier_invoice_ref).trim() ? `Ref ${s(h.supplier_invoice_ref)}` : "",
    ),
    notice: (_h, items) => mobilePiPoPriceNotice(items), // PO price vs PI price, reference only (owner 2026-09-14)
    status: (h) => h.status, statusDoc: "pi",
    meta: (h, items) => {
      /* Every PO the lines bill, not only the header's first (owner 2026-11-10).
         The phone has no hover, so the full list is shown and wraps. */
      const pos = piPoNumbers(items.map((it) => it?.source_po_number), s(nested(h.purchase_order)?.po_number).trim() || null);
      return [
      ["Invoice Date", dmy(h.invoice_date)],
      ["Due Date", dmy(h.due_date)],
      ["Supplier", firstOf(nested(h.supplier)?.code)],
      [pos.length > 1 ? `POs (${pos.length})` : "PO", pos.join(", ") || "—"],
      ["GRN", firstOf(nested(h.grn)?.grn_number)],
      ["Currency", firstOf(h.currency)],
      ["Posted", dmy(h.posted_at)],
      ];
    },
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
    status: (h) => h.status, statusDoc: "pr",
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

  "delivery-returns": {
    path: "/delivery-returns",
    headerKey: "deliveryReturn",
    eyebrow: (h) => firstOf(h.return_number),
    title: (h) => firstOf(h.debtor_name, h.return_number),
    subtitle: (h) => (s(h.do_doc_no).trim() ? `DO ${s(h.do_doc_no)}` : ""),
    status: (h) => h.status, statusDoc: "dr",
    meta: (h) => [
      ["Return Date", dmy(h.return_date)],
      ["Reason", firstOf(h.reason)],
      ["DO", firstOf(h.do_doc_no)],
      ["Phone", formatPhone(firstOf(h.phone))],
      ["Location", firstOf(h.sales_location, h.customer_state, h.state)],
      ["Received", dmy(h.received_at)],
      ["Inspected", dmy(h.inspected_at)],
      ["Refunded", dmy(h.refunded_at)],
      ["Ref No.", firstOf(h.ref)],
      ["Credit note", returnCreditLabel(h.credit_note_state) || "—"],
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
    status: (h) => h.status, statusDoc: null,
    meta: (h) => [
      ["Order Date", dmy(h.so_date)],
      ["Delivery", dmy(h.customer_delivery_date ?? h.processing_date)],
      ["Phone", formatPhone(firstOf(h.phone))],
      ["Location", firstOf(h.sales_location, h.customer_state, h.customer_country)],
      ["Ref No.", firstOf(h.ref, h.po_doc_no)],
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

  "consignment-notes": {
    path: "/consignment-notes",
    headerKey: "deliveryOrder",
    eyebrow: (h) => firstOf(h.do_number),
    title: (h) => firstOf(h.debtor_name, h.do_number),
    subtitle: (h) => (s(h.consignment_so_doc_no).trim() ? `CO ${s(h.consignment_so_doc_no)}` : ""),
    status: (h) => h.status, statusDoc: null,
    meta: (h) => [
      ["Note Date", dmy(h.do_date)],
      ["Delivery", dmy(h.customer_delivery_date ?? h.expected_delivery_at)],
      ["Phone", formatPhone(firstOf(h.phone))],
      ["Location", firstOf(h.sales_location, h.customer_state, h.state)],
      ["Ref No.", firstOf(h.ref, h.po_doc_no)],
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

  "consignment-returns": {
    path: "/consignment-returns",
    headerKey: "deliveryReturn",
    eyebrow: (h) => firstOf(h.return_number),
    title: (h) => firstOf(h.debtor_name, h.return_number),
    subtitle: (h) => (s(h.do_doc_no).trim() ? `CN ${s(h.do_doc_no)}` : ""),
    status: (h) => h.status, statusDoc: null,
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

  "purchase-consignment-orders": {
    path: "/purchase-consignment-orders",
    headerKey: "purchaseOrder",
    eyebrow: (h) => firstOf(h.pc_number),
    title: (h) => firstOf(nested(h.supplier)?.name, h.pc_number),
    subtitle: (h) => firstOf(nested(h.supplier)?.code) === "—" ? "" : firstOf(nested(h.supplier)?.code),
    status: (h) => h.status, statusDoc: null,
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
    status: (h) => h.status, statusDoc: null,
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
    status: (h) => h.status, statusDoc: null,
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

/* Posting a GRN is its own permission (owner 2026-10-01): a storekeeper with
   Goods Receipt edit drafts and sets racks, the purchaser posts. Same helper as
   desktop; the server gate is scm/lib/grn-post-capability.ts. */
function useMayPostGrn(): boolean {
  return canPostGoodsReceipts(useAuth().user);
}

function statusActionsFor(moduleKey: string, id: string, header: any, mayOperate: boolean, mayPostGrn: boolean): DocAction[] {
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
      out.push({ key: "cancel", label: "Cancel", variant: "danger", request: { path, method: "PATCH", body: { status: "CANCELLED" } }, reasonPrompt: DO_CANCEL_PROMPT });
      return out;
    }

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

    case "mfg-purchase-orders": {
      if (st === "RECEIVED") return out;
      if (st === "DRAFT") {
        out.push({ key: "submit", label: "Submit", variant: "solid", request: { path: `/mfg-purchase-orders/${enc}/confirm`, method: "PATCH" } });
        out.push({ key: "cancel", label: "Cancel", variant: "danger", request: { path: `/mfg-purchase-orders/${enc}/cancel`, method: "PATCH" }, reasonPrompt: PO_CANCEL_PROMPT });
        return out;
      }
      if (st === "CANCELLED") {
        out.push({ key: "reopen", label: "Reopen", variant: "outline", request: { path: `/mfg-purchase-orders/${enc}/reopen`, method: "PATCH" } });
        // A hard Delete used to sit here for desktop parity. Both are gone
        // (owner rule 2026-08-11: 不可以删只可以 cancel) — CANCELLED is the
        // terminal state and the record stays. Reopen is the only way back.
        return out;
      }
      out.push({ key: "cancel", label: "Cancel", variant: "danger", request: { path: `/mfg-purchase-orders/${enc}/cancel`, method: "PATCH" }, reasonPrompt: PO_CANCEL_PROMPT });
      return out;
    }

    case "grns": {
      if (st === "CANCELLED" || st === "CLOSED") return out;
      if (st === "DRAFT" && mayPostGrn) {
        out.push({ key: "post", label: "Post", variant: "solid", request: { path: `/grns/${enc}/post`, method: "PATCH" } });
      }
      out.push({ key: "cancel", label: "Cancel", variant: "danger", request: { path: `/grns/${enc}/cancel`, method: "PATCH" }, confirm: { title: "Cancel this goods receipt?", body: "This voids the GRN and reverses any posted stock.", confirmLabel: "Cancel GRN" } });
      return out;
    }

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

    case "purchase-returns": {
      if (st === "COMPLETED" || st === "CANCELLED") return out;
      if (st === "POSTED") {
        out.push({ key: "complete", label: "Mark Completed", variant: "solid", request: { path: `/purchase-returns/${enc}/complete`, method: "PATCH" } });
      }
      out.push({ key: "cancel", label: "Cancel", variant: "danger", request: { path: `/purchase-returns/${enc}/cancel`, method: "PATCH" }, confirm: { title: "Cancel this purchase return?", body: "This voids the return and reverses its stock movement.", confirmLabel: "Cancel Return" } });
      return out;
    }

    case "purchase-invoices": {
      if (st === "CANCELLED" || st === "PAID") return out;
      if (st === "DRAFT") {
        out.push({ key: "post", label: "Post", variant: "solid", request: { path: `/purchase-invoices/${enc}/post`, method: "PATCH" } });
        out.push({ key: "cancel", label: "Cancel", variant: "danger", request: { path: `/purchase-invoices/${enc}/cancel`, method: "PATCH" }, confirm: { title: "Cancel this purchase invoice?", body: "This voids the PI and reverses its accounting.", confirmLabel: "Cancel PI" } });
        return out;
      }
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

const SI_METHODS: Array<{ value: string; label: string }> = PAYMENT_METHOD_CODES.map(
  (code) => ({ value: code, label: PAYMENT_METHOD_DEFAULT_LABELS[code] }),
);

function actSkin(variant: ActVariant, disabled: boolean): React.CSSProperties {
  const skin: React.CSSProperties =
    variant === "solid" ? { background: "var(--hz-c-primary)", color: "#fff", border: "none" }
    : variant === "danger" ? { background: "var(--hz-c-surface)", color: "var(--hz-c-err)", border: "1.5px solid #f0d4d4" }
    : { background: "var(--hz-c-surface)", color: "var(--hz-c-primary)", border: "1.5px solid var(--hz-c-primary)" };
  return { flex: 1, padding: 12, borderRadius: 11, fontSize: 13.5, whiteSpace: "nowrap", ...skin, opacity: disabled ? 0.55 : 1 };
}

function PaymentSheet({ id, header, onClose, onDone }: {
  id: string; header: any; onClose: () => void; onDone: () => void;
}) {
  const notify = useNotify();
  const total = Number(header?.total_sen ?? header?.local_total_sen ?? 0);
  const paid = Number(header?.paid_sen ?? 0);
  const balance = siOutstandingSen(total, paid, siDepositAppliedSen(header), siCreditNotesSen(header));

  const [amount, setAmount] = useState(() => (balance > 0 ? (balance / 100).toFixed(2) : ""));
  const [method, setMethod] = useState("cash");
  const [date, setDate] = useState(() => todayMyt());
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const idemKey = useIdempotencyKey();

  const mutation = useMutation({
    mutationFn: async () => {
      const amountSen = Math.round(Number(amount) * 100);
      if (!Number.isFinite(amountSen) || amountSen <= 0) throw new Error("Enter a valid amount greater than zero.");
      const body: Record<string, unknown> = { paidAt: date, method, amountSen };
      if (ref.trim()) body.approvalCode = ref.trim();
      await authedFetch(`/sales-invoices/${encodeURIComponent(id)}/payments`,
        idempotentInit(idemKey, { method: "POST", body: JSON.stringify(body) }));
    },
    onSuccess: () => { onDone(); onClose(); void notify({ title: "Payment recorded" }); },
    onError: (e) => setError(e instanceof Error ? e.message : "Couldn't record the payment. Please try again."),
  });

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", height: 42, padding: "0 12px", borderRadius: 10,
    border: "1px solid var(--hz-c-border-subtle)", background: "var(--hz-c-surface)", fontFamily: "inherit", fontSize: 14, color: "var(--ink)",
  };
  const labelStyle: React.CSSProperties = { fontSize: 9.5, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--hz-c-ink-soft)", marginBottom: 5, display: "block" };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 2500, background: "rgba(0,0,0,0.32)", display: "flex", alignItems: "flex-end" }}>
      <div onClick={(e) => e.stopPropagation()} className="hz-m" style={{ width: "100%", background: "var(--hz-c-surface)", borderRadius: "18px 18px 0 0", padding: "18px 16px calc(env(safe-area-inset-bottom) + 16px)", boxShadow: "0 -8px 28px rgba(0,0,0,0.16)" }}>
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

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Method</label>
          <select value={method} onChange={(e) => setMethod(e.target.value)} style={{ ...inputStyle, appearance: "none", WebkitAppearance: "none" }}>
            {SI_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Date</label>
          <DateField value={date} onChange={(iso) => setDate(iso)} style={inputStyle}/>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Reference</label>
          <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Approval / reference" style={inputStyle} />
        </div>

        {error && <div style={{ fontSize: 11.5, color: "var(--hz-c-err)", marginBottom: 12, textAlign: "center" }}>{error}</div>}

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

function DocActionFooter({ moduleKey, id, header, invalidate, onPOD, onDeleted }: {
  moduleKey: string; id: string; header: any; invalidate: () => void; onPOD?: () => void;
  onDeleted?: () => void;
}) {
  const qc = useQueryClient();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const notify = useNotify();
  const [error, setError] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [runningKey, setRunningKey] = useState<string | null>(null);

  const mayOperate = useMayOperateDoc(moduleKey);
  const mayPostGrn = useMayPostGrn();
  const podEnabled = !!onPOD && mayOperate;
  const statusActions = useMemo(() => statusActionsFor(moduleKey, id, header, mayOperate, mayPostGrn), [moduleKey, id, header, mayOperate, mayPostGrn]);
  const canPay = offersRecordPayment(moduleKey, header);

  const refresh = () => {
    invalidate();
    void qc.invalidateQueries({ queryKey: ["mobile-module"] });
    invalidateModuleShared(qc, moduleKey);
  };

  const zeroCost = useGrnZeroCostRemedy({ grnId: id, onPosted: refresh });

  const mutation = useMutation({
    mutationFn: (action: DocAction) =>
      authedFetch(action.request.path, {
        method: action.request.method,
        ...(action.request.body !== undefined ? { body: JSON.stringify(action.request.body) } : {}),
      }),
    onSuccess: (data, action) => {
      setRunningKey(null);
      if (action.removes) {
        void qc.invalidateQueries({ queryKey: ["mobile-module"] });
        invalidateModuleShared(qc, moduleKey);
        void notify({ title: "Deleted" });
        onDeleted?.();
        return;
      }
      refresh();
      void notify(actionDoneNotice(action.label, data));
    },
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
    const fired = await askActionReason(action, prompt);
    if (!fired) return;
    setRunningKey(action.key);
    mutation.mutate(fired);
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
  const doNextStepNote =
    moduleKey === "delivery-orders-mfg" && mayOperate && s(header?.status)
      ? (siTransferBlockReason(header?.status) ?? SI_TRANSFER_MOBILE_ROUTE_HINT)
      : null;
  const footNote = doNextStepNote ?? piPaymentHint(moduleKey, header);

  const hasRow = statusActions.length > 0 || canPay;
  if (!hasRow && !podEnabled && !footNote) return null;
  const busy = mutation.isPending;

  return (
    <>
      {error && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: hasRow && podEnabled ? 130 : 76, padding: "0 16px", textAlign: "center", fontSize: 11.5, color: "var(--hz-c-err)", zIndex: 1, maxWidth: "calc(100% - 32px)" }}>{error}</div>
      )}
      <footer className="actbar" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
        {footNote && (
          <p style={{ margin: "0 0 8px", fontSize: 11.5, lineHeight: 1.35, color: "#6b7280" }}>
            {footNote}
          </p>
        )}
        {podEnabled && (
          <button className="btn" onClick={onPOD} style={{ marginBottom: hasRow ? 9 : 0 }}>Proof of Delivery</button>
        )}
        {hasRow && (
          <div style={{ display: "flex", gap: 9 }}>
            {canPay && (
              <button className="btn" disabled={busy} onClick={() => { setError(null); setPayOpen(true); }} style={actSkin("solid", busy)}>Record Payment</button>
            )}
            {statusActions.map((a) => (
              <button className="btn" key={a.key} disabled={busy} onClick={() => run(a)} style={actSkin(a.variant, busy)}>{busy && runningKey === a.key ? "Working…" : a.label}</button>
            ))}
          </div>
        )}
      </footer>
      {payOpen && canPay && (
        <PaymentSheet id={id} header={header} onClose={() => setPayOpen(false)} onDone={refresh} />
      )}
      {zeroCost.sheet}
    </>
  );
}

const COVERAGE_TYPE: Record<string, "po" | "grn" | "pi"> = {
  "mfg-purchase-orders": "po",
  grns: "grn",
  "purchase-invoices": "pi",
};

function DocumentDetail({ map, row, moduleKey, onBack, onEdit, onPOD, flowNav }: { map: DocMap; row: any; moduleKey: string; onBack: () => void; onEdit?: () => void; onPOD?: () => void; flowNav?: FlowNav }) {
  const id = docId(row);
  const qc = useQueryClient();
  const detailNotify = useNotify();
  const [mapOpen, setMapOpen] = useState(false);
  const mapAnchor = flowAnchorForModule(moduleKey);
  const filesKind = FLOW_DOC_KIND_BY_MODULE[moduleKey];
  const coverageType = COVERAGE_TYPE[moduleKey] ?? null;
  const covQ = usePoSoCoverage(coverageType, coverageType && id ? id : null);
  const originByCode = originsByCode(covQ.data);
  const provByCode = provenanceByCode(covQ.data);
  const linkedSkus = storedLinkSkus(covQ.data);
  const deliveredMap = deliveredByCode(covQ.data);
  const { data, isLoading, error } = useQuery({
    queryKey: ["mobile-module-detail", map.path, id],
    queryFn: () => authedFetch<Record<string, unknown>>(`${map.path}/${encodeURIComponent(id)}`),
    enabled: !!id,
    staleTime: 15_000,
  });
  const { nameOf: salespersonNameOf } = useStaffLookup();

  const header = (data?.[map.headerKey] as any) ?? row ?? {};
  const items = (data?.items as any[]) ?? [];
  const meta = map.meta(header, items).filter(([, v]) => v && v !== "—");
  const stats = map.stats(header);

  const cancelled = isCancelledDoc(map.status(header));

  const canPdf = !error && !isLoading;
  const refusePdf = async () => {
    void detailNotify({
      title: "Can't make the PDF yet",
      body: isLoading
        ? "The line items are still loading. Please try again in a moment."
        : "We couldn't load the line items for this document. Making the PDF now would produce one with no items on it. Please refresh and try again.",
    });
  };
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
        const { armDoScanToken } = await import("../vendor/scm/lib/do-scan-token-arm");
        const doId = (header as { id?: string }).id ?? "";
        const salesperson =
          header.salesperson_name ||
          salespersonNameOf(header.agent ?? null, header.salesperson_id ?? null, "") ||
          null;
        const armed = await armDoScanToken(header as Record<string, unknown>, doId);
        await generateDeliveryOrderPdf({ ...armed, salesperson } as never, items as never, { action });
      } else {
        const { generateSalesInvoicePdf } = await import("../vendor/scm/lib/sales-invoice-pdf");
        await generateSalesInvoicePdf(header as never, items as never, { action });
      }
    } catch (e) {
      void detailNotify({ title: "Couldn't generate the PDF", body: e instanceof Error ? e.message : "Please try again." });
    }
  };
  const print = usePrintPreview(deliverPdf);
  const onPdf = !printableDocTitle
    ? undefined
    : !canPdf
      ? refusePdf
      : print.openPreview;

  const mayOperate = useMayOperateDoc(moduleKey);
  const mayPostGrn = useMayPostGrn();
  const podEnabled = !!onPOD && mayOperate;
  const hasStatusActions = !!id && (statusActionsFor(moduleKey, id, header, mayOperate, mayPostGrn).length > 0 || offersRecordPayment(moduleKey, header) || piPaymentHint(moduleKey, header) !== null);
  const hasFooter = hasStatusActions || podEnabled;
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["mobile-module-detail", map.path, id] }); };

  return (
    <div className="hz-m" style={{ ...wrapStyle, position: "relative" }}>
      <DetailHeader
        eyebrow={map.eyebrow(header)}
        title={map.title(header)}
        subtitle={map.subtitle?.(header)}
        status={map.status(header)}
        statusDoc={map.statusDoc}
        onBack={onBack}
        onEdit={onEdit}
        onPdf={onPdf}
        onMap={mapAnchor && id ? () => setMapOpen(true) : undefined}
      />
      {printableDocTitle && (
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
        {!id && <div style={{ textAlign: "center", color: "var(--hz-c-err)", fontSize: 12, padding: "26px 0" }}>Couldn't identify this record.</div>}

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
              {isLoading && <div style={{ fontSize: 11.5, color: "var(--hz-c-ink-soft)", padding: "9px 0" }}>Loading{"…"}</div>}
              {!!error && !isLoading && <div style={{ fontSize: 11.5, color: "var(--hz-c-err)", padding: "9px 0" }}>Couldn't load line items. Please try again.</div>}
              {!isLoading && !error && (items.length ? items.map((it, i) => {
                const l = map.line(it);
                const code = String(((it?.item_code ?? it?.item_code) ?? "")).trim();
                const assigned = coverageType ? (originByCode.get(code) ?? []) : undefined;
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
                const isDo = moduleKey === "delivery-orders-mfg";
                const committedBatch = moduleKey === "delivery-orders-mfg"
                  ? ((it?.committed_po_batch_no as string | null | undefined) ?? null)
                  : null;
                const delivered = coverageType ? (deliveredMap.get(code) ?? []) : undefined;
                const provenance = coverageType ? (provByCode.get(code) ?? []) : undefined;
                return <LineItem key={s(it?.id) || i} name={l.name} sub={l.sub} remark={l.remark} qty={l.qty} unitSen={l.unitSen} amountSen={l.amountSen} assigned={assigned} sourceLinked={coverageType ? linkedSkus.has(code) : undefined} provenance={provenance} allocations={allocations} poNumber={s(header?.po_number)} sourcePos={sourcePos} sourceAdj={sourceAdj} racks={isDo ? ((it?.racks as string[] | undefined) ?? []) : undefined} sourceState={isDo ? ((it?.source_state as "locked" | "worked_out" | null | undefined) ?? null) : undefined} delivered={delivered} committedBatch={committedBatch} substituted={moduleKey === "delivery-orders-mfg" && Boolean(it?.ac_substituted)} poRef={<><MobileLinePoFacts moduleKey={moduleKey} line={it ?? {}} nav={flowNav} />{id && <MobileGrnLineRack moduleKey={moduleKey} grnId={id} header={header} line={it ?? {}} onSaved={invalidate} />}</>} />;
              }) : <div style={{ fontSize: 11.5, color: "var(--hz-c-ink-soft)", padding: "9px 0" }}>No line items.</div>)}
            </div>
            {!isLoading && !error && id && <MobileAddLine moduleKey={moduleKey} docId={id} header={header} onAdded={invalidate} />}
          </div>
        )}
        {!!id && filesKind && <div style={{ marginTop: 13 }}><FlowDocFilesCard kind={filesKind} docId={id} status={s(header?.status) || null} /></div>}
      </div>
      {moduleKey === "delivery-orders-mfg" && id && <MobileDoDeliveryIssues doId={id} />}
      {moduleKey === "delivery-orders-mfg" && id && (
        <DoEarlierPodAttempts doId={id} docNo={s(header?.do_number) || `DO ${id.slice(0, 8)}`} />
      )}
      {moduleKey === "delivery-orders-mfg" && s(header?.so_doc_no) && (
        <MobileCollectedOnOrder soDocNo={s(header?.so_doc_no)} currency={s(header?.currency) || "MYR"} />
      )}
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


function humanize(key: string): string {
  return key
    .replace(/_sen$|_sen$/i, "")
    .replace(/_id$/i, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

const HIDDEN_KEYS = /^(id|created_by|updated_by|.*_by|.*_id|.*_color|color|.*_json|variants|custom_specials|password|token)$/i;

type Field = { label: string; value: string; mono: boolean; wide: boolean };

function rowToFields(row: any): Field[] {
  if (!row || typeof row !== "object") return [];
  const out: Field[] = [];
  for (const [key, raw] of Object.entries(row)) {
    if (HIDDEN_KEYS.test(key)) continue;
    if (raw == null || raw === "") continue;
    if (typeof raw === "object") continue;
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

const SIMPLE_DOC_PATHS: Record<string, { path: string; headerKey: string }> = {};


function SimpleDetail({ moduleKey, row, title, onBack, onEdit }: { moduleKey: string; row: any; title: string; onBack: () => void; onEdit?: (fresh?: Record<string, unknown>) => void }) {
  /* Owner 2026-07-17 — cost is director-only. Its own useAuth: the costing gate
     further up this file lives in a DIFFERENT component, so there is nothing to
     borrow here. */
  const { user: detailUser } = useAuth();
  const wantSupplier = moduleKey === "suppliers";
  const id = s(row?.id);
  const supplierQ = useQuery({
    queryKey: ["mobile-supplier-detail", id],
    queryFn: () => authedFetch<{ supplier: any; bindings: any[] }>(`/suppliers/${encodeURIComponent(id)}`),
    enabled: wantSupplier && !!id,
    staleTime: 30_000,
  });

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
  const cancelled = wantDoc && isCancelledDoc(status);
  const dumpFields = rowToFields(effectiveRow);

  const qc = useQueryClient();
  const actionRow = row ?? {};
  const actionId = s(row?.id);
  const mayOperate = useMayOperateDoc(moduleKey);
  const mayPostGrn = useMayPostGrn();
  const hasFooter = !!actionId && (statusActionsFor(moduleKey, actionId, actionRow, mayOperate, mayPostGrn).length > 0 || offersRecordPayment(moduleKey, actionRow) || piPaymentHint(moduleKey, actionRow) !== null);
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["mobile-module"] }); };

  return (
    <div className="hz-m" style={{ ...wrapStyle, position: "relative" }}>
      <DetailHeader
        eyebrow={eyebrow === "—" ? "" : eyebrow}
        title={heading}
        status={status}
        statusDoc={null}
        onBack={onBack}
        onEdit={onEdit && wantSupplier && supplierQ.data?.supplier ? () => onEdit(effectiveRow) : onEdit}
      />
      <div className="scroll hz-scroll" style={hasFooter ? { ...scrollStyle, paddingBottom: 96 } : scrollStyle}>
        {cancelled && <CancelledRibbon header={docHeader} />}
        <div style={cancelled ? { opacity: 0.55, pointerEvents: "none" } : undefined}>
        <Eyebrow>Details</Eyebrow>
        {configFields ? (
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
            <div style={{ fontSize: 11.5, color: "var(--hz-c-ink-soft)", padding: "9px 0" }}>No details to show.</div>
          </div>
        )}

        {moduleKey === "members" && (
          <MemberAccountActions row={effectiveRow} onDone={() => { void qc.invalidateQueries({ queryKey: ["mobile-module"] }); }} />
        )}

        </div>
      </div>
      {hasFooter && <DocActionFooter moduleKey={moduleKey} id={actionId} header={actionRow} invalidate={invalidate} onDeleted={onBack} />}
    </div>
  );
}


export function MobileModuleDetail({ moduleKey, row, title, onBack, onPOD, onEdit, flowNav }: {
  moduleKey: string; row: any; title: string; onBack: () => void; onPOD?: () => void;
  onEdit?: (fresh?: Record<string, unknown>) => void;
  flowNav?: FlowNav;
}) {
  const editable = !!MODULE_CONFIGS[moduleKey]?.form?.updatePath || moduleKey === "delivery-orders-mfg";
  const editHandler = editable ? onEdit : undefined;
  const doc = DOC_MODULES[moduleKey];
  if (doc) {
    return <DocumentDetail map={doc} row={row} moduleKey={moduleKey} onBack={onBack} onEdit={editHandler} onPOD={onPOD} flowNav={flowNav} />;
  }
  return <SimpleDetail moduleKey={moduleKey} row={row} title={title} onBack={onBack} onEdit={editHandler} />;
}

import { DateField } from "../vendor/scm/components/DateField";
import { MobileCollectedOnOrder } from "./MobileCollectedOnOrder";
import { MobileDoDeliveryIssues } from "./DeliveryIssueForm";
import { DoEarlierPodAttempts } from "../components/scm-v2/DoEarlierPodAttempts";
import { poDriftMode } from "../vendor/scm/lib/po-drift";
import { returnCreditLabel } from "../vendor/scm/lib/return-credit-state";
import { shortRackLabels } from "../vendor/scm/lib/rack-label";
