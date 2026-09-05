// ----------------------------------------------------------------------------
// PaymentsTable — shared Houzs-pattern payments ledger.
//
// Task #105 — Commander 2026-05-27: "Edit SO 和 New SO 界面一定要一样的啊"
// New SO and Edit SO must render an IDENTICAL Payments section. This component
// was extracted verbatim from SalesOrderDetail.tsx's PaymentCard so both pages
// can reuse it without drift.
//
// Two modes:
//   - SAVED mode  (docNo: string)
//       Uses useSalesOrderPayments / useAddSalesOrderPayment /
//       useDeleteSalesOrderPayment. Each row commit POSTs to
//       /mfg-sales-orders/:docNo/payments.
//   - DRAFT mode  (docNo: null + payments + onChange)
//       Holds payments in caller-supplied local state. No API calls. Used
//       on the New SO page where the docNo doesn't exist until the SO has
//       been created. After the parent POSTs the SO, it replays each draft
//       through POST /:docNo/payments before navigating to the Detail page.
//
// Visuals + columns + method options + label→API enum mapping are identical
// across both modes.
// ----------------------------------------------------------------------------

import { memo, useEffect, useRef, useState, type CSSProperties, type ReactNode, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DollarSign, Plus, Trash2, Save, FileText, Image as ImageIcon,
  Calendar as CalIcon, User as UserIcon, Tag, Pencil, Printer,
} from 'lucide-react';
import { sortByText } from '../lib/sort-options';
import { authedFetch } from '../lib/authed-fetch';
import { generateReceiptPdf, type ReceiptPdfData } from '../lib/receipt-pdf';
import { fetchPaymentSlipUrl, scanPaymentReceipt, type SlipUrlResponse } from '../lib/slip';
import { SlipUploadField } from './SlipUploadField';
import { MoneyInput } from './MoneyInput';
import { DateField } from './DateField';
import { useNotify } from './NotifyDialog';
import { useConfirm } from './ConfirmDialog';
import { todayMyt, mytDayOf } from '../lib/dates';
/* The SHARED payment-window predicate — the same function the server calls, so
   the button and the endpoint cannot disagree about whether the window is open
   (Owner 2026-07-19). */
import { paymentRowMutable } from '../lib/so-field-policy';
import {
  PAYMENT_METHOD_CODE_TO_VALUE,
  PAYMENT_METHOD_DEFAULT_LABELS,
  paymentMethodCodeForValue,
  type PaymentMethodCode,
} from '@2990s/shared/payment-methods';
import { useAuth } from '../lib/auth';
import { useStaff, usePickableStaff } from '../lib/admin-queries';
import {
  useSalesOrderPayments,
  useAddSalesOrderPayment,
  useEditSalesOrderPayment,
  useAttachSalesOrderPaymentSlip,
  useDeleteSalesOrderPayment,
  type SoPayment,
} from '../lib/sales-order-queries';
import {
  useSoDropdownOptions, optionsOrFallback,
} from '../lib/so-dropdown-options-queries';
import { formatDate } from '../../../lib/utils';
import { newIdempotencyKey } from '../../../lib/idempotency';
import detailStyles from '../../../pages/scm-v2/SalesOrderDetail.module.css';
import paymentsStyles from '../../../pages/scm-v2/Payments.module.css';

/* Bare amount, no currency. The Amount COLUMN carries the currency once in its
   header: `currency` is a single per-document prop (callers pass
   `header.currency`) and SoPayment has no currency field of its own, so every
   row in one table was already printing the same constant. */
const fmtAmt = (centi: number): string =>
  (centi / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

/* Currency-prefixed — for the summary totals and the delete confirm, which read
   outside the Amount column and so cannot lean on its header. */
const fmtRm = (centi: number, currency = 'MYR'): string =>
  `${currency} ${fmtAmt(centi)}`;

/* installment_plan "One Shot" option VALUE (spec 1 + 6) — the default plan for
   a Merchant card with no written tenure. Parsed to null months on persist. */
const ONE_SHOT_PLAN = 'One Shot';

/* ════════════════════════════════════════════════════════════════════════
   API enum + Houzs friendly-label mapping (kept verbatim from PaymentCard
   so the Detail page's ledger semantics don't change).
   ════════════════════════════════════════════════════════════════════════ */

export type PaymentMethod = PaymentMethodCode;
/* Bank provider name (now open-ended — sourced from
   so_dropdown_options('payment_merchant'), no longer constrained to the
   legacy 4-bank enum). */
export type MerchantProvider = string;

/* 2026-06-06 payment-method unify (Loo) — the L1 cascade and the POS
   handover cards now share ONE maintenance list (payment_method category,
   locked to four rows whose VALUE is the immutable key):
     Method (L1)    → Merchant | Online | Installment | Cash
       Merchant     → pick Merchant bank + Installment plan
       Online       → pick Online sub-type (Bank Transfer / TNG / Cheque / DuitNow)
       Installment  → pick Merchant bank + Installment plan (term in months)
                      (bank added 2026-07-19 — drives the EPP/installment fee)
       Cash         → done
   Routing keys off the row VALUE via the shared map — labels are freely
   renameable in SO Maintenance and never affect booking. The cash fallback
   below can only fire on data that predates the API lock. */
export type PaymentMethodLabel = string;

export const labelToApi = (label: PaymentMethodLabel): {
  method: PaymentMethod;
  merchantProvider: MerchantProvider | null;
} => {
  const method = paymentMethodCodeForValue(label);
  if (method) return { method, merchantProvider: null };
  // The payment_method category is locked server-side to the four core
  // values, so an unknown value here means pre-lock drifted data — surface
  // it and fall back to cash so we don't book a card payment as transfer.
  // eslint-disable-next-line no-console
  console.warn(
    `[PaymentsTable] Unknown payment method value "${label}" — falling ` +
    `back to method=cash. Values are locked to Merchant / Online / ` +
    `Installment / Cash (see @2990s/shared/payment-methods).`,
  );
  return { method: 'cash', merchantProvider: null };
};

/* Persisted method code → the maintenance row VALUE (for select rehydrate
   + the locked-set keys). Display labels resolve live from methodOpts. */
const apiToValue = (p: SoPayment): string =>
  PAYMENT_METHOD_CODE_TO_VALUE[p.method] ?? 'Cash';

const methodPillStyle = (m: PaymentMethod): CSSProperties => {
  const bg =
    m === 'merchant'    ? 'rgba(232, 107, 58, 0.12)' :
    m === 'transfer'    ? 'rgba(47, 93, 79, 0.12)'   :
    m === 'installment' ? 'rgba(34, 31, 32, 0.08)'   :
                          'rgba(0, 0, 0, 0.06)';
  const fg =
    m === 'merchant'    ? 'var(--c-burnt)' :
    m === 'transfer'    ? 'var(--c-secondary-a, #2F5D4F)' :
    m === 'installment' ? 'var(--c-ink)' :
                          'var(--fg-muted)';
  return {
    display: 'inline-block',
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--fs-11)',
    fontWeight: 600,
    padding: '1px 8px',
    borderRadius: 'var(--radius-pill)',
    background: bg,
    color: fg,
    letterSpacing: '0.02em',
  };
};

/* ════════════════════════════════════════════════════════════════════════
   Shared draft row shape — what the inline-editor renders.

   In SAVED mode this is internal state; rows promote to API rows on commit.
   In DRAFT mode the parent owns the array (PaymentDraft[]) so we expose the
   same shape minus the `uid` (parent can derive a key per row).
   ════════════════════════════════════════════════════════════════════════ */

/* Task #122 (cascade) — methodLabel is the L1 pick (Merchant / Online /
   Cash). The three optional sub-fields below carry the L2 picks; only the
   field(s) relevant to the current methodLabel are populated.
     methodLabel = Merchant    → merchantProvider + installmentMonthsLabel
     methodLabel = Installment → merchantProvider + installmentMonthsLabel
     methodLabel = Online      → onlineType
     methodLabel = Cash        → all three sub-fields stay ''
   installmentMonthsLabel is stored verbatim from the dropdown (e.g.
   'One-off', '3 months', '12 months') and parsed to an integer on
   persist (One-off → null/0; 'N months' → N). */
/** What a page-driven commit did, per row. `blocked` names the rows that could
 *  not be sent at all (no amount, missing sub-field) — RETURNED rather than
 *  skipped, because skipping in silence is the defect this exists to fix. */
export type PaymentCommitResult = { committed: number; failed: number; blocked: string[] };

export type PaymentDraft = {
  uid:                      string;
  paidAt:                   string;             // YYYY-MM-DD
  methodLabel:              PaymentMethodLabel;
  merchantProvider:         string;             // L2 bank pick (Merchant + Installment)
  installmentMonthsLabel:   string;             // L2 plan pick (Merchant + Installment)
  onlineType:               string;             // L2 sub-type (Online only)
  amountSen:              number;
  accountSheet:             string;
  approvalCode:             string;
  collectedBy:              string;             // staff.id (uuid) | ''
  /* Spec D4 (2026-06-06) — committed slip upload session for this row. In
     SAVED mode (SO route) it is REQUIRED before commit; in DRAFT mode it is
     optional and the batching pages (DO / SI / consignment) ignore it. */
  slipUploadSessionId:      string | null;
  /* Bug #3 (2026-06-24) — when this draft was seeded from a card receipt scanned
     in the Scan-Order modal, the receipt's R2 key (scan-slips/…-receipt). The
     receipt IS the slip, so a draft carrying this satisfies the New SO slip-
     required guard without a second upload; SalesOrderNew records it via the SO-
     create deposit fields (which reuse the order-level proof) instead of the
     strict per-payment slip route. '' / undefined for a manually-added row. */
  receiptImageKey?:         string;
  /* Same-day EDIT (owner 2026-07-13) — when set, this draft is an in-place edit
     of the persisted payment with this id; commit PATCHes that row instead of
     POSTing a new one, and the persisted row is hidden while the draft edits it.
     Undefined for a normal new-payment draft. SAVED mode only. */
  editingPersistedId?:      string;
  /* Idempotency-Key for the ONE payment this draft will become (2026-07-17).
     The draft IS the intent: minted by newPaymentDraft when the operator adds
     the row, carried through every failed-and-retried commit, and destroyed
     with the draft on success (removeDraft) — so a double-fire de-dupes while
     two genuinely separate RM100 rows keep two different keys and both book.
     Do NOT derive this from the payload; see lib/idempotency.ts for why that
     silently swallows the second of two identical payments.
     OPTIONAL because a draft built as a read-only VIEW of an already-persisted
     row (SalesInvoiceDetailV2.apiToDraft) is never posted and needs no key. */
  idempotencyKey?:          string;
};

const EMPTY_PAYMENT_DRAFTS: PaymentDraft[] = [];

export const newPaymentDraft = (defaultStaffId = ''): PaymentDraft => ({
  uid: Math.random().toString(36).slice(2, 10),
  idempotencyKey: newIdempotencyKey(),
  paidAt: todayMyt(),
  methodLabel: 'Cash',
  merchantProvider:       '',
  installmentMonthsLabel: '',
  onlineType:             '',
  amountSen: 0,
  accountSheet: '',
  approvalCode: '',
  collectedBy: defaultStaffId,
  slipUploadSessionId: null,
});

/* Parse an installment-plan label like 'One Shot' / 'One-off' / '3 months' /
   '12 months' into an integer term in months. The one-shot labels and any
   unrecognised string return null (= no installment); otherwise the leading
   number. */
export const parseInstallmentMonths = (label: string): number | null => {
  if (!label || label === 'One-off' || label === ONE_SHOT_PLAN) return null;
  const m = /^(\d+)\s*month/i.exec(label.trim());
  return m ? Number(m[1]) : null;
};

/* Cascade required-field check (spec 1) — returns a human reason when the
   chosen method is missing a required sub-field, else null:
     Merchant    → Bank (merchantProvider) AND Plan (installmentMonthsLabel)
     Online      → Sub-Type (onlineType)
     Installment → nothing gated (its Bank + Plan are both OPTIONAL — the bank
                   was added 2026-07-19 to inform the EPP fee, but a bank-less
                   installment still books; the server FIX-3 guard likewise
                   exempts installment)
     Cash        → nothing
   Keyed off the L1 methodLabel VALUE (Merchant / Online / Installment / Cash).
   Unknown /
   pre-lock labels are treated as Cash (no sub-field), matching labelToApi's
   cash fallback. Shared by the per-row commit gate (SAVED mode) and the New SO
   batch-save guard (DRAFT mode) so both pages enforce the same rule. */
export const missingMethodSubField = (
  d: Pick<PaymentDraft, 'methodLabel' | 'merchantProvider' | 'installmentMonthsLabel' | 'onlineType'>,
): string | null => {
  if (d.methodLabel === 'Merchant') {
    if (!d.merchantProvider) return 'Bank';
    if (!d.installmentMonthsLabel) return 'Plan';
    return null;
  }
  if (d.methodLabel === 'Online') {
    if (!d.onlineType) return 'Sub-Type';
    return null;
  }
  return null;
};

/* Method-scoped L2 fields for a draft row — shared by commitDraft below and
   every page that batches PaymentDraft[] to a payments endpoint (New SO /
   DO / SI / consignment flows), so the installment branch lives in exactly
   one place. */
export const draftMethodFields = (
  method: PaymentMethod,
  d: Pick<PaymentDraft, 'merchantProvider' | 'installmentMonthsLabel' | 'onlineType'>,
): Record<string, unknown> => {
  if (method === 'merchant') {
    return {
      merchantProvider:  d.merchantProvider || null,
      installmentMonths: parseInstallmentMonths(d.installmentMonthsLabel),
    };
  }
  if (method === 'installment') {
    // Owner 2026-07-19 ("Installment 要能选银行的") — Installment now also carries
    // the bank: different banks charge different EPP fees, so the bank is needed
    // to compute installment cost. Backend already treats installment as
    // merchant-like (persists merchant_provider); send it here too.
    return {
      merchantProvider:  d.merchantProvider || null,
      installmentMonths: parseInstallmentMonths(d.installmentMonthsLabel),
    };
  }
  if (method === 'transfer') {
    return { onlineType: d.onlineType || null };
  }
  return {};
};

/* ════════════════════════════════════════════════════════════════════════
   Props — discriminated union on `docNo`.
   - docNo: string   → SAVED mode (mutations + remote fetch)
   - docNo: null     → DRAFT mode (caller-owned state)
   ════════════════════════════════════════════════════════════════════════ */

type SavedModeProps = {
  docNo: string;
  /** Grand total used to compute the Balance summary at the bottom. */
  grandTotalSen: number;
  currency?: string;
  /** When true, hides Add Payment + per-row trash/save controls. */
  locked?: boolean;
  /** Owner 2026-07-13 (no-naked-payment-edits) — set when the parent SO is a
   *  DRAFT. A draft's payments are never locked by the same-day rule, so the
   *  per-row Edit (pencil) shows on EVERY persisted row (not just today's).
   *  Independent of `locked`, which the DRAFT caller already leaves false. */
  draftUnlocked?: boolean;
  /** Optional payment-slip column (Wei Siang 2026-06-06). When provided, a
   *  "Slip" column is rendered immediately LEFT of "Collected By", showing the
   *  order's POS-handover payment slip thumbnail (one slip per order — the same
   *  proof backs each payment row). Only the Sales Order detail passes this; the
   *  DO / SI tables that also use PaymentsTable leave it unset and are unchanged. */
  slip?: { slipKey: string | null; fetcher: (id: string) => Promise<SlipUrlResponse> };
  /** Nick 2026-07-09 — restrict Collected By picker to staff whose id is in
   *  the set. Any per-row already-selected id + the seeded default id are
   *  always grandfathered in so the <select> value stays valid. Undefined =
   *  no restriction (show every active staff). */
  collectedByAllowedIds?: Set<string> | null;
  /** Owner 2026-07-13 — page-supplied default Collected By (scm.staff id) for
   *  NEW payment rows. On Houzs the vendored auth bridge has no staff id
   *  (auth.staff.id === null), so the page resolves the logged-in user's staff
   *  row by email and passes it here. Falls back to the auth bridge when unset
   *  (HOOKKA / 2990, where the bridge does carry the id). '' / null = leave "—". */
  defaultCollectedBy?: string | null;
  /** Temporary retry rows carried from a successfully-created SO whose payment
   * follow-up failed. Deduplicated by their original idempotency key. */
  initialDrafts?: PaymentDraft[];
  /** Called only after a seeded/new draft is confirmed by the server. */
  onDraftCommitted?: (draft: PaymentDraft) => void;
  /* Hands the page a way to BOOK the typed rows as part of its own Save. Called
     with the function on mount and with null on unmount; the page keeps it in a
     ref. Without this the page Save saved the document and silently left the
     money rows behind (owner 2026-08-31). Must be a stable reference. */
  onRegisterCommitAll?: (commit: (() => Promise<PaymentCommitResult>) | null) => void;
  /** How many rows are typed but NOT yet booked (owner 2026-08-07). The drafts
   *  live inside this component in SAVED mode, so the page cannot see them —
   *  and the page owns the exits (its back button, the payments Edit toggle)
   *  that would silently discard them. Must be a STABLE reference (a useState
   *  setter, or useCallback) — it is an effect dependency. */
  onUnsavedChange?: (count: number) => void;
  /** Owner 2026-08-07 — control rendered on the RIGHT of the card header (the
   *  SO detail puts its payments-only Edit toggle there, mirroring mobile's
   *  in-card toggle). The card header lives in here, not in the caller, so a
   *  page that needs a control beside "Payments" has to hand it in. */
  headerAction?: ReactNode;
  /** Official Receipt print (GL redesign 9b). When present, a PERSISTED row
   *  grows a printer button: POST /accounting/receipts/ensure fetches (or
   *  heals) the payment's OR, then the pdf prints — DRAFT watermark until the
   *  money is confirmed. Deliberately available while `locked`: printing
   *  changes nothing, and the counter is exactly where it happens. */
  receiptFor?: ReceiptSource;
};

type DraftModeProps = {
  docNo: null;
  payments: PaymentDraft[];
  onChange: (next: PaymentDraft[]) => void;
  grandTotalSen: number;
  currency?: string;
  locked?: boolean;
  /** Unused in DRAFT mode (no persisted rows to same-day-lock); declared so the
   *  discriminated-union prop stays accessible without a cast. */
  draftUnlocked?: boolean;
  /** Render the per-draft slip uploader (SO-route batching only — the SO payments
   *  endpoint requires a slip per payment; DO/SI endpoints don't accept one). */
  slipUpload?: boolean;
  /** See SavedModeProps.collectedByAllowedIds. */
  collectedByAllowedIds?: Set<string> | null;
  /** See SavedModeProps.defaultCollectedBy. */
  defaultCollectedBy?: string | null;
  /** See SavedModeProps.headerAction. */
  headerAction?: ReactNode;
  /** Declared so the discriminated union stays readable without a cast; the
   *  count is always 0 in DRAFT mode (the whole document is unsaved and the
   *  page's own Save commits it), so this never fires here. */
  onUnsavedChange?: (count: number) => void;
  /** See SavedModeProps.receiptFor. DRAFT-mode rows are anonymous local state,
   *  so the caller must also say which uids are persisted payment ids
   *  (`persistedIds`) — the SI detail seeds its drafts from the API rows and
   *  keeps `uid = row id`, which is exactly the key the ensure endpoint takes. */
  receiptFor?: ReceiptSource;
};

/** Which payment book the rows belong to, in the receipts table's own key. */
type ReceiptSource = { source: 'SOPAY' | 'SIPAY'; persistedIds?: ReadonlySet<string> };

export type PaymentsTableProps = SavedModeProps | DraftModeProps;

/* ════════════════════════════════════════════════════════════════════════
   Per-payment slip thumbnail (Spec D4, migration 0159).

   Per-payment slip (0159) first; legacy rows fall back to the order slip
   (Wei Siang's 2026-06-06 column semantics). The per-row slip (blob object
   URL via the Worker proxy) is fetched lazily and only when the row actually
   carries a slip_key.
   ════════════════════════════════════════════════════════════════════════ */
const PaymentSlipThumb = ({ docNo, payment, orderSlipUrl, orderSlipType }: {
  docNo: string;
  payment: SoPayment;
  orderSlipUrl: string | null;
  orderSlipType: string;
}) => {
  const perRowQ = useQuery({
    queryKey: ['payment-slip', payment.id],
    enabled: Boolean(payment.slip_key),
    // Houzs proxy deviation: fetchPaymentSlipUrl now returns a blob object URL
    // (no 5-min presign expiry); the staleTime just bounds re-fetch churn.
    staleTime: 4 * 60 * 1000,
    queryFn: () => fetchPaymentSlipUrl(docNo, payment.id),
  });
  const url = payment.slip_key ? (perRowQ.data?.url ?? null) : orderSlipUrl;
  const contentType = payment.slip_key ? (perRowQ.data?.contentType ?? 'image/jpeg') : orderSlipType;
  if (!url) return <span className={detailStyles.muted}>—</span>;
  if (contentType.startsWith('image/')) {
    /* Owner 2026-07-19 — the slip was a 34x34 crop, which is not enough pixels
       to read an amount or a reference number off a bank slip; the column
       existed but was decorative. 72px square with object-fit:contain (not
       cover) so the whole slip is visible rather than a centre crop of it —
       a cropped slip loses exactly the edges where the reference number sits.
       Click still opens the full-size image, as it always did. */
    return (
      <a href={url} target="_blank" rel="noreferrer" title="Open payment slip full size">
        <img
          src={url}
          alt="Slip"
          style={{
            width: 72, height: 72, objectFit: 'contain',
            borderRadius: 4, border: '1px solid var(--line)', display: 'block',
            background: 'var(--bg-subtle, #fff)',
          }}
        />
      </a>
    );
  }
  return <a href={url} target="_blank" rel="noreferrer" style={{ fontSize: 'var(--fs-11)', color: 'var(--c-burnt)' }}>PDF</a>;
};

/* ════════════════════════════════════════════════════════════════════════
   Component.
   ════════════════════════════════════════════════════════════════════════ */

const PaymentsTableInner = (props: PaymentsTableProps) => {
  const notify = useNotify();
  const askConfirm = useConfirm();
  const currency = props.currency ?? 'MYR';
  const grandTotal = props.grandTotalSen ?? 0;
  const locked = props.locked ?? false;
  /* Owner 2026-07-13 — DRAFT SO: lift the per-row same-day EDIT lock so every
     persisted payment on an unconfirmed order can still be corrected. */
  const draftUnlocked = props.draftUnlocked ?? false;

  /* ── Official Receipt print (GL redesign 9b) ──────────────────────────
     ensure-then-print: the endpoint fetches the payment's OR (creating one
     for a payment recorded before the module existed) and hands the whole
     row back; the pdf carries a DRAFT watermark until the money confirms. */
  const receiptFor = props.receiptFor;
  const [receiptBusy, setReceiptBusy] = useState<string | null>(null);
  const printReceipt = async (paymentId: string) => {
    if (!receiptFor) return;
    setReceiptBusy(paymentId);
    try {
      const res = await authedFetch<{ receipt: ReceiptPdfData }>('/accounting/receipts/ensure', {
        method: 'POST', body: JSON.stringify({ source: receiptFor.source, paymentId }),
      });
      await generateReceiptPdf(res.receipt, { action: 'print' });
    } catch (e) {
      void notify({
        title: 'Receipt not printed',
        body: e instanceof Error ? e.message : 'Something went wrong.',
        tone: 'error',
      });
    } finally {
      setReceiptBusy(null);
    }
  };

  const staffQ = useStaff();
  const staff  = staffQ.data ?? [];        // FULL roster — resolves persisted collected_by names
  /* The Collected-By SELECTION list is company-scoped via the Team-grant rule
     (usePickableStaff); the display of already-recorded rows keeps the full
     roster (staffNameById) so a scoped-out / departed collector still resolves
     to a name. */
  const pickableStaff = usePickableStaff().data ?? [];
  const auth   = useAuth();

  /* Task #118 — methods are DB-backed (so_dropdown_options 'payment_method',
     locked to the four core rows since the 2026-06-06 unify). Falls back to
     FALLBACK_OPTIONS during loading + when the DB has zero rows so the user
     never sees an empty select.

     Task #122 (cascade) — three additional categories for the L2 picks
     under Merchant / Online / Installment. */
  const methodOptsQ      = useSoDropdownOptions('payment_method');
  const methodOpts       = optionsOrFallback('payment_method', methodOptsQ.data);
  const merchantOptsQ    = useSoDropdownOptions('payment_merchant');
  const merchantOpts     = optionsOrFallback('payment_merchant', merchantOptsQ.data);
  const onlineOptsQ      = useSoDropdownOptions('online_type');
  const onlineOpts       = optionsOrFallback('online_type', onlineOptsQ.data);
  const installmentOptsQ = useSoDropdownOptions('installment_plan');
  const installmentOpts  = optionsOrFallback('installment_plan', installmentOptsQ.data);

  /* ── SAVED MODE hooks (always called — TanStack Query lazily skips
        when enabled=false). docNo is non-null in SAVED mode. ──────────── */
  const isSaved = props.docNo !== null;
  const paymentsQ     = useSalesOrderPayments(isSaved ? props.docNo : null);
  const addPayment    = useAddSalesOrderPayment();
  const editPayment   = useEditSalesOrderPayment();
  const attachSlip    = useAttachSalesOrderPaymentSlip();
  const deletePayment = useDeleteSalesOrderPayment();

  /* Attach / replace the proof on a PERSISTED row (owner 2026-08-07). Separate
     endpoint from the payment PATCH, because PATCH is same-day-locked and this
     is not — see the route comment. Replacing an existing slip asks first: the
     old proof is not recoverable from the UI afterwards. */
  const attachSlipToPayment = async (p: SoPayment, uploadSessionId: string) => {
    if (!isSaved) return;
    if (p.slip_key && !(await askConfirm({
      title: 'Replace the proof on this payment?',
      body: 'The slip currently attached to this payment will be swapped for the one you just uploaded. The change is recorded in the order history.',
      confirmLabel: 'Replace',
    }))) return;
    attachSlip.mutate(
      { docNo: (props as SavedModeProps).docNo, id: p.id, uploadSessionId },
      {
        onError: (e) => {
          // eslint-disable-next-line no-console
          console.error('[payment] slip attach failed:', e);
          notify({
            title: 'Failed to attach the proof',
            body: e instanceof Error ? e.message : 'Something went wrong.',
            tone: 'error',
          });
        },
      },
    );
  };

  /* SAVED-mode local drafts (pre-commit rows). DRAFT mode uses parent's
     `payments` array directly. */
  const [savedDraftState, setSavedDraftState] = useState<{ docNo: string | null; drafts: PaymentDraft[] }>({ docNo: null, drafts: [] });
  const savedDocNo = isSaved ? props.docNo : null;
  const initialDrafts = isSaved ? ((props as SavedModeProps).initialDrafts ?? EMPTY_PAYMENT_DRAFTS) : EMPTY_PAYMENT_DRAFTS;
  useEffect(() => {
    if (!isSaved || !savedDocNo) return;
    setSavedDraftState((current) => {
      const base = current.docNo === savedDocNo ? current.drafts : [];
      const keys = new Set(base.map((draft) => draft.idempotencyKey).filter(Boolean));
      const incoming = initialDrafts.filter(
        (draft) => draft.idempotencyKey && !keys.has(draft.idempotencyKey),
      );
      return { docNo: savedDocNo, drafts: incoming.length > 0 ? [...base, ...incoming] : base };
    });
  }, [isSaved, initialDrafts, savedDocNo]);
  const savedDrafts = savedDraftState.docNo === savedDocNo ? savedDraftState.drafts : EMPTY_PAYMENT_DRAFTS;

  const setSavedDrafts = (updater: PaymentDraft[] | ((current: PaymentDraft[]) => PaymentDraft[])) => {
    if (!savedDocNo) return;
    setSavedDraftState((current) => {
      const base = current.docNo === savedDocNo ? current.drafts : [];
      return { docNo: savedDocNo, drafts: typeof updater === 'function' ? updater(base) : updater };
    });
  };

  const persistedPayments: SoPayment[] = isSaved ? (paymentsQ.data ?? []) : [];
  const drafts: PaymentDraft[] = isSaved ? savedDrafts : (props as DraftModeProps).payments;

  /* Latest drafts mirror — the receipt-scan handler resolves asynchronously
     (a late scan can land after the operator has kept typing), so it must read
     each row's CURRENT values by uid, never the values captured when the scan
     was fired. This ref is kept in sync with `drafts` every render. */
  const draftsRef = useRef<PaymentDraft[]>(drafts);
  draftsRef.current = drafts;

  /* Default Collected By → current logged-in staff. Nick 2026-07-09:
     "Collect By needs default user" — the row was landing empty when
     auth.staff resolved AFTER the staff dropdown, since the previous
     check filtered the id out when it wasn't found in the active list
     yet. Relax to: always return auth.staff?.id when auth has it,
     regardless of whether staff has loaded. If the id turns out to
     match no active staff, the dropdown falls through to '—' at render
     time — but the common case (owner / staff clicking Add Payment on
     their own account) now defaults reliably.
     Existing persisted payments still show their stored `collected_by`
     name — this default only seeds NEW draft rows.

     Owner 2026-07-13 — prefer the page-supplied `defaultCollectedBy` when
     given: on Houzs the auth bridge's staff id is null, so the page resolves
     the logged-in user's scm.staff row by email and passes it here. Fall back
     to the bridge id (HOOKKA / 2990, where it's populated) when the prop is
     unset. */
  const defaultStaffId = (props.defaultCollectedBy || '') || (auth.staff?.id ?? '');

  const addDraft = () => {
    /* Loo 2026-06-09 — seed the new row's amount with the OUTSTANDING balance
       (grand total − already paid − amounts on other in-flight rows) so a full
       balance payment is one click. On SO create the first row defaults to the
       full total; a split second row defaults to the remainder. Mirrors the POS
       Record-payment drawer + handover default. */
    const paidNow =
      persistedPayments.reduce((s, p) => s + (p.amount_sen || 0), 0) +
      drafts.reduce((s, dr) => s + (dr.amountSen || 0), 0);
    /* This floor STAYS, unlike the displayed balance below (owner 2026-08-16).
       It seeds an INPUT, and the amount a cashier is about to collect is never
       negative — an already-over-collected order defaults the next row to 0,
       not to minus the credit. `amountSen` is `.nonnegative()` server-side. */
    const outstanding = Math.max(0, grandTotal - paidNow);
    const d = { ...newPaymentDraft(defaultStaffId), amountSen: outstanding };
    if (isSaved) {
      setSavedDrafts((prev) => [...prev, d]);
    } else {
      (props as DraftModeProps).onChange([...(props as DraftModeProps).payments, d]);
    }
  };

  const patchDraft = (uid: string, patch: Partial<PaymentDraft>) => {
    if (isSaved) {
      setSavedDrafts((prev) => prev.map((d) => d.uid === uid ? { ...d, ...patch } : d));
    } else {
      const cur = (props as DraftModeProps).payments;
      (props as DraftModeProps).onChange(
        cur.map((d) => d.uid === uid ? { ...d, ...patch } : d),
      );
    }
  };

  const removeDraft = (uid: string) => {
    if (isSaved) {
      setSavedDrafts((prev) => prev.filter((d) => d.uid !== uid));
    } else {
      const cur = (props as DraftModeProps).payments;
      (props as DraftModeProps).onChange(cur.filter((d) => d.uid !== uid));
    }
  };

  /* Receipt OCR fill (card-terminal / EPP slip). Fired by SlipUploadField when
     an IMAGE is uploaded to a row's slip — the receipt IS the slip. Reads the
     row's CURRENT state by uid (draftsRef) and fills ONLY blank fields, so a
     late scan never clobbers anything the operator already typed. Method maps
     to the locked payment_method VALUE: Merchant → bank; Online → online type;
     Installment → tenure plan; Cash → nothing. Owner convention: a card EPP
     receipt comes back as method=Installment + the N-month plan.

     UI: SUCCESS is SILENT — the visible feedback is the fields populating
     themselves; we render NOTHING in the narrow Slip column (the reason the
     last version was reverted). Only a hard scan FAILURE surfaces a brief
     in-app notice so the operator knows to fill manually; that notice is the
     shared modal (never rendered inside the Slip cell). Best-effort — a
     failure changes no fields. */
  const scanReceiptIntoRow = async (uid: string, file: File): Promise<void> => {
    let rec;
    try {
      rec = await scanPaymentReceipt(file);
    } catch {
      void notify({ title: 'Could not read receipt', body: 'Fill the payment fields manually.', tone: 'info' });
      return;
    }
    const row = draftsRef.current.find((d) => d.uid === uid);
    if (!row) return;

    /* 3-method model (spec 1 + 2) — a card-terminal receipt is always a
       Merchant payment (drop the legacy Installment carve-out: a bank EPP is
       Merchant + an N-month plan). Fold any legacy "Installment" match to
       Merchant so a stale backend never seeds a dropped method. */
    const rawMethod = rec.paymentMethodMatch?.value ?? '';
    const method = rawMethod === 'Installment' ? 'Merchant' : rawMethod;
    const patch: Partial<PaymentDraft> = {};
    // methodLabel ← payment_method VALUE (only when the row still holds the
    // default 'Cash' OR is blank — i.e. the operator hasn't deliberately set it).
    if (method && (row.methodLabel === '' || row.methodLabel === 'Cash')) {
      patch.methodLabel = method;
    }
    // The method the row WILL have once this patch applies (so the L2 fills are
    // gated against the post-patch method, not the stale one).
    const effectiveMethod = patch.methodLabel ?? row.methodLabel;
    if (effectiveMethod === 'Merchant') {
      // Bank (merchant_provider).
      if (rec.bankMatch?.value && !row.merchantProvider) {
        patch.merchantProvider = rec.bankMatch.value;
      }
      // Plan (installment_months) — a matched tenure (e.g. AEON 12 Months) wins;
      // a Merchant swipe with NO tenure on the receipt → "One Shot" (spec 6).
      if (!row.installmentMonthsLabel) {
        patch.installmentMonthsLabel = rec.installmentPlanMatch?.value || ONE_SHOT_PLAN;
      }
    }
    if (effectiveMethod === 'Online' && rec.onlineTypeMatch?.value && !row.onlineType) {
      patch.onlineType = rec.onlineTypeMatch.value;
    }
    if (rec.approvalCode && !row.approvalCode) {
      patch.approvalCode = rec.approvalCode;
    }
    if (rec.amountRm != null && rec.amountRm > 0 && row.amountSen <= 0) {
      patch.amountSen = Math.round(rec.amountRm * 100);
    }
    /* paid_at ← the receipt's swipe date (spec 2). THIS MAY BE A PAST DATE —
       the salesperson can open the SO days after collecting the money — so we
       set it verbatim and never clamp to today. Only fills when the row still
       holds the default todayMyt() value (the operator hasn't set a date). */
    if (rec.paidAt && (row.paidAt === '' || row.paidAt === todayMyt())) {
      patch.paidAt = rec.paidAt;
    }

    if (Object.keys(patch).length > 0) patchDraft(uid, patch);
  };

  /* Same-day EDIT + DELETE window (owner 2026-07-13, extended to DELETE
     2026-07-19). A persisted payment created on the current MY calendar day may
     be corrected or removed; after MYT midnight it locks.

     `isCreatedTodayMyt` is imported from vendor/scm/lib/dates rather than
     re-declared here — this file carried a byte-identical private copy, which
     is exactly how the delete path came to diverge from the edit path in the
     first place.

     `rowMutable` routes the decision through the SHARED policy predicate that
     the server also uses (so-field-policy.paymentRowMutable), so the button and
     the endpoint cannot disagree about whether the window is open. */
  const rowMutable = (createdAt: string | null | undefined): boolean => {
    /* An unreadable created_at is not "today" and not "not today" — we cannot
       tell. Deny the control and let the server explain, rather than defaulting
       into a silent allow. */
    if (!createdAt) return false;
    const t = new Date(createdAt).getTime();
    if (Number.isNaN(t)) return false;
    const day = mytDayOf(createdAt);
    if (day === null) return false;
    return paymentRowMutable(day, todayMyt(), draftUnlocked).mutable;
  };

  /* installment_months (int|null) → the maintenance plan LABEL/value to rehydrate
     the Plan <select> when editing a persisted row. Matches on parsed months;
     null → One Shot; an unlisted term falls back to "N months". */
  const installmentLabelForMonths = (months: number | null): string => {
    if (!months) return ONE_SHOT_PLAN;
    return installmentOpts.find((o) => parseInstallmentMonths(o.value) === months)?.value
      ?? `${months} months`;
  };

  const isEditingPersisted = (id: string): boolean =>
    savedDrafts.some((d) => d.editingPersistedId === id);

  /* Seed an in-place edit draft from a persisted row and hide that row while the
     draft edits it. Reuses the exact same inline fields as Add Payment. */
  const beginEditPersisted = (p: SoPayment) => {
    if (!isSaved || isEditingPersisted(p.id)) return;
    setSavedDrafts((prev) => [...prev, {
      uid: Math.random().toString(36).slice(2, 10),
      paidAt: (p.paid_at ?? '').slice(0, 10) || todayMyt(),
      methodLabel: apiToValue(p),
      merchantProvider: p.merchant_provider ?? '',
      installmentMonthsLabel:
        (p.method === 'merchant' || p.method === 'installment')
          ? installmentLabelForMonths(p.installment_months) : '',
      onlineType: p.online_type ?? '',
      amountSen: p.amount_sen,
      accountSheet: p.account_sheet ?? '',
      approvalCode: p.approval_code ?? '',
      collectedBy: p.collected_by ?? '',
      slipUploadSessionId: null,
      editingPersistedId: p.id,
    }]);
  };

  /* Commit an edit draft → PATCH /:docNo/payments/:id. Same payload derivation
     as commitDraft's POST (method-scoped sub-fields via draftMethodFields);
     slip is untouched by an edit. On success the draft is dropped and the
     (freshly refetched) persisted row reappears. */
  const commitEdit = (d: PaymentDraft) => {
    if (!isSaved || !d.editingPersistedId) return;
    const persisted = persistedPayments.find((p) => p.id === d.editingPersistedId);
    if (!persisted) return;
    const { method } = labelToApi(d.methodLabel);
    const body = {
      docNo:        (props as SavedModeProps).docNo,
      id:           d.editingPersistedId,
      version:      persisted.version,
      paidAt:       d.paidAt,
      method,
      amountSen:  d.amountSen,
      accountSheet: d.accountSheet || null,
      approvalCode: d.approvalCode || null,
      collectedBy:  d.collectedBy  || null,
      ...draftMethodFields(method, d),
    };
    editPayment.mutate(body, {
      onSuccess: () => removeDraft(d.uid),
      onError: (e) => {
        // eslint-disable-next-line no-console
        console.error('[payment] edit failed:', e);
        notify({ title: 'Failed to save changes', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
      },
    });
  };

  /* SAVED mode commit — fire POST /:docNo/payments. DRAFT mode has no
     commit affordance; the parent batches them at SO-create time. */
  const commitDraft = (d: PaymentDraft) => {
    if (!isSaved) return;
    /* Owner 2026-07-13 — the slip is OPTIONAL now (a receipt isn't always on
       hand). Gate only on an amount > 0; the SO route accepts a slip-less
       payment. The slip uploader stays available for when one IS attached. */
    if (d.amountSen <= 0) return;
    /* Same-day EDIT (owner 2026-07-13) — an edit draft carries the id of the
       persisted row it amends. Route it through PATCH instead of POST. */
    if (d.editingPersistedId) { commitEdit(d); return; }
    /* Cascade guard (spec 1) — block the commit when the chosen method is
       missing a required sub-field (Merchant → Bank + Plan; Online → Sub-Type)
       and tell the operator which one. */
    const missing = missingMethodSubField(d);
    if (missing) {
      void notify({
        title: `Pick the ${missing} for this ${d.methodLabel} payment.`,
        tone: 'error',
      });
      return;
    }
    const { method } = labelToApi(d.methodLabel);
    /* Cascade payload — populate sub-fields by the L1 method only
       (draftMethodFields). The API mirrors the same guard and will scrub any
       irrelevant sub-fields (e.g. a stale onlineType left over from a
       Merchant→Online toggle). */
    const body: Record<string, unknown> = {
      docNo:           (props as SavedModeProps).docNo,
      paidAt:          d.paidAt,
      method,
      amountSen:     d.amountSen,
      accountSheet:    d.accountSheet || null,
      approvalCode:    d.approvalCode || null,
      collectedBy:     d.collectedBy  || null,
      uploadSessionId: d.slipUploadSessionId,
      /* This row's own key — the hook lifts it into the Idempotency-Key header
         rather than the body. A commit that fails leaves the draft (and so the
         key) in place, so the operator's retry de-dupes against the first
         attempt instead of booking the payment twice. */
      idempotencyKey:  d.idempotencyKey,
      ...draftMethodFields(method, d),
    };
    addPayment.mutate(body as { docNo: string } & Record<string, unknown>, {
      onSuccess: () => {
        removeDraft(d.uid);
        (props as SavedModeProps).onDraftCommitted?.(d);
      },
      onError: (e) => {
        // eslint-disable-next-line no-console
        console.error('[payment] add failed:', e);
        notify({ title: 'Failed to save payment', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
      },
    });
  };

  /* THE PAGE'S SAVE COMMITS THESE ROWS TOO (owner 2026-08-31).
   *
   * A typed payment row used to be booked ONLY by its own Save button. The page
   * Save saved the document and left the row where it was — and the one warning
   * that exists (`onUnsavedChange` -> the page's guard) is wired to the payments
   * card's Done and to the page's BACK button, not to Save. So the operator
   * pressed Save, the order saved, and the money row was silently dropped:
   * 「我明明有 update 到 payment，可是为什么 payment 那边没有 save 成功呢」. On
   * HC-SO-013393 the audit log held zero payment actions of any kind.
   *
   * AWAITABLE, and reports per row, because the page has to know whether to stay
   * put. A row that cannot be committed (no amount, missing sub-field) is
   * RETURNED as blocked rather than skipped — silently skipping is the bug.
   * Each row keeps its own idempotency key, so a retry de-dupes against the
   * first attempt instead of booking the money twice. */
  const commitAllDrafts = useCallback(async (): Promise<PaymentCommitResult> => {
    if (!isSaved) return { committed: 0, failed: 0, blocked: [] };
    const pending = draftsRef.current.filter((d) => !d.editingPersistedId);
    const blocked: string[] = [];
    let committed = 0;
    let failed = 0;
    for (const d of pending) {
      if (d.amountSen <= 0) { blocked.push(`${d.methodLabel}: no amount`); continue; }
      const missing = missingMethodSubField(d);
      if (missing) { blocked.push(`${d.methodLabel}: pick the ${missing}`); continue; }
      const { method } = labelToApi(d.methodLabel);
      try {
        await addPayment.mutateAsync({
          docNo:           (props as SavedModeProps).docNo,
          paidAt:          d.paidAt,
          method,
          amountSen:       d.amountSen,
          accountSheet:    d.accountSheet || null,
          approvalCode:    d.approvalCode || null,
          collectedBy:     d.collectedBy || null,
          uploadSessionId: d.slipUploadSessionId,
          idempotencyKey:  d.idempotencyKey,
          ...draftMethodFields(method, d),
        } as { docNo: string } & Record<string, unknown>);
        removeDraft(d.uid);
        (props as SavedModeProps).onDraftCommitted?.(d);
        committed += 1;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[payment] add failed during page save:', e);
        failed += 1;
      }
    }
    return { committed, failed, blocked };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- props is read at call time by design
  }, [isSaved, addPayment, removeDraft]);

  /* Summary maths — identical across modes. In DRAFT mode there are no
     persisted rows yet, so paid is just Σ drafts. In SAVED mode paid is
     Σ persisted (drafts only enter the total once committed via API). */
  const paidSen = isSaved
    ? persistedPayments.reduce((sum, p) => sum + (p.amount_sen || 0), 0)
    : drafts.reduce((sum, d) => sum + (d.amountSen || 0), 0);
  /* SIGNED (owner 2026-08-16) — over-collection is allowed, and a negative
     balance is the whole point: it is what tells the operator he is holding
     RM 250 of the customer's money. The old Math.max(0, …) floor is what made
     an over-payment look like a settled order, so the only way to make the
     screen agree with the cash was to go back and re-price a LINE.

     Floored still when there is no total to measure against — a zero grand
     total is an unsaved / not-yet-recomputed order, not a fully-credited one.
     Same rule as soBalanceSen on the server. */
  const balanceSen = grandTotal > 0 ? grandTotal - paidSen : 0;
  const overCollected = balanceSen < 0;

  const staffNameById = (id: string | null): string | null => {
    if (!id) return null;
    return staff.find((s) => s.id === id)?.name ?? null;
  };

  /* Persisted row → display label. Resolves the live maintenance label for
     the row's method (so a rename in SO Maintenance re-labels history too);
     falls back to the shared defaults. */
  const methodDisplay = (p: SoPayment): string => {
    const value = apiToValue(p);
    return methodOpts.find((m) => m.value === value)?.label
      ?? PAYMENT_METHOD_DEFAULT_LABELS[p.method as PaymentMethodCode]
      ?? value;
  };

  const totalRowCount = persistedPayments.length + drafts.length;

  /* Optional payment-slip column. One slip per order, so we fetch it once and
     render the same proof thumbnail on each persisted row, in a "Slip" column
     immediately left of Collected By. */
  const slipProp = isSaved ? (props as SavedModeProps).slip : undefined;
  /* Show the Slip column when the order prop is passed (SO detail) OR when any
     persisted row carries its own per-payment slip (Spec D4). DO/SI tables
     pass no prop and their payments have no slip_key, so they stay unchanged. */
  const showSlip = Boolean(slipProp) || persistedPayments.some((p) => p.slip_key);
  const [slipUrl, setSlipUrl] = useState<string | null>(null);
  const [slipType, setSlipType] = useState<string>('image/jpeg');
  useEffect(() => {
    if (!isSaved || !slipProp?.slipKey) { setSlipUrl(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await slipProp.fetcher((props as SavedModeProps).docNo);
        if (!cancelled) { setSlipUrl(r.url); setSlipType(r.contentType); }
      } catch { if (!cancelled) setSlipUrl(null); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSaved, slipProp?.slipKey]);

  /* 8-column override when the Slip column is shown (SO detail).
     ALL FIXED, NO fr (owner 2026-07-18: "整齐一点"). Every prior attempt kept
     one flexible track so the table would "fill" the card, and every attempt
     read crooked because a flexible track has no honest width:
       - Collected By was minmax(140px, 1fr): on a WIDE desktop body it
         ballooned to absorb all the leftover width, leaving the other columns
         cramped-left with a gap punched down the middle of the row;
       - the min-width that guarded it (844) then forced a horizontal scrollbar
         the moment the body was narrower than that.
     There is no width worth stretching to fill: the payments table is a small
     fixed set of columns. Pinning EVERY track to the width that fits its own
     header on one line makes the grid a tidy, predictable 844px block that
     left-aligns in its card — the leftover space sits as trailing air to the
     RIGHT of the whole table, never as holes between columns, and nothing
     balloons on a wide screen. Track widths are each sized to their header
     (Amount 116 holds "Amount (MYR)"; Account Sheet / Approval Code / Collected
     By at 140 each hold their labels — headerCell is white-space:nowrap so a
     track can only be too narrow, never wrap). Track sum:
       112 + 116 + 116 + 140 + 140 + 52 + 140 + 28 = 844 px,
     which fits inside a typical ~960-1000px SCM detail body with no scroll. The
     844 min-width is kept as the narrow/drawer-open safety net: below 844 the
     .gridScroll wrapper scrolls the block horizontally instead of clipping the
     Slip cell. */
  /* Slip track widened 52 -> 88px alongside the 72px thumbnail (owner
     2026-07-19, "the slip must be legible"). Track sum moves 844 -> 880:
       112 + 116 + 116 + 140 + 140 + 88 + 140 + 28 = 880 px.
     minWidth moves with it. Read the note above before touching these: every
     track is FIXED on purpose, and reintroducing an `fr` to absorb the extra
     36px is the exact change that previously ballooned Collected By and punched
     a gap down the middle of the row. 880 still fits a typical ~960-1000px SCM
     detail body without a scrollbar; below it .gridScroll scrolls the block. */
  /* Trailing actions track widens 28 -> 104px while an UNSAVED row is on screen
     (owner 2026-08-07). 28px only ever fitted icon-only buttons, and an
     icon-only 💾 is precisely what cost a real balance collection: the operator
     filled the row, watched the slip uploader turn into a green tick, read that
     as "saved", and navigated away — the payment was never written and the slip
     was left orphaned in R2. The tick means "the FILE reached R2", which is not
     a fact anyone outside this code cares about. So the commit affordance gets
     a WORD, not a glyph. Widening a fixed track (rather than adding an `fr`) is
     the change the note above permits; the 36px lesson was about flexible
     tracks ballooning, not about track width.
     Track sum with an unsaved row:
       112 + 116 + 116 + 140 + 140 + 88 + 140 + 104 = 956 px.
     Read-only (no drafts) stays exactly as it was at 880. */
  const hasUnsavedRows = drafts.length > 0;

  /* ── Leaving with unbooked money (owner 2026-08-07) ────────────────────────
     The marks added earlier say a row is unsaved; they cannot stop anyone
     acting on it. The loss this all comes from was "filled it in and left", and
     a notice you have already walked past is not a guard.

     `beforeunload` covers the exits the browser owns: closing the tab, a
     refresh, typing a new URL — and the COMPANY SWITCH, which hard-reloads the
     app (TopNavbar carries its own confirm precisely because, in its words,
     "the app registers no beforeunload guard". It does now, for this case.)

     It does NOT cover in-app SPA navigation. react-router 6 blocks that only
     through `useBlocker`, which requires a DATA router, and this app mounts a
     plain BrowserRouter + <Routes>. Converting the whole app's router to get
     one dialog is not a trade worth making here, so the page-owned exits are
     guarded individually instead (see onUnsavedChange). The left nav and the
     workspace tabs remain unguarded — stated plainly rather than papered over.

     SAVED mode only: a DRAFT-mode page (New SO / DO / SI) has its own Save for
     the whole document and its own recovery path, and would otherwise prompt on
     every single exit from a form where every row is legitimately unsaved. */
  const unsavedCount = isSaved ? drafts.length : 0;
  useEffect(() => {
    if (unsavedCount === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      /* Both lines are required for cross-browser coverage; no browser has
         shown custom text here for years, so there is no message to write. */
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsavedCount]);

  /* Registered upward the same way the unsaved COUNT is, and nulled on unmount
     for the same reason: the page outlives this card. */
  const onRegisterCommitAll = (props as SavedModeProps).onRegisterCommitAll;
  useEffect(() => {
    if (!isSaved) return;
    onRegisterCommitAll?.(commitAllDrafts);
    return () => onRegisterCommitAll?.(null);
  }, [isSaved, onRegisterCommitAll, commitAllDrafts]);

  const onUnsavedChange = props.onUnsavedChange;
  useEffect(() => {
    onUnsavedChange?.(unsavedCount);
    /* Report zero on unmount: the page outlives this card (the payments Edit
       toggle unmounts it), and a stale non-zero count would leave the page
       guarding work that no longer exists. */
    return () => onUnsavedChange?.(0);
  }, [unsavedCount, onUnsavedChange]);
  /* The tint marks a row as NOT YET a payment. That only says something in
     SAVED mode, where it sits among real ones. On New SO / DO / SI every row is
     unsaved and committed by the page's own Save, so tinting them all just
     paints the table orange. Same reasoning as the Unsaved pill. */
  const unsavedCls = isSaved ? paymentsStyles.unsavedCell : '';
  const gridStyle: CSSProperties | undefined = showSlip
    ? {
        gridTemplateColumns:
          `112px 116px 116px 140px 140px 88px 140px ${hasUnsavedRows ? '104px' : '28px'}`,
        minWidth: hasUnsavedRows ? 956 : 880,
      }
    : undefined;

  return (
    <section className={detailStyles.card}>
      <header className={detailStyles.cardHeader}>
        <h2 className={detailStyles.cardTitle}>
          <DollarSign size={14} strokeWidth={1.75} /> Payments
        </h2>
        {props.headerAction}
      </header>
      <div className={detailStyles.cardBody}>
        <div className={paymentsStyles.section}>
          {/* Top bar with + Add Payment trigger ─────────────────────── */}
          <div className={paymentsStyles.head}>
            <span className={paymentsStyles.headLabel}>
              {totalRowCount} transaction{totalRowCount === 1 ? '' : 's'}
              {/* The count above cheerfully includes rows that are not payments
                  yet, which is how an unsaved row can read as booked from the
                  summary alone. Name them here too, so the fact survives being
                  scrolled past the row itself. SAVED mode only — see the pill. */}
              {isSaved && hasUnsavedRows && (
                <span style={{ color: 'var(--c-burnt)', fontWeight: 700 }}>
                  {' · '}{drafts.length} unsaved
                </span>
              )}
            </span>
            {!locked && (
              <button
                type="button"
                className={paymentsStyles.addBtn}
                onClick={addDraft}
                disabled={isSaved && addPayment.isPending}
              >
                <Plus size={14} strokeWidth={1.75} />
                Add Payment
              </button>
            )}
          </div>

          {/* Transactions table ──────────────────────────────────────── */}
          {/* Bug #4 — OUTER scroll wrapper: the wide slip-mode grid scrolls
              horizontally INSIDE the overflow:hidden card instead of being
              clipped at the right edge. overflow lives on the wrapper, the
              min-width on the inner .grid (must be different elements). */}
          <div className={paymentsStyles.gridScroll}>
          <div className={paymentsStyles.grid} style={gridStyle}>
            {/* Header row */}
            <span className={paymentsStyles.headerCell}>
              Date <CalIcon size={12} strokeWidth={1.75} />
            </span>
            <span className={paymentsStyles.headerCell}>
              Method <Tag size={12} strokeWidth={1.75} />
            </span>
            <span className={paymentsStyles.headerCellRight}>
              Amount ({currency}) <DollarSign size={12} strokeWidth={1.75} />
            </span>
            <span className={paymentsStyles.headerCell}>
              Account Sheet <FileText size={12} strokeWidth={1.75} />
            </span>
            <span className={paymentsStyles.headerCell}>
              Approval Code <FileText size={12} strokeWidth={1.75} />
            </span>
            {showSlip && (
              <span className={paymentsStyles.headerCell}>
                Slip <ImageIcon size={12} strokeWidth={1.75} />
              </span>
            )}
            <span className={paymentsStyles.headerCell}>
              Collected By <UserIcon size={12} strokeWidth={1.75} />
            </span>
            <span className={paymentsStyles.headerCell} />

            {/* Empty + loading states */}
            {isSaved && paymentsQ.isLoading && (
              <span className={paymentsStyles.emptyRow} style={{ gridColumn: '1 / -1' }}>
                Loading…
              </span>
            )}
            {(!isSaved || !paymentsQ.isLoading) &&
              persistedPayments.length === 0 &&
              drafts.length === 0 && (
              <span className={paymentsStyles.emptyRow} style={{ gridColumn: '1 / -1' }}>
                No payments recorded yet · click "Add Payment" to log a deposit
              </span>
            )}

            {/* Persisted payment rows (SAVED mode only). A row currently being
                edited in place is hidden — its editable draft renders below. */}
            {persistedPayments.filter((p) => !isEditingPersisted(p.id)).map((p) => (
              <div className={paymentsStyles.row} key={p.id}>
                <span className={paymentsStyles.cell} data-label="Date" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {formatDate(p.paid_at)}
                </span>
                <span className={paymentsStyles.cell} data-label="Method" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                  <span className={paymentsStyles.methodPill} style={methodPillStyle(p.method)}>
                    {methodDisplay(p)}
                  </span>
                  {/* Task #122 (cascade) — surface the L2 picks below the
                      pill so a Merchant row reads as "Merchant · MBB · 12
                      months", an Online row as "Online · TNG", an
                      Installment row as "Installment · 12m". */}
                  {p.method === 'merchant' && (p.merchant_provider || p.installment_months) && (
                    <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                      {p.merchant_provider ?? '—'}
                      {p.installment_months ? ` · ${p.installment_months}m` : ''}
                    </span>
                  )}
                  {p.method === 'transfer' && p.online_type && (
                    <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                      {p.online_type}
                    </span>
                  )}
                  {p.method === 'installment' && (p.merchant_provider || p.installment_months) && (
                    <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                      {p.merchant_provider ? `${p.merchant_provider} · ` : ''}
                      {p.installment_months ? `${p.installment_months}m` : ''}
                    </span>
                  )}
                  {/* NO approval code here — desktop renders it in its own
                      "Approval Code" COLUMN below. Mobile's PaymentInfoBlock
                      does print it inline, and that is correct FOR MOBILE: the
                      card has no columns. Copying that cell here for "parity"
                      is what printed the same field twice in one row. Parity is
                      the VALUE, not the placement. */}
                </span>
                <span className={paymentsStyles.cellRight} data-label="Amount"
                      style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                  {fmtAmt(p.amount_sen)}
                </span>
                <span className={paymentsStyles.cell} data-label="Account Sheet">
                  {p.account_sheet ?? <span className={detailStyles.muted}>—</span>}
                </span>
                <span className={paymentsStyles.cell} data-label="Approval Code" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {p.approval_code ?? <span className={detailStyles.muted}>—</span>}
                </span>
                {showSlip && (
                  <span className={paymentsStyles.cell} data-label="Slip"
                        style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                    {isSaved ? (
                      <PaymentSlipThumb
                        docNo={(props as SavedModeProps).docNo}
                        payment={p}
                        orderSlipUrl={slipUrl}
                        orderSlipType={slipType}
                      />
                    ) : (
                      <span className={detailStyles.muted}>—</span>
                    )}
                    {/* Attach the proof AFTER the fact (owner 2026-08-07). Until
                        now the slip could only ride along with the INSERT, so a
                        balance collected before its receipt reached the office
                        had no route back to its own proof. Deliberately NOT
                        gated by rowMutable: the same-day window guards the
                        MONEY (amount / method / date), and this touches none of
                        it — a slip that turns up on a later day is exactly the
                        case this exists for. `locked` still applies, so it only
                        shows once the operator has opted into payment edits. */}
                    {isSaved && !locked && (
                      <SlipUploadField
                        key={p.slip_key ?? 'none'}
                        required={false}
                        disabled={attachSlip.isPending}
                        onConfirmed={(sid) => attachSlipToPayment(p, sid)}
                        onCleared={() => {}}
                      />
                    )}
                  </span>
                )}
                <span className={paymentsStyles.cell} data-label="Collected By">
                  {p.collected_by_name ?? staffNameById(p.collected_by) ?? <span className={detailStyles.muted}>—</span>}
                </span>
                <span className={paymentsStyles.cell}>
                  {receiptFor && (
                    <button
                      type="button"
                      onClick={() => void printReceipt(p.id)}
                      disabled={receiptBusy === p.id}
                      title="Print official receipt"
                      style={{
                        background: 'transparent', border: 'none', padding: 4,
                        cursor: 'pointer', color: 'var(--fg-muted)',
                      }}
                    >
                      <Printer size={14} strokeWidth={1.75} />
                    </button>
                  )}
                  {!locked && (
                    <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end', alignItems: 'center' }}>
                      {/* Same-day EDIT (owner 2026-07-13) — only for a payment
                          recorded today; after MYT midnight it locks (no pencil).
                          A DRAFT SO (draftUnlocked) is never same-day-locked, so
                          every persisted row keeps its pencil while unconfirmed. */}
                      {rowMutable(p.created_at) && (
                        <button
                          type="button"
                          disabled={editPayment.isPending}
                          onClick={() => beginEditPersisted(p)}
                          title="Edit payment (same-day only)"
                          style={{
                            background: 'transparent', border: 'none', padding: 4,
                            cursor: 'pointer', color: 'var(--fg-muted)',
                          }}
                        >
                          <Pencil size={14} strokeWidth={1.75} />
                        </button>
                      )}
                      {/* Same-day DELETE (owner 2026-07-19) — "删除只有在当天才行".
                          The control is genuinely ABSENT once the window closes,
                          not disabled and not CSS-hidden. The server refuses too
                          (409 payment_edit_locked); this is the courtesy, that is
                          the control. Before this, delete had NO time gate at all
                          while the pencil beside it did — so a months-old payment
                          on a delivered, invoiced SO could be hard-deleted,
                          silently flipping the order from PAID back to owing. */}
                      {rowMutable(p.created_at) && (
                        <button
                          type="button"
                          className={paymentsStyles.trashBtn}
                          disabled={deletePayment.isPending}
                          onClick={async () => {
                            if (await askConfirm({
                              title: `Delete this ${methodDisplay(p)} payment of ${fmtRm(p.amount_sen, currency)}?`,
                              body: 'This removes the payment from the order, so the balance owing goes back up. It cannot be undone.',
                              confirmLabel: 'Delete',
                              danger: true,
                            })) {
                              deletePayment.mutate({ docNo: (props as SavedModeProps).docNo, id: p.id, version: p.version });
                            }
                          }}
                          title="Remove payment (same-day only)"
                        >
                          <Trash2 size={14} strokeWidth={1.75} />
                        </button>
                      )}
                    </div>
                  )}
                </span>
              </div>
            ))}

            {/* In-flight draft rows (SAVED + DRAFT).

                These are NOT payments yet. Nothing in the row used to say so:
                it sat flush with the persisted rows above it, in the same
                columns, and its only tell was a 14px 💾 glyph at the far right.
                An operator filled one in, attached the slip, saw the uploader's
                green tick and left — RM 6,400 never booked, slip orphaned in R2
                (owner 2026-08-07, live on prod). The row now says what it is,
                in words, in the reading position, and carries a Save button
                with a label. */}
            {drafts.map((d) => (
              <div className={paymentsStyles.row} key={d.uid}>
                <span className={`${paymentsStyles.cell} ${unsavedCls}`} data-label="Date"
                      style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }}>
                  {/* Only meaningful in SAVED mode: a DRAFT-mode caller (New SO
                      / DO / SI) batches every row on the page's own Save, so
                      there is no per-row commit to miss and the pill would be
                      noise on a page where EVERY row is unsaved. */}
                  {isSaved && (
                    <span className={paymentsStyles.unsavedPill}>Unsaved</span>
                  )}
                  <DateField
                    fullWidth
                    className={paymentsStyles.inlineInput}
                    value={d.paidAt ?? ''}
                    disabled={locked}
                    onChange={(iso) => patchDraft(d.uid, { paidAt: iso })}
                  />
                </span>
                <span className={`${paymentsStyles.cell} ${unsavedCls}`} data-label="Method" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
                  {/* L1 — Method (always visible) */}
                  <select
                    className={paymentsStyles.inlineSelect}
                    value={d.methodLabel}
                    disabled={locked}
                    onChange={(e) => {
                      /* When Method changes, clear the L2 fields that
                         don't apply to the new pick. Keeps stale data
                         out of the API call + the audit log. */
                      const next = e.target.value;
                      patchDraft(d.uid, {
                        methodLabel: next,
                        /* Bank applies to Merchant AND Installment now (owner
                           2026-07-19) — preserve it across a switch between the
                           two, clear it for Online / Cash. */
                        merchantProvider:       next === 'Merchant' || next === 'Installment'
                          ? d.merchantProvider : '',
                        installmentMonthsLabel: next === 'Merchant' || next === 'Installment'
                          ? d.installmentMonthsLabel : '',
                        onlineType:             next === 'Online'   ? d.onlineType       : '',
                      });
                    }}
                  >
                    {methodOpts.map((m) => (
                      <option key={m.id} value={m.value}>{m.label}</option>
                    ))}
                    {/* Persist labels that are no longer active in the
                        list so existing drafts (rehydrated from
                        somewhere) still render their selection. */}
                    {d.methodLabel && !methodOpts.some((m) => m.value === d.methodLabel) && (
                      <option value={d.methodLabel}>{d.methodLabel}</option>
                    )}
                  </select>

                  {/* L2 — Merchant cascade: pick the Bank + Installment plan. */}
                  {d.methodLabel === 'Merchant' && (
                    <>
                      <select
                        className={paymentsStyles.inlineSelect}
                        style={{ fontSize: 'var(--fs-11)' }}
                        value={d.merchantProvider}
                        disabled={locked}
                        onChange={(e) => patchDraft(d.uid, { merchantProvider: e.target.value })}
                        aria-label="Merchant bank"
                      >
                        <option value="">— Bank —</option>
                        {merchantOpts.map((m) => (
                          <option key={m.id} value={m.value}>{m.label}</option>
                        ))}
                        {d.merchantProvider && !merchantOpts.some((m) => m.value === d.merchantProvider) && (
                          <option value={d.merchantProvider}>{d.merchantProvider}</option>
                        )}
                      </select>
                      <select
                        className={paymentsStyles.inlineSelect}
                        style={{ fontSize: 'var(--fs-11)' }}
                        value={d.installmentMonthsLabel}
                        disabled={locked}
                        onChange={(e) => patchDraft(d.uid, { installmentMonthsLabel: e.target.value })}
                        aria-label="Installment plan"
                      >
                        <option value="">— Plan —</option>
                        {installmentOpts.map((m) => (
                          <option key={m.id} value={m.value}>{m.label}</option>
                        ))}
                        {d.installmentMonthsLabel && !installmentOpts.some((m) => m.value === d.installmentMonthsLabel) && (
                          <option value={d.installmentMonthsLabel}>{d.installmentMonthsLabel}</option>
                        )}
                      </select>
                    </>
                  )}

                  {/* L2 — Online cascade: pick the sub-type. */}
                  {d.methodLabel === 'Online' && (
                    <select
                      className={paymentsStyles.inlineSelect}
                      style={{ fontSize: 'var(--fs-11)' }}
                      value={d.onlineType}
                      disabled={locked}
                      onChange={(e) => patchDraft(d.uid, { onlineType: e.target.value })}
                      aria-label="Online sub-type"
                    >
                      <option value="">— Type —</option>
                      {onlineOpts.map((o) => (
                        <option key={o.id} value={o.value}>{o.label}</option>
                      ))}
                      {d.onlineType && !onlineOpts.some((o) => o.value === d.onlineType) && (
                        <option value={d.onlineType}>{d.onlineType}</option>
                      )}
                    </select>
                  )}

                  {/* L2 — Installment cascade: pick the Bank + the plan (term).
                      Bank added 2026-07-19 (owner: "Installment 要能选银行的") — the
                      same picker/source Merchant uses (payment_merchant), since the
                      bank drives the EPP/installment fee. Optional (no gate), so a
                      bank-less installment still books (backend derives 'Card
                      terminal' for the Account Sheet). */}
                  {d.methodLabel === 'Installment' && (
                    <>
                      <select
                        className={paymentsStyles.inlineSelect}
                        style={{ fontSize: 'var(--fs-11)' }}
                        value={d.merchantProvider}
                        disabled={locked}
                        onChange={(e) => patchDraft(d.uid, { merchantProvider: e.target.value })}
                        aria-label="Installment bank"
                      >
                        <option value="">— Bank —</option>
                        {merchantOpts.map((m) => (
                          <option key={m.id} value={m.value}>{m.label}</option>
                        ))}
                        {d.merchantProvider && !merchantOpts.some((m) => m.value === d.merchantProvider) && (
                          <option value={d.merchantProvider}>{d.merchantProvider}</option>
                        )}
                      </select>
                      <select
                        className={paymentsStyles.inlineSelect}
                        style={{ fontSize: 'var(--fs-11)' }}
                        value={d.installmentMonthsLabel}
                        disabled={locked}
                        onChange={(e) => patchDraft(d.uid, { installmentMonthsLabel: e.target.value })}
                        aria-label="Installment plan"
                      >
                        <option value="">— Plan —</option>
                        {installmentOpts.map((m) => (
                          <option key={m.id} value={m.value}>{m.label}</option>
                        ))}
                        {d.installmentMonthsLabel && !installmentOpts.some((m) => m.value === d.installmentMonthsLabel) && (
                          <option value={d.installmentMonthsLabel}>{d.installmentMonthsLabel}</option>
                        )}
                      </select>
                    </>
                  )}

                  {/* L2 — Cash: no extra fields */}
                </span>
                <span className={`${paymentsStyles.cellRight} ${unsavedCls}`} data-label="Amount">
                  <MoneyInput
                    bare allowBlank
                    valueSen={d.amountSen === 0 ? null : d.amountSen}
                    inputClassName={paymentsStyles.inlineInputRight}
                    placeholder="0"
                    disabled={locked}
                    onCommit={(sen) => patchDraft(d.uid, { amountSen: sen ?? 0 })}
                  />
                </span>
                <span className={`${paymentsStyles.cell} ${unsavedCls}`} data-label="Account Sheet">
                  <input
                    type="text"
                    className={`${paymentsStyles.inlineInput} ${paymentsStyles.placeholderHint}`}
                    placeholder="e.g. AKHC 3809"
                    value={d.accountSheet}
                    disabled={locked}
                    onChange={(e) => patchDraft(d.uid, { accountSheet: e.target.value })}
                  />
                </span>
                <span className={`${paymentsStyles.cell} ${unsavedCls}`} data-label="Approval Code">
                  <input
                    type="text"
                    className={paymentsStyles.inlineInput}
                    value={d.approvalCode}
                    disabled={locked}
                    onChange={(e) => patchDraft(d.uid, { approvalCode: e.target.value })}
                  />
                </span>
                {showSlip && (
                  <span className={`${paymentsStyles.cell} ${unsavedCls}`} data-label="Slip">
                    {/* Edit mode — show the EXISTING attached slip (the persisted
                        row is hidden while its edit draft is open, so its Slip
                        thumbnail would otherwise disappear). Reuses the same
                        PaymentSlipThumb the read-view row renders. View-only; an
                        edit never changes the slip. */}
                    {(() => {
                      const editedRow = d.editingPersistedId
                        ? persistedPayments.find((p) => p.id === d.editingPersistedId)
                        : undefined;
                      return editedRow ? (
                        <div style={{ marginBottom: 4 }}>
                          <PaymentSlipThumb
                            docNo={(props as SavedModeProps).docNo}
                            payment={editedRow}
                            orderSlipUrl={slipUrl}
                            orderSlipType={slipType}
                          />
                        </div>
                      ) : null;
                    })()}
                    {/* Owner 2026-07-13 — per-payment slip uploader is OPTIONAL
                        now (a receipt isn't always available); commit no longer
                        waits on it. Still offered for when one IS on hand. */}
                    <SlipUploadField
                      required={false}
                      disabled={locked}
                      onConfirmed={(sid) => patchDraft(d.uid, { slipUploadSessionId: sid })}
                      onCleared={() => patchDraft(d.uid, { slipUploadSessionId: null })}
                      onImageScan={(file) => scanReceiptIntoRow(d.uid, file)}
                    />
                  </span>
                )}
                <span className={`${paymentsStyles.cell} ${unsavedCls}`} data-label="Collected By">
                  <select
                    className={paymentsStyles.inlineInputUser}
                    value={d.collectedBy}
                    disabled={locked}
                    onChange={(e) => patchDraft(d.uid, { collectedBy: e.target.value })}
                  >
                    <option value="">—</option>
                    {(() => {
                      const allowed = props.collectedByAllowedIds;
                      const active = pickableStaff; // already active + company-scoped
                      const filtered = allowed
                        ? active.filter((s) =>
                            allowed.has(s.id) ||
                            s.id === d.collectedBy ||
                            s.id === defaultStaffId,
                          )
                        : active;
                      return sortByText(filtered).map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ));
                    })()}
                  </select>
                </span>
                <span className={`${paymentsStyles.cell} ${unsavedCls}`}>
                  <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end', alignItems: 'center' }}>
                    {/* DRAFT mode slip uploader — opt-in via slipUpload prop.
                        Only the SO-route batching page (SalesOrderNew) sets
                        slipUpload; DO / SI / consignment pages do NOT, so their
                        tables render no uploader (the endpoint doesn't accept
                        one). NOT required-marked: the slip is optional on the
                        new-SO path too (Owner 2026-08-13), so the asterisk went
                        with the rule — the SAVED-mode uploader above has never
                        carried one since 2026-07-13. */}
                    {!isSaved && (props as DraftModeProps).slipUpload && (
                      <SlipUploadField
                        required={false}
                        disabled={locked}
                        onConfirmed={(sid) => patchDraft(d.uid, { slipUploadSessionId: sid })}
                        onCleared={() => patchDraft(d.uid, { slipUploadSessionId: null })}
                        onImageScan={(file) => scanReceiptIntoRow(d.uid, file)}
                      />
                    )}
                    {/* SAVED mode shows the Save (commit) button next to
                        Discard. DRAFT mode has no Save — the parent batches
                        all drafts on SO-create. We still show Discard so the
                        user can drop a half-typed row. */}
                    {isSaved && (() => {
                      /* Owner 2026-07-13 — commit needs an amount > 0 (slip is
                         optional now). Spec 1 — a chosen method also needs its
                         required sub-field(s). */
                      const noAmount = d.amountSen <= 0;
                      const missing  = missingMethodSubField(d);
                      const blocked  = noAmount || missing !== null;
                      const title = noAmount
                        ? 'Enter an amount > 0 first'
                        : missing
                          ? `Pick the ${missing} for this ${d.methodLabel} payment first`
                          : d.editingPersistedId ? 'Save changes' : 'Save payment';
                      /* A LABELLED button, not a bare glyph — see the note on
                         the drafts block. `title` still carries the reason the
                         button is unavailable, which a label cannot. */
                      return (
                        <button
                          type="button"
                          className={paymentsStyles.saveBtn}
                          onClick={() => commitDraft(d)}
                          disabled={locked || addPayment.isPending || blocked}
                          title={title}
                        >
                          <Save size={13} strokeWidth={1.75} />
                          {addPayment.isPending ? 'Saving…' : 'Save'}
                        </button>
                      );
                    })()}
                    <button
                      type="button"
                      className={paymentsStyles.trashBtn}
                      onClick={() => removeDraft(d.uid)}
                      title="Discard"
                      disabled={locked}
                    >
                      <Trash2 size={14} strokeWidth={1.75} />
                    </button>
                    {/* DRAFT-mode rows seeded from PERSISTED payments (uid =
                        API row id — the SI detail) can hand over their OR.
                        NOT gated by `locked`: printing changes nothing. */}
                    {receiptFor?.persistedIds?.has(d.uid) === true && (
                      <button
                        type="button"
                        onClick={() => void printReceipt(d.uid)}
                        disabled={receiptBusy === d.uid}
                        title="Print official receipt"
                        style={{
                          background: 'transparent', border: 'none', padding: 4,
                          cursor: 'pointer', color: 'var(--fg-muted)',
                        }}
                      >
                        <Printer size={14} strokeWidth={1.75} />
                      </button>
                    )}
                  </div>
                </span>
              </div>
            ))}
          </div>
          </div>

          {/* ── Summary (Deposit Paid + Balance) ────────────────────── */}
          <div className={paymentsStyles.summary}>
            <span className={paymentsStyles.summaryLabel}>
              Deposit Paid <DollarSign size={12} strokeWidth={1.75} />
            </span>
            <span className={paymentsStyles.summaryValueAccent}>
              {fmtRm(paidSen, currency)}
            </span>
            <span className={paymentsStyles.summaryLabel}>
              Balance <DollarSign size={12} strokeWidth={1.75} />
            </span>
            {/* Three states, not two. `paidSen >= grandTotal` used to print
                "· PAID" — which, once the balance can go negative, would have
                labelled an over-collection as settled and hidden the very
                thing the owner asked to see. */}
            <span
              className={
                balanceSen > 0 ? paymentsStyles.balanceOutstanding
                  : overCollected ? paymentsStyles.balanceCredit
                    : paymentsStyles.balanceClear
              }
            >
              {fmtRm(balanceSen, currency)}
              {overCollected && (
                <span style={{ marginLeft: 8, fontSize: 'var(--fs-11)' }}>· OVER-COLLECTED</span>
              )}
              {!overCollected && grandTotal > 0 && paidSen >= grandTotal && (
                <span style={{ marginLeft: 8, fontSize: 'var(--fs-11)' }}>· PAID</span>
              )}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
};

export const PaymentsTable = memo(PaymentsTableInner) as typeof PaymentsTableInner;
