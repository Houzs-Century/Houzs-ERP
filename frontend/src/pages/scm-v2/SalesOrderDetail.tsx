
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
import { buildVariantSummary, canonicalizeVariants, consoleAttachOptions, fmtSen, fmtDateOrDash, fmtMoneySen, lineIdentity, missingVariantAxes } from '@2990s/shared';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import {
  useMfgSalesOrderDetail,
  useUpdateMfgSalesOrderHeader,
  useUpdateMfgSalesOrderStatus, useOverrideSoLock,
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
import { useSoHistoryWithRelated } from './so-history-related';
import {
  LOCKED_STATUSES,
  CANCELLABLE_STATUSES,
  isLocked as isSoLocked,
  procLockActive as soProcLockActive,
  amendmentEligible as soAmendmentEligible, migratedReadonly as soMigratedReadonly, migratedReadonlyReason as soMigratedReason, soDownstreamHardLocked, soItemFrozen,
} from '../../vendor/scm/lib/so-detail-gates';
import { soDateGuardError, soErrorText } from '../../vendor/scm/lib/so-form-validate';
import { FROZEN_LINE_LABEL, FROZEN_LINE_LABEL_STYLE, FROZEN_LINE_STYLE } from '../../vendor/scm/lib/so-frozen-line-style';
import { zeroPriceClaim } from '../../vendor/scm/lib/zeroPriceClaim';
import { notifySaveProblems, SaveProblemsList, saveProblemsTitle } from '../../vendor/scm/components/SaveProblemsList';
import { SaveBlockedIndicator } from '../../vendor/scm/components/SaveBlockedIndicator';
import { useSoValidate } from '../../vendor/scm/lib/use-so-validate';
import { authedFetch, type SaveProblem } from '../../vendor/scm/lib/authed-fetch';
import {
  buildAmendmentHeaderChanges,
  hasAmendmentHeaderChanges,
  withoutFrozenHeaderFields,
  amendmentHeaderDiffRows,
  soHeaderFieldKind,
  type SoAmendmentHeaderChanges,
} from '../../vendor/scm/lib/so-amendment-header';
import { diffHeaderPayload, hasHeaderChanges } from '../../vendor/scm/lib/so-header-diff';
import { soSaveEndFields, soVersionAfter } from '../../vendor/scm/lib/so-save-lease';
import { planAmendmentSubmit, amendmentSubmittedNotice, AMENDMENT_MODE_BANNER,
  AMENDMENT_NOTHING_TO_SUBMIT } from '../../vendor/scm/lib/so-amendment-submit';
import { useAmendmentSubmitDialog, RequestProcessingDateRemoval } from '../../vendor/scm/components/AmendmentSubmitDialog';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { soConfirmDateNote } from '../../lib/soConfirmDateNote';
import { SoAddressLines } from '../../components/SoAddressLines';
import { formatDate } from '../../lib/utils';
import { SoLineCard, emptySoLine, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import { PaymentsTable, type PaymentDraft, type PaymentCommitResult } from '../../vendor/scm/components/PaymentsTable';
import { paymentSaveOutcome } from '../../vendor/scm/lib/payment-save-outcome';
import { completePaymentRetryDraft, consumePaymentRetryNavigationState, readPaymentRetryHandoff, readPaymentRetryNavigationState } from '../../lib/paymentRetryHandoff';
import { DocumentRelationshipMapModal, DocumentChoiceDialog } from '../../components/scm-v2/DocumentRelationshipMapModal';
import { useSoRelationshipMap } from './so-relationship-map';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { passesSoffioReminder } from '../../vendor/scm/lib/soffio-reminder';
import { SoLockBanner } from './SoLockBanner';
import { SaveFailedBanner } from './SaveFailedBanner';
import { soAfterDoMode, soPriceAfterDoOn, soLinesAfterDoOn, afterDoEditableLine, afterDoProductLineEditable, afterDoFeeLineEditable, afterDoHeaderFields, afterDoEditFields, afterDoAddFields, afterDoCopyProblem, type AfterDoSave } from '../../vendor/scm/lib/so-after-do-client';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { AMENDMENT_APPROVER_LABEL, soAmendmentApprover } from '../../vendor/scm/lib/amendment-approver';
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
  visibleAmendmentLines, amendmentLineSig, amendmentVariantsKey, amendmentRequestedUnitPriceSen, amendmentPriceFields} from '../../vendor/scm/lib/so-amendment-line-diff';
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
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { SearchableSelect } from '../../vendor/scm/components/SearchableSelect';
import { AddressPostcodeField } from '../../vendor/scm/components/AddressPostcodeField';
import { DebtorSuggestList } from '../../vendor/scm/components/DebtorSuggestList';
import { soStatusDisplay, type DeliveryState, type SoLifecycle } from '../../vendor/scm/lib/so-status';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useAuth } from '../../vendor/scm/lib/auth';
import { useVenues } from '../../vendor/scm/lib/venues-queries';
import { FairDayPicker, FairPicker } from '../../components/FairPicker';
import { fairDayCheck, fairEditPatch, fairElsewhereLine, fairEventOf, fairPickValue, isScannedOrder, linkedEvent, type LinkedFair } from '../../components/fairPick';
import { useStateWarehouseMappings } from '../../vendor/scm/lib/state-warehouse-queries';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
import { generateSalesOrderPdf } from '../../vendor/scm/lib/sales-order-pdf';
import { newIdempotencyKey } from '../../lib/idempotency';
import { deferLineDateToHeader } from '../../vendor/scm/lib/so-line-date-defer';
import { useSoVariantCascade, useSoLineDeliveryDateCascade } from './use-so-variant-cascade';
import {
  dropStagedAdd, firstBlankStagedAdd, namedStagedAdds,
  patchStagedAdd, runSoLineWrites, stagedAddDrafts, stagedAddLabel, visibleLineCounts,
  type StagedAddLine, splitSofaPiecesOnEdit, SOFA_PIECES_SPLIT_DIALOG,
} from './so-add-lines';
import {
  readVersionConflict, SoVersionConflictBanner, type SoVersionConflict,
} from './so-version-conflict';
import { RevisionsTab } from './so-revisions-tab';
import styles from './SalesOrderDetail.module.css';
import { DetailLoadFailure } from './DetailLoadFailure';
import { PriceAfterDoModal } from './PriceAfterDoModal';
import { DateField } from "../../vendor/scm/components/DateField";
import { HoldChip } from "../../vendor/scm/components/HoldChip";
import { CancelRequestPanel } from "../../vendor/scm/components/CancelRequestPanel"; import { useCancelRequestAction } from "./use-cancel-request-action";
import { useDiscardDraftAction } from "./use-discard-draft-action";

import { ADD_LINE_LABEL } from '../../vendor/scm/lib/add-line-handoff';
import { useAddLineHandoff } from '../../vendor/scm/lib/useAddLineHandoff';
import { FormTouchScope } from '../../components/FormTouchScope';
import { useFormTouched, useLeaveGuard } from '../../hooks/useLeaveGuard';
const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const LOCK_BANNER_INNER_STYLE: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 8,
};
const VARIANT_WARN_BANNER_STYLE: CSSProperties = {
  background: 'rgba(184, 51, 31, 0.08)',
  border: '1px solid var(--c-festive-b, #B8331F)',
  color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))',
  padding: 'var(--space-3) var(--space-4)',
  borderRadius: 'var(--radius-md)',
  fontSize: 'var(--fs-13)',
};
const VARIANT_WARN_LIST_STYLE: CSSProperties = { marginTop: 4, fontSize: 'var(--fs-12)' };
const DATES_XOR_WARN_STYLE: CSSProperties = {
  background: 'rgba(184, 51, 31, 0.08)',
  border: '1px solid var(--c-festive-b, #B8331F)',
  color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))',
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

const formatGroupRequirements = (g: string): string =>
  g === 'bedframe' ? 'Divan · Leg · Gap · Fabric' :
  g === 'sofa'     ? 'Seat · Leg · Fabric' : '';

const STATUS_LIST = [
  'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP',
  'SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED',
] as const;
type SoStatus = typeof STATUS_LIST[number];

const STATUS_CLASS: Record<string, string> = {
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

const SO_STATUS_LABEL: Record<string, string> = {
  DRAFT:         'Draft',
  CONFIRMED:     'Submitted',
  IN_PRODUCTION: 'In Production',
  READY_TO_SHIP: 'Stock Ready',
  SHIPPED:       'Arranged',
  DELIVERED:     'Delivered',
  INVOICED:      'Invoiced',
  CLOSED:        'Closed',
  ON_HOLD:       'On Hold',
  CANCELLED:     'Cancelled',
};

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneySen(centi, currency);


type SoHeader = {
  doc_no: string;
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
  venue_id: string | null;
  fair?: LinkedFair | null; // the linked event (owner 2026-09-24); absent on an older server
  fair_date?: string | null; fair_match?: string | null;
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
  amendment_eligible?: boolean;
  /* Owner 2026-08-12 — a live PO already claims one of this SO's lines (2990
     only). Feeds soProcLockActive, which is why the line/State/Postcode freeze
     below fires with no processing date involved. */
  po_locked?: boolean;
  processing_date_po_locked?: boolean;
  has_children?: boolean; downstream_fully_frozen?: boolean;
  has_open_amendment?: boolean;
  open_amendment?: { id: string; status: string; amendment_no: string; lane?: string | null } | null;
  open_amendments?: Array<{ id: string; status: string; amendment_no: string; lane?: string | null }> | null;
  customer_id: string | null;
  customer_state: string | null;
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
  email: string | null;
  customer_type: string | null;
  salesperson_id: string | null;
  city: string | null;
  postcode: string | null;
  building_type: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  target_date: string | null;
  signature_b64: string | null;
  slip_key: string | null;
  slip_state: 'none' | 'pending' | 'verified' | 'flagged' | null;
  slip_image_key: string | null;
  receipt_image_key: string | null;
  payment_method: string | null;
  installment_months: number | null;
  merchant_provider: string | null;
  approval_code: string | null;
  payment_date: string | null;
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
  photo_urls: string[] | null;
  cancelled: boolean; downstream_frozen?: boolean; // a live DO / SI carries it — greyed, read-only (owner 2026-09-15)
  line_delivery_date: string | null;
  line_delivery_date_overridden: boolean;
  deliveries?: { doNumber: string; qty: number; status: string }[];
  delivered_qty?: number;
  remaining_qty?: number;
  coverage_po?: string | null;
  coverage_eta?: string | null;
  shipped_source_pos?: string[];
  /* Shipped from a PO-less stock ADJUSTMENT lot (free gift / add-back) —
     rendered as "STOCK ADJ", never a blank (owner 2026-08-01). */
  shipped_source_adj?: boolean;
  ready_source_pos?: Array<{ po: string | null; qty: number; kind: 'po' | 'adjustment' }>;
  stock_state?: 'stock' | 'po' | 'shortage' | null;
};

const draftFromItem = (it: SoItem): SoLineDraft => ({
  itemCode:       it.item_code ?? '',
  itemGroup:      it.item_group ?? 'others',
  description:    it.description ?? '',
  uom:            it.uom ?? 'UNIT',
  qty:            it.qty ?? 1,
  unitPriceSen: it.unit_price_sen ?? 0,
  priceAuthored: true,
  discountSen:  it.discount_sen ?? 0,
  unitCostSen:  it.unit_cost_sen ?? 0,
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
  const addLineHandoff = useAddLineHandoff();
  const detail = useMfgSalesOrderDetail(docNo ?? null);
  const updateHeader = useUpdateMfgSalesOrderHeader();
  const updateStatus = useUpdateMfgSalesOrderStatus(); const overrideLock = useOverrideSoLock();
  const requestCancel = useCancelRequestAction('so');
  const deleteDraft = useDiscardDraftAction();
  const askConfirm = useConfirm();
  const submitDialog = useAmendmentSubmitDialog();
  const notify = useNotify();
  const addItem = useAddMfgSalesOrderItem();
  const updateItem = useUpdateMfgSalesOrderItem();
  const deleteItem = useDeleteMfgSalesOrderItem();
  const uploadPhoto = useUploadSoItemPhoto();

  const { user: currentUser, can } = useHouzsAuth();
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
  const [activeTab, setActiveTab] = useState<'order' | 'revisions'>('order');
  const [viewingAmendmentId, setViewingAmendmentId] = useState<string | null>(null);
  const [showSupplierForm, setShowSupplierForm] = useState(false);

  const header = (detail.data?.salesOrder as SoHeader | undefined) ?? null;
  const items = useMemo(() => (detail.data?.items as SoItem[] | undefined) ?? [], [detail.data]);
  const itemIdsInOrder = useMemo(() => items.map((it) => it.id), [items]);
  const frozenIdsRef = useRef<ReadonlySet<string>>(new Set()); frozenIdsRef.current = new Set(items.filter(soItemFrozen).map((it) => it.id));

  const loadedVersionRef = useRef<number | undefined>(undefined);
  const loadedVersionDocRef = useRef<string | undefined>(undefined);
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

  const requireVariants = !!header?.processing_date;
  const incompleteVariantLines = useMemo(() => {
    if (!requireVariants) return [];
    return items
      .filter((it) => missingVariantAxes(it.item_group, it.variants as Record<string, unknown> | null, it.item_code).length > 0)
      .map((it) => ({ code: it.item_code, group: (it.item_group ?? '').toLowerCase() }));
  }, [items, requireVariants]);

  const printPaymentsQ = useSalesOrderPayments(docNo ?? null);

  const [editingDrafts, setEditingDrafts] = useState<Record<string, SoLineDraft>>({});
  const originalDraftsRef = useRef<Record<string, SoLineDraft>>({});
  /* Owner 2026-08-16: "it should be able to keep adding lines." A single
     nullable draft + a self-hiding button capped an edit session at ONE. */
  const [addingDrafts, setAddingDrafts] = useState<StagedAddLine[]>([]);
  const attachOptionsById = useMemo(() => {
    const rows = items.map((it) => {
      const d = it.id in editingDrafts ? editingDrafts[it.id] : null;
      return { id: it.id, itemCode: d ? d.itemCode : it.item_code, itemGroup: d ? d.itemGroup : it.item_group };
    });
    for (const a of addingDrafts) rows.push({ id: a.key, itemCode: a.draft.itemCode, itemGroup: a.draft.itemGroup });
    const out: Record<string, string[] | null> = {};
    rows.forEach((r, i) => { out[r.id] = consoleAttachOptions(rows, i); });
    return out;
  }, [items, editingDrafts, addingDrafts]);
  const [overriding, setOverriding] = useState<SoItem | null>(null);
  const [repricing, setRepricing] = useState<SoItem | null>(null);
  const [unlockOverride, setUnlockOverride] = useState(false), [afterDoTargetId, setAfterDoTargetId] = useState<string | null>(null), afterDoRef = useRef<AfterDoSave | null>(null); // DEV-32
  const [historyOpen, setHistoryOpen] = useState(false);

  const [editSearchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(
    editSearchParams.get('edit') === '1',
  );
  const { touched: formTouched, markTouched, resetTouched } = useFormTouched();
  useLeaveGuard(isEditing && formTouched, null);
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
    editSearchParams.get('payments') === '1',
  );
  useEffect(() => { if (isEditing) setPayEditing(false); }, [isEditing]);
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
  const {
    nodes: chainNodes,
    onNodeClick: onChainNodeClick,
    amendments: chainAmendments,
    onAmendmentClick: onChainAmendmentClick,
    returns: chainReturns, onReturnClick: onChainReturnClick,
    pairing: chainPairing,
    choice: chainChoice,
    closeChoice: closeChainChoice,
    pickChoice: pickChainChoice,
  } = useSoRelationshipMap(header);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [versionConflict, setVersionConflict] = useState<SoVersionConflict | null>(null);
  const customerCardRef = useRef<CustomerCardHandle | null>(null);

  const amendKeyRef = useRef<string | null>(null);
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

  const clearSaveFeedback = () => { setSaveError(null); setVersionConflict(null); };

  /* Backend authors the submit-blocked list (owner 2026-09-16). The draft carries
     the edit context (isEdit + ORIGINAL dates/line groups) so the grandfather +
     introduced-mix carve-outs run server-side. Name/address/venue/salesperson/
     location stay the server PATCH's gate; stored dates on both sides grandfather,
     and the CustomerCard validate() supplies the edited-date fault. */
  const editedDraftGroups = useMemo(
    () => [...Object.values(editingDrafts), ...stagedAddDrafts(addingDrafts)].filter((d) => d.itemCode.trim()),
    [editingDrafts, addingDrafts],
  );
  const buildEditValidateDraft = useCallback(() => {
    const proc = header?.processing_date ? String(header.processing_date).slice(0, 10) : '';
    const deliv = header?.customer_delivery_date ? String(header.customer_delivery_date).slice(0, 10) : '';
    return {
      isEdit: true, hasVenue: true, hasSalesperson: true, fillAddressLater: false, companyCode: null, salesLocation: '', payments: [], ...customerCardRef.current?.fairDayKeys(),
      phone: customerCardRef.current?.getPhone() ?? header?.phone, origPhone: header?.phone ?? '', debtorName: header?.debtor_name,
      address1: header?.address1, postcode: header?.postcode, customerState: header?.customer_state,
      items: editedDraftGroups.map((d) => ({ itemCode: d.itemCode, itemGroup: d.itemGroup, variants: d.variants, qty: d.qty })),
      origItemGroups: items.map((it) => it.item_group),
      processingDate: proc, customerDeliveryDate: deliv, origProcessingDate: proc, origDeliveryDate: deliv,
    };
  }, [editedDraftGroups, header, items]);
  const liveEditDraft = useMemo(() => buildEditValidateDraft(), [buildEditValidateDraft]);
  const { problems: editBackendProblems } = useSoValidate(liveEditDraft, !!header);
  const editClientExtras = useMemo<SaveProblem[]>(() => {
    const blankAdd = firstBlankStagedAdd(addingDrafts);
    const blankLine = Object.values(editingDrafts).some((d) => !d.itemCode.trim());
    return [
      ...(blankLine ? [{ code: 'line_unpicked', message: 'Every line must have a product selected before saving.', field: 'Line items' }] : []),
      ...(blankAdd != null ? [{ code: 'line_unpicked', message: `${stagedAddLabel(blankAdd)} has no product picked — pick one, or remove that line before saving.`, field: 'Line items' }] : []),
    ];
  }, [editingDrafts, addingDrafts]);
  const editBlockingProblems = useMemo(() => [...editBackendProblems, ...editClientExtras], [editBackendProblems, editClientExtras]);
  const openEditBlockingList = () => {
    void notify({ title: saveProblemsTitle(editBlockingProblems.length), body: <SaveProblemsList problems={editBlockingProblems} />, tone: 'error' });
  };
  const enterEdit  = () => { clearSaveFeedback(); resetTouched(); setIsEditing(true); };
  const cancelEdit = () => {
    customerCardRef.current?.reset();
    clearSaveFeedback();
    endEditSession();
    returnToDetail();
  };

  const [savingOrder, setSavingOrder] = useState(false);
  const savePressRef = useRef(false);
  const [savePressed, setSavePressed] = useState(false);
  const saveNow = () => {
    if (savePressRef.current) return;
    savePressRef.current = true;
    setSavePressed(true);
    void (amendmentMode ? submitAmendment : saveEdit)().finally(() => { savePressRef.current = false; setSavePressed(false); });
  };
  const saveEdit = async () => {
    const handle = customerCardRef.current;
    if (!handle || !header) return;
    if (savingOrder) return;
    clearSaveFeedback();

    const pieces = splitSofaPiecesOnEdit({ editing: editingDrafts, originals: originalDraftsRef.current, adding: addingDrafts, mintKey: newIdempotencyKey });
    if (pieces) { setEditingDrafts(pieces.editing); setAddingDrafts(pieces.adding); await notify(SOFA_PIECES_SPLIT_DIALOG); return; }
    const blankAddPos = firstBlankStagedAdd(addingDrafts);
    const blankLine = Object.values(editingDrafts).find((d) => !d.itemCode.trim());
    const headerErr = handle.validate();
    let serverProblems: SaveProblem[] = [];
    try {
      const r = await authedFetch<{ problems: SaveProblem[] }>('/mfg-sales-orders/validate', {
        method: 'POST', body: JSON.stringify(buildEditValidateDraft()),
      });
      serverProblems = r.problems;
    } catch { /* silent-write-ok: read-only dry-run; the writes below are the gate. */ }
    const problems: SaveProblem[] = [
      ...serverProblems,
      ...(blankAddPos != null ? [{ code: 'line_unpicked', message: `${stagedAddLabel(blankAddPos)} has no product picked — pick one, or remove that line before saving.`, field: 'Line items' }] : []),
      ...(blankLine ? [{ code: 'line_unpicked', message: 'Every line must have a product selected before saving.', field: 'Line items' }] : []),
      ...(headerErr ? [{ code: 'date_invalid', message: headerErr, field: 'Dates' }] : []),
    ];
    if (problems.length > 0) {
      void notify({ title: saveProblemsTitle(problems.length), body: <SaveProblemsList problems={problems} />, tone: 'error' });
      return;
    }

    setSavingOrder(true);
    const lineEntries = Object.entries(editingDrafts).filter(([id, d]) => {
      const orig = originalDraftsRef.current[id];
      if (!orig) return true;
      if (lineCommitSig(d) === lineCommitSig(orig)) return false;
      if (!d.lineDeliveryDateOverridden && !orig.lineDeliveryDateOverridden) {
        return lineCommitSig({ ...d, lineDeliveryDate: null })
            !== lineCommitSig({ ...orig, lineDeliveryDate: null });
      }
      return true;
    });
    const deleteEntries = items.filter((it) => !(it.id in editingDrafts));
    const pendingAdds = addingDrafts;
    const addLabel = (row: StagedAddLine, i: number) =>
      row.draft.itemCode.trim() || stagedAddLabel(i + 1);
    const itemLabel = (id: string) => editingDrafts[id]?.itemCode.trim()
      || items.find((it) => it.id === id)?.item_code || 'A line';

    const saveHeader = () => new Promise<void>((resolve, rejectSave) => {
      handle.save({
        onSuccess: () => resolve(),
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
        }).then((result) => { loadedVersionRef.current = soVersionAfter(result, loadedVersionRef.current); })
      : Promise.resolve();

    await reserveHeader
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
      .then(async () => commitPaymentsRef.current?.() ?? { committed: 0, failed: 0, blocked: [] })
      .then((pay: PaymentCommitResult) => {
        setSavingOrder(false);
        const outcome = paymentSaveOutcome(pay);
        if (outcome.stay) { setSaveError(outcome.message ?? 'Some payment rows were not saved.'); return; }
        endEditSession();
        returnToDetail();
      })
      .catch((e) => {
        setSavingOrder(false);
        const heldLease = activeLineLeaseRef.current;
        if (heldLease && loadedVersionRef.current != null) {
          void updateHeader.mutateAsync({
            docNo: header.doc_no,
            completeLineWrites: true,
            lineWriteLeaseToken: heldLease,
            version: loadedVersionRef.current,
            __suppressInvalidate: true,
          }).then(() => { activeLineLeaseRef.current = null; }, () => { });
        }
        const conflict = readVersionConflict((e as { body?: string } | undefined)?.body);
        if (conflict) { setVersionConflict(conflict); return; }
        /* An aggregated save-gate failure (validation_failed) — show EVERY reason
           at once in a POPUP the owner can't miss (owner 2026-07-18: he wanted a
           modal listing all reasons, not a banner to scroll to). Anything else
           keeps the inline banner. */
        void notifySaveProblems(notify, e, setSaveError);
      });
  };


  const buildAmendmentLines = (): CreateAmendmentLine[] => {
    const out: CreateAmendmentLine[] = [];
    for (const it of items) {
      const draft = editingDrafts[it.id];
      if (!draft) continue;
      const orig = originalDraftsRef.current[it.id] ?? draftFromItem(it);
      const requestedUnitSen = amendmentRequestedUnitPriceSen(draft);
      const effective = { ...draft, unitPriceSen: requestedUnitSen ?? orig.unitPriceSen };
      if (amendmentLineSig(effective) === amendmentLineSig(orig)) continue;
      const qtyOnly =
        draft.itemCode === orig.itemCode
        && amendmentVariantsKey(draft.variants) === amendmentVariantsKey(orig.variants)
        && effective.unitPriceSen === orig.unitPriceSen
        && draft.qty !== orig.qty;
      out.push({
        salesOrderItemId: it.id,
        changeType: qtyOnly ? 'QTY' : 'SPEC',
        newItemCode: draft.itemCode || undefined,
        newVariants: draft.variants ?? undefined,
        newQty: draft.qty,
        ...amendmentPriceFields(draft),
        ...(((draft.remark ?? '') !== (orig.remark ?? ''))
          ? { newRemark: draft.remark ?? '' }
          : {}),
        ...((Math.round(draft.discountSen) !== Math.round(orig.discountSen))
          ? { newDiscountSen: Math.max(0, Math.round(draft.discountSen)) }
          : {}),
        oldSnapshot: {
          itemCode: it.item_code,
          variants: it.variants ?? null,
          qty: it.qty,
          unitPriceSen: it.unit_price_sen,
          description2: it.description2 ?? null,
        },
      });
    }
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
    for (const { draft } of namedStagedAdds(addingDrafts)) {
      out.push({
        changeType: 'ADD',
        newItemCode: draft.itemCode,
        newVariants: draft.variants ?? undefined,
        newQty: draft.qty,
        newUnitPriceSen: draft.unitPriceSen,
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
    /* ONE consolidated client pre-flight for the amendment submit, shown all at
       once in the same SaveProblemsList popup the server uses (owner 2026-09-16).
       An amendment does not re-check variants or sofa mix (those ride the line
       diff); its client blockers are a blank staged add, the compulsory phone,
       and the header date fault (the shared guard's original-date carve-out
       keeps this from tripping on the SO's own unchanged past processing date —
       the state every amendable SO is in). */
    const blankAddPos = firstBlankStagedAdd(addingDrafts);
    const headerErr = handle.validate();
    let serverProblems: SaveProblem[] = [];
    try {
      const r = await authedFetch<{ problems: SaveProblem[] }>('/mfg-sales-orders/validate', {
        method: 'POST',
        body: JSON.stringify({
          isEdit: true, hasVenue: true, hasSalesperson: true, fillAddressLater: false, companyCode: null, salesLocation: '', payments: [], ...handle.fairDayKeys(),
          processingDate: '', customerDeliveryDate: '', phone: handle.getPhone(), origPhone: header?.phone ?? '', debtorName: header?.debtor_name,
          items: items.map((it) => ({ itemCode: it.item_code, itemGroup: it.item_group, variants: {}, qty: it.qty })),
          origItemGroups: items.map((it) => it.item_group),
        }),
      });
      serverProblems = r.problems;
    } catch { /* silent-write-ok: read-only dry-run; the amendment write below is the gate. */ }
    const problems: SaveProblem[] = [
      ...serverProblems,
      ...(blankAddPos != null ? [{ code: 'line_unpicked', message: `${stagedAddLabel(blankAddPos)} has no product picked — pick one, or remove that line before submitting.`, field: 'Line items' }] : []),
      ...(headerErr ? [{ code: 'date_invalid', message: headerErr, field: 'Dates' }] : []),
    ];
    if (problems.length > 0) {
      void notify({ title: saveProblemsTitle(problems.length), body: <SaveProblemsList problems={problems} />, tone: 'error' });
      return;
    }

    const { changes: headerChanges } = handle.getLockedHeaderChanges();
    const lines = buildAmendmentLines();

    const plan = planAmendmentSubmit({
      hasLineChanges: lines.length > 0,
      hasFrozenHeaderChanges: hasAmendmentHeaderChanges(headerChanges),
      hasDirectHeaderChanges: handle.hasDirectHeaderChanges(),
    });
    if (plan === 'NOTHING') { setSaveError(AMENDMENT_NOTHING_TO_SUBMIT); return; }
    /* DIRECT_ONLY needs no ask: nothing is going for approval. Otherwise the shared
       dialog shows WHO approves and takes the required reason
       (owner 2026-09-15; vendor/scm/components/AmendmentSubmitDialog). */
    const answer = plan === 'AMENDMENT'
      ? await submitDialog.ask({ docNo: header.doc_no, lines, headerChanges })
      : { reason: '' };
    if (answer == null) return;
    setSavingOrder(true);
    try {
      await new Promise<void>((resolve, reject) => {
        handle.save(
          { onSuccess: () => resolve(), onError: (msg) => reject(new Error(msg)) },
          { keepLockedColsAsOriginal: true },
        );
      });
      let createdRes: unknown = null;
      if (plan === 'AMENDMENT') {
        amendKeyRef.current ??= newIdempotencyKey();
        createdRes = await createAmendment.mutateAsync({
          docNo: header.doc_no,
          reason: answer.reason,
          lines,
          headerChanges,
          idempotencyKey: amendKeyRef.current,
        });
      }
      setSavingOrder(false);
      endEditSession();
      notify(amendmentSubmittedNotice(plan, createdRes));
    } catch (e) {
      setSavingOrder(false);
      const conflict = readVersionConflict((e as { body?: string } | undefined)?.body);
      if (conflict) { setVersionConflict(conflict); return; }
      setSaveError(e instanceof Error ? e.message : 'Something went wrong.');
    }
  };

  const adoptServerVersion = () => {
    const v = versionConflict?.serverVersion;
    if (v == null) return false;
    loadedVersionRef.current = v;
    setVersionConflict(null);
    return true;
  };

  const stableDocNo = docNo ?? '';
  const handleHeaderSave = useCallback(
    (patch: Record<string, unknown>, cb?: { onSuccess?: () => void; onError?: (msg: string, raw?: unknown) => void }) => {
      const lineLease = activeLineLeaseRef.current;
      if (Object.keys(patch).length === 0 && !lineLease) { cb?.onSuccess?.(); return; }
      const VERIFY: Record<string, string> = {
        debtorName: 'debtor_name', debtorCode: 'debtor_code', agent: 'agent', ref: 'ref',
      };
      const __verify: Record<string, unknown> = {};
      for (const [k, col] of Object.entries(VERIFY)) if (k in patch) __verify[col] = patch[k];
      updateHeader.mutate(
        {
          docNo: stableDocNo,
          ...patch,
          ...soSaveEndFields(lineLease),
          ...afterDoHeaderFields(afterDoRef.current, patch),
          version: loadedVersionRef.current,
          ...(Object.keys(__verify).length ? { __verify } : {}),
        },
        {
          onSuccess: (result) => {
            loadedVersionRef.current = soVersionAfter(result, loadedVersionRef.current);
            if (lineLease) activeLineLeaseRef.current = null;
            const copyMsg = afterDoCopyProblem(result); if (copyMsg) void notify({ title: 'Delivery Order not updated', body: copyMsg, tone: 'error' });
            cb?.onSuccess?.();
          },
          onError:   (e) => cb?.onError?.(e instanceof Error ? e.message : 'Something went wrong.', e),
        },
      );
    },
    [stableDocNo, updateHeader, notify],
  );
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  const patchEditingDraft = useCallback((id: string, patch: Partial<SoLineDraft>) => {
    setEditingDrafts((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      return { ...prev, [id]: { ...cur, ...patch } };
    });
  }, []);

  const cascadeDeliveryDateToLines = useSoLineDeliveryDateCascade(
    setEditingDrafts, setAddingDrafts, frozenIdsRef,
  );
  useSoVariantCascade({
    isEditing, orderedIds: itemIdsInOrder,
    editingDrafts, addingDrafts, frozenIds: frozenIdsRef.current,
    setEditingDrafts, setAddingDrafts,
  });

  const removeEditingLine = useCallback((id: string) => {
    setEditingDrafts((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  useEffect(() => {
    if (!isEditing) {
      setEditingDrafts({});
      setAddingDrafts([]);
      originalDraftsRef.current = {};
      return;
    }
    // On items refetch (a photo upload/delete invalidates the SO detail),
    // MERGE — keep the user's in-flight drafts, seed only new lines, drop
    // gone ones. A naive re-seed used to wipe unsaved picks (docs/bugs/).
    const orig: Record<string, SoLineDraft> = {};
    for (const it of items) orig[it.id] = draftFromItem(it);
    originalDraftsRef.current = orig;
    setEditingDrafts((prev) => {
      const alive = new Set(items.map((it) => it.id));
      const next: Record<string, SoLineDraft> = {};
      for (const id of Object.keys(prev)) if (alive.has(id)) next[id] = prev[id];
      for (const it of items) if (!(it.id in next)) next[it.id] = draftFromItem(it);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, items]);

  const rowCallbacks = useMemo(() => {
    const map = new Map<string, {
      onChange: (patch: Partial<SoLineDraft>) => void;
      onRemove: () => void;
    }>();
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
              removeEditingLine(it.id);
              return;
            }
            removeEditingLine(it.id);
          }
        },
      });
    }
    return map;
  }, [items, patchEditingDraft, removeEditingLine, askConfirm,
      header?.amendment_eligible, header?.has_open_amendment]);

  const startAddLine = () => {
    if (!header) return;
    setAddingDrafts((prev) => [...prev, {
      key: newIdempotencyKey(),
      idempotencyKey: newIdempotencyKey(),
      draft: {
        ...emptySoLine(),
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

  const commitEditingDraft = (id: string, d: SoLineDraft) =>
    updateItem.mutateAsync({
      docNo: header!.doc_no,
      itemId: id, ...afterDoEditFields(afterDoRef.current, id),
      leaseToken: activeLineLeaseRef.current!,
      itemCode:       d.itemCode,
      itemGroup:      d.itemGroup,
      description:    d.description,
      uom:            d.uom,
      qty:            d.qty,
      unitPriceSen: d.unitPriceSen,
      ...zeroPriceClaim(d.unitPriceSen, d.priceAuthored === true),
      discountSen:  d.discountSen,
      unitCostSen:  d.unitCostSen,
      variants:       d.variants,
      remark:         d.remark,
      lineDeliveryDate: deferLineDateToHeader({ storedProcessingDate: header!.processing_date, overridden: !!d.lineDeliveryDateOverridden }) ? undefined : (d.lineDeliveryDate ?? null),
      lineDeliveryDateOverridden: d.lineDeliveryDateOverridden ?? false,
    }).then((r) => { const msg = afterDoCopyProblem(r); if (msg) void notify({ title: 'Delivery Order not updated', body: msg, tone: 'error' }); return r; });

  const commitAddLine = async (staged: StagedAddLine) => {
    const d = staged.draft;
    const pendingFiles = d.pendingPhotoFiles ?? [];
    const res = await addItem.mutateAsync({
      docNo: header!.doc_no,
      idempotencyKey: staged.idempotencyKey, ...afterDoAddFields(afterDoRef.current),
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
      lineDeliveryDate: deferLineDateToHeader({ storedProcessingDate: header!.processing_date, overridden: !!d.lineDeliveryDateOverridden }) ? undefined : (d.lineDeliveryDate ?? null),
      lineDeliveryDateOverridden: d.lineDeliveryDateOverridden ?? false,
    });
    const newItemId = (res.item as { id?: string } | null)?.id, copyMsg = afterDoCopyProblem(res); if (copyMsg) void notify({ title: 'Delivery Order not updated', body: copyMsg, tone: 'error' });
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
        <DetailLoadFailure noun="Sales order" error={detail.isError ? detail.error : null} onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
      </div>
    );
  }

  /* Downstream lock, per line (owner 2026-09-15, shared/so-line-freeze.ts): the page locks only when EVERY line is on a live DO/SI; otherwise those lines grey out below. Not overridable, except by soAfterDoMode below. */
  const downstreamLocked = soDownstreamHardLocked(header), migratedLocked = soMigratedReadonly(header);
  const isLocked = migratedLocked || isSoLocked(header.status, downstreamLocked, unlockOverride);
  const afterDo = soAfterDoMode(header, { can, override: unlockOverride, migrated: migratedLocked });
  const priceAfterDo = soPriceAfterDoOn(header, { can, migrated: migratedLocked }), linesAfterDo = soLinesAfterDoOn(header, { can, migrated: migratedLocked }); // DEV-70 $ dialog; owner 2026-11-21 super-admin qty/spec inline
  const canAttributeOther = can('scm.so.attribute_other');

  /* Owner 2026-07-05 — SO PROCESS lock: once the SO has a Processing Date
     (which IS what being proceeded means — owner, pinned 2026-08-13) AND that
     day has passed, we PO to the supplier, so the LINE ITEMS freeze (State + Postcode freeze in the customer
     card below). Payment + the rest of the customer data stay editable. This is
     independent of `isLocked` (status/downstream) — it applies while the SO is
     still in an otherwise-editable status. Shared gate uses todayMyt() (Malaysia
     calendar day) so the lock flips at MYT midnight, not the device's midnight. */
  const procLockActive = soProcLockActive(header);

  const amendmentEligible = soAmendmentEligible(header, isLocked);
  const openAmendment = header.open_amendment ?? null;
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
  const linesLocked = isLocked || (procLockActive && !amendmentMode), chargeAdds = linesLocked && afterDo.on, addLocked = linesLocked && !chargeAdds;
  afterDoRef.current = { mode: afterDo, lineIds: new Set(items.filter((it) => afterDoEditableLine(afterDo, it) || afterDoProductLineEditable(linesAfterDo, it)).map((it) => it.id)), chargeAdds, targetId: afterDoTargetId };
  addLineHandoff.current = { enabled: isEditing && !addLocked, onTrigger: startAddLine };
  const overrideLocked = isLocked || procLockActive;
  const visibleLines = visibleLineCounts({
    isEditing, itemIds: items.map((it) => it.id),
    editingDraftIds: Object.keys(editingDrafts), stagedAdds: addingDrafts.length,
  });
  const canSupplierConfirm = can('scm.amendment.supplier_confirm');
  const canApproveSo = can('scm.amendment.approve_so');

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
  const canCancel = !migratedLocked && CANCELLABLE_STATUSES.includes(header.status);
  const canOfferPayEdit  = !migratedLocked && !isDraftSo && !isCancelled && !isEditing;
  const canEditPayments  = !migratedLocked && (isDraftSo || (!isCancelled && (isEditing || payEditing)));

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

  const togglePayEditing = async () => {
    if (payEditing && !(await guardUnsavedPayments())) return;
    setPayEditing((v) => !v);
  };

  /* Cancel is a REQUEST now (owner 2026-09-08): a reason, then two approvals,
     then the cancel itself — run by CancelRequestPanel on the second signature. */
  const handleCancelSo = () => void requestCancel(header.doc_no, header.doc_no);
  const executeCancel = () => updateStatus.mutate({ docNo: header.doc_no, status: 'CANCELLED', expectedStatus: header.status });
  /* Discard draft (owner 2026-07-20) — hard-delete a junk DRAFT (esp. a bad
     scan/OCR draft) instead of burning a doc number on confirm→cancel. Behind the
     house confirm dialog (no naked destructive action); the backend refuses
     anything but a DRAFT. On success the SO is gone, so we leave the page for the
     SO list rather than render a detail for a deleted order. */
  const handleDiscardDraft = async () => {
    if (await deleteDraft.discard(header.doc_no)) navigate('/scm/sales-orders');
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
  deliverPrintPdfRef.current = deliverPrintPdf;

  return (
    <FormTouchScope onTouch={markTouched}>
    <div className="space-y-4" style={isCancelled ? { filter: 'grayscale(0.7)' } : undefined}>
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
                  <HoldChip
                    onHold={(header as { on_hold?: boolean | null }).on_hold}
                    reason={(header as { hold_reason?: string | null }).hold_reason}
                  />
                </>
              );
            })()}
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
            {/* Request cancellation (owner 2026-09-08) — a reason + two approvals; final once it runs. */}
            {!isCancelled && canCancel && !isEditing ? (
              <Button variant="ghost"
                onClick={handleCancelSo} disabled={updateStatus.isPending}
                style={{ color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' }}>
                <Ban {...ICON} />
                <span>Request cancellation</span>
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
                onClick={enterEdit} disabled={migratedLocked || (isLocked && !canAttributeOther && !afterDo.on && !priceAfterDo && !linesAfterDo)}>
                <Pencil {...ICON} />
                <span>Edit</span>
              </Button>
            ) : (
              <>
                <Button variant="ghost"
                  onClick={cancelEdit} disabled={updateHeader.isPending || savingOrder}>
                  <span>Cancel</span>
                </Button>
                {/* Persistent "Can't save — N to fix" pill (owner 2026-09-16): a
                    blocked Save is never silent; backend-authored, clears live. */}
                {!migratedLocked && <SaveBlockedIndicator problems={editBlockingProblems} onOpen={openEditBlockingList} />}
                {amendmentMode ? (
                  <Button variant="primary"
                    onClick={saveNow} disabled={migratedLocked || savePressed || savingOrder || createAmendment.isPending}>
                    <Save {...ICON} />
                    <span>{savePressed || savingOrder || createAmendment.isPending ? 'Submitting…' : 'Submit amendment request'}</span>
                  </Button>
                ) : (
                  <Button variant="primary"
                    onClick={saveNow} disabled={migratedLocked || savePressed || updateHeader.isPending || savingOrder}>
                    <Save {...ICON} />
                    <span>{savePressed || updateHeader.isPending || savingOrder ? 'Saving…' : 'Save'}</span>
                  </Button>
                )}
              </>
            )}
          </div>
        }
      />

      {saveError && <SaveFailedBanner message={saveError} className={styles.bannerWarn} />}

      {versionConflict && (
        <SoVersionConflictBanner
          conflict={versionConflict}
          className={styles.bannerWarn}
          saving={savingOrder}
          onReview={() => setHistoryOpen(true)}
          onProceed={() => { if (adoptServerVersion()) saveNow(); }}
        />
      )}

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
            <Button variant="ghost"
              onClick={handleDiscardDraft}
              disabled={deleteDraft.isPending || updateStatus.isPending}
              style={{ color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' }}>
              <Trash2 {...ICON} />
              <span>{deleteDraft.isPending ? 'Discarding…' : 'Discard draft'}</span>
            </Button>
            <Button variant="primary"
              onClick={async () => {
                if (!(await passesSoffioReminder(askConfirm, items.filter((it) => !it.cancelled).map((it) => it.item_code)))) return;
                const dateNote = soConfirmDateNote(header.processing_date, header.customer_delivery_date);
                if (!(await askConfirm({
                  title: `Confirm ${header.doc_no}?`,
                  body: <>This turns the draft into a live, confirmed sales order — it will appear in MRP / PO / DO flows and KPIs.{dateNote && <><br /><br /><strong>{dateNote}</strong></>}</>,
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

      <SoLockBanner status={header.status} cancelled={isCancelled} migratedReason={migratedLocked ? soMigratedReason(header) : null} overridden={unlockOverride}
        onOverride={(reason) => overrideLock.mutate({ docNo: header.doc_no, status: header.status, reason }, { onSuccess: () => setUnlockOverride(true) })}
        onRelock={() => setUnlockOverride(false)} afterDo={afterDo} afterDoTargetId={afterDoTargetId} onPickTarget={setAfterDoTargetId} />

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
          <span>{AMENDMENT_MODE_BANNER}</span>
        </div>
      )}

      <CancelRequestPanel docType="so" docKey={header.doc_no} docNumber={header.doc_no} onExecute={executeCancel} executing={updateStatus.isPending} />
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
            {(oa.lane === 'LINES' || oa.lane === 'DELIVERY') && (
              <span style={{ color: 'var(--fg-muted)' }}>waiting for {AMENDMENT_APPROVER_LABEL[soAmendmentApprover(oa.lane)]}</span>
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
          {oa.lane == null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {oa.status === 'REQUESTED' && canSupplierConfirm && (
                <Button variant="primary"
                  onClick={() => setShowSupplierForm((v) => !v)}
                  disabled={supplierConfirm.isPending}>
                  <Check {...ICON} />
                  <span>Record supplier confirmation</span>
                </Button>
              )}
              {oa.status === 'SUPPLIER_PENDING' && canApproveSo && (
                <Button variant="primary"
                  onClick={handleApproveSo} disabled={approveSo.isPending}>
                  <Check {...ICON} />
                  <span>Approve SO revision</span>
                </Button>
              )}
            </span>
          )}
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
      <CustomerCard
        ref={customerCardRef}
        header={header}
        onSave={handleHeaderSave}
        saving={updateHeader.isPending}
        locked={isLocked} identityLocked={header.has_children === true} afterDoFields={afterDo.headerOpen}
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
            <Button variant="primary" onClick={startAddLine} disabled={addLocked}>
              <Plus {...ICON} />
              <span>{ADD_LINE_LABEL}</span>
            </Button>
          )}
        </header>

        {items.length === 0 && !isEditing ? (
          <p className={styles.emptyRow}>No items yet — click "Edit" then "Add Line Item" to begin.</p>
        ) : isEditing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-3)' }}>
            {items.map((it, idx) => {
              const editDraft = editingDrafts[it.id];
              if (!editDraft) return null;
              const cb = rowCallbacks.get(it.id), frozen = soItemFrozen(it), afterDoLine = afterDoEditableLine(afterDo, it), afterDoProduct = afterDoProductLineEditable(linesAfterDo, it), afterDoFee = afterDoFeeLineEditable(linesAfterDo, it);
              return (
                <div key={it.id} style={frozen && !afterDoLine && !afterDoProduct ? FROZEN_LINE_STYLE : undefined} data-frozen={frozen || undefined}>
                  <div className={styles.actionsCell} style={{ marginBottom: 'var(--space-2)' }}>
                    {frozen && <span style={FROZEN_LINE_LABEL_STYLE}>{FROZEN_LINE_LABEL}</span>}
                    {frozen && priceAfterDo
                      ? <button type="button" className={styles.iconBtn} title="Change price after DO" onClick={() => setRepricing(it)}><DollarSign {...SM_ICON} /></button>
                      : (
                      <button type="button" className={styles.iconBtn} title="Override price"
                        disabled={overrideLocked || frozen}
                        onClick={() => !overrideLocked && !frozen && setOverriding(it)}>
                        <DollarSign {...SM_ICON} />
                      </button>
                    )}
                  </div>
                  <SoLineCard
                    index={idx}
                    draft={editDraft}
                    onChange={cb?.onChange ?? ((patch) => patchEditingDraft(it.id, patch))}
                    onRemove={cb?.onRemove ?? (() => removeEditingLine(it.id))}
                    canRemove={(!linesLocked && !frozen) || afterDoFee || afterDoProduct}
                    docNo={header.doc_no}
                    itemId={it.id}
                    isEditing={(!linesLocked && !frozen) || afterDoLine || afterDoProduct || afterDoFee} chargeOnly={afterDoLine}
                    variantsRequired={requireVariants} lineDateLocked={!requireVariants} specLockedReason={null} seedSofaLegDefault={true}
                    attachOptions={attachOptionsById[it.id] ?? null}
                  />
                </div>
              );
            })}

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
                    canRemove={true} chargeOnly={chargeAdds}
                    variantsRequired={requireVariants} lineDateLocked={!requireVariants} specLockedReason={null} seedSofaLegDefault={true}
                    attachOptions={attachOptionsById[staged.key] ?? null}
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
                const displayDate = it.line_delivery_date
                  ?? (!it.line_delivery_date_overridden ? header.customer_delivery_date : null);
                const isAuto = !it.line_delivery_date_overridden;
                return (
                <tr key={it.id}>
                  <td>
                    <div className={styles.codeCell}>
                      {lineIdentity({ code: it.item_code, description: it.description }).primary || '—'}
                    </div>
                    {it.remark && (
                      <div className={styles.muted} style={{ fontStyle: 'italic' }}>
                        Remark: {it.remark}
                      </div>
                    )}
                  </td>
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
                                color: it.remaining_qty > 0 ? 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' : 'var(--c-secondary-a, #2F5D4F)',
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
        receiptFor={{ source: 'SOPAY' }}
        headerAction={canOfferPayEdit ? (
          <Button variant="ghost" onClick={() => { void togglePayEditing(); }}>
            {payEditing ? <span>Done</span> : <><Pencil {...ICON} /><span>Edit payments</span></>}
          </Button>
        ) : null}
      />

      {header.signature_b64 && (
        <section className={styles.card}>
          <header className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Customer Signature</h2>
          </header>
          <div className={styles.cardBody}>
            <img
              src={header.signature_b64}
              alt="Customer signature captured at handover"
              style={{ maxWidth: 360, width: '100%', height: 'auto', border: '1px solid var(--c-line, #E5E1DC)', borderRadius: 8, background: 'var(--hz-c-surface)' }}
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

      </>
      )}

      {overriding && (
        <OverridePriceModal
          item={overriding}
          docNo={header.doc_no}
          currency={header.currency}
          onClose={() => setOverriding(null)}
        />
      )}
      {repricing && <PriceAfterDoModal item={repricing} docNo={header.doc_no} currency={header.currency} onClose={() => setRepricing(null)} />}

      {viewingAmendmentId && (
        <AmendmentDiffModal
          amendmentId={viewingAmendmentId}
          currency={header.currency}
          onClose={() => setViewingAmendmentId(null)}
        />
      )}

      {historyOpen && (
        <HistoryPanel docNo={header.doc_no} onClose={closeHistory} />
      )}

      <DocumentRelationshipMapModal
        open={relMapOpen}
        onClose={() => setRelMapOpen(false)}
        nodes={chainNodes}
        onNodeClick={(n) => {
          if (onChainNodeClick(n)) setRelMapOpen(false);
        }}
        amendments={chainAmendments}
        onAmendmentClick={(a) => {
          if (onChainAmendmentClick(a)) setRelMapOpen(false);
        }}
        returns={chainReturns} onReturnClick={(r) => { if (onChainReturnClick(r)) setRelMapOpen(false); }}
        pairing={chainPairing}
      />
      <DocumentChoiceDialog
        prompt={chainChoice}
        onClose={closeChainChoice}
        onPick={pickChainChoice}
      />
      {submitDialog.element}
    </div>
    </FormTouchScope>
  );
};


type CustomerCardHandle = {
  validate: () => string | null;
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
  hasDirectHeaderChanges: () => boolean;
  fairDayKeys: () => Record<string, string | null>;
};

type CustomerCardProps = {
  header: SoHeader;
  onSave: (
    patch: Record<string, unknown>,
    cb?: { onSuccess?: () => void; onError?: (msg: string, raw?: unknown) => void },
  ) => void;
  saving: boolean;
  locked?: boolean;
 identityLocked: boolean; afterDoFields?: boolean;
  isEditing?: boolean;
  /** Owner 2026-07-16 — the SO is processing-locked but amendment-eligible, so
      the page's primary action SUBMITS AN AMENDMENT. The frozen fields
      (Processing Date / State / Postcode) must therefore be EDITABLE here: an
      amendment is precisely the sanctioned way to change them, and disabling
      the input made the one supported channel unusable. They don't save
      directly — submitAmendment routes them through the approval flow. */
  amendmentMode?: boolean;
  onDeliveryDateChange?: (date: string) => void;
};

const CustomerCardInner = forwardRef<CustomerCardHandle, CustomerCardProps>(({
  header,
  onSave,
  saving: _saving,
  locked = false, identityLocked, afterDoFields = false,
  isEditing = false,
  amendmentMode = false,
  onDeliveryDateChange,
}, ref) => {
  const notify = useNotify();
  const localities = useLocalities();
  const localityRows = useMemo(() => localities.data ?? [], [localities.data]);
  const staffQ = usePickableStaff({ onlySales: true, include: [header.salesperson_id] });
  const staffList = (staffQ.data ?? []).filter((s) => s.active);
  const { can } = useHouzsAuth();
  const venuesQ = useVenues();
  /* Commander 2026-05-27 ("delivery 一点没有跟着跳"): Sales Location no longer
     just mirrors header.sales_location. When the user picks a delivery state
     we look up state_warehouse_mappings and auto-populate the field with the
     mapped warehouse code. The user can still leave it blank (no mapping
     exists for that state) or manually override on Maintenance. */
  const stateWarehousesQ = useStateWarehouseMappings();
  const canChangeSalesperson = can('scm.so.attribute_other');
  /* Remove-Processing-Date gate (Owner 2026-07-09, port of 2990 #717) —
     clearing a SET Processing Date pulls the SO back out of the Proceed lane,
     so it is admin-level only. 2990 gates on staff.role === 'super_admin';
     Houzs has no live staff_role (the SCM bridge pins every caller to one
     super_admin row), so mirror the API and gate on the flat permission key
     the PATCH enforces (mfg-sales-orders.ts). Owner + IT Admin pass via `*`. */
  const canRemoveProcessingDate = can('scm.so.remove_processing_date');
  const canOverridePoProcessingDate = can('scm.so.override_po_processing_date');

  const customerTypeOptsQ = useSoDropdownOptions('customer_type');
  const buildingTypeOptsQ = useSoDropdownOptions('building_type');
  const relationshipOptsQ = useSoDropdownOptions('relationship');
  const customerTypeOpts = optionsOrFallback('customer_type', customerTypeOptsQ.data);
  const buildingTypeOpts = optionsOrFallback('building_type', buildingTypeOptsQ.data);
  const relationshipOpts = optionsOrFallback('relationship',  relationshipOptsQ.data);

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
  const initialFormFor = (h: SoHeader) => ({
    /* customerCode kept in state but the UI no longer renders an input
       (commander 2026-05-27: "customer code 不需要"). Payload still sends
       debtorCode so the server-side mapping is unchanged. */
    customerCode: h.debtor_code ?? '',
    customerName: h.debtor_name ?? '',
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
    fair: linkedEvent(h.venue, h.fair, h.fair_date ?? null), noFair: h.fair_match === 'NO_FAIR',
    phone: h.phone ?? '',
    address1: h.address1 ?? '',
    address2: h.address2 ?? '',
    address3: h.address3 ?? '',
    address4: h.address4 ?? '',
    city: h.city ?? h.address3 ?? '',
    postcode: h.postcode ?? h.address4 ?? '',
    state: h.customer_state ?? '',
    emergencyContactName: h.emergency_contact_name ?? '',
    emergencyContactPhone: h.emergency_contact_phone ?? '',
    emergencyContactRelationship: h.emergency_contact_relationship ?? '',
    processingDate: h.processing_date ?? '',
    customerDeliveryDate: h.customer_delivery_date ?? '',
    note: h.note ?? '',
    salesLocation: h.sales_location ?? '',
  });

  const payloadFor = (f: ReturnType<typeof initialFormFor>) => ({
    debtorCode: f.customerCode,
    debtorName: f.customerName,
    customerSoNo: f.customerSoNo || null,
    email: f.email,
    customerType: f.customerType,
    salespersonId: f.salespersonId || null,
    buildingType: f.buildingType,
    venue: f.venue,
    venueId: f.venueId || null,
    ...fairEditPatch(f.fair), ...(f.noFair ? { noFair: true } : {}),
    phone: f.phone,
    address1: f.address1,
    address2: f.address2,
    address3: f.address3,
    address4: f.address4,
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
  const originalPayloadRef = useRef<Record<string, unknown>>(payloadFor(initialFormFor(header)));
  const [showSuggest, setShowSuggest] = useState(false);
  const custInputRef = useRef<HTMLInputElement>(null);
  const debouncedDebtorQ = useDebouncedValue(form.customerName, 200);
  const debtorQuery = useDebtorSearch(debouncedDebtorQ);
  const suggestions = (debtorQuery.data?.debtors ?? []).filter(
    (d) => (d.debtor_name ?? '').toLowerCase() !== form.customerName.trim().toLowerCase(),
  );

  useEffect(() => {
    if (isEditing) return;
    const seeded = initialFormFor(header);
    setForm(seeded);
    originalPayloadRef.current = payloadFor(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header, isEditing]);

  const set = <K extends keyof typeof form>(k: K, v: string) =>
    setForm((s) => ({ ...s, [k]: v }));

  useEffect(() => {
    if (!form.salespersonId) return;
    /* Houzs 2026-06-23 (owner): Venue is manually pickable — only auto-fill the
       DEFAULT when it is still empty; never override a manual or loaded pick. */
    if (form.venueId || form.venue.trim()) return;
    if (isScannedOrder(header)) return; // a scan's venue is a person's pick (owner 2026-11-12)
    const picked = staffList.find((s) => s.id === form.salespersonId);
    const resolvedId = picked?.venueId ?? '';
    if (!resolvedId) return;
    const resolvedName = (venuesQ.data ?? []).find((v) => v.id === resolvedId)?.name;
    if (!resolvedName) return;
    setForm((s) => (s.venueId || s.venue.trim() ? s : { ...s, venueId: resolvedId, venue: resolvedName, fair: null }));
  }, [form.salespersonId, staffList, venuesQ.data, form.venueId, form.venue, header]);

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

  const { cities: cityChoices, postcodes: postcodeChoices } =
    useAddressCascade(localityRows, form.state, form.city);
  const applyCityReverse = (nextCity: string) =>
    setForm((s) => ({ ...s, ...pickCity(localityRows, s, nextCity) }));
  const applyPostcodeReverse = (nextPostcode: string) =>
    setForm((s) => ({ ...s, ...pickPostcode(localityRows, s, nextPostcode) }));
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
  const processingPoLocked = originalProcessing !== '' && header.processing_date_po_locked === true && !canOverridePoProcessingDate;

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
      // In amendment mode the removal is a REQUEST the Purchaser signs (owner 2026-09-30), not a direct write.
      canRemoveProcessingDate: canRemoveProcessingDate || amendmentMode,
    });
    return err ? soErrorText(err) : null;
  };

  const lockedHeaderNow = {
    processingDate:   form.processingDate,
    customerDeliveryDate: form.customerDeliveryDate,
    customerState:        form.state,
    postcode:             form.postcode,
    city:                 form.city,
    address1:             form.address1,
    address2:             form.address2,
    address3:             form.address3,
    address4:             form.address4,
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
    address3:             header.address3 ?? '',
    address4:             header.address4 ?? '',
    debtorName:           header.debtor_name ?? '',
    phone:                header.phone ?? '',
    email:                header.email ?? '',
  };

  const directHeaderPatch = () => diffHeaderPayload(originalPayloadRef.current,
    withoutFrozenHeaderFields(buildPayload()));

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
    onSave(opts?.keepLockedColsAsOriginal ? directHeaderPatch()
      : diffHeaderPayload(originalPayloadRef.current, buildPayload()), cb);
  };

  useImperativeHandle(ref, () => ({
    validate: () => validateDates(),
    save: (cb, opts) => trySave(cb, opts),
    reset: () => {
      const seeded = initialFormFor(header);
      setForm(seeded);
      originalPayloadRef.current = payloadFor(seeded);
    },
    getPhone: () => form.phone ?? '',
    getLockedHeaderChanges: () =>
      buildAmendmentHeaderChanges(lockedHeaderNow, lockedHeaderOriginal),
    hasDirectHeaderChanges: () => hasHeaderChanges(directHeaderPatch()),
    fairDayKeys: () => fairDayCheck(buildPayload(), originalPayloadRef.current),
  }));

  const scheduleDisabled = !isEditing || locked, inputsDisabled = scheduleDisabled || identityLocked, customerDisabled = afterDoFields ? !isEditing : inputsDisabled;

  return (
    <>
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
                disabled={customerDisabled}
                onChange={(e) => { set('customerName', e.target.value); setShowSuggest(true); }}
                onFocus={() => setShowSuggest(true)}
                onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
              />
              <DebtorSuggestList
                anchorRef={custInputRef}
                open={showSuggest && !inputsDisabled}
                suggestions={suggestions}
                onPick={applySuggestion}
                classes={{ list: styles.suggestList, item: styles.suggestItem, code: styles.suggestCode }}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Ref No.</span>
              <input className={styles.fieldInput} value={form.customerSoNo}
                placeholder="Their PO / SO number"
                disabled={inputsDisabled}
                onChange={(e) => set('customerSoNo', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Phone *</span>
              <PhoneInput
                className={styles.fieldInput}
                value={form.phone}
                disabled={customerDisabled}
                onChange={(v) => set('phone', v)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Email *</span>
              <input type="email" className={styles.fieldInput} value={form.email}
                disabled={customerDisabled}
                onChange={(e) => set('email', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.customerType}
                  disabled={customerDisabled}
                  onChange={(e) => set('customerType', e.target.value)}>
                  <option value="">—</option>
                  {customerTypeOpts.map((t) => (
                    <option key={t.id} value={t.value}>{t.label}</option>
                  ))}
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
                  disabled={customerDisabled}
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
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Fair</span>
              {/* Same picker as the create forms. A picked EVENT is saved and linked
                  exactly (owner 2026-09-24); the order's link reads back as its row.
                  Both halves live in components/fairPick.ts, shared with the phone. */}
              <FairPicker
                id="so-detail-fair"
                value={fairPickValue(form.venue || null, form.fair)}
                soDate={header.so_date}
                disabled={inputsDisabled} boothFor={{ docNo: header.doc_no, items: [] }}
                onChange={(next) => setForm((s) => ({
                  ...s,
                  fair: fairEventOf(next), noFair: fairEventOf(next) ? false : s.noFair,
                  venue: next.venue ?? '',
                  venueId: (venuesQ.data ?? []).find(
                    (v) => v.name.trim().toLowerCase() === (next.venue ?? '').trim().toLowerCase(),
                  )?.id ?? '',
                }))}
                wrapClassName={styles.selectWrap}
                selectClassName={styles.fieldSelect}
              />
              {!form.fair && fairElsewhereLine(header.venue, header.fair) && <span style={{ fontSize: '11px', marginTop: '4px' }}>{fairElsewhereLine(header.venue, header.fair)}</span>}
              {(header.status as string) === 'DRAFT' && !form.fair && (/* a draft says No fair here too (owner 2026-10-19) */
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', marginTop: '6px', cursor: 'pointer' }}><input type="checkbox" checked={form.noFair} disabled={inputsDisabled} onChange={(e) => setForm((s) => ({ ...s, noFair: e.target.checked }))} />
                  <span>No fair (showroom / direct sale)</span></label>)}
            </label>
            {form.fair && (/* which DAY of the picked event (owner 2026-09-24) */
              <label className={styles.field}><span className={styles.fieldLabel}>Fair Day</span><FairDayPicker id="so-detail-fair-day" value={fairPickValue(form.venue || null, form.fair)} soDate={header.so_date} disabled={inputsDisabled}
                onChange={(next) => setForm((s) => ({ ...s, fair: fairEventOf(next) }))} wrapClassName={styles.selectWrap} selectClassName={styles.fieldSelect} /></label>)}
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Processing Date</span>
              <DateField
                fullWidth
                className={styles.fieldInput}
                value={form.processingDate}
                disabled={scheduleDisabled || processingLocked || processingPoLocked}
                title={processingPoLocked
                  ? 'This order already has a Purchase Order — only a Purchaser can change the Processing Date.'
                  : processingLocked ? 'Processing date has passed — locked.' : undefined}
                min={processingLocked || processingPoLocked ? undefined : today}
                onChange={(iso) => set('processingDate', iso)}
                style={datesXor && !form.processingDate ? { borderColor: 'var(--c-festive-b, #B8331F)' } : undefined}
              />
              <RequestProcessingDateRemoval docNo={header.doc_no} surface="desktop" hint={originalProcessing !== '' && !inputsDisabled && !processingLocked && !canRemoveProcessingDate && !amendmentMode} show={originalProcessing !== '' && !locked && !processingLocked && !processingPoLocked && !canRemoveProcessingDate && !amendmentMode} />
              {processingPoLocked && !scheduleDisabled && (
                <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', marginTop: 2 }}>Has a Purchase Order — only a Purchaser can change this date.</span>
              )}
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Delivery Date</span>
              <DateField
                fullWidth
                className={styles.fieldInput}
                value={form.customerDeliveryDate}
                disabled={scheduleDisabled}
                min={today}
                onChange={(iso) => { set('customerDeliveryDate', iso); onDeliveryDateChange?.(iso); }}
                style={datesXor && !form.customerDeliveryDate ? { borderColor: 'var(--c-festive-b, #B8331F)' } : undefined}
              />
            </label>
            <label className={`${styles.field}`} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Note</span>
              <input className={styles.fieldInput} value={form.note}
                disabled={scheduleDisabled}
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
                disabled={customerDisabled}
                onChange={(e) => set('emergencyContactName', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Relationship</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.emergencyContactRelationship}
                  disabled={customerDisabled}
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
                disabled={customerDisabled}
                onChange={(v) => set('emergencyContactPhone', v)}
              />
            </label>
          </div>
        </div>
      </section>


      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Delivery Address</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <SoAddressLines lines={[form.address1, form.address2, form.address3, form.address4]}
              town={{ postcode: form.postcode, city: form.city, state: form.state }}
              onChange={(line, v) => set(`address${line}` as const, v)}
              fieldClassName={styles.field} labelClassName={styles.fieldLabel} inputClassName={() => styles.fieldInput} disabled={customerDisabled} />
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
                  disabled={afterDoFields ? !isEditing : (inputsDisabled || stateLocked)}
                  title={stateLocked ? 'Processing has passed — City is locked (it is part of the PO delivery location).' : undefined}
                  placeholder={cityPlaceholder(form.state)}
                  options={sortByText(cityChoices).map((c) => ({ value: c, label: c }))}
                />
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <AddressPostcodeField
              country={country}
              value={form.postcode}
              onChange={(v) => setForm((s) => ({ ...s, postcode: v }))}
              onCascadePick={applyPostcodeReverse}
              onResolve={(r) => setForm((s) => ({ ...s, address1: r.address, ...(r.state && r.city ? { state: r.state, city: r.city } : {}) }))}
              postcodeChoices={postcodeChoices}
              placeholder={postcodePlaceholder(form.state, form.city)}
              disabled={afterDoFields ? !isEditing : (inputsDisabled || stateLocked)}
              title={stateLocked ? 'Processing has passed — Postcode is locked (it drives the PO delivery location).' : undefined}
              classes={{ field: styles.field, label: styles.fieldLabel, select: styles.fieldSelect, selectWrap: styles.selectWrap, chevron: styles.selectChevron, input: styles.fieldInput }}
            />
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
          <div style={{ color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))', fontSize: 13 }}>
            Couldn&apos;t load the scanned image. {error}
          </div>
        ) : src ? (
          <a href={src} target="_blank" rel="noreferrer" title="Open full size in a new tab">
            <img
              src={src}
              alt={alt}
              style={{ maxWidth: 360, width: '100%', height: 'auto', border: '1px solid var(--c-line, #E5E1DC)', borderRadius: 8, background: 'var(--hz-c-surface)', cursor: 'zoom-in' }}
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
                color: delta < 0 ? 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' : 'var(--c-burnt)',
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


const HistoryPanel = memo(({
  docNo,
  onClose,
}: {
  docNo: string;
  onClose: () => void;
}) => {
  const q = useSalesOrderAuditLog(docNo);
  const { panel, error, renderDocTag } = useSoHistoryWithRelated(docNo, q);

  const renderBadge = useCallback((entry: AuditLogEntry, changes: AuditFieldChange[]) => {
    if (entry.action !== 'UPDATE_STATUS') return renderDocTag(entry);
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
  }, [renderDocTag]);

  return (
    <AuditHistoryPanel
      recordLabel={docNo}
      entityName="Sales order"
      {...panel}
      error={error}
      labels={SO_AUDIT_LABELS}
      onClose={onClose}
      renderBadge={renderBadge}
    />
  );
});
HistoryPanel.displayName = 'HistoryPanel';


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
      background: 'var(--hz-c-surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)',
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
  changed ? { fontWeight: 700, color: 'var(--hz-c-primary-ink)' } : undefined;

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
                            {chg.remark ? (
                              <div className={styles.muted} style={{ fontStyle: 'italic', ...emphasiseIf(true) }}>
                                {(l.new_remark ?? '').trim() ? `“${l.new_remark}”` : 'Remark cleared'}
                              </div>
                            ) : null}
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

