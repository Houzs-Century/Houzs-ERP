import { ViewOriginalScan } from "../vendor/scm/components/ViewOriginalScan";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { formatDate } from "../lib/utils";
import { NoProcessingDateNoteMobile, NonSellingWarehouseNoteMobile, SourcePosRowMobile, soStockPillMobile } from "./source-chips";
import { MobileRelationshipMap } from "./MobileRelationshipMap";
import { ADD_LINE_LABEL } from "../vendor/scm/lib/add-line-handoff";
import type { FlowNav } from "./relationship-map-model";
import { fmtAmt } from "../lib/scm";
import { useQueryClient } from "@tanstack/react-query"; import { itDetailOf } from "../vendor/scm/lib/authed-fetch";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog"; import { passesSoffioReminder } from "../vendor/scm/lib/soffio-reminder";
import { useNotify } from "../vendor/scm/components/NotifyDialog"; import { notifySaveProblems } from "../vendor/scm/components/SaveProblemsList"; import { MobileSoDoDraftButton } from "./MobileSoDoDraftButton";
import { usePrompt } from "../vendor/scm/components/PromptDialog"; import { CancelRequestPanel } from "../vendor/scm/components/CancelRequestPanel"; import { useCancelRequestAction } from "../pages/scm-v2/use-cancel-request-action"; import { WrongApproverFlagButton } from "../pages/scm-v2/WrongApproverFlagButton";
import { fetchScanSlipImageBlobUrl } from "../vendor/scm/lib/slip"; import { fairLabel } from "../vendor/scm/lib/fair-options-queries"; import { fairElsewhereLine, type LinkedFair } from "../components/fairPick";
import { MobileLinePhotos } from "./MobileLinePhotos";
import { useStaff, usePickableStaff } from "../vendor/scm/lib/admin-queries";
import { SoSharedWith } from "../vendor/scm/components/SoSharedWith";
import { HIST_FIELD_LABEL, HIST_MONEY_FIELDS } from "./so-history-labels";
import { isStoredPhotoKey } from "../components/audit/audit-value";
import { statusLabel } from "../vendor/scm/lib/status-pill";
import { AMENDMENT_APPROVER_LABEL, soAmendmentApprover, SO_AMENDMENT_LANE_APPROVE_PERM } from "../vendor/scm/lib/amendment-approver";
import { useAuth as useHouzsAuth } from "../auth/AuthContext";
import { ACCESS_RANK } from "../types";
import {
  useMfgSalesOrderDetail,
  useSoLineCoverage,
  useSalesOrderPayments,
  useUpdateMfgSalesOrderStatus,
  useDeleteMfgSalesOrder,
  useSalesOrderAuditLog,
  type SoAuditEntry,
  type SoAuditFieldChange,
} from "../vendor/scm/lib/sales-order-queries";
import { overlaySoLineCoverage } from "../vendor/scm/lib/so-coverage-overlay";
import { buildVariantSummary } from "../vendor/shared/variant-summary";
import { formatPhone } from "../vendor/shared/phone";
import { fmtDateTime } from "../vendor/shared/format";
import { orderLineIdentity } from "@2990s/shared"; import { soEditOpensOnOverride } from "../vendor/scm/lib/so-after-do-client";
import {
  CANCELLABLE_STATUSES,
  isLocked as isSoLocked, soDownstreamHardLocked,
  procLockActive as soProcLockActive,
  amendmentEligible as soAmendmentEligible, migratedReadonly as soMigratedReadonly, migratedReadonlyReason as soMigratedReason,
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
import { generateAmendmentPdf } from "../vendor/scm/lib/amendment-pdf";
import { PrintPreviewModal, usePrintPreview } from "../components/scm-v2/PrintPreviewModal";
import type { PdfAction } from "../vendor/scm/lib/pdf-common";
import { amendmentPrintedStatus, soAmendmentToPdfInput } from "../vendor/scm/lib/amendment-pdf-map";
import { useStaffLookup } from "../hooks/useStaffLookup";
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
import { OrderMoneyPanel } from "../vendor/scm/components/OrderMoneyPanel"; import type { MobileConvertPrefill } from "./MobileOrderMoney"; // money on a cancelled order (docs/bugs/0933)
import { owesPaymentReason } from "../vendor/scm/lib/payment-reason";
import { MobileLineRemark } from "./MobileLineRemark";
import { MobileSoDeliveryIssues } from "./DeliveryIssueForm";
import "./mobile.css";

import { isFocLine } from '../vendor/scm/lib/foc-line';
import { soConfirmDateNote } from '../lib/soConfirmDateNote';
import { addressLineTwoView } from '../vendor/shared/address-two-lines';
type SoHeader = {
  doc_no: string;
  debtor_name: string | null;
  status: string | null;
  phone: string | null;
  email: string | null;
  customer_type: string | null;
  salesperson_id: string | number | null;
  collaborator_staff_ids: string[] | null;
  sales_location: string | null;
  customer_state: string | null;
  customer_country: string | null;
  ref: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  building_type: string | null;
  venue: string | null;
  venue_id: string | null;
  fair?: LinkedFair | null; fair_date?: string | null;
  note: string | null;
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
  has_children: boolean | null; downstream_fully_frozen?: boolean | null;
  delivery_state: string | null;
  amendment_eligible: boolean | null;
  /* Owner 2026-08-12 — a live PO already claims one of this SO's lines (2990
     only). Feeds soProcLockActive (line ~390), so the phone freezes the same
     fields the desktop does with no processing date involved. */
  po_locked: boolean | null;
  has_open_amendment: boolean | null;
  open_amendment: { id: string; status: string; amendment_no: string; lane?: string | null } | null;
  slip_image_key: string | null;
  receipt_image_key: string | null;
};
type SoItem = {
  id: string;
  description: string | null;
  item_group: string | null;
  variants: Record<string, unknown> | null;
  description2: string | null;
  item_code: string | null;
  uom: string | null;
  qty: number | null;
  unit_price_sen: number | null;
  discount_sen: number | null;
  total_sen: number | null;
  line_delivery_date: string | null;
  /* Per-line stock + source-PO trace (owner 2026-08-01) — stamped by the SAME
     GET /mfg-sales-orders/:docNo the desktop reads. Mobile renders the stock
     pill + source chips so the phone answers "which PO are these goods from"
     exactly like the desktop (one-product rule). */
  stock_status?: string | null;
  stock_state?: "stock" | "po" | "shortage" | null;
  coverage_po?: string | null; coverage_eta?: string | null;
  bound_source_pos?: string[];
  bound_source_po_etas?: Record<string, string>;
  shipped_source_pos?: string[];
  shipped_source_adj?: boolean;
  ready_source_pos?: Array<{ po: string | null; qty: number; kind: "po" | "adjustment" }>;
  delivered_qty?: number | null; remaining_qty?: number | null;
  non_selling_warehouse?: { code: string | null; name: string | null; type: string | null; notice: string } | null; awaiting_processing_date?: boolean;
  cancelled?: boolean | null;
  remark?: string | null;
  photo_urls?: string[] | null;
  photoUrls?: string[] | null;
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
  created_at: string | null;
};

const rm = fmtAmt;
const dl = (d: string | null | undefined) => formatDate(d);
const val = (v: string | null | undefined) => {
  const s = (v ?? "").toString().trim();
  return s.length ? s : "—";
};
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
export function MobileSODetail({ docNo, onBack, onEdit, onAddLine, flowNav, onConvert }: { docNo: string; onBack: () => void; onEdit?: (docNo: string) => void; onAddLine: ((docNo: string) => void) | null;
  flowNav?: FlowNav;
  /** Convert on a cancelled order's money panel: open New SO with this seed (docs/bugs/0933). */
  onConvert?: (seed: MobileConvertPrefill) => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const notifyTop = useNotify();
  const askPrompt = usePrompt();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [viewingAmendmentId, setViewingAmendmentId] = useState<string | null>(null);
  const [supplierConfirmOpen, setSupplierConfirmOpen] = useState(false);
  const approveSo = useApproveSo();
  const approvePo = useApprovePo();
  const sendAmendment = useSendAmendment();
  const rejectAmendment = useRejectAmendment();
  const withdrawAmendment = useWithdrawAmendment();
  const updateStatus = useUpdateMfgSalesOrderStatus(); const requestCancel = useCancelRequestAction("so"); // cancel = request + two approvals (owner 2026-09-08)
  const deleteDraft = useDeleteMfgSalesOrder();

  const detail = useMfgSalesOrderDetail(docNo);
  /* The live Stock / Incoming PO / READY-source fields are NOT in GET /:docNo
     (it returns coverage_po null since docs/bugs/0592); they come from this
     second call, overlaid below with the SAME function the desktop uses. The
     phone never made the call, so its line card could not show the incoming
     purchase order at all (found tracing staff issues #18/#19, 2026-09-14). */
  const coverage = useSoLineCoverage(docNo);
  const paymentsQ = useSalesOrderPayments(docNo);

  const staffQ = useStaff();
  const pickableStaffQ = usePickableStaff({ onlySales: true });
  const houzsAuth = useHouzsAuth();
  const h = detail.data?.salesOrder as SoHeader | undefined;
  const items = useMemo(
    () => overlaySoLineCoverage(((detail.data?.items ?? []) as SoItem[]).filter((l) => !l.cancelled), coverage.data?.coverage),
    [detail.data, coverage.data],
  );
  const paymentsKnown = paymentsQ.error === null && Array.isArray(paymentsQ.data);
  const payments = (paymentsKnown ? paymentsQ.data! : []) as SoPayment[];
  const deliverPdf = async (action: PdfAction) => {
    if (!h) return;
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

  const salespersonName = h?.salesperson_id != null
    ? (staffQ.data ?? []).find((s) => String(s.id) === String(h.salesperson_id))?.name ?? null
    : null;
  /* Who else may see and edit it. Null on an unshared order, which is most of
     them; granting and withdrawing live on SO Maintenance, desktop-only
     (docs/modules/so-handover.md §8). */

  const setStatus = async (status: string, confirmMsg?: string) => {
    if (busy) return;
    if (confirmMsg && !(await confirm({ title: confirmMsg, confirmLabel: "Confirm", danger: true }))) return;
    setActionError(null);
    setBusy(true);
    try {
      await updateStatus.mutateAsync({ docNo, status, expectedStatus: h?.status ?? null });
    } catch (e) {
      await notifySaveProblems(notifyTop, e, setActionError, "Something went wrong. Please try again.");
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
  const balanceUnknown =
    h != null && h.balance_sen == null && h.paid_sen_total == null && !paymentsKnown;
  const bal = h && !balanceUnknown ? deriveBalance(h, payments) : null;

  /* Parity with desktop SO Detail / list gating — the primitives now come from
     the SHARED vendor/scm/lib/so-detail-gates module so a fix lands once for
     both platforms (statuses are upper-cased inside the gate).
     - Cancel is offered only on in-flight statuses (CONFIRMED / IN_PRODUCTION /
       READY_TO_SHIP), never once SHIPPED+ / INVOICED / CLOSED — those carry
       downstream docs (CANCELLABLE_STATUSES).
     - isLocked = SHIPPED+ terminal status OR every line is on a live DO/SI
       (soDownstreamHardLocked, owner 2026-09-15). Mirrors SalesOrderDetail.isLocked. */
  const rawStatus = (h?.status ?? "").toUpperCase();
  const hasChildren = soDownstreamHardLocked(h);
  const migratedLocked = soMigratedReadonly(h), canCancel = !migratedLocked && CANCELLABLE_STATUSES.includes(rawStatus);
  const isLocked = migratedLocked || isSoLocked(h?.status, hasChildren);

  /* Processing LOCK — the shared procLockActive: once the SO has a Processing
     Date AND that day has passed (compared against todayMyt() — the Malaysia
     calendar day, NOT the device's local day) the line items are historical.
     Having a Processing Date IS being proceeded (owner, pinned 2026-08-13);
     there is no separate stamp to consult. Here we surface a banner and treat the SO as
     edit-locked so the detail never offers line-item edits on a proceeded,
     past-processing order. */
  const processingLocked = h ? soProcLockActive(h) : false;

  const amendmentEligible = h ? soAmendmentEligible(h, isLocked) : false;
  const openAmendment = h?.open_amendment ?? null;
  const hasOpenAmendment = Boolean(h?.has_open_amendment) && openAmendment != null;

  const hardLocked = isLocked || (processingLocked && !amendmentEligible);
  const editLocked = hardLocked && !(h && soEditOpensOnOverride(h, { can: houzsAuth.can, migrated: migratedLocked }));

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
     control. Whether the caller raised it comes from the SERVER
     (viewerIsRequester on the shared amendment detail — useAmendmentDetail,
     same query key the diff sheet warms): the browser has no scm.staff id to
     compare requested_by against, so a local compare was always false. */
  const openAmendmentDetail = useAmendmentDetail(hasOpenAmendment && openAmendment ? openAmendment.id : null);
  const amendmentStatus = (openAmendment?.status ?? "").toUpperCase();
  const isAmendmentRequester = openAmendmentDetail.data?.viewerIsRequester === true;
  const amendmentLane =
    openAmendment?.lane === "LINES" || openAmendment?.lane === "DELIVERY" || openAmendment?.lane === "PRICE" || openAmendment?.lane === "LINE_ADDREMOVE"
      ? openAmendment.lane : null;
  const canApproveLane =
    amendmentLane != null
    && houzsAuth.can(SO_AMENDMENT_LANE_APPROVE_PERM[amendmentLane]);
  const canRejectAmendment = amendmentLane
    ? canApproveLane
    : houzsAuth.can("scm.amendment.approve_po");
  const canApprovePo = houzsAuth.can("scm.amendment.approve_po");
  const boundPo =
    (openAmendmentDetail.data?.purchaseOrders?.[0] as { id: string; po_number: string; status: string } | undefined) ?? null;
  const canOfferReject = amendmentLane
    ? amendmentStatus === "REQUESTED" && canRejectAmendment
    : (amendmentStatus === "REQUESTED" || amendmentStatus === "SUPPLIER_PENDING") && canRejectAmendment;
  const canOfferWithdraw =
    amendmentStatus === "REQUESTED" && (isAmendmentRequester || canRejectAmendment);

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
    if (reason == null) return;
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
    if (reason == null) return;
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

  const handleApproveSo = async () => {
    if (!openAmendment || busy) return;
    if (!(await confirm({
      title: `Approve ${amendmentLane ? "amendment" : "SO revision"} for ${docNo}?`,
      body: amendmentLane === "LINES"
        ? "Check with the supplier BEFORE approving — your signature records the change is workable. The Sales Order is revised at once and a follow-up PO Amendment is raised for you to confirm in PO Amendments. This cannot be undone."
        : amendmentLane === "LINE_ADDREMOVE"
          ? "Adding or cancelling a product line changes what the customer ordered. The Sales Order is revised at once and a follow-up PO Amendment is raised for the purchaser to confirm the supplier side. This cannot be undone."
        : amendmentLane === "DELIVERY" || amendmentLane === "PRICE"
          ? `This applies the ${amendmentLane === "PRICE" ? "price change" : "delivery changes"} to the Sales Order at once (the current version is snapshotted into Revisions). The purchase order is not touched. This cannot be undone.`
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
      void notifyTop({ title: "Could not approve the revision", body: e instanceof Error ? `${e.message}${itDetailOf(e)}` : "Something went wrong.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

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
  const canOfferPayEdit = !migratedLocked && ph === "submitted" && !paymentLocked;
  const canEditPayments = !migratedLocked && (isDraftSo || (canOfferPayEdit && payEditing));
  const canAddPayment = canEditPayments;
  const [payOpen, setPayOpen] = useState(false);

  const authEmail = houzsAuth.user?.email ?? null;
  const defaultCollectedBy =
    (authEmail
      ? (staffQ.data ?? []).find(
          (s) => s.email && s.email.toLowerCase() === authEmail.toLowerCase(),
        )?.id
      : "") ?? "";

  const refreshAfterPayment = () =>
    qc.invalidateQueries({ queryKey: ["mfg-sales-order-detail", docNo] });

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}><span className="chev">{"‹"}</span> Sales Orders</button>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {h && <button className="tinybtn" onClick={() => setMapOpen(true)} style={{ background: "var(--hz-c-surface-2)", border: "1px solid var(--line2)", color: "var(--ink)" }}>Map</button>}
            {h && <button className="tinybtn" onClick={print.openPreview} style={{ background: "var(--hz-c-surface-2)", border: "1px solid var(--line2)", color: "var(--ink)" }}>PDF</button>}
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
          {h?.doc_no && <ViewOriginalScan kind="so" documentId={h.doc_no} />}
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
              <div role="status" style={{ display: "flex", alignItems: "flex-start", gap: 9, background: "var(--amber-bg, var(--hz-c-warning-bg))", border: "1px solid #e0cf9e", borderRadius: 12, padding: "11px 13px", marginBottom: 12 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--amber, #8a6a2e)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /></svg>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--amber, #8a6a2e)" }}>Draft — not confirmed</div>
                  <div style={{ fontSize: 11.5, color: "#6d5626", marginTop: 2, lineHeight: 1.45 }}>This order is not confirmed yet. Review it and tap Create Sales Order to confirm.</div>
                </div>
              </div>
            )}

            {hardLocked ? (
              <div data-testid={migratedLocked ? "so-migrated-readonly-banner" : "so-locked-banner"} style={{ display: "flex", alignItems: "flex-start", gap: 8, background: "rgba(232,107,58,0.08)", border: "1px solid var(--c-orange, #e86b3a)", borderRadius: 10, padding: "9px 11px", marginBottom: 12, fontSize: 11, color: "#8a4a24", lineHeight: 1.45 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c66a34" strokeWidth="2" strokeLinecap="round"><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
                {migratedLocked ? soMigratedReason(h)
                  : processingLocked ? "Locked — the processing date has passed and this order was proceeded. Line items can't be edited."
                  : hasChildren
                  ? "Locked — every line is already on a delivery order or invoice. Line items can't be edited."
                  : "Locked — this order has moved past editing. Line items can't be edited."}
              </div>
            ) : amendmentEligible ? (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, background: "rgba(232,107,58,0.08)", border: "1px solid var(--c-orange, #e86b3a)", borderRadius: 10, padding: "9px 11px", marginBottom: 12, fontSize: 11, color: "#8a4a24", lineHeight: 1.45 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c66a34" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="m10.5 13-2.5 2.5 2.5 2.5" /><path d="m13.5 13 2.5 2.5-2.5 2.5" /></svg>
                {hasOpenAmendment
                  ? "On order to the supplier — an amendment is pending (see below). Line changes are locked until it's confirmed or rejected."
                  : "On order to the supplier. Tap Edit to request a line-item amendment — the coordinator and supplier confirm it before the order is revised."}
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--hz-dk-surface-2, #eef1ec)", border: "1px solid var(--hz-c-border-subtle)", borderRadius: 10, padding: "9px 11px", marginBottom: 12, fontSize: 11, color: "#5c6156" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#767b6e" strokeWidth="2" strokeLinecap="round"><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
                Locked view — tap Edit to change. Same form as New SO.
              </div>
            )}

            <CancelRequestPanel compact docType="so" docKey={docNo} docNumber={docNo} onExecute={() => setStatus("CANCELLED")} executing={busy} />
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
                {amendmentLane != null && openAmendment.status === "REQUESTED" && canApproveLane && (
                  <button
                    type="button"
                    onClick={() => void handleApproveSo()}
                    disabled={busy}
                    className="money"
                    style={{ border: "1px solid var(--hz-dk-primary-line, #bcdcd7)", background: "var(--hz-c-primary-soft)", color: "var(--hz-c-primary)", fontFamily: "inherit", fontSize: 12, fontWeight: 700, borderRadius: 9, padding: "9px 11px", cursor: "pointer", opacity: busy ? 0.5 : 1 }}
                  >
                    {busy ? "Working…" : amendmentLane === "LINES" ? "Approve product changes" : amendmentLane === "LINE_ADDREMOVE" ? "Approve add / cancel line" : amendmentLane === "PRICE" ? "Approve price change" : "Approve delivery changes"}
                  </button>
                )}
                {amendmentLane != null && openAmendment.status === "REQUESTED" && !canApproveLane && (
                  <div style={{ fontSize: 11.5, lineHeight: 1.45, color: "#6d5626" }}>
                    Waiting for {AMENDMENT_APPROVER_LABEL[soAmendmentApprover(amendmentLane)]} — one signature applies it.
                  </div>
                )}
                {amendmentLane == null && openAmendment.status === "REQUESTED" && canSupplierConfirm && (
                  <button
                    type="button"
                    onClick={() => setSupplierConfirmOpen(true)}
                    disabled={busy}
                    className="money"
                    style={{ border: "1px solid var(--hz-dk-primary-line, #bcdcd7)", background: "var(--hz-c-primary-soft)", color: "var(--hz-c-primary)", fontFamily: "inherit", fontSize: 12, fontWeight: 700, borderRadius: 9, padding: "9px 11px", cursor: "pointer", opacity: busy ? 0.5 : 1 }}
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
                    style={{ border: "1px solid var(--hz-dk-primary-line, #bcdcd7)", background: "var(--hz-c-primary-soft)", color: "var(--hz-c-primary)", fontFamily: "inherit", fontSize: 12, fontWeight: 700, borderRadius: 9, padding: "9px 11px", cursor: "pointer", opacity: busy ? 0.5 : 1 }}
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
                        style={{ border: "1px solid var(--hz-dk-primary-line, #bcdcd7)", background: "var(--hz-c-primary-soft)", color: "var(--hz-c-primary)", fontFamily: "inherit", fontSize: 12, fontWeight: 700, borderRadius: 9, padding: "9px 11px", cursor: "pointer", opacity: approvePo.isPending ? 0.5 : 1 }}
                      >
                        {approvePo.isPending ? "Approving…" : "Approve PO revision"}
                      </button>
                    )}
                  </>
                )}
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
                        style={{ border: "1px solid var(--hz-dk-primary-line, #bcdcd7)", background: "var(--hz-c-primary-soft)", color: "var(--hz-c-primary)", fontFamily: "inherit", fontSize: 12, fontWeight: 700, borderRadius: 9, padding: "9px 11px", cursor: "pointer", opacity: sendAmendment.isPending ? 0.5 : 1 }}
                      >
                        {sendAmendment.isPending ? "Sending…" : "Send to supplier"}
                      </button>
                    )}
                  </>
                )}
                <WrongApproverFlagButton amendment={openAmendmentDetail.data?.amendment} canSign={canApproveLane} variant="mobile" />
                {canOfferReject && (
                  <button
                    type="button"
                    onClick={() => void handleReject()}
                    disabled={rejectAmendment.isPending}
                    className="money"
                    style={{ border: "1px solid #e0bcbc", background: "var(--hz-c-err-bg)", color: "var(--hz-c-err)", fontFamily: "inherit", fontSize: 12, fontWeight: 700, borderRadius: 9, padding: "9px 11px", cursor: "pointer", opacity: rejectAmendment.isPending ? 0.5 : 1 }}
                  >
                    {rejectAmendment.isPending ? "Rejecting…" : "Reject amendment"}
                  </button>
                )}
                {canOfferWithdraw && (
                  <button
                    type="button"
                    onClick={() => void handleWithdraw()}
                    disabled={withdrawAmendment.isPending}
                    style={{ border: "1px solid var(--line2)", background: "var(--hz-c-surface)", color: "var(--mut)", fontFamily: "inherit", fontSize: 12, fontWeight: 700, borderRadius: 9, padding: "9px 11px", cursor: "pointer", opacity: withdrawAmendment.isPending ? 0.5 : 1 }}
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

            <div className="card"><div className="card-h"><span className="card-t">Customer</span></div><div className="card-b">
              <RoField label="Customer name" value={val(h.debtor_name)} />
              <div style={{ display: "flex", gap: 9 }}><div style={{ flex: 1, minWidth: 0 }}><RoField label="Phone" value={formatPhone(h.phone) || val(h.phone)} mono /></div><div style={{ flex: 1, minWidth: 0 }}><RoField label="Email" value={val(h.email)} /></div></div>
              <div style={{ display: "flex", gap: 9 }}><div style={{ flex: 1, minWidth: 0 }}><RoField label="Customer type" value={val(h.customer_type)} /></div><div style={{ flex: 1, minWidth: 0 }}><RoField label="Salesperson" value={val(salespersonName)} /></div></div>
              <SoSharedWith docNo={h.doc_no} header={h} staff={staffQ.data} frame={(v) => <RoField label="Shared with" value={v} />} />
              <RoField label="Ref No." value={val(h.customer_so_no ?? h.ref)} mono />
              {(h.emergency_contact_phone ?? "").trim() ? (
                <RoField label="Emergency contact" value={composeEmergency(h)} />
              ) : null}
            </div></div>

            <div className="card"><div className="card-h"><span className="card-t">Order info</span></div><div className="card-b">
              <div style={{ display: "flex", gap: 9 }}><div style={{ flex: 1, minWidth: 0 }}><RoField label="Building type" value={val(h.building_type)} /></div><div style={{ flex: 1, minWidth: 0 }}><RoField label="Fair" value={h.fair ? fairLabel(h.fair) : val(h.venue ?? h.venue_id)} /></div></div>{h.fair_date ? <RoField label="Fair day" value={dl(h.fair_date)} mono /> : null}
              {h.fair && h.venue && fairElsewhereLine(h.venue, h.fair) ? <RoField label="Venue" value={`${h.venue} · Venue differs`} /> : null}{/* the fair is named above; its place is not the order's (owner 2026-10-19) */}
              <div style={{ display: "flex", gap: 9 }}><div style={{ flex: 1, minWidth: 0 }}><RoField label="Processing Date" value={dl(h.processing_date)} mono /></div><div style={{ flex: 1, minWidth: 0 }}><RoField label="Delivery Date" value={dl(h.customer_delivery_date)} mono /></div></div>
              <RoField label="Sales location" value={val(h.sales_location ?? h.customer_state)} />
              {(h.note ?? "").trim() ? (
                <div style={{ marginTop: 2, border: "1px solid #e0cf9e", background: "var(--amber-bg, var(--hz-c-warning-bg))", borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--amber, #8a6a2e)" }}>Note</div>
                  <p style={{ margin: "4px 0 0", fontSize: 12.5, lineHeight: 1.5, color: "#6d5626", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{h.note}</p>
                </div>
              ) : (
                <RoField label="Note" value="—" />
              )}
            </div></div>

            {/* Delivery address — the desktop SO form's parts, each labelled: two lines
                (line 2 carries what 3 / 4 hold, owner 2026-11-18); City = city ?? address3;
                Postcode = postcode ?? address4; State; Country. Em-dashed when blank. */}
            <div className="card"><div className="card-h"><span className="card-t">Delivery address</span></div><div className="card-b">
              {[h.address1, addressLineTwoView(h.address2, h.address3, h.address4, { postcode: h.postcode ?? h.address4, city: h.city ?? h.address3, state: h.customer_state })].map((v, i) => <RoField key={i} label={i ? "Address line 2" : "Address line 1"} value={val(v || null)} />)}
              <div style={{ display: "flex", gap: 9 }}>
                <div style={{ flex: 1, minWidth: 0 }}><RoField label="City" value={val(h.city ?? h.address3)} /></div>
                <div style={{ flex: 1, minWidth: 0 }}><RoField label="Postcode" value={val(h.postcode ?? h.address4)} mono /></div>
              </div>
              <div style={{ display: "flex", gap: 9 }}>
                <div style={{ flex: 1, minWidth: 0 }}><RoField label="State" value={val(h.customer_state)} /></div>
                <div style={{ flex: 1, minWidth: 0 }}><RoField label="Country" value={val(h.customer_country)} /></div>
              </div>
            </div></div>

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
                const { primary, secondary } = orderLineIdentity({
                  code,
                  description: it.description,
                  variant: buildVariantSummary(it.item_group, it.variants) || (it.description2 ?? ""),
                });
                const isFoc = isFocLine({ ...it, line_total_sen: lineTotalSen(it) });
                const discountSen = it.discount_sen ?? 0;
                return (
                <div key={it.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "11px 13px", borderTop: i ? "1px solid var(--line2)" : "none" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)", overflowWrap: "anywhere" }}>{primary || "—"}</div>
                    {secondary ? <div style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 2, overflowWrap: "anywhere" }}>{secondary}</div> : null}
                    <MobileLineRemark text={it.remark} />
                    <MobileLinePhotos docNo={docNo} line={it} />
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
                    <NonSellingWarehouseNoteMobile note={it.non_selling_warehouse} />
                    {!it.non_selling_warehouse && <NoProcessingDateNoteMobile show={it.awaiting_processing_date} />}
                    {/* Bound PO wins over the shipped batch (owner 2026-09-22), like desktop SoSourceChips. */}
                    <SourcePosRowMobile
                      pos={(it.bound_source_pos && it.bound_source_pos.length > 0) ? it.bound_source_pos : (it.shipped_source_pos ?? [])}
                      adj={it.shipped_source_adj}
                      etas={it.bound_source_pos && it.bound_source_pos.length > 0 ? Object.fromEntries(Object.entries(it.bound_source_po_etas ?? {}).map(([po, d]) => [po, dl(d)])) : undefined}
                      ready={(it.bound_source_pos && it.bound_source_pos.length > 0) ? [] : ((it.delivered_qty ?? 0) > 0 && (it.remaining_qty ?? null) === 0 ? [] : (it.ready_source_pos ?? []))}
                      incoming={(it.bound_source_pos && it.bound_source_pos.length > 0) ? null : (it.stock_state === "po" && it.coverage_po ? { po: it.coverage_po, eta: it.coverage_eta ? dl(it.coverage_eta) : null } : null)}
                    />
                  </div>
                  <div style={{ textAlign: "right", whiteSpace: "nowrap", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                    <div className="money" style={{ fontSize: 13, fontWeight: 700, color: "var(--hz-c-primary-ink)" }}>RM {rm(lineTotalSen(it))}</div>
                    <div className="money" style={{ fontSize: 11, color: "var(--mut)" }}>RM {rm(it.unit_price_sen ?? 0)} {"×"}{it.qty ?? 0}</div>
                    {isFoc ? (
                      <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: ".3px", color: "var(--hz-c-accent)", background: "var(--hz-dk-warning-bg, #f6ecd9)", border: "1px solid #e6d3ad", borderRadius: 5, padding: "1px 5px" }}>FOC</span>
                    ) : discountSen > 0 ? (
                      <div className="money" style={{ fontSize: 10.5, color: "var(--hz-c-err)" }}>Disc RM {rm(discountSen)}</div>
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
                    style={{ border: "1px solid var(--line2)", background: payEditing ? "var(--hz-dk-surface-2, #eef1ec)" : "var(--hz-c-surface)", color: "var(--mut)", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, borderRadius: 8, padding: "4px 10px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
                  >
                    {payEditing ? "Done" : "Edit"}
                  </button>
                )}
                {canAddPayment && (
                  <button
                    type="button"
                    onClick={() => setPayOpen(true)}
                    className="money"
                    style={{ border: "1px solid var(--hz-dk-primary-line, #bcdcd7)", background: "var(--hz-c-primary-soft)", color: "var(--hz-c-primary)", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, borderRadius: 8, padding: "4px 10px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
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
              <OrderMoneyPanel docNo={docNo} onOpenNewOrder={(copyFrom, picks) => onConvert?.({ copyFrom, picks })} />
            </div>
            <MobileSoDeliveryIssues docNo={docNo} />

            <HistoryCard docNo={docNo} />

            {actionError && <div style={{ marginTop: 13, fontSize: 11.5, color: "var(--red)", whiteSpace: "pre-line", textAlign: actionError.includes("\n") ? "left" : "center" }}>{actionError}</div>}
          </div>
        )}
      </div>

      {payOpen && h && (
        <AddPaymentSheet
          docNo={docNo}
          staff={pickableStaffQ.data ?? []}
          defaultCollectedBy={defaultCollectedBy}
          /* A role holding the correction right says why it records money
             (docs/bugs/0888); the list decides the same for its own edits. */
          reasonWhy={owesPaymentReason(houzsAuth.user) ? "holder" : null}
          onClose={() => setPayOpen(false)}
          onSaved={async () => {
            setPayOpen(false);
            await refreshAfterPayment();
          }}
        />
      )}

      {supplierConfirmOpen && openAmendment && (
        <SupplierConfirmSheet
          amendmentId={openAmendment.id}
          onClose={() => setSupplierConfirmOpen(false)}
          onDone={() => setSupplierConfirmOpen(false)}
        />
      )}

      {viewingAmendmentId && (
        <AmendmentDiffSheet
          amendmentId={viewingAmendmentId}
          onClose={() => setViewingAmendmentId(null)}
        />
      )}

      {!detail.isLoading && !detail.error && h && (
        <footer className="actbar">
          {ph === "draft" && canWriteSo && (
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <div style={{ display: "flex", gap: 9 }}>
                <button className="btn-ghost" style={{ flex: 1, opacity: busy || migratedLocked ? 0.55 : 1 }} disabled={busy || migratedLocked} onClick={() => onEdit?.(docNo)}>Edit Draft</button>
                <button className="btn" style={{ flex: 1.3, opacity: busy || migratedLocked ? 0.55 : 1 }} disabled={busy || migratedLocked} onClick={async () => { if (!(await passesSoffioReminder(confirm, items.map((l) => l.item_code)))) return; const note = soConfirmDateNote(h.processing_date, h.customer_delivery_date); if (note && !(await confirm({ title: `Confirm ${docNo}?`, body: note, confirmLabel: "Create Sales Order" }))) return; void setStatus("CONFIRMED"); }}>{busy ? "Working…" : "Create Sales Order"}</button>
              </div>
              {onAddLine && <button className="btn-ghost" style={{ opacity: busy || migratedLocked ? 0.55 : 1 }} disabled={busy || migratedLocked} onClick={() => onAddLine(docNo)}>+ {ADD_LINE_LABEL}</button>}
              <button
                type="button"
                className="btn-ghost"
                style={{ opacity: busy ? 0.55 : 1, color: "var(--hz-c-err)", borderColor: "#e0bcbc" }}
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
                <button className="btn-ghost" style={{ flex: 1, opacity: busy || editLocked ? 0.4 : 1 }} disabled={busy || editLocked} onClick={() => onEdit?.(docNo)}>Edit</button>
                {canCancel ? (
                  <button className="btn-danger" style={{ flex: 1, opacity: busy ? 0.55 : 1 }} disabled={busy} onClick={() => void requestCancel(docNo, docNo)}>{busy ? "Working…" : "Request cancel"}</button>
                ) : (
                  <div style={{ flex: 1, textAlign: "center", fontSize: 11, color: "var(--mut2)", alignSelf: "center" }}>Items locked</div>
                )}
              </div>
              {onAddLine && canWriteSo && <button className="btn-ghost" style={{ marginTop: 9, opacity: busy || hardLocked ? 0.4 : 1 }} disabled={busy || hardLocked} onClick={() => onAddLine(docNo)}>+ {ADD_LINE_LABEL}</button>}
            </>
          )}
          {ph === "cancelled" && (
            <div style={{ textAlign: "center", fontSize: 11.5, color: "var(--mut2)", padding: 4 }}>This order was cancelled.</div>
          )}
          {ph === "submitted" && <MobileSoDoDraftButton so={{ doc_no: docNo, status: h.status, on_hold: (h as { on_hold?: boolean | null }).on_hold ?? null, has_undelivered: items.some((l) => l.remaining_qty == null) ? null : items.some((l) => (l.remaining_qty ?? 0) > 0) }} onCreated={(id) => { const nav = { kind: "module" as const, moduleKey: "delivery-orders-mfg", id }; if (flowNav?.can(nav)) flowNav.open(nav); }} />}{ph !== "draft" && canWriteSo && onConvert && <button className="btn-ghost" style={{ width: "100%", marginTop: 9 }} disabled={busy} onClick={() => onConvert({ copyFrom: docNo, picks: [] })}>Copy as new</button>}{/* HC-0149: the desktop list's Copy as new, same seed (lib/soCopyLines) */}
        </footer>
      )}

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

function Kpi({ label, centi, color, unknown }: { label: string; centi: number | null | undefined; color: string; unknown?: boolean }) {
  const v = unknown ? "—" : rm(centi);
  const big = v.replace(/\D/g, "").length > 6;
  return (
    <div className="card" style={{ flex: "1 1 0", minWidth: 0, marginBottom: 0 }}>
      <div className="card-b" style={{ padding: "9px 9px" }}>
        <div className="fld-l" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
        <div className="money" style={{ fontSize: big ? 12 : 13.5, fontWeight: 800, color, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {unknown ? null : <span style={{ fontSize: big ? 9 : 10, fontWeight: 700, opacity: 0.75, marginRight: 3 }}>RM</span>}{v}
        </div>
      </div>
    </div>
  );
}

function RoField({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="fld">
      <span className="fld-l">{label}</span>
      <div className={`fld-ro${mono ? " money" : ""}`}>{value}</div>
    </div>
  );
}

function composeEmergency(h: SoHeader): string {
  const name = (h.emergency_contact_name ?? "").trim();
  const phone = formatPhone(h.emergency_contact_phone);
  const rel = (h.emergency_contact_relationship ?? "").trim();
  const head = [name, phone].filter((x) => x.length).join(" · ");
  return rel ? `${head} (${rel})` : head || "—";
}

const lineTotalSen = (it: SoItem): number =>
  it.total_sen ?? Math.round((it.unit_price_sen ?? 0) * (it.qty ?? 0));

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
          <img src={viewer.src} alt={viewer.label} style={{ maxWidth: "100%", maxHeight: "84vh", borderRadius: 10, objectFit: "contain", background: "var(--hz-c-surface)" }} />
          <div style={{ marginTop: 12, fontSize: 12, fontWeight: 700, color: "#fff", opacity: 0.85 }}>{viewer.label} · tap anywhere to close</div>
        </div>
      )}
    </>
  );
}

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
      style={{ border: "1px solid var(--line2, var(--hz-c-border-subtle))", background: "var(--hz-c-surface-2)", borderRadius: 12, padding: 0, overflow: "hidden", cursor: src ? "pointer" : "default", fontFamily: "inherit", textAlign: "center" }}
    >
      {failed ? (
        <div style={{ height: 96, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 8px", fontSize: 10.5, color: "var(--mut2)", lineHeight: 1.4 }}>Couldn't load this photo.</div>
      ) : src ? (
        <img src={src} alt={label} style={{ width: "100%", height: 96, objectFit: "cover", display: "block" }} />
      ) : (
        <div className="ph" style={{ height: 96 }} />
      )}
      <div style={{ padding: "6px 4px", fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--hz-c-ink-soft)" }}>{label}</div>
    </button>
  );
}


const histVal = (field: string, v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  if ((HIST_MONEY_FIELDS.has(field) || /Sen$/.test(field)) && typeof v === "number") return `RM ${rm(v)}`;
  if (typeof v === "object") {
    return Array.isArray(v) ? `${v.length} item${v.length === 1 ? "" : "s"}` : "updated";
  }
  if (typeof v === "string" && isStoredPhotoKey(v)) return "1 photo";
  return String(v).replace(/_/g, " ");
};
const histWhen = (iso: string): string => fmtDateTime(iso);
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
const histSentence = (e: SoAuditEntry): string => {
  const fc: SoAuditFieldChange[] = Array.isArray(e.field_changes) ? e.field_changes : [];
  const find = (f: string) => fc.find((c) => c.field === f);
  switch (e.action) {
    case "CREATE":
      return e.status_snapshot === "DRAFT" ? "created this order (draft)" : "created this order";
    case "UPDATE_DETAILS":
      return "updated details";
    case "UPDATE_FAIR": { // owner 2026-10-19: every fair move, named
      const f = find("fair");
      return f ? `changed the fair: ${String(f.from ?? "—")} → ${String(f.to ?? "—")}` : "changed the fair";
    }
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
                        <div style={{ marginTop: 5, background: "var(--hz-c-surface-2)", border: "1px solid var(--hz-c-border-subtle)", borderRadius: 8, padding: "7px 9px", display: "flex", flexDirection: "column", gap: 4 }}>
                          {fc.map((ch, idx) => (
                            <div key={idx} style={{ fontSize: 11, lineHeight: 1.4, color: "var(--ink)", wordBreak: "break-word" }}>
                              <span style={{ fontWeight: 700, color: "var(--mut)" }}>{HIST_FIELD_LABEL[ch.field] ?? ch.field}:</span>{" "}
                              {ch.from !== undefined && ch.from !== null && ch.from !== "" ? (
                                <>
                                  <span style={{ color: "var(--hz-c-err)", textDecoration: "line-through" }}>{ch.from_label ?? histVal(ch.field, ch.from)}</span>
                                  <span style={{ color: "var(--mut2)" }}>{" → "}</span>
                                </>
                              ) : null}
                              <span style={{ color: "var(--hz-c-primary-ink)", fontWeight: 600 }}>{ch.to_label ?? histVal(ch.field, ch.to)}</span>
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

const amendmentChangeLabel = (t: string): string =>
  t === "SPEC" ? "Spec change" :
  t === "QTY" ? "Quantity change" :
  t === "ADD" ? "Added line" :
  t === "REMOVE" ? "Removed line" : t;

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

/* Owner 2026-07-16 — the moved field is struck on the Was side and emphasised on
   the Requesting side, so the ask is visible without reading both columns
   character-by-character. Desktop does the same on its table + job card. */
const mStrikeIf = (changed: boolean): CSSProperties =>
  changed ? { textDecoration: "line-through", opacity: 0.7 } : {};
const mEmphIf = (changed: boolean): CSSProperties =>
  changed ? { fontWeight: 800, color: "var(--ink)" } : {};

function AmRoutingChips({ kinds }: { kinds: AmendmentFieldKind[] }) {
  if (kinds.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "6px 11px 0" }}>
      {kinds.map((k) => (
        <span
          key={k}
          style={{
            display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10,
            padding: "1px 5px", borderRadius: 4, border: "1px solid var(--line2, var(--hz-c-border-subtle))",
            background: "var(--hz-c-surface-2)", color: "var(--mut)",
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

function AmTypeBadges({ kinds }: { kinds: AmendmentFieldKind[] }) {
  const { types, isMixed } = summariseRouting(kinds);
  if (types.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
      {isMixed && (
        <span style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", padding: "1px 6px", borderRadius: 4, background: "var(--line2, var(--hz-c-surface-dim))", color: "var(--mut)" }}>
          Mixed
        </span>
      )}
      {types.map((t) => (
        <span key={t} style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", padding: "1px 6px", borderRadius: 4, background: "var(--hz-dk-surface-2, #e7efe9)", color: "var(--brand, #2b6a4a)" }}>
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
  const headerDiffs = amendmentHeaderDiffRows(
    data?.amendment?.header_changes as SoAmendmentHeaderChanges | null | undefined,
    data?.amendment?.old_header_snapshot as SoAmendmentHeaderChanges | null | undefined,
    dl,
  );

  const allFieldKinds: AmendmentFieldKind[] = [
    ...lines.flatMap((l) => amendmentLineFieldKinds(l)),
    ...headerDiffs.map((d) => soHeaderFieldKind(d.key) as AmendmentFieldKind),
  ];

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
            <div style={{ fontSize: 11.5, color: "var(--mut2)", padding: "8px 0", lineHeight: 1.45 }}>
              {allLines.length > 0
                ? "No line changes recorded — every line matches the order exactly. This request predates order-detail tracking, so what was asked for is in the Reason below."
                : "This amendment has no changes recorded."}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {headerDiffs.map((d) => (
                <div key={d.key} style={{ border: "1px solid var(--line2, var(--hz-c-border-subtle))", borderRadius: 11, overflow: "hidden" }}>
                  <div style={{ padding: "7px 11px", background: "var(--hz-c-surface-2)", fontSize: 10.5, fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase", color: "#5c6156" }}>{d.label}</div>
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
                const chg = amendmentLineChangedFields(l);
                const unrendered = amendmentUnrenderedAxes(l);
                const unrenderedAll = [...new Set([...unrendered.from, ...unrendered.to])];
                return (
                  <div key={l.id} style={{ border: "1px solid var(--line2, var(--hz-c-border-subtle))", borderRadius: 11, overflow: "hidden" }}>
                    <div style={{ padding: "7px 11px", background: "var(--hz-c-surface-2)", fontSize: 10.5, fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase", color: "#5c6156" }}>{amendmentChangeLabel(l.change_type)}</div>
                    <AmRoutingChips kinds={amendmentLineFieldKinds(l)} />
                    <div style={{ display: "flex", gap: 0 }}>
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
                            {chg.remark && (old.remark ?? "").trim() ? (
                              <div style={{ fontSize: 10.5, color: "var(--mut2)", marginTop: 2, fontStyle: "italic", ...mStrikeIf(true) }}>{"“"}{old.remark}{"”"}</div>
                            ) : null}
                          </>
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0, padding: "9px 11px" }}>
                        <div className="fld-l" style={{ marginBottom: 3 }}>Requesting</div>
                        {l.change_type === "REMOVE" ? (
                          <div style={{ fontSize: 11.5, color: "var(--hz-c-err)", fontWeight: 600 }}>Removed</div>
                        ) : (
                          <>
                            <div className="money" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--hz-c-primary-ink)", ...mEmphIf(chg.itemCode) }}>{l.new_item_code ?? old.itemCode ?? "—"}</div>
                            <div className="money" style={{ fontSize: 11, color: "var(--mut)", marginTop: 2 }}>
                              <span style={mEmphIf(chg.qty)}>Qty {l.new_qty ?? old.qty ?? "—"}</span>
                              {typeof (l.new_unit_price_sen ?? old.unitPriceSen) === "number" ? (
                                <>{" · "}<span style={mEmphIf(chg.unitPrice)}>RM {rm((l.new_unit_price_sen ?? old.unitPriceSen) as number)}</span></>
                              ) : ""}
                            </div>
                            {newSummary ? <div style={{ fontSize: 10.5, color: "var(--mut2)", marginTop: 2, ...mEmphIf(chg.variants) }}>{newSummary}</div> : null}
                            {chg.remark ? (
                              <div style={{ fontSize: 10.5, color: "var(--mut2)", marginTop: 2, fontStyle: "italic", ...mEmphIf(true) }}>
                                {(l.new_remark ?? "").trim() ? `“${l.new_remark}”` : "Remark cleared"}
                              </div>
                            ) : null}
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
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: rej ? "var(--hz-c-err)" : "var(--ink)", lineHeight: 1.35 }}>{d.label}</div>
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

