// ----------------------------------------------------------------------------
// SalesOrderDetail — full-page route at /mfg-sales-orders/:docNo.
//
// HOUZS-pattern B2B sales order:
//   1. Header: back button + doc no · debtor + status pill + actions (Print PDF)
//   2. Customer info card: editable debtor_code/name/phone/agent/branding/
//      venue/4 addresses with autocomplete from prior SOs
//   3. Line items table: Item code + group + description + variants summary +
//      qty + unit price + discount + total + Edit/Delete. "+ Add Line Item"
//      opens a modal with a product picker + variant editor (sofa: size +
//      fabric color + leg height; bedframe: divan + gap + leg + specials).
//   4. Totals card: per-category subtotal + grand total + margin
//   5. Status transition strip: Draft → Confirmed → Shipped → Delivered → Invoiced → Closed.
//
// Wires to: GET /mfg-sales-orders/:docNo, PATCH header, POST/PATCH/DELETE items,
// PATCH /:docNo/status, GET /debtors/search.
// ----------------------------------------------------------------------------

import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
  type CSSProperties,
} from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, FileText, Pencil, Plus, X, Printer, Save,
  DollarSign, Lock, History, ChevronDown, Ban, Share2, Check, Trash2,
} from 'lucide-react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { PrintPreviewModal, usePrintPreview } from '../../components/scm-v2/PrintPreviewModal';
import type { PdfAction } from '../../vendor/scm/lib/pdf-common';
import { SoSourceChips } from '../../components/SoSourceChips';
import { useSetBreadcrumbs } from '../../hooks/useBreadcrumbs';
import { buildVariantSummary, canonicalizeVariants, fmtSen, fmtDateOrDash, fmtMoneySen, lineIdentity, missingVariantAxes, sofaMixIntroduced, SOFA_MIX_MESSAGE } from '@2990s/shared'; // Commander 2026-05-28
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import {
  useMfgSalesOrderDetail,
  useUpdateMfgSalesOrderHeader,
  useUpdateMfgSalesOrderStatus,
  useDeleteMfgSalesOrder,
  useAddMfgSalesOrderItem,
  useUpdateMfgSalesOrderItem,
  useDeleteMfgSalesOrderItem,
  useDebtorSearch,
  useOverrideMfgSoLinePrice,
  useSalesOrderAuditLog,
  useSalesOrderPayments,
  useUploadSoItemPhoto,
  type DebtorSuggestion,
} from '../../vendor/scm/lib/sales-order-queries';
import { resolveSelfStaff } from '../../vendor/scm/lib/self-staff';
import { AuditHistoryPanel } from '../../components/audit/AuditHistoryPanel';
import type { AuditFieldChange, AuditLogEntry } from '../../components/audit/audit-labels';
import { SO_AUDIT_LABELS } from './so-audit-labels';
import {
  LOCKED_STATUSES,
  CANCELLABLE_STATUSES,
  isLocked as isSoLocked,
  procLockActive as soProcLockActive,
  amendmentEligible as soAmendmentEligible,
} from '../../vendor/scm/lib/so-detail-gates';
import { soDateGuardError, soErrorText } from '../../vendor/scm/lib/so-form-validate';
import { zeroPriceClaim } from '../../vendor/scm/lib/zeroPriceClaim';
import { notifySaveProblems } from '../../vendor/scm/components/SaveProblemsList';
import {
  buildAmendmentHeaderChanges,
  hasAmendmentHeaderChanges,
  withFrozenHeaderFieldsReverted,
  amendmentHeaderDiffRows,
  soHeaderFieldKind,
  type SoAmendmentHeaderChanges,
} from '../../vendor/scm/lib/so-amendment-header';
import { diffHeaderPayload, hasHeaderChanges } from '../../vendor/scm/lib/so-header-diff';
import { planAmendmentSubmit, amendmentSubmittedNotice, AMENDMENT_MODE_BANNER,
  AMENDMENT_NOTHING_TO_SUBMIT } from '../../vendor/scm/lib/so-amendment-submit';
import { todayMyt } from '../../vendor/scm/lib/dates';
/* lib/utils formatDate (NOT the vendored fmtDate) for the amendment's header
   dates: these are bare YYYY-MM-DD strings, and fmtDate's `new Date(d)` parses
   those as UTC midnight then renders in the DEVICE zone — the documented
   off-by-one on an off-GMT+8 phone. formatDate formats a date-only string
   verbatim and pins the rest to Asia/Kuala_Lumpur. */
import { formatDate } from '../../lib/utils';
import { SoLineCard, emptySoLine, missingRequiredVariants, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import { PaymentsTable, type PaymentDraft, type PaymentCommitResult } from '../../vendor/scm/components/PaymentsTable';
import { paymentSaveOutcome } from '../../vendor/scm/lib/payment-save-outcome';
import { completePaymentRetryDraft, consumePaymentRetryNavigationState, readPaymentRetryHandoff, readPaymentRetryNavigationState } from '../../lib/paymentRetryHandoff';
import { DocumentRelationshipMapModal, DocumentChoiceDialog } from '../../components/scm-v2/DocumentRelationshipMapModal';
import { useSoRelationshipMap } from './so-relationship-map';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { usePrompt } from '../../vendor/scm/components/PromptDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import {
  useCreateAmendment,
  useSupplierConfirm,
  useApproveSo,
  useAmendmentDetail,
  type CreateAmendmentLine,
  type AmendmentLine,
} from '../../vendor/scm/lib/so-amendment-queries';
import {
  amendmentLineChangedFields,
  amendmentLineFieldKinds,
  amendmentOldSnapshot,
  amendmentVariantSummaries,
  visibleAmendmentLines, amendmentLineSig} from '../../vendor/scm/lib/so-amendment-line-diff';
import { routeField, type AmendmentFieldKind } from '../../vendor/scm/lib/amendment-routing';
import { fetchSoSlipUrl, fetchScanSlipImageBlobUrl } from '../../vendor/scm/lib/slip';
import {
  useLocalities,
  countryForState,
} from '../../vendor/scm/lib/localities-queries';
import {
  useAddressCascade,
  pickState,
  pickCity,
  pickPostcode,
  cityPlaceholder,
  postcodePlaceholder,
} from '../../vendor/scm/lib/address-cascade';
import { StatePicker } from '../../vendor/scm/components/StatePicker';
import {
  useSoDropdownOptions, optionsOrFallback,
} from '../../vendor/scm/lib/so-dropdown-options-queries';
import { useStaff, usePickableStaff } from '../../vendor/scm/lib/admin-queries';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import { SearchableSelect } from '../../vendor/scm/components/SearchableSelect';
import { DebtorSuggestList } from '../../vendor/scm/components/DebtorSuggestList';
import { soStatusDisplay, type DeliveryState, type SoLifecycle } from '../../vendor/scm/lib/so-status';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useAuth } from '../../vendor/scm/lib/auth';
import { useVenues } from '../../vendor/scm/lib/venues-queries';
import { useStateWarehouseMappings } from '../../vendor/scm/lib/state-warehouse-queries';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
import { generateSalesOrderPdf } from '../../vendor/scm/lib/sales-order-pdf';
import { newIdempotencyKey } from '../../lib/idempotency';
import {
  cascadeStagedDeliveryDate, dropStagedAdd, firstBlankStagedAdd, namedStagedAdds,
  patchStagedAdd, runSoLineWrites, stagedAddDrafts, stagedAddLabel, visibleLineCounts,
  type StagedAddLine,
} from './so-add-lines';
import {
  readVersionConflict, SoVersionConflictBanner, type SoVersionConflict,
} from './so-version-conflict';
import { RevisionsTab } from './so-revisions-tab';
import styles from './SalesOrderDetail.module.css';
import { DateField } from "../../vendor/scm/components/DateField";
import { HoldChip } from "../../vendor/scm/components/HoldChip";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

/* ──────────────────────────────────────────────────────────────────────────
   Module-level style constants (micro-perf: hoisted out of render so React
   keeps stable referential identity on host elements between renders).
   ────────────────────────────────────────────────────────────────────────── */
/* PR — commander 2026-05-27 followup #2. Total was previously inline in
   the <h1> title; relocated into a right-rail meta block (.totalRail) sit-
   ting beside the action group so the title stays compact. Style now lives
   in SalesOrderDetail.module.css → .totalRailLabel / .totalRailValue. */
const LOCK_BANNER_INNER_STYLE: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 8,
};
const VARIANT_WARN_BANNER_STYLE: CSSProperties = {
  background: 'rgba(184, 51, 31, 0.08)',
  border: '1px solid var(--c-festive-b, #B8331F)',
  color: 'var(--c-festive-b, #B8331F)',
  padding: 'var(--space-3) var(--space-4)',
  borderRadius: 'var(--radius-md)',
  fontSize: 'var(--fs-13)',
};
const VARIANT_WARN_LIST_STYLE: CSSProperties = { marginTop: 4, fontSize: 'var(--fs-12)' };
const DATES_XOR_WARN_STYLE: CSSProperties = {
  background: 'rgba(184, 51, 31, 0.08)',
  border: '1px solid var(--c-festive-b, #B8331F)',
  color: 'var(--c-festive-b, #B8331F)',
  padding: '4px var(--space-2)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 'var(--fs-11)',
  fontWeight: 600,
  marginTop: 'var(--space-2)',
};
const EMERGENCY_HEADER_NOTE_STYLE: CSSProperties = {
  fontSize: 'var(--fs-12)', color: 'var(--fg-muted)',
};
/* TOTALS_KPI_VALUE_STYLE removed with the Totals·Margin card (owner 2026-07-17). */
const HISTORY_STATUS_PILL_STYLE: CSSProperties = { marginLeft: 6, fontSize: 'var(--fs-10)' };

/* 2026-06-04 — the required-variant rule lives in @2990s/shared
   `so-variant-rule` (one source for the server 409 gate + every Backend
   surface). Alias-aware: a POS-created sofa line satisfies the Seat / Leg
   axes via depth / sofaLegHeight — the old hand-copied key list here flagged
   those lines as incomplete. */
const formatGroupRequirements = (g: string): string =>
  g === 'bedframe' ? 'Divan · Leg · Gap · Fabric' :
  g === 'sofa'     ? 'Seat · Leg · Fabric' : '';

// PR-DRAFT-removal — DRAFT dropped from mfg_so_status (migration 0078).
// SOs are CONFIRMED on create (PR #154); no DRAFT staging step.
const STATUS_LIST = [
  'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP',
  'SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED',
] as const;
type SoStatus = typeof STATUS_LIST[number];

const STATUS_CLASS: Record<string, string> = {
  // DRAFT flow — re-added so a DRAFT SO (scanned / auto-generated, pending
  // operator Confirm) renders the muted grey pill instead of a bare string.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition -- a CSS module is
     typed as a total Record<string,string>, so TS calls every `?? ''` here
     redundant. It is not: a key with no matching class in the .module.css
     resolves to undefined at runtime and the pill renders `class="undefined"`.
     The type is the thing that is wrong, and until CSS modules are typed from
     the stylesheet these guards are the only thing standing between a missing
     class and a broken status pill. Deleting them to satisfy the rule would
     trade a lint line for a visual bug. */
  DRAFT:          styles.statusDraft ?? '',
  CONFIRMED:      styles.statusConfirmed ?? '',
  IN_PRODUCTION:  styles.statusInProd ?? '',
  READY_TO_SHIP:  styles.statusReady ?? '',
  SHIPPED:        styles.statusShipped ?? '',
  DELIVERED:      styles.statusDelivered ?? '',
  INVOICED:       styles.statusInvoiced ?? '',
  CLOSED:         styles.statusClosed ?? '',
  CANCELLED:      styles.statusCancelled ?? '',
  RETURNED:       styles.statusReturned ?? '',
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
};

// Owner-preferred status wording — kept identical to the SO list pill
// (MfgSalesOrdersList SO_STATUS_LABEL) so the badge reads the same on the list
// and here (lifecycle states like Delivered/Invoiced/Delivery Return still come
// from soStatusDisplay; this is only the stored-status fallback).
const SO_STATUS_LABEL: Record<string, string> = {
  DRAFT:         'Draft',
  CONFIRMED:     'Confirmed',
  IN_PRODUCTION: 'Proceed',
  READY_TO_SHIP: 'Stock Ready',
  SHIPPED:       'Arranged',
  DELIVERED:     'Delivered',
  INVOICED:      'Invoiced',
  CLOSED:        'Closed',
  ON_HOLD:       'On Hold',
  CANCELLED:     'Cancelled',
};

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneySen(centi, currency);

/* Task #99 (UI perf) — Local debounce hook lifted to ../lib/hooks.ts as
   useDebouncedValue so SoLineCard's product picker (Task #102) can reuse
   it without duplicating the implementation. */

type SoHeader = {
  doc_no: string;
  /* Optimistic-lock token (migration 0153) — loaded here and echoed back on the
     header PATCH so a concurrent editor's Save can't silently overwrite this one. */
  version: number;
  so_date: string;
  status: SoStatus;
  debtor_code: string | null;
  debtor_name: string;
  agent: string | null;
  sales_location: string | null;
  ref: string | null;
  po_doc_no: string | null;
  venue: string | null;
  /* Migration 0086 — venue master FK. Auto-stamped from staff.venue_id on
     POST/PATCH when the row's salesperson belongs to a venue. */
  venue_id: string | null;
  branding: string | null;
  transfer_to: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
  phone: string | null;
  mattress_sofa_sen: number;
  bedframe_sen: number;
  accessories_sen: number;
  others_sen: number;
  /* Task #114 — per-category cost rollup (migration 0079). Used by the
     Totals card category breakdown so each row can show Revenue / Cost /
     Margin without summing items. May be undefined on rows older than
     0079 — fall back to 0 in the consumer. */
  mattress_sofa_cost_sen?: number;
  bedframe_cost_sen?:      number;
  accessories_cost_sen?:   number;
  others_cost_sen?:        number;
  local_total_sen: number;
  total_cost_sen: number;
  total_margin_sen: number;
  margin_pct_basis: number;
  line_count: number;
  currency: string;
  note: string | null;
  /* SO-amendment gate flags (Phase 1-C, read-only) — the GET /:docNo endpoint
     derives these. amendment_eligible = the SO is processing-locked (already
     PO'd) but still editable via the amendment flow, so a direct edit here must
     go out as an amendment. open_amendment is the light summary of any in-flight
     amendment (status NOT IN SENT/REJECTED). */
  amendment_eligible?: boolean;
  /* Owner 2026-08-12 — a live PO already claims one of this SO's lines (2990
     only). Feeds soProcLockActive, which is why the line/State/Postcode freeze
     below fires with no processing date involved. */
  po_locked?: boolean;
  has_open_amendment?: boolean;
  open_amendment?: { id: string; status: string; amendment_no: string; lane?: string | null } | null;
  /* Two-lane rework: up to TWO can be open at once (one per lane). */
  open_amendments?: Array<{ id: string; status: string; amendment_no: string; lane?: string | null }> | null;
  // ── PR #35 additions ────────────────────────────────────────────────
  customer_id: string | null;
  customer_state: string | null;
  /* Task #121 — country snapshot auto-derived from customer_state via
     my_localities on POST/PATCH (migration 0082). Nullable for SOs whose
     state isn't in the locality dataset yet. */
  customer_country: string | null;
  customer_po: string | null;
  customer_po_id: string | null;
  customer_po_date: string | null;
  customer_po_image_b64: string | null;
  /* PR #163 — customer's own SO number (their ERP reference). Already in
     schema since PR #121 but the Detail page never exposed it. Commander
     2026-05-27: "还需要顾客salesorder的reference在order details". */
  customer_so_no: string | null;
  hub_id: string | null;
  hub_name: string | null;
  customer_delivery_date: string | null;
  processing_date: string | null;
  linked_do_doc_no: string | null;
  ship_to_address: string | null;
  bill_to_address: string | null;
  install_to_address: string | null;
  subtotal_sen: number | null;
  overdue: string | null;
  /* PR #46 — POS handover */
  email: string | null;
  customer_type: string | null;
  salesperson_id: string | null;
  city: string | null;
  postcode: string | null;
  building_type: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  /* POS handover "Target Date" — still WRITTEN by the POS (46 SOs in the last
     90 days, measured on prod 2026-08-18) and still read by the sales-report
     export. Not rendered here; do not delete it as dead. */
  target_date: string | null;
  /* P1 (migration 0142) — POS handover customer signature (data URL). Read-only
     here; rendered as an image so the coordinator can see the signed proof. */
  signature_b64: string | null;
  /* P1 (migration 0143) — POS handover payment slip. slip_key = R2 object key
     (display via the Worker-proxied /slip-url route); slip_state = review state. */
  slip_key: string | null;
  slip_state: 'none' | 'pending' | 'verified' | 'flagged' | null;
  /* Migration 0033 — original handwritten slip image (R2 key under
     `scan-slips/...`) when this SO was created via the Scan Order flow. Served
     back (authed) via GET /scan-so/slip-image?key=... and shown as proof. */
  slip_image_key: string | null;
  /* Migration 0034 — scanned card-terminal payment receipt image (R2 key under
     `scan-slips/...-receipt`) when the Scan Order flow carried a receipt photo
     alongside the order slip. Served back via the same authed endpoint. */
  receipt_image_key: string | null;
  /* PR #143 + #150 — Payment. Installment is a sub-type of merchant
     (not its own top-level method). approval_code captured for the
     terminal auth slip. */
  payment_method: string | null;        // cash | transfer | merchant
  installment_months: number | null;    // 6 | 12 — NULL = normal swipe; valid only when method=merchant
  merchant_provider: string | null;     // GHL | HLB | MBB | PBB
  approval_code: string | null;
  payment_date: string | null;          // PR #157 — date funds received
  deposit_sen: number;
  paid_sen: number;
};

type SoItem = {
  id: string;
  doc_no: string;
  item_group: string;
  item_code: string;
  description: string | null;
  description2: string | null;
  uom: string;
  qty: number;
  unit_price_sen: number;
  discount_sen: number;
  total_sen: number;
  unit_cost_sen: number;
  line_cost_sen: number;
  line_margin_sen: number;
  variants: Record<string, unknown> | null;
  remark: string | null;
  /* PR-F photos live on the row as R2 keys; the API detail SELECT returns
     them (mfg-sales-orders.ts items select), the card renders draft.photoUrls. */
  photo_urls: string[] | null;
  cancelled: boolean;
  /* PR-E — Per-item delivery date with cascade override flag.
     line_delivery_date null + overridden=false → display falls back to
     header.customer_delivery_date. Once the user types in the SoLineCard
     date input, overridden=true and the line keeps its own value even
     when the header date changes. */
  line_delivery_date: string | null;
  line_delivery_date_overridden: boolean;
  /* Delivery breakdown stamped by the SO detail endpoint — which DO took how
     much off this line, plus the live balance still deliverable. */
  deliveries?: { doNumber: string; qty: number; status: string }[];
  delivered_qty?: number;
  remaining_qty?: number;
  /* Incoming-stock coverage — the PO this line's goods were raised into +
     earliest ETA, shown while the line is still on the way. null when no PO. */
  coverage_po?: string | null;
  coverage_eta?: string | null;
  /* Source PO(s) the delivered goods actually shipped from (from the DO OUT
     batch_no). Populated once shipped; kept visible even after full delivery so
     the operator can trace which supplier PO supplied the shipped goods. */
  shipped_source_pos?: string[];
  /* Shipped from a PO-less stock ADJUSTMENT lot (free gift / add-back) —
     rendered as "STOCK ADJ", never a blank (owner 2026-08-01). */
  shipped_source_adj?: boolean;
  /* READY trace: the PO(s) this line's allocated on-hand stock sits in (sofa:
     allocated_batch_no; non-sofa: FIFO projection). */
  ready_source_pos?: Array<{ po: string | null; qty: number; kind: 'po' | 'adjustment' }>;
  stock_state?: 'stock' | 'po' | 'shortage' | null;
};

/* Whole-order inline edit — build a SoLineDraft from a persisted SoItem.
   Hoisted to module scope so the edit-mode seed effect can map every line
   without re-allocating the function each render. Mirrors the snake_case →
   camelCase field mapping the per-row editor used before. */
const draftFromItem = (it: SoItem): SoLineDraft => ({
  itemCode:       it.item_code ?? '',
  itemGroup:      it.item_group ?? 'others',
  description:    it.description ?? '',
  uom:            it.uom ?? 'UNIT',
  qty:            it.qty ?? 1,
  unitPriceSen: it.unit_price_sen ?? 0,
  discountSen:  it.discount_sen ?? 0,
  unitCostSen:  it.unit_cost_sen ?? 0,
  // 2026-06-08 (Loo) — canonicalise POS-vocabulary sofa keys (depth →
  // seatHeight, sofaLegHeight → legHeight) so the Edit modal's Seat/Leg
  // dropdowns prefill a POS-created line instead of re-asking. fabricCode
  // already shares one key; the 409 gate + variant summary were alias-aware,
  // only this editor seam wasn't.
  variants:       canonicalizeVariants(it.item_group, it.variants as Record<string, unknown> | null),
  remark:         it.remark ?? '',
  /* Owner 2026-08-10 (AutoCount photo import): saved photos never rendered on
     the desktop edit card because the draft seed dropped photo_urls — the card
     defaulted photoUrls to [] and only session uploads showed. Mobile already
     mapped it (MobileNewSO photoKeys); this closes the desktop seam. */
  photoUrls:      it.photo_urls ?? [],
  lineDeliveryDate:           it.line_delivery_date ?? null,
  lineDeliveryDateOverridden: it.line_delivery_date_overridden ?? false,
});

/* Serialised signature of exactly the fields a line PATCH persists. Two drafts
   with the same signature need NO PATCH. Loo 2026-06-28 — entering edit mode
   seeds a draft for every line, and Save used to re-commit them ALL, even ones
   the user never touched. That re-runs the server-side recompute on each line
   (which would, e.g., clobber a PWP reward line's grant price back to full
   retail because the edit path passes no pwpBaseSen) and re-validates it against
   the CURRENT allowed-options — so an unrelated header / customer / demographics
   edit could fail (or silently corrupt a price) on a line nobody changed. Now
   Save commits only the lines whose signature actually moved. Both sides are
   draftFromItem output for an untouched line, so normalisation never false-
   positives — only a genuine user edit flips the signature. */
const lineCommitSig = (d: SoLineDraft): string => JSON.stringify({
  itemCode:       d.itemCode,
  itemGroup:      d.itemGroup,
  description:    d.description,
  uom:            d.uom,
  qty:            d.qty,
  unitPriceSen: d.unitPriceSen,
  discountSen:  d.discountSen,
  unitCostSen:  d.unitCostSen,
  variants:       d.variants ?? null,
  remark:         d.remark,
  lineDeliveryDate:           d.lineDeliveryDate ?? null,
  lineDeliveryDateOverridden: d.lineDeliveryDateOverridden ?? false,
});

export const SalesOrderDetail = () => {
  const { docNo } = useParams<{ docNo: string }>();
  const navigate = useNavigate();
  const detail = useMfgSalesOrderDetail(docNo ?? null);
  const updateHeader = useUpdateMfgSalesOrderHeader();
  const updateStatus = useUpdateMfgSalesOrderStatus();
  const deleteDraft = useDeleteMfgSalesOrder();
  const askConfirm = useConfirm();
  const askPrompt = usePrompt();
  const notify = useNotify();
  const addItem = useAddMfgSalesOrderItem();
  const updateItem = useUpdateMfgSalesOrderItem();
  const deleteItem = useDeleteMfgSalesOrderItem();
  const uploadPhoto = useUploadSoItemPhoto();

  /* Phase 1-C — SO-amendment workflow. Same edit page; when the SO is
     processing-locked (amendment_eligible) the primary Save submits an
     amendment instead of writing the lines directly. The pending banner hosts
     the supplier-confirm + approve-so gates, and the Revisions tab lists prior
     SO snapshots. Buttons are gated on the Houzs scm.amendment.* permissions. */
  const { user: currentUser, can } = useHouzsAuth();
  /* The 2990 bridge's staff row — null/role-only on Houzs for a user without a
     scm.staff row (e.g. the owner). Used only as the first (id) match key + a
     name fallback in selfStaffMatch below. */
  const { staff: currentStaff } = useAuth();
  /* Owner 2026-07-13 — resolve the signed-in user against the staff roster so
     Add-Payment's "Collected By" defaults to the person recording it. No match
     ⇒ undefined ⇒ PaymentsTable keeps "—".

     THE LADDER IS THE SHARED ONE NOW, and that is a BEHAVIOUR CHANGE, not a
     pure refactor: this page had no `user_id` rung at all (bridge-id → email →
     name), while resolveSelfStaff tries `user_id` first — the key the backend
     itself joins on, present on 102 of 140 staff rows against email's 18. So
     people previously unmatched (IT Admin: user_id 4, email NULL) now match,
     and where the two disagree `user_id` wins. Changes only this picker's
     DEFAULT, overridable, writes nothing. Full account: docs/bugs/0483. */
  const staffQ = useStaff();
  const staffList = useMemo(
    () => (staffQ.data ?? []).filter((s) => s.active),
    [staffQ.data],
  );
  const selfStaffMatch = useMemo(
    () => resolveSelfStaff(staffList, {
      userId: currentUser?.id,
      email: currentUser?.email,
      name: currentUser?.name,
      staffId: currentStaff?.id,
      staffName: currentStaff?.name,
    }),
    [staffList, currentStaff?.id, currentStaff?.name, currentUser?.id, currentUser?.email, currentUser?.name],
  );
  const createAmendment = useCreateAmendment();
  const supplierConfirm = useSupplierConfirm();
  const approveSo = useApproveSo();
  /* Phase 1-C — main content tab. 'order' = the existing edit view; 'revisions'
     lists prior SO snapshots read-only. */
  const [activeTab, setActiveTab] = useState<'order' | 'revisions'>('order');
  /* Amendment "view changes" modal — holds the open amendment id whose
     before/after diff is being shown. */
  const [viewingAmendmentId, setViewingAmendmentId] = useState<string | null>(null);
  /* Inline supplier-confirmation form toggle inside the pending banner. */
  const [showSupplierForm, setShowSupplierForm] = useState(false);

  const header = (detail.data?.salesOrder as SoHeader | undefined) ?? null;
  const items = useMemo(() => (detail.data?.items as SoItem[] | undefined) ?? [], [detail.data]);

  /* Pinned when this document is loaded, then advanced only by this editor's
     successful header Save. It must not be reassigned on every render: a line
     mutation can refetch the detail while the form is open, and adopting a
     concurrent writer's newer token would let the stale form overwrite it. */
  const loadedVersionRef = useRef<number | undefined>(undefined);
  const loadedVersionDocRef = useRef<string | undefined>(undefined);
  /* current_doc_no isn't on SoHeader — same cast this file has always used for
     it, kept inside a null guard so the shape TS sees is unchanged. */
  const currentDocNo = header
    ? ((header as { current_doc_no?: string | null }).current_doc_no ?? null)
    : null;

  /* Owner 2026-07-16 — the breadcrumb is this page's Back (the rail no longer
     carries one). VERBATIM the crumbs SalesOrderDetailV2ReadOnly pushes, and
     it has to be repeated here rather than inherited: SalesOrderDetailV2 is a
     thin router that renders EITHER the read-only body OR this editor on
     `?edit=1`, so on the edit route that component never mounts and its
     useSetBreadcrumbs never runs. Without this the top bar fell back to
     labelForPath's single, UNCLICKABLE "Sales Order" crumb — there was no
     breadcrumb back to move Back onto. Declared above the isPending / isError
     early returns (Rules of Hooks) and falls back to the route param so the
     crumb never flashes while the detail loads. */
  useSetBreadcrumbs([
    { label: 'Sales Orders', to: '/scm/sales-orders' },
    { label: header?.doc_no ?? docNo ?? 'Sales Order' },
  ]);

  /* Fix 2 (micro-perf) — Variant-completeness check memoized; derives only
     when items or the processing-date toggle changes. 2026-06-04: delegates
     to the shared so-variant-rule (alias-aware, matches the server 409). */
  const requireVariants = !!header?.processing_date;
  const incompleteVariantLines = useMemo(() => {
    if (!requireVariants) return [];
    return items
      .filter((it) => missingVariantAxes(it.item_group, it.variants as Record<string, unknown> | null, it.item_code).length > 0)
      .map((it) => ({ code: it.item_code, group: (it.item_group ?? '').toLowerCase() }));
  }, [items, requireVariants]);

  /* Followup #81 — Print PDF reads payments from the ledger now. PaymentCard
     also calls this hook (with the same docNo), so TanStack Query dedupes
     and shares the cache entry — no double fetch. */
  const printPaymentsQ = useSalesOrderPayments(docNo ?? null);

  /* Whole-order inline edit (commander 2026-05-28) — There is no longer a
     per-row "pencil" that toggles a single line into edit mode. Instead,
     when the page enters edit mode EVERY line is seeded into editingDrafts
     and rendered as an inline SoLineCard simultaneously. The whole order
     (header + every line draft + an optional pending add-draft) is then
     committed by the ONE page-level Save in the header. editingDrafts is
     keyed by item id; the seed/clear effect below mirrors isEditing.
     The "+ Add Line Item" button appends one StagedAddLine (emptySoLine() +
     the SO header's customer_delivery_date) so a brand-new line renders an
     inline SoLineCard at the bottom of the table (same component, same
     behavior as the New SO page — there is no modal flow at all). */
  const [editingDrafts, setEditingDrafts] = useState<Record<string, SoLineDraft>>({});
  /* The drafts AS SEEDED (pristine) — Save diffs each current draft against this
     so untouched lines are not re-committed (see lineCommitSig). */
  const originalDraftsRef = useRef<Record<string, SoLineDraft>>({});
  /* Owner 2026-08-16: "it should be able to keep adding lines." A single
     nullable draft + a self-hiding button capped an edit session at ONE. */
  const [addingDrafts, setAddingDrafts] = useState<StagedAddLine[]>([]);
  const [overriding, setOverriding] = useState<SoItem | null>(null);
  const [unlockOverride, setUnlockOverride] = useState(false);
  // PR-D — History panel toggle. Commander asked for the HOOKKA-style
  // floating right-side history drawer.
  const [historyOpen, setHistoryOpen] = useState(false);

  /* PR-A — Page-level Edit/Save framework. Default is read-only: all inputs
     are disabled, the "+ Add Line Item" button + per-line trash icons are
     hidden, and CustomerCard's own Save button is suppressed. Click Edit in
     the page header → entire page enters edit mode (CustomerCard inputs
     unlock, line-item actions appear, Edit button is replaced with Save +
     Cancel). Save commits via updateHeader; Cancel resets the local form.
     Status transitions remain accessible outside edit mode.
     Nick 2026-07-09 — when this component is forwarded to from V2 with
     ?edit=1, jump straight into edit mode so the operator doesn't have to
     click Edit again after Detail V2's Edit already navigated them here. */
  const [editSearchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(
    editSearchParams.get('edit') === '1',
  );
  /* Print preview — the HOOK must live above the isPending / isError early
     returns (owner 2026-08-07). It arrived at its call site further down
     (#1665), which sits PAST those returns: a cold page's first render bails
     out early with N hooks, the render after the query resolves reaches
     usePrintPreview with N+1, and React throws "Rendered more hooks than during
     the previous render" — a blank crash page.

     Nobody hit it coming from the SO list, because arriving that way the header
     is already in the TanStack cache and there is no pending first render. It
     only bites a COLD load of this route: a pasted or bookmarked link, a
     refresh while on the editor, a new tab. That is also why it shipped.

     The deliver callback closes over `header` / `items` / query data that only
     exist after the guards, so it cannot move up here with the hook. The ref is
     the join: the hook is created once, up here, and reads the CURRENT deliver
     through the ref at call time. Assigned below, where deliverPrintPdf is
     defined. */
  const deliverPrintPdfRef = useRef<(action: PdfAction) => void | Promise<void>>(() => {});
  const print = usePrintPreview(
    useCallback((action: PdfAction) => deliverPrintPdfRef.current(action), []),
  );

  /* Payments edit mode — the money's OWN toggle (owner 2026-08-07). Declared up
     here with the other page state, NOT beside the `canEditPayments` derivation
     it feeds: everything below the early returns is conditional, and a hook
     there throws the exact error described above. See the derivation for what
     this gates and why. */
  const [payEditing, setPayEditing] = useState(
    /* `?payments=1` — arrived through V2's "Collect payment" button, which is
       the only door into this page on a hard-locked order. Open the ledger
       straight away rather than making the operator hunt for a second toggle
       on a page they reached BY asking for payments. */
    editSearchParams.get('payments') === '1',
  );
  /* Page Edit mode already unlocks the ledger, so the toggle hides while it is
     on — and clears, so leaving page Edit re-locks payments instead of leaving
     them silently open on a stale `payEditing` from before. */
  useEffect(() => { if (isEditing) setPayEditing(false); }, [isEditing]);
  /* Unbooked payment rows currently typed into the Payments card (owner
     2026-08-07). They live inside PaymentsTable in SAVED mode, so the page has
     to be told; it needs the count because IT owns the two exits that would
     throw them away — the header back button and the payments Edit toggle.
     `setUnsavedPayments` is a stable setState reference, which the prop
     requires (it is an effect dependency over there).
     Declared here with the other page state, ABOVE the early returns — same
     rule as payEditing and the print hook. */
  const [unsavedPayments, setUnsavedPayments] = useState(0);
  /* The card hands this up so Save can book the typed rows (docs/bugs/0584-*). */
  const commitPaymentsRef = useRef<(() => Promise<PaymentCommitResult>) | null>(null);
  useEffect(() => {
    if (!header) return;
    if (loadedVersionDocRef.current !== header.doc_no) {
      loadedVersionDocRef.current = header.doc_no;
      loadedVersionRef.current = header.version;
      return;
    }
    if (!isEditing || loadedVersionRef.current == null) {
      loadedVersionRef.current = Math.max(loadedVersionRef.current ?? 0, header.version);
    }
  }, [header, isEditing]);
  const location = useLocation();
  const [paymentRetryState, setPaymentRetryState] = useState<{ documentId: string; drafts: PaymentDraft[] } | null>(null);
  const paymentRetryDrafts = paymentRetryState && paymentRetryState.documentId === docNo
    ? paymentRetryState.drafts
    : [];
  useEffect(() => {
    if (!docNo) return;
    const stored = readPaymentRetryHandoff('so', docNo)?.drafts ?? [];
    const navigated = readPaymentRetryNavigationState(location.state, 'so', docNo);
    const byKey = new Map([...stored, ...navigated].map((draft) => [draft.idempotencyKey, draft]));
    setPaymentRetryState({ documentId: docNo, drafts: [...byKey.values()] });
    if (location.state && typeof location.state === 'object' && 'paymentRetry' in location.state) {
      navigate(
        { pathname: location.pathname, search: location.search, hash: location.hash },
        { replace: true, state: consumePaymentRetryNavigationState(location.state) },
      );
    }
  }, [docNo, location.hash, location.pathname, location.search, location.state, navigate]);
  const paymentRetryCommitted = (draft: PaymentDraft) => {
    if (!docNo || !draft.idempotencyKey) return;
    completePaymentRetryDraft('so', docNo, draft.idempotencyKey);
    setPaymentRetryState((current) => current?.documentId === docNo
      ? { ...current, drafts: current.drafts.filter((row) => row.idempotencyKey !== draft.idempotencyKey) }
      : current);
  };
  const [relMapOpen, setRelMapOpen] = useState(false);
  /* Relationship-map chain + destinations — SHARED with SalesOrderDetailV2 so the
     two SO detail surfaces can't drift again. Called here (not at the render site)
     because the early returns below would otherwise make the hook conditional. */
  const {
    nodes: chainNodes,
    onNodeClick: onChainNodeClick,
    amendments: chainAmendments,
    onAmendmentClick: onChainAmendmentClick,
    pairing: chainPairing,
    choice: chainChoice,
    closeChoice: closeChainChoice,
    pickChoice: pickChainChoice,
  } = useSoRelationshipMap(header);
  const [saveError, setSaveError] = useState<string | null>(null);
  /* The order moved under this editor. Held as STATE, not written straight into
     loadedVersionRef, because adopting the server's version is the operator's
     decision — see so-version-conflict.tsx for why silently adopting it is a
     lost update rather than a fix. */
  const [versionConflict, setVersionConflict] = useState<SoVersionConflict | null>(null);
  const customerCardRef = useRef<CustomerCardHandle | null>(null);

  /* One idempotency key per AMENDMENT INTENT (see lib/idempotency.ts). The
     intent is this edit session: the operator opened the order to request one
     amendment. Minted lazily on submit and retired when the edit session ENDS,
     never when the write succeeds — if the submit times out and the operator
     presses Submit again, the same key must replay the first response instead
     of filing a second amendment (the number is minted `count + 1`, so a second
     one is a real duplicate). A later, genuinely separate amendment is a new
     edit session and therefore a new key. */
  const amendKeyRef = useRef<string | null>(null);
  /* The ADD key rides on the ROW now (StagedAddLine.idempotencyKey): one key
     shared across distinct inserts would replay the first for all of them. */
  const activeLineLeaseRef = useRef<string | null>(null);
  const endEditSession = () => {
    amendKeyRef.current = null;
    activeLineLeaseRef.current = null;
    setIsEditing(false);
  };

  /* Leaving edit mode has to leave the EDIT ROUTE too, not just flip a flag.
     SalesOrderDetailV2 is a thin router that renders THIS component whenever
     `?edit=1` is on the URL, so `setIsEditing(false)` alone left the operator
     on this legacy ledger — a visibly different page from the V2 detail they
     pressed Edit on, at the same address, with no way back to it except the
     browser's own Back (owner 2026-08-10: "按 Cancel 出來不一樣的頁面").
     Dropping the param hands them back to SalesOrderDetailV2ReadOnly.

     `replace` because the editor URL is a mode, not a place: V2's goEdit
     PUSHED `?edit=1` onto the history, so replacing it here collapses the pair
     instead of stacking a second detail entry that Back would have to walk
     through twice.

     NOT called on the amendment path — a submitted amendment deliberately
     stays on this page to show its raised-amendment notice. */
  const returnToDetail = () => {
    if (docNo) navigate(`/scm/sales-orders/${docNo}`, { replace: true });
  };

  /* Both halves of the save feedback die together — a version banner left up
     from the previous attempt would accuse the operator of a stale baseline
     they have already dealt with. */
  const clearSaveFeedback = () => { setSaveError(null); setVersionConflict(null); };
  const enterEdit  = () => { clearSaveFeedback(); setIsEditing(true); };
  const cancelEdit = () => {
    customerCardRef.current?.reset();
    clearSaveFeedback();
    // The seed/clear effect wipes editingDrafts + addingDraft when isEditing
    // flips to false, discarding any uncommitted line edits.
    endEditSession();
    returnToDetail();
  };

  /* Whole-order Save — persists the order in one shot:
       1. validate the header (CustomerCard's own Save runs its date-XOR gate)
       2. commit every dirty line draft via updateItem (parallel)
       3. commit the pending add-draft via addItem (+ drain staged photos)
     The header save is sequenced first so its validation can short-circuit
     before any line writes go out. We only leave edit mode after ALL writes
     resolve; any failure surfaces inline and keeps the user in edit mode so
     nothing is silently lost. */
  const [savingOrder, setSavingOrder] = useState(false);
  const saveEdit = () => {
    const handle = customerCardRef.current;
    if (!handle || !header) return;
    if (savingOrder) return;
    clearSaveFeedback();

    /* Owner 2026-06-03 — phone is COMPULSORY on every SO. Mirror the New SO
       guard so Edit can't blank it out (the backend PATCH now rejects an
       empty phone too; this keeps the operator from a confusing 400). */
    if (!handle.getPhone().trim()) {
      notify({
        title: 'Phone number is required',
        body: 'every sales order must have a contact number.',
        tone: 'error',
      });
      return;
    }

    // Guard: every staged add needs a product. Named by POSITION — with
    // several staged, "the new line" no longer says which card to go and fix.
    const blankAddPos = firstBlankStagedAdd(addingDrafts);
    if (blankAddPos != null) {
      setSaveError(`${stagedAddLabel(blankAddPos)} has no product picked — pick one, or remove that line before saving.`);
      return;
    }
    // Guard: every existing line must still reference a product.
    const blankLine = Object.values(editingDrafts).find((d) => !d.itemCode.trim());
    if (blankLine) {
      setSaveError('Every line must have a product selected before saving.');
      return;
    }
    /* Sofa is exclusive among main products — the server 400s
       `so_sofa_no_other_main` when a sofa line rides with a bedframe/mattress.
       Block + warn here so the operator gets one plain sentence, not a raw 400.
       In edit mode every existing line is seeded into editingDrafts, so this
       (+ EVERY staged add) covers the whole order.

       INTRODUCED, not flat (2026-08-18). This asked `hasSofaMixConflict` on the
       edited set alone, which is the CREATE path's question. The three server
       line paths ask a different one — `mainMixIntroduced` refuses only a change
       that INTRODUCES the mix, so an order written before the rule existed stays
       editable — and the flat client check sat in front of them refusing saves
       the server would have accepted. An operator on a pre-rule mixed order could
       not save ANY change to it, not even a phone number, and the sentence blamed
       a rule the server itself grandfathers. */
    const storedGroups = items.map((it) => it.item_group);
    const editedGroups = [
      ...Object.values(editingDrafts),
      ...stagedAddDrafts(addingDrafts),
    ].filter((d) => d.itemCode.trim()).map((d) => d.itemGroup);
    if (sofaMixIntroduced(storedGroups, editedGroups)) {
      setSaveError(SOFA_MIX_MESSAGE);
      return;
    }
    // Variants are only mandatory once a processing date is set: with a date
    // the order is committed to production and purchasing needs the full spec.
    // No processing date = still a draft, so allow saving with gaps.
    if (header?.processing_date) {
      const variantGaps = [
        ...Object.values(editingDrafts),
        ...stagedAddDrafts(addingDrafts),
      ]
        .filter((d) => d.itemCode.trim())
        .map((d) => ({ code: d.itemCode, miss: missingRequiredVariants(d.itemGroup, d.variants, d.itemCode) }))
        .filter((x) => x.miss.length > 0);
      if (variantGaps.length > 0) {
        setSaveError(
          'Complete all variant selections before saving — '
          + variantGaps.map((x) => `${x.code}: ${x.miss.join(', ')}`).join('; ') + '.',
        );
        return;
      }
    }

    // Validate the header (date XOR + no-past-date) BEFORE writing anything,
    // so an invalid date can't leave lines half-committed.
    const headerErr = handle.validate();
    if (headerErr) {
      setSaveError(headerErr);
      return;
    }

    setSavingOrder(true);
    // Snapshot drafts up front so concurrent re-seeds don't shift the set.
    // Only commit lines the user actually changed — re-committing an untouched
    // line re-runs the server recompute (which can clobber a PWP reward's grant
    // price) and re-validates it against current allowed-options, so an edit to
    // the header / customer / demographics alone must NOT touch the lines
    // (Loo 2026-06-28). New lines have no pristine snapshot -> always committed.
    const lineEntries = Object.entries(editingDrafts).filter(([id, d]) => {
      const orig = originalDraftsRef.current[id];
      if (!orig) return true;
      if (lineCommitSig(d) === lineCommitSig(orig)) return false;
      /* Remove-Processing-Date follow-up (2990 PR #718) — a line that is
         dirty ONLY because the header Delivery Date cascade rewrote its
         (non-overridden) lineDeliveryDate needs NO line PATCH: the header
         PATCH's server-side master-follower cascade stamps every line's date
         authoritatively. Skipping it spares untouched lines the server
         recompute (PWP grant-price clobber) AND keeps the processing-locked
         item route out of a pure header-date save — otherwise a super_admin
         clearing the dates 409s on the LINE call before the header (which
         carries the super-admin exemption) ever runs. A manually-overridden
         line date (either side) still commits — the cascade never wrote it. */
      if (!d.lineDeliveryDateOverridden && !orig.lineDeliveryDateOverridden) {
        return lineCommitSig({ ...d, lineDeliveryDate: null })
            !== lineCommitSig({ ...orig, lineDeliveryDate: null });
      }
      return true;
    });
    const deleteEntries = items.filter((it) => !(it.id in editingDrafts));
    // Snapshot: the set that goes out must be the set the guards above passed.
    const pendingAdds = addingDrafts;
    // What the operator will read in a failure message.
    const addLabel = (row: StagedAddLine, i: number) =>
      row.draft.itemCode.trim() || stagedAddLabel(i + 1);
    const itemLabel = (id: string) => editingDrafts[id]?.itemCode.trim()
      || items.find((it) => it.id === id)?.item_code || 'A line';

    const saveHeader = () => new Promise<void>((resolve, rejectSave) => {
      handle.save({
        onSuccess: () => resolve(),
        // Carry the raw Error's `.body` forward so the catch can pull the
        // server's aggregated `problems` list off it.
        onError: (msg, raw) => {
          const err = new Error(msg) as Error & { body?: string };
          if (raw && typeof raw === 'object' && 'body' in raw) {
            err.body = (raw as { body?: string }).body;
          }
          rejectSave(err);
        },
      });
    });
    const hasLineWrites = lineEntries.length > 0 || deleteEntries.length > 0 || pendingAdds.length > 0;
    const leaseToken = hasLineWrites
      ? (activeLineLeaseRef.current ??= newIdempotencyKey())
      : null;
    const reserveHeader = leaseToken
      ? updateHeader.mutateAsync({
          docNo: header.doc_no,
          reserveLineWrites: true,
          lineWriteLeaseToken: leaseToken,
          version: loadedVersionRef.current,
        }).then((result) => { loadedVersionRef.current = result.version; })
      : Promise.resolve();

    /* The version reservation is the first persisted operation. A stale
       editor therefore stops at 409 before any line PATCH/POST. Each staged
       ADD carries its OWN Idempotency-Key across retries. runSoLineWrites owns
       the stage order and the settling rules — see so-add-lines.ts for why the
       ADDs go one at a time and why every stage now reports which line. */
    reserveHeader
      .then(() => runSoLineWrites({
        deletes: deleteEntries.map((it) => ({
          label: it.item_code || 'A removed line',
          value: it.id,
          run: () => deleteItem.mutateAsync({ docNo: header.doc_no, itemId: it.id, leaseToken: leaseToken! }),
        })),
        updates: lineEntries.map(([id, d]) => ({
          label: itemLabel(id), value: id, run: () => commitEditingDraft(id, d),
        })),
        adds: pendingAdds.map((row, i) => ({
          label: addLabel(row, i), value: row, run: () => commitAddLine(row),
        })),
        onAddsLanded: (landed) => {
          const keys = new Set(landed.map((row) => row.key));
          setAddingDrafts((prev) => prev.filter((row) => !keys.has(row.key)));
        },
      }))
      .then(saveHeader)
      /* AND THE TYPED PAYMENT ROWS — AFTER the document write, deliberately: a
         payment must not be booked against a save that did not happen. */
      .then(async () => commitPaymentsRef.current?.() ?? { committed: 0, failed: 0, blocked: [] })
      .then((pay: PaymentCommitResult) => {
        setSavingOrder(false);
        /* A row that could not be booked KEEPS THE PAGE OPEN — leaving discards it. */
        const outcome = paymentSaveOutcome(pay);
        if (outcome.stay) { setSaveError(outcome.message ?? 'Some payment rows were not saved.'); return; }
        endEditSession();
        // Same exit as Cancel — a completed Save is done with the edit route.
        // (The amendment path below deliberately stays put.)
        returnToDetail();
      })
      .catch((e) => {
        setSavingOrder(false);
        const heldLease = activeLineLeaseRef.current;
        if (heldLease && loadedVersionRef.current != null) {
          /* Forget the token only when the server CONFIRMS the release. The
             release predicate is `.eq('version', clientVersion)
             .eq('edit_lease_token', ...)` (mfg-sales-orders.ts:6810-6812), so a
             release can be refused — and dropping the token on a refusal used
             to leave the server holding a lease this client could no longer
             name. The next Save then minted a fresh token, tripped
             `activeLeaseToken !== requestedLeaseToken` (:6782) and told the
             operator their order was "being saved on another screen" — about
             themselves — until the 5-minute TTL (:7274) expired. */
          void updateHeader.mutateAsync({
            docNo: header.doc_no,
            completeLineWrites: true,
            lineWriteLeaseToken: heldLease,
            version: loadedVersionRef.current,
            __suppressInvalidate: true,
          }).then(() => { activeLineLeaseRef.current = null; }, () => { /* keep it: the server still has it */ });
        }
        /* The order moved under us. The server told us where it actually is
           (soVersionConflict -> `currentVersion`, mfg-sales-orders.ts:356) and
           authed-fetch kept that body verbatim on `err.body`; until now nothing
           read it, so a stale baseline was a dead end — every later Save re-sent
           the same number and the refetch effect is (rightly) forbidden from
           advancing it mid-edit. The banner is the door out. */
        const conflict = readVersionConflict((e as { body?: string } | undefined)?.body);
        if (conflict) { setVersionConflict(conflict); return; }
        /* An aggregated save-gate failure (validation_failed) — show EVERY reason
           at once in a POPUP the owner can't miss (owner 2026-07-18: he wanted a
           modal listing all reasons, not a banner to scroll to). Anything else
           keeps the inline banner. */
        void notifySaveProblems(notify, e, setSaveError);
      });
  };

  /* ── Phase 1-C — SO-amendment submit ─────────────────────────────────────────
     When the SO is processing-locked (amendment_eligible) the SAME edit view is
     used, but the primary Save no longer writes the lines directly. Instead it
     diffs the operator's in-flight drafts (editingDrafts / addingDraft) against
     the pristine seed (originalDraftsRef / items) and packages the changes as a
     CreateAmendmentLine[] for POST /mfg-sales-orders/:docNo/amendments. The
     amendment then flows through the supplier-confirm / approve gates before it
     re-derives the SO — direct line writes on a PO'd SO would break the supplier
     copy, which is exactly what this workflow prevents. */

  const buildAmendmentLines = (): CreateAmendmentLine[] => {
    const out: CreateAmendmentLine[] = [];
    // Existing lines — SPEC / QTY. An item still in editingDrafts whose AMENDABLE
    // signature moved from its pristine seed is a change; classify QTY-only vs SPEC.
    for (const it of items) {
      const draft = editingDrafts[it.id];
      if (!draft) continue; // dropped → handled as REMOVE below
      /* Fall back to the item's own pristine draft when the seed is missing, so a
         line can never be recorded just because its snapshot went absent. */
      const orig = originalDraftsRef.current[it.id] ?? draftFromItem(it);
      if (amendmentLineSig(draft) === amendmentLineSig(orig)) continue; // nothing amendable moved
      /* QTY vs SPEC — compared against the same pristine draft the signature
         used, so both sides are canonicalised alike (an `it`-derived fallback
         would compare canonicalised drafts to a raw blob and mis-classify a
         POS-created sofa line as SPEC). */
      const qtyOnly =
        draft.itemCode === orig.itemCode
        && JSON.stringify(draft.variants ?? null) === JSON.stringify(orig.variants ?? null)
        && draft.unitPriceSen === orig.unitPriceSen
        && draft.qty !== orig.qty;
      out.push({
        salesOrderItemId: it.id,
        changeType: qtyOnly ? 'QTY' : 'SPEC',
        newItemCode: draft.itemCode || undefined,
        newVariants: draft.variants ?? undefined,
        newQty: draft.qty,
        newUnitPriceSen: draft.unitPriceSen,
        /* mig 0280 — the line's remark rides the amendment. Sent ONLY when it
           actually moved: null/absent means "not requested", which is what stops
           the apply from rewriting a remark this session never touched. */
        ...(((draft.remark ?? '') !== (orig.remark ?? ''))
          ? { newRemark: draft.remark ?? '' }
          : {}),
        /* mig 0317 — the discount rides only when it moved (the fee cell's one
           lever on a locked SO). Sent-when-unchanged would let an approval
           overwrite a discount booked on the line since the request. */
        ...((Math.round(draft.discountSen) !== Math.round(orig.discountSen))
          ? { newDiscountSen: Math.max(0, Math.round(draft.discountSen)) }
          : {}),
        // Old snapshot for the before/after diff — the pre-edit line values.
        oldSnapshot: {
          itemCode: it.item_code,
          variants: it.variants ?? null,
          qty: it.qty,
          unitPriceSen: it.unit_price_sen,
          description2: it.description2 ?? null,
        },
      });
    }
    // Removed lines — an item present in `items` but whose draft was dropped
    // from editingDrafts during this edit session (the trash button).
    for (const it of items) {
      if (editingDrafts[it.id]) continue;
      out.push({
        salesOrderItemId: it.id,
        changeType: 'REMOVE',
        oldSnapshot: {
          itemCode: it.item_code,
          variants: it.variants ?? null,
          qty: it.qty,
          unitPriceSen: it.unit_price_sen,
          description2: it.description2 ?? null,
        },
      });
    }
    /* Added lines — EVERY staged add. POST /:docNo/amendments caps `lines` at
       nothing and applySoAmendment (scm/lib/so-revision.ts:383) inserts them in
       a per-diff loop; this used to emit at most one, so on a processing-locked
       SO the second new line vanished at submit. */
    for (const { draft } of namedStagedAdds(addingDrafts)) {
      out.push({
        changeType: 'ADD',
        newItemCode: draft.itemCode,
        newVariants: draft.variants ?? undefined,
        newQty: draft.qty,
        newUnitPriceSen: draft.unitPriceSen,
        /* mig 0280 — an ADDED line carries whatever remark was typed on it. This
           is the case that lost the owner's instruction on 2990-SO-2608-016: the
           added line WAS a SVC-ADDON whose entire purpose lived in the text. */
        ...((draft.remark ?? '').trim() ? { newRemark: draft.remark } : {}),
      });
    }
    return out;
  };

  /* Owner 2026-07-16 — an edit on a processing-locked SO has TWO halves and this
     used to ship only one of them:

       * FROZEN header fields (Delivery / Processing Date, State, Postcode) +
         line changes  -> ride the amendment, need approval.
       * everything else (customer name / phone / email / address lines / note)
         -> save DIRECTLY via the header PATCH. They never reach the supplier, so
         they never needed an amendment ("有些東西原本不需要 SO amendment 都可以
         edit 的 例如顧客名字 電話號碼").

     Previously this handler called neither the header validate nor handle.save(),
     so in amendment mode EVERY header edit the operator made in the same session
     was silently discarded on submit — and an edit that touched only header
     fields hit `lines.length === 0` and never created an amendment at all ("我
     amend 了東西不給 approval"). Now: validate the header, save the direct half,
     and send the frozen half + the line diffs as the amendment. */
  const submitAmendment = async () => {
    const handle = customerCardRef.current;
    if (!handle || !header || savingOrder) return;
    clearSaveFeedback();
    // Guard: every staged add must have a product picked (named by position).
    const blankAddPos = firstBlankStagedAdd(addingDrafts);
    if (blankAddPos != null) {
      setSaveError(`${stagedAddLabel(blankAddPos)} has no product picked — pick one, or remove that line before submitting.`);
      return;
    }
    /* Owner 2026-06-03 — phone is COMPULSORY on every SO. Mirrors saveEdit: the
       header PATCH below carries the phone, so an amendment submit must not be a
       back door to blanking it. */
    if (!handle.getPhone().trim()) {
      setSaveError('Phone number is required — every sales order must have a contact number.');
      return;
    }
    /* Header date sanity BEFORE anything is written. With the shared guard's
       original-date carve-out this no longer trips on the SO's own unchanged
       past processing date — which is exactly the state every amendable SO is
       in, and is what used to make this unreachable. */
    const headerErr = handle.validate();
    if (headerErr) {
      setSaveError(headerErr);
      return;
    }

    const { changes: headerChanges } = handle.getLockedHeaderChanges();
    const lines = buildAmendmentLines();

    // Asks about BOTH halves — see vendor/scm/lib/so-amendment-submit.
    const plan = planAmendmentSubmit({
      hasLineChanges: lines.length > 0,
      hasFrozenHeaderChanges: hasAmendmentHeaderChanges(headerChanges),
      hasDirectHeaderChanges: handle.hasDirectHeaderChanges(),
    });
    if (plan === 'NOTHING') { setSaveError(AMENDMENT_NOTHING_TO_SUBMIT); return; }
    // DIRECT_ONLY needs no reason: nothing is going for approval.
    const reason = plan === 'AMENDMENT' ? await askPrompt({
      title: `Submit amendment for ${header.doc_no}?`,
      body: 'This Sales Order is already ordered from the supplier, so your changes go out as an '
        + 'amendment request. Coordinator + supplier confirm it before the order is revised. '
        + 'Add a short reason (optional).',
      placeholder: 'e.g. customer changed the fabric colour',
      multiline: true,
      confirmLabel: 'Submit amendment',
    }) : '';
    if (reason == null) return; // cancelled the prompt
    setSavingOrder(true);
    try {
      /* 1. The directly-editable half. keepLockedColsAsOriginal reverts every
            frozen column to its saved value so this PATCH can't 409
            so_locked_processing on the very change we're about to request. */
      await new Promise<void>((resolve, reject) => {
        handle.save(
          { onSuccess: () => resolve(), onError: (msg) => reject(new Error(msg)) },
          { keepLockedColsAsOriginal: true },
        );
      });
      /* 2. The approval half — frozen header fields + line diffs. DIRECT_ONLY
            skips ONLY this: the save above is the whole of that edit. */
      let createdRes: unknown = null;
      if (plan === 'AMENDMENT') {
        amendKeyRef.current ??= newIdempotencyKey();
        createdRes = await createAmendment.mutateAsync({
          docNo: header.doc_no,
          reason: reason.trim() || undefined,
          lines,
          headerChanges,
          idempotencyKey: amendKeyRef.current,
        });
      }
      setSavingOrder(false);
      endEditSession();
      /* Two-lane rework: the server classifies (and may SPLIT) the request —
         product changes go to Purchasing, delivery changes to Logistics, each
         applied by ONE signature. Tell the operator exactly what was raised. */
      notify(amendmentSubmittedNotice(plan, createdRes));
    } catch (e) {
      setSavingOrder(false);
      // Same dead end as saveEdit: the amendment's direct-half header PATCH
      // carries the CAS version too, so it 409s on a stale baseline forever.
      const conflict = readVersionConflict((e as { body?: string } | undefined)?.body);
      if (conflict) { setVersionConflict(conflict); return; }
      // authed-fetch already humanises the API error to one plain sentence.
      setSaveError(e instanceof Error ? e.message : 'Something went wrong.');
    }
  };

  /* Adopt the server's version as the new CAS baseline. Called ONLY from the
     conflict banner's own button: the operator has been told the order moved
     and has been offered the history panel first, so this is an informed
     decision to write on top rather than the silent adoption that would turn
     CAS into last-writer-wins. Their drafts are untouched — nothing to retype. */
  const adoptServerVersion = () => {
    const v = versionConflict?.serverVersion;
    if (v == null) return false;
    loadedVersionRef.current = v;
    setVersionConflict(null);
    return true;
  };

  /* Task #99 (UI perf) — Stable callbacks for the memo'd child cards. Without
     these, every parent render produces a new `onSave`/`onClose`, defeating
     React.memo on PaymentCard / CustomerCard / HistoryPanel. The mutations
     they call are stable across renders (TanStack Query returns the same
     mutate fn) so the only moving piece is `docNo` from URL params, which
     never changes inside one mounted page. */
  const stableDocNo = docNo ?? '';
  const handleHeaderSave = useCallback(
    (patch: Record<string, unknown>, cb?: { onSuccess?: () => void; onError?: (msg: string, raw?: unknown) => void }) => {
      /* `patch` arrives already diffed to the dirty fields, so an empty one means
         the operator changed nothing this PATCH persists. Skip the request: an
         all-unchanged body still re-fires the server's delivery-date cascade
         (keyed on PRESENCE, not change) and wipes every per-line override. The
         caller is told SUCCESS because nothing failed and nothing was lost —
         and no refresh is skipped by doing so: every line mutation invalidates
         the detail / list / audit queries itself, and when no line committed
         either, there is nothing new to fetch. */
      const lineLease = activeLineLeaseRef.current;
      if (Object.keys(patch).length === 0 && !lineLease) { cb?.onSuccess?.(); return; }
      /* verified-save (Wei Siang 2026-06-08): confirm the customer-identity
         fields actually persisted, so a stale-cache overwrite can't silently
         discard the edit (BUG-2026-06-07-002 #5). Only verbatim-stored, readback-
         present fields are checked (phone is E.164-normalised on store, so it's
         excluded to avoid a false "didn't stick"). A field the operator did not
         change is no longer in `patch`, so it is correctly not verified either. */
      const VERIFY: Record<string, string> = {
        debtorName: 'debtor_name', debtorCode: 'debtor_code', agent: 'agent', ref: 'ref',
      };
      const __verify: Record<string, unknown> = {};
      for (const [k, col] of Object.entries(VERIFY)) if (k in patch) __verify[col] = patch[k];
      updateHeader.mutate(
        {
          docNo: stableDocNo,
          ...patch,
          ...(lineLease ? {
            lineWriteLeaseToken: lineLease,
            ...(Object.keys(patch).length === 0 ? { completeLineWrites: true } : {}),
          } : {}),
          // The route rejects a real header mutation without this loaded token.
          // The detail response is migration-backed, so absence is a load defect,
          // not permission to fall back to last-writer-wins.
          version: loadedVersionRef.current,
          ...(Object.keys(__verify).length ? { __verify } : {}),
        },
        {
          onSuccess: (result) => {
            loadedVersionRef.current = result.version;
            if (lineLease) activeLineLeaseRef.current = null;
            cb?.onSuccess?.();
          },
          // Pass the raw Error too — its `.body` carries the aggregated problems.
          onError:   (e) => cb?.onError?.(e instanceof Error ? e.message : 'Something went wrong.', e),
        },
      );
    },
    [stableDocNo, updateHeader],
  );
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  /* Whole-order inline edit — line-item helpers.

     There is no longer a per-row "start editing this line" action: every
     persisted line is seeded into editingDrafts the moment the page enters
     edit mode (see the seed/clear effect below) and stays editable until the
     user clicks the page-level Save or Cancel. Drafts are keyed by item id.

     patchEditingDraft mutates one row's draft in place. It's stable
     (useCallback, no deps) because it's closed over by the per-row callbacks
     the memoized SoLineCard receives — a fresh arrow each render would bust
     SoLineCard's React.memo and re-render the heaviest tree on the page. */
  const patchEditingDraft = useCallback((id: string, patch: Partial<SoLineDraft>) => {
    setEditingDrafts((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      return { ...prev, [id]: { ...cur, ...patch } };
    });
  }, []);

  /* Fix A — Live header→line Delivery Date cascade. The backend already
     re-cascades non-overridden lines on Save, but inside the edit view the
     line rows didn't "jump" until that Save round-trip. This pushes the new
     header date into every line draft that hasn't been manually overridden
     the moment the user changes the header Delivery Date input — matching the
     New SO behaviour. Overridden lines keep their own value untouched. EVERY
     staged add follows too, on the same not-overridden rule. */
  const cascadeDeliveryDateToLines = useCallback((date: string) => {
    const next = date || null;
    setEditingDrafts((prev) => {
      let changed = false;
      const out: Record<string, SoLineDraft> = {};
      for (const [id, d] of Object.entries(prev)) {
        if (!d.lineDeliveryDateOverridden && d.lineDeliveryDate !== next) {
          out[id] = { ...d, lineDeliveryDate: next };
          changed = true;
        } else {
          out[id] = d;
        }
      }
      return changed ? out : prev;
    });
    setAddingDrafts((prev) => cascadeStagedDeliveryDate(prev, next));
  }, []);

  /* Per-row delete. On a persisted line this fires the delete mutation
     immediately (and drops the row's draft on success) — deletes are not
     deferred to the page-level Save because there's no "undo a removed line"
     affordance and batching a destructive op behind Save is surprising. The
     remaining line edits are still committed together by Save. */
  const removeEditingLine = useCallback((id: string) => {
    setEditingDrafts((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  /* Edit-mode seed/clear effect — whole-order inline edit. Entering edit
     mode populates a draft for EVERY current line so they all render as
     inline SoLineCard editors at once; leaving edit mode wipes the drafts
     (and any half-typed add-draft). Re-seeds whenever the underlying items
     change (e.g. after a delete or a successful Save re-fetch) so the
     inline editors stay in sync with the server snapshot. Lines the user
     is mid-deleting via removeEditingLine are intentionally dropped from
     the draft map and won't be re-seeded until the next items change. */
  useEffect(() => {
    if (!isEditing) {
      setEditingDrafts({});
      setAddingDrafts([]);
      originalDraftsRef.current = {};
      return;
    }
    const next: Record<string, SoLineDraft> = {};
    for (const it of items) next[it.id] = draftFromItem(it);
    // Snapshot the pristine drafts so Save can skip lines the user never edits.
    originalDraftsRef.current = next;
    setEditingDrafts(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, items]);

  /* Per-row callback map. SoLineCard is React.memo'd, so each row needs a
     stable onChange / onRemove pair. The Map is keyed on the line id and its
     identity changes only when the set of lines changes — exactly when a
     row's callbacks must rebind. patchEditingDraft + removeEditingLine are
     stable via useCallback above, so the bound arrows here are the only
     churn. */
  const rowCallbacks = useMemo(() => {
    const map = new Map<string, {
      onChange: (patch: Partial<SoLineDraft>) => void;
      onRemove: () => void;
    }>();
    /* Phase 1-C — on a processing-locked (PO'd) SO removing a line does NOT
       delete the persisted row: the removal is packaged as a REMOVE amendment
       line by buildAmendmentLines, so it only drops the draft here (which the
       diff then reads as "gone"). A second-open guard (has_open_amendment)
       falls back to the direct delete. */
    const removeViaAmendment =
      Boolean(header?.amendment_eligible) && !Boolean(header?.has_open_amendment);
    for (const it of items) {
      map.set(it.id, {
        onChange: (patch) => patchEditingDraft(it.id, patch),
        onRemove: async () => {
          if (await askConfirm({
            title: removeViaAmendment
              ? `Remove ${it.item_code} in this amendment?`
              : `Remove ${it.item_code} from this SO?`,
            body: removeViaAmendment
              ? 'The line stays until the amendment is approved — Submit the amendment to request its removal.'
              : undefined,
            confirmLabel: 'Remove',
            danger: true,
          })) {
            if (removeViaAmendment) {
              // Defer to the amendment: just drop the draft (→ REMOVE line).
              removeEditingLine(it.id);
              return;
            }
            /* Direct deletes are deferred to the page Save so they run under
               the same header lease as add/update and remain cancellable. */
            removeEditingLine(it.id);
          }
        },
      });
    }
    return map;
  }, [items, patchEditingDraft, removeEditingLine, askConfirm,
      header?.amendment_eligible, header?.has_open_amendment]);

  /* Add path — one more inline SoLineCard appended below the table on every
     "+ Add Line Item" click. Every staged draft is committed together with the
     header + line edits by the page-level Save (see saveEdit). */
  const startAddLine = () => {
    if (!header) return;
    setAddingDrafts((prev) => [...prev, {
      key: newIdempotencyKey(),
      idempotencyKey: newIdempotencyKey(),
      draft: {
        ...emptySoLine(),
        // Header's date as the default — same pattern SalesOrderNew uses.
        lineDeliveryDate: header.customer_delivery_date ?? null,
        lineDeliveryDateOverridden: false,
      },
    }]);
  };

  const cancelAddLine = useCallback(
    (key: string) => setAddingDrafts((prev) => dropStagedAdd(prev, key)),
    [],
  );

  const patchAddingDraft = useCallback(
    (key: string, patch: Partial<SoLineDraft>) =>
      setAddingDrafts((prev) => patchStagedAdd(prev, key, patch)),
    [],
  );

  /* Per-staged-line callbacks — same reason rowCallbacks exists (SoLineCard is
     React.memo'd). Keyed on the KEY LIST, not on addingDrafts: that array's
     identity changes on every character typed. */
  const addKeyList = addingDrafts.map((row) => row.key).join('|');
  const addCallbacks = useMemo(() => {
    const map = new Map<string, { onChange: (p: Partial<SoLineDraft>) => void; onRemove: () => void }>();
    for (const key of addKeyList ? addKeyList.split('|') : []) {
      map.set(key, {
        onChange: (patch) => patchAddingDraft(key, patch),
        onRemove: () => cancelAddLine(key),
      });
    }
    return map;
  }, [addKeyList, patchAddingDraft, cancelAddLine]);

  /* Commit one persisted line via updateItem. Used by the page-level Save to
     fan every dirty line draft out in parallel. Returns the mutation promise
     so saveEdit can Promise.all them. */
  const commitEditingDraft = (id: string, d: SoLineDraft) =>
    updateItem.mutateAsync({
      docNo: header!.doc_no,
      itemId: id,
      leaseToken: activeLineLeaseRef.current!,
      itemCode:       d.itemCode,
      itemGroup:      d.itemGroup,
      description:    d.description,
      uom:            d.uom,
      qty:            d.qty,
      unitPriceSen: d.unitPriceSen,
      /* This line ALREADY EXISTS: its 0 is the price it carries, so re-sending
         it must not silently re-price it (a qty-only edit sends the price too). */
      ...zeroPriceClaim(d.unitPriceSen, true),
      discountSen:  d.discountSen,
      unitCostSen:  d.unitCostSen,
      variants:       d.variants,
      remark:         d.remark,
      lineDeliveryDate:           d.lineDeliveryDate ?? null,
      lineDeliveryDateOverridden: d.lineDeliveryDateOverridden ?? false,
    });

  /* Commit ONE staged add via addItem, then drain its staged photo Files
     against the freshly-minted itemId. The key comes off the ROW, so a retry
     of this line replays this line and never another. */
  const commitAddLine = async (staged: StagedAddLine) => {
    const d = staged.draft;
    const pendingFiles = d.pendingPhotoFiles ?? [];
    const res = await addItem.mutateAsync({
      docNo: header!.doc_no,
      idempotencyKey: staged.idempotencyKey,
      leaseToken: activeLineLeaseRef.current!,
      itemCode:       d.itemCode,
      itemGroup:      d.itemGroup,
      description:    d.description,
      uom:            d.uom,
      qty:            d.qty,
      unitPriceSen: d.unitPriceSen,
      /* UNCHANGED behaviour: this staged ADD has claimed every 0 since #2425.
         BUG-HISTORY 2026-08-20 records the open question about an unpriced SKU
         reaching this path; deliberately not touched here. */
      ...zeroPriceClaim(d.unitPriceSen, true),
      discountSen:  d.discountSen,
      unitCostSen:  d.unitCostSen,
      variants:       d.variants,
      remark:         d.remark,
      lineDeliveryDate:           d.lineDeliveryDate ?? null,
      lineDeliveryDateOverridden: d.lineDeliveryDateOverridden ?? false,
    });
    /* POST /:docNo/items returns the inserted row; pull its id and upload
       each staged File. Upload failures don't undo the line — surface a
       soft warning so the line can be re-attached. */
    const newItemId = (res.item as { id?: string } | null)?.id;
    if (newItemId && pendingFiles.length > 0) {
      let failed = 0;
      for (const f of pendingFiles) {
        try {
          await uploadPhoto.mutateAsync({ docNo: header!.doc_no, itemId: newItemId, file: f });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[so-line-photos] add-line upload failed', { file: f.name, err });
          failed++;
        }
      }
      if (failed > 0) {
        notify({
          title:
            `Line added, but ${failed} staged photo${failed === 1 ? '' : 's'} ` +
            `failed to upload.`,
          body: 'Please re-attach on the row.',
          tone: 'error',
        });
      }
    }
  };

  // Lock mechanism — terminal statuses live in the shared LOCKED_STATUSES
  // (vendor/scm/lib/so-detail-gates) so desktop + mobile agree. CANCELLED +
  // CLOSED + INVOICED are terminal; SHIPPED is the earliest locked state (once
  // goods leave our hands the header is no longer editable).

  // isPending, NOT isLoading: isLoading is (isPending && isFetching), so it is
  // FALSE whenever the query is pending but not actively fetching — i.e. while
  // it is disabled, or PAUSED because the device is briefly offline. Gating on
  // isLoading let those states fall through to the error branch below and paint
  // "Sales order not found." before the fetch had ever run, then swap to the real
  // order once it resolved (the "error 先然後再 loading" the owner reported).
  // isPending covers all three, so the skeleton holds until the query settles.
  if (detail.isPending) {
    return <SkeletonDetailPage />;
  }
  if (detail.isError || !header) {
    return (
      <div className="space-y-4">
        <Link
          to="/scm/sales-orders"
          className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary"
        >
          <ArrowLeft {...ICON} />
          <span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Sales order not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  /* Tier 2 downstream-lock — once a non-cancelled DO/SI references this SO,
     the page becomes read-only. unlockOverride NOT honoured for this case —
     the child must be cancelled/deleted to edit. Convert-to-DO stays available
     (partial delivery) via the list's right-click. */
  const hasChildren = Boolean((header as { has_children?: boolean }).has_children);
  const isLocked = isSoLocked(header.status, hasChildren, unlockOverride);
  /* The one thing a hard-locked SO still accepts: a new salesperson. Same
     permission the API enforces (mfg-sales-orders.ts PATCH), so the Edit button
     it re-enables can never open an order the server would refuse to save. */
  const canAttributeOther = can('scm.so.attribute_other');

  /* Owner 2026-07-05 — SO PROCESS lock: once the SO has a Processing Date
     (which IS what being proceeded means — owner, pinned 2026-08-13) AND that
     day has passed, we PO to the supplier, so the LINE ITEMS freeze (State + Postcode freeze in the customer
     card below). Payment + the rest of the customer data stay editable. This is
     independent of `isLocked` (status/downstream) — it applies while the SO is
     still in an otherwise-editable status. Shared gate uses todayMyt() (Malaysia
     calendar day) so the lock flips at MYT midnight, not the device's midnight. */
  const procLockActive = soProcLockActive(header);

  /* Phase 1-C — SO-amendment gating (server-derived flags on the header). When
     amendment_eligible is true the SO is processing-locked (already PO'd) but not
     hard-locked by a DO/SI: the edit page stays usable, but its primary Save
     SUBMITS AN AMENDMENT rather than writing the lines directly. amendmentMode
     also suppresses the immediate line-delete path (removals become REMOVE
     amendment lines instead of live deletes). has_open_amendment gates the
     pending banner + its supplier-confirm / approve actions. */
  const amendmentEligible = soAmendmentEligible(header, isLocked);
  const openAmendment = header.open_amendment ?? null;
  /* Two-lane rework: up to TWO amendments can be awaiting approval (one per
     lane). A LEGACY open row (lane null, mid two-gate chain) still blocks
     everything; lane rows only block their own lane — the server 409s a
     same-lane resubmission with a plain message, so the editor stays usable
     while ONE lane is free. */
  const openAmendments = header.open_amendments ?? (openAmendment ? [openAmendment] : []);
  const legacyOpenAmendment = openAmendments.some((a) => a.lane == null);
  const bothLanesBusy =
    openAmendments.some((a) => a.lane === 'LINES') && openAmendments.some((a) => a.lane === 'DELIVERY');
  const amendmentMode = amendmentEligible && !legacyOpenAmendment && !bothLanesBusy;

  /* Line editing is locked by EITHER the status/downstream lock OR the process
     lock — both mean the lines are no longer ours to change directly.

     ...UNLESS the SO is in amendment mode. This was a deadlock (Owner 2026-07-16
     "我 amend 了東西不給 approval"): the process lock rendered every SoLineCard
     read-only AND disabled Add Line, while the page's primary button was "Submit
     amendment request" — which builds its payload by diffing those very line
     drafts. So buildAmendmentLines() could only ever return [], and the submit
     always answered "No changes to submit — edit a line first" with no line the
     operator was able to edit. The amendment was unreachable on desktop.

     Mobile already had this right (`lineEditingBlocked = lineLocked ||
     (procLocked && !amendmentMode)`); this brings desktop onto the same rule.
     Nothing is written directly — submitAmendment routes the diff through the
     approval flow, and the server's line routes still 409 a direct write. */
  const linesLocked = isLocked || (procLockActive && !amendmentMode);
  /* The raw lock, for the few per-line actions that still write DIRECTLY to the
     server (price override) rather than through the amendment diff — those must
     stay disabled on a locked SO or they render-then-409. */
  const overrideLocked = isLocked || procLockActive;
  const visibleLines = visibleLineCounts({
    isEditing, itemIds: items.map((it) => it.id),
    editingDraftIds: Object.keys(editingDrafts), stagedAdds: addingDrafts.length,
  });
  // Houzs perm gates (mirror the server-side scm.amendment.* keys): the server
  // 403 stays the real gate (its plain-language message is humanised by
  // authed-fetch); these just hide the affordance from users who can't use it.
  const canSupplierConfirm = can('scm.amendment.supplier_confirm');
  const canApproveSo = can('scm.amendment.approve_so');

  /* Phase 1-C — approve-so gate. Re-derives the SO + snapshots the old version
     (SUPPLIER_PENDING → SO_APPROVED). useConfirm guards it; the mutation
     invalidates the SO detail so the banner + Revisions tab refresh. */
  const handleApproveSo = async () => {
    if (!openAmendment) return;
    if (!(await askConfirm({
      title: `Approve SO revision for ${header.doc_no}?`,
      body: 'This applies the supplier-confirmed changes: the Sales Order is re-derived and the '
        + 'current version is snapshotted into Revisions. This cannot be undone.',
      confirmLabel: 'Approve revision',
    }))) return;
    approveSo.mutate({ id: openAmendment.id }, {
      onError: (e) => notify({
        title: 'Could not approve the revision',
        body: e instanceof Error ? e.message : 'Something went wrong.',
        tone: 'error',
      }),
      onSuccess: () => notify({ title: 'SO revision approved' }),
    });
  };

  // Cancel SO flow (Commander 2026-05-29) — a cancelled SO stops proceeding
  // (no PO / DO / production; the whole page greys out) and can be reopened
  // back to CONFIRMED. Cancel is offered only on in-flight statuses (not once
  // it has SHIPPED / been INVOICED / CLOSED — those have downstream docs).
  const isCancelled = header.status === 'CANCELLED';
  /* Owner 2026-07-13 (no-naked-payment-edits) — a DRAFT SO isn't confirmed yet,
     so its payments must ALWAYS be editable (the user is still adjusting), even
     while the detail is in its read-only view. For every other status the
     Payments section stays view-only until the operator clicks Edit. */
  const isDraftSo = (header.status as string) === 'DRAFT';
  /* Payments edit mode — the money's OWN toggle, deliberately not the page's
     Edit mode (owner 2026-08-07, mobile parity). Page Edit is gated by
     `isLocked` (terminal status / downstream DO-SI), which freezes LINES and the
     HEADER because a child document already quotes them. It has no business
     freezing the ledger: the balance is collected ON delivery, i.e. precisely
     when the SO is locked. Only CANCELLED shuts payments — same rule as
     MobileSODetail's `paymentLocked`.
     The no-naked-edits rule (owner 2026-07-13) is unchanged: a submitted SO's
     payments are view-only until the operator opts in here, and a DRAFT skips
     the toggle because it is never confirmed. Page Edit mode still counts as
     opting in, so the existing flow on an unlocked SO is untouched. */
  const canCancel = CANCELLABLE_STATUSES.includes(header.status);
  const canOfferPayEdit  = !isDraftSo && !isCancelled && !isEditing;
  const canEditPayments  = isDraftSo || (!isCancelled && (isEditing || payEditing));

  /* The two exits this PAGE owns, guarded against discarding typed-but-unbooked
     payment rows (owner 2026-08-07). PaymentsTable registers the browser-level
     beforeunload guard itself; these cover the in-app moves react-router 6
     cannot block for us (no data router — see the `beforeBack` prop doc).

     Named the money, not "unsaved changes": an operator who is told "1 payment
     row" knows exactly what is at stake and can decide in one read. */
  const guardUnsavedPayments = async (): Promise<boolean> => {
    if (unsavedPayments === 0) return true;
    return askConfirm({
      title: `Leave ${unsavedPayments} payment row${unsavedPayments === 1 ? '' : 's'} unsaved?`,
      body: `${unsavedPayments === 1 ? 'It has' : 'They have'} not been recorded against this order — `
        + 'the balance stays as it is, and any slip attached to the row is discarded. '
        + 'Press Save on the row to book it.',
      confirmLabel: 'Discard and leave',
      danger: true,
    });
  };

  /* Closing the card with Done unmounts the rows, so it discards exactly what
     leaving the page does. Opening it needs no guard. */
  const togglePayEditing = async () => {
    if (payEditing && !(await guardUnsavedPayments())) return;
    setPayEditing((v) => !v);
  };

  const handleCancelSo = async () => {
    if (!(await askConfirm({
      title: `Cancel ${header.doc_no}?`,
      body: "The SO will stop proceeding — it won't appear in MRP / PO / DO conversion, and line edits lock. You can Reopen it later.",
      confirmLabel: 'Cancel SO', danger: true,
    }))) return;
    updateStatus.mutate({ docNo: header.doc_no, status: 'CANCELLED', expectedStatus: header.status });
  };
  /* Discard draft (owner 2026-07-20) — hard-delete a junk DRAFT (esp. a bad
     scan/OCR draft) instead of burning a doc number on confirm→cancel. Behind the
     house confirm dialog (no naked destructive action); the backend refuses
     anything but a DRAFT. On success the SO is gone, so we leave the page for the
     SO list rather than render a detail for a deleted order. */
  const handleDiscardDraft = async () => {
    if (!(await askConfirm({
      title: `Discard draft ${header.doc_no}?`,
      body: 'This permanently deletes this draft order and everything on it. It cannot be undone. (Confirmed orders are cancelled, not discarded.)',
      confirmLabel: 'Discard draft', danger: true,
    }))) return;
    try {
      await deleteDraft.mutateAsync({ docNo: header.doc_no });
      notify({ title: 'Draft discarded' });
      navigate('/scm/sales-orders');
    } catch (e) {
      notify({
        title: 'Could not discard this draft',
        body: `${e instanceof Error ? e.message : String(e)} Nothing was changed — please try again.`,
        tone: 'error',
      });
    }
  };
  const deliverPrintPdf = (action: PdfAction) => {
    /* Followup #81 — Wait for the payments query before generating; legacy
       header columns (paid_sen, payment_method, …) are deprecated. If
       the query is still loading we surface a brief notice and bail out
       rather than printing a PDF with an empty Payments table.

       2026-07-19 — the guard was keyed on `isLoading` ALONE, which is the exact
       hole the sentence above was written to close. On a FAILED read react-query
       leaves `isLoading` false and `data` undefined, so an errored payments
       fetch fell straight through to `?? []` and printed the customer-facing PDF
       with an empty Payments table — telling the customer they have paid nothing
       and owe the full total. That is reference_houzs_nullish_hides_ignorance on
       a document that leaves the building: "the read failed" rendered as "no
       payments exist". Same class as MobilePOD (#653) and #1158.

       An empty array is an ANSWER (a genuinely unpaid SO prints an empty
       Payments table, correctly). The ABSENCE of an array is not — `data` is set
       only by a successful fetch. So we print only when we actually learned what
       was paid, and say which of the two states we are in, because "still
       loading" and "we asked and failed" need different actions from the
       operator. */
    const paymentRows = printPaymentsQ.data;
    if (!Array.isArray(paymentRows)) {
      if (printPaymentsQ.isFetching) {
        notify({ title: 'Loading payments… please try again in a moment.' });
      } else {
        notify({
          title: 'Cannot print — payments could not be loaded',
          /* authedFetch already runs every non-ok response through humanApiError,
             so this arrives as a plain sentence. Re-mapping it here would be a
             second copy of that rule. */
          body: `${
            printPaymentsQ.error instanceof Error
              ? printPaymentsQ.error.message
              : 'The payment records for this order could not be read.'
          } Printing now would show the customer an empty Payments table.`,
          tone: 'error',
        });
      }
      return;
    }
    const payments = paymentRows;
    /* `pwpCodes` rides on the same GET /:docNo payload — vouchers this SO's
       trigger items issued, so the printed PDF can mark the trigger lines. */
    const pwpCodes = ((detail.data as { pwpCodes?: unknown[] } | undefined)?.pwpCodes ?? []) as never;
    return generateSalesOrderPdf(header, items, payments, action, pwpCodes).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('PDF generation failed:', e);
      notify({
        title: 'PDF generation failed',
        body: `${e instanceof Error ? e.message : 'Something went wrong.'}`,
        tone: 'error',
      });
    });
  };
  /* The hook itself lives above the early returns (see its declaration and why).
     This is the assignment half: every render refreshes the ref with a closure
     over the CURRENT header / items / payments, so Print behaves exactly as it
     did when the hook was created here. */
  deliverPrintPdfRef.current = deliverPrintPdf;

  return (
    /* Commander 2026-05-29 — a CANCELLED SO greys the whole page so it reads
       as dead/inactive. The Cancel/Reopen buttons + banner stay clickable
       (a CSS filter doesn't block pointer events). */
    <div className="space-y-4" style={isCancelled ? { filter: 'grayscale(0.7)' } : undefined}>
      {/* ── Header (shared PageHeader — full-bleed, design-system) ── */}
      <PageHeader back beforeBack={guardUnsavedPayments}
        eyebrow="Sales Order"
        /* Owner 2026-07-16 — 17px document title (see PageHeader.titleSize).
           Scoped to this page; every other page keeps the default h1. */
        titleSize="sm"
        title={`${header.doc_no} — ${header.debtor_name}`}
        /* Owner 2026-07-16 — one meta line, no redundancy: the bare date (the
           "SO date" label said nothing the date didn't), and the "Current
           SO-…" echo only when the SO actually HAS been superseded by a
           different doc no — when it equals this SO it just repeated the
           title. */
        description={
          `${fmtDateOrDash(header.so_date)} · ${header.line_count} ${header.line_count === 1 ? 'line' : 'lines'}`
          + (currentDocNo && currentDocNo !== header.doc_no ? ` · Current ${currentDocNo}` : '')
          + (header.po_doc_no ? ` · Customer PO ${header.po_doc_no}` : '')
          + (header.customer_so_no ? ` · Ref ${header.customer_so_no}` : '')
          + (Number((header as { customer_credit_sen?: number }).customer_credit_sen ?? 0) > 0
            ? ` · Customer credit balance: ${fmtSen(Number((header as { customer_credit_sen?: number }).customer_credit_sen ?? 0))}`
            : '')
        }
        primaryAction={
          /* Owner 2026-07-16 — Back is OUT of the desktop action rail: the
             breadcrumb above ("Sales Orders › SO-…", pushed by the
             useSetBreadcrumbs call at the top of this component) is the back
             affordance there, so a Back button in the rail was the same
             navigation twice.

             It survives BELOW lg because TopNavbar — and with it the whole
             breadcrumb — is `hidden … lg:flex`. `lg:hidden` here is the exact
             complement of that rule, so Back renders precisely where the
             breadcrumb does not. This is NOT dead code on a phone: HOUZS
             swaps to the mobile app under 1024px, but the 2990 host does not
             ("2990 手机关闭" — AuthGate gates mobileEnabled on the company),
             so a 2990 user on a narrow viewport gets this desktop page with
             no breadcrumb and would otherwise have no way back to the list.
             h-9 = the <Button> height (the rail is one flex row — #624). */
          <Link
            to="/scm/sales-orders"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary lg:hidden"
          >
            <ArrowLeft size={14} />
            <span>Back</span>
          </Link>
        }
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Total KPI rail — eyebrow label + KPI-sized value */}
            <div className="mr-1 flex flex-col items-end leading-none">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Total</span>
              <span className="text-[15px] font-semibold tabular-nums text-primary-ink">
                {fmtRm(header.local_total_sen, header.currency)}
              </span>
            </div>
            {(() => {
              const eff = soStatusDisplay(
                header.status,
                (header as { delivery_state?: DeliveryState }).delivery_state,
                (header as { lifecycle_state?: SoLifecycle }).lifecycle_state,
              );
              return (
                <>
                  <span className={`${styles.statusPill} ${STATUS_CLASS[eff.classKey as SoStatus] ?? ''}`}>
                    {eff.label ?? SO_STATUS_LABEL[header.status] ?? header.status.replace(/_/g, ' ')}
                  </span>
                  {/* mig 0324 — the hold marker sits BESIDE the status, never
                      instead of it. Before this change an order that went on
                      hold stopped saying "In Production" anywhere on this page,
                      and the fact was gone from the database too. */}
                  <HoldChip
                    onHold={(header as { on_hold?: boolean | null }).on_hold}
                    reason={(header as { hold_reason?: string | null }).hold_reason}
                  />
                </>
              );
            })()}
            {/* PR-D — History drawer toggle (HOOKKA-style timeline). */}
            <Button variant="ghost" onClick={() => setHistoryOpen(true)}>
              <History {...ICON} />
              <span>History</span>
            </Button>
            {/* Nick 2026-07-09 — shared 5-node Relationship Map (Customer PO
                → SO → DO → GRN → SI), same chain the read-only Detail V2 uses.
                Owner 2026-07-16 — label shortened to "Map"; each of these
                buttons keeps its icon, which is what carries the meaning in a
                7-control rail. */}
            <Button variant="ghost" onClick={() => setRelMapOpen(true)}>
              <Share2 {...ICON} />
              <span>Map</span>
            </Button>
            <Button variant="ghost" onClick={print.openPreview}>
              <Printer {...ICON} />
              <span>Print</span>
            </Button>
            <PrintPreviewModal
              open={print.open}
              onClose={print.close}
              docTitle="Sales Order"
              docNo={header.doc_no}
              rows={[
                { label: 'Customer', value: header.debtor_name || '—' },
                { label: 'Order date', value: fmtDateOrDash(header.so_date) },
                { label: 'Items', value: `${header.line_count} line${header.line_count === 1 ? '' : 's'}` },
                { label: 'Order total', value: fmtRm(header.local_total_sen, header.currency) },
              ]}
              {...print.handlers}
            />
            {/* Cancel SO (Commander 2026-05-29) — stops proceeding; final. */}
            {!isCancelled && canCancel && !isEditing ? (
              <Button variant="ghost"
                onClick={handleCancelSo} disabled={updateStatus.isPending}
                style={{ color: 'var(--c-festive-b, #B8331F)' }}>
                <Ban {...ICON} />
                <span>Cancel SO</span>
              </Button>
            ) : null}
            {/* PR-A — Page-level Edit/Save/Cancel.

                Owner 2026-08-17 — a hard-locked (DO/SI) SO still opens for
                edit when the caller may RE-ATTRIBUTE it. Everything else on
                the page stays disabled: `inputsDisabled` keeps reading
                `locked`, and only the Salesperson select opts out of it (see
                CustomerCard). Without this, handing a delivered order to the
                replacement rep meant clicking Override — which unlocks the
                WHOLE order, addresses and lines included, to change one
                dropdown. The heavy door stays for everything else. */}
            {!isEditing ? (
              <Button variant="primary"
                onClick={enterEdit} disabled={isLocked && !canAttributeOther}>
                <Pencil {...ICON} />
                <span>Edit</span>
              </Button>
            ) : (
              <>
                <Button variant="ghost"
                  onClick={cancelEdit} disabled={updateHeader.isPending || savingOrder}>
                  <span>Cancel</span>
                </Button>
                {/* Phase 1-C — on a processing-locked (PO'd) SO the primary Save
                    SUBMITS AN AMENDMENT instead of writing the lines directly. */}
                {amendmentMode ? (
                  <Button variant="primary"
                    onClick={submitAmendment} disabled={savingOrder || createAmendment.isPending}>
                    <Save {...ICON} />
                    <span>{savingOrder || createAmendment.isPending ? 'Submitting…' : 'Submit amendment request'}</span>
                  </Button>
                ) : (
                  <Button variant="primary"
                    onClick={saveEdit} disabled={updateHeader.isPending || savingOrder}>
                    <Save {...ICON} />
                    <span>{updateHeader.isPending || savingOrder ? 'Saving…' : 'Save'}</span>
                  </Button>
                )}
              </>
            )}
          </div>
        }
      />

      {/* PR-A — Inline error from the page-level Save. Cleared on Edit /
          Cancel / next successful Save. */}
      {saveError && (
        <div className={styles.bannerWarn}>
          <strong>Save failed.</strong>
          <span>{saveError}</span>
        </div>
      )}

      {versionConflict && (
        <SoVersionConflictBanner
          conflict={versionConflict}
          className={styles.bannerWarn}
          saving={savingOrder}
          onReview={() => setHistoryOpen(true)}
          onProceed={() => { if (adoptServerVersion()) (amendmentMode ? submitAmendment : saveEdit)(); }}
        />
      )}

      {/* ── Cancelled banner (Commander 2026-05-29) ─────────────── */}
      {isCancelled ? (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)',
          background: 'rgba(184, 51, 31, 0.10)',
          border: '1px solid var(--c-festive-b, #B8331F)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--fs-13)',
        }}>
          <span style={LOCK_BANNER_INNER_STYLE}>
            <Ban {...ICON} />
            <span>This SO is <strong>cancelled</strong> — it won't proceed (no MRP / PO / DO / production).</span>
          </span>
        </div>
      ) : null}

      {/* ── DRAFT banner + Confirm (DRAFT flow) ─────────────────────
          Scanned / auto-generated SOs land as DRAFT (excluded from
          KPI / MRP / PO / DO) so the operator can review + correct first.
          Confirming flips DRAFT → CONFIRMED via the status mutation, which
          invalidates the SO detail + list queries so the page updates.
          `header.status` is typed to the post-0078 enum (no DRAFT), so the
          stored value is read off a string view for the comparison. */}
      {(header.status as string) === 'DRAFT' && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)',
          background: 'rgba(232, 107, 58, 0.08)',
          border: '1px solid var(--c-orange)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--fs-13)',
        }}>
          <span style={LOCK_BANNER_INNER_STYLE}>
            <FileText {...ICON} />
            <span>
              <strong>Draft — not yet confirmed.</strong>{' '}
              Review and Confirm to make it a live order (it stays out of MRP / PO / DO until then).
            </span>
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {/* Discard draft — the escape hatch for a junk draft (esp. a bad
                scan/OCR draft). Secondary + red so it never competes with
                Confirm; behind the house confirm dialog. Backend refuses anything
                but a DRAFT. */}
            <Button variant="ghost"
              onClick={handleDiscardDraft}
              disabled={deleteDraft.isPending || updateStatus.isPending}
              style={{ color: 'var(--c-festive-b, #B8331F)' }}>
              <Trash2 {...ICON} />
              <span>{deleteDraft.isPending ? 'Discarding…' : 'Discard draft'}</span>
            </Button>
            <Button variant="primary"
              onClick={async () => {
                if (!(await askConfirm({
                  title: `Confirm ${header.doc_no}?`,
                  body: 'This turns the draft into a live, confirmed sales order — it will appear in MRP / PO / DO flows and KPIs.',
                  confirmLabel: 'Confirm Order',
                }))) return;
                updateStatus.mutate({ docNo: header.doc_no, status: 'CONFIRMED', expectedStatus: header.status });
              }}
              disabled={updateStatus.isPending || deleteDraft.isPending}>
              <span>{updateStatus.isPending ? 'Confirming…' : 'Confirm Order'}</span>
            </Button>
          </div>
        </div>
      )}

      {/* ── Lock banner ─────────────────────────────────────────── */}
      {!isCancelled && LOCKED_STATUSES.includes(header.status) && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)',
          background: unlockOverride ? 'rgba(184, 51, 31, 0.06)' : 'rgba(232, 107, 58, 0.08)',
          border: `1px solid ${unlockOverride ? 'var(--c-festive-b, #B8331F)' : 'var(--c-orange)'}`,
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--fs-13)',
        }}>
          <span style={LOCK_BANNER_INNER_STYLE}>
            <Lock {...ICON} />
            {unlockOverride
              ? <strong>Edit-lock overridden — changes are tracked in the status timeline below.</strong>
              : <>This SO is <strong>{header.status.replace(/_/g, ' ')}</strong>. Line item edits + addresses are locked. Click <em>Override</em> if you must change something.</>}
          </span>
          <Button variant={unlockOverride ? 'ghost' : 'primary'}
            onClick={async () => {
              if (!unlockOverride) {
                const reason = await askPrompt({
                  title: 'Reason for override?',
                  body: 'This unlocks editing on a locked SO. The override is tracked in the status timeline.',
                  placeholder: 'At least 10 characters',
                  multiline: true,
                  confirmLabel: 'Override',
                  validate: (v) => (v.trim().length < 10 ? 'Override needs a reason ≥ 10 chars.' : null),
                });
                if (reason == null) return;
                // Audit the override via a status change row (we re-affirm the
                // current status with an OVERRIDE notes prefix).
                updateStatus.mutate({ docNo: header.doc_no, status: header.status, expectedStatus: header.status });
                setUnlockOverride(true);
              } else {
                setUnlockOverride(false);
              }
            }}>
            {unlockOverride ? 'Re-lock' : 'Override'}
          </Button>
        </div>
      )}

      {/* ── Amendment-mode banner (Phase 1-C) ─────────────────────────
          The SO is processing-locked (already PO'd) but still editable via the
          amendment flow. Explain that Save here submits an amendment, not a
          direct edit. Only shown when there's no open amendment already. */}
      {amendmentMode && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: 'var(--space-3) var(--space-4)',
          background: 'rgba(232, 107, 58, 0.08)',
          border: '1px solid var(--c-orange)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--fs-13)',
        }}>
          <Lock {...ICON} />
          {/* Shared copy — both surfaces were wrong about addresses. */}
          <span>{AMENDMENT_MODE_BANNER}</span>
        </div>
      )}

      {/* ── Amendment-pending banner (Phase 1-C) ──────────────────────
          An amendment is in flight. Show its status pill + the gate actions,
          gated by permission AND the amendment's current state, plus a "view
          changes" link opening the before/after diff. */}
      {openAmendments.map((oa) => (
        <div key={oa.id} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: 'var(--space-3)',
          padding: 'var(--space-3) var(--space-4)',
          background: 'rgba(214, 158, 46, 0.14)',
          border: '1px solid rgba(214, 158, 46, 0.55)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--fs-13)',
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <History {...ICON} />
            <span>Amendment <strong>{oa.amendment_no}</strong> pending</span>
            <StatusPill docType={oa.lane ? 'soAmendmentLane' : 'soAmendment'} status={oa.status} />
            {/* Two-lane rework: say WHO it is waiting on. */}
            {(oa.lane === 'LINES' || oa.lane === 'DELIVERY') && (
              <span style={{ color: 'var(--fg-muted)' }}>
                waiting for {oa.lane === 'LINES' ? 'Purchasing' : 'Logistics'}
              </span>
            )}
            <button type="button"
              onClick={() => setViewingAmendmentId(oa.id)}
              style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: 'var(--c-burnt)', fontWeight: 600, fontSize: 'var(--fs-13)',
                textDecoration: 'underline',
              }}>
              view changes
            </button>
          </span>
          {/* Lane rows approve on the Amendment detail page (one signature);
              the inline gates below are the LEGACY chain's only. */}
          {oa.lane == null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {/* Record supplier confirmation — only at REQUESTED, gated on perm */}
              {oa.status === 'REQUESTED' && canSupplierConfirm && (
                <Button variant="primary"
                  onClick={() => setShowSupplierForm((v) => !v)}
                  disabled={supplierConfirm.isPending}>
                  <Check {...ICON} />
                  <span>Record supplier confirmation</span>
                </Button>
              )}
              {/* Approve SO revision — only at SUPPLIER_PENDING, gated on perm */}
              {oa.status === 'SUPPLIER_PENDING' && canApproveSo && (
                <Button variant="primary"
                  onClick={handleApproveSo} disabled={approveSo.isPending}>
                  <Check {...ICON} />
                  <span>Approve SO revision</span>
                </Button>
              )}
            </span>
          )}
          {/* Inline supplier-confirmation form (ref + note + attachment key) */}
          {oa.lane == null && showSupplierForm && oa.status === 'REQUESTED' && canSupplierConfirm && (
            <div style={{ flexBasis: '100%' }}>
              <SupplierConfirmForm
                amendmentId={oa.id}
                onDone={() => setShowSupplierForm(false)}
              />
            </div>
          )}
        </div>
      ))}

      {/* ── Tab strip (Phase 1-C) — Order vs Revisions ────────────────
          The Revisions tab lists prior SO snapshots read-only. Default is the
          Order view so nothing changes for never-amended SOs. */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--line)' }}>
        {(['order', 'revisions'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setActiveTab(t)}
            style={{
              padding: '8px 16px', border: 'none', background: 'none', cursor: 'pointer',
              fontSize: 'var(--fs-13)', fontWeight: 600,
              color: activeTab === t ? 'var(--c-burnt)' : 'var(--fg-muted)',
              borderBottom: `2px solid ${activeTab === t ? 'var(--c-burnt)' : 'transparent'}`,
              marginBottom: -1,
            }}>
            {t === 'order' ? 'Order' : 'Revisions'}
          </button>
        ))}
      </div>

      {activeTab === 'revisions' ? (
        <RevisionsTab docNo={header.doc_no} currency={header.currency} />
      ) : (
      <>
      {/* ── Customer info ───────────────────────────────────────── */}
      <CustomerCard
        ref={customerCardRef}
        header={header}
        onSave={handleHeaderSave}
        saving={updateHeader.isPending}
        locked={isLocked}
        isEditing={isEditing}
        amendmentMode={amendmentMode}
        onDeliveryDateChange={cascadeDeliveryDateToLines}
      />

      {/* PR #140 — Commander 2026-05-26: "这个 multi address、customer PO
          这些是什么？" The Multi-Address · Customer PO · Schedule card was
          a HOOKKA leftover (ship-to / bill-to / install-to / customer PO
          No / PO ID / PO Date). We don't model 3-way addresses or track
          the customer's own PO numbers. Dropped entirely; Processing
          Date + Delivery Date now live inside the Customer card below. */}

      {/* ── Line items ──────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          {/* Owner 2026-08-16 — "LINE ITEMS (2)" over three rows made the new row
              look unreal. Counts what is RENDERED now (visibleLineCounts), and
              says how many are unsaved: a count including staged work must say so. */}
          <h2 className={styles.cardTitle}>
            Line Items ({visibleLines.total})
            {addingDrafts.length > 0 && (
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.04em', color: '#a6471e' }}>
                {addingDrafts.length} new · not saved yet
              </span>
            )}
          </h2>
          {/* PR-A — Add Line Item is only shown in edit mode.
              Task #80 — clicking seeds one more inline SoLineCard at the bottom of
              the table (no more modal). It used to hide itself while a draft was
              open, capping an edit session at ONE new line (owner 2026-08-16: "it
              should be able to keep adding lines"). `linesLocked` still refuses. */}
          {isEditing && (
            <Button variant="primary" onClick={startAddLine} disabled={linesLocked}>
              <Plus {...ICON} />
              <span>Add Line Item</span>
            </Button>
          )}
        </header>

        {items.length === 0 && !isEditing ? (
          <p className={styles.emptyRow}>No items yet — click "Edit" then "Add Line Item" to begin.</p>
        ) : isEditing ? (
          /* Whole-order inline edit — every line is an inline SoLineCard
             editor and all are editable at once. There is no per-row Save /
             Cancel anymore: the ONE page-level Save in the header commits the
             header + every line draft (+ any new add-draft) together. Each
             row keeps a small action bar with Override price ($) + Remove,
             since those operate on a single line. The add-draft (if open)
             renders as one more card at the bottom. */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-3)' }}>
            {items.map((it, idx) => {
              const editDraft = editingDrafts[it.id];
              // A freshly-deleted row drops its draft (removeEditingLine) but
              // lingers in `items` until the re-fetch — skip rendering it.
              if (!editDraft) return null;
              const cb = rowCallbacks.get(it.id);
              return (
                <div key={it.id}>
                  {/* Per-line action — Override price ($). Removal is handled
                      by the SoLineCard's own trash button (onRemove → delete
                      mutation), so it isn't duplicated here. Override is a
                      single-line audited operation that the inline card
                      doesn't expose, so it stays in this small action bar. */}
                  <div className={styles.actionsCell} style={{ marginBottom: 'var(--space-2)' }}>
                    {/* Override price writes DIRECTLY to the per-line override
                        route, which the server 409s on a processing-locked SO —
                        so it stays gated on the raw lock, not on `linesLocked`
                        (which now opens in amendment mode). A price change on a
                        locked SO goes through the amendment's line diff instead,
                        which carries newUnitPriceSen. Off, not render-then-deny. */}
                    <button type="button" className={styles.iconBtn} title="Override price"
                      disabled={overrideLocked}
                      onClick={() => !overrideLocked && setOverriding(it)}>
                      <DollarSign {...SM_ICON} />
                    </button>
                  </div>
                  <SoLineCard
                    index={idx}
                    draft={editDraft}
                    onChange={cb?.onChange ?? ((patch) => patchEditingDraft(it.id, patch))}
                    onRemove={cb?.onRemove ?? (() => removeEditingLine(it.id))}
                    canRemove={!linesLocked}
                    /* PR-F (#79) wiring — enable photo upload on already-saved
                       lines. New lines (addingDraft) have no itemId yet so
                       their photos defer to after the first save. */
                    docNo={header.doc_no}
                    itemId={it.id}
                    isEditing={!linesLocked}
                    /* Variants are mandatory only once a Processing Date is set
                       (matches this page's Save gate + the backend), so the ` *`
                       marker + red ring stay off on a no-date draft (owner
                       2026-07-14). */
                    variantsRequired={requireVariants}
                  />
                </div>
              );
            })}

            {/* New lines — as many as the operator asks for, each with its own ADD
                idempotency key, all committed by the page-level Save. The caption is
                the "visibly staged" half of the count fix: the row number continues
                the table, so a staged card would otherwise look like a saved one. */}
            {addingDrafts.map((staged, i) => {
              const cb = addCallbacks.get(staged.key);
              return (
                <div key={staged.key}>
                  <div className={styles.actionsCell} style={{ marginBottom: 'var(--space-2)' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: '#a6471e' }}>
                      {stagedAddLabel(i + 1)} — not saved yet
                    </span>
                  </div>
                  <SoLineCard
                    index={visibleLines.persisted + i}
                    draft={staged.draft}
                    onChange={cb?.onChange ?? ((patch) => patchAddingDraft(staged.key, patch))}
                    onRemove={cb?.onRemove ?? (() => cancelAddLine(staged.key))}
                    canRemove={true}
                    variantsRequired={requireVariants}
                  />
                </div>
              );
            })}

            {items.length === 0 && addingDrafts.length === 0 && (
              <p className={styles.emptyRow} style={{ padding: 'var(--space-3)' }}>
                No items yet — click "Add Line Item" above to begin.
              </p>
            )}
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              {/* PR #144 — Group column removed ("group是什么 删掉").
                  Category is already visible as a colored badge inside
                  the item's variant pills, so the raw "mfg_product"
                  internal kind isn't useful in the table view. */}
              <tr>
                <th>Item</th>
                <th>Description 2</th>
                <th className={styles.tableRight}>Qty</th>
                <th>Transfer To</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Disc</th>
                {/* PR-E — Per-line delivery date. Falls back to the SO
                    header date when the line hasn't been overridden. */}
                <th className={styles.tableRight}>Delivery</th>
                <th className={styles.tableRight}>Total</th>
                {/* Owner 2026-07-17: per-line Unit Cost / Line Cost / Margin
                    columns removed from the SO document view for EVERYONE —
                    costing moves to the separate Finance "Fulfillment Costing"
                    module. Customer-facing columns (Unit / Disc / Total) stay. */}
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                /* PR-E — Display fallback: a line whose own date is null
                   AND that hasn't been overridden displays the SO header's
                   customer_delivery_date with a small "· auto" marker. The
                   API cascade keeps line_delivery_date populated for
                   non-overridden lines after each header save, so this
                   fallback mostly serves rows from before migration 0074
                   landed. */
                const displayDate = it.line_delivery_date
                  ?? (!it.line_delivery_date_overridden ? header.customer_delivery_date : null);
                const isAuto = !it.line_delivery_date_overridden;
                return (
                <tr key={it.id}>
                  <td>
                    {/* Description ONCE, code NOT displayed — the shared rule
                        (vendor/shared/line-identity.ts). The code still BINDS:
                        it is this row's key, its search/export value and what
                        the PO/PDF carry. No variant is passed because this table
                        gives the variant summary its OWN "Description 2" column
                        below — feeding it here would re-create the duplicate. */}
                    <div className={styles.codeCell}>
                      {lineIdentity({ code: it.item_code, description: it.description }).primary || '—'}
                    </div>
                    {it.remark && (
                      <div className={styles.muted} style={{ fontStyle: 'italic' }}>
                        Remark: {it.remark}
                      </div>
                    )}
                  </td>
                  {/* Commander 2026-05-28 — "Description 2": the HOOKKA-style
                      one-line variant/spec summary in its own column.
                      Commander 2026-06-16 — recompute the summary LIVE from
                      `variants` (the source of truth) and fall back to the stored
                      description2 only when there's nothing to recompute. This
                      mirrors composeSoLineDescription (so-line-description.ts:34)
                      and the Convert-From pickers (VariantDescription.tsx:30) so
                      the VIEW table, the SO PDF, and the PO all show the SAME
                      line. Older rows carried a STALE stored description2 (written
                      before the remark/RM display fixes) that made this VIEW
                      disagree with what the PO printed. */}
                  <td data-label="Description 2">
                    {(() => {
                      const live = buildVariantSummary(it.item_group, it.variants);
                      const desc2 = live || (it.description2 ?? '').trim();
                      return desc2
                        ? <span>{desc2}</span>
                        : <span className={styles.muted}>—</span>;
                    })()}
                  </td>
                  <td className={styles.tableRight} data-label="Qty">{it.qty}</td>
                  <td data-label="Transfer To">
                    {(() => {
                      const hasDeliveries = it.deliveries && it.deliveries.length > 0;
                      /* Which supplier PO supplied this line's goods — the ONE
                         shared SO-source renderer (SoSourceChips): shipped
                         batch trail (survives delivery, Owner 2026-07-11) →
                         STOCK ADJ → READY FIFO projection → incoming MRP
                         coverage PO + ETA (owner 2026-08-01: identical data on
                         every surface). */
                      const hasTrace = (it.shipped_source_pos?.length ?? 0) > 0
                        || it.shipped_source_adj
                        || (it.ready_source_pos?.length ?? 0) > 0
                        || Boolean(it.coverage_po);
                      const coverage = hasTrace
                        ? (
                          <div style={{ display: 'inline-block', marginTop: hasDeliveries ? 3 : 0 }}>
                            <SoSourceChips line={it} coverage="ready" />
                          </div>
                        )
                        : null;
                      if (hasDeliveries) {
                        return (
                          <div>
                            {it.deliveries!.map((d, di) => (
                              <div key={di} style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                                {d.doNumber} <span className={styles.muted} style={{ fontWeight: 400 }}>×{d.qty}</span>
                              </div>
                            ))}
                            {typeof it.remaining_qty === 'number' && (
                              <div style={{
                                fontSize: 'var(--fs-11)', marginTop: 1,
                                color: it.remaining_qty > 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--c-secondary-a, #2F5D4F)',
                              }}>
                                {it.remaining_qty > 0 ? `Balance ${it.remaining_qty}` : 'Fully delivered'}
                              </div>
                            )}
                            {coverage}
                          </div>
                        );
                      }
                      return coverage ?? <span className={styles.muted}>—</span>;
                    })()}
                  </td>
                  <td className={styles.tableRight} data-label="Unit">{fmtRm(it.unit_price_sen, header.currency)}</td>
                  <td className={styles.tableRight} data-label="Disc">{it.discount_sen > 0 ? fmtRm(it.discount_sen, header.currency) : '—'}</td>
                  <td className={styles.tableRight} data-label="Delivery">
                    {displayDate ? (
                      <span style={isAuto ? { color: 'var(--fg-muted)' } : undefined}>
                        {fmtDateOrDash(displayDate)}
                        {isAuto && (
                          <span style={{ marginLeft: 4, color: 'var(--c-orange)', fontSize: 'var(--fs-11)' }}>· auto</span>
                        )}
                      </span>
                    ) : '—'}
                  </td>
                  <td className={styles.priceCell} data-label="Total">{fmtRm(it.total_sen, header.currency)}</td>
                  {/* Owner 2026-07-17: per-line Unit Cost / Line Cost / Margin
                      cells removed for EVERYONE (see the <thead> note). */}
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Owner 2026-07-17: the Totals·Margin (Revenue / Cost / Margin / Margin%
          + per-category breakdown) card is removed from the SO document view
          for EVERYONE — including directors — because costing moves to the
          separate Finance "Fulfillment Costing" module. This is the legacy
          `?edit=1` editor reached from SalesOrderDetailV2's Edit button; the
          read-only V2 view had its own copy of the card removed too. The
          customer-facing Order Total section above is untouched. */}

      {/* ── Payment — Houzs-pattern transactions table ────────────── */}
      {/* Commander 2026-05-27: "Payment 也 follow Hookka 那个排版". Verbatim
          port of houzs-erp/src/components/NewSalesOrderForm.tsx Payments
          block (lines 1047-1126). Subtotal / Expected Deposit dropped —
          Houzs doesn't have them, and commander wants the ledger view
          (transactions + Deposit Paid + Balance) only.
          Task #105 — PaymentCard was extracted into <PaymentsTable> so
          New SO and Edit SO render the same ledger from one source. */}
      {/* No-naked-payment-edits (owner 2026-07-13): Add / Delete / Edit are only
          exposed when (SO is DRAFT) OR (the detail is in Edit mode). A DRAFT SO
          is never confirmed, so its payments stay editable in the read-only view
          too (draftUnlocked also lifts the per-row same-day EDIT lock). */}
      {/* Owner 2026-07-17: "delivered了之後也要可以key payment". This used to pass
          `isLocked`, which is `LOCKED_STATUSES.includes(status) || hasChildren`
          — and DELIVERED is in that list, and a delivered SO has a DO, so a
          delivered order's payments were frozen twice over and Edit mode could
          not lift either. That contradicted this page's own rule three comments
          up ("PAYMENT and every other customer field stay editable") and the
          backend, which never gated POST /:docNo/payments on status at all.
          isLocked is the LINE/HEADER lock: those freeze because a DO/SI already
          quotes them. Money is not a line. Collecting the balance ON delivery is
          the normal case — that is what a Balance figure is FOR. Only CANCELLED
          stays shut (a cancelled order takes no money); the no-naked-edits rule
          is unchanged, so it is still Edit-then-type for everything but DRAFT. */}
      {/* Owner 2026-08-07 — the paragraph above says what this page MEANT to do,
          and mobile has done since 7-17 (MobileSODetail `paymentLocked =
          rawStatus === "CANCELLED"` + its own in-card Edit toggle). Desktop
          never got there: `locked` dropped `isLocked` but replaced it with
          `!isEditing`, and PAGE Edit mode is reached through a button that is
          itself `disabled={isLocked}` (see the header Button). So on a
          delivered SO — the exact order a balance gets collected on — the
          operator could not enter Edit, could not Add Payment, and had nowhere
          to put the balance-payment proof. The lock was simply reached through
          a second door.
          Fix mirrors mobile rather than inventing a third rule: payments carry
          their OWN edit toggle (`payEditing`), independent of the page-level
          Edit mode that the line/header lock owns. "電話電腦的權限應該一樣的". */}
      {paymentRetryDrafts.length > 0 && (
        <div className={styles.bannerWarn} role="status">
          This order exists, but {paymentRetryDrafts.length} payment row{paymentRetryDrafts.length === 1 ? '' : 's'} were not confirmed saved.
          The rows below are a temporary retry copy; save each payment to confirm it on the server.
        </div>
      )}
      <PaymentsTable
        key={header.doc_no}
        docNo={header.doc_no}
        grandTotalSen={header.local_total_sen}
        currency={header.currency}
        locked={!canEditPayments}
        draftUnlocked={isDraftSo}
        slip={{ slipKey: header.slip_key, fetcher: fetchSoSlipUrl }}
        defaultCollectedBy={selfStaffMatch?.id ?? ''}
        initialDrafts={paymentRetryDrafts}
        onDraftCommitted={paymentRetryCommitted}
        onUnsavedChange={setUnsavedPayments}
        onRegisterCommitAll={(fn) => { commitPaymentsRef.current = fn; }}
        headerAction={canOfferPayEdit ? (
          <Button variant="ghost" onClick={() => { void togglePayEditing(); }}>
            {payEditing ? <span>Done</span> : <><Pencil {...ICON} /><span>Edit payments</span></>}
          </Button>
        ) : null}
      />

      {/* ── CUSTOMER SIGNATURE — moved directly below Payments (Wei Siang
          2026-06-06). Read-only proof captured on the POS handover pad; only
          shown when the SO carries one (POS orders). */}
      {header.signature_b64 && (
        <section className={styles.card}>
          <header className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Customer Signature</h2>
          </header>
          <div className={styles.cardBody}>
            <img
              src={header.signature_b64}
              alt="Customer signature captured at handover"
              style={{ maxWidth: 360, width: '100%', height: 'auto', border: '1px solid var(--c-line, #E5E1DC)', borderRadius: 8, background: '#fff' }}
            />
          </div>
        </section>
      )}

      {/* ── ORIGINAL SLIP (migration 0033) — the handwritten order-slip photo
          this SO was scanned from, kept as proof. Dual-read camelCase ??
          snake_case (the pg driver camelCases result columns).

          Owner 2026-07-16 ("payment receipt 已經在第二章照片了 第一個照片可以
          delete了") — the standalone PAYMENT RECEIPT card (receipt_image_key,
          mig 0034) that used to sit beside this one is GONE. It rendered the
          same card-terminal image the Payments table above already shows in
          its Slip column: since 2026-07-15 the scan-seeded deposit is inserted
          with `slip_key: slipKey ?? receiptImageKey`, so the receipt IS the
          payment row's proof, and split-payment rows each carry their own
          uploaded slip. Showing it twice on one page was the duplicate.

          This is a DESKTOP-ONLY fix: mobile already made exactly this call on
          2026-07-04 — MobileSODetail's scanned-photos card is hard-wired to
          `receiptKey={null}` with the note "the payment RECEIPT does NOT
          belong in this card -- it lives on its payment row's slip". Desktop
          was the drift; it now follows.

          The ORDER SLIP stays: it is the customer's handwritten slip, a
          different document that appears nowhere else on the page. */}
      {(() => {
        const slipImageKey =
          (header as unknown as { slipImageKey?: string | null }).slipImageKey ?? header.slip_image_key;
        if (!slipImageKey) return null;
        return (
          <ScannedImageCard
            imageKey={slipImageKey}
            title="Order Slip"
            alt="Original handwritten sale-order slip"
          />
        );
      })()}

      {/* ── Variant-completeness banner ─────────────────────────────
          PR #144 + #156 gating rule kept as a read-only warning. The
          "Move to next stage" pill strip below it (commander 2026-05-27:
          "这个不需要") was removed — status transitions now flow through
          the Edit/Save path or the API directly, while this banner stays
          so the Order Coordinator still sees which lines are incomplete
          when a Processing Date is set. updateStatus is still wired for
          the lock-override flow above. */}
      {incompleteVariantLines.length > 0 && (
        <div style={VARIANT_WARN_BANNER_STYLE}>
          <strong>Processing Date is set — line variants must be filled before next stage.</strong>
          <div style={VARIANT_WARN_LIST_STYLE}>
            {incompleteVariantLines.map((l, i) => (
              <div key={i}>
                • <code>{l.code}</code> ({l.group}): {formatGroupRequirements(l.group)}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Followup #85 — the standalone StatusTimeline + PriceOverridePanel
          audit cards were superseded by the PR-D History drawer, which
          shows ALL action types (CREATE / UPDATE_DETAILS / UPDATE_STATUS /
          ADD_LINE / UPDATE_LINE / DELETE_LINE / ADD_PAYMENT / …) in one
          unified feed. The underlying mfg_so_status_changes and
          mfg_so_price_overrides tables stay (writes continue), so old
          data remains queryable — only the rendering is removed. */}
      </>
      )}

      {/* ── Modals ─────────────────────────────────────────────── */}
      {/* Task #80 — LineItemModal removed (deleted with PR #125's inline
          SoLineCard work). Both Add + Edit now use inline SoLineCard rows
          inside the line-items table above. */}
      {overriding && (
        <OverridePriceModal
          item={overriding}
          docNo={header.doc_no}
          currency={header.currency}
          onClose={() => setOverriding(null)}
        />
      )}

      {/* Phase 1-C — Amendment before/after diff modal ("view changes"). */}
      {viewingAmendmentId && (
        <AmendmentDiffModal
          amendmentId={viewingAmendmentId}
          currency={header.currency}
          onClose={() => setViewingAmendmentId(null)}
        />
      )}

      {/* PR-D — History drawer ─────────────────────────────────── */}
      {historyOpen && (
        <HistoryPanel docNo={header.doc_no} onClose={closeHistory} />
      )}

      {/* Nick 2026-07-09 — Relationship Map (5-node chain). Chain + destinations
          come from the SHARED hook, same as the V2 read-only page: this copy used
          to hard-code every downstream node to "Not created" and no-op every
          click, so on the page an operator amends an order from, the map lied and
          nothing responded. */}
      <DocumentRelationshipMapModal
        open={relMapOpen}
        onClose={() => setRelMapOpen(false)}
        nodes={chainNodes}
        onNodeClick={(n) => {
          // Close only when the click actually navigated away; an in-app notice
          // must render OVER the map, not dismiss it.
          if (onChainNodeClick(n)) setRelMapOpen(false);
        }}
        amendments={chainAmendments}
        onAmendmentClick={(a) => {
          if (onChainAmendmentClick(a)) setRelMapOpen(false);
        }}
        pairing={chainPairing}
      />
      {/* A chain slot standing for several documents opens this chooser instead
          of a notice that only named them. Picking a row navigates, so the map
          closes with it. */}
      <DocumentChoiceDialog
        prompt={chainChoice}
        onClose={closeChainChoice}
        onPick={(d) => {
          setRelMapOpen(false);
          pickChainChoice(d);
        }}
      />
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Customer info card — editable, with debtor autocomplete
   ════════════════════════════════════════════════════════════════════════ */

/* PR-A — Imperative handle for the page-level Edit/Save framework.
   The parent calls save() with onSuccess/onError callbacks; reset() reverts
   the local form to the current header snapshot (used by Cancel). */
type CustomerCardHandle = {
  /** Returns the first blocking header error (date XOR / past date), or null
      when the header is OK. Called by the page Save BEFORE any line is written
      so a bad date never half-commits the order. */
  validate: () => string | null;
  /** `keepLockedColsAsOriginal` (amendment mode) — send every FROZEN header
      column at its ORIGINAL value so this direct PATCH stays inside the server's
      field-scoped processing lock, while the customer's contact details and note
      in the same payload still save immediately. The changed frozen values ride
      the amendment instead (getLockedHeaderChanges below). NOT address lines:
      they joined the CONTROLLED set 2026-07-27 and ride the amendment too. */
  save: (
    // `raw` (optional 2nd arg) carries the original Error, whose `.body` holds
    // the server's aggregated `problems` list — so the page Save can show EVERY
    // reason at once (owner 2026-07-18), not just the first line.
    cb: { onSuccess: () => void; onError: (msg: string, raw?: unknown) => void },
    opts?: { keepLockedColsAsOriginal?: boolean },
  ) => void;
  reset: () => void;
  /** Owner 2026-06-03 — current (possibly edited) phone value, so the page
      Save can enforce the compulsory-phone rule before any write, mirroring
      the New SO guard. */
  getPhone: () => string;
  /** Owner 2026-07-16 — the FROZEN header fields this edit changed (Delivery
      Date / Processing Date / State / Postcode), for the amendment payload.
      Empty when the operator only touched directly-editable fields. */
  getLockedHeaderChanges: () => {
    changes: SoAmendmentHeaderChanges;
    oldSnapshot: SoAmendmentHeaderChanges;
  };
  /** Is the DIRECT half dirty? Tells "nothing to submit" apart from "nothing
      needs APPROVAL" — the two the old single return could not. */
  hasDirectHeaderChanges: () => boolean;
};

type CustomerCardProps = {
  header: SoHeader;
  /** PR-A — Optional callbacks let the parent's page-level Save flow know
      when the mutation succeeded or failed, so it can return to read-only /
      surface an inline error. The per-card Save button (legacy) still works
      without callbacks. */
  onSave: (
    patch: Record<string, unknown>,
    cb?: { onSuccess?: () => void; onError?: (msg: string, raw?: unknown) => void },
  ) => void;
  saving: boolean;
  /** When true, disable input editing — accepted but consumer must show
      the visual lock. We keep the prop optional so existing call sites
      compile. */
  locked?: boolean;
  /** PR-A — Page-level edit mode. When false (default), every input in this
      card is disabled and the per-card Save button is hidden — the parent
      page renders Edit/Save/Cancel in its own header. */
  isEditing?: boolean;
  /** Owner 2026-07-16 — the SO is processing-locked but amendment-eligible, so
      the page's primary action SUBMITS AN AMENDMENT. The frozen fields
      (Processing Date / State / Postcode) must therefore be EDITABLE here: an
      amendment is precisely the sanctioned way to change them, and disabling
      the input made the one supported channel unusable. They don't save
      directly — submitAmendment routes them through the approval flow. */
  amendmentMode?: boolean;
  /** Fix A — Live header→line cascade. Fires on every keystroke of the
      Delivery Date input (not just Save) so the parent can immediately push
      the new date into every line that hasn't been manually overridden. The
      parent owns the line drafts, so the card just reports the new value. */
  onDeliveryDateChange?: (date: string) => void;
};

/* Task #99 (UI perf) — Wrap the CustomerCard in memo so parent page state
   churn (Edit-mode toggle, History drawer, line-item edits) doesn't
   re-render the full address-cascade tree. Combined with the `onSave`
   useCallback in the page below + the debtor-search debounce, this is the
   biggest single saving on the Detail page. */
const CustomerCardInner = forwardRef<CustomerCardHandle, CustomerCardProps>(({
  header,
  onSave,
  /* PR-A — `saving` prop kept on the type for compatibility but the
     per-card Save button it drove was removed. The page-level Save in
     SalesOrderDetail's header now surfaces the in-flight spinner. */
  saving: _saving,
  locked = false,
  isEditing = false,
  amendmentMode = false,
  onDeliveryDateChange,
}, ref) => {
  // PR #39 — POS-aligned customer + address form. Maps:
  //   • address1, address2 → free-text lines (POS "Address line 1/2")
  //   • address3           → city (cascade from localities)
  //   • address4           → postcode (cascade from city)
  //   • customer_state     → state (cascade source — PR #35 column)
  //   • venue              → reused for Building Type (POS dropdown)
  // Agent + Branding kept (B2B-specific, commander 2026-05-26).
  // POS field "Salesperson" → Agent column on the SO.
  const notify = useNotify();
  const localities = useLocalities();
  const localityRows = useMemo(() => localities.data ?? [], [localities.data]);
  /* PICKER: the salesperson SELECTION dropdown — scoped to the active company
     via the Team-grant rule (usePickableStaff). The self-resolution copy above
     (for the Collected-By default) stays on the FULL useStaff roster; only the
     list of people you can PICK is company-scoped. */
  /* `include` carries the salesperson already ON this document, so someone the
     onlySales narrowing hides is still named. "(former staff)" below is then
     only reachable for a row that genuinely is gone. */
  const staffQ = usePickableStaff({ onlySales: true, include: [header.salesperson_id] });
  const staffList = (staffQ.data ?? []).filter((s) => s.active);
  /* Commander 2026-05-27: Venue is locked to the picked salesperson's
     staff.venue_id; only admin / sales_director may swap the salesperson.
     useVenues drives the read-only Venue input's display name. */
  const { can } = useHouzsAuth();
  const venuesQ = useVenues();
  /* Commander 2026-05-27 ("delivery 一点没有跟着跳"): Sales Location no longer
     just mirrors header.sales_location. When the user picks a delivery state
     we look up state_warehouse_mappings and auto-populate the field with the
     mapped warehouse code. The user can still leave it blank (no mapping
     exists for that state) or manually override on Maintenance. */
  const stateWarehousesQ = useStateWarehouseMappings();
  // Houzs-flavoured: gate on the flat permission key `scm.so.attribute_other`
  // (the 2990 bridge always reports either super_admin or sales). Owner + IT
  // Admin pass via `*`; grant to other positions via Team > Positions.
  const canChangeSalesperson = can('scm.so.attribute_other');
  /* Remove-Processing-Date gate (Owner 2026-07-09, port of 2990 #717) —
     clearing a SET Processing Date pulls the SO back out of the Proceed lane,
     so it is admin-level only. 2990 gates on staff.role === 'super_admin';
     Houzs has no live staff_role (the SCM bridge pins every caller to one
     super_admin row), so mirror the API and gate on the flat permission key
     the PATCH enforces (mfg-sales-orders.ts). Owner + IT Admin pass via `*`. */
  const canRemoveProcessingDate = can('scm.so.remove_processing_date');

  /* Task #118 — DB-backed dropdowns (was hardcoded). Falls back to the
     migration 0081 seed list when loading or when the DB has zero rows
     so commander never sees an empty select on this page. */
  const customerTypeOptsQ = useSoDropdownOptions('customer_type');
  const buildingTypeOptsQ = useSoDropdownOptions('building_type');
  const relationshipOptsQ = useSoDropdownOptions('relationship');
  const customerTypeOpts = optionsOrFallback('customer_type', customerTypeOptsQ.data);
  const buildingTypeOpts = optionsOrFallback('building_type', buildingTypeOptsQ.data);
  const relationshipOpts = optionsOrFallback('relationship',  relationshipOptsQ.data);

  /* PR #46 — Form shape now matches POS handover schema. Renamed
     debtor → customer; building_type promoted to proper column;
     branding + ref + venue dropped per commander 2026-05-26. */
  // PR #140 — Commander 2026-05-26 drop list:
  //   - poDocNo (Customer PO #)   → "customer PO 不需要"
  //   - the POS-era "Target Date" → replaced by Processing + Delivery Date.
  //     The NAME went with it on 2026-08-18: the server no longer selects,
  //     accepts or maps it anywhere (owner: "全部你都是要统一掉的，不要那么多个").
  // PR #140 — add list:
  //   - processingDate
  //   - customerDeliveryDate
  // #140 renamed only the LABEL to "Processing Date"; the column stayed
  // `internal_expected_dd` for another three months and cost several incidents.
  // Mig 0284 finished the job: field, payload key and column are one word.
  /* PR-A — initialFormFor() is the single source-of-truth for what the
     local form looks like when reset (Cancel) or when the header reloads
     after a successful Save. Keeps the snapshot + reset paths consistent. */
  const initialFormFor = (h: SoHeader) => ({
    /* customerCode kept in state but the UI no longer renders an input
       (commander 2026-05-27: "customer code 不需要"). Payload still sends
       debtorCode so the server-side mapping is unchanged. */
    customerCode: h.debtor_code ?? '',
    customerName: h.debtor_name ?? '',
    /* PR-A — customer's own SO reference number (their ERP doc no). The
       column has existed since PR #121; this exposes it as an editable
       field inside the Customer sub-section. */
    customerSoNo: h.customer_so_no ?? '',
    email: h.email ?? '',
    customerType: h.customer_type ?? '',
    salespersonId: h.salesperson_id ?? '',
    buildingType: h.building_type ?? '',
    /* PR #156 — Commander 2026-05-27: "开单的 venue 呢也没有". Reinstate
       venue as a free-text field separate from Building Type.

       Commander 2026-05-27 follow-up: "venue就不能换 自动跳出来". Venue is
       now read-only on Edit too — derived from the picked salesperson's
       staff.venue_id. We keep the free-text `venue` column on the row
       (back-compat with PDFs / reports) and also persist `venue_id` so the
       master link is durable. */
    venue: h.venue ?? '',
    venueId: h.venue_id ?? '',
    phone: h.phone ?? '',
    address1: h.address1 ?? '',
    address2: h.address2 ?? '',
    city: h.city ?? h.address3 ?? '',
    postcode: h.postcode ?? h.address4 ?? '',
    state: h.customer_state ?? '',
    emergencyContactName: h.emergency_contact_name ?? '',
    emergencyContactPhone: h.emergency_contact_phone ?? '',
    emergencyContactRelationship: h.emergency_contact_relationship ?? '',
    processingDate: h.processing_date ?? '',
    customerDeliveryDate: h.customer_delivery_date ?? '',
    note: h.note ?? '',
    /* Commander 2026-05-27 cascade — seeded from the persisted value so we
       don't clobber a manually-entered location on first paint. The cascade
       effect below replaces it whenever the state changes. */
    salesLocation: h.sales_location ?? '',
  });

  /* PR #46 — Payload uses the proper column names now. Sales Location +
     Agent are NOT in this form — they auto-populate from the logged-in
     POS user (Sales Location = staff.showroom; Agent legacy column kept
     for B2B manual cases).

     A PURE function of a form snapshot, so the SAME builder produces both the
     outgoing payload and the pristine one Save diffs it against — an untouched
     field then yields byte-identical values on both sides and normalisation
     cannot false-positive (the line path's lineCommitSig relies on the same
     property). Declared beside initialFormFor because the pristine snapshot
     below must be seeded from it at the same moment `form` is. */
  const payloadFor = (f: ReturnType<typeof initialFormFor>) => ({
    debtorCode: f.customerCode,
    debtorName: f.customerName,
    /* PR-A — Persist customer's own SO ref. Empty string → null so we
       clear the column when the field is blanked. */
    customerSoNo: f.customerSoNo || null,
    email: f.email,
    customerType: f.customerType,
    salespersonId: f.salespersonId || null,
    buildingType: f.buildingType,
    /* Commander 2026-05-27: Venue is locked to the salesperson's
       staff.venue_id. We persist both the FK + the resolved name. */
    venue: f.venue,
    venueId: f.venueId || null,
    phone: f.phone,
    address1: f.address1,
    address2: f.address2,
    city: f.city,
    postcode: f.postcode,
    customerState: f.state,
    emergencyContactName: f.emergencyContactName,
    emergencyContactPhone: f.emergencyContactPhone,
    emergencyContactRelationship: f.emergencyContactRelationship,
    /* Processing Date persists to the processing_date column — the same word
       on the form, in this payload and in Postgres since mig 0284 (commander
       2026-05-26: "internal expected date 是 Hookka 用的"; #140 changed the
       label, 0284 changed the name underneath it).

       WHAT IT MEANS (owner 2026-08-18): the date this order is RELEASED for
       purchasing to order goods — "Processing Date 就代表这张单可以安排订货了".
       Not a production date; this business does not schedule a factory. */
    processingDate: f.processingDate || null,
    customerDeliveryDate: f.customerDeliveryDate || null,
    note: f.note,
    /* Commander 2026-05-27 (Fix 5) — persist the auto-resolved sales location
       so subsequent edits don't lose it. Empty string → null so we clear the
       column when no mapping resolves AND the user blanks it. */
    salesLocation: f.salesLocation || null,
  });

  const [form, setForm] = useState(() => initialFormFor(header));
  /* Imported-order venue seeding (owner 2026-08-10 "点 edit 的时候它不会不见掉"):
     AutoCount-migrated rows carry the venue as TEXT but nothing the picker's
     option values recognise in venue_id, so the picker rendered "—" even though
     the view header shows the venue — operators read that as the value having
     vanished. When the venue master loads and the seeded venueId matches no
     option, adopt the option whose name equals the stored text
     (case-insensitive). The adoption marks the field dirty, so the operator's
     next Save persists the master link — self-healing, no data migration. */
  useEffect(() => {
    const opts = venuesQ.data ?? [];
    if (!opts.length) return;
    setForm((s) => {
      if (s.venueId && opts.some((v) => v.id === s.venueId)) return s;
      const name = (s.venue ?? '').trim().toUpperCase();
      if (!name) return s;
      const hit = opts.find((v) => (v.name ?? '').trim().toUpperCase() === name);
      return hit && s.venueId !== hit.id ? { ...s, venueId: hit.id } : s;
    });
  }, [venuesQ.data, form.venueId, form.venue]);
  const buildPayload = () => payloadFor(form);
  /* The header payload AS SEEDED (pristine) — trySave diffs the outgoing
     payload against this so an untouched field is never sent (the header mirror
     of originalDraftsRef). Re-seeded in LOCK-STEP with `form`, never from a
     live `header`: the re-seed effect below deliberately does NOT touch `form`
     while editing, so tracking `header` here would make a field the SERVER
     changed under the operator (a background scan write) read as dirty, and
     Save would clobber that newer value with the stale one the form still
     holds. Both sides therefore always describe the same snapshot. */
  const originalPayloadRef = useRef<Record<string, unknown>>(payloadFor(initialFormFor(header)));
  const [showSuggest, setShowSuggest] = useState(false);
  /* Portal the debtor dropdown to document.body so the section card's
     overflow:hidden can't clip it (mirrors the SoLineCard fix). */
  const custInputRef = useRef<HTMLInputElement>(null);
  /* Task #99 (UI perf) — 200 ms debounce on the debtor autocomplete. Until
     this commit each keystroke in the Customer Name field issued a
     /debtors/search request. The hook itself now guards length>=2 (see
     flow-queries.ts) but a fast typist still produced one request per
     character on top of that, which was the dominant freeze when entering
     a new customer. Debouncing here keeps `form.customerName` reactive for
     the rest of the card (state cascade, save payload) while the autocomplete
     hook sees a settled value. */
  const debouncedDebtorQ = useDebouncedValue(form.customerName, 200);
  const debtorQuery = useDebtorSearch(debouncedDebtorQ);
  const suggestions = (debtorQuery.data?.debtors ?? []).filter(
    (d) => (d.debtor_name ?? '').toLowerCase() !== form.customerName.trim().toLowerCase(),
  );

  /* Reset the local form to the header ONLY when not actively editing. A
     background refetch (payment add, slip upload, line-draft autosave) hands a
     fresh `header` reference; without this guard it would overwrite the
     operator's in-progress, unsaved Customer edits — the same silent-data-loss
     the line-item drafts buffer prevents. Cancel still resets via the ref. */
  useEffect(() => {
    if (isEditing) return;
    const seeded = initialFormFor(header);
    setForm(seeded);
    originalPayloadRef.current = payloadFor(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header, isEditing]);

  const set = <K extends keyof typeof form>(k: K, v: string) =>
    setForm((s) => ({ ...s, [k]: v }));

  /* Commander 2026-05-27: keep form.venueId / form.venue in lock-step with
     the picked salesperson's home venue. Runs whenever the salesperson
     swaps OR when the staff/venue lookups arrive (since the staff row may
     not be in the list at first paint). We only patch when the resolved
     values differ from the current form to avoid an infinite loop. */
  useEffect(() => {
    if (!form.salespersonId) return;
    /* Houzs 2026-06-23 (owner): Venue is manually pickable — only auto-fill the
       DEFAULT when it is still empty; never override a manual or loaded pick. */
    if (form.venueId) return;
    const picked = staffList.find((s) => s.id === form.salespersonId);
    const resolvedId = picked?.venueId ?? '';
    if (!resolvedId) return;
    const resolvedName = (venuesQ.data ?? []).find((v) => v.id === resolvedId)?.name;
    if (!resolvedName) return; // 0591: `?? ''` blanked a loaded venue, permanently
    setForm((s) => ({ ...s, venueId: resolvedId, venue: resolvedName }));
  }, [form.salespersonId, staffList, venuesQ.data, form.venueId]);

  /* Commander 2026-05-27 (Fix 5) — State → Sales Location cascade. When the
     user picks a delivery state, look up state_warehouse_mappings and set
     the Sales Location to the mapped warehouse code (e.g. "SLGR WAREHOUSE").
     Commander 2026-05-31: standardised on the warehouse CODE so this form, the
     New SO form, the server-side derive, and every list Location column all
     show ONE consistent label. PO warehouse resolution (resolveWarehouseId)
     matches on name OR code, so either resolves the same warehouse downstream
     — this is purely display. Only fires when we have a mapping AND the
     resolved code differs from what the form already shows — guards against
     re-render loops and avoids stomping a manual override before the mappings
     query resolves. */
  useEffect(() => {
    if (!form.state) return;
    const list = stateWarehousesQ.data?.mappings ?? [];
    if (list.length === 0) return;
    const hit = list.find((m) => m.state === form.state);
    const code = hit?.warehouse?.code ?? hit?.warehouse?.name ?? null;
    if (!code) return;
    if (form.salesLocation === code) return;
    setForm((s) => ({ ...s, salesLocation: code }));
  }, [form.state, stateWarehousesQ.data, form.salesLocation]);

  /* Cascade derivations — shared layer, both directions (address-cascade.ts).
     One setForm per pick so the value the operator just chose survives; routing
     a back-filled State through the State picker's own handler would clear it,
     because that handler exists to reset the cascade. */
  const { cities: cityChoices, postcodes: postcodeChoices } =
    useAddressCascade(localityRows, form.state, form.city);
  const applyCityReverse = (nextCity: string) =>
    setForm((s) => ({ ...s, ...pickCity(localityRows, s, nextCity) }));
  const applyPostcodeReverse = (nextPostcode: string) =>
    setForm((s) => ({ ...s, ...pickPostcode(localityRows, s, nextPostcode) }));
  /* Task #121 — Country auto-derives from the picked state. Read-only on
     the form; the API re-derives + snapshots it on PATCH. Prefer the
     header's stored customer_country (so historic SOs whose locality
     country later changed still display the captured country); fall back
     to the live derive, then Malaysia. */
  const country = useMemo<string>(() => {
    const headerCountry = (header.customer_country as string | null | undefined) ?? null;
    if (headerCountry) return headerCountry;
    const derived = form.state ? countryForState(localityRows, form.state) : null;
    return derived ?? 'Malaysia';
  }, [header, form.state, localityRows]);

  const applySuggestion = (d: DebtorSuggestion) => {
    setForm((s) => ({
      ...s,
      customerCode: d.debtor_code ?? s.customerCode,
      customerName: d.debtor_name ?? s.customerName,
      phone: d.phone ?? s.phone,
      address1: d.address1 ?? s.address1,
      address2: d.address2 ?? s.address2,
      city: d.address3 ?? s.city,
      postcode: d.address4 ?? s.postcode,
    }));
    setShowSuggest(false);
  };

  /* PR #156 — Commander 2026-05-27: "为什么能 save processing date 呢
     没有 delivery date 而且 variant 也没有补完". Mirror the New SO form's
     XOR rule on Detail Save: block when only one of Processing/Delivery
     Date is set. */
  const datesXor =
    (form.processingDate.trim() !== '') !== (form.customerDeliveryDate.trim() !== '');

  /* Commander 2026-05-28 — Processing/Delivery Date may only be today or a
     future date. Used as the <input min> AND re-checked on Save (parity with
     the New SO form). todayMyt() = the Malaysia (UTC+8) calendar day — NOT the
     device clock (`new Date().toLocaleDateString('en-CA')`, which decided
     past-vs-future by the browser's own timezone and disagreed with the create
     form + both mobile paths near midnight on a non-UTC+8 device). */
  const today = todayMyt();

  /* Owner 2026-06-01 — Grandfather an already-past date that the edit does not
     change. The Processing Date is the day work started; once it has elapsed it
     is a historical record, so we LOCK its input (read-only) and never block a
     Save just because it sits in the past. The same grandfather (without the
     lock) applies to the Delivery Date so an SO can still be postponed even if
     its old delivery day has passed — only a freshly-typed past date is
     rejected. */
  const originalProcessing = header.processing_date ?? '';
  const originalDelivery = header.customer_delivery_date ?? '';
  /* ...EXCEPT in amendment mode: an amendment is the sanctioned channel for
     changing exactly these frozen fields, so read-only-ing the input there left
     the operator with a change they were told to request and no way to type it
     (Owner 2026-07-16). The value still can't be written directly — the page's
     primary action routes it through the approval flow. */
  /* ...and EXCEPT for a Remove-Processing-Date holder (Owner 2026-07-09, port of
     2990 #717): clearing an ELAPSED Processing Date is the one sanctioned way to
     pull a locked SO back out of Proceed, and the API explicitly allows it. With
     the input read-only they could not perform the very action the permission
     exists to grant — the past-date lock must not apply to them. */
  const processingLocked =
    originalProcessing !== '' && originalProcessing < today && !amendmentMode &&
    !canRemoveProcessingDate;

  /* Owner 2026-07-05 — the SO PROCESS lock fires only once the SO has a
     Processing Date (which IS what being proceeded means) AND that day has
     passed. That is the moment we PO to the supplier, so from then on the LINE ITEMS and the
     customer STATE + POSTCODE (which drive the line warehouse + the PO delivery
     location) freeze. PAYMENT and every other customer field stay editable.
     This is stricter than `processingLocked` (which grandfather-locks the past
     Processing-Date input alone, proceeded or not) — keep the two separate.
     Shared gate (vendor/scm/lib/so-detail-gates) uses todayMyt() so the lock is
     computed against the Malaysia calendar day, not the device's local day.

     `stateLocked` is what the State/Postcode inputs read: the process lock UNLESS
     the SO is amendment-eligible, in which case those fields are editable and
     their new values ride the amendment for approval (Owner 2026-07-16 — every
     frozen field must be requestable). */
  const procLockActive = soProcLockActive(header);
  const stateLocked = procLockActive && !amendmentMode;

  /* Returns the first blocking date error, or null when the dates are valid.
     Shared by the imperative validate() (page-level Save runs this BEFORE
     committing any line) and trySave (defence-in-depth on the header write).

     Delegates the XOR / not-in-past / processing≤delivery rules to the SHARED
     soDateGuardError (same helper the create form + both mobile paths use)
     against todayMyt(), so Detail can't drift on any of those rules.

     GRANDFATHER (Owner 2026-06-01) — an already-saved past date that this edit
     does NOT change is a historical record, not a fresh past-date entry, and
     must never block a Save. That rule now lives IN the shared guard: we hand it
     the real values plus the originals, and it skips the not-in-past check on an
     unchanged date while still running the XOR + processing<=delivery rules on
     the real values (a freshly-typed or moved past date is still rejected).

     This replaces the earlier workaround of passing the ORIGINAL date in AS
     `today` — that lied to the guard about the current date, which also skewed
     the processing<=delivery comparison, and it could not be reused by mobile
     (whose amendment submit was hard-blocked by its own unchanged past date). */
  const validateDates = (): string | null => {
    const err = soDateGuardError({
      processingDate: form.processingDate,
      deliveryDate: form.customerDeliveryDate,
      today,
      originalProcessingDate: originalProcessing,
      originalDeliveryDate: originalDelivery,
      canRemoveProcessingDate,
    });
    return err ? soErrorText(err) : null;
  };

  /* The FROZEN header fields as this form currently holds them, and as the SO
     had them. Fed to the SHARED so-amendment-header helpers so desktop + mobile
     agree on what needs approval and what saves directly. */
  const lockedHeaderNow = {
    processingDate:   form.processingDate,
    customerDeliveryDate: form.customerDeliveryDate,
    customerState:        form.state,
    postcode:             form.postcode,
    /* City joined the frozen set 2026-07-17 (so-field-policy) — part of the PO
       delivery destination, same as Postcode. Without it here a City change on
       an amendment-eligible SO would be silently dropped from the request. */
    city:                 form.city,
    /* Address lines joined 2026-07-27 (two-lane phase 2): a street/unit change
       on a locked SO is a Logistics-approved amendment, no longer a direct
       save. Without these here the request would silently drop the change —
       the exact City defect this table exists to prevent. The editor form
       collects TWO address lines (address3/4 are legacy/postcode-mirror
       columns with no input here); buildAmendmentHeaderChanges skips keys the
       surface doesn't collect, so omitting them is the correct shape. */
    address1:             form.address1,
    address2:             form.address2,
    /* Customer info joined the frozen set 2026-08-21 (owner: "需要加上更新
       客户信息") — a name/phone/email change on a locked SO rides the
       DELIVERY-lane amendment instead of saving directly. */
    debtorName:           form.customerName,
    phone:                form.phone,
    email:                form.email,
  };
  const lockedHeaderOriginal = {
    processingDate:   header.processing_date ?? '',
    customerDeliveryDate: header.customer_delivery_date ?? '',
    customerState:        header.customer_state ?? '',
    postcode:             header.postcode ?? header.address4 ?? '',
    city:                 header.city ?? '',
    address1:             header.address1 ?? '',
    address2:             header.address2 ?? '',
    debtorName:           header.debtor_name ?? '',
    phone:                header.phone ?? '',
    email:                header.email ?? '',
  };

  /* The EXACT body the direct half sends in amendment mode; trySave and
     hasDirectHeaderChanges share it so the two cannot disagree. */
  const directHeaderPatch = () => diffHeaderPayload(originalPayloadRef.current,
    withFrozenHeaderFieldsReverted(buildPayload(), lockedHeaderOriginal));

  const trySave = (
    cb?: { onSuccess?: () => void; onError?: (msg: string, raw?: unknown) => void },
    opts?: { keepLockedColsAsOriginal?: boolean },
  ) => {
    const err = validateDates();
    if (err) {
      if (cb?.onError) cb.onError(err);
      else notify({ title: 'Check the dates', body: err, tone: 'error' });
      return;
    }
    /* Send ONLY what the operator changed. The diff runs AFTER the frozen-field
       revert, so a reverted column equals its seeded value and drops out
       entirely — which is strictly safer than sending it back unchanged: the
       server's lock diffs `col in updates`, so a column we never send cannot
       409 so_locked_processing at all. */
    onSave(opts?.keepLockedColsAsOriginal ? directHeaderPatch()
      : diffHeaderPayload(originalPayloadRef.current, buildPayload()), cb);
  };

  /* PR-A — Expose imperative save()/reset() so the page-level Edit/Save/
     Cancel buttons can drive this card without lifting all of its form
     state to the parent. No deps array → handle re-binds every render so
     `save` always closes over the latest form snapshot. */
  useImperativeHandle(ref, () => ({
    validate: () => validateDates(),
    save: (cb, opts) => trySave(cb, opts),
    /* Cancel re-seeds the form, so the pristine snapshot must move with it —
       otherwise the next edit would diff against the abandoned session. */
    reset: () => {
      const seeded = initialFormFor(header);
      setForm(seeded);
      originalPayloadRef.current = payloadFor(seeded);
    },
    getPhone: () => form.phone ?? '',
    getLockedHeaderChanges: () =>
      buildAmendmentHeaderChanges(lockedHeaderNow, lockedHeaderOriginal),
    hasDirectHeaderChanges: () => hasHeaderChanges(directHeaderPatch()),
  }));

  /* PR-A — Inputs are read-only when the page isn't in edit mode OR the
     SO is locked (post-SHIPPED). Combining both keeps the existing lock
     semantics intact. */
  const inputsDisabled = !isEditing || locked;


  /* PR #168 — Commander 2026-05-27 screenshot diff vs. Create SO: Detail
     was using one big "Customer · Addresses" card with 4 hairline-divided
     sub-blocks; Create SO uses 4 visually distinct top-level cards. Mirror
     the New SO layout here — same module classes (.card / .cardHeader /
     .cardTitle / .formGrid4 / .field / .fieldLabel) — so the two pages
     read identically. The component still exposes its imperative save() /
     reset() handle to the page-level Edit/Save flow; the 4 cards just
     replace the single wrapper. */
  return (
    <>
      {/* ── CUSTOMER ──────────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Customer</h2>
        </header>
        <div className={styles.cardBody}>
          {/* PR-A — Customer Code input removed (commander 2026-05-27:
              "customer code 不需要"). Field still flows through state +
              payload so the server-side mapping is untouched.
              Customer SO Ref added next to Customer Name. */}
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: 'span 3' }}>
              <span className={styles.fieldLabel}>Customer Name *</span>
              <input
                ref={custInputRef}
                className={styles.fieldInput}
                value={form.customerName}
                disabled={inputsDisabled}
                onChange={(e) => { set('customerName', e.target.value); setShowSuggest(true); }}
                onFocus={() => setShowSuggest(true)}
                onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
              />
              {/* Shared with the New SO / consignment forms. It was portalled
                  here already but only ever placed BELOW the input, so near the
                  window bottom it ran off-screen where `position: fixed` puts it
                  beyond any scroll; the shared component flips it. */}
              <DebtorSuggestList
                anchorRef={custInputRef}
                open={showSuggest && !inputsDisabled}
                suggestions={suggestions}
                onPick={applySuggestion}
                classes={{ list: styles.suggestList, item: styles.suggestItem, code: styles.suggestCode }}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer SO Ref</span>
              <input className={styles.fieldInput} value={form.customerSoNo}
                placeholder="Their PO / SO number"
                disabled={inputsDisabled}
                onChange={(e) => set('customerSoNo', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Phone *</span>
              {/* Task #91 — PhoneInput normalizes to E.164 on blur and shows
                  the pretty Malaysian format when unfocused. */}
              <PhoneInput
                className={styles.fieldInput}
                value={form.phone}
                disabled={inputsDisabled}
                onChange={(v) => set('phone', v)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Email *</span>
              <input type="email" className={styles.fieldInput} value={form.email}
                disabled={inputsDisabled}
                onChange={(e) => set('email', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.customerType}
                  disabled={inputsDisabled}
                  onChange={(e) => set('customerType', e.target.value)}>
                  <option value="">—</option>
                  {customerTypeOpts.map((t) => (
                    <option key={t.id} value={t.value}>{t.label}</option>
                  ))}
                  {/* If the persisted value isn't in the active options list
                      (commander deactivated it but this SO already references
                      it), render it explicitly so the select still shows it. */}
                  {form.customerType && !customerTypeOpts.some((t) => t.value === form.customerType) && (
                    <option value={form.customerType}>{form.customerType}</option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Salesperson</span>
              {/* Commander 2026-05-27: only admin / sales_director can swap
                  the salesperson on an existing SO. Non-admin sales roles
                  see a disabled picker pinned to whoever owns the SO.

                  Owner 2026-08-17 — this ONE field ignores `locked`. A
                  delivered / invoiced order freezes everything a DO or SI
                  snapshots, but not who owns it: that is how a resigning rep's
                  orders reach their replacement. Searchable because the roster
                  is ~100 people; a former staff id with no roster row still
                  shows as "(not in this list)" rather than a bare uuid. */}
              <span className={styles.selectWrap}>
                <SearchableSelect
                  className={styles.fieldSelect}
                  ariaLabel="Salesperson"
                  placeholder="— Pick staff —"
                  disabled={!isEditing || !canChangeSalesperson}
                  value={form.salespersonId}
                  onChange={(v) => set('salespersonId', v)}
                  options={[
                    ...sortByText(staffList).map((s) => ({
                      value: s.id,
                      label: `${s.name} (${s.staffCode})`,
                    })),
                    /* Persisted salesperson may not be in the active list
                       (deactivated since the SO was created) — carry a row for
                       it so the picker still shows a name instead of blanking
                       out or printing a uuid. */
                    ...(form.salespersonId && !staffList.some((s) => s.id === form.salespersonId)
                      ? [{ value: form.salespersonId, label: '(former staff)' }]
                      : []),
                  ]}
                />
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
          </div>
        </div>
      </section>

      {/* ── ORDER INFO (venue / dates / note) ─────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Order Info</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Building Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.buildingType}
                  disabled={inputsDisabled}
                  onChange={(e) => set('buildingType', e.target.value)}>
                  <option value="">—</option>
                  {buildingTypeOpts.map((b) => (
                    <option key={b.id} value={b.value}>{b.label}</option>
                  ))}
                  {form.buildingType && !buildingTypeOpts.some((b) => b.value === form.buildingType) && (
                    <option value={form.buildingType}>{form.buildingType}</option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Venue</span>
              {/* Houzs 2026-06-23 (owner): Venue is manually pickable (was a
                  locked 2990 field). Defaults to the salesperson's venue. */}
              <span className={styles.selectWrap}>
                <select
                  className={styles.fieldSelect}
                  value={form.venueId || ''}
                  disabled={inputsDisabled}
                  onChange={(e) => {
                    const id = e.target.value;
                    const name = (venuesQ.data ?? []).find((v) => v.id === id)?.name ?? '';
                    setForm((s) => ({ ...s, venueId: id, venue: name }));
                  }}
                  aria-label="Venue"
                >
                  <option value="">—</option>
                  {(venuesQ.data ?? []).map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Processing Date</span>
              <DateField
                fullWidth
                className={styles.fieldInput}
                value={form.processingDate}
                disabled={inputsDisabled || processingLocked}
                title={processingLocked ? 'Processing date has passed — locked.' : undefined}
                min={processingLocked ? undefined : today}
                onChange={(iso) => set('processingDate', iso)}
                style={datesXor && !form.processingDate ? { borderColor: 'var(--c-festive-b, #B8331F)' } : undefined}
              />
              {/* Remove-Processing-Date gate (Owner 2026-07-09) — the server 403s
                  a non-holder's clear; surface the rule up front instead of
                  letting them find out on Save. */}
              {originalProcessing !== '' && !inputsDisabled && !processingLocked && !canRemoveProcessingDate && (
                <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', marginTop: 2 }}>
                  Only a Super Admin can remove this date.
                </span>
              )}
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Delivery Date</span>
              <DateField
                fullWidth
                className={styles.fieldInput}
                value={form.customerDeliveryDate}
                disabled={inputsDisabled}
                min={today}
                onChange={(iso) => { set('customerDeliveryDate', iso); onDeliveryDateChange?.(iso); }}
                style={datesXor && !form.customerDeliveryDate ? { borderColor: 'var(--c-festive-b, #B8331F)' } : undefined}
              />
            </label>
            {/* Proceed Date field removed per request 2026-06-05. It showed a
                separate server-stamped Proceed timestamp; the owner has since
                ruled (three times, last 2026-08-18) that the Processing Date IS
                the Proceed, so there is no second date to surface. */}
            <label className={`${styles.field}`} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Note</span>
              <input className={styles.fieldInput} value={form.note}
                disabled={inputsDisabled}
                onChange={(e) => set('note', e.target.value)} />
            </label>
          </div>
          {datesXor && (
            <div style={DATES_XOR_WARN_STYLE}>
              ⚠ Processing Date and Delivery Date must be set together — Save is blocked.
            </div>
          )}
        </div>
      </section>

      {/* ── EMERGENCY CONTACT ─────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Emergency Contact</h2>
          <span style={EMERGENCY_HEADER_NOTE_STYLE}>
            Used only if we cannot reach the customer on delivery day
          </span>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Contact Name</span>
              <input className={styles.fieldInput} value={form.emergencyContactName}
                placeholder="e.g. Lim Mei Hua"
                disabled={inputsDisabled}
                onChange={(e) => set('emergencyContactName', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Relationship</span>
              {/* Task #118 — DB-backed dropdown (was a free-text input).
                  Detail and New SO now share the same option list from
                  so_dropdown_options('relationship'). Historical free-text
                  values that aren't in the options list still render via
                  the trailing fallback <option> so we don't silently drop
                  them on first paint. */}
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.emergencyContactRelationship}
                  disabled={inputsDisabled}
                  onChange={(e) => set('emergencyContactRelationship', e.target.value)}>
                  <option value="">—</option>
                  {relationshipOpts.map((r) => (
                    <option key={r.id} value={r.value}>{r.label}</option>
                  ))}
                  {form.emergencyContactRelationship &&
                    !relationshipOpts.some((r) => r.value === form.emergencyContactRelationship) && (
                    <option value={form.emergencyContactRelationship}>
                      {form.emergencyContactRelationship}
                    </option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Phone</span>
              <PhoneInput
                className={styles.fieldInput}
                value={form.emergencyContactPhone}
                disabled={inputsDisabled}
                onChange={(v) => set('emergencyContactPhone', v)}
              />
            </label>
          </div>
        </div>
      </section>

      {/* CUSTOMER SIGNATURE + PAYMENT SLIP relocated (Wei Siang 2026-06-06):
          signature now renders directly below Payments (above), and the payment
          slip is shown as a column inside the Payments table. */}

      {/* ── DELIVERY ADDRESS ──────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Delivery Address</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={`${styles.field}`} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Address Line 1</span>
              {/* KEEP CHROME'S ADDRESS AUTOFILL OFF THIS BLOCK.
                  Chrome classifies a form by its FIELDS, not one at a time, so
                  a bare address input here makes it treat the whole group as an
                  address form and offer its saved-address popup — which renders
                  above the State list and makes State unpickable, and with it
                  City and Postcode. StatePicker already sets autoComplete="off"
                  and it was not enough: Chrome overrides `off` once the form
                  looks like an address. An UNRECOGNISED token is what actually
                  stops the heuristic, because it is neither a known field type
                  nor the `off` it argues with. */}
              <input className={styles.fieldInput} value={form.address1}
                placeholder="Unit, street, area"
                autoComplete="houzs-no-autofill"
                disabled={inputsDisabled}
                onChange={(e) => set('address1', e.target.value)} />
            </label>
            <label className={`${styles.field}`} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Address Line 2</span>
              <input className={styles.fieldInput} value={form.address2}
                placeholder="Apt, floor, building (optional)"
                autoComplete="houzs-no-autofill"
                disabled={inputsDisabled}
                onChange={(e) => set('address2', e.target.value)} />
            </label>
            {/* Owner spec 2026-07-23 — StatePicker (MY-default, click Others for CN/SG, Search). Same shared component as Warehouse / Supplier / Venue / MobileNewSO / SalesOrderNew. No `(legacy)` sneak-through, no free-text fallback. */}
            <label
              className={styles.field}
              title={stateLocked ? 'Processing has passed — State is locked (it drives the PO delivery location).' : undefined}
            >
              <span className={styles.fieldLabel}>State</span>
              <StatePicker
                value={form.state}
                onChange={(next) => setForm((s) => ({ ...s, ...pickState(next) }))}
                disabled={inputsDisabled || stateLocked}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>City</span>
              <span className={styles.selectWrap}>
                {/* City locks with State + Postcode (Owner 2026-07-17). It is
                    part of the delivery destination printed on the supplier PO,
                    exactly like Postcode — but desktop did not lock it at all
                    while mobile disabled it, and NO backend set contained it, so
                    a City change wrote straight through on a locked, PO'd SO.
                    It is CONTROLLED now (so-field-policy) and rides the
                    amendment when the SO is amendment-eligible. */}
                <SearchableSelect
                  className={styles.fieldSelect}
                  value={form.city}
                  onChange={applyCityReverse}
                  disabled={inputsDisabled || stateLocked}
                  title={stateLocked ? 'Processing has passed — City is locked (it is part of the PO delivery location).' : undefined}
                  placeholder={cityPlaceholder(form.state)}
                  options={sortByText(cityChoices).map((c) => ({ value: c, label: c }))}
                />
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Postcode</span>
              <span className={styles.selectWrap}>
                <SearchableSelect
                  className={styles.fieldSelect}
                  value={form.postcode}
                  onChange={applyPostcodeReverse}
                  disabled={inputsDisabled || stateLocked}
                  title={stateLocked ? 'Processing has passed — Postcode is locked (it drives the PO delivery location).' : undefined}
                  placeholder={postcodePlaceholder(form.state, form.city)}
                  options={sortByNumeric(postcodeChoices).map((p) => ({ value: p, label: p }))}
                />
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            {/* Task #121 — Country is auto-derived from the picked state via
                my_localities. Read-only; the API re-derives + snapshots it
                onto the SO header on PATCH whenever customerState changes. */}
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Country</span>
              <span className={styles.fieldInput} style={{
                display: 'inline-flex', alignItems: 'center', height: 26,
                color: 'var(--fg-muted)',
              }}>
                {country}
              </span>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Sales Location</span>
              {/* Commander 2026-05-27 (Fix 5) — Auto-derived from
                  state_warehouse_mappings on State change. Surfaced as
                  read-only display (mappings are managed from Maintenance)
                  but the live form value is what gets persisted. */}
              <span className={styles.fieldInput} style={{
                display: 'inline-flex', alignItems: 'center', height: 26,
                color: 'var(--fg-muted)',
              }}
                title={form.salesLocation
                  ? `Auto-set from State → Warehouse mapping for "${form.state}"`
                  : 'Pick a State above to auto-set'}
              >
                {form.salesLocation || header.sales_location || '—'}
              </span>
            </div>
          </div>
        </div>
      </section>
    </>
  );
});
CustomerCardInner.displayName = 'CustomerCardInner';
const CustomerCard = memo(CustomerCardInner) as typeof CustomerCardInner;

/* ════════════════════════════════════════════════════════════════════════
   Totals card
   ════════════════════════════════════════════════════════════════════════ */

/* ── Scanned image viewer (migrations 0033 + 0034) ──────────────────────────
   When the SO was created via the Scan Order flow, the handwritten ORDER SLIP
   (0033) and/or the printed card-terminal PAYMENT RECEIPT (0034) were kept in
   R2. Show each as proof: authed-fetch the serve endpoint as a blob (the bearer
   token can't ride on an <img src>), render the object URL inline, and offer
   "open full size" in a new tab. Mirrors the item-photo blob display pattern;
   the object URL is revoked on unmount. `title` / `alt` distinguish the two. */
const ScannedImageCard = ({
  imageKey,
  title,
  alt,
}: {
  imageKey: string;
  title: string;
  alt: string;
}) => {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    fetchScanSlipImageBlobUrl(imageKey)
      .then((u) => {
        if (cancelled) { URL.revokeObjectURL(u); return; }
        url = u;
        setSrc(u);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Something went wrong.'); });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [imageKey]);

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>{title}</h2>
      </header>
      <div className={styles.cardBody}>
        {error ? (
          <div style={{ color: 'var(--c-festive-b, #B8331F)', fontSize: 13 }}>
            Couldn&apos;t load the scanned image. {error}
          </div>
        ) : src ? (
          <a href={src} target="_blank" rel="noreferrer" title="Open full size in a new tab">
            <img
              src={src}
              alt={alt}
              style={{ maxWidth: 360, width: '100%', height: 'auto', border: '1px solid var(--c-line, #E5E1DC)', borderRadius: 8, background: '#fff', cursor: 'zoom-in' }}
            />
          </a>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--c-muted, #8A8377)' }}>Loading…</div>
        )}
      </div>
    </section>
  );
};

/* ── Totals · Margin card — REMOVED (owner 2026-07-17) ─────────────────────
   The Revenue / Cost / Margin / Margin% card (and its per-category cost
   breakdown) is gone from the SO document view for EVERYONE — costing moves to
   the separate Finance "Fulfillment Costing" module. Customer-facing totals are
   untouched. The header cost/margin columns (total_cost_sen etc.) remain in
   the type + server payload; only their display is removed. */

/* ════════════════════════════════════════════════════════════════════════
   Task #101 — dead code removal (2026-05-27)
   ────────────────────────────────────────────────────────────────────────
   The following exports/components were removed because PR #171 (Houzs
   rollout) replaced their callers:
     • StatusBar + NEXT — status transition strip; the Edit/Save framework
       now drives status changes via updateStatus.mutate() directly from
       the page header (commander 2026-05-27: "这个不需要")
     • AddressCard — multi-address (ship-to / bill-to / install-to) card;
       PR #168 replaced it with the 4-section CustomerCard split below.
   The DB columns the deleted components read from (ship_to_address /
   bill_to_address / install_to_address / customer_po / customer_po_id /
   customer_po_date / hub_name / overdue) remain in the schema so existing
   rows stay queryable — only the UI rendering is gone.
   ════════════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════════════
   PaymentCard moved → components/PaymentsTable (task #105).
   AddressCard + StatusBar + NEXT deleted as dead code (task #101).
   ════════════════════════════════════════════════════════════════════════ */



/* ════════════════════════════════════════════════════════════════════════
   StatusTimeline + PriceOverridePanel — removed in followup #85
   Both standalone audit cards were superseded by the PR-D History drawer
   (useSalesOrderAuditLog), which renders the same data plus every other
   action type in one unified feed. The underlying tables and writes are
   retained so the data remains queryable for admin tooling.
   ════════════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════════════
   OverridePriceModal — PR #35 set line price override + reason audit
   ════════════════════════════════════════════════════════════════════════ */

const OverridePriceModal = ({
  item,
  docNo,
  currency,
  onClose,
}: {
  item: SoItem;
  docNo: string;
  currency: string;
  onClose: () => void;
}) => {
  const override = useOverrideMfgSoLinePrice();
  const notify = useNotify();
  const [overrideRm, setOverrideRm] = useState(
    (item.unit_price_sen / 100).toFixed(2),
  );
  const [reason, setReason] = useState('');

  const submit = () => {
    const newSen = Math.round(Number(overrideRm) * 100);
    if (!Number.isFinite(newSen) || newSen <= 0) {
      notify({ title: 'Override price must be a positive number.', tone: 'error' });
      return;
    }
    if (reason.trim().length < 10) {
      notify({ title: 'Reason must be at least 10 characters.', tone: 'error' });
      return;
    }
    override.mutate(
      { docNo, itemId: item.id, overridePriceSen: newSen, reason: reason.trim() },
      { onSuccess: () => onClose() },
    );
  };

  const delta = Math.round(Number(overrideRm) * 100) - item.unit_price_sen;
  const deltaPct = item.unit_price_sen > 0
    ? (delta / item.unit_price_sen) * 100
    : 0;

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <header className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>
            <DollarSign {...ICON} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Override Line Price
          </h3>
          <button type="button" className={styles.iconBtn} onClick={onClose} title="Close">
            <X {...ICON} />
          </button>
        </header>

        <div className={styles.modalBody}>
          <p className={styles.muted}>
            Item <strong>{item.item_code}</strong>{item.description ? ` — ${item.description}` : ''}<br />
            Current unit price: <strong>{fmtRm(item.unit_price_sen, currency)}</strong>
          </p>

          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Override Price (RM) *</span>
              <input type="number" step="0.01" min="0"
                className={styles.fieldInput}
                value={overrideRm}
                onChange={(e) => setOverrideRm(e.target.value)} />
            </label>
            <div className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Δ vs current</span>
              <span className={styles.fieldInput} style={{
                display: 'inline-flex', alignItems: 'center', height: 32,
                color: delta < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--c-burnt)',
              }}>
                {delta >= 0 ? '+' : ''}{fmtRm(delta, currency)} ({deltaPct.toFixed(1)}%)
              </span>
            </div>
          </div>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Reason * (≥ 10 chars, audited)</span>
            <textarea className={styles.fieldInput} rows={3}
              placeholder="e.g. Manager approved 15% discount due to display unit blemish."
              value={reason}
              onChange={(e) => setReason(e.target.value)} />
          </label>
        </div>

        <footer className={styles.modalFooter}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={override.isPending}>
            {override.isPending ? 'Saving…' : 'Override + Audit'}
          </Button>
        </footer>
      </div>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   PR-D — HistoryPanel
   Thin Sales Order binding over the shared AuditHistoryPanel: fetches
   mfg_so_audit_log and supplies the SO vocabulary plus the status pill.
   ════════════════════════════════════════════════════════════════════════ */

const HistoryPanel = memo(({
  docNo,
  onClose,
}: {
  docNo: string;
  onClose: () => void;
}) => {
  const q = useSalesOrderAuditLog(docNo);
  const entries = q.data ?? [];

  const renderBadge = useCallback((entry: AuditLogEntry, changes: AuditFieldChange[]) => {
    if (entry.action !== 'UPDATE_STATUS') return null;
    const status = changes.find((f) => f.field === 'status')?.to as string | undefined;
    if (!status) return null;
    return (
      <span
        className={`${styles.statusPill} ${STATUS_CLASS[status as SoStatus] ?? ''}`}
        style={HISTORY_STATUS_PILL_STYLE}
      >
        {SO_STATUS_LABEL[status] ?? status.replace(/_/g, ' ')}
      </span>
    );
  }, []);

  return (
    <AuditHistoryPanel
      recordLabel={docNo}
      entityName="Sales order"
      entries={entries}
      isLoading={q.isLoading}
      labels={SO_AUDIT_LABELS}
      onClose={onClose}
      renderBadge={renderBadge}
    />
  );
});
HistoryPanel.displayName = 'HistoryPanel';

/* ════════════════════════════════════════════════════════════════════════
   Phase 1-C — SO-amendment UI: supplier-confirm form, before/after diff modal,
   and the read-only Revisions tab. HOUZS VENDOR port of 2990's components.
   ════════════════════════════════════════════════════════════════════════ */

/* Inline supplier-confirmation form (rendered inside the pending banner).
   Captures the supplier's acknowledgement: ref (required), note (optional),
   attachment key (optional). Advances REQUESTED → SUPPLIER_PENDING via
   useSupplierConfirm. Errors surface as one plain sentence via useNotify. */
const SupplierConfirmForm = ({
  amendmentId,
  onDone,
}: {
  amendmentId: string;
  onDone: () => void;
}) => {
  const supplierConfirm = useSupplierConfirm();
  const notify = useNotify();
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [attachmentKey, setAttachmentKey] = useState('');

  const submit = () => {
    if (!ref.trim()) {
      notify({ title: 'Supplier reference is required', body: 'Enter the supplier\'s confirmation reference.', tone: 'error' });
      return;
    }
    supplierConfirm.mutate(
      {
        id: amendmentId,
        ref: ref.trim(),
        note: note.trim() || undefined,
        attachmentKey: attachmentKey.trim() || undefined,
      },
      {
        onSuccess: () => { notify({ title: 'Supplier confirmation recorded' }); onDone(); },
        onError: (e) => notify({
          title: 'Could not record the confirmation',
          body: e instanceof Error ? e.message : 'Something went wrong.',
          tone: 'error',
        }),
      },
    );
  };

  return (
    <div style={{
      marginTop: 'var(--space-2)', padding: 'var(--space-3)',
      background: '#fff', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)',
    }}>
      <div className={styles.formGrid4}>
        <label className={styles.field} style={{ gridColumn: 'span 2' }}>
          <span className={styles.fieldLabel}>Supplier confirmation ref *</span>
          <input className={styles.fieldInput} value={ref}
            placeholder="e.g. supplier WhatsApp / email ref"
            onChange={(e) => setRef(e.target.value)} />
        </label>
        <label className={styles.field} style={{ gridColumn: 'span 2' }}>
          <span className={styles.fieldLabel}>Attachment key (optional)</span>
          <input className={styles.fieldInput} value={attachmentKey}
            placeholder="R2 object key, if any"
            onChange={(e) => setAttachmentKey(e.target.value)} />
        </label>
        <label className={styles.field} style={{ gridColumn: 'span 4' }}>
          <span className={styles.fieldLabel}>Note (optional)</span>
          <input className={styles.fieldInput} value={note}
            placeholder="Anything the supplier flagged"
            onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 'var(--space-2)' }}>
        <Button variant="ghost" onClick={onDone} disabled={supplierConfirm.isPending}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={supplierConfirm.isPending}>
          {supplierConfirm.isPending ? 'Recording…' : 'Record confirmation'}
        </Button>
      </div>
    </div>
  );
};

/* Before/after diff modal — opened by the "view changes" link. Reads the
   amendment detail (useAmendmentDetail) and renders each requested line change
   as an old → new pair. Falls back to plain messages while loading / on error
   (authed-fetch already humanises the error). */
const changeTypeLabel = (t: string): string =>
  t === 'SPEC' ? 'Spec change' :
  t === 'QTY' ? 'Quantity change' :
  t === 'ADD' ? 'Added line' :
  t === 'REMOVE' ? 'Removed line' : t;

/* Owner 2026-07-16 — Before / After were two plain columns the approver had to
   diff character-by-character. The moved field is now struck on the Before side
   and emphasised on the After side; untouched fields stay plain, so the eye
   lands on the ask. Inline styles because this table is CSS-modules, not
   Tailwind (the AmendmentDetailV2 job card does the same with utility classes);
   #0c3f39 is this stylesheet's own brand-dark (see .codeCell) rather than a
   var(--ink)-style token — the desktop app defines no such variable, it is
   scoped to .hz-m in mobile.css, so it would silently resolve to nothing here. */
const strikeIf = (changed: boolean): CSSProperties | undefined =>
  changed ? { textDecoration: 'line-through', opacity: 0.7 } : undefined;
const emphasiseIf = (changed: boolean): CSSProperties | undefined =>
  changed ? { fontWeight: 700, color: '#0c3f39' } : undefined;

/* The responsible department(s) for a row's changed atoms — de-duplicated, for
   the amendment diff modal's Dept column (accountability routing). */
const deptOf = (kinds: AmendmentFieldKind[]): string => {
  const seen: string[] = [];
  for (const k of kinds) {
    const d = routeField(k).department;
    if (!seen.includes(d)) seen.push(d);
  }
  return seen.join(', ') || '—';
};

const AmendmentDiffModal = ({
  amendmentId,
  currency,
  onClose,
}: {
  amendmentId: string;
  currency: string;
  onClose: () => void;
}) => {
  const { data, isLoading, error } = useAmendmentDetail(amendmentId);
  /* Only the lines that actually request something — a recorded line whose new_*
     equals its own old_snapshot is not a change and must not render as one
     (Owner 2026-07-16). Pre-fix rows are already in the DB, so this filter is
     what makes them readable, not the builder fix. */
  const allLines = (data?.lines ?? []) as AmendmentLine[];
  const lines = visibleAmendmentLines(allLines);
  /* The HEADER half (mig 0119) — without this a Delivery-Date-only amendment
     opened as "no line changes recorded" and the requested change was invisible. */
  const headerDiffs = amendmentHeaderDiffRows(
    data?.amendment?.header_changes as SoAmendmentHeaderChanges | null | undefined,
    data?.amendment?.old_header_snapshot as SoAmendmentHeaderChanges | null | undefined,
    formatDate,
  );

  const oldOf = amendmentOldSnapshot;

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
        <header className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>
            <History {...ICON} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Requested changes
            {data?.amendment?.amendment_no ? ` — ${String(data.amendment.amendment_no)}` : ''}
          </h3>
          <button type="button" className={styles.iconBtn} onClick={onClose} title="Close">
            <X {...ICON} />
          </button>
        </header>

        <div className={styles.modalBody}>
          {isLoading ? (
            <p className={styles.muted}>Loading changes…</p>
          ) : error ? (
            <div className={styles.bannerWarn}>
              <strong>Could not load the changes.</strong>{' '}
              {error instanceof Error ? error.message : 'Something went wrong.'}
            </div>
          ) : lines.length === 0 && headerDiffs.length === 0 ? (
            /* Distinguish "nothing recorded" from "every recorded line is a
               no-op" — the latter is a legacy amendment raised before the header
               half existed (mig 0119), whose real ask only survives in Reason. */
            <p className={styles.muted}>
              {allLines.length > 0
                ? 'No line changes recorded — every line matches the order exactly. This request predates order-detail tracking, so what was asked for is in the Reason below.'
                : 'This amendment has no changes recorded.'}
            </p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Change</th>
                  <th>Before</th>
                  <th>After</th>
                  <th>Dept</th>
                </tr>
              </thead>
              <tbody>
                {/* Order details (dates / delivery location) first, then lines. */}
                {headerDiffs.map((d) => (
                  <tr key={d.key}>
                    <td><strong>{d.label}</strong></td>
                    <td><span className={styles.muted}>{d.from}</span></td>
                    <td>{d.to}</td>
                    <td><span className={styles.muted}>{deptOf([soHeaderFieldKind(d.key) as AmendmentFieldKind])}</span></td>
                  </tr>
                ))}
                {lines.map((l) => {
                  const old = oldOf(l);
                  /* Emphasise the field that actually moved — the two columns
                     were plain text you had to diff character-by-character. */
                  const chg = amendmentLineChangedFields(l);
                  const summary = amendmentVariantSummaries(l).to;
                  return (
                    <tr key={l.id}>
                      <td><strong>{changeTypeLabel(l.change_type)}</strong></td>
                      <td>
                        {l.change_type === 'ADD' ? (
                          <span className={styles.muted}>—</span>
                        ) : (
                          <div>
                            <div className={styles.codeCell} style={strikeIf(chg.itemCode)}>{old.itemCode ?? '—'}</div>
                            <div className={styles.muted}>
                              <span style={strikeIf(chg.qty)}>Qty {old.qty ?? '—'}</span>
                              {typeof old.unitPriceSen === 'number' ? (
                                <>{' · '}<span style={strikeIf(chg.unitPrice)}>{fmtRm(old.unitPriceSen, currency)}</span></>
                              ) : ''}
                            </div>
                            {old.description2 && (
                              <div className={styles.muted} style={strikeIf(chg.variants)}>{old.description2}</div>
                            )}
                            {/* mig 0280 — the remark this request replaces, shown
                                only when the request touches it. */}
                            {chg.remark && (old.remark ?? '').trim() ? (
                              <div className={styles.muted} style={{ fontStyle: 'italic', ...strikeIf(true) }}>“{old.remark}”</div>
                            ) : null}
                            {chg.discount ? (
                              <div className={styles.muted} style={strikeIf(true)}>Discount {fmtRm(old.discountSen ?? 0, currency)}</div>
                            ) : null}
                          </div>
                        )}
                      </td>
                      <td>
                        {l.change_type === 'REMOVE' ? (
                          <span className={styles.muted}>Removed</span>
                        ) : (
                          <div>
                            <div className={styles.codeCell} style={emphasiseIf(chg.itemCode)}>{l.new_item_code ?? old.itemCode ?? '—'}</div>
                            <div className={styles.muted}>
                              <span style={emphasiseIf(chg.qty)}>Qty {l.new_qty ?? old.qty ?? '—'}</span>
                              {typeof l.new_unit_price_sen === 'number' ? (
                                <>{' · '}<span style={emphasiseIf(chg.unitPrice)}>{fmtRm(l.new_unit_price_sen, currency)}</span></>
                              ) : ''}
                            </div>
                            {summary ? <div className={styles.muted} style={emphasiseIf(chg.variants)}>{summary}</div> : null}
                            {/* mig 0280 — the REQUESTED remark. On a service line
                                this text is the entire request, so it must render
                                here rather than only on the approver's page. */}
                            {chg.remark ? (
                              <div className={styles.muted} style={{ fontStyle: 'italic', ...emphasiseIf(true) }}>
                                {(l.new_remark ?? '').trim() ? `“${l.new_remark}”` : 'Remark cleared'}
                              </div>
                            ) : null}
                            {/* mig 0317 — the requested discount: on a fee line it is the request. */}
                            {chg.discount ? (
                              <div className={styles.muted} style={emphasiseIf(true)}>
                                {Math.round(l.new_discount_sen ?? 0) > 0 ? `Discount ${fmtRm(l.new_discount_sen ?? 0, currency)}` : 'Discount cleared'}
                              </div>
                            ) : null}
                          </div>
                        )}
                      </td>
                      <td><span className={styles.muted}>{deptOf(amendmentLineFieldKinds(l))}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {data?.amendment?.reason ? (
            <p className={styles.muted} style={{ marginTop: 'var(--space-3)' }}>
              <strong>Reason:</strong> {String(data.amendment.reason)}
            </p>
          ) : null}
        </div>

        <footer className={styles.modalFooter}>
          <Button variant="primary" onClick={onClose}>Close</Button>
        </footer>
      </div>
    </div>
  );
};

