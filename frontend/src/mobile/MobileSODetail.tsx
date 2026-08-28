import { useEffect, useState, type CSSProperties } from "react";
import { formatDate } from "../lib/utils";
import { SourcePosRowMobile, soStockPillMobile } from "./source-chips";
import { MobileRelationshipMap } from "./MobileRelationshipMap";
import type { FlowNav } from "./relationship-map-model";
import { fmtAmt } from "../lib/scm";
import { useQueryClient } from "@tanstack/react-query";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { usePrompt } from "../vendor/scm/components/PromptDialog";
import { fetchScanSlipImageBlobUrl } from "../vendor/scm/lib/slip";
import { useStaff, usePickableStaff } from "../vendor/scm/lib/admin-queries";
import { statusLabel } from "../vendor/scm/lib/status-pill";
import { useAuth as useHouzsAuth } from "../auth/AuthContext";
import { ACCESS_RANK } from "../types";
import {
  useMfgSalesOrderDetail,
  useSalesOrderPayments,
  useUpdateMfgSalesOrderStatus,
  useDeleteMfgSalesOrder,
  useSalesOrderAuditLog,
  type SoAuditEntry,
  type SoAuditFieldChange,
} from "../vendor/scm/lib/sales-order-queries";
import { buildVariantSummary } from "../vendor/shared/variant-summary";
import { formatPhone } from "../vendor/shared/phone";
import { orderLineIdentity } from "@2990s/shared";
import {
  CANCELLABLE_STATUSES,
  isLocked as isSoLocked,
  procLockActive as soProcLockActive,
  amendmentEligible as soAmendmentEligible,
  deriveBalance,
} from "../vendor/scm/lib/so-detail-gates";
import {
  amendmentHeaderDiffRows,
  soHeaderFieldKind,
  type SoAmendmentHeaderChanges,
} from "../vendor/scm/lib/so-amendment-header";
import {
  amendmentLineChangedFields,
  amendmentLineFieldKinds,
  amendmentOldSnapshot,
  amendmentUnrenderedAxes,
  amendmentVariantSummaries,
  visibleAmendmentLines,
} from "../vendor/scm/lib/so-amendment-line-diff";
import {
  routeField,
  summariseRouting,
  FIELD_KIND_LABEL,
  TYPE_LABEL,
  type AmendmentFieldKind,
} from "../vendor/scm/lib/amendment-routing";
import {
  useAmendmentDetail,
  useSupplierConfirm,
  useApproveSo,
  useApprovePo,
  useSendAmendment,
  useRejectAmendment,
  useWithdrawAmendment,
  type AmendmentLine,
} from "../vendor/scm/lib/so-amendment-queries";
/* Printable amendment document — the SAME shared client-side jsPDF template the
   desktop AmendmentDetailV2 and the PO mobile detail use (one logic layer). Gives
   the mobile SO-amendment surface the "Print amendment" the desktop already had,
   closing the desktop/mobile parity gap. */
import { generateAmendmentPdf } from "../vendor/scm/lib/amendment-pdf";
import { PrintPreviewModal, usePrintPreview } from "../components/scm-v2/PrintPreviewModal";
import type { PdfAction } from "../vendor/scm/lib/pdf-common";
import { amendmentPrintedStatus, soAmendmentToPdfInput } from "../vendor/scm/lib/amendment-pdf-map";
import { useStaffLookup } from "../hooks/useStaffLookup";
/* The 2990 bridge's staff row — the vocabulary so_amendments.requested_by is
   written in (a scm.staff uuid). Desktop AmendmentDetailV2 compares it to decide
   "did I raise this?"; mirrored here so the mobile withdraw gate matches exactly
   (the Houzs bridge has no staff id, so isRequester is inert on BOTH surfaces —
   the effective gate is canReject — but the logic is kept identical so a future
   bridge fix lands on both at once). */
import { useAuth as useScmAuth } from "../vendor/scm/lib/auth";
import {
  buildAmendmentDecisionHistory,
  isRejectDecision,
} from "../vendor/scm/lib/so-amendment-history";
/* Owner 2026-07-16 — the persisted-payment ledger (rows + slip + amount + edit
   + delete + the edit sheet) is the SHARED RecordedPayments module, rendered
   identically by the Edit Sales Order sheet (MobileNewSO). This screen no longer
   owns any payment-row markup: that second, read-only copy is exactly what made
   Edit Draft offer LESS than the screen it was opened from. */
import { AddPaymentSheet, RecordedPaymentsList, type RecordedPayment } from "./RecordedPayments";
import "./mobile.css";

/* Shapes are the subset of the /mfg-sales-orders/:docNo + /:docNo/payments
   responses the mobile detail screen reads. The backend camelCases nothing —
   these are the raw snake_case columns. */
type SoHeader = {
  doc_no: string;
  debtor_name: string | null;
  status: string | null;
  phone: string | null;
  email: string | null;
  customer_type: string | null;
  salesperson_id: string | number | null;
  sales_location: string | null;
  customer_state: string | null;
  /* Task #121 — country snapshot auto-derived from customer_state (mig 0082).
     Desktop SO Detail surfaces it as the address block's Country line. */
  customer_country: string | null;
  ref: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  /* Emergency contact — the detail HEADER carries all three columns
     (emergency_contact_name / _phone / _relationship). The Build Spec's
     Customer card shows an "Emergency contact" row, HIDDEN entirely when no
     phone is on file. Mirrors the desktop SO form's emergency block. */
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  building_type: string | null;
  /* venue = free-text venue name (customer-facing, on PDFs); venue_id = the
     master FK (mig 0086). Desktop reads the name for display, id as fallback. */
  venue: string | null;
  venue_id: string | null;
  note: string | null;
  /* Delivery address columns — the desktop SO form maps these to labelled
     lines (address1/2 = free-text; address3 = city fallback; address4 =
     postcode fallback; customer_state = State; customer_country = Country).
     The header also carries `city`/`postcode` proper columns, so read those
     first and fall back to address3/address4 exactly like desktop. */
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
  city: string | null;
  postcode: string | null;
  customer_delivery_date: string | null;
  processing_date: string | null;
  so_date: string | null;
  created_at: string | null;
  local_total_sen: number | null;
  total_revenue_sen: number | null;
  paid_sen_total: number | null;
  balance_sen: number | null;
  /* Tier 2 downstream-lock + delivery progress — stamped by the detail GET
     (same fields the desktop SO Detail / list read). has_children = a
     non-cancelled DO/SI references this SO (locks Edit + Cancel). */
  has_children: boolean | null;
  delivery_state: string | null;
  /* SO-amendment gate flags (Phase 1-C, read-only) — the GET /:docNo endpoint
     derives these (backend mfg-sales-orders.ts). amendment_eligible = the SO is
     processing-locked (already PO'd to the supplier) but still editable via the
     amendment flow, so a line change here must go out as an amendment request.
     open_amendment is the light summary of any in-flight amendment (status NOT IN
     SENT/REJECTED). Same flags the desktop SalesOrderDetail routes on. */
  amendment_eligible: boolean | null;
  /* Owner 2026-08-12 — a live PO already claims one of this SO's lines (2990
     only). Feeds soProcLockActive (line ~390), so the phone freezes the same
     fields the desktop does with no processing date involved. */
  po_locked: boolean | null;
  has_open_amendment: boolean | null;
  open_amendment: { id: string; status: string; amendment_no: string; lane?: string | null } | null;
  /* Scan-flow proof photos (migrations 0033 + 0034) — R2 keys for the
     handwritten order slip and the card-terminal payment receipt this SO was
     scanned from. Dual-read camelCase ?? snake_case at the use site (the pg
     driver camelCases result columns on some paths). */
  slip_image_key: string | null;
  receipt_image_key: string | null;
};
type SoItem = {
  id: string;
  description: string | null;
  /* Backend returns mfg_sales_order_items.variants as a JSONB OBJECT (not a
     pre-formatted string). Render it through the shared summary builder — the
     prototype's `variants: string` assumption crashed on .trim(). */
  item_group: string | null;
  variants: Record<string, unknown> | null;
  /* description2 = the server-computed variant summary string (HOOKKA-style),
     stamped on the line. Used as a fallback when the raw `variants` object is
     absent/empty so the spec line still shows its category-aware spec text. */
  description2: string | null;
  item_code: string | null;
  /* Unit of measure — the Build Spec line item reads "SKU {sku} · {uom}". */
  uom: string | null;
  qty: number | null;
  unit_price_sen: number | null;
  /* Per-line discount (mfg_sales_order_items.discount_sen). Desktop SO detail
     shows it in the "Disc" column; without it a discounted line silently hid the
     discount on mobile and an FOC line read "RM 0.00 ×qty" with no marker. */
  discount_sen: number | null;
  total_sen: number | null;
  line_delivery_date: string | null;
  /* Per-line stock + source-PO trace (owner 2026-08-01) — stamped by the SAME
     GET /mfg-sales-orders/:docNo the desktop reads. Mobile renders the stock
     pill + source chips so the phone answers "which PO are these goods from"
     exactly like the desktop (one-product rule). */
  stock_status?: string | null;
  stock_state?: "stock" | "po" | "shortage" | null;
  coverage_po?: string | null;
  coverage_eta?: string | null;
  shipped_source_pos?: string[];
  shipped_source_adj?: boolean;
  ready_source_pos?: Array<{ po: string | null; qty: number; kind: "po" | "adjustment" }>;
  delivered_qty?: number | null;
  remaining_qty?: number | null;
  /* A retired line — the SO's history, not part of the live order. Returned by
     GET /:docNo like every other row; filtered out at the use site. */
  cancelled?: boolean | null;
  /* The operator's free-text instruction for whoever executes this line (the
     line card's "Type remarks…" box). Served by GET /:docNo all along and
     rendered on neither platform until 2026-08-11 — see the render site. */
  remark?: string | null;
};
type SoPayment = {
  id: string;
  paid_at: string | null;
  method: string | null;
  merchant_provider: string | null;
  installment_months: number | null;
  online_type: string | null;
  approval_code: string | null;
  account_sheet: string | null;
  collected_by: string | null;
  collected_by_name: string | null;
  amount_sen: number | null;
  slip_key: string | null;
  /* Row creation instant (UTC) — drives the same-day EDIT affordance (a payment
     may be corrected only on the MY calendar day it was recorded). */
  created_at: string | null;
};

// Bare 2dp amount; callers print their own "RM " prefix. The shared fmtAmt
// keeps a non-finite from reaching the user as "RM NaN".
const rm = fmtAmt;
/* Full date for the locked read-only fields. Numeric DD/MM/YYYY via the shared
   formatter (house rule — no month names), which also UTC-tags bare timestamps. */
const dl = (d: string | null | undefined) => formatDate(d);
/* Locked-field value or em-dash — a field the detail endpoint doesn't return
   (or returns empty) renders as "—" inside the .fld-ro box, per the brief. */
const val = (v: string | null | undefined) => {
  const s = (v ?? "").toString().trim();
  return s.length ? s : "—";
};
/* DRAFT → Draft, CANCELLED → Cancelled, everything else (CONFIRMED,
   IN_PRODUCTION, READY_TO_SHIP, SHIPPED, DELIVERED …) reads as a live/Submitted
   order — matching the design's 3-state action model. */
const phase = (status: string | null): "draft" | "cancelled" | "submitted" => {
  const s = (status ?? "").toUpperCase();
  if (s === "DRAFT") return "draft";
  if (s === "CANCELLED") return "cancelled";
  return "submitted";
};
const total = (h: SoHeader) => h.local_total_sen ?? h.total_revenue_sen ?? 0;

/** Sales Order DETAIL — markup ported VERBATIM from the owner's mobile design
 *  (`#so-detail` + `renderSoDetail`/`openSO`), wired to the real
 *  /mfg-sales-orders/:docNo (header + line items) and /:docNo/payments.
 *  Draft/Submitted actions PATCH /:docNo/status. Design classes only. */
export function MobileSODetail({ docNo, onBack, onEdit, flowNav }: { docNo: string; onBack: () => void; onEdit?: (docNo: string) => void;
  /** Relationship-Map node navigation (MobileApp). Absent → map nodes inert. */
  flowNav?: FlowNav;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const notifyTop = useNotify();
  const askPrompt = usePrompt();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /* Relationship Map — the mobile twin of the desktop SO map
     (so-relationship-map.ts → DocumentRelationshipMapModal). The SO anchor
     reads /document-flow/so/:docNo ONLY — no coverage fetch, matching the
     desktop SO map's deliberate no-floating-hop rule (coverage is
     purchase-doc-keyed; an SO-keyed read would be new backend load). */
  const [mapOpen, setMapOpen] = useState(false);
  /* SO-amendment (Phase 1-C) — the pending-amendment banner's actions. The
     diff sheet opens with the amendment id; the supplier-confirm sheet toggles
     inline. approve-SO / reject / withdraw are direct mutations gated by
     permission + status. All reuse the vendored so-amendment-queries hooks (no
     re-implemented API). */
  const [viewingAmendmentId, setViewingAmendmentId] = useState<string | null>(null);
  const [supplierConfirmOpen, setSupplierConfirmOpen] = useState(false);
  const approveSo = useApproveSo();
  const approvePo = useApprovePo();
  const sendAmendment = useSendAmendment();
  const rejectAmendment = useRejectAmendment();
  const withdrawAmendment = useWithdrawAmendment();
  const updateStatus = useUpdateMfgSalesOrderStatus();
  const deleteDraft = useDeleteMfgSalesOrder();

  /* Reads route through the SHARED vendored hooks (vendor/scm/lib/
     sales-order-queries) so mobile lives in the SAME query-key namespace as the
     desktop SalesOrderDetail — shared mutations (status / payments / amendments)
     invalidate ['mfg-sales-order-detail'] + ['mfg-sales-orders', docNo,
     'payments'] and those invalidations now reach this screen too. */
  const detail = useMfgSalesOrderDetail(docNo);
  const paymentsQ = useSalesOrderPayments(docNo);

  const staffQ = useStaff();
  /* staffQ (FULL roster) resolves persisted names (a scoped-out / resigned
     salesperson or collector still shows a name). The payment "Collected By"
     SELECTION list must instead be the company-scoped, ACTIVE-only pickable set
     (Team-grant rule), mirroring the desktop PaymentsTable — a resigned or
     other-company staff must never be a NEW pickable collector. */
  const pickableStaffQ = usePickableStaff({ onlySales: true });
  const houzsAuth = useHouzsAuth();
  const h = detail.data?.salesOrder as SoHeader | undefined;
  /* Cancelled lines are dropped here for the SAME reason desktop V2 drops them
     (SalesOrderDetailV2.tsx `.filter((l) => !l.cancelled)`): GET /:docNo returns
     an SO's retired lines along with its live ones, and this screen's `items`
     feeds both the Line items card and generateSalesOrderPdf. Desktop filtered
     and mobile did not — the one-shared-rule divergence this repo keeps paying
     for. Production held zero cancelled rows until 2026-08-10, so it never
     showed. */
  const items = ((detail.data?.items ?? []) as SoItem[]).filter((l) => !l.cancelled);
  /* MONEY IS EITHER KNOWN OR UNKNOWN — the MobilePOD (#653) rule, applied to the
     sibling screen that runs the same subtraction. `paymentsQ.data ?? []` folded
     a FAILED payments read into "no payments", and `data` is set only by a
     SUCCESSFUL fetch, so an empty array meant two different things. An empty
     array is an ANSWER (a genuinely unpaid SO has none); the ABSENCE of one is
     not. */
  const paymentsKnown = paymentsQ.error === null && Array.isArray(paymentsQ.data);
  const payments = (paymentsKnown ? paymentsQ.data! : []) as SoPayment[];
  /* Download the SO PDF — reuses the SAME desktop generator (per-brand letterhead)
     so the phone produces byte-identical output. 'save' = normal download. */
  const deliverPdf = async (action: PdfAction) => {
    if (!h) return;
    /* This PDF is handed to the CUSTOMER. Generating it from an unknown payments
       ledger prints an empty Payments table, which does not read as "we could not
       load this" — it reads as "you have paid nothing and owe the full total".
       Refusing to print is recoverable; a wrong statement of what a customer owes
       is not. Same guard as the desktop SalesOrderDetail print path. */
    if (!paymentsKnown) {
      void notifyTop({
        title: "Can't generate the PDF yet",
        body: paymentsQ.isFetching
          ? "Still loading this order's payments. Please try again in a moment."
          : `${
              paymentsQ.error instanceof Error
                ? paymentsQ.error.message
                : "This order's payments could not be read."
            } Printing now would show the customer an empty Payments table.`,
      });
      return;
    }
    try {
      const { generateSalesOrderPdf } = await import("../vendor/scm/lib/sales-order-pdf");
      await generateSalesOrderPdf(h as never, items as never, payments as never, action, []);
    } catch (e) {
      void notifyTop({ title: "Couldn't generate the PDF", body: e instanceof Error ? e.message : "Please try again." });
    }
  };
  const print = usePrintPreview(deliverPdf);

  /* Salesperson NAME — the detail header carries only salesperson_id (a staff
     UUID), so resolve it against the shared /staff list. Falls back to em-dash
     while loading or when the id has no matching active staff row. */
  const salespersonName = h?.salesperson_id != null
    ? (staffQ.data ?? []).find((s) => String(s.id) === String(h.salesperson_id))?.name ?? null
    : null;

  /* Status change routes through the SHARED useUpdateMfgSalesOrderStatus so
     mobile gets the same optimistic update + audit-log / status-changes
     invalidation desktop has (the raw inline PATCH skipped both). */
  const setStatus = async (status: string, confirmMsg?: string) => {
    if (busy) return;
    if (confirmMsg && !(await confirm({ title: confirmMsg, confirmLabel: "Confirm", danger: true }))) return;
    setActionError(null);
    setBusy(true);
    try {
      await updateStatus.mutateAsync({ docNo, status, expectedStatus: h?.status ?? null });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  /* Discard draft (owner 2026-07-20) — hard-deletes a junk DRAFT (esp. a bad
     scan/OCR draft) instead of burning a doc number on confirm→cancel. Behind the
     house confirm dialog (no naked destructive action); the backend refuses
     anything but a DRAFT. On success the SO no longer exists, so we leave the
     detail (onBack) rather than showing a screen for a deleted order. */
  const handleDiscardDraft = async () => {
    if (busy || !h) return;
    if (!(await confirm({
      title: `Discard draft ${docNo}?`,
      body: "This permanently deletes this draft order and everything on it. It can't be undone. (Confirmed orders are cancelled, not discarded.)",
      confirmLabel: "Discard draft",
      danger: true,
    }))) return;
    setActionError(null);
    setBusy(true);
    try {
      await deleteDraft.mutateAsync({ docNo });
      void notifyTop({ title: "Draft discarded" });
      onBack();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Couldn't discard the draft. Please try again.");
      setBusy(false);
    }
  };

  const ph = h ? phase(h.status) : "submitted";
  /* Balance — null means UNKNOWN, not zero. deriveBalance prefers the
     server-stamped `balance_sen`, then `paid_sen_total`, and only falls
     through to summing the payments ledger when BOTH header fields are null.
     That is the one case where a failed payments read corrupts the answer:
     paid becomes 0 and the balance renders as the FULL order total. Narrow, but
     it is the #653 loss exactly (an already-paid order shown as owing
     everything), so it fails closed instead of guessing. */
  const balanceUnknown =
    h != null && h.balance_sen == null && h.paid_sen_total == null && !paymentsKnown;
  const bal = h && !balanceUnknown ? deriveBalance(h, payments) : null;

  /* Parity with desktop SO Detail / list gating — the primitives now come from
     the SHARED vendor/scm/lib/so-detail-gates module so a fix lands once for
     both platforms (statuses are upper-cased inside the gate).
     - Cancel is offered only on in-flight statuses (CONFIRMED / IN_PRODUCTION /
       READY_TO_SHIP), never once SHIPPED+ / INVOICED / CLOSED — those carry
       downstream docs (CANCELLABLE_STATUSES).
     - isLocked = SHIPPED+ terminal status OR a non-cancelled DO/SI references it
       (has_children). Mirrors SalesOrderDetail.isLocked. */
  const rawStatus = (h?.status ?? "").toUpperCase();
  const hasChildren = Boolean(h?.has_children);
  const canCancel = CANCELLABLE_STATUSES.includes(rawStatus);
  const isLocked = isSoLocked(h?.status, hasChildren);

  /* Processing LOCK — the shared procLockActive: once the SO has a Processing
     Date AND that day has passed (compared against todayMyt() — the Malaysia
     calendar day, NOT the device's local day) the line items are historical.
     Having a Processing Date IS being proceeded (owner, pinned 2026-08-13);
     there is no separate stamp to consult. Here we surface a banner and treat the SO as
     edit-locked so the detail never offers line-item edits on a proceeded,
     past-processing order. */
  const processingLocked = h ? soProcLockActive(h) : false;

  /* Amendment gate (server-derived, desktop SalesOrderDetail parity) — when
     amendment_eligible AND not hard-locked the SO is processing-locked but still
     editable via the amendment flow, so Edit stays ENABLED (tapping it routes
     into MobileNewSO's amendment-raise mode) rather than being hard-locked by
     the processing date. A SHIPPED/terminal SO is never amendment-eligible.
     open_amendment / has_open_amendment drive the pending banner + its gate
     actions below. */
  const amendmentEligible = h ? soAmendmentEligible(h, isLocked) : false;
  const openAmendment = h?.open_amendment ?? null;
  const hasOpenAmendment = Boolean(h?.has_open_amendment) && openAmendment != null;

  /* editLocked (disables the footer Edit button) = hard-locked (terminal status
     OR downstream DO/SI) OR a proceeded past-processing order that is NOT
     amendment-eligible. An amendment-eligible SO keeps Edit live so the
     salesperson can raise an amendment from mobile instead of reopening it on
     desktop. */
  const editLocked = isLocked || (processingLocked && !amendmentEligible);

  /* Houzs perm gates (mirror the server-side scm.amendment.* keys, desktop
     parity) — the server 403 stays the real gate (its plain-language message is
     humanised by authed-fetch); these just hide the affordance from users who
     can't use it. */
  /* Both footer actions below are WRITES -- "Edit Draft" PATCHes the SO and
     "Create Sales Order" PATCHes /:docNo/status. The backend's area guard needs
     `edit` for either (scm/middleware/area-guard: GET/HEAD -> view,
     POST/PATCH/PUT/DELETE -> edit, "else 403 (ENFORCED)"), so a view-level rep
     was shown both and got a 403 on the tap. Owner's off-not-hide rule: a
     button its holder cannot use must be ABSENT, not fail on press. */
  const canWriteSo =
    houzsAuth.can("scm.access") ||
    ACCESS_RANK[houzsAuth.pageAccess("scm.sales.orders")] >= ACCESS_RANK.edit;
  const canSupplierConfirm = houzsAuth.can("scm.amendment.supplier_confirm");
  const canApproveSo = houzsAuth.can("scm.amendment.approve_so");

  /* Reject / Withdraw (desktop AmendmentDetailV2 parity) — the two escape hatches
     the pending banner was missing. Without them the person who raised a mistaken
     amendment could neither reject nor pull it back, so their only move was to
     raise ANOTHER one — the competing-documents problem (Owner 2026-07-19).
       • Reject rides the purchasing gate the backend enforces
         (scm.amendment.approve_po), available at every pre-approved gate
         (REQUESTED / SUPPLIER_PENDING) — desktop `!pastSoGate && canReject`.
       • Withdraw is the REQUESTER's own way out, REQUESTED only, offered to the
         requester OR anyone who could reject — desktop `status === "REQUESTED"
         && (isRequester || canReject)`.
     The server re-checks both; these gates only decide whether to show the
     control. `requested_by` (a scm.staff uuid) comes off the shared amendment
     detail (useAmendmentDetail — same query key the diff sheet warms). The
     scm-auth bridge has no staff id on Houzs, so isRequester is inert here
     exactly as on desktop (the effective gate is canReject), but the shape is
     kept identical so a future bridge fix lands on both surfaces at once. */
  const { staff: scmStaff } = useScmAuth();
  const openAmendmentDetail = useAmendmentDetail(hasOpenAmendment && openAmendment ? openAmendment.id : null);
  const amendmentStatus = (openAmendment?.status ?? "").toUpperCase();
  const amendmentRequestedBy =
    (openAmendmentDetail.data?.amendment as { requested_by?: string | null } | undefined)?.requested_by ?? null;
  const isAmendmentRequester =
    amendmentRequestedBy != null && scmStaff?.id != null && String(amendmentRequestedBy) === String(scmStaff.id);
  /* Two-lane rework (2026-07-27): a lane row (open_amendment.lane set) has ONE
     approver key — LINES → purchasing, DELIVERY → logistics — and its whole
     life is REQUESTED → applied. The legacy chain keys below stay for
     pre-rework (lane null) rows only. */
  const amendmentLane =
    openAmendment?.lane === "LINES" || openAmendment?.lane === "DELIVERY"
      ? openAmendment.lane : null;
  const canApproveLane =
    amendmentLane != null
    && houzsAuth.can(amendmentLane === "LINES" ? "scm.amendment.approve_lines" : "scm.amendment.approve_delivery");
  const canRejectAmendment = amendmentLane
    ? canApproveLane
    : houzsAuth.can("scm.amendment.approve_po");
  /* Approve-PO + Send gates (SO_APPROVED -> PO_APPROVED -> SENT) ride the SAME
     purchasing key the server enforces + the desktop PO banner uses
     (scm.amendment.approve_po). The server 403 stays the real gate. */
  const canApprovePo = houzsAuth.can("scm.amendment.approve_po");
  /* The bound PO carried on the shared amendment detail — names the PO in the
     "SO revised, PO not yet revised" safety warning; null until the PO exists. */
  const boundPo =
    (openAmendmentDetail.data?.purchaseOrders?.[0] as { id: string; po_number: string; status: string } | undefined) ?? null;
  const canOfferReject = amendmentLane
    ? amendmentStatus === "REQUESTED" && canRejectAmendment
    : (amendmentStatus === "REQUESTED" || amendmentStatus === "SUPPLIER_PENDING") && canRejectAmendment;
  const canOfferWithdraw =
    amendmentStatus === "REQUESTED" && (isAmendmentRequester || canRejectAmendment);

  /* Reject (an APPROVER refusing) — reason MANDATORY (server 400s without one; a
     refusal that doesn't say why leaves the requester guessing and resubmitting).
     Same ≥5-char prompt as desktop handleReject. */
  const handleReject = async () => {
    if (!openAmendment) return;
    const reason = await askPrompt({
      title: `Reject amendment ${openAmendment.amendment_no || ""}?`.trim(),
      body: "The Sales Order keeps its current revision and nothing is changed. "
        + "Say what is wrong so the person who raised it knows what to fix — they will see this.",
      placeholder: "e.g. supplier cannot supply PC151-01 in this fabric",
      multiline: true,
      confirmLabel: "Reject amendment",
      validate: (v) =>
        v.trim().length < 5
          ? "Give a reason the requester can act on — at least a few words."
          : null,
    });
    if (reason == null) return; // cancelled
    try {
      await rejectAmendment.mutateAsync({ id: openAmendment.id, reason: reason.trim() });
      void notifyTop({
        title: "Amendment rejected",
        body: "The person who raised it can see your reason and raise a corrected request.",
      });
    } catch (e) {
      void notifyTop({
        title: "Could not reject this amendment",
        body: `${e instanceof Error ? e.message : String(e)} Nothing was changed — please try again.`,
        tone: "error",
      });
    }
  };

  /* Withdraw (the REQUESTER pulling their own request back) — REQUESTED only;
     the server refuses once anyone has acted on it. Confirm first, then an
     OPTIONAL reason, mirroring desktop handleWithdraw's two steps. */
  const handleWithdraw = async () => {
    if (!openAmendment) return;
    if (!(await confirm({
      title: `Withdraw amendment ${openAmendment.amendment_no || ""}?`.trim(),
      body: "This closes the request without changing the Sales Order. It cannot be reopened — "
        + "but withdrawing frees the order so you can raise a corrected amendment straight away.",
      confirmLabel: "Withdraw request",
      danger: true,
    }))) return;
    const reason = await askPrompt({
      title: "Why are you withdrawing it?",
      body: "Optional — this is recorded on the Sales Order's history so the next person can follow what happened.",
      placeholder: "e.g. raised against the wrong line",
      multiline: true,
      confirmLabel: "Withdraw request",
    });
    if (reason == null) return; // cancelled at the second step
    try {
      await withdrawAmendment.mutateAsync({ id: openAmendment.id, reason: reason.trim() || undefined });
      void notifyTop({
        title: "Amendment withdrawn",
        body: "This Sales Order is free again — open it and submit a corrected amendment when you are ready.",
      });
    } catch (e) {
      void notifyTop({
        title: "Could not withdraw this amendment",
        body: `${e instanceof Error ? e.message : String(e)} It is still open — please try again.`,
        tone: "error",
      });
    }
  };

  /* Approve-SO gate (SUPPLIER_PENDING → SO_APPROVED). Confirms, then re-derives
     the SO server-side; the vendored useApproveSo mutation already invalidates
     the shared SO detail + amendment queries this screen now reads, so no
     mobile-scoped refresh is needed. */
  const handleApproveSo = async () => {
    if (!openAmendment || busy) return;
    if (!(await confirm({
      title: `Approve ${amendmentLane ? "amendment" : "SO revision"} for ${docNo}?`,
      body: amendmentLane === "LINES"
        ? "Check with the supplier BEFORE approving — your signature records the change is workable. The Sales Order is revised at once and a follow-up PO Amendment is raised for you to confirm in PO Amendments. This cannot be undone."
        : amendmentLane === "DELIVERY"
          ? "This applies the delivery changes to the Sales Order at once (the current version is snapshotted into Revisions). The purchase order is not touched. This cannot be undone."
          : "This applies the supplier-confirmed changes: the Sales Order is re-derived and the current version is snapshotted into Revisions. This cannot be undone.",
      confirmLabel: amendmentLane ? "Approve & apply" : "Approve revision",
    }))) return;
    setBusy(true);
    try {
      const res = await approveSo.mutateAsync({ id: openAmendment.id }) as unknown as {
        poFollowUps?: Array<{ amendmentNo?: string; poNumber?: string }>;
      } | undefined;
      const fu = res?.poFollowUps ?? [];
      void notifyTop({
        title: amendmentLane ? "Amendment applied" : "SO revision approved",
        body: fu.length
          ? `Follow-up PO amendment${fu.length === 1 ? "" : "s"} raised: ${fu.map((f) => f.amendmentNo ?? "").join("; ")} — confirm in PO Amendments.`
          : undefined,
      });
    } catch (e) {
      void notifyTop({ title: "Could not approve the revision", body: e instanceof Error ? e.message : "Something went wrong.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  /* Approve-PO gate (SO_APPROVED -> PO_APPROVED) — the amendment's SECOND gate.
     Re-derives the bound PO(s) in place (same PO number, revision bumped, prior
     snapshotted into Revisions). Desktop drives this from the PO page; the mobile
     app has no PO editor, so the gate lives on this banner. The PO's line items
     are not loaded here, so a `received_floor` 409 names no specific line — the
     plain-language "raise a Purchase Return first" is still exact. Mirrors desktop
     PurchaseOrderDetail.handleApprovePo. */
  const handleApprovePo = async () => {
    if (!openAmendment || approvePo.isPending) return;
    if (!(await confirm({
      title: `Approve PO revision for ${docNo}?`,
      body: "This applies the supplier-confirmed changes to the bound Purchase Order: it is re-derived in place (same PO number, revision bumped) and the current version is snapshotted into Revisions. This cannot be undone.",
      confirmLabel: "Approve PO",
    }))) return;
    try {
      const res = await approvePo.mutateAsync({ id: openAmendment.id });
      const warns = res?.warnings ?? [];
      void notifyTop(
        warns.length
          ? { title: "PO revision approved — please check a few items", body: warns.join(" "), tone: "info" }
          : { title: "PO revision approved" },
      );
    } catch (e) {
      /* approve-po may 409 { code:'received_floor', revisedQty, receivedQty } —
         the revised qty is below what's already been received, so a Purchase
         Return must clear the excess first. Read the structured body off the
         thrown error (authed-fetch rides err.body) and render ONE plain sentence. */
      const body = (e as { body?: Record<string, unknown> }).body ?? null;
      if (body && body.code === "received_floor") {
        const revised = Number(body.revisedQty ?? 0);
        const received = Number(body.receivedQty ?? 0);
        void notifyTop({
          title: "Cannot approve — quantity already received",
          body: `One PO line would be revised down to ${revised}, but ${received} have already been received. `
            + "Raise a Purchase Return for the excess first, then approve the amendment again.",
          tone: "error",
        });
        return;
      }
      void notifyTop({ title: "Could not approve the PO", body: e instanceof Error ? e.message : "Something went wrong.", tone: "error" });
    }
  };

  /* Send gate (PO_APPROVED -> SENT) — marks the amendment SENT. There is no server
     email (Houzs mirrors 2990): the operator opens the bound PO on desktop to
     download the Revised PO and sends it to the supplier themselves. Mirrors
     desktop PurchaseOrderDetail.handleSendAmendment. */
  const handleSendAmendment = async () => {
    if (!openAmendment || sendAmendment.isPending) return;
    if (!(await confirm({
      title: `Mark amendment ${openAmendment.amendment_no || ""} as sent?`.trim(),
      body: "This marks the amendment SENT. There is no automatic email — open the bound PO on desktop to download the Revised PO and send it to the supplier yourself (print / WhatsApp).",
      confirmLabel: "Mark sent",
    }))) return;
    try {
      await sendAmendment.mutateAsync({ id: openAmendment.id });
      void notifyTop({ title: "Amendment marked sent" });
    } catch (e) {
      void notifyTop({ title: "Could not mark sent", body: e instanceof Error ? e.message : "Something went wrong.", tone: "error" });
    }
  };

  /* Owner rule 2026-07-05 (desktop parity, SalesOrderDetail.tsx): a PROCEEDED
     order that's past its processing date freezes its LINE ITEMS + State /
     Postcode (that's `editLocked` above, which feeds the Edit button), but
     PAYMENT must STAY addable. Desktop keeps this exact split — its
     PaymentsTable `locked` prop is `isLocked` (SHIPPED+ / downstream children)
     ONLY, deliberately NOT the processing lock. Mirror that here: payment is
     lock-gated only by the terminal / downstream statuses, never by the
     processing lock. Drafts + cancelled orders still take NO payment (owner:
     "no payments on drafts"), matching desktop hiding Add Payment off-status. */
  /* Owner 2026-07-17: "delivered了之後也要可以key payment" — and "電話電腦的權限
     應該一樣的", so this moves in lockstep with SalesOrderDetail's PaymentsTable.
     This was `isLocked` (LOCKED_STATUSES.includes(status) || hasChildren): a
     delivered SO is in that list AND has a DO, so its payments were frozen twice
     over. isLocked is the LINE/HEADER lock — those freeze because a DO/SI quotes
     them. Money is not a line, and collecting the balance ON delivery is the
     normal case. Only CANCELLED stays shut; payEditing still gates the rest. */
  const paymentLocked = rawStatus === "CANCELLED";

  /* No-naked-payment-edits (owner 2026-07-13) — Add / Delete / Edit must NOT
     show in the read-only detail without the operator opting in. The rule
     (desktop parity, SalesOrderDetail.tsx): payments are editable when the SO is
     a DRAFT (never confirmed — always adjustable) OR the operator has entered
     the payments Edit mode on this card. `payEditing` is that in-card toggle,
     offered on any submitted, non-CANCELLED SO — see paymentLocked: the
     SHIPPED+/has-children lock used to view-only the section here too, and that
     was the bug (owner 2026-07-17: "delivered了之後也要可以key payment"). The
     processing lock does NOT gate payments either (owner rule 2026-07-05). */
  const isDraftSo = ph === "draft";
  const [payEditing, setPayEditing] = useState(false);
  const canOfferPayEdit = ph === "submitted" && !paymentLocked;
  const canEditPayments = isDraftSo || (canOfferPayEdit && payEditing);
  const canAddPayment = canEditPayments;
  const [payOpen, setPayOpen] = useState(false);

  /* Collected By default = the logged-in user (owner option B). The detail
     header has no staff id for the viewer, so resolve it by matching the Houzs
     session email against the shared /staff list; '' when unmatched (dropdown
     falls back to "—"). Seeds NEW payment rows only. */
  const authEmail = houzsAuth.user?.email ?? null;
  const defaultCollectedBy =
    (authEmail
      ? (staffQ.data ?? []).find(
          (s) => s.email && s.email.toLowerCase() === authEmail.toLowerCase(),
        )?.id
      : "") ?? "";

  /* Refresh the header KPIs after a payment posts. Reused by both the delete
     action and the standalone Add-Payment sheet's onSaved.
     After a payment add/edit/delete the shared mutation already invalidates the
     payments ledger (['mfg-sales-orders', docNo, 'payments']) — the same key
     useSalesOrderPayments reads. The header KPIs (Paid / Balance) come from the
     DETAIL header, which the payment mutation does NOT touch, so refresh that
     one key here so the KPIs update live. */
  const refreshAfterPayment = () =>
    qc.invalidateQueries({ queryKey: ["mfg-sales-order-detail", docNo] });

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}><span className="chev">{"‹"}</span> Sales Orders</button>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {h && <button className="tinybtn" onClick={() => setMapOpen(true)} style={{ background: "#f4f6f3", border: "1px solid var(--line2)", color: "var(--ink)" }}>Map</button>}
            {h && <button className="tinybtn" onClick={print.openPreview} style={{ background: "#f4f6f3", border: "1px solid var(--line2)", color: "var(--ink)" }}>PDF</button>}
            {h && (
              <PrintPreviewModal
                open={print.open}
                onClose={print.close}
                docTitle="Sales Order"
                docNo={String(h.doc_no ?? "")}
                rows={[
                  { label: "Customer", value: String(h.debtor_name ?? "—") },
                  { label: "Items", value: `${items.length} line${items.length === 1 ? "" : "s"}` },
                ]}
                {...print.handlers}
              />
            )}
            {h && <StatusPill status={h.status} />}
          </div>
        </div>
        <div className="eyebrow" style={{ marginTop: 7, display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" }}>
          <span className="money" style={{ flex: "none" }}>{h?.doc_no ?? docNo}</span>
          {(h?.customer_so_no || h?.ref || h?.po_doc_no) && (<><span style={{ opacity: .5, flex: "none" }}>·</span><span className="money" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{h?.customer_so_no || h?.ref || h?.po_doc_no}</span></>)}
        </div>
        <div className="scr-title">{h?.debtor_name || "—"}</div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14 }}>
        {detail.isLoading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {[0, 1, 2].map((i) => (<div key={i} className="card"><div className="card-b ph" style={{ height: 70, borderRadius: 14 }} /></div>))}
          </div>
        )}
        {detail.error && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: "var(--red-bg)", border: "1px solid #e6cccc", borderRadius: 12, padding: "11px 13px" }}>
            <span style={{ fontSize: 12, color: "var(--red)", fontWeight: 600 }}>Couldn't load this order</span>
            <button onClick={() => detail.refetch()} style={{ border: "none", background: "transparent", color: "var(--red)", fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Retry</button>
          </div>
        )}

        {!detail.isLoading && !detail.error && h && (
          <div>
            {/* DRAFT banner — owner 2026-07-04: "根本不知道自己是在 Confirm 还是
                Draft". An unmissable amber card sits FIRST, directly under the
                header, whenever the SO is still a draft. Pairs with the amber
                Draft pill in the header (StatusPill below). */}
            {ph === "draft" && (
              <div role="status" style={{ display: "flex", alignItems: "flex-start", gap: 9, background: "var(--amber-bg, #f6efd9)", border: "1px solid #e0cf9e", borderRadius: 12, padding: "11px 13px", marginBottom: 12 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--amber, #8a6a2e)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /></svg>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--amber, #8a6a2e)" }}>Draft — not confirmed</div>
                  <div style={{ fontSize: 11.5, color: "#6d5626", marginTop: 2, lineHeight: 1.45 }}>This order is not confirmed yet. Review it and tap Create Sales Order to confirm.</div>
                </div>
              </div>
            )}

            {/* Locked-view hint (design VERBATIM) — Edit unlocks the same New SO
                form; there's no in-place edit here, so wording drops the mode.
                When the SO is genuinely edit-locked (SHIPPED+ / downstream DO-SI /
                past-processing proceeded order) the banner turns orange and names
                the reason, mirroring the desktop SO Detail lock banner — and the
                footer Edit button is disabled below. */}
            {editLocked ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(232,107,58,0.08)", border: "1px solid var(--c-orange, #e86b3a)", borderRadius: 10, padding: "9px 11px", marginBottom: 12, fontSize: 11, color: "#8a4a24" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c66a34" strokeWidth="2" strokeLinecap="round"><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
                {processingLocked
                  ? "Locked — the processing date has passed and this order was proceeded. Line items can't be edited."
                  : hasChildren
                  ? "Locked — a delivery order or invoice references this SO. Line items can't be edited."
                  : "Locked — this order has moved past editing. Line items can't be edited."}
              </div>
            ) : amendmentEligible ? (
              /* Amendment-eligible (desktop parity) — the SO is on order to the
                 supplier but still editable via the amendment flow. Edit stays
                 live; tapping it opens the same New SO form in amendment-raise
                 mode where Save submits an amendment request. */
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, background: "rgba(232,107,58,0.08)", border: "1px solid var(--c-orange, #e86b3a)", borderRadius: 10, padding: "9px 11px", marginBottom: 12, fontSize: 11, color: "#8a4a24", lineHeight: 1.45 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c66a34" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="m10.5 13-2.5 2.5 2.5 2.5" /><path d="m13.5 13 2.5 2.5-2.5 2.5" /></svg>
                {hasOpenAmendment
                  ? "On order to the supplier — an amendment is pending (see below). Line changes are locked until it's confirmed or rejected."
                  : "On order to the supplier. Tap Edit to request a line-item amendment — the coordinator and supplier confirm it before the order is revised."}
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#eef1ec", border: "1px solid #e3e6e0", borderRadius: 10, padding: "9px 11px", marginBottom: 12, fontSize: 11, color: "#5c6156" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#767b6e" strokeWidth="2" strokeLinecap="round"><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
                Locked view — tap Edit to change. Same form as New SO.
              </div>
            )}

            {/* ── Pending-amendment banner (Phase 1-C) ──────────────────────
                An amendment is in flight. Shows its no + status pill, a "View
                changes" link opening the before/after diff, and the gate actions
                the current user is permitted across BOTH gates — record supplier
                confirmation (REQUESTED) / approve SO revision (SUPPLIER_PENDING) /
                approve the bound PO (SO_APPROVED) / send to supplier (PO_APPROVED)
                — mirroring the desktop SalesOrderDetail + PurchaseOrderDetail
                amendment banners so mobile can finish + send the amendment. */}
            {hasOpenAmendment && openAmendment && (
              <div style={{ display: "flex", flexDirection: "column", gap: 9, background: "rgba(214,158,46,0.14)", border: "1px solid rgba(214,158,46,0.55)", borderRadius: 12, padding: "11px 13px", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8a6a2e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l4 2" /></svg>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: "#6d5626" }}>Amendment {openAmendment.amendment_no || "—"} pending</span>
                  <AmendmentStatusPill status={openAmendment.status} />
                  <button
                    type="button"
                    onClick={() => setViewingAmendmentId(openAmendment.id)}
                    style={{ marginLeft: "auto", border: "none", background: "transparent", padding: 0, cursor: "pointer", color: "#a25a2a", fontFamily: "inherit", fontSize: 12, fontWeight: 700, textDecoration: "underline" }}
                  >
                    View changes
                  </button>
                </div>
                {/* Two-lane rework — a lane row is ONE signature: approve at
                    REQUESTED applies the SO on the spot (LINES also raises the
                    follow-up PO Amendment for purchasing to confirm in PO
                    Amendments). The legacy multi-gate buttons below are
                    lane-null only. */}
                {amendmentLane != null && openAmendment.status === "REQUESTED" && canApproveLane && (
                  <button
                    type="button"
                    onClick={() => void handleApproveSo()}
                    disabled={busy}
                    className="money"
                    style={{ border: "1px solid #bcdcd7", background: "#e1efed", color: "#16695f", fontFamily: "inherit", fontSize: 12, fontWeight: 700, borderRadius: 9, padding: "9px 11px", cursor: "pointer", opacity: busy ? 0.5 : 1 }}
                  >
                    {busy ? "Working…" : amendmentLane === "LINES" ? "Approve product changes" : "Approve delivery changes"}
                  </button>
                )}
                {amendmentLane != null && openAmendment.status === "REQUESTED" && !canApproveLane && (
                  <div style={{ fontSize: 11.5, lineHeight: 1.45, color: "#6d5626" }}>
                    Waiting for {amendmentLane === "LINES" ? "Purchasing" : "Logistics"} — one signature applies it.
                  </div>
                )}
                {/* Gate actions — perm + status gated, exactly like desktop.
                    LEGACY (lane null) rows only. */}
                {amendmentLane == null && openAmendment.status === "REQUESTED" && canSupplierConfirm && (
                  <button
                    type="button"
                    onClick={() => setSupplierConfirmOpen(true)}
                    disabled={busy}
                    className="money"
                    style={{ border: "1px solid #bcdcd7", background: "#e1efed", color: "#16695f", fontFamily: "inherit", fontSize: 12, fontWeight: 700, borderRadius: 9, padding: "9px 11px", cursor: "pointer", opacity: busy ? 0.5 : 1 }}
                  >
                    Record supplier confirmation
                  </button>
                )}
                {amendmentLane == null && openAmendment.status === "SUPPLIER_PENDING" && canApproveSo && (
                  <button
                    type="button"
                    onClick={() => void handleApproveSo()}
                    disabled={busy}
                    className="money"
                    style={{ border: "1px solid #bcdcd7", background: "#e1efed", color: "#16695f", fontFamily: "inherit", fontSize: 12, fontWeight: 700, borderRadius: 9, padding: "9px 11px", cursor: "pointer", opacity: busy ? 0.5 : 1 }}
                  >
                    {busy ? "Working…" : "Approve SO revision"}
                  </button>
                )}
                {/* SO_APPROVED -> Approve PO (the amendment's SECOND gate). The SO
                    revision is live but the bound PO is NOT yet revised, so the
                    supplier is still building the OLD version until this runs
                    (safety warning, owner 2026-07-19). Desktop drives this from the
                    PO page; mobile has no PO editor, so the gate lives here. */}
                {amendmentLane == null && openAmendment.status === "SO_APPROVED" && (
                  <>
                    <div style={{ fontSize: 11.5, lineHeight: 1.45, color: "#6d5626", background: "rgba(214,158,46,0.12)", border: "1px solid rgba(214,158,46,0.4)", borderRadius: 9, padding: "8px 10px" }}>
                      The Sales Order is revised{boundPo?.po_number ? <> but <strong>{boundPo.po_number}</strong> is NOT</> : ", but its purchase order is NOT"} — the supplier is still working to the old version until the PO revision is approved too.
                    </div>
                    {canApprovePo && (
                      <button
                        type="button"
                        onClick={() => void handleApprovePo()}
                        disabled={approvePo.isPending}
                        className="money"
                        style={{ border: "1px solid #bcdcd7", background: "#e1efed", color: "#16695f", fontFamily: "inherit", fontSize: 12, fontWeight: 700, borderRadius: 9, padding: "9px 11px", cursor: "pointer", opacity: approvePo.isPending ? 0.5 : 1 }}
                      >
                        {approvePo.isPending ? "Approving…" : "Approve PO revision"}
                      </button>
                    )}
                  </>
                )}
                {/* PO_APPROVED -> Send. Marks the amendment SENT (no server email);
                    the Revised PO PDF is downloaded from the desktop PO screen — the
                    mobile app has no PO PDF generator. */}
                {amendmentLane == null && openAmendment.status === "PO_APPROVED" && (
                  <>
                    <div style={{ fontSize: 11.5, lineHeight: 1.45, color: "#6d5626" }}>
                      The PO is revised. Mark it sent, then open the bound PO on desktop to download the Revised PO for the supplier.
                    </div>
                    {canApprovePo && (
                      <button
                        type="button"
                        onClick={() => void handleSendAmendment()}
                        disabled={sendAmendment.isPending}
                        className="money"
                        style={{ border: "1px solid #bcdcd7", background: "#e1efed", color: "#16695f", fontFamily: "inherit", fontSize: 12, fontWeight: 700, borderRadius: 9, padding: "9px 11px", cursor: "pointer", opacity: sendAmendment.isPending ? 0.5 : 1 }}
                      >
                        {sendAmendment.isPending ? "Sending…" : "Send to supplier"}
                      </button>
                    )}
                  </>
                )}
                {/* Reject — an approver refusing (reason mandatory). Available at
                    every pre-approved gate, exactly as desktop AmendmentDetailV2. */}
                {canOfferReject && (
                  <button
                    type="button"
                    onClick={() => void handleReject()}
                    disabled={rejectAmendment.isPending}
                    className="money"
                    style={{ border: "1px solid #e0bcbc", background: "#f8eaea", color: "#b23a3a", fontFamily: "inherit", fontSize: 12, fontWeight: 700, borderRadius: 9, padding: "9px 11px", cursor: "pointer", opacity: rejectAmendment.isPending ? 0.5 : 1 }}
                  >
                    {rejectAmendment.isPending ? "Rejecting…" : "Reject amendment"}
                  </button>
                )}
                {/* Withdraw — the requester's own way out, so a mistaken request
                    can be closed instead of buried under a second one. */}
                {canOfferWithdraw && (
                  <button
                    type="button"
                    onClick={() => void handleWithdraw()}
                    disabled={withdrawAmendment.isPending}
                    style={{ border: "1px solid var(--line2)", background: "#fff", color: "var(--mut)", fontFamily: "inherit", fontSize: 12, fontWeight: 700, borderRadius: 9, padding: "9px 11px", cursor: "pointer", opacity: withdrawAmendment.isPending ? 0.5 : 1 }}
                  >
                    {withdrawAmendment.isPending ? "Withdrawing…" : "Withdraw this request"}
                  </button>
                )}
              </div>
            )}

            {/* KPI — Total / Paid / Balance. Colours VERBATIM from the design:
                Total + Paid both brand-dark (#0c3f39), Balance always red
                (#b23a3a). Overflow-hardened for 375px (owner 2026-07-04 "上面
                那一块都爆掉了"): flex 1 1 0 + minWidth 0 per card, tighter
                gap/padding, ellipsis-safe nowrap values, and the RM figure
                steps down a size once it passes 6 digits — see <Kpi/>. */}
            <div style={{ display: "flex", gap: 7, marginBottom: 12 }}>
              <Kpi label="Total" centi={total(h)} color="#0c3f39" />
              <Kpi label="Paid" centi={h.paid_sen_total} color="#0c3f39" />
              <Kpi label="Balance" centi={bal} color="#b23a3a" unknown={balanceUnknown} />
            </div>

            {/* Customer — locked .fld-ro fields (design layout VERBATIM) */}
            <div className="card"><div className="card-h"><span className="card-t">Customer</span></div><div className="card-b">
              <RoField label="Customer name" value={val(h.debtor_name)} />
              <div style={{ display: "flex", gap: 9 }}><div style={{ flex: 1, minWidth: 0 }}><RoField label="Phone" value={formatPhone(h.phone) || val(h.phone)} mono /></div><div style={{ flex: 1, minWidth: 0 }}><RoField label="Email" value={val(h.email)} /></div></div>
              <div style={{ display: "flex", gap: 9 }}><div style={{ flex: 1, minWidth: 0 }}><RoField label="Customer type" value={val(h.customer_type)} /></div><div style={{ flex: 1, minWidth: 0 }}><RoField label="Salesperson" value={val(salespersonName)} /></div></div>
              <RoField label="Customer SO ref" value={val(h.customer_so_no ?? h.ref)} mono />
              {/* Emergency contact — whole row HIDDEN when no phone on file
                  (Build Spec §6 + null-field rule: "hide the row"). Value =
                  "name · phone (relationship)" from the header's emergency_* cols. */}
              {(h.emergency_contact_phone ?? "").trim() ? (
                <RoField label="Emergency contact" value={composeEmergency(h)} />
              ) : null}
            </div></div>

            {/* Order info */}
            <div className="card"><div className="card-h"><span className="card-t">Order info</span></div><div className="card-b">
              <div style={{ display: "flex", gap: 9 }}><div style={{ flex: 1, minWidth: 0 }}><RoField label="Building type" value={val(h.building_type)} /></div><div style={{ flex: 1, minWidth: 0 }}><RoField label="Venue" value={val(h.venue ?? h.venue_id)} /></div></div>
              <div style={{ display: "flex", gap: 9 }}><div style={{ flex: 1, minWidth: 0 }}><RoField label="Processing Date" value={dl(h.processing_date)} mono /></div><div style={{ flex: 1, minWidth: 0 }}><RoField label="Delivery Date" value={dl(h.customer_delivery_date)} mono /></div></div>
              <RoField label="Sales location" value={val(h.sales_location ?? h.customer_state)} />
              {/* Note — a non-empty note is emphasised as an amber callout (desktop
                  SalesOrderDetailV2 parity), reusing THIS screen's own amber family
                  (the --amber-bg / --amber / #e0cf9e / #6d5626 tokens the Draft
                  banner above already uses) and the card's own field font sizes
                  (9px label / 12.5px value). An empty note keeps the plain field. */}
              {(h.note ?? "").trim() ? (
                <div style={{ marginTop: 2, border: "1px solid #e0cf9e", background: "var(--amber-bg, #f6efd9)", borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--amber, #8a6a2e)" }}>Note</div>
                  <p style={{ margin: "4px 0 0", fontSize: 12.5, lineHeight: 1.5, color: "#6d5626", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{h.note}</p>
                </div>
              ) : (
                <RoField label="Note" value="—" />
              )}
            </div></div>

            {/* Delivery address — the STRUCTURED parts the desktop SO form shows,
                each labelled (not one concatenated blob). Desktop mapping:
                address1/2 = free-text lines; City = city ?? address3; Postcode =
                postcode ?? address4; State = customer_state; Country =
                customer_country. Individually em-dashed when blank. */}
            <div className="card"><div className="card-h"><span className="card-t">Delivery address</span></div><div className="card-b">
              <RoField label="Address line 1" value={val(h.address1)} />
              <RoField label="Address line 2" value={val(h.address2)} />
              <div style={{ display: "flex", gap: 9 }}>
                <div style={{ flex: 1, minWidth: 0 }}><RoField label="City" value={val(h.city ?? h.address3)} /></div>
                <div style={{ flex: 1, minWidth: 0 }}><RoField label="Postcode" value={val(h.postcode ?? h.address4)} mono /></div>
              </div>
              <div style={{ display: "flex", gap: 9 }}>
                <div style={{ flex: 1, minWidth: 0 }}><RoField label="State" value={val(h.customer_state)} /></div>
                <div style={{ flex: 1, minWidth: 0 }}><RoField label="Country" value={val(h.customer_country)} /></div>
              </div>
            </div></div>

            {/* Line items — description / variants / SKU / ×qty / line total */}
            <div className="card"><div className="card-h"><span className="card-t">Line items</span><span className="card-sub">{items.length} {items.length === 1 ? "line" : "lines"}</span></div>
              {items.length ? items.map((it, i) => {
                /* SUPERSEDED, owner 2026-07-17 ("根據你的") — this row used to show
                   the item CODE INSTEAD of the name (owner 2026-07-04, "呈现 Code
                   即可"), because a long name 爆掉/被挤掉 at phone width. That
                   instruction fixed TRUNCATION, and #626 has since fixed
                   truncation properly: the name takes the row's full width and
                   WRAPS (overflowWrap) rather than being squeezed into one
                   ellipsised line. The problem the code-swap worked around is
                   gone, so the code-swap goes with it and this row reads the same
                   rule as every other surface (`orderLineIdentity`, the ONE home).
                   Do NOT re-swap the code back in without first checking that
                   wrapping actually failed — restoring it costs the readable name
                   AND the desktop parity, to fix a truncation that no longer
                   happens. The code still binds (dual-read camelCase ?? snake_case
                   feeds `orderLineIdentity`, and is the fallback for a codeless row). */
                const code = (((it as unknown as { itemCode?: string | null }).itemCode ?? it.item_code) ?? "").trim();
                /* Variant = the category-aware spec (sofa Fabric·config / bedframe
                   size·Headboard·Storage / mattress size·firmness·height) built
                   from the variants JSON, falling back to the server's stamped
                   description2 for older rows. It is the ONLY display of that spec
                   on the row, so `orderLineIdentity` keeps it as `secondary` and drops
                   only the redundant code. */
                const { primary, secondary } = orderLineIdentity({
                  code,
                  description: it.description,
                  variant: buildVariantSummary(it.item_group, it.variants) || (it.description2 ?? ""),
                });
                /* FOC + discount markers (desktop SalesOrderDetailV2 "Disc"
                   column). FOC = zero unit price AND zero line total; otherwise a
                   positive discount_sen renders under the unit price. Without
                   these the row hid the discount and an FOC line looked like a
                   plain "RM 0.00 ×qty". */
                const isFoc = (it.unit_price_sen ?? 0) === 0 && lineTotalSen(it) === 0;
                const discountSen = it.discount_sen ?? 0;
                return (
                <div key={it.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "11px 13px", borderTop: i ? "1px solid var(--line2)" : "none" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)", overflowWrap: "anywhere" }}>{primary || "—"}</div>
                    {secondary ? <div style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 2, overflowWrap: "anywhere" }}>{secondary}</div> : null}
                    {/* The line's REMARK — desktop parity (SalesOrderDetailV2's
                        Item column). Free text that appears nowhere else on the
                        row: a service line's whole job lives here ("Please take
                        back Cody Bedframe (King Size) 2 units"). Wraps, never
                        truncates — half an instruction is worse than none. */}
                    {(it.remark ?? "").trim() ? (
                      <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 3, fontStyle: "italic", whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.35 }}>
                        {it.remark!.trim()}
                      </div>
                    ) : null}
                    {/* UOM only — never the code (see the primary line above). */}
                    {(it.uom ?? "").trim() ? <div className="money" style={{ fontSize: 10, color: "var(--mut2)", marginTop: 3 }}>{it.uom!.trim()}</div> : null}
                    {/* Stock pill + source-PO trace (owner 2026-08-01) — the
                        mobile twin of the desktop Stock / Incoming PO columns,
                        off the SAME detail payload. Shipped batch trail →
                        STOCK ADJ → READY FIFO projection → incoming coverage. */}
                    {(() => {
                      const pill = soStockPillMobile(it);
                      return (
                        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 4 }}>
                          {pill && (
                            <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".4px", textTransform: "uppercase", color: pill.fg, background: pill.bg, border: `1px solid ${pill.bd}`, borderRadius: 5, padding: "1px 6px" }}>
                              {pill.label}
                            </span>
                          )}
                        </div>
                      );
                    })()}
                    <SourcePosRowMobile
                      pos={it.shipped_source_pos ?? []}
                      adj={it.shipped_source_adj}
                      ready={(it.delivered_qty ?? 0) > 0 && (it.remaining_qty ?? null) === 0 ? [] : (it.ready_source_pos ?? [])}
                      incoming={it.stock_state === "po" && it.coverage_po ? { po: it.coverage_po, eta: it.coverage_eta ? dl(it.coverage_eta) : null } : null}
                    />
                  </div>
                  <div style={{ textAlign: "right", whiteSpace: "nowrap", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                    <div className="money" style={{ fontSize: 13, fontWeight: 700, color: "#0c3f39" }}>RM {rm(lineTotalSen(it))}</div>
                    {/* Unit price × qty — the per-unit price was missing on mobile,
                        so a discounted / FOC line was indistinguishable from a
                        full-price one. */}
                    <div className="money" style={{ fontSize: 11, color: "var(--mut)" }}>RM {rm(it.unit_price_sen ?? 0)} {"×"}{it.qty ?? 0}</div>
                    {isFoc ? (
                      <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: ".3px", color: "#a16a2e", background: "#f6ecd9", border: "1px solid #e6d3ad", borderRadius: 5, padding: "1px 5px" }}>FOC</span>
                    ) : discountSen > 0 ? (
                      <div className="money" style={{ fontSize: 10.5, color: "#b23a3a" }}>Disc RM {rm(discountSen)}</div>
                    ) : null}
                  </div>
                </div>
                );
              }) : <div style={{ padding: "11px 13px", borderTop: "1px solid var(--line2)", fontSize: 11.5, color: "var(--mut2)" }}>No items.</div>}
            </div>

            {/* Photos — the scan-flow proof images (order slip + payment receipt),
                parity with desktop's ScannedImageCard pair. Owner 2026-07-04
                asked "which button shows the customer's photographed order slip":
                the card sits HIGH (right under Line items, above Payments) so the
                Order slip thumbnail is easy to find, and each thumb is
                tap-to-fullscreen. Keys dual-read camelCase ?? snake_case; the
                whole card is hidden only when the SO carries NEITHER key
                (hand-keyed orders). Served as authed blob fetches — the bearer
                can't ride on an <img src>. */}
            {(() => {
              const slipImageKey =
                (h as unknown as { slipImageKey?: string | null }).slipImageKey ?? h.slip_image_key ?? null;
              // Owner: the payment RECEIPT does NOT belong in this card -- it
              // lives on its payment row's slip (the camera icon there). This
              // card shows ONLY the customer's order slip.
              if (!slipImageKey) return null;
              return <ScannedPhotosCard slipKey={slipImageKey} receiptKey={null} />;
            })()}

            {/* Payments — read-only rows (method / date · account · collected_by /
                approval / amount), design layout. Recording a payment normally
                lives INSIDE Edit (MobileNewSO edit mode's PAYMENTS card), but a
                payment must STAY addable even when the SO is edit-locked (owner
                rule 2026-07-05 + desktop parity — see paymentLocked above). So a
                standalone "Add Payment" control sits on THIS card's header,
                gated by `canAddPayment` and NOT by the processing lock.
                That intent is older than this comment, but the code did not
                match it until 2026-07-17: paymentLocked was `isLocked`, so
                SHIPPED+/child-locked DID view-only the section — the exact case
                the sentence above says must stay addable. Owner, on hitting it:
                "delivered了之後也要可以key payment". Now only CANCELLED shuts it,
                which is also the per-row delete rule. */}
            <div className="card"><div className="card-h"><span className="card-t">Payments</span>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {!!payments.length && <span className="card-sub">{payments.length}</span>}
                {/* No-naked-edits toggle (owner 2026-07-13) — on a submitted SO the
                    payments stay view-only until the operator taps Edit here; a
                    DRAFT skips the toggle (always editable). Mirrors the desktop
                    Detail's Edit-mode gate on the PaymentsTable. */}
                {canOfferPayEdit && (
                  <button
                    type="button"
                    onClick={() => setPayEditing((v) => !v)}
                    style={{ border: "1px solid var(--line2)", background: payEditing ? "#eef1ec" : "#fff", color: "var(--mut)", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, borderRadius: 8, padding: "4px 10px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
                  >
                    {payEditing ? "Done" : "Edit"}
                  </button>
                )}
                {canAddPayment && (
                  <button
                    type="button"
                    onClick={() => setPayOpen(true)}
                    className="money"
                    style={{ border: "1px solid #bcdcd7", background: "#e1efed", color: "#16695f", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, borderRadius: 8, padding: "4px 10px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
                  >
                    <span style={{ fontSize: 13, lineHeight: 1 }}>+</span> Add Payment
                  </button>
                )}
              </span>
            </div>
              {paymentsQ.isLoading && <div style={{ padding: "11px 13px", borderTop: "1px solid var(--line2)", fontSize: 11.5, color: "var(--mut2)" }}>Loading{"…"}</div>}
              {!paymentsQ.isLoading && (
                <RecordedPaymentsList
                  docNo={docNo}
                  payments={payments as RecordedPayment[]}
                  staff={pickableStaffQ.data ?? []}
                  defaultCollectedBy={defaultCollectedBy}
                  canEdit={canEditPayments}
                  draftUnlocked={isDraftSo}
                  busy={busy}
                  onChanged={refreshAfterPayment}
                />
              )}
            </div>

            {/* History — owner requirement (Inistate-style audit timeline): WHO
                created / edited / changed status, WHEN, via WHICH app, with an
                expandable field-level old → new diff. Accordion follows the
                card pattern above; the audit-log fetch is LAZY — it only fires
                the first time the section is opened (mirrors desktop's
                historyOpen-mounted HistoryPanel). */}
            <HistoryCard docNo={docNo} />

            {/* Confirm-gate refusals arrive as a bullet-per-reason list
                (humanApiError renders validation_failed problems one per
                line) — pre-line keeps the list readable; a single-line error
                stays centered as before. */}
            {actionError && <div style={{ marginTop: 13, fontSize: 11.5, color: "var(--red)", whiteSpace: "pre-line", textAlign: actionError.includes("\n") ? "left" : "center" }}>{actionError}</div>}
          </div>
        )}
      </div>

      {/* Standalone ADD-Payment sheet (the card-header "+ Add Payment"). Editing
          an EXISTING row is owned by RecordedPaymentsList, which mounts the same
          sheet in edit mode — so the affordance exists wherever the ledger is
          rendered, including inside Edit Sales Order. Reachable even when the SO
          is edit-locked, because payment is never lock-gated (only
          status/downstream via canAddPayment). */}
      {payOpen && h && (
        <AddPaymentSheet
          docNo={docNo}
          staff={pickableStaffQ.data ?? []}
          defaultCollectedBy={defaultCollectedBy}
          onClose={() => setPayOpen(false)}
          onSaved={async () => {
            setPayOpen(false);
            await refreshAfterPayment();
          }}
        />
      )}

      {/* Supplier-confirmation sheet (Phase 1-C) — records the supplier's
          confirmation ref/note against the open amendment (REQUESTED →
          SUPPLIER_PENDING) via the vendored useSupplierConfirm mutation. */}
      {supplierConfirmOpen && openAmendment && (
        <SupplierConfirmSheet
          amendmentId={openAmendment.id}
          onClose={() => setSupplierConfirmOpen(false)}
          onDone={() => setSupplierConfirmOpen(false)}
        />
      )}

      {/* Before/after diff sheet (Phase 1-C) — reads the amendment detail
          (useAmendmentDetail) and renders each requested line change as
          old_snapshot → new_*, the SAME data as the desktop AmendmentDiffModal. */}
      {viewingAmendmentId && (
        <AmendmentDiffSheet
          amendmentId={viewingAmendmentId}
          onClose={() => setViewingAmendmentId(null)}
        />
      )}

      {!detail.isLoading && !detail.error && h && (
        <footer className="actbar">
          {/* No Add Payment in the FOOTER — the standalone Add-Payment entry
              lives on the Payments card header (see AddPaymentSheet above), so
              it stays reachable even when this footer's Edit button is locked.
              Adding a payment through Edit (MobileNewSO's PAYMENTS card) also
              still works when the SO is unlocked. */}
          {ph === "draft" && canWriteSo && (
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <div style={{ display: "flex", gap: 9 }}>
                <button className="btn-ghost" style={{ flex: 1, opacity: busy ? 0.55 : 1 }} disabled={busy} onClick={() => onEdit?.(docNo)}>Edit Draft</button>
                <button className="btn" style={{ flex: 1.3, opacity: busy ? 0.55 : 1 }} disabled={busy} onClick={() => setStatus("CONFIRMED")}>{busy ? "Working…" : "Create Sales Order"}</button>
              </div>
              {/* Discard draft — the escape hatch for a junk draft (esp. a bad
                  scan/OCR draft). Secondary red-outline so it never competes with
                  Create; behind the house confirm dialog. Backend refuses anything
                  but a DRAFT. */}
              <button
                type="button"
                className="btn-ghost"
                style={{ opacity: busy ? 0.55 : 1, color: "#b23a3a", borderColor: "#e0bcbc" }}
                disabled={busy}
                onClick={() => void handleDiscardDraft()}
              >
                Discard draft
              </button>
            </div>
          )}
          {ph === "submitted" && (
            <>
              <div style={{ display: "flex", gap: 9 }}>
                {/* Edit — locked once SHIPPED+ or a non-cancelled DO/SI references
                    this SO (has_children), matching the desktop's lockedStatuses. */}
                <button className="btn-ghost" style={{ flex: 1, opacity: busy || editLocked ? 0.4 : 1 }} disabled={busy || editLocked} onClick={() => onEdit?.(docNo)}>Edit</button>
                {/* Cancel — only on in-flight statuses (not SHIPPED+ / INVOICED /
                    CLOSED), matching the desktop's cancellableStatuses. */}
                {canCancel ? (
                  <button className="btn-danger" style={{ flex: 1, opacity: busy ? 0.55 : 1 }} disabled={busy} onClick={() => setStatus("CANCELLED", `Cancel ${docNo}? This voids the order.`)}>{busy ? "Working…" : "Cancel Order"}</button>
                ) : (
                  <div style={{ flex: 1, textAlign: "center", fontSize: 11, color: "var(--mut2)", alignSelf: "center" }}>Locked — downstream documents exist.</div>
                )}
              </div>
            </>
          )}
          {ph === "cancelled" && (
            <div style={{ textAlign: "center", fontSize: 11.5, color: "var(--mut2)", padding: 4 }}>This order was cancelled.</div>
          )}
        </footer>
      )}

      {/* Relationship Map (mobile) — the SO anchor's stacked twin of the
          desktop SO map. See the mapOpen comment at the top of the component
          for the deliberate no-coverage-fetch rule. */}
      {mapOpen && (
        <MobileRelationshipMap
          type="so"
          id={docNo}
          label={h?.doc_no ?? docNo}
          onClose={() => setMapOpen(false)}
          nav={flowNav}
        />
      )}

    </div>
  );
}

/* KPI stat card — one third of the Total / Paid / Balance strip. Sized to fit
   three-up at 375px: flex 1 1 0 (equal thirds regardless of content width) +
   minWidth 0 so a long RM figure can't blow the row open; the value line is
   nowrap + ellipsis as the final safety net. `.money` supplies tabular-nums.
   The figure renders at 13.5px and steps down to 12px once the amount passes
   6 digits (>= RM 10,000.00); the "RM" prefix rides smaller so the digits keep
   the room. Visual style (card / .fld-l label / weights / colours) unchanged
   from the design. */
/* `unknown` is NOT the same as a null `centi`. fmtAmt deliberately renders null
   as "0.00" (see lib/scm.ts — six mobile screens depend on that), which is the
   right call for a figure the ERP genuinely holds as zero and the WRONG one for
   a figure it failed to read. A card that could not be computed says so. */
function Kpi({ label, centi, color, unknown }: { label: string; centi: number | null | undefined; color: string; unknown?: boolean }) {
  const v = unknown ? "—" : rm(centi);
  const big = v.replace(/\D/g, "").length > 6;
  return (
    <div className="card" style={{ flex: "1 1 0", minWidth: 0, marginBottom: 0 }}>
      <div className="card-b" style={{ padding: "9px 9px" }}>
        <div className="fld-l" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
        <div className="money" style={{ fontSize: big ? 12 : 13.5, fontWeight: 800, color, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {/* No "RM" in front of an em-dash — "RM —" reads as a broken amount
              rather than an absent one. */}
          {unknown ? null : <span style={{ fontSize: big ? 9 : 10, fontWeight: 700, opacity: 0.75, marginRight: 3 }}>RM</span>}{v}
        </div>
      </div>
    </div>
  );
}

/* Locked read-only field — the design's `.fld` + `.fld-l` + `.fld-ro` trio, the
   detail screen's whole "form rendered locked" idiom. `mono` opts the value into
   tabular-nums (phone / doc refs / dates) via the shared `.money` class. */
function RoField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="fld">
      <span className="fld-l">{label}</span>
      <div className={`fld-ro${mono ? " money" : ""}`}>{value}</div>
    </div>
  );
}

/* Emergency contact — "name · phone (relationship)" from the header's
   emergency_* columns. Only rendered when a phone exists (caller-gated), so a
   blank name still shows the phone; relationship is appended in parens if set. */
function composeEmergency(h: SoHeader): string {
  const name = (h.emergency_contact_name ?? "").trim();
  const phone = formatPhone(h.emergency_contact_phone);
  const rel = (h.emergency_contact_relationship ?? "").trim();
  const head = [name, phone].filter((x) => x.length).join(" · ");
  return rel ? `${head} (${rel})` : head || "—";
}

/* Line total — prefer the persisted total_sen; fall back to unit_price × qty
   for older rows that never stamped it. */
const lineTotalSen = (it: SoItem): number =>
  it.total_sen ?? Math.round((it.unit_price_sen ?? 0) * (it.qty ?? 0));

/* ── Scanned photos card (mobile port of desktop's ScannedImageCard pair) ────
   Order slip (slip_image_key, mig 0033) + payment receipt (receipt_image_key,
   mig 0034) as tappable thumbnails; tap opens a full-size overlay (tap again to
   dismiss). The images are served by GET /scan-so/slip-image?key=… which needs
   the bearer, so each thumb authed-fetches the blob (fetchScanSlipImageBlobUrl)
   and renders the object URL — revoked when the thumb unmounts, so the overlay
   (which shows while the thumb stays mounted) always has a live URL. */
function ScannedPhotosCard({ slipKey, receiptKey }: { slipKey: string | null; receiptKey: string | null }) {
  const [viewer, setViewer] = useState<{ src: string; label: string } | null>(null);
  return (
    <>
      {/* Owner 2026-07-04 — "which button shows the customer's photographed order
          slip?": the card is titled "Order slip photo" (the thing he's looking
          for), sits high in the page, and each thumb is tap-to-open-fullscreen.
          A one-line hint spells out the interaction so it's unmistakable. */}
      <div className="card"><div className="card-h"><span className="card-t">Order slip photo</span><span className="card-sub">Tap to enlarge</span></div>
        <div className="card-b" style={{ paddingTop: 4 }}>
          <div style={{ fontSize: 11, color: "var(--mut)", marginBottom: 9, lineHeight: 1.4 }}>
            The customer's photographed slip{receiptKey ? " and payment receipt" : ""} this order was scanned from. Tap a photo to view it full-screen.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: slipKey && receiptKey ? "1fr 1fr" : "1fr", gap: 9 }}>
            {slipKey ? <ScannedThumb imageKey={slipKey} label="Order slip" onView={(src, label) => setViewer({ src, label })} /> : null}
            {receiptKey ? <ScannedThumb imageKey={receiptKey} label="Payment receipt" onView={(src, label) => setViewer({ src, label })} /> : null}
          </div>
        </div>
      </div>
      {viewer && (
        <div
          onClick={() => setViewer(null)}
          role="dialog"
          aria-label={viewer.label}
          style={{ position: "fixed", inset: 0, zIndex: 2600, background: "rgba(0,0,0,0.84)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16 }}
        >
          <img src={viewer.src} alt={viewer.label} style={{ maxWidth: "100%", maxHeight: "84vh", borderRadius: 10, objectFit: "contain", background: "#fff" }} />
          <div style={{ marginTop: 12, fontSize: 12, fontWeight: 700, color: "#fff", opacity: 0.85 }}>{viewer.label} · tap anywhere to close</div>
        </div>
      )}
    </>
  );
}

/* One authed thumbnail — fetches the scan image as a blob, shows a skeleton
   while loading and a plain-language line when the fetch fails. */
function ScannedThumb({ imageKey, label, onView }: { imageKey: string; label: string; onView: (src: string, label: string) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setSrc(null);
    setFailed(false);
    fetchScanSlipImageBlobUrl(imageKey)
      .then((u) => {
        if (cancelled) { URL.revokeObjectURL(u); return; }
        url = u;
        setSrc(u);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [imageKey]);

  return (
    <button
      type="button"
      onClick={() => { if (src) onView(src, label); }}
      aria-label={`View ${label} photo`}
      style={{ border: "1px solid var(--line2, #e3e6e0)", background: "#f4f6f3", borderRadius: 12, padding: 0, overflow: "hidden", cursor: src ? "pointer" : "default", fontFamily: "inherit", textAlign: "center" }}
    >
      {failed ? (
        <div style={{ height: 96, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 8px", fontSize: 10.5, color: "var(--mut2)", lineHeight: 1.4 }}>Couldn't load this photo.</div>
      ) : src ? (
        <img src={src} alt={label} style={{ width: "100%", height: 96, objectFit: "cover", display: "block" }} />
      ) : (
        <div className="ph" style={{ height: 96 }} />
      )}
      <div style={{ padding: "6px 4px", fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "#9aa093" }}>{label}</div>
    </button>
  );
}

/* ── History timeline (owner requirement — Inistate-style audit trail) ──────
   Reads GET /mfg-sales-orders/:docNo/audit-log (mfg_so_audit_log) via the SAME
   vendored hook desktop's HistoryPanel uses. Lazy: the hook receives null until
   the accordion opens, so `enabled: Boolean(docNo)` keeps the request unfired.
   Entries arrive newest-first from the backend. */

/* Human labels for the audit `field` keys — subset of desktop's FIELD_LABEL
   plus the payment / amendment / automation keys the mobile timeline surfaces. */
const HIST_FIELD_LABEL: Record<string, string> = {
  debtorName: "Customer", debtorCode: "Customer code", agent: "Agent",
  phone: "Phone", email: "Email", soDate: "SO date", status: "Status",
  paymentMethod: "Payment method", depositSen: "Deposit",
  processingDate: "Processing Date", customerSoNo: "Customer SO ref",
  customerPo: "Customer PO", customerDeliveryDate: "Delivery Date",
  amendedDeliveryDate: "Amended delivery date",
  amendDateFromCustomer: "Amend date (customer)", amendReason: "Amend reason",
  deliveryState: "Delivery region", possessionDate: "Possession date",
  houseType: "House type", replacementDisposal: "Replacement / disposal",
  referral: "Referral", city: "City", postcode: "Postcode",
  buildingType: "Building type", address1: "Address 1", address2: "Address 2",
  address3: "Address 3", address4: "Address 4", note: "Note", remark: "Remark",
  itemCode: "Item", itemGroup: "Group", description: "Description",
  description2: "Description 2", uom: "UOM", qty: "Qty",
  unitPriceSen: "Unit price", discountSen: "Discount",
  unitCostSen: "Unit cost", totalSen: "Line total", lineCount: "Lines",
  localTotalSen: "Total", amountSen: "Amount", paidAt: "Paid on",
  method: "Method", merchantProvider: "Bank", installmentMonths: "Installment months",
  onlineType: "Online type", approvalCode: "Approval code",
  stockStatus: "Stock status", salespersonId: "Salesperson",
  customerType: "Customer type", venue: "Venue", venueId: "Venue (master)",
  salesLocation: "Sales location", customerState: "State", cancelled: "Cancelled",
  photoAdded: "Photo added", photoRemoved: "Photo removed",
  tbcVariants: "Variants updated", sofaBuild: "Sofa build",
  pwpCode: "PWP code", pwpRewardsReverted: "PWP rewards reverted",
  pwpCodesDeleted: "PWP codes deleted", photosCleaned: "Photos removed",
};
const HIST_MONEY_FIELDS = new Set([
  "unitPriceSen", "discountSen", "totalSen", "depositSen",
  "localTotalSen", "unitCostSen", "amountSen",
]);
const histVal = (field: string, v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  if ((HIST_MONEY_FIELDS.has(field) || /Sen$/.test(field)) && typeof v === "number") return `RM ${rm(v)}`;
  // An object field-change (variants / sofa build) must never dump raw JSON at
  // the user: summarise a list by its count, any other object as "updated".
  if (typeof v === "object") {
    return Array.isArray(v) ? `${v.length} item${v.length === 1 ? "" : "s"}` : "updated";
  }
  return String(v).replace(/_/g, " ");
};
/* Timestamp — desktop-standard numeric DD/MM/YYYY + HH:mm. */
const histWhen = (iso: string): string => {
  const d = new Date(iso);
  if (isNaN(+d)) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const histHue = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
};
const histInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0] ?? "";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? "";
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase();
};
/* Action → plain sentence ("<actor> <sentence>"), pulling the headline value
   (status pair / amount / item code) out of the entry's field_changes. */
const histSentence = (e: SoAuditEntry): string => {
  const fc: SoAuditFieldChange[] = Array.isArray(e.field_changes) ? e.field_changes : [];
  const find = (f: string) => fc.find((c) => c.field === f);
  switch (e.action) {
    case "CREATE":
      return e.status_snapshot === "DRAFT" ? "created this order (draft)" : "created this order";
    case "UPDATE_DETAILS":
      return "updated details";
    case "UPDATE_STATUS": {
      const s = find("status");
      const to = statusLabel("so", (s?.to ?? e.status_snapshot ?? "?") as string);
      return s?.from
        ? `changed status ${statusLabel("so", String(s.from))} → ${to}`
        : `changed status to ${to}`;
    }
    case "ADD_PAYMENT": {
      const a = find("amountSen");
      return typeof a?.to === "number" ? `added payment RM ${rm(a.to)}` : "added a payment";
    }
    case "UPDATE_PAYMENT": {
      const a = find("amountSen");
      return typeof a?.to === "number" ? `edited payment (RM ${rm(a.to)})` : "edited a payment";
    }
    case "DELETE_PAYMENT": {
      const a = find("amountSen");
      return typeof a?.from === "number" ? `removed payment RM ${rm(a.from)}` : "removed a payment";
    }
    case "ADD_LINE": {
      const cd = find("itemCode");
      return cd?.to ? `added line ${String(cd.to)}` : "added a line";
    }
    case "UPDATE_LINE": {
      const cd = find("itemCode");
      const code = cd?.to ?? cd?.from;
      return code ? `edited line ${String(code)}` : "edited a line";
    }
    case "DELETE_LINE": {
      const cd = find("itemCode");
      return cd?.from ? `removed line ${String(cd.from)}` : "removed a line";
    }
    default:
      return e.action.replace(/_/g, " ").toLowerCase();
  }
};

function HistoryCard({ docNo }: { docNo: string }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /* Lazy load — hook gets null until first open, so nothing is fetched for the
     common "just glancing at the order" visit (mirrors desktop historyOpen). */
  const q = useSalesOrderAuditLog(open ? docNo : null);
  const entries = q.data ?? [];

  return (
    <div className="card">
      <div
        className="card-h"
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
        style={{ cursor: "pointer", userSelect: "none" }}
        aria-expanded={open}
      >
        <span className="card-t">History</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {open && !q.isLoading && !q.error && <span className="card-sub">{entries.length}</span>}
          <span style={{ fontSize: 12, color: "var(--mut)", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s", display: "inline-block" }}>{"›"}</span>
        </span>
      </div>
      {open && (
        <>
          {q.isLoading && <div style={{ padding: "11px 13px", borderTop: "1px solid var(--line2)", fontSize: 11.5, color: "var(--mut2)" }}>Loading{"…"}</div>}
          {!!q.error && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "11px 13px", borderTop: "1px solid var(--line2)" }}>
              <span style={{ fontSize: 11.5, color: "var(--red)", fontWeight: 600 }}>Couldn't load the history</span>
              <button onClick={() => q.refetch()} style={{ border: "none", background: "transparent", color: "var(--red)", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>Retry</button>
            </div>
          )}
          {!q.isLoading && !q.error && (entries.length ? entries.map((e) => {
            const name = e.actor_name_snapshot ?? "(unknown)";
            const fc: SoAuditFieldChange[] = Array.isArray(e.field_changes) ? e.field_changes : [];
            const isX = !!expanded[e.id];
            return (
              <div key={e.id} style={{ display: "flex", gap: 9, padding: "10px 13px", borderTop: "1px solid var(--line2)", alignItems: "flex-start" }}>
                <span aria-hidden style={{ width: 24, height: 24, minWidth: 24, borderRadius: "50%", background: `hsl(${histHue(name)}, 45%, 55%)`, color: "#fff", fontSize: 9.5, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>
                  {histInitials(name)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: "var(--ink)", lineHeight: 1.35 }}>
                    <span style={{ fontWeight: 700 }}>{name}</span>{" "}{histSentence(e)}
                  </div>
                  <div className="money" style={{ fontSize: 10.5, color: "var(--mut)", marginTop: 2 }}>
                    {histWhen(e.created_at)}{e.source ? ` · via ${e.source}` : ""}
                  </div>
                  {e.note ? <div style={{ fontSize: 10.5, color: "var(--mut2)", marginTop: 2, fontStyle: "italic" }}>{e.note}</div> : null}
                  {fc.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={() => setExpanded((s) => ({ ...s, [e.id]: !s[e.id] }))}
                        style={{ border: "none", background: "transparent", padding: 0, marginTop: 4, fontFamily: "inherit", fontSize: 11, fontWeight: 700, color: "var(--teal)", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
                      >
                        <span style={{ transform: isX ? "rotate(90deg)" : "none", transition: "transform .15s", display: "inline-block", fontSize: 10 }}>{"›"}</span>
                        Changes ({fc.length})
                      </button>
                      {isX && (
                        <div style={{ marginTop: 5, background: "#f4f6f3", border: "1px solid #e3e6e0", borderRadius: 8, padding: "7px 9px", display: "flex", flexDirection: "column", gap: 4 }}>
                          {fc.map((ch, idx) => (
                            <div key={idx} style={{ fontSize: 11, lineHeight: 1.4, color: "var(--ink)", wordBreak: "break-word" }}>
                              <span style={{ fontWeight: 700, color: "var(--mut)" }}>{HIST_FIELD_LABEL[ch.field] ?? ch.field}:</span>{" "}
                              {ch.from !== undefined && ch.from !== null && ch.from !== "" ? (
                                <>
                                  <span style={{ color: "#b23a3a", textDecoration: "line-through" }}>{histVal(ch.field, ch.from)}</span>
                                  <span style={{ color: "var(--mut2)" }}>{" → "}</span>
                                </>
                              ) : null}
                              <span style={{ color: "#0c3f39", fontWeight: 600 }}>{histVal(ch.field, ch.to)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          }) : <div style={{ padding: "11px 13px", borderTop: "1px solid var(--line2)", fontSize: 11.5, color: "var(--mut2)" }}>No history yet.</div>)}
        </>
      )}
    </div>
  );
}

/* soPill — from the design's status→color map (Submitted [#e1efed,#0c3f39] ·
   Cancelled [#f8eaea,#b23a3a]), EXCEPT Draft: owner 2026-07-04 couldn't tell
   Draft from Confirmed, so Draft upgraded from the design's grey to the shared
   amber "pending" badge (+ border) so it reads unmistakably as unconfirmed. */
function StatusPill({ status }: { status: string | null }) {
  const p = phase(status);
  const cls = p === "draft" ? "b-amber" : p === "cancelled" ? "b-red" : "b-brand";
  const label = p === "draft" ? "Draft" : p === "cancelled" ? "Cancelled" : "Submitted";
  return <span className={`badge ${cls}`} style={p === "draft" ? { border: "1px solid #e0cf9e" } : undefined}>{label}</span>;
}

/* ── Amendment status pill ───────────────────────────────────────────────────
   The SO-amendment state machine (backend so-amendments.ts):
   REQUESTED → SUPPLIER_PENDING → SO_APPROVED → PO_APPROVED → SENT (or REJECTED).
   Plain-language labels; amber/teal/red tones by phase. */
const AMENDMENT_STATUS_LABEL: Record<string, string> = {
  REQUESTED: "Requested",
  SUPPLIER_PENDING: "Supplier pending",
  SO_APPROVED: "SO approved",
  PO_APPROVED: "PO approved",
  SENT: "Sent",
  REJECTED: "Rejected",
};
function AmendmentStatusPill({ status }: { status: string }) {
  const s = (status ?? "").toUpperCase();
  const label = AMENDMENT_STATUS_LABEL[s] ?? (s ? s.replace(/_/g, " ").toLowerCase() : "—");
  const tone =
    s === "REJECTED"
      ? { bg: "#f8eaea", fg: "#b23a3a" }
      : s === "SO_APPROVED" || s === "PO_APPROVED" || s === "SENT"
      ? { bg: "#e1efed", fg: "#0c3f39" }
      : { bg: "#f6efd9", fg: "#8a6a2e" };
  return (
    <span className="money" style={{ display: "inline-block", fontSize: 10, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", padding: "2px 7px", borderRadius: 999, background: tone.bg, color: tone.fg }}>
      {label}
    </span>
  );
}

/* changeType → plain label (desktop AmendmentDiffModal parity). */
const amendmentChangeLabel = (t: string): string =>
  t === "SPEC" ? "Spec change" :
  t === "QTY" ? "Quantity change" :
  t === "ADD" ? "Added line" :
  t === "REMOVE" ? "Removed line" : t;

/* ── Supplier-confirmation sheet ─────────────────────────────────────────────
   Records the supplier's confirmation reference (+ optional note / attachment
   key) against the open amendment via the vendored useSupplierConfirm mutation
   (REQUESTED → SUPPLIER_PENDING). Mobile .hz-m bottom sheet; mirrors the desktop
   SupplierConfirmForm fields. The server 403/409 is the real gate (humanised by
   authed-fetch). */
function SupplierConfirmSheet({
  amendmentId,
  onClose,
  onDone,
}: {
  amendmentId: string;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const supplierConfirm = useSupplierConfirm();
  const notify = useNotify();
  const [ref, setRef] = useState("");
  const [note, setNote] = useState("");
  const [attachmentKey, setAttachmentKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    if (!ref.trim()) { setError("Enter the supplier's confirmation reference."); return; }
    setError(null);
    setBusy(true);
    try {
      await supplierConfirm.mutateAsync({
        id: amendmentId,
        ref: ref.trim(),
        note: note.trim() || undefined,
        attachmentKey: attachmentKey.trim() || undefined,
      });
      void notify({ title: "Supplier confirmation recorded" });
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't record the confirmation. Please try again.");
      setBusy(false);
    }
  };

  return (
    <div className="hz-m sheet-bd" onClick={() => { if (!busy) onClose(); }}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="sheet-head">
          <div>
            <div className="card-t" style={{ fontSize: 15 }}>Record supplier confirmation</div>
            <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 2 }}>The supplier confirmed the amended order</div>
          </div>
          <button type="button" className="sheet-x" onClick={() => { if (!busy) onClose(); }} aria-label="Close">{"✕"}</button>
        </div>
        <div className="sheet-scroll">
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <label className="fld">
              <span className="fld-l">Supplier confirmation ref *</span>
              <input className="fld-i" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. supplier WhatsApp / email ref" />
            </label>
            <label className="fld">
              <span className="fld-l">Attachment key (optional)</span>
              <input className="fld-i" value={attachmentKey} onChange={(e) => setAttachmentKey(e.target.value)} placeholder="R2 object key, if any" />
            </label>
            <label className="fld">
              <span className="fld-l">Note (optional)</span>
              <input className="fld-i" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything the supplier flagged" />
            </label>
            {error && <div style={{ fontSize: 11.5, color: "var(--red)", textAlign: "center" }}>{error}</div>}
          </div>
        </div>
        <div className="sheet-foot">
          <button type="button" className="btn-ghost" style={{ flex: 1, opacity: busy ? 0.55 : 1 }} disabled={busy} onClick={() => onClose()}>Cancel</button>
          <button type="button" className="btn" style={{ flex: 1.3, opacity: busy || !ref.trim() ? 0.5 : 1 }} disabled={busy || !ref.trim()} onClick={() => void submit()}>{busy ? "Recording…" : "Record confirmation"}</button>
        </div>
      </div>
    </div>
  );
}

/* ── Amendment diff sheet ────────────────────────────────────────────────────
   Reads the amendment detail (useAmendmentDetail) and renders each requested
   line change as a Before → After pair — the SAME data as the desktop
   AmendmentDiffModal (old_snapshot vs new_item_code / new_variants / new_qty /
   new_unit_price_sen), laid out mobile-first as stacked cards. */
/* Owner 2026-07-16 — the moved field is struck on the Was side and emphasised on
   the Requesting side, so the ask is visible without reading both columns
   character-by-character. Desktop does the same on its table + job card. */
const mStrikeIf = (changed: boolean): CSSProperties =>
  changed ? { textDecoration: "line-through", opacity: 0.7 } : {};
const mEmphIf = (changed: boolean): CSSProperties =>
  changed ? { fontWeight: 800, color: "var(--ink)" } : {};

/* Per-row department routing chips (mobile idiom). Advisory accountability — it
   never gates the single-signature apply. Mirror of the desktop RowRoutingChips. */
function AmRoutingChips({ kinds }: { kinds: AmendmentFieldKind[] }) {
  if (kinds.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "6px 11px 0" }}>
      {kinds.map((k) => (
        <span
          key={k}
          style={{
            display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10,
            padding: "1px 5px", borderRadius: 4, border: "1px solid var(--line2, #e3e6e0)",
            background: "#f4f6f3", color: "var(--mut)",
          }}
        >
          <span style={{ color: "var(--ink)", fontWeight: 600 }}>{FIELD_KIND_LABEL[k]}</span>
          <span aria-hidden>&rarr;</span>
          <span style={{ fontWeight: 700, color: "var(--brand, #2b6a4a)" }}>{routeField(k).department}</span>
        </span>
      ))}
    </div>
  );
}

/* Amendment TYPE badge(s) — Processing vs Delivery / Commercial, Mixed when both. */
function AmTypeBadges({ kinds }: { kinds: AmendmentFieldKind[] }) {
  const { types, isMixed } = summariseRouting(kinds);
  if (types.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
      {isMixed && (
        <span style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", padding: "1px 6px", borderRadius: 4, background: "var(--line2, #e3e6e0)", color: "var(--mut)" }}>
          Mixed
        </span>
      )}
      {types.map((t) => (
        <span key={t} style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", padding: "1px 6px", borderRadius: 4, background: "#e7efe9", color: "var(--brand, #2b6a4a)" }}>
          {TYPE_LABEL[t]}
        </span>
      ))}
    </div>
  );
}

function AmendmentDiffSheet({ amendmentId, onClose }: { amendmentId: string; onClose: () => void }) {
  const { data, isLoading, error } = useAmendmentDetail(amendmentId);
  /* Approve / reject decision trail (owner 2026-07-18) — read the SO audit log
     and keep only THIS amendment's AMENDMENT_* rows (created_at floor). The only
     source that carries a rejection's actor / time / reason. Same shared builder
     desktop uses; one logic layer. */
  const soDocNo = typeof data?.amendment?.so_doc_no === "string" ? data.amendment.so_doc_no : null;
  const audit = useSalesOrderAuditLog(soDocNo);
  const decisions = buildAmendmentDecisionHistory(
    audit.data,
    typeof data?.amendment?.created_at === "string" ? data.amendment.created_at : null,
  );
  /* Only the lines that actually request something — a recorded line whose new_*
     equals its own old_snapshot is not a change and must not render as one
     (Owner 2026-07-16). Same shared filter as desktop; one logic layer. */
  const allLines = (data?.lines ?? []) as AmendmentLine[];
  const lines = visibleAmendmentLines(allLines);
  const oldOf = amendmentOldSnapshot;
  const amNo = data?.amendment?.amendment_no != null ? String(data.amendment.amendment_no) : "";
  const reason = typeof data?.amendment?.reason === "string" ? data.amendment.reason : "";
  /* The HEADER half of the request (mig 0119) — Delivery / Processing Date,
     State, Postcode. Same shared builder the desktop job card uses, so a
     header-only amendment isn't invisible here either. `dl` is the shared
     TZ-aware date formatter (see its definition — delegates to lib/utils
     formatDate, which formats a bare YYYY-MM-DD verbatim). */
  const headerDiffs = amendmentHeaderDiffRows(
    data?.amendment?.header_changes as SoAmendmentHeaderChanges | null | undefined,
    data?.amendment?.old_header_snapshot as SoAmendmentHeaderChanges | null | undefined,
    dl,
  );

  /* Every routable atom this amendment moves — lines + header — for the type
     badge(s). Mirror of the desktop job card. */
  const allFieldKinds: AmendmentFieldKind[] = [
    ...lines.flatMap((l) => amendmentLineFieldKinds(l)),
    ...headerDiffs.map((d) => soHeaderFieldKind(d.key) as AmendmentFieldKind),
  ];

  /* Print amendment — reuse the shared jsPDF template + soAmendmentToPdfInput,
     EXACTLY as desktop AmendmentDetailV2 and MobilePoAmendmentDetail. Status
     label collapses the multi-gate backend states to the SIMPLIFIED
     Requested / Approved on the document (SO revision is live from SO_APPROVED
     on). All lines are handed to the mapper (it filters no-op rows itself). */
  const notify = useNotify();
  const { actorNameOf } = useStaffLookup();
  const amd = data?.amendment as Record<string, unknown> | undefined;
  const amdStatus = String(amd?.status ?? "");
  const deliverAmendmentPdf = (action: PdfAction) => {
    if (!amd) return;
    const input = soAmendmentToPdfInput({
      amendment: {
        amendment_no: amNo || null,
        status: amdStatus,
        reason: reason || null,
        created_at: typeof amd.created_at === "string" ? amd.created_at : null,
        requested_by_name: actorNameOf(typeof amd.requested_by === "string" ? amd.requested_by : null),
        so_approved_by_name: amd.so_approved_by ? actorNameOf(String(amd.so_approved_by)) : null,
        so_approved_at: typeof amd.so_approved_at === "string" ? amd.so_approved_at : null,
      },
      lines: (data?.lines ?? []) as never,
      salesOrder: (data?.salesOrder ?? null) as never,
      customerName: (data?.salesOrder as { customer_name?: string | null } | null)?.customer_name ?? null,
    });
    return Promise.resolve(generateAmendmentPdf(input, { action })).catch((e: unknown) =>
      void notify({ title: "PDF generation failed", body: e instanceof Error ? e.message : "Something went wrong.", tone: "error" }));
  };
  const amendmentPrint = usePrintPreview(deliverAmendmentPdf);

  return (
    <div className="hz-m sheet-bd" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="sheet-head">
          <div>
            <div className="card-t" style={{ fontSize: 15 }}>Requested changes{amNo ? ` — ${amNo}` : ""}</div>
            <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 2 }}>Was → requesting</div>
            <AmTypeBadges kinds={allFieldKinds} />
          </div>
          <button type="button" className="sheet-x" onClick={onClose} aria-label="Close">{"✕"}</button>
        </div>
        <div className="sheet-scroll">
          {isLoading ? (
            <div style={{ fontSize: 11.5, color: "var(--mut2)", padding: "8px 0" }}>Loading changes{"…"}</div>
          ) : error ? (
            <div style={{ fontSize: 11.5, color: "var(--red)", padding: "8px 0" }}>{error instanceof Error ? error.message : "Couldn't load the changes."}</div>
          ) : lines.length === 0 && headerDiffs.length === 0 ? (
            /* "Nothing recorded" vs "every recorded line is a no-op" — the
               latter is a legacy amendment raised before the header half existed
               (mig 0119); its real ask only survives in the Reason below. */
            <div style={{ fontSize: 11.5, color: "var(--mut2)", padding: "8px 0", lineHeight: 1.45 }}>
              {allLines.length > 0
                ? "No line changes recorded — every line matches the order exactly. This request predates order-detail tracking, so what was asked for is in the Reason below."
                : "This amendment has no changes recorded."}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {/* Order details (dates / delivery location) first, then the lines. */}
              {headerDiffs.map((d) => (
                <div key={d.key} style={{ border: "1px solid var(--line2, #e3e6e0)", borderRadius: 11, overflow: "hidden" }}>
                  <div style={{ padding: "7px 11px", background: "#f4f6f3", fontSize: 10.5, fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase", color: "#5c6156" }}>{d.label}</div>
                  <AmRoutingChips kinds={[soHeaderFieldKind(d.key) as AmendmentFieldKind]} />
                  <div style={{ display: "flex", gap: 0 }}>
                    <div style={{ flex: 1, minWidth: 0, padding: "9px 11px", borderRight: "1px solid var(--line2, #e3e6e0)" }}>
                      <div className="fld-l" style={{ marginBottom: 3 }}>Was</div>
                      <div style={{ fontSize: 12.5, color: "var(--mut)" }}>{d.from}</div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0, padding: "9px 11px" }}>
                      <div className="fld-l" style={{ marginBottom: 3 }}>Requesting</div>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>{d.to}</div>
                    </div>
                  </div>
                </div>
              ))}
              {lines.map((l) => {
                const old = oldOf(l);
                const newSummary = amendmentVariantSummaries(l).to;
                /* Emphasise the field that actually moved — Was / Requesting
                   were two plain columns you had to diff by eye. */
                const chg = amendmentLineChangedFields(l);
                /* Axes this line carries that the summaries above cannot show. A
                   non-empty set means the spec strings are INCOMPLETE, and a short
                   Requesting string is exactly what reads as "the amendment dropped
                   my divan height" on a screen you can APPROVE from. Say it out loud
                   (mirror desktop DiffCard) instead of showing a shorter string. */
                const unrendered = amendmentUnrenderedAxes(l);
                const unrenderedAll = [...new Set([...unrendered.from, ...unrendered.to])];
                return (
                  <div key={l.id} style={{ border: "1px solid var(--line2, #e3e6e0)", borderRadius: 11, overflow: "hidden" }}>
                    <div style={{ padding: "7px 11px", background: "#f4f6f3", fontSize: 10.5, fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase", color: "#5c6156" }}>{amendmentChangeLabel(l.change_type)}</div>
                    <AmRoutingChips kinds={amendmentLineFieldKinds(l)} />
                    <div style={{ display: "flex", gap: 0 }}>
                      {/* Before */}
                      <div style={{ flex: 1, minWidth: 0, padding: "9px 11px", borderRight: "1px solid var(--line2, #e3e6e0)" }}>
                        <div className="fld-l" style={{ marginBottom: 3 }}>Was</div>
                        {l.change_type === "ADD" ? (
                          <div style={{ fontSize: 11.5, color: "var(--mut2)" }}>—</div>
                        ) : (
                          <>
                            <div className="money" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)", ...mStrikeIf(chg.itemCode) }}>{old.itemCode ?? "—"}</div>
                            <div className="money" style={{ fontSize: 11, color: "var(--mut)", marginTop: 2 }}>
                              <span style={mStrikeIf(chg.qty)}>Qty {old.qty ?? "—"}</span>
                              {typeof old.unitPriceSen === "number" ? (
                                <>{" · "}<span style={mStrikeIf(chg.unitPrice)}>RM {rm(old.unitPriceSen)}</span></>
                              ) : ""}
                            </div>
                            {old.description2 ? <div style={{ fontSize: 10.5, color: "var(--mut2)", marginTop: 2, ...mStrikeIf(chg.variants) }}>{old.description2}</div> : null}
                            {/* mig 0280 — the remark this request replaces (only
                                when the request touches it). Desktop parity. */}
                            {chg.remark && (old.remark ?? "").trim() ? (
                              <div style={{ fontSize: 10.5, color: "var(--mut2)", marginTop: 2, fontStyle: "italic", ...mStrikeIf(true) }}>{"“"}{old.remark}{"”"}</div>
                            ) : null}
                          </>
                        )}
                      </div>
                      {/* After */}
                      <div style={{ flex: 1, minWidth: 0, padding: "9px 11px" }}>
                        <div className="fld-l" style={{ marginBottom: 3 }}>Requesting</div>
                        {l.change_type === "REMOVE" ? (
                          <div style={{ fontSize: 11.5, color: "#b23a3a", fontWeight: 600 }}>Removed</div>
                        ) : (
                          <>
                            <div className="money" style={{ fontSize: 12.5, fontWeight: 700, color: "#0c3f39", ...mEmphIf(chg.itemCode) }}>{l.new_item_code ?? old.itemCode ?? "—"}</div>
                            <div className="money" style={{ fontSize: 11, color: "var(--mut)", marginTop: 2 }}>
                              <span style={mEmphIf(chg.qty)}>Qty {l.new_qty ?? old.qty ?? "—"}</span>
                              {typeof l.new_unit_price_sen === "number" ? (
                                <>{" · "}<span style={mEmphIf(chg.unitPrice)}>RM {rm(l.new_unit_price_sen)}</span></>
                              ) : ""}
                            </div>
                            {newSummary ? <div style={{ fontSize: 10.5, color: "var(--mut2)", marginTop: 2, ...mEmphIf(chg.variants) }}>{newSummary}</div> : null}
                            {/* mig 0280 — the REQUESTED remark: on a service line
                                it is the whole request, so it renders here too. */}
                            {chg.remark ? (
                              <div style={{ fontSize: 10.5, color: "var(--mut2)", marginTop: 2, fontStyle: "italic", ...mEmphIf(true) }}>
                                {(l.new_remark ?? "").trim() ? `“${l.new_remark}”` : "Remark cleared"}
                              </div>
                            ) : null}
                            {/* mig 0317 — a fee line's discount IS the request. */}
                            {chg.discount ? <div className="money" style={{ fontSize: 10.5, marginTop: 2, ...mEmphIf(true) }}>{Math.round(l.new_discount_sen ?? 0) > 0 ? `Discount RM ${rm(l.new_discount_sen ?? 0)}` : "Discount cleared"}</div> : null}
                          </>
                        )}
                      </div>
                    </div>
                    {unrenderedAll.length > 0 && (
                      <div style={{ borderTop: "1px solid var(--line2, #e3e6e0)", background: "rgba(214,158,46,0.12)", padding: "7px 11px", fontSize: 10.5, lineHeight: 1.4, color: "#6d5626" }}>
                        This line also carries {unrenderedAll.join(", ")}, which the summary above cannot display. Open the Sales Order to check the full specification before approving.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {reason ? (
            <div style={{ marginTop: 11, fontSize: 11.5, color: "var(--mut)", lineHeight: 1.45 }}>
              <span style={{ fontWeight: 700 }}>Reason:</span> {reason}
            </div>
          ) : null}

          {/* Approve / reject history (owner 2026-07-18) — WHO approved or
              rejected, WHEN, and the reason. Newest first. */}
          <div style={{ marginTop: 14, borderTop: "1px solid var(--line2, #e3e6e0)", paddingTop: 12 }}>
            <div className="fld-l" style={{ marginBottom: 8 }}>Approval history</div>
            {audit.isLoading ? (
              <div style={{ fontSize: 11.5, color: "var(--mut2)" }}>Loading history{"…"}</div>
            ) : audit.error ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "var(--red)" }}>
                <span>Couldn't load the history.</span>
                <button type="button" onClick={() => audit.refetch()} style={{ border: "none", background: "transparent", color: "var(--red)", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0 }}>Retry</button>
              </div>
            ) : decisions.length === 0 ? (
              <div style={{ fontSize: 11.5, color: "var(--mut2)" }}>No decisions recorded yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {decisions.map((d) => {
                  const rej = isRejectDecision(d.action);
                  return (
                    <div key={d.id} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                      <span aria-hidden style={{ width: 8, height: 8, minWidth: 8, borderRadius: "50%", marginTop: 4, background: rej ? "#b23a3a" : "#0c3f39" }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: rej ? "#b23a3a" : "var(--ink)", lineHeight: 1.35 }}>{d.label}</div>
                        <div className="money" style={{ fontSize: 10.5, color: "var(--mut)", marginTop: 1 }}>
                          {histWhen(d.at)}{d.actor ? ` · ${d.actor}` : ""}
                        </div>
                        {d.note ? <div style={{ fontSize: 10.5, color: "var(--mut2)", marginTop: 2, fontStyle: "italic", lineHeight: 1.4 }}>{d.note}</div> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="sheet-foot">
          <button type="button" className="btn" style={{ flex: 1 }} onClick={amendmentPrint.openPreview} disabled={isLoading || !amd}>Print amendment</button>
          <PrintPreviewModal
            open={amendmentPrint.open}
            onClose={amendmentPrint.close}
            docTitle="Sales Order Amendment"
            docNo={amNo || "Amendment"}
            rows={[
              { label: "Against SO", value: soDocNo || "—" },
              { label: "Status", value: amendmentPrintedStatus(amdStatus) },
              { label: "Reason", value: reason || "—" },
              {
                label: "Changes",
                value: `${lines.length + headerDiffs.length} change${
                  lines.length + headerDiffs.length === 1 ? "" : "s"
                }`,
              },
            ]}
            {...amendmentPrint.handlers}
          />
          <button type="button" className="btn" style={{ flex: 1 }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

