import { useEffect, useMemo, useRef, useState } from "react";
import { postScanLearningSample, reportScanLearningSkipped } from "../vendor/scm/lib/scan-learning";
import {
  cascadeMasterVariants,
  seedFollowerVariants,
  seedableMasterVariants,
  FABRIC_IDENTITY_KEYS,
  type MasterVariantSnapshot,
} from "../vendor/scm/lib/so-variant-cascade";
import { useQueryClient } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { runSoVersionedMutation } from "../vendor/scm/lib/so-versioned-mutation";
import { notifySaveProblems } from "../vendor/scm/components/SaveProblemsList";
import { uploadSlipFull } from "../vendor/scm/lib/slip";
import { usePickableStaff } from "../vendor/scm/lib/admin-queries";
import { resolveSelfStaff } from "../vendor/scm/lib/self-staff";
import { useAuth, isAdminLevel, isHatchSales } from "../vendor/scm/lib/auth";
import { useAuth as useHouzsAuth } from "../auth/AuthContext";
import { useVenues, type AutoVenue } from "../vendor/scm/lib/venues-queries";
import { useStateWarehouseMappings } from "../vendor/scm/lib/state-warehouse-queries";
import { todayMyt } from "../vendor/scm/lib/dates";
import { paymentMethodCodeForValue } from "../vendor/scm/lib/payment-methods";
import { soDateGuardError, soStockLocationError, soErrorText } from "../vendor/scm/lib/so-form-validate";
import { useBranding } from "../hooks/useBranding";
import { newIdempotencyKey, idempotentInit, useIdempotencyKey } from "../lib/idempotency";
import {
  buildAmendmentHeaderChanges,
  hasAmendmentHeaderChanges,
  withFrozenHeaderFieldsReverted,
} from "../vendor/scm/lib/so-amendment-header";
import { SearchableSelect } from "../vendor/scm/components/SearchableSelect";
import { diffHeaderPayload, hasHeaderChanges } from "../vendor/scm/lib/so-header-diff";
import { planAmendmentSubmit, amendmentSubmittedNotice, AMENDMENT_MODE_BANNER, AMENDMENT_NOTHING_TO_SUBMIT } from "../vendor/scm/lib/so-amendment-submit";
import { LOCKED_STATUSES, procLockActive } from "../vendor/scm/lib/so-detail-gates";
import {
  useSoDropdownOptions,
  optionsOrFallback,
  preferredCustomerTypeValue,
} from "../vendor/scm/lib/so-dropdown-options-queries";
import {
  useLocalities,
  countryForState,
} from "../vendor/scm/lib/localities-queries";
import {
  useAddressCascade,
  pickState,
  pickCity,
  pickPostcode,
  cityPlaceholder,
  postcodePlaceholder,
} from "../vendor/scm/lib/address-cascade";
import { StatePicker } from "../vendor/scm/components/StatePicker";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { usePrompt } from "../vendor/scm/components/PromptDialog";
import { useCreateAmendment, type CreateAmendmentLine } from "../vendor/scm/lib/so-amendment-queries";
import { useCreateMfgSalesOrder } from "../vendor/scm/lib/sales-order-queries";
import { zeroPriceClaim } from "../vendor/scm/lib/zeroPriceClaim";
import { invalidateSoShared } from "./sharedInvalidate";
import { mobileLineAddHeaders } from "./mobile-so-line-save";
import { uploadSoItemPhotoWithLease } from "./mobile-so-concurrency";
import type { ExtractedSlip } from "../vendor/scm/components/ScanOrderModal";
import type { MobileScanPrefill } from "./MobileScan";
import { MobileSkuPicker, type PickedSku } from "./MobileSkuPicker";
import {
  useMaintenanceConfig,
  useSpecialAddons,
  useModelAllowedOptionsByCode,
  useSkuCategoryByCode,
  type MaintenanceConfig,
  type ModelAllowedOptions,
  type SpecialAddonRow,
} from "../vendor/scm/lib/mfg-products-queries";
import { useFabricColoursSearch, type FabricColourRow } from "../vendor/scm/lib/fabric-queries";
/* Owner 2026-07-16 — the recorded-payment ledger is the SHARED
   RecordedPaymentsList, the SAME component the scan-draft review screen
   (MobileSODetail) renders. It was a local read-only copy, which is why
   entering "Edit Draft" REMOVED the pencil + trash the previous screen showed. */
import { RecordedPaymentsList, type RecordedPayment } from "./RecordedPayments";
/* The method ⇒ sub-field cascade rule, imported from the SHARED desktop source
   (PaymentsTable) rather than re-implemented — the same import RecordedPayments
   makes. This screen owns the only OTHER payment editor (the pre-create PayCard
   below), so it is the one surface a rule landing on the shared/detail ledger
   keeps missing (#583, then again in fix/b3-pay). */
import { missingMethodSubField } from "../vendor/scm/components/PaymentsTable";
import { useFabricLibrary } from "../vendor/scm/lib/queries";
import { useDebouncedValue } from "../vendor/scm/lib/hooks";
import { activeOptions, maintPickerValues, restrictPricedToPool, restrictStringsToPool } from "../vendor/shared/maintenance-pools";
import { missingVariantAxes, sofaMixIntroduced, SOFA_MIX_MESSAGE } from "../vendor/shared/so-variant-rule";
import { isColourKiv } from "../vendor/shared/variant-summary";
/* parseInches is imported, not redeclared: this file's private copy also served
   sortNumeric below, and a shared parser serves both readers. */
import { computeTotalHeight, isTotalHeightCategory, parseInches } from "../vendor/shared/total-height";
import { lineIdentity } from "@2990s/shared";
import { normalizePhone } from "../vendor/shared/phone";
import { PhoneInput } from "../vendor/scm/components/PhoneInput";
import "./mobile.css";

/* ---------------------------------------------------------------------------
 * MobileNewSO — mobile New / Edit Sales Order as ONE single scrolling form
 * (owner rejected the 5-step wizard 2026-07-03). Both NEW and EDIT are
 * single-form, one primary action at the bottom.
 *
 * The backend contract this screen is wired to, and the category-aware variant
 * pools (which real hook feeds each axis, the per-SKU allowed_options filter,
 * the sofa follower-line inherit rule) are in docs/modules/sales-order.md under
 * "Mobile New / Edit SO is ONE single scrolling form". They are shared with the
 * desktop SoLineCard, so changing one here without the other is the recurring
 * two-surface bug this repo keeps paying for.
 * ------------------------------------------------------------------------- */

type Mode = "new" | "edit" | "edit-draft";

/* Per-line scan meta — the verbatim slip row, the SKU Claude suggested + its
   confidence, and the itemCode the scan seeded. */
type ScanLineMetaSeed = { rawText: string; suggestedCode: string; confidence: number; seededCode: string; seededName: string };

/* Line category — drives which variant panel shows (matches the desktop
   SoLineCard). Only sofa/bedframe have mandatory variant panels; every other
   group (mattress/accessory/others) is a plain line. */
type LineCat = "" | "sofa" | "bedframe" | "mattress";

type LineItem = {
  key: string;
  /** Stable POST idempotency key for this unsaved line intent. */
  addIdempotencyKey: string;
  itemCode: string;
  itemGroup: string;
  itemId: string;
  name: string;
  qty: string;
  price: string; // RM, as typed — display/default only; server recomputes
  /* Typed into the price box? Tells a deliberate RM 0 from an unpriced SKU.
     Client-only like overriddenKeys; sent as `zeroPriceIntended`, not stored. */
  priceAuthored: boolean;
  ddate: string; // per-line delivery date (ISO yyyy-mm-dd)
  remark: string;
  cat: LineCat;
  /* variants — the canonical variant blob, SAME keys the desktop SoLineCard /
     POST /mfg-sales-orders write. */
  variants: Record<string, unknown>;
  /* PR #147 parity — client-only set of variant keys this line was MANUALLY
     edited for. The master-follower cascade leaves an overridden key alone. */
  overriddenKeys: string[];
  /* Per-line photos. Already-saved R2 object keys (edit prefill) + staged File
     objects (uploaded against the itemId after the SO/items save, mirroring the
     desktop pendingPhotoFiles drain). */
  photoKeys: string[];
  photoFiles: File[];
};

type Payment = {
  /** React list key. NOT usable as an idempotency key: uid() is 8 base36
   *  chars and carries no money semantics. */
  key: string;
  /** Money idempotency key — minted ONCE per payment row and reused by every
   *  retry of that row, so a re-submitted create cannot book it twice.
   *  recordNewPayments has two call sites and the rows survive a failed
   *  submit, which is exactly the double-fire this closes. */
  idempotencyKey: string;
  method: string; // Cash / Merchant / Online / Installment
  date: string;
  amount: string; // RM as typed
  account: string; // account sheet ref
  approval: string; // approval code
  collectedBy: string; // staff.id (uuid) | ""
  // Method-aware sub-fields
  bank: string; // Merchant provider
  plan: string; // Merchant / Installment plan
  online: string; // Online sub-type
  // Slip capture
  slipName: string;
  slipSession: string;
  slipPhase: "" | "uploading" | "done" | "error";
};

// Existing (prefill) shapes — raw snake_case columns from the detail endpoints.
type SoHeader = {
  doc_no: string;
  /* Optimistic-lock token (migration 0153) — loaded here and echoed back on the
     edit-mode header PATCH so a concurrent editor's Save can't silently overwrite
     this one (WO-8). */
  version: number;
  debtor_name: string | null;
  status: string | null;
  /* The staff row this order is credited to. Served by the detail route and read
     by MobileSODetail already; this form was typed without it, which is part of
     why it never seeded the picker. */
  salesperson_id: string | number | null;
  phone: string | null;
  email: string | null;
  ref: string | null;
  customer_so_no: string | null;
  customer_type: string | null;
  building_type: string | null;
  venue: string | null;
  venue_id?: string | null;
  venueId?: string | null;
  sales_location?: string | null;
  note: string | null;
  address1: string | null;
  address2: string | null;
  customer_state: string | null;
  city: string | null;
  postcode: string | null;
  processing_date: string | null;
  customer_delivery_date: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
};
type SoItem = {
  id: string;
  description: string | null;
  item_code: string | null;
  item_group: string | null;
  qty: number | null;
  unit_price_sen: number | null;
  discount_sen: number | null;
  line_delivery_date: string | null;
  remark: string | null;
  variants: Record<string, unknown> | null;
  /* Saved per-line photo R2 object keys — dual-read camelCase / snake_case
     (the pg driver camelCases result columns; the API may expose either). */
  photo_urls?: string[] | null;
  photoUrls?: string[] | null;
  cancelled: boolean | null;
};
type DetailResp = {
  salesOrder: SoHeader & {
    has_children?: boolean | null;
    status?: string | null;
    /* SO-amendment gate flags (Phase 1-C, read-only) — the GET /:docNo endpoint
       derives these (backend mfg-sales-orders.ts). amendment_eligible = the SO
       is processing-locked (already PO'd to the supplier) but not hard-locked by
       a DO/SI and not terminal, so a line change must go out as an AMENDMENT
       rather than a direct edit. open_amendment is the light summary of any
       in-flight amendment (status NOT IN SENT/REJECTED). Mirrors the desktop
       SalesOrderDetail header flags. */
    amendment_eligible?: boolean | null;
    has_open_amendment?: boolean | null;
    open_amendment?: { id: string; status: string; amendment_no: string } | null;
  };
  items: SoItem[];
};
type SoPayment = {
  id: string;
  paid_at: string | null;
  method: string | null;
  amount_sen: number | null;
  approval_code: string | null;
  account_sheet: string | null;
  collected_by_name: string | null;
  /* Owner 2026-07-13 — the recorded-payment row now renders through the shared
     PaymentInfoBlock (parity with the confirmed SO detail), which surfaces the
     merchant bank / installment tenure / online type. GET /:docNo/payments
     already returns these; carry them so the draft-edit view shows them too.
     Dual-read camelCase ?? snake_case (postgres.js / PostgREST casing drift). */
  merchant_provider?: string | null;
  installment_months?: number | null;
  online_type?: string | null;
  merchantProvider?: string | null;
  installmentMonths?: number | null;
  onlineType?: string | null;
  /* Owner 2026-07-16 — the recorded rows are now EDITABLE here (shared
     RecordedPaymentsList), so carry the columns the ledger row needs: the slip
     thumbnail, the same-day EDIT lock instant, and the Collected By the edit
     sheet rehydrates. GET /:docNo/payments already returns all three. */
  collected_by?: string | null;
  slip_key?: string | null;
  slipKey?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
};
type PaymentsResp = { payments: SoPayment[] };

/* FIX A — the interactive form sources Customer Type / Building Type /
   Relationship / State / City / Postcode from the SAME real hooks the desktop
   SalesOrderNew reads (useSoDropdownOptions + useLocalities); see the component
   body. The scan prefill's customer/building type + state no longer need a
   static allowlist here: the SHARED reconciler (vendor/scm/lib/scan-prefill) has
   already snapped those against the LIVE catalog before the value reaches this
   file, so both the interactive seed and the headless createDraftFromPrefill
   trust the reconciled value. The payment METHOD joined that rule 2026-08-20:
   a PAY_METHODS list from the static FALLBACK_OPTIONS re-checked a value that
   reconcilePayment had ALREADY snapped against the live catalog (scan-prefill.ts:
   snapValue returns null, never a bad method). It dropped nothing while that list
   was a superset, and was one edit from silently blanking a scanned method — the
   re-guard this paragraph records removing for customer type. */
const LINE_CATS: Array<{ value: LineCat; label: string }> = [
  { value: "", label: "General item" },
  { value: "sofa", label: "Sofa" },
  { value: "bedframe", label: "Bedframe" },
  { value: "mattress", label: "Mattress" },
];
/* The BANK_OPTS / PLAN_OPTS / ONLINE_OPTS lists that used to live here existed
   ONLY to seed a new payment row's L2 picks, which is exactly what invented a
   bank nobody chose. The picks now seed blank (newPayment) and PayCard renders
   the LIVE catalog via useSoDropdownOptions/optionsOrFallback, so there is no
   remaining reader — and no static list left to drift from the DB values. */

const uid = () => Math.random().toString(36).slice(2, 10);
const num = (s: string) => parseFloat(String(s).replace(/,/g, "")) || 0;
const toSen = (s: string) => Math.round(num(s) * 100);
// centi → a BARE editable ringgit string ("1,234.56") for seeding the price/amount
// form fields. NOT a display formatter — it must stay prefix-free so num()/toSen
// can parse it back. Display money uses the shared fmtSen() instead.
const fromSen = (c: number | null | undefined) =>
  ((c ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (n: number) => n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/* Fabric-identity variant keys a colour pick writes (FabricPicker.onPick /
   SoLineCard.pickFabricColour). Colour auto-sync mirrors exactly these across
   the compartments of one sofa. */
const FABRIC_SYNC_KEYS: readonly string[] = FABRIC_IDENTITY_KEYS;

/* Mobile renders variant panels for sofa + bedframe only, so the cascade is
   scoped to those. Desktop passes null (every category). */
const MOBILE_CASCADE_CATEGORIES: ReadonlySet<string> = new Set(["sofa", "bedframe"]);

function newLine(): LineItem {
  return {
    key: uid(), addIdempotencyKey: newIdempotencyKey(), itemCode: "", itemGroup: "", itemId: "",
    name: "", qty: "1", price: "0.00", ddate: "", remark: "", cat: "", priceAuthored: false,
    variants: {}, overriddenKeys: [], photoKeys: [], photoFiles: [],
  };
}

/* item_group (catalog category, lowercase) → the line's `cat` axis. */
function catForGroup(group: string | null | undefined): LineCat {
  const g = (group ?? "").toLowerCase();
  return g === "sofa" ? "sofa" : g === "bedframe" ? "bedframe" : g === "mattress" ? "mattress" : "";
}

const isBlankVar = (v: unknown): boolean =>
  v === undefined || v === null || String(v).trim() === "";

/* The sofa Leg Height "Default" option (RM 0.00) from the maintenance
   sofaLegHeights pool, matched case-insensitively by name (owner 2026-07-13).
   Seeds a sofa line's Leg Height so it is never an empty required field and
   never blocks Confirm. null when the pool has no such option. */
const DEFAULT_SOFA_LEG_RE = /^\s*default\s*$/i;
function defaultSofaLegValue(maint: MaintenanceConfig | null | undefined): string | null {
  for (const e of (maint?.sofaLegHeights ?? [])) {
    const val = typeof e === "string" ? e : String((e as { value?: unknown })?.value ?? "");
    if (DEFAULT_SOFA_LEG_RE.test(val)) return val;
  }
  return null;
}

/* Build a line's outgoing `variants` blob for the create/edit body. We fold in
   the remark + a fresh computed totalHeight for bedframes (kept for the backend
   even though the readout is hidden).

   THE TOTAL HEIGHT IS ASSIGNED UNCONDITIONALLY NOW. This function used to say
   `if (th > 0) variants.totalHeight = …`, which was a third answer to "what is
   written when divan/leg/gap are blank" — it both left a STALE height on a line
   whose parts were cleared (the blob is spread from l.variants, so the old
   number survived) and omitted the key on a fresh line. Writing '' matches the
   fourteen purchasing screens; '' and an absent key are interchangeable to
   every consumer (computeVariantKey drops empty axes, the pricing lookups and
   the allowed-options gate all short-circuit on a falsy value), so the only
   thing that changes is that a cleared spec now actually clears. */
function buildVariants(l: LineItem): Record<string, unknown> {
  const variants: Record<string, unknown> = { ...(l.variants ?? {}) };
  if (l.remark.trim()) variants.remark = l.remark.trim();
  else delete variants.remark;
  if (isTotalHeightCategory(l.cat)) variants.totalHeight = computeTotalHeight(l.cat, variants);
  return variants;
}

/* Line-item body for POST /:docNo/items and the create body's items[]. Pure +
   module-level so BOTH the interactive save() and the headless
   createDraftFromPrefill() below shape a line identically (no copy-paste). */
function buildItemBody(l: LineItem): Record<string, unknown> {
  const variants = buildVariants(l);
  return {
    itemCode: l.itemCode,
    itemGroup: l.itemGroup || "others",
    /* Owner 2026-08-08 ("square pillow", HC-SO-2607-013) — an UNPICKED line
       must NOT borrow free text (the raw slip transcription) as its
       description; the backend now refuses that shape outright. A picked line
       carries its SKU name; an unpicked one goes out as the CLEAN "Pick a
       product…" placeholder (desktop scan rule, owner 2026-07-13 — the slip
       photo on the SO detail is the operator's reference). Interactive saves
       never reach here unpicked (the save() guard blocks them); this is the
       headless scan-draft path. */
    description: l.itemCode.trim() ? l.name.trim() : "",
    qty: num(l.qty) || 1,
    unitPriceSen: toSen(l.price),
    /* Create items[] AND POST /:docNo/items: a TYPED 0 is free, an untouched 0 is unpriced. */
    ...zeroPriceClaim(toSen(l.price), l.priceAuthored === true),
    lineDeliveryDate: l.ddate || null,
    ...(Object.keys(variants).length ? { variants } : {}),
  };
}

/* ── Headless draft-create from a scan prefill ───────────────────────────────
   The owner wants "OCR 了直接進 SO draft 做": after scanning, a DRAFT SO should
   be created in the background WITHOUT the operator reviewing the form, and it
   must survive the operator navigating away / pressing Cancel.

   This is the SAME create call the interactive form fires on "Save draft":
   POST /mfg-sales-orders with the dates left null AND asDraft: true (the
   backend statuses on body.asDraft === true — empty dates alone do NOT make a
   DRAFT). We deliberately REUSE the pure body-shaping (newLine seeding + the
   module-level buildItemBody, identical to the interactive path) instead of
   duplicating it, and we DO NOT touch the backend's honest-pricing recompute —
   the server mints the doc_no and prices exactly as it does for a hand-saved
   draft.

   What a headless draft intentionally omits vs. the interactive save: venue /
   salesLocation resolution (those come from live hooks — active-venue, staff,
   state→warehouse — that only exist inside the mounted form) AND slip-backed
   payments (those are recorded only after the SO exists, from uploaded slip
   sessions the mounted form owns). A DRAFT is a skeleton the operator opens and
   reviews later, where the venue auto-fill, variant panels and payment capture
   run normally; omitting them here is safe because venueId is optional on the
   create body and the draft carries no delivery dates or payments yet.

   Returns the minted docNo. Throws on failure so the caller can show a plain-
   language notify (it never leaves a phantom — a failed POST creates nothing).

   `idempotencyKey` is OPTIONAL and belongs to the CALLER, not to this function:
   headless code has no mount to hang an intent on, and minting one here would
   mint a fresh key per invocation — stable for nothing, since this function is
   called exactly once per draft. The caller owns the scanned-order object that
   IS the intent and mints the key onto it (MobileScan.tsx), so a re-submit of
   the same scanned order replays instead of raising a second draft. Omitted →
   the middleware no-ops, i.e. exactly today's behaviour. */
export async function createDraftFromPrefill(prefill: MobileScanPrefill, idempotencyKey?: string): Promise<string> {
  // Map each scanned line into a minimal LineItem, exactly as the interactive
  // form seeds `lines` from scanPrefill (name / qty / price / remark), then
  // shape it through the shared buildItemBody.
  const lines: LineItem[] = (prefill.lines ?? []).map((l) => ({
    ...newLine(),
    name: l.name,
    qty: l.qty || "1",
    price: l.price || "0.00",
    itemCode: l.itemCode || "",
    remark: l.remark,
  }));
  // Same "named line" filter the interactive create uses — a line counts once it
  // has a name or a matched itemCode (drops blank rows).
  const namedLines = lines.filter((l) => l.name.trim() || l.itemCode.trim());
  const items = namedLines.map((l) => buildItemBody(l));

  // Phone shaping mirrors save(): the prefill carries national digits, the +60
  // prefix is re-attached here (the form's prefix box owns it interactively).
  const phoneOut = normalizePhone(prefill.phone);
  const ecPhoneOut = normalizePhone(prefill.emergencyPhone);

  const body: Record<string, unknown> = {
    customerName: prefill.name.trim(),
    debtorName: prefill.name.trim(),
    customerSoNo: prefill.custRef.trim() || null,
    phone: phoneOut,
    /* The scan prefill's customer/building type + state are already reconciled
       against the LIVE catalog by the SHARED reconciler (MobileScan builds this
       prefill through reconcileScanPrefill), so trust them here rather than
       re-guarding against a stale hardcoded list that would drop a valid value. */
    customerType: prefill.customerType.trim() || null,
    buildingType: prefill.buildingType.trim() || null,
    note: prefill.note.trim() || null,
    address1: prefill.address1.trim() || null,
    customerState: prefill.state.trim() || null,
    city: prefill.city.trim() || null,
    postcode: prefill.postcode.trim() || null,
    // DRAFT: no dates (the interactive "Save draft" nulls these too).
    processingDate: null,
    customerDeliveryDate: null,
    /* EXPLICIT draft flag — the backend statuses the SO on body.asDraft === true
       (mfg-sales-orders.ts POST /), NOT on empty dates. Without it a scanned,
       date-less SO landed CONFIRMED (owner hit this on the legacy scan path). */
    asDraft: true,
    emergencyContactPhone: ecPhoneOut,
    /* Slip + receipt provenance (migrations 0033 / 0034) — the R2 keys
       /scan-so/extract answered with, so the SO detail can show the slip this
       order was read from. Desktop sends the same pair; this path sent neither,
       leaving a phone-scanned order's "Scanned photos" card permanently empty.
       Omitted rather than "" when absent — the handler stores it verbatim. */
    ...(prefill.slipImageKey ? { slipImageKey: prefill.slipImageKey } : {}),
    ...(prefill.receiptImageKey ? { receiptImageKey: prefill.receiptImageKey } : {}),
    items,
  };

  const res = await authedFetch<{ docNo: string }>(`/mfg-sales-orders`,
    idempotentInit(idempotencyKey, { method: "POST", body: JSON.stringify(body) }));
  /* Was `return res?.docNo ?? ""` — flagged by fix/so-idempotency and taken here
     (reference_houzs_nullish_hides_ignorance). The `?? ""` turned "the server
     answered 2xx with a body I don't understand" into a confident empty docNo:
     the ONLY caller is MobileScan's `void createDraftFromPrefill(...).catch(...)`,
     so a "" return silently skipped the .catch and the operator was told nothing
     while their scanned slip produced no order — the same silence this whole PR
     is about. Throwing is not a new contract, it is THIS function's documented
     one ("Throws on failure so the caller can show a plain-language notify"),
     which the `??` quietly broke. */
  if (!res?.docNo) throw new Error("The order was not saved. Scan it again.");
  return res.docNo;
}

/* Map a persisted SoItem (edit prefill) back into an editable LineItem. */
function lineFromItem(it: SoItem): LineItem {
  const base = newLine();
  const v = { ...((it.variants ?? {}) as Record<string, unknown>) };
  const cat = catForGroup(it.item_group);
  return {
    ...base,
    itemId: it.id,
    itemCode: it.item_code ?? "",
    itemGroup: (it.item_group ?? "").toLowerCase(),
    name: it.description ?? it.item_code ?? "",
    qty: String(it.qty ?? 1),
    price: fromSen(it.unit_price_sen),
    priceAuthored: true, // off the persisted row: a 0 IS its price (edit-DRAFT re-creates)
    ddate: (it.line_delivery_date ?? "").slice(0, 10),
    remark: it.remark ?? (typeof v.remark === "string" ? v.remark : ""),
    cat,
    variants: v,
    photoKeys: Array.isArray(it.photoUrls) ? it.photoUrls : Array.isArray(it.photo_urls) ? it.photo_urls : [],
    photoFiles: [],
  };
}
function newPayment(): Payment {
  const today = todayMyt();
  return {
    key: uid(), idempotencyKey: newIdempotencyKey(),
    method: "Cash", date: today, amount: "0.00", account: "", approval: "", collectedBy: "",
    /* The method's L2 picks seed BLANK — desktop parity (newPaymentDraft seeds
       merchantProvider / installmentMonthsLabel / onlineType as ''). Seeding
       BANK_OPTS[0] here INVENTED a bank: a Merchant payment the operator never
       assigned one to was silently booked to "MBB", and the invented value also
       satisfied every guard, so nothing could ever catch it. Same defect, same
       reason, as the one fix/b3-pay removed from the payment detail sheet ("no
       bank is ever invented"); this screen's own editor was missed. */
    bank: "", plan: "", online: "",
    slipName: "", slipSession: "", slipPhase: "",
  };
}

// Payment-row method label → backend enum: use the SHARED map
// (paymentMethodCodeForValue, payment-methods.ts) so desktop + mobile can't
// drift on method codes. "Online" surfaces as the "transfer" code.
// 'One Shot' → null (no installment term); 'N months' → N.
const planToMonths = (label: string): number | null => {
  const m = /^(\d+)\s*month/i.exec(String(label).trim());
  return m ? Number(m[1]) : null;
};

type Opt = { value: string; label: string };
type VariantPools = {
  ready: boolean; // maintenance config loaded (pools meaningful)
  /* Owner #1 scaling pain (2026-07-14): the fabric-colour library is NO LONGER
     preloaded here — the mobile Fabric picker now server-typeaheads via
     useFabricColoursSearch (parity with the desktop FabricColourCombobox), so
     only fabricSeries (fabric_library labels) stays warm for the series display. */
  fabricSeries: Map<string, string>; // fabricId → series label
  maint: MaintenanceConfig | null;
  /* Special Add-ons pool (owner 2026-07-04) — the SAME special_addons defs the
     desktop SoLineCard + server recompute price from. */
  specialAddons: SpecialAddonRow[];
};

export function MobileNewSO({
  mode,
  docNo,
  scanPrefill,
  onBack,
  onSaved,
}: {
  mode: Mode;
  docNo?: string;
  scanPrefill?: MobileScanPrefill;
  onBack: () => void;
  onSaved?: (docNo: string) => void;
}) {
  const qc = useQueryClient();
  const notify = useNotify();
  const confirm = useConfirm();
  const prompt = usePrompt();
  /* SO-amendment CREATE (Phase 1-C) — the SAME vendored mutation the desktop
     SalesOrderDetail.submitAmendment uses (POST /:docNo/amendments). Reused
     verbatim so the mobile amendment-raise carries no re-implemented API logic. */
  const createAmendment = useCreateAmendment();
  /* SO CREATE — the SAME vendored mutation the desktop create path uses, so the
     POST body/route and its shared-key invalidation stay single-sourced. */
  const createSo = useCreateMfgSalesOrder();
  /* One key for the one order this form is open to raise (lib/idempotency.ts).
     MobileApp mounts this screen behind `screen.t === "new-so"` (MobileApp.tsx:
     422) and leaves via onSaved/onBack, so the MOUNT is exactly one order: the
     key is minted once by useState's lazy init (survives every re-render), is
     the same on a re-press after a stalled 4G submit (so the retry REPLAYS the
     first order's docNo instead of raising a second RM3,888 order), and a new
     order means a new mount and a new key — two customers buying the same item
     minutes apart never collide. Unused by the isEdit PATCH branch, which
     addresses one existing docNo and cannot duplicate. */
  const soIdemKey = useIdempotencyKey();
  /* The isEdit branch's amendment submit gets its OWN per-mount key. Same rule
     as soIdemKey: this mount is one amendment intent (it navigates away on
     success), so a retry after a timeout replays the first response instead of
     filing a second amendment — the amendment number is minted `count + 1`, so
     a duplicate is a real one. A separate constant from soIdemKey purely for
     legibility; the two never run on the same mount. */
  const amendIdemKey = useIdempotencyKey();
  /* The payment "Collected By" dropdown + the Salesperson selection both draw
     from the company-scoped, ACTIVE-only pickable set (Team-grant rule), mirroring
     the desktop PaymentsTable/SoLineCard — a resigned or other-company staff must
     not be pickable. A persisted collected_by name is displayed from the row's own
     collected_by_name (PaymentInfoBlock), so no full roster is needed here. */
  // Salesperson picker (owner 2026-07-22) — sales-only, mirrors desktop
  // SalesOrderNew's narrowed dropdown.
  /* The PERSISTED salesperson (edit mode), kept apart from the editable
     `salespersonId`: it is the id the picker must be able to NAME, and feeding
     the live state to `include` would re-key the roster query on every pick. */
  const [origSalespersonId, setOrigSalespersonId] = useState<string>("");
  const pickableStaffQ = usePickableStaff({ onlySales: true, include: [origSalespersonId] });
  const { staff: authStaff } = useAuth();
  /* FIX A — the app-level Houzs auth exposes the permission gate + the signed-in
     user (name/email/id), which the vendor auth bridge doesn't. Drives the
     Salesperson default + the scm.so.attribute_other gate, mirroring desktop
     SalesOrderNew (which reads `can` + `user` from the same context). */
  const { user: currentUser, can } = useHouzsAuth();
  const canChangeSalesperson = can("scm.so.attribute_other");
  /* Remove-Processing-Date gate (Owner 2026-07-09, port of 2990 #717) — clearing
     a SET Processing Date pulls the SO back out of Proceed, so it is admin-level
     only. Same flat permission key the API PATCH enforces (mfg-sales-orders.ts);
     Owner + IT Admin pass via `*`. Desktop SalesOrderDetail reads the identical
     key — one rule, both surfaces. */
  const canRemoveProcessingDate = can("scm.so.remove_processing_date");
  /* Unit Price is LOCKED to the SKU Master sell price for everyone below admin
     (SO-SKU spec D4, Loo 2026-06-05) — the SAME gate the desktop SoLineCard uses
     (lib/auth): admin-level roles (or the temporary POS "hatch" role) may hand-
     type a price; everyone else follows the catalog, and the server recompute is
     authoritative at save. Without this any salesperson could type any price. */
  const canEditPrice = isAdminLevel(authStaff?.role) || isHatchSales(authStaff?.role);
  /* Special-order price DISPLAY is off for EVERYONE on the order-entry documents
     (owner 2026-07-17: costing left the SO/DO/SI forms for the separate Finance
     "Fulfillment Costing" module — even an admin does not see it while opening an
     SO). So the preset "+RM …" surcharges, the option-group amounts, and the
     manual "Extra charge (RM)" field are all hidden — only the special-order NAME
     stays. The server still applies every surcharge; this removes the DISPLAY
     only. Mirrors SoLineCard.tsx:236 (was `isAdminLevel(authStaff?.role)`). */
  const showSpecialPrices = false;
  const isEdit = mode === "edit" || mode === "edit-draft";

  /* FIX A — real DB-backed SO dropdowns (was hardcoded arrays). Same hooks +
     optionsOrFallback the desktop SalesOrderNew uses; the fallback seed keeps the
     selects populated before the API resolves / when the table is empty. */
  const customerTypeOptsQ = useSoDropdownOptions("customer_type");
  const buildingTypeOptsQ = useSoDropdownOptions("building_type");
  const relationshipOptsQ = useSoDropdownOptions("relationship");
  const customerTypeOpts = optionsOrFallback("customer_type", customerTypeOptsQ.data);
  const buildingTypeOpts = optionsOrFallback("building_type", buildingTypeOptsQ.data);
  const relationshipOpts = optionsOrFallback("relationship", relationshipOptsQ.data);

  /* FIX A — cascading State → City → Postcode off my_localities (desktop parity).
     With the empty-localities fallback the cascade collapses to empty selects and
     the State field renders a free-text input instead (the verbatim no-data
     behaviour the vendor slice ships). */
  const locQ = useLocalities();

  /* ── Real variant sources — the SAME hooks the desktop SoLineCard reads. */
  const maintQ = useMaintenanceConfig("master");
  const maint = maintQ.data?.data ?? null;
  const fabricLibQ = useFabricLibrary();
  /* Special Add-ons (owner 2026-07-04) — the mobile line editor now renders a
     Specials accordion (bedframe + sofa), consuming the same pool it used to
     only warm. */
  const specialAddonsQ = useSpecialAddons();

  const pools: VariantPools = useMemo(() => {
    const fabricSeries = new Map<string, string>();
    for (const f of fabricLibQ.data ?? []) fabricSeries.set(f.id, f.label);
    return {
      ready: Boolean(maint),
      fabricSeries,
      maint,
      specialAddons: specialAddonsQ.data ?? [],
    };
  }, [maint, fabricLibQ.data, specialAddonsQ.data]);

  /* One-shot seed derived from the scan handoff (new-from-scan only). */
  const scanLines: Array<{ line: LineItem; meta: ScanLineMetaSeed }> = (scanPrefill?.lines ?? []).map((l) => {
    const line: LineItem = { ...newLine(), name: l.name, qty: l.qty || "1", price: l.price || "0.00", remark: l.remark };
    return { line, meta: { rawText: l.rawText, suggestedCode: l.suggestedCode, confidence: l.confidence, seededCode: l.itemCode, seededName: l.name } };
  });
  const seededLineMeta: Record<string, ScanLineMetaSeed> = {};
  for (const { line, meta } of scanLines) seededLineMeta[line.key] = meta;
  /* Seed ONE payment row per captured payment slip. */
  const scanPaymentSlips = scanPrefill?.payments ?? [];
  const scanSlipFilesInit: Record<string, File> = {};
  const seededPays: Payment[] = scanPaymentSlips.length
    ? scanPaymentSlips.map((ps) => {
        const row: Payment = {
          ...newPayment(),
          method: ps.method,
          amount: ps.amount || "0.00",
          approval: ps.approval ?? "",
          slipName: ps.file.name,
          slipPhase: "uploading",
        };
        scanSlipFilesInit[row.key] = ps.file;
        return row;
      })
    : scanPrefill?.payment
      ? [{ ...newPayment(), method: scanPrefill.payment.method, amount: scanPrefill.payment.amount || "0.00", approval: scanPrefill.payment.approval ?? "" }]
      : [];

  // Customer
  const [name, setName] = useState(scanPrefill?.name ?? "");
  const [custRef, setCustRef] = useState(scanPrefill?.custRef ?? "");
  const [phone, setPhone] = useState(toE164(scanPrefill?.phone));
  const [email, setEmail] = useState("");
  /* Trust the value the SHARED reconciler produced — it already snapped the OCR
     match against the LIVE customer_type catalog (optionsOrFallback), the same
     master this form's dropdown renders. Re-guarding against a stale hardcoded
     list is what silently dropped valid scanned values on mobile; mirror desktop
     (setCustomerType(payload.customerType)) and seed it straight. */
  const [custType, setCustType] = useState(scanPrefill?.customerType ?? "");
  // Salesperson (staff.id). Blank = the backend stamps the logged-in caller.
  const [salespersonId, setSalespersonId] = useState(scanPrefill?.salesperson ?? "");

  // Order info
  // Reconciled against the live building_type catalog — seed it straight (see custType).
  const [buildingType, setBuildingType] = useState(scanPrefill?.buildingType ?? "");
  /* SEEDING NOTE (unchanged by the 2026-08-13 rename, flagged by it): this is
     the Sales Order's PROCESSING DATE (internal_expected_dd, the factory-start
     date), but it is seeded from `slipDate` — the day the rep WROTE the slip.
     Those are different facts. Desktop derives the same field from
     Delivery − 6 weeks and never reads the slip's date.
     LATENT, not live: no `setScreen({t:"new-so"})` call site supplies
     `scanPrefill` (MobileApp.tsx declares it in the union and never passes it),
     and the live mobile scan path is createDraftFromPrefill, which sends
     `processingDate: null` — this comment said `internalExpectedDd: null` until
     2026-08-15, the pre-0286 spelling of a key this file no longer sends under
     that name. The backend still ACCEPTS the legacy key (see
     SO_HEADER_LEGACY_PAYLOAD_KEYS in shared/so-processing-date.ts), so the alias
     is live; what was stale was naming it as the thing WE send.
     Re-wire that handoff and this starts stamping
     factory dates off slip handwriting. Fixing it is a behaviour change, not a
     rename — see docs/modules/scan-to-so.md §2b. */
  const [procDate, setProcDate] = useState(scanPrefill?.slipDate ?? "");
  const [delivDate, setDelivDate] = useState(scanPrefill?.deliveryDate ?? "");
  const [note, setNote] = useState(scanPrefill?.note ?? "");

  // Emergency contact
  const [ecName, setEcName] = useState("");
  const [ecRel, setEcRel] = useState("");
  const [ecPhone, setEcPhone] = useState(toE164(scanPrefill?.emergencyPhone));

  // Delivery address
  const [addr1, setAddr1] = useState(scanPrefill?.address1 ?? "");
  const [addr2, setAddr2] = useState("");
  // Reconciled against the live my_localities state list — seed it straight (see custType).
  const [state, setState] = useState(scanPrefill?.state ?? "");
  const [city, setCity] = useState(scanPrefill?.city ?? "");
  const [postcode, setPostcode] = useState(scanPrefill?.postcode ?? "");

  // Lines + payments
  const [lines, setLines] = useState<LineItem[]>(() =>
    scanLines.length > 0 ? scanLines.map((s) => s.line) : [newLine()],
  );
  const [pays, setPays] = useState<Payment[]>(() => seededPays);
  /* FIX D1(b) — line keys whose Item Delivery Date was MANUALLY changed. The
     header Delivery Date cascades onto every line's ddate, re-syncing when the
     header changes, EXCEPT lines in this set (manual-override-wins — same
     pattern as the sofa variant overriddenKeys inherit already in this file). */
  const [ddateOverrides, setDdateOverrides] = useState<Set<string>>(() => new Set());
  const scanSlipFilesRef = useRef<Record<string, File>>(scanSlipFilesInit);
  const [origItems, setOrigItems] = useState<SoItem[]>([]);
  const [existingPays, setExistingPays] = useState<SoPayment[]>([]);
  /* Re-read the persisted ledger after the shared RecordedPaymentsList edits or
     deletes a row. This screen loads payments with a one-shot authedFetch (not a
     TanStack query), so the list's cache invalidation can't refresh it — pull the
     ledger again from the same endpoint the prefill uses. A failed refresh leaves
     the current rows on screen rather than blanking the card. */
  const reloadExistingPays = async () => {
    if (!docNo) return;
    try {
      const r = await authedFetch<PaymentsResp>(`/mfg-sales-orders/${encodeURIComponent(docNo)}/payments`);
      setExistingPays(r.payments ?? []);
    } catch {
      /* keep what's on screen */
    }
  };
  const [lineLocked, setLineLocked] = useState(false);
  /* SO-amendment flags captured from the detail GET (Phase 1-C). When
     `amendEligible` the SO is processing-locked but still editable via the
     amendment flow — the edit view stays usable and Save submits an AMENDMENT
     instead of writing the lines directly (desktop SalesOrderDetail parity).
     `hasOpenAmend` blocks raising a SECOND amendment while one is in flight. */
  const [amendEligible, setAmendEligible] = useState(false);
  const [hasOpenAmend, setHasOpenAmend] = useState(false);
  /* FIX D2/D3 — the PERSISTED processing date (processing_date) drives the
     processing-date lock. Kept separate from the editable procDate form value so
     the lock reflects what the backend has, not an in-flight edit. */
  const [origProcDate, setOrigProcDate] = useState<string>("");
  /* The PERSISTED delivery date — the pair of origProcDate. Needed for the same
     two reasons: the shared date guard must know which dates this edit actually
     CHANGED (an unchanged past date must not block the save), and the amendment
     needs a before-value for the frozen-field diff. */
  const [origDelivDate, setOrigDelivDate] = useState<string>("");
  /* PERSISTED State / Postcode / City — the other columns the processing lock
     freezes. Needed to diff what an amendment is actually requesting.
     City joined 2026-07-17: this screen already DISABLED City under the lock
     and named it in the lock copy, but City was in neither the backend lock set
     nor the amendment allow-list — so it was simultaneously un-editable here
     and un-requestable by amendment, a dead end with no way out. It is
     CONTROLLED now (see so-field-policy: part of the PO delivery destination,
     same as Postcode) and rides the amendment like the rest. */
  const [origState, setOrigState] = useState<string>("");
  const [origPostcode, setOrigPostcode] = useState<string>("");
  const [origCity, setOrigCity] = useState<string>("");
  // Address lines joined the frozen set 2026-07-27 (two-lane phase 2) — persisted pair for addr1/addr2.
  const [origAddress1, setOrigAddress1] = useState<string>("");
  const [origAddress2, setOrigAddress2] = useState<string>("");
  // Customer info joined 2026-08-21 (DELIVERY lane). phone kept E164 = state seed = pristine baseline.
  const [origContact, setOrigContact] = useState({ debtorName: "", phone: "", email: "" });
  /* PERSISTED SO status — feeds the SHARED procLockActive() so the processing
     lock keeps a DRAFT / CANCELLED SO editable (status guard), matching the
     mobile detail screen + desktop instead of the old status-blind copy. */
  const [soStatus, setSoStatus] = useState<string>("");
  /* Owner 2026-07-16 ("payment draft著的時候為什麼還是不能edit？講了很多次了") — a
     DRAFT SO is never confirmed, so its payments stay fully editable (and are
     never same-day-locked). Same rule as the mobile detail screen + desktop
     SalesOrderDetail; the server matches it too (the PATCH same-day lock exempts
     DRAFT). setSoStatus stores the status upper-cased. */
  const isDraftSo = soStatus === "DRAFT";
  // Prefill venue (edit) — used to seed the manual venue pick.
  /* The header patch this form WOULD have sent the moment prefill finished, if
     the operator changed nothing — the baseline save() diffs against, so an
     untouched field is never sent (mirrors the desktop originalPayloadRef and
     the line path's applyLineDiff). null until prefill lands: no baseline means
     no proof, so save() falls back to sending the whole patch.

     Seeded from the values the form is being seeded WITH, not from a live read,
     so a field the SERVER changed under the operator mid-edit stays undirty and
     Save cannot clobber it with the staler value on screen. The three columns
     the form does not seed — venue_id / venue / sales_location, all re-derived
     from async lookups — take the SERVER's stored value as their baseline
     instead, which is what "did the derivation actually change this column"
     must compare against. */
  const originalHeaderPatchRef = useRef<Record<string, unknown> | null>(null);
  /* Optimistic-lock token the SO was loaded with (WO-8), pinned at edit-seed and
     echoed back on the header PATCH. The mobile editor loads the detail into
     local state ONCE (not via a live query), so this stays the loaded value for
     the whole edit session — a concurrent editor's Save 409s instead of being
     silently overwritten. */
  const loadedVersionRef = useRef<number | undefined>(undefined);
  const activeLineLeaseRef = useRef<string | null>(null);
  const [prefillVenueId, setPrefillVenueId] = useState<string | null>(null);
  const [prefillVenueName, setPrefillVenueName] = useState<string>("");
  // SKU picker sheet — the line key it was opened for, or null when closed.
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  // Fabric picker sheet — the line key it was opened for, or null when closed.
  const [fabricPickerFor, setFabricPickerFor] = useState<string | null>(null);
  // Special-order picker sheet — the line key it was opened for, or null.
  const [specialPickerFor, setSpecialPickerFor] = useState<string | null>(null);

  const [loading, setLoading] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  /* ── Scan-Order review state (scanPrefill only) ───────────────────────── */
  const [scanSampleId] = useState<string | null>(scanPrefill?.sampleId ?? null);
  const [scanSalesperson] = useState<string | null>(scanPrefill?.salesperson ?? null);
  const [scanAiOriginal] = useState<ExtractedSlip | null>(scanPrefill?.aiOriginal ?? null);
  type ScanBaseline = {
    name?: string; custRef?: string; phone?: string;
    custType?: string; buildingType?: string; note?: string;
    procDate?: string; delivDate?: string;
    addr1?: string; state?: string; city?: string; postcode?: string;
  };
  const [scanBaseline] = useState<ScanBaseline | null>(
    scanPrefill
      ? {
          name: scanPrefill.name, custRef: scanPrefill.custRef,
          // Coerced the SAME way the field is seeded. The field holds E.164
          // now, so comparing it against the raw scan string would never match
          // — the "scanned" badge would never light, and worse, the scan-review
          // learning label would call an UNTOUCHED phone "changed" and feed the
          // OCR loop a correction the operator never made.
          phone: toE164(scanPrefill.phone),
          custType: custType, buildingType: buildingType,
          note: scanPrefill.note,
          // Coerced the SAME way procDate is seeded above (from the slip's own
          // date), so the "scanned" badge and the learning diff agree with it.
          procDate: scanPrefill.slipDate, delivDate: scanPrefill.deliveryDate,
          addr1: scanPrefill.address1, state: state,
          city: scanPrefill.city, postcode: scanPrefill.postcode,
        }
      : null,
  );
  const [scanLineMeta] = useState<Record<string, ScanLineMetaSeed>>(seededLineMeta);
  const fromScan = !!scanPrefill;

  // ---- Prefill (edit / edit-draft) -----------------------------------------
  useEffect(() => {
    if (!isEdit || !docNo) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [detail, payResp] = await Promise.all([
          authedFetch<DetailResp>(`/mfg-sales-orders/${encodeURIComponent(docNo)}`),
          /* NO `.catch(() => ({ payments: [] }))` here (removed 2026-07-19).
             This response seeds `existingPays` — what the order has ALREADY been
             paid. Folding a failed read into "no payments" showed the operator an
             edit screen stating this order has never been paid, on the one screen
             whose job is to record a payment: the invitation is to enter the
             deposit a second time. Same class as #653 / #1158 — "the read failed"
             rendered as "nothing was paid".
             The surrounding try/catch already sets the form's `error` state from
             the message authedFetch built via humanApiError, so the failure now
             surfaces as a plain sentence instead of a confident wrong number. */
          authedFetch<PaymentsResp>(`/mfg-sales-orders/${encodeURIComponent(docNo)}/payments`),
        ]);
        if (cancelled) return;
        const h = detail.salesOrder;
        setName(h.debtor_name ?? "");
        setCustRef(h.customer_so_no ?? h.ref ?? "");
        setPhone(toE164(h.phone));
        setEmail(h.email ?? "");
        setCustType(h.customer_type ?? "");
        setBuildingType(h.building_type ?? "");
        setPrefillVenueId(h.venueId ?? h.venue_id ?? null);
        setPrefillVenueName(h.venue ?? "");
        setProcDate((h.processing_date ?? "").slice(0, 10));
        setOrigProcDate((h.processing_date ?? "").slice(0, 10));
        setDelivDate((h.customer_delivery_date ?? "").slice(0, 10));
        setOrigDelivDate((h.customer_delivery_date ?? "").slice(0, 10));
        setNote(h.note ?? "");
        setEcName(h.emergency_contact_name ?? "");
        setEcRel(h.emergency_contact_relationship ?? "");
        setEcPhone(toE164(h.emergency_contact_phone));
        setAddr1(h.address1 ?? "");
        setAddr2(h.address2 ?? "");
        setState(h.customer_state ?? "");
        setCity(h.city ?? "");
        setPostcode(h.postcode ?? "");
        setOrigState(h.customer_state ?? "");
        setOrigPostcode(h.postcode ?? "");
        setOrigCity(h.city ?? "");
        setOrigAddress1(h.address1 ?? "");
        setOrigAddress2(h.address2 ?? "");
        setOrigContact({ debtorName: h.debtor_name ?? "", phone: toE164(h.phone), email: h.email ?? "" });
        /* SEED THE PICKER FROM THE ROW. Owner, 2026-08-05, on an order whose
           salesperson is Pei Fen: "当我点选 ID 的时候，跳出第一个人的时候，他就
           直接变成我的名字了，那么奇怪".
           The form used to leave salespersonId as "" on edit, and "" renders as
           "{me} (me)" — the first option in the picker. So every edit screen
           claimed the order was the CURRENT user's, whoever actually sold it.
           The stored value was safe (an untouched picker sends null and
           salesperson_id is left alone), but the screen said otherwise, and an
           operator "correcting" what they saw would have reassigned a colleague's
           sale to themselves.
           Seeding it means the picker shows the truth. The pristine baseline
           below is seeded to the SAME value, so an untouched picker still diffs
           to {} and still sends nothing. */
        setSalespersonId(h.salesperson_id != null ? String(h.salesperson_id) : "");
        setOrigSalespersonId(h.salesperson_id != null ? String(h.salesperson_id) : "");
        originalHeaderPatchRef.current = soHeaderPatchFrom({
          name: h.debtor_name ?? "",
          custRef: h.customer_so_no ?? h.ref ?? "",
          phone: toE164(h.phone),
          email: h.email ?? "",
          custType: h.customer_type ?? "",
          buildingType: h.building_type ?? "",
          venueId: h.venueId ?? h.venue_id ?? null,
          venueName: h.venue ?? "",
          note: h.note ?? "",
          addr1: h.address1 ?? "",
          addr2: h.address2 ?? "",
          state: h.customer_state ?? "",
          city: h.city ?? "",
          postcode: h.postcode ?? "",
          salesLocation: h.sales_location ?? "",
          procDate: (h.processing_date ?? "").slice(0, 10),
          delivDate: (h.customer_delivery_date ?? "").slice(0, 10),
          ecName: h.emergency_contact_name ?? "",
          ecPhone: toE164(h.emergency_contact_phone),
          ecRel: h.emergency_contact_relationship ?? "",
          /* Matches the seed above, not a hard null: the baseline has to describe
             the form as it now stands, or a form nobody touched reads as dirty. */
          salespersonId: h.salesperson_id != null ? String(h.salesperson_id) : null,
        });
        const liveItems = (detail.items ?? []).filter((it) => !it.cancelled);
        setOrigItems(liveItems);
        const editable = liveItems.map(lineFromItem);
        setLines(editable.length ? editable : [newLine()]);
        /* FIX D1(b) — a prefilled line already carries its persisted Item Delivery
           Date; treat it as a manual override so the header→line cascade never
           stomps a saved per-line date on load. */
        setDdateOverrides(new Set(editable.filter((l) => l.ddate).map((l) => l.key)));
        setExistingPays(payResp.payments ?? []);
        // Pin the version this SO was loaded with (WO-8 optimistic locking).
        loadedVersionRef.current = detail.salesOrder.version;
        const st = (detail.salesOrder.status ?? "").toUpperCase();
        setSoStatus(st);
        setLineLocked(LOCKED_STATUSES.includes(st) || Boolean(detail.salesOrder.has_children));
        /* Amendment gate (server-derived) — the same flags the desktop SO Detail
           routes on. When amendment_eligible the SO is processing-locked but the
           edit view stays usable; Save then submits an amendment (see save()). */
        setAmendEligible(Boolean(detail.salesOrder.amendment_eligible));
        setHasOpenAmend(Boolean(detail.salesOrder.has_open_amendment));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load this order.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isEdit, docNo]);

  /* ── Pre-upload scan-seeded payment slips (new-from-scan only) ─────────── */
  useEffect(() => {
    const files = scanSlipFilesRef.current;
    const keys = Object.keys(files);
    if (keys.length === 0) return;
    scanSlipFilesRef.current = {}; // consume once
    let cancelled = false;
    for (const key of keys) {
      const file = files[key];
      void (async () => {
        try {
          const { uploadSessionId } = await uploadSlipFull({ file });
          if (cancelled) return;
          setPays((prev) => prev.map((p) => (p.key === key ? { ...p, slipSession: uploadSessionId, slipPhase: "done" } : p)));
        } catch {
          if (cancelled) return;
          setPays((prev) => prev.map((p) => (p.key === key ? { ...p, slipPhase: "error" } : p)));
        }
      })();
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Derived Venue / Sales Location (desktop parity) ----------------------
  const venuesQ = useVenues();
  const staffList = useMemo(() => (pickableStaffQ.data ?? []).filter((s) => s.active), [pickableStaffQ.data]);
  const selectedStaff = useMemo(
    () => staffList.find((s) => s.id === salespersonId) ?? null,
    [staffList, salespersonId],
  );

  /* Houzs venue binding (owner 2026-07-19) — the venue this salesperson is
     bound to, resolved server-side by the ONE shared resolver
     (backend scm/lib/venue-binding.ts): their in-period exhibition project if
     they have one, else the showroom they are parked under, else nothing.
     Mobile does NOT re-implement any of that — same endpoint as desktop.
     Declared BEFORE resolvedVenueName so the memo can read it (no TDZ). */
  const [autoVenue, setAutoVenue] = useState<AutoVenue | null>(null);
  useEffect(() => {
    if (isEdit) return; // edit keeps the persisted venue
    let alive = true;
    authedFetch<AutoVenue>(
      "/mfg-sales-orders/active-venue",
    )
      .then((r) => { if (alive) setAutoVenue(r); })
      .catch(() => {});
    return () => { alive = false; };
  }, [isEdit]);

  /* Venue derives from the picked salesperson's staff.venue_id (falls back to
     the auth user's own venue, the persisted venue on edit, or the active
     project's venue). Mirrors SalesOrderNew resolvedVenue*. */
  const resolvedVenueId: string | null =
    prefillVenueId ?? selectedStaff?.venueId ?? authStaff?.venueId ?? autoVenue?.venueId ?? null;
  const resolvedVenueName: string = useMemo(() => {
    if (resolvedVenueId) {
      const v = (venuesQ.data ?? []).find((r) => r.id === resolvedVenueId);
      if (v?.name) return v.name;
    }
    return prefillVenueName || autoVenue?.venueName || "";
  }, [resolvedVenueId, venuesQ.data, prefillVenueName, autoVenue]);

  /* Owner 2026-07-04 — Venue is EDITABLE on mobile too ("虽然是 by default 的,
     可是为什么不给更改呢?"). Mirrors desktop SalesOrderNew pickedVenueId: the
     select DEFAULTS to the derived venue above and the operator can override
     from the same useVenues() master. null = untouched → the auto-derived
     value keeps flowing (including a later salesperson change re-deriving it);
     picking "—" reverts to the derived default (desktop-verbatim behaviour). */
  const [pickedVenueId, setPickedVenueId] = useState<string | null>(null);
  const effectiveVenueId = pickedVenueId ?? resolvedVenueId;
  const effectiveVenueName: string = useMemo(() => {
    if (pickedVenueId == null) return resolvedVenueName;
    return (venuesQ.data ?? []).find((r) => r.id === pickedVenueId)?.name ?? "";
  }, [pickedVenueId, venuesQ.data, resolvedVenueName]);

  /* Sales Location derives from state_warehouse_mappings for the picked state
     (desktop parity: SalesOrderNew state → salesLocation cascade). */
  const stateWarehousesQ = useStateWarehouseMappings();
  const salesLocation: string = useMemo(() => {
    if (!state) return "";
    const list = stateWarehousesQ.data?.mappings ?? [];
    const hit = list.find((m) => m.state === state);
    return hit?.warehouse?.code ?? "";
  }, [state, stateWarehousesQ.data]);
  /* Active company — decides whether the stock-location gate applies at all
     (owner 2026-08-13: company 1 only). Already cached app-wide by the chrome,
     so this costs no extra request. */
  const branding = useBranding();

  /* Effective venue to SEND on save — the operator's manual pick when they
     changed it, otherwise the derived default (resolvedVenueId already folds
     in the persisted / salesperson / active-project fallbacks). */
  const outgoingVenueId = effectiveVenueId;
  const outgoingVenueName = effectiveVenueName;

  /* Salesperson to SEND — always a real scm.staff uuid. The `__self__` sentinel
     that used to stand in for "the creator has no staff row" is gone: the
     roster now always carries the caller (staff.ts, THE ALWAYS-HOLDS RULE), so
     there is nothing to map. Null only while the roster is still loading, where
     the backend falls back to its own caller-based resolution. */
  const outgoingSalespersonId = salespersonId || null;

  /* ── FIX A — locality cascade (desktop SalesOrderNew parity) ──────────────
     State → City → Postcode all derive from the my_localities dataset. City
     options depend on the picked State; Postcode on the picked City. Country
     derives from the State (display-only; the backend re-derives on save). When
     the dataset is empty every list collapses to [] and the State field falls
     back to a free-text input. */
  const locRows = useMemo(() => locQ.data ?? [], [locQ.data]);
  /* Shared cascade (address-cascade.ts) — the same both-directions rules the
     desktop forms run, so the two surfaces cannot drift apart again. */
  const { states: stateOpts, cities: cityChoices, postcodes: postcodeChoices } =
    useAddressCascade(locRows, state, city);
  const localitiesReady = stateOpts.length > 0; // real dataset present → use dropdowns
  const country = useMemo(
    () => (state ? countryForState(locRows, state) : null) ?? "Malaysia",
    [locRows, state],
  );

  /* ── FIX D2/D3 — processing-date LOCK (mirror the backend + SalesOrderDetail).
     The backend locks an SO once "today (MYT)" is strictly AFTER its processing
     date (processing_date) on a non-DRAFT / non-CANCELLED order: line
     add/edit/delete + the identity columns State / City / Postcode are rejected
     409 so_locked_processing. Delegated to the SHARED procLockActive() (which
     reads processing_date + status against todayMyt()) so this edit form
     can't drift from the mobile detail screen or desktop — DRAFT / CANCELLED
     stay editable. In EDIT mode we DISABLE line editing + State/City/Postcode,
     but keep the rest of the customer info + address lines + note editable. */
  const procLocked = useMemo(
    () => isEdit && procLockActive({ processing_date: origProcDate, status: soStatus }),
    [isEdit, origProcDate, soStatus],
  );
  /* AMENDMENT MODE (desktop SalesOrderDetail parity) — the SO is
     processing-locked (already PO'd) but the server flags it amendment_eligible
     (not hard-locked by a DO/SI, not terminal) AND no amendment is already open.
     In this mode the LINE EDITOR STAYS ENABLED even though procLocked, but Save
     packages the changes as an amendment request (POST /:docNo/amendments) that
     the coordinator + supplier confirm before the order is revised — a direct
     line write on a PO'd SO would break the supplier copy, which is exactly what
     this flow prevents. Uses the server flag; falls back to false when absent so
     older responses keep the old block-everything behaviour. */
  const amendmentMode = amendEligible && !lineLocked && !hasOpenAmend;
  /* Line editing is blocked when the SO is shipped / has downstream docs
     (lineLocked), OR when the processing date has passed (procLocked) UNLESS the
     order is in amendment mode (then the editor stays open and Save raises an
     amendment). A procLocked SO that already has an open amendment stays
     read-only — a second amendment can't be raised while one is in flight. */
  const lineEditingBlocked = lineLocked || (procLocked && !amendmentMode);
  /* Identity address columns (State/City/Postcode) freeze on the processing
     lock (State drives each line's warehouse → the supplier PO) — EXCEPT in
     amendment mode, where changing them is exactly what an amendment is for, so
     they stay editable and their new values ride the request for approval
     (Owner 2026-07-16: "應該是全部可以 request 啊 然後看有沒有 approval"). */
  const addressIdentityLocked = procLocked && !amendmentMode;
  /* The two schedule dates follow the same rule: frozen on a plain locked SO,
     requestable via the amendment. Delivery Date specifically — owner:
     "delivery date 也要給 amend 也是 subject approval". */
  /* ...and a Remove-Processing-Date holder keeps them editable even on a locked
     SO (Owner 2026-07-09, port of 2990 #717): the API lets that holder CLEAR the
     pair to pull a locked SO back out of Proceed, so freezing the inputs here
     would deny the very action the permission grants. Moving (rather than
     clearing) a locked date still 409s server-side — same as desktop. */
  const scheduleDatesLocked = procLocked && !amendmentMode && !canRemoveProcessingDate;
  /* Schedule-date floor (desktop parity) — the backend rejects a past
     Processing / Delivery Date (todayMY, UTC+8), so grey out earlier days in
     the picker exactly as SalesOrderNew / SalesOrderDetail do, instead of
     letting mobile pick a date Save will only bounce. todayMyt() is the same
     Malaysia (UTC+8) calendar day the backend measures against, so a user near
     midnight isn't wrongly blocked. Processing Date drops the floor when the
     order is already processing-locked (procLocked) — mirrors Detail so an
     existing, legitimately-past processing date on a locked/amendment SO isn't
     forced forward. */
  const today = todayMyt();

  /* ── FIX A — Salesperson default (desktop parity) ─────────────────────────
     The creator IS the salesperson: default to the signed-in user. If they have
     a matching scm.staff row seed its canonical id; otherwise seed a UI-only
     "self" sentinel so their NAME shows (never blank). Only seeds when nothing
     is picked yet (never stomps an admin's manual pick, or a scan-provided
     salesperson). Non-admins can't re-pick (gated select).

     The MATCH is the SHARED `resolveSelfStaff` — user_id first, the key the
     backend joins on. This file matched email-then-name while the comment above
     it advertised an id match it never ran; of 140 production scm.staff rows 18
     carry an email and 102 carry user_id, so most salespeople were not
     recognised as themselves here and could be blocked by the confirm gate
     below (#2049). */
  const selfStaffMatch = useMemo(
    () => resolveSelfStaff(staffList, {
      userId: currentUser?.id, email: currentUser?.email, name: currentUser?.name,
    }),
    [staffList, currentUser?.id, currentUser?.email, currentUser?.name],
  );
  useEffect(() => {
    if (isEdit) return; // edit keeps the persisted salesperson
    if (selfStaffMatch) setSalespersonId((prev) => prev || selfStaffMatch.id);
  }, [isEdit, selfStaffMatch]);

  /* Customer Type default (owner 2026-07-03, re-stated 2026-07-16) — a NEW SO
     defaults to the real DB option whose label reads "New Customer". The pick
     itself lives in the SHARED preferredCustomerTypeValue so desktop
     (SalesOrderNew) applies the identical rule. Never on EDIT (keeps the
     persisted value) and never once a value is already picked (a scan-provided
     customerType wins). Fed by useSoDropdownOptions — no fabricated list. */
  useEffect(() => {
    if (isEdit) return;
    const preferred = preferredCustomerTypeValue(customerTypeOpts);
    if (preferred) setCustType((prev) => prev || preferred);
  }, [isEdit, customerTypeOpts]);

  /* Three separate atoms, so each pick writes the whole triple back. The raw
     setters are deliberate: routing a back-filled State through onStateChange
     would clear the City/Postcode just picked, because that handler exists to
     reset the cascade. The salesLocation memo follows the resolved State. */
  const applyTriple = (next: { state: string; city: string; postcode: string }) => {
    setState(next.state);
    setCity(next.city);
    setPostcode(next.postcode);
  };
  const onStateChange = (next: string) => applyTriple(pickState(next));
  const onCityChange = (next: string) =>
    applyTriple(pickCity(locRows, { state, city, postcode }, next));
  const onPostcodeChange = (next: string) =>
    applyTriple(pickPostcode(locRows, { state, city, postcode }, next));

  // ---- Totals ---------------------------------------------------------------
  const subtotal = useMemo(
    () => lines.reduce((a, l) => a + toSen(l.price) * num(l.qty), 0),
    [lines],
  );

  const title = mode === "edit-draft" ? "Edit Draft" : mode === "edit" ? "Edit Sales Order" : "New Sales Order";

  // ---- Validation -----------------------------------------------------------
  /* Email is NOT required (owner 2026-07-03). Required = customer name + phone.
     If an email IS typed it must still be well-formed. */
  const emailProvided = Boolean(email.trim());
  const emailFormatOk = !emailProvided || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const nameErr = !name.trim();
  const phoneErr = !phone.trim();
  const emailErr = emailProvided && !emailFormatOk; // only an error when a BAD email is typed
  const dateXorErr = Boolean(procDate) !== Boolean(delivDate); // set together or both empty

  /* Address-required rule — optional by default; a PROCESSING DATE makes it
     required, because that date is the proceed signal and a proceeding order
     has to be deliverable. It used to read `procDate && delivDate`, which
     DISAGREED with the server (required on procDate alone since 2026-07-31),
     so the marks stayed off and the save was then refused. Do not re-add the
     AND: docs/modules/sales-order.md, "The client-side address marks". */
  const addressRequired = Boolean(procDate);
  const missingAddress = addressRequired
    ? [
        !state.trim() ? "state" : null,
        !city.trim() ? "city" : null,
        !postcode.trim() ? "postcode" : null,
        !addr1.trim() ? "address line 1" : null,
      ].filter(Boolean) as string[]
    : [];

  /* Dynamic "missing required fields" message — names ONLY what's actually
     missing/invalid (owner: don't say "name, phone and email" when only email
     is empty; email is optional anyway). */
  const missingCustomerMsg = (): string | null => {
    const miss: string[] = [];
    if (nameErr) miss.push("customer name");
    if (phoneErr) miss.push("phone");
    if (emailErr) miss.push("a valid email");
    if (miss.length === 0) return null;
    const joined = miss.length === 1 ? miss[0] : miss.slice(0, -1).join(", ") + " and " + miss[miss.length - 1];
    return `Fill in ${joined}.`;
  };

  /* Address validation message — only fires when both dates are set and the
     delivery address is incomplete. */
  const missingAddressMsg = (): string | null => {
    if (missingAddress.length === 0) return null;
    const joined = missingAddress.length === 1 ? missingAddress[0] : missingAddress.slice(0, -1).join(", ") + " and " + missingAddress[missingAddress.length - 1];
    return `Both a Processing and a Delivery date are set, so fill in the delivery ${joined}.`;
  };

  const namedLines = useMemo(() => lines.filter((l) => l.name.trim() || l.itemCode.trim()), [lines]);
  const unpickedLines = useMemo(() => namedLines.filter((l) => !l.itemCode.trim()), [namedLines]);

  /* The lines as the shared cascade layer sees them. A line with no SKU picked
     has no category, so it neither drives nor follows. */
  const cascadeLines = useMemo(
    () => lines.map((l) => ({ category: l.itemCode.trim() && l.itemGroup ? l.itemGroup : '', variants: l.variants })),
    [lines],
  );

  /* Per-category variants captured from the FIRST line of that category that
     has any variants set — the PICK-TIME seed. Same shared helper the desktop
     form calls; this file used to carry its own copy of it. */
  const inheritVariantsByCategory = useMemo(
    () => seedableMasterVariants(cascadeLines),
    [cascadeLines],
  );

  /* Follower-line cascade — the FIRST same-category line is the master and its
     variants travel to the rest. The rule is the shared layer
     (vendor/scm/lib/so-variant-cascade), imported by the desktop SalesOrderNew
     too; this file used to carry a second copy whose comment claimed it
     mirrored the desktop while behaving differently.

     Owner ruling 2026-08-21 — the master's LATEST change always wins, so a
     follower already typed by hand IS overwritten when the master moves again.
     `overriddenKeys` no longer vetoes this cascade; it still guards the
     per-sofa colour sync in the FabricPicker below, which is a different rule.
     The dep is now the LINES, not a JSON string of the inherit map: the
     snapshot ref is what decides whether the master actually moved a key. */
  const masterSnapshotRef = useRef<MasterVariantSnapshot>({});
  useEffect(() => {
    const { variants, masters } = cascadeMasterVariants(
      cascadeLines,
      masterSnapshotRef.current,
      /* Mobile only shows variant panels for sofa + bedframe, so only those
         cascade here. Passed explicitly because desktop answers differently. */
      MOBILE_CASCADE_CATEGORIES,
    );
    masterSnapshotRef.current = masters;
    setLines((prev) => {
      let mutated = false;
      const next = prev.map((l, idx) => {
        if (variants[idx] === undefined || variants[idx] === l.variants) return l;
        mutated = true;
        return { ...l, variants: variants[idx]! };
      });
      return mutated ? next : prev;
    });
  }, [cascadeLines]);

  /* Scanned hint — a field the scan filled shows a subtle "scanned" tag. */
  const scanned = (key: keyof ScanBaseline, current: string): boolean => {
    if (!scanBaseline) return false;
    const base = scanBaseline[key];
    if (base === undefined || base === "") return false;
    return current === base;
  };

  /* ── Scan-review learning (scan-seeded SO only) ───────────────────────────
     `changed` LABELS the sample, it no longer gates the POST: an unchanged scan
     is the operator confirming the AI read the slip perfectly — a positive
     example, not a non-event. Mirrors desktop SalesOrderNew.maybeLearnFromScan
     exactly (single logic layer); the backend keeps corrected vs accepted-as-is
     apart because they teach different things (scan-so.ts SAMPLE_* header). */
  const maybeLearnFromScan = () => {
    if (!fromScan) return;
    /* A scan that teaches nothing used to return here in silence — the pool
       stays empty and there is no record of why. 40 scans / 0 confirmations
       made that ambiguity the whole question. */
    if (!scanSampleId) { reportScanLearningSkipped('no-sample-id', 'mobile'); return; }
    if (!scanAiOriginal) { reportScanLearningSkipped('no-ai-original', 'mobile'); return; }
    const ai = scanAiOriginal;
    const optMatch = (v: string) => (v ? { value: v, confidence: 1, reason: "operator-confirmed" } : null);
    const norm = (s: string | null | undefined) => (s ?? "").trim();
    const digits = (s: string) => s.replace(/\D+/g, "");
    const aiFirstPhoneDigits = digits(ai.phones?.[0] ?? "");
    const finalLines = lines.filter((l) => l.name.trim());

    let changed = false;
    const mark = (a: string, b: string) => { if (a !== b) changed = true; };
    mark(norm(name), norm(ai.customerName));
    // Both sides are E.164 now, so compare them as-is. This used to strip a
    // leading 60/0 from the AI value to meet a field that held national digits;
    // once the field became E.164 that stripping made the two permanently
    // unequal, labelling an UNTOUCHED phone as operator-corrected and feeding
    // the OCR loop a correction nobody made.
    mark(digits(phone), aiFirstPhoneDigits);
    mark(norm(addr1), norm(ai.addressLine1 ?? ai.address));
    mark(norm(state), norm(ai.addressStateMatch?.value));
    mark(norm(city), norm(ai.city));
    mark(norm(postcode), norm(ai.postcode));
    mark(norm(custRef), norm(ai.customerSoRef));
    mark(norm(custType), norm(ai.customerTypeMatch?.value));
    mark(norm(buildingType), norm(ai.buildingTypeMatch?.value));
    mark(norm(pays[0]?.method), norm(ai.paymentMethodMatch?.value === "Installment" ? "Merchant" : ai.paymentMethodMatch?.value));
    if (finalLines.length !== ai.lines.length) changed = true;
    for (const l of finalLines) {
      const meta = scanLineMeta[l.key];
      if (!meta || norm(l.name) !== norm(meta.seededName)) changed = true;
    }

    const corrected: ExtractedSlip = {
      customerName: name.trim() || null,
      address: addr1.trim() || null,
      addressLine1: addr1.trim() || null,
      city: city.trim() || null,
      postcode: postcode.trim() || null,
      addressStateMatch: optMatch(state),
      phones: phone.trim() ? [phone.trim()] : ai.phones,
      location: ai.location,
      deliveryDate: delivDate || ai.deliveryDate,
      /* UNCHANGED MAPPING, now visibly odd (see the procDate seed above): the
         SO's Processing Date field is written back into the slip's own
         `slipDate`. It is only consistent because mobile SEEDED procDate from
         slipDate, so an untouched field inverts to exactly the AI's read and
         contributes no diff. Backend `CARRIED_NOT_INVERTED` lists slipDate for
         precisely this reason. Rewiring it is a behaviour change, not a rename. */
      slipDate: procDate || ai.slipDate,
      salesRep: scanSalesperson || ai.salesRep,
      customerSoRef: custRef.trim() || ai.customerSoRef,
      paymentMethod: ai.paymentMethod,
      depositRm: ai.depositRm,
      totalRm: ai.totalRm,
      remarks: note.trim() || ai.remarks,
      approvalCode: pays[0]?.approval || ai.approvalCode,
      paymentMethodMatch: optMatch(pays[0]?.method ?? "") ?? ai.paymentMethodMatch,
      bankMatch: ai.bankMatch,
      onlineTypeMatch: ai.onlineTypeMatch,
      installmentPlanMatch: ai.installmentPlanMatch,
      customerTypeMatch: optMatch(custType),
      buildingTypeMatch: optMatch(buildingType),
      locationMatch: ai.locationMatch,
      lines: finalLines.map((l) => {
        const meta = scanLineMeta[l.key];
        return {
          rawText: meta?.rawText || l.name,
          qtyGuess: num(l.qty) || 1,
          priceRmGuess: toSen(l.price) > 0 ? toSen(l.price) / 100 : null,
          skuMatch: null,
          fabricMatch: null,
          specialsMatch: [],
          notes: l.name.trim() || null,
        };
      }),
    };

    /* Still best-effort — it never blocks the save. What changed is that a
       4xx/5xx no longer vanishes into an empty arrow function (Hookka 5ea07668:
       ".catch only sees a NETWORK failure — a 403, 404 or 500 resolves normally
       and was thrown away unread"). */
    void postScanLearningSample(
      authedFetch,
      scanSampleId,
      { corrected, salesperson: scanSalesperson || null, accepted: !changed },
      'mobile',
    );
  };

  /* Post-create payment recording — records each amount-bearing row AFTER the
     SO exists, through the same POST /:docNo/payments the SO-detail screen uses.

     THE FILTER IS THE AMOUNT, AND ONLY THE AMOUNT. It used to also demand a
     slipSession, which silently dropped a slip-less row: the cashier's payment
     never posted and the SO read unpaid (BUG-HISTORY, the money bug that
     produced the shared slipless guard). With the slip now OPTIONAL everywhere
     (Owner 2026-08-13) that guard is gone, so this filter is the only thing
     deciding whether the money is recorded — it must never look at the slip
     again. The route accepts a null uploadSessionId and records the row
     slip-less. */
  async function recordNewPayments(createdDocNo: string) {
    const rows = pays.filter((p) => toSen(p.amount) > 0);
    if (rows.length === 0) return;
    let failed = 0;
    let firstError = "";
    for (const p of rows) {
      const code = paymentMethodCodeForValue(p.method) ?? "cash";
      const body: Record<string, unknown> = {
        paidAt: p.date,
        method: code,
        amountSen: toSen(p.amount),
        accountSheet: p.account.trim() || null,
        approvalCode: p.approval.trim() || null,
        collectedBy: p.collectedBy || null,
        // '' when no slip was attached — send null, not an empty session id.
        uploadSessionId: p.slipSession || null,
      };
      if (code === "merchant") { body.merchantProvider = p.bank || null; body.installmentMonths = planToMonths(p.plan); }
      else if (code === "installment") { body.merchantProvider = p.bank || null; body.installmentMonths = planToMonths(p.plan); }
      else if (code === "transfer") { body.onlineType = p.online || null; }
      try {
        await authedFetch(`/mfg-sales-orders/${encodeURIComponent(createdDocNo)}/payments`,
          idempotentInit(p.idempotencyKey, { method: "POST", body: JSON.stringify(body) }));
      } catch (e) {
        failed += 1;
        if (!firstError && e instanceof Error && e.message) firstError = e.message;
      }
    }
    if (failed > 0) {
      const detail = firstError ? ` ${firstError}` : "";
      void notify({ title: "Some payments weren't recorded", body: `${failed} of ${rows.length} payment(s) failed to post.${detail} Record them again from the SO detail screen.`, tone: "error" });
    }
  }

  /* Post-save per-line photo upload. Uploads each staged File against the saved
     itemId (mirrors the desktop pendingPhotoFiles drain). On CREATE we re-fetch
     the items to pair each line's staged files with its minted id (matched by
     item_code + description in order). */
  async function uploadStagedPhotos(soDocNo: string, existingLeaseToken?: string | null) {
    const withFiles = lines.filter((l) => l.photoFiles.length > 0);
    if (withFiles.length === 0) return;
    // Resolve each staged line to a saved itemId. In edit mode a persisted line
    // already carries itemId; otherwise pair against the freshly saved items.
    let saved: SoItem[] = [];
    const needsLookup = withFiles.some((l) => !l.itemId);
    if (needsLookup) {
      try {
        const detail = await authedFetch<DetailResp>(`/mfg-sales-orders/${encodeURIComponent(soDocNo)}`);
        saved = (detail.items ?? []).filter((it) => !it.cancelled);
      } catch { /* best-effort */ }
    }
    const claimed = new Set<string>();
    const resolveId = (l: LineItem): string | null => {
      if (l.itemId) return l.itemId;
      const hit = saved.find((s) =>
        !claimed.has(s.id) &&
        (s.item_code ?? "") === l.itemCode &&
        (s.description ?? "") === l.name.trim(),
      ) ?? saved.find((s) => !claimed.has(s.id) && (s.item_code ?? "") === l.itemCode);
      if (hit) { claimed.add(hit.id); return hit.id; }
      return null;
    };
    let failed = 0;
    const uploadUnderLease = async (lease: string) => {
      for (const l of withFiles) {
        const itemId = resolveId(l);
        if (!itemId) { failed += l.photoFiles.length; continue; }
        for (const file of l.photoFiles) {
          try {
            await uploadSoItemPhotoWithLease(soDocNo, itemId, file, lease);
          } catch { failed += 1; }
        }
      }
    };
    if (existingLeaseToken) {
      await uploadUnderLease(existingLeaseToken);
    } else {
      await runSoVersionedMutation(qc, soDocNo, "mobile-new-so-photo-upload", ({ leaseToken }) =>
        uploadUnderLease(leaseToken));
    }
    if (failed > 0) {
      void notify({ title: "Some photos didn't upload", body: `${failed} line photo(s) failed to upload. Add them again from the SO detail screen.`, tone: "error" });
    }
  }

  /* Line-item body for POST /:docNo/items and the create body's items[].
     Delegates to the module-level buildItemBody (shared with the headless
     createDraftFromPrefill). */
  const itemBody = buildItemBody;

  const itemPatchBody = (l: LineItem): Record<string, unknown> => ({
    itemCode: l.itemCode,
    itemGroup: l.itemGroup || "others",
    description: l.name.trim(),
    qty: num(l.qty) || 1,
    unitPriceSen: toSen(l.price),
    /* An EXISTING line: its 0 IS its persisted price (desktop's PATCH said so since #2425). */
    ...zeroPriceClaim(toSen(l.price), true),
    lineDeliveryDate: l.ddate || null,
    variants: buildVariants(l),
  });

  const canonJson = (o: unknown): string => {
    if (o == null) return "null";
    if (typeof o !== "object") return JSON.stringify(o);
    if (Array.isArray(o)) return "[" + o.map(canonJson).join(",") + "]";
    return "{" + Object.keys(o as Record<string, unknown>).sort()
      .map((k) => JSON.stringify(k) + ":" + canonJson((o as Record<string, unknown>)[k]))
      .join(",") + "}";
  };
  const lineChanged = (l: LineItem, snap: SoItem): boolean => {
    if (l.itemCode !== (snap.item_code ?? "")) return true;
    if ((l.itemGroup || "others") !== ((snap.item_group ?? "others").toLowerCase())) return true;
    if ((num(l.qty) || 1) !== (snap.qty ?? 1)) return true;
    if (toSen(l.price) !== (snap.unit_price_sen ?? 0)) return true;
    if (l.name.trim() !== (snap.description ?? "").trim()) return true;
    if ((l.ddate || "") !== ((snap.line_delivery_date ?? "").slice(0, 10))) return true;
    if (canonJson(buildVariants(l)) !== canonJson(snap.variants ?? {})) return true;
    return false;
  };

  /* The AMENDMENT half of lineChanged — only the four fields a
     CreateAmendmentLine can carry. lineChanged above is right for applyLineDiff
     (a direct PATCH persists all of description / group / line date), but WRONG
     as an amendment's dirtiness test: a line dirty only in `ddate` — which the
     header Delivery Date cascade rewrites on every non-overridden line — has
     nothing to request, so recording it produced a SPEC row whose new_* equalled
     its own old_snapshot and rendered as an identical Was/Requesting pair
     (Owner 2026-07-16: "完全看不出有什麼變動申請？"). Desktop had the same defect via
     lineCommitSig; both now test only what the payload carries. */
  const amendmentLineChanged = (l: LineItem, snap: SoItem): boolean => {
    if (l.itemCode !== (snap.item_code ?? "")) return true;
    if ((num(l.qty) || 1) !== (snap.qty ?? 1)) return true;
    if (toSen(l.price) !== (snap.unit_price_sen ?? 0)) return true;
    if (canonJson(buildVariants(l)) !== canonJson(snap.variants ?? {})) return true;
    /* mig 0280 — the remark is a carryable field now, so a remark-only edit IS
       a request. Stated explicitly rather than relying on the variants compare
       above: buildVariants copies the remark into variants.remark, so this was
       incidentally caught here while desktop's signature (four fields, no
       variants.remark side channel) missed it entirely and silently requested
       nothing. Both platforms now test the same five fields on purpose. */
    if (l.remark.trim() !== (snap.remark ?? "").trim()) return true;
    return false;
  };

  async function applyLineDiff(soDocNo: string, leaseToken: string): Promise<number> {
    const base = `/mfg-sales-orders/${encodeURIComponent(soDocNo)}/items`;
    const leaseHeaders = { "X-SO-Edit-Lease": leaseToken };
    let failed = 0;
    const liveIds = new Set(lines.map((l) => l.itemId).filter(Boolean));
    for (const snap of origItems) {
      if (liveIds.has(snap.id)) continue;
      try { await authedFetch(`${base}/${encodeURIComponent(snap.id)}`, { method: "DELETE", headers: leaseHeaders }); }
      catch { failed += 1; }
    }
    const snapById = new Map(origItems.map((s) => [s.id, s]));
    for (const l of lines) {
      if (!l.itemCode.trim()) continue;
      if (!l.itemId) {
        try {
          await authedFetch(base, {
            method: "POST",
            headers: mobileLineAddHeaders(l, leaseToken),
            body: JSON.stringify(itemBody(l)),
          });
        }
        catch { failed += 1; }
        continue;
      }
      const snap = snapById.get(l.itemId);
      if (snap && lineChanged(l, snap)) {
        try { await authedFetch(`${base}/${encodeURIComponent(l.itemId)}`, { method: "PATCH", headers: leaseHeaders, body: JSON.stringify(itemPatchBody(l)) }); }
        catch { failed += 1; }
      }
    }
    return failed;
  }

  /* ── Amendment line builder (Phase 1-C) ──────────────────────────────────
     Verbatim port of the desktop SalesOrderDetail.buildAmendmentLines logic,
     adapted to the mobile LineItem shape: diff the in-flight `lines` against the
     pristine `origItems` seed and package the changes as CreateAmendmentLine[]
     for POST /:docNo/amendments (via useCreateAmendment). No pricing is computed
     here — the server recomputes on approve; we only carry the raw new values +
     an old_snapshot for the before/after diff. Classification mirrors desktop:
       • existing line, only qty moved              → QTY
       • existing line, code/variants/price moved   → SPEC
       • orig line whose itemId dropped from lines  → REMOVE
       • new line (no itemId) with a product picked → ADD */
  const buildAmendmentLines = (): CreateAmendmentLine[] => {
    const out: CreateAmendmentLine[] = [];
    const snapById = new Map(origItems.map((s) => [s.id, s]));
    const liveIds = new Set(lines.map((l) => l.itemId).filter(Boolean));
    // Existing lines — SPEC / QTY changes.
    for (const l of lines) {
      if (!l.itemId) continue; // added line handled below
      const snap = snapById.get(l.itemId);
      if (!snap) continue;
      if (!amendmentLineChanged(l, snap)) continue; // nothing amendable moved
      const codeSame = l.itemCode === (snap.item_code ?? "");
      const variantsSame = canonJson(buildVariants(l)) === canonJson(snap.variants ?? {});
      const priceSame = toSen(l.price) === (snap.unit_price_sen ?? 0);
      const qtyMoved = (num(l.qty) || 1) !== (snap.qty ?? 1);
      const qtyOnly = codeSame && variantsSame && priceSame && qtyMoved;
      out.push({
        salesOrderItemId: l.itemId,
        changeType: qtyOnly ? "QTY" : "SPEC",
        newItemCode: l.itemCode || undefined,
        newVariants: buildVariants(l),
        newQty: num(l.qty) || 1,
        newUnitPriceSen: toSen(l.price),
        /* mig 0280 — send the remark only when it MOVED (desktop parity): a null
           new_remark is "not requested", which is what keeps the apply from
           rewriting a remark this session never touched. */
        ...(l.remark.trim() !== (snap.remark ?? "").trim()
          ? { newRemark: l.remark.trim() }
          : {}),
        oldSnapshot: {
          itemCode: snap.item_code,
          variants: snap.variants ?? null,
          qty: snap.qty,
          unitPriceSen: snap.unit_price_sen,
          description2: (snap as { description2?: string | null }).description2 ?? null,
        },
      });
    }
    // Removed lines — an orig item whose itemId no longer appears in `lines`.
    for (const snap of origItems) {
      if (liveIds.has(snap.id)) continue;
      out.push({
        salesOrderItemId: snap.id,
        changeType: "REMOVE",
        oldSnapshot: {
          itemCode: snap.item_code,
          variants: snap.variants ?? null,
          qty: snap.qty,
          unitPriceSen: snap.unit_price_sen,
          description2: (snap as { description2?: string | null }).description2 ?? null,
        },
      });
    }
    // Added lines — new (no itemId) with a product picked.
    for (const l of lines) {
      if (l.itemId) continue;
      if (!l.itemCode.trim()) continue;
      out.push({
        changeType: "ADD",
        newItemCode: l.itemCode,
        newVariants: buildVariants(l),
        newQty: num(l.qty) || 1,
        newUnitPriceSen: toSen(l.price),
        /* mig 0280 — desktop parity: an added line carries its typed remark to
           the mfg_sales_order_items.remark COLUMN, not only inside the variants
           blob. A service line added purely to carry an instruction is the case
           that lost the owner's text on 2990-SO-2608-016. */
        ...(l.remark.trim() ? { newRemark: l.remark.trim() } : {}),
      });
    }
    return out;
  };

  // ---- Mutations ------------------------------------------------------------
  async function save(asDraft = false) {
    setTouched(true);
    const custMsg = missingCustomerMsg();
    if (custMsg) { setError(custMsg); return; }
    if (namedLines.length < 1) { setError("Add at least one line item."); return; }
    if (unpickedLines.length > 0) {
      setError(`Pick a product from the catalog for every line (${unpickedLines.length} line${unpickedLines.length === 1 ? "" : "s"} still ha${unpickedLines.length === 1 ? "s" : "ve"} no product selected).`);
      return;
    }
    /* Sofa is exclusive among main products — the server 400s
       `so_sofa_no_other_main` when a sofa line rides with a bedframe/mattress.
       INTRODUCED, not flat (desktop parity, #2395): this asked the flat
       `hasSofaMixConflict`, which is the CREATE path's question, and the guard
       sits ABOVE the edit branch so it ran on edits too. The server's line paths
       refuse only a change that INTRODUCES the mix, so an order written before
       the rule existed stays editable — while this refused EVERY save on one,
       not even a phone number, blaming a rule the server grandfathers.
       `origItems` is empty on a create, so there this IS the flat question. */
    if (sofaMixIntroduced(origItems.map((it) => it.item_group), namedLines.map((l) => l.itemGroup))) {
      setError(SOFA_MIX_MESSAGE);
      return;
    }
    /* Variant completeness is the PROCEED rule, and only the proceed rule
       (owner 2026-08-13: "只要是没有 proceed 这一张订单，其实都不一定是需要填写
       的，除非它是 proceed 了"). A Processing Date IS proceed — colour-KIV also
       blocks a date, owner 2026-07-24 — so the axes are demanded exactly when
       a date is being set, on create and on edit alike. This briefly also ran
       on a date-less CONFIRMED create (2026-08-08, HC-SO-2607-008); that made
       a real order for a real customer unbookable before the customer had
       picked a seat height, and is removed. Drafts were never gated. */
    if (!asDraft && procDate) {
      const missOf = (l: LineItem) => missingVariantAxes(l.itemGroup, l.variants, l.itemCode);
      const offender = namedLines.find((l) => missOf(l).length > 0);
      if (offender) {
        const miss = missOf(offender).map((a) => a.label).join(", ");
        setError(`Complete the required options (${miss}) on "${offender.name || offender.itemCode}" before setting a Processing Date.`);
        return;
      }
    }
    /* Confirm gates (owner 2026-08-08) — a NEW confirmed order needs a venue
       and a salesperson; drafts and edits are untouched (the DRAFT→CONFIRMED
       status transition has its own server gate). The backend enforces both
       (validation_failed); these pre-checks just say it in one sentence before
       the round-trip. Salesperson: a caller who CANNOT re-pick is stamped
       server-side as themselves, so only an attribute_other caller with the
       picker left empty is blocked here. */
    if (!asDraft && !isEdit && !outgoingVenueName && !outgoingVenueId) {
      setError("Pick a venue before confirming this order (drafts can be saved without one).");
      return;
    }
    if (!asDraft && !isEdit && canChangeSalesperson && !outgoingSalespersonId && !selfStaffMatch) {
      setError("Pick a salesperson before confirming this order (drafts can be saved without one).");
      return;
    }
    /* Stock-location gate (owner 2026-08-13, company 1 only) — the order must
       ship from a warehouse or AutoCount refuses the whole document. SHARED
       with desktop via soStockLocationError. Create only: an EDIT enqueues an
       AutoCount edit, which leaves the account book's own Location alone. */
    const locationErr = soStockLocationError({
      companyCode: branding.companyCode,
      salesLocation,
      state,
      mappingsLoaded: !!stateWarehousesQ.data,
      asDraft,
      isEdit,
    });
    if (locationErr) { setError(soErrorText(locationErr)); return; }
    const procOut = asDraft ? "" : procDate;
    const delivOut = asDraft ? "" : delivDate;
    /* The one value bag the EDIT patch and the CREATE body are both built from
       (soHeaderPatchFrom), so the two can never drift. */
    const headerPatchInput: SoHeaderPatchInput = {
      name, custRef, phone, email, custType, buildingType,
      venueId: outgoingVenueId, venueName: outgoingVenueName,
      note, addr1, addr2, state, city, postcode, salesLocation,
      procDate: procOut, delivDate: delivOut,
      ecName, ecPhone, ecRel,
      salespersonId: outgoingSalespersonId,
    };
    /* Date sanity (set-together / not-past / processing≤delivery) — SHARED with
       desktop via soDateGuardError so the rule can't drift. Validates only what
       will actually be saved (a draft strips both dates → procOut/delivOut "").
       Draft skips the both-or-neither rule (mobile parity); a firm SO enforces it.

       The originals are passed so the not-in-past rule fires only on a date this
       edit CHANGED. Without them this guard made the whole EDIT SHEET unusable on
       any SO that needed an amendment: such an SO ALWAYS has a past processing
       date, so its own unchanged date failed the not-in-past check and the submit
       was rejected before it ever reached the amendment (Owner 2026-07-16). */
    const dateErr = soDateGuardError({
      processingDate: procOut,
      deliveryDate: delivOut,
      today: todayMyt(),
      requireDatesTogether: !asDraft,
      originalProcessingDate: origProcDate,
      originalDeliveryDate: origDelivDate,
      canRemoveProcessingDate,
    });
    if (dateErr) { setError(soErrorText(dateErr)); return; }
    /* Address becomes required only when this is a firm delivery (both dates set)
       and we're not stashing a draft. Otherwise an empty address saves empty. */
    if (!asDraft) {
      const addrMsg = missingAddressMsg();
      if (addrMsg) { setError(addrMsg); return; }
    }
    /* NO SLIP GUARD (Owner 2026-08-13) — "SalesOrder 所有的付款都不强制".
       The guard that used to sit here existed because `recordNewPayments` only
       POSTed rows carrying a slipSession, so refusing the save was all that
       stood between a cashier and a payment that silently never booked. That
       writer now posts on AMOUNT alone, so the row lands either way and there
       is nothing left to refuse. Removing the guard WITHOUT that change would
       re-introduce the exact money bug it was written for. */
    /* Cascade guard — a chosen method needs its sub-field(s): Merchant → Bank +
       Plan, Online → Sub-Type, Cash → none. Uses the SHARED desktop rule
       (missingMethodSubField) at the SAME point desktop runs it: BEFORE the SO is
       created. Without it, save() passed every check, the SO was created, and
       recordNewPayments then POSTed the incomplete row — the server 400s
       payment_method_field_required, which is caught below and surfaced only as
       the generic "record them again" toast, AFTER the order already exists. The
       payment never books and the SO reads unpaid. Only amount-bearing rows are
       checked (a zeroed row is dropped at flush), mirroring desktop. */
    const methodGaps = pays
      .map((p, i) => ({
        row: i + 1,
        method: p.method,
        missing: toSen(p.amount) > 0
          ? missingMethodSubField({
              methodLabel: p.method,
              merchantProvider: p.bank,
              installmentMonthsLabel: p.plan,
              onlineType: p.online,
            })
          : null,
      }))
      .filter((x) => x.missing !== null);
    if (methodGaps.length > 0) {
      const g = methodGaps[0]!;
      setError(`Payment ${g.row} (${g.method}) needs a ${g.missing}. Pick the required sub-field for each payment method before saving.`);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      if (isEdit && docNo) {
        const patch: Record<string, unknown> = soHeaderPatchFrom(headerPatchInput);
        /* AMENDMENT MODE (Phase 1-C, desktop SalesOrderDetail.submitAmendment
           parity) — the SO is processing-locked but amendment_eligible. The edit
           splits in two:
             * directly-editable fields (contact / address lines / note) -> the
               header PATCH below, saved immediately, no approval needed.
             * FROZEN fields (Delivery / Processing Date, State, Postcode) + line
               changes -> the amendment request, approval decides.
           The PATCH must therefore send every frozen column at its ORIGINAL value
           or the server 409s so_locked_processing on the very change we're about
           to request. Shared helpers with desktop (so-amendment-header) so the
           split can't drift. */
        const { changes: headerChanges } = buildAmendmentHeaderChanges(
          {
            processingDate:   procOut,
            customerDeliveryDate: delivOut,
            customerState:        state,
            postcode:             postcode.trim(),
            city:                 city.trim(),
            // Addresses frozen 2026-07-27, customer contact 2026-08-21 — collected so a locked-SO edit rides the amendment.
            address1:             addr1.trim(),
            address2:             addr2.trim(),
            debtorName: name, phone, email,
          },
          {
            processingDate:   origProcDate,
            customerDeliveryDate: origDelivDate,
            customerState:        origState,
            postcode:             origPostcode,
            city:                 origCity,
            address1:             origAddress1,
            address2:             origAddress2,
            ...origContact,
          },
        );
        // EVERY key collected must appear here — an omitted one reverts to NULL, not "leave alone", and 409s the lock (so-amendment-header.test.ts).
        const outgoingPatch = amendmentMode
          ? withFrozenHeaderFieldsReverted(patch, {
              processingDate:   origProcDate,
              customerDeliveryDate: origDelivDate,
              customerState:        origState,
              postcode:             origPostcode,
              city:                 origCity,
              address1:             origAddress1,
              address2:             origAddress2,
              ...origContact,
            })
          : patch;

        /* Send ONLY what the operator changed. The diff runs AFTER the frozen-
           field revert, so a reverted column drops out entirely rather than
           being re-sent unchanged — the server's lock diffs `col in updates`, so
           a column we never send cannot 409 so_locked_processing at all.
           Baseline missing (prefill never completed) -> send the whole patch,
           exactly as before: we cannot prove a field is unchanged, and
           "unknown" must not silently become "not dirty". */
        const dirtyPatch = originalHeaderPatchRef.current
          ? diffHeaderPayload(originalHeaderPatchRef.current, outgoingPatch)
          : outgoingPatch;
        /* Nothing dirty -> no request. An all-unchanged body still re-fires the
           server's delivery-date cascade (keyed on PRESENCE, not change) and
           wipes every per-line override. Skipping loses no refresh: this branch
           invalidates everything itself once the whole composite save settles. */
        // Captured once: the plan must ask about the SAME patch this branch sends.
        const directDirty = hasHeaderChanges(dirtyPatch);
        if (amendmentMode && directDirty) {
          /* Attach the mandatory loaded token after the dirty check, so `version`
             never turns an otherwise-empty patch into a mutation. A 409 throws;
             the catch leaves every input in place and shows the curated conflict. */
          const headerBody = { ...dirtyPatch, version: loadedVersionRef.current };
          const headerResult = await authedFetch<{ ok: boolean; version: number }>(`/mfg-sales-orders/${encodeURIComponent(docNo)}`, {
            method: "PATCH",
            body: JSON.stringify(headerBody),
          });
          loadedVersionRef.current = headerResult.version;
        }

        if (amendmentMode) {
          const amLines = buildAmendmentLines();
          // Asks about BOTH halves — see vendor/scm/lib/so-amendment-submit.
          const plan = planAmendmentSubmit({
            hasLineChanges: amLines.length > 0,
            hasFrozenHeaderChanges: hasAmendmentHeaderChanges(headerChanges),
            hasDirectHeaderChanges: directDirty,
            hasStagedPayments: pays.some((p) => toSen(p.amount) > 0),
          });
          if (plan === "NOTHING") { setSubmitting(false); setError(AMENDMENT_NOTHING_TO_SUBMIT); return; }
          let amendCreatedRes: unknown = null;
          // DIRECT_ONLY skips ONLY this block; the tail after it is shared.
          if (plan === "AMENDMENT") {
            const reason = await prompt({
              title: `Submit amendment for ${docNo}?`,
              body: "This Sales Order is already ordered from the supplier, so your changes go out as an amendment request. Coordinator and supplier confirm it before the order is revised. Add a short reason (optional).",
              placeholder: "e.g. customer changed the fabric colour",
              multiline: true,
              confirmLabel: "Submit amendment",
            });
            if (reason == null) { setSubmitting(false); return; } // cancelled
            try {
              amendCreatedRes = await createAmendment.mutateAsync({
                docNo, reason: reason.trim() || undefined, lines: amLines, headerChanges,
                idempotencyKey: amendIdemKey,
              });
            } catch (e) {
              setSubmitting(false);
              // authed-fetch already humanises the API error to one plain sentence.
              setError(e instanceof Error ? e.message : "Couldn't submit the amendment. Please try again.");
              return;
            }
          }
          // A payment recorded alongside the amendment still posts, slip or not.
          await recordNewPayments(docNo);
          /* useCreateAmendment invalidated the SO lists already; that raw payment
             lands after it and moves the list's paid / outstanding aggregates. */
          invalidateSoShared(qc);
          await qc.invalidateQueries({ queryKey: ["mfg-sales-order-detail", docNo] });
          await qc.invalidateQueries({ queryKey: ["mobile-so-list-paged"] });
          /* Two-lane rework — the server classifies (and may split) the request:
             product changes wait on Purchasing, delivery changes on Logistics. */
          void notify(amendmentSubmittedNotice(plan, amendCreatedRes));
          if (onSaved) onSaved(docNo);
          else onBack();
          return;
        }

        const liveIds = new Set(lines.map((l) => l.itemId).filter(Boolean));
        const snapById = new Map(origItems.map((s) => [s.id, s]));
        const hasStagedPhotos = lines.some((line) => line.photoFiles.length > 0);
        const hasDirectLineChanges = !lineEditingBlocked && (
          origItems.some((snap) => !liveIds.has(snap.id))
          || lines.some((l) => !l.itemId || (snapById.get(l.itemId) ? lineChanged(l, snapById.get(l.itemId)!) : true))
          || hasStagedPhotos
        );
        let leaseToken: string | null = null;
        if (hasDirectLineChanges) {
          leaseToken = activeLineLeaseRef.current ??= newIdempotencyKey();
          const reserved = await authedFetch<{ ok: boolean; version: number }>(`/mfg-sales-orders/${encodeURIComponent(docNo)}`, {
            method: "PATCH",
            body: JSON.stringify({
              reserveLineWrites: true,
              lineWriteLeaseToken: leaseToken,
              version: loadedVersionRef.current,
            }),
          });
          loadedVersionRef.current = reserved.version;
        }

        /* FIX D2/D3 — skip line mutations + photo staging when line editing is
           blocked (shipped/has-children OR processing-date-locked); the backend
           rejects them 409 so_locked_processing anyway. */
        if (!lineEditingBlocked) {
          if (leaseToken) {
            const failed = await applyLineDiff(docNo, leaseToken);
            if (failed > 0) {
              throw new Error(`${failed} line change(s) did not save. Your edits are still here; try Save again.`);
            }
          }
          await uploadStagedPhotos(docNo, leaseToken);
        }

        if (hasHeaderChanges(dirtyPatch) || leaseToken) {
          const headerBody = {
            ...dirtyPatch,
            version: loadedVersionRef.current,
            ...(leaseToken ? {
              lineWriteLeaseToken: leaseToken,
              ...(!hasHeaderChanges(dirtyPatch) ? { completeLineWrites: true } : {}),
            } : {}),
          };
          const headerResult = await authedFetch<{ ok: boolean; version: number }>(`/mfg-sales-orders/${encodeURIComponent(docNo)}`, {
            method: "PATCH",
            body: JSON.stringify(headerBody),
          });
          loadedVersionRef.current = headerResult.version;
          activeLineLeaseRef.current = null;
        }
        await recordNewPayments(docNo);

        /* The header PATCH + line diff + payments above are raw authedFetch, so
           nothing has told the desktop SO list its rows moved. Invalidate once
           HERE, after every part of the composite save has settled. */
        invalidateSoShared(qc);
        await qc.invalidateQueries({ queryKey: ["mfg-sales-order-detail", docNo] });
        await qc.invalidateQueries({ queryKey: ["mobile-so-list-paged"] });
        if (onSaved) onSaved(docNo);
        else onBack();
        return;
      }

      // CREATE (new / edit-draft treated as create — mints a fresh doc_no).
      const items = namedLines.map((l) => itemBody(l));

      const body: Record<string, unknown> = {
        customerName: name.trim(),
        /* Same builder as the edit patch — a CREATE sends every field because a
           new order has no prior value to diff against. */
        ...soHeaderPatchFrom(headerPatchInput),
        /* EXPLICIT draft flag — the backend statuses DRAFT only on
           body.asDraft === true; nulling the dates alone saves CONFIRMED. */
        asDraft: asDraft === true,
        /* GATE-ONLY, never booked. recordNewPayments runs AFTER this
           create, so at CREATE time the backend saw RM0 and the Processing-Date
           deposit gate refused the save with the money plainly on screen — and
           the create had to succeed before the payments could ever be posted.
           Deadlock, identical to the desktop screen (same fix, same PR: the two
           surfaces share this rule and only one of them being fixed is the
           recurring bug class in CLAUDE.md). Same filter recordNewPayments
           uses — the AMOUNT, and only the amount — so this can never claim
           money it is not about to record. It used to also demand a
           slipSession; once the slip became optional (Owner 2026-08-13) that
           would have re-opened this very deadlock for a slip-less deposit. */
        pendingDepositSen: (() => {
          const c = pays
            .filter((p) => toSen(p.amount) > 0)
            .reduce((sum, p) => sum + toSen(p.amount), 0);
          return c > 0 ? c : undefined;
        })(),
        items,
      };

      const res = await createSo.mutateAsync({ ...body, idempotencyKey: soIdemKey });
      if (res?.docNo) {
        await uploadStagedPhotos(res.docNo);
        await recordNewPayments(res.docNo);
      }
      maybeLearnFromScan();
      /* useCreateMfgSalesOrder already invalidated the SO lists at POST success,
         but recordNewPayments posts RAW (not via useAddSalesOrderPayment)
         and lands after it, moving the list's paid / outstanding aggregates. */
      invalidateSoShared(qc);
      await qc.invalidateQueries({ queryKey: ["mobile-so-list-paged"] });
      if (res?.docNo && onSaved) onSaved(res.docNo);
      else onBack();
    } catch (e) {
      const heldLease = activeLineLeaseRef.current;
      if (isEdit && docNo && heldLease && loadedVersionRef.current != null) {
        try {
          await authedFetch(`/mfg-sales-orders/${encodeURIComponent(docNo)}`, {
            method: "PATCH",
            body: JSON.stringify({
              completeLineWrites: true,
              lineWriteLeaseToken: heldLease,
              version: loadedVersionRef.current,
            }),
          });
        } catch { /* silent-write-ok: RECOVERY arm of an outer catch that already told the operator the save failed; the lease expires anyway. */ }
        activeLineLeaseRef.current = null;
      }
      /* Aggregated save-gate failure (validation_failed) — show EVERY reason at
         once, same popup + list as desktop (owner 2026-07-18). Anything else
         keeps the inline error line. */
      void notifySaveProblems(notify, e, setError, "Couldn't save the sales order. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const patchLine = (key: string, patch: Partial<LineItem>) =>
    setLines((prev) => prev.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  /* FIX D1(b) — a manual Item Delivery Date edit records the line key as an
     override (so the header cascade leaves it alone) and applies the value. */
  const setLineDdateManual = (key: string, value: string) => {
    setDdateOverrides((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    patchLine(key, { ddate: value });
  };

  /* FIX D1(b) — header Delivery Date → each line's Item Delivery Date. Fills
     every line that hasn't been manually overridden, and re-syncs whenever the
     header date changes. A line the operator hand-edited (in ddateOverrides)
     keeps its own value. No-op while line editing is locked. */
  useEffect(() => {
    if (lineEditingBlocked) return;
    if (!delivDate) return; // nothing to cascade until the header date is set
    setLines((prev) => {
      let changed = false;
      const next = prev.map((l) => {
        if (ddateOverrides.has(l.key)) return l; // manual override wins
        if (l.ddate === delivDate) return l;
        changed = true;
        return { ...l, ddate: delivDate };
      });
      return changed ? next : prev;
    });
    // Re-run when the header date changes or a new (non-overridden) line appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delivDate, lineEditingBlocked, lines.length]);

  // ---- Render ---------------------------------------------------------------
  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      {/* Header — "Cancel" text button, Draft/Editing pill, title. No wizard
          progress bar (single-form). */}
      <header className="hdr">
        <div className="hdr-row">
          <button type="button" onClick={onBack} style={{ background: "none", border: "none", color: "var(--mut)", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>Cancel</button>
          <span className="badge b-grey">{mode === "edit" ? "EDITING" : "DRAFT"}</span>
        </div>
        <div id="nso-title" className="scr-title" style={{ marginTop: 6 }}>{title}</div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 12, paddingBottom: 24 }}>
        {loading ? (
          <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "40px 0" }}>Loading{"…"}</div>
        ) : (
          <>
            {fromScan && (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 9, marginBottom: 11, padding: "10px 12px", background: "#eaf2f0", border: "1px solid #cfe1dc", borderRadius: 12 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", marginTop: 1 }}><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>
                <div style={{ fontSize: 11.5, color: "#16695f", lineHeight: 1.5 }}>
                  Prefilled from your scan. Review every field marked <b>Scanned</b>, correct anything the reader missed, then create the order.
                </div>
              </div>
            )}

            {/* FIX D2/D3 — processing-date lock notice. The SO is on order to the
                supplier, so line items + State/City/Postcode are frozen; the rest
                of the customer info + address lines + note stay editable.
                NOT shown in amendment mode — there the lines + frozen fields ARE
                editable (they ride an amendment), so this banner would contradict
                the form. The amendment banner on the Items card says it instead. */}
            {procLocked && !amendmentMode && (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 9, marginBottom: 11, padding: "10px 12px", background: "#fbf3e6", border: "1px solid #ecd9b6", borderRadius: 12 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", marginTop: 1 }}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                <div style={{ fontSize: 11.5, color: "#8a5a22", lineHeight: 1.5 }}>
                  This order&apos;s processing date has passed, so it is now on order to the supplier. Line items and the delivery <b>State / City / Postcode</b> are locked. You can still update the rest of the customer details, address lines and note.
                </div>
              </div>
            )}

            {/* ── Customer ────────────────────────────────────────────── */}
            <div className="card" style={{ marginBottom: 11 }}>
              <div className="card-h"><span className="card-t">Customer</span></div>
              <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                <Field label="Customer Name *" error={touched && nameErr} scanned={scanned("name", name)}>
                  <input className="fld-i" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lim Mei Hua" />
                </Field>
                <Field label="Phone *" error={touched && phoneErr} scanned={scanned("phone", phone)}>
                  <PhoneInput className="fld-i" value={phone} onChange={setPhone} placeholder="1X-XXX XXXX" />
                </Field>
                <Field label="Email" error={touched && emailErr}>
                  <input className="fld-i" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Optional" />
                </Field>
                <div style={{ display: "flex", gap: 9 }}>
                  {/* FIX A — Customer Type from so_dropdown_options (was hardcoded). */}
                  <Field label="Customer Type" style={{ flex: 1 }} scanned={scanned("custType", custType)}>
                    <select className="fld-i" value={custType} onChange={(e) => setCustType(e.target.value)}>
                      <option value="">—</option>
                      {custType && !customerTypeOpts.some((o) => o.value === custType) && (
                        <option value={custType}>{custType}</option>
                      )}
                      {customerTypeOpts.map((t) => <option key={t.id} value={t.value}>{t.label}</option>)}
                    </select>
                  </Field>
                  {/* FIX A — Salesperson defaults to the signed-in user; only a
                      user with scm.so.attribute_other can re-pick (desktop parity).
                      Non-admins see a disabled select pinned to themselves. */}
                  <Field label="Salesperson" style={{ flex: 1 }}>
                    <SearchableSelect
                      className="fld-i"
                      ariaLabel="Salesperson"
                      placeholder="— Pick staff —"
                      value={salespersonId}
                      onChange={setSalespersonId}
                      disabled={!canChangeSalesperson}
                      options={[
                        ...(canChangeSalesperson
                          ? staffList
                              .map((s) => ({ value: s.id, label: s.name }))
                              .sort((a, b) =>
                                a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
                          : selfStaffMatch
                            ? [{ value: selfStaffMatch.id, label: selfStaffMatch.name }]
                            : []),
                      ]}
                    />
                  </Field>
                </div>
                <Field label="Customer SO Ref" scanned={scanned("custRef", custRef)}>
                  <input className="fld-i" value={custRef} onChange={(e) => setCustRef(e.target.value)} placeholder="Their PO / SO number" />
                </Field>
              </div>
            </div>

            {/* ── Emergency Contact ───────────────────────────────────── */}
            <div className="card" style={{ marginBottom: 11 }}>
              <div className="card-h"><span className="card-t">Emergency Contact</span><span className="card-sub">If we can't reach the customer</span></div>
              <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                <Field label="Contact Name">
                  <input className="fld-i" value={ecName} onChange={(e) => setEcName(e.target.value)} placeholder="e.g. Lim Mei Hua" />
                </Field>
                {/* FIX A — Relationship from so_dropdown_options (was hardcoded). */}
                <Field label="Relationship">
                  <select className="fld-i" value={ecRel} onChange={(e) => setEcRel(e.target.value)}>
                    <option value="">—</option>
                    {ecRel && !relationshipOpts.some((o) => o.value === ecRel) && (
                      <option value={ecRel}>{ecRel}</option>
                    )}
                    {relationshipOpts.map((t) => <option key={t.id} value={t.value}>{t.label}</option>)}
                  </select>
                </Field>
                <Field label="Phone">
                  <PhoneInput className="fld-i" value={ecPhone} onChange={setEcPhone} placeholder="1X-XXX XXXX" />
                </Field>
              </div>
            </div>

            {/* ── Order info ──────────────────────────────────────────── */}
            <div className="card" style={{ marginBottom: 11 }}>
              <div className="card-h"><span className="card-t">Order info</span></div>
              <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                <div style={{ display: "flex", gap: 9 }}>
                  {/* FIX A — Building Type from so_dropdown_options (was hardcoded). */}
                  <Field label="Building Type" style={{ flex: 1 }} scanned={scanned("buildingType", buildingType)}>
                    <select className="fld-i" value={buildingType} onChange={(e) => setBuildingType(e.target.value)}>
                      <option value="">—</option>
                      {buildingType && !buildingTypeOpts.some((o) => o.value === buildingType) && (
                        <option value={buildingType}>{buildingType}</option>
                      )}
                      {buildingTypeOpts.map((t) => <option key={t.id} value={t.value}>{t.label}</option>)}
                    </select>
                  </Field>
                  {/* Owner 2026-07-04 — Venue is a real select (was read-only).
                      Defaults to the derived venue (salesperson's active project
                      / home venue / persisted on edit); the operator can override
                      from the venues master, mirroring desktop SalesOrderNew. */}
                  <Field label="Venue" style={{ flex: 1 }}>
                    <select
                      className="fld-i"
                      value={effectiveVenueId ?? ""}
                      onChange={(e) => setPickedVenueId(e.target.value || null)}
                    >
                      <option value="">—</option>
                      {effectiveVenueId && !(venuesQ.data ?? []).some((v) => v.id === effectiveVenueId) && (
                        <option value={effectiveVenueId}>{effectiveVenueName || resolvedVenueName || effectiveVenueId}</option>
                      )}
                      {(venuesQ.data ?? []).map((v) => (
                        <option key={v.id} value={v.id}>{v.name}</option>
                      ))}
                    </select>
                  </Field>
                </div>
                {!isEdit && autoVenue?.venueId &&
                  (pickedVenueId == null || pickedVenueId === autoVenue.venueId) && (
                  <div style={{ fontSize: 10, color: "#16695f", marginTop: -4 }}>
                    {autoVenue.source === "SHOWROOM"
                      ? `Auto-filled from your showroom${autoVenue.showroomName ? ` (${autoVenue.showroomName})` : ""}`
                      : autoVenue.projectName
                        ? `Auto-filled from ${autoVenue.projectName}`
                        : "Auto-filled"}
                  </div>
                )}
                {/* FIX D3 — once the processing date has passed the SO is locked
                    (it's what we PO to the supplier); the date inputs freeze.
                    Owner 2026-07-16 — UNLESS the order is amendment-eligible:
                    then both dates are editable and go out as an amendment
                    request for approval instead of saving directly. */}
                <Field label="Processing Date" error={touched && dateXorErr} scanned={scanned("procDate", procDate)} onClear={procDate && !scheduleDatesLocked ? () => setProcDate("") : undefined}>
                  <DateField
                    fullWidth
                    className="fld-i"
                    value={procDate}
                    disabled={scheduleDatesLocked}
                    min={procLocked ? undefined : today}
                    onChange={(iso) => setProcDate(iso)}
                  />
                </Field>
                <Field label="Delivery Date" error={touched && dateXorErr} scanned={scanned("delivDate", delivDate)} onClear={delivDate && !scheduleDatesLocked ? () => setDelivDate("") : undefined}>
                  <DateField
                    fullWidth
                    className="fld-i"
                    value={delivDate}
                    disabled={scheduleDatesLocked}
                    min={today}
                    onChange={(iso) => setDelivDate(iso)}
                  />
                </Field>
                <div style={{ fontSize: 10, color: "#9aa093", marginTop: -3 }}>
                  {amendmentMode
                    ? "Changing a date here submits an amendment request — it applies once approved."
                    : "Set both dates together, or leave both empty to keep this a draft."}
                </div>
                <Field label="Note" scanned={scanned("note", note)}>
                  <input className="fld-i" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Internal notes — SO detail only" />
                </Field>
                <div style={{ display: "flex", gap: 9 }}>
                  {/* FIX A — Country derives from the picked State (my_localities). */}
                  <Field label="Country" style={{ flex: 1 }}>
                    <div className="fld-ro">{country}</div>
                  </Field>
                  {/* Sales Location derives from state → warehouse mapping. */}
                  <Field label="Sales Location" style={{ flex: 1 }}>
                    <div className="fld-ro">{salesLocation || (state ? "Not mapped" : "Pick a state")}</div>
                  </Field>
                </div>
              </div>
            </div>

            {/* ── Delivery address ────────────────────────────────────── */}
            <div className="card" style={{ marginBottom: 11 }}>
              <div className="card-h"><span className="card-t">Delivery address</span></div>
              <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {addressRequired && (
                  <div style={{ fontSize: 10.5, color: "#a16a2e", background: "#fbf3e6", border: "1px solid #ecd9b6", borderRadius: 10, padding: "7px 10px" }}>
                    Both a Processing and a Delivery date are set, so the full delivery address (State, City, Postcode and Address Line 1) is required.
                  </div>
                )}
                <Field label={addressRequired ? "Address Line 1 *" : "Address Line 1"} error={touched && addressRequired && !addr1.trim()} scanned={scanned("addr1", addr1)}>
                      <input className="fld-i" value={addr1} onChange={(e) => setAddr1(e.target.value)} placeholder="Unit, street, area" />
                    </Field>
                    <Field label="Address Line 2">
                      <input className="fld-i" value={addr2} onChange={(e) => setAddr2(e.target.value)} placeholder="Apt, floor, building (optional)" />
                    </Field>
                    {/* FIX A — cascading State → City → Postcode from my_localities
                        (desktop parity). When the dataset is present these are
                        dependent dropdowns; when it's empty they fall back to
                        free-text inputs (the vendor no-data behaviour).
                        FIX D2 — State/City/Postcode freeze once the processing
                        date has passed (identity columns feed the supplier PO). */}
                    {/* Address MVP2 (2026-07-23) — the shared StatePicker in
                        compact mode. MY states listed first, then CN + SG
                        grouped under their country in native <optgroup>s the
                        OS picker respects (iOS wheel picker, Android list).
                        No `(legacy)` fallback option, no `<select> → <input>`
                        free-text branch — a state not in scm.my_localities
                        must be added via the Localities Maintenance UI first. */}
                    <Field label={addressRequired ? "State *" : "State"} error={touched && addressRequired && !state.trim()} scanned={scanned("state", state)}>
                      <StatePicker
                        compact
                        value={state}
                        disabled={addressIdentityLocked}
                        placeholder="Pick state"
                        selectClassName="fld-i"
                        onChange={(next) => onStateChange(next)}
                      />
                    </Field>
                    <div style={{ display: "flex", gap: 11 }}>
                      {/* Address MVP2 (2026-07-23) — City + Postcode are
                          dropdown-only from scm.my_localities, matching the
                          desktop rule. Removed the hidden legacy fallback
                          option (`{v && !opts.includes(v) && <option>v</option>}`)
                          and the `<input>` free-text branch — a value not in
                          the seeded set forces the operator to add it via
                          the Localities Maintenance UI. When no state is
                          picked the picker offers the cross-state pool so
                          the operator can pick City/Postcode first and let
                          state resolve back via resolvePostcode /
                          resolveCityState. */}
                      <Field label={addressRequired ? "City *" : "City"} style={{ flex: 1 }} error={touched && addressRequired && !city.trim()} scanned={scanned("city", city)}>
                        <select
                          className="fld-i"
                          value={city}
                          disabled={addressIdentityLocked || cityChoices.length === 0}
                          onChange={(e) => onCityChange(e.target.value)}
                        >
                          <option value="">
                            {cityChoices.length === 0 ? "No cities seeded" : cityPlaceholder(state)}
                          </option>
                          {cityChoices.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </Field>
                      <Field label={addressRequired ? "Postcode *" : "Postcode"} style={{ flex: 1 }} error={touched && addressRequired && !postcode.trim()} scanned={scanned("postcode", postcode)}>
                        <select
                          className="fld-i"
                          value={postcode}
                          disabled={addressIdentityLocked || postcodeChoices.length === 0}
                          onChange={(e) => onPostcodeChange(e.target.value)}
                        >
                          <option value="">
                            {postcodeChoices.length === 0 ? "No postcodes seeded" : postcodePlaceholder(state, city)}
                          </option>
                          {postcodeChoices.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                      </Field>
                    </div>
                    {addressIdentityLocked ? (
                      <div style={{ fontSize: 10, color: "#a16a2e", marginTop: -3 }}>
                        State, City, Postcode and the address lines are locked — this order&apos;s processing date has passed and it is now on order to the supplier.
                      </div>
                    ) : null}
                    {amendmentMode && (
                      <div style={{ fontSize: 10, color: "#a16a2e", marginTop: -3 }}>
                        Changing the State, City, Postcode or an address line submits an amendment request — it applies once approved.
                      </div>
                    )}
              </div>
            </div>

            {/* ── Line items ──────────────────────────────────────────── */}
            <div className="card" style={{ marginBottom: 11 }}>
              <div className="card-h"><span className="card-t">Line items</span><span className="card-sub">{`${lines.length} ${lines.length === 1 ? "line" : "lines"}`}</span></div>
              <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {/* Amendment-mode banner (Phase 1-C) — the SO is on order to the
                    supplier but still editable via the amendment flow; the primary
                    Save submits an amendment request, not a direct edit. Mirrors
                    the desktop SalesOrderDetail amendment banner. */}
                {amendmentMode && (
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8, background: "rgba(232,107,58,0.08)", border: "1px solid var(--c-orange, #e86b3a)", borderRadius: 10, padding: "9px 11px", fontSize: 11, color: "#8a4a24", lineHeight: 1.45 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c66a34" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
                    {/* Shared with desktop — both were wrong about addresses. */}
                    <span>{AMENDMENT_MODE_BANNER}</span>
                  </div>
                )}
                {lineEditingBlocked ? (
                  <>
                    {lines.length ? lines.map((l) => (
                      <div key={l.key} style={roItemBox}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                          {/* Same rule as the editable row above it — description
                              first, code only as the fallback. This row is the one
                              #651's lesson predicts you miss: it is the read-only
                              twin of the picker button in THIS SAME FILE, and it
                              was code-first with no instruction behind it, purely
                              because it was copied. minWidth:0 lets a long name
                              wrap instead of shouldering the price off the row. */}
                          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: "#11140f", overflowWrap: "anywhere" }}>{lineIdentity({ code: l.itemCode, description: l.name }).primary || "—"} <span style={{ color: "#9aa093" }}>{"×"}{num(l.qty)}</span></span>
                          <span className="money" style={{ flex: "none", whiteSpace: "nowrap", fontSize: 12.5, fontWeight: 800, color: "#0c3f39" }}>RM {fmt((toSen(l.price) * num(l.qty)) / 100)}</span>
                        </div>
                      </div>
                    )) : <div style={{ fontSize: 11.5, color: "#9aa093", padding: "8px 0" }}>No items.</div>}
                    {/* FIX D2/D3 — distinguish the lock reasons in the notice. An
                        already-open amendment takes precedence (procLocked but a
                        second amendment can't be raised yet). */}
                    <div style={{ fontSize: 10, color: "#9aa093", marginTop: 4 }}>
                      {hasOpenAmend
                        ? "An amendment is already pending on this order — line items are locked until it is confirmed or rejected. View its status on the order detail screen."
                        : procLocked
                        ? "This order's processing date has passed — it is on order to the supplier, so line items can no longer be changed."
                        : "This order is shipped or has downstream documents — line items can no longer be changed."}
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                      {lines.map((l, i) => (
                        <LineCard
                          key={l.key}
                          line={l}
                          index={i}
                          pools={pools}
                          removable={lines.length > 1}
                          /* Red "missing axis" ring only once a Processing Date
                             is set — matches the backend variants gate + the
                             save block above (owner 2026-07-14). */
                          showErrors={touched && Boolean(procDate)}
                          onOpenPicker={() => setPickerFor(l.key)}
                          onOpenFabricPicker={() => setFabricPickerFor(l.key)}
                          onOpenSpecialPicker={() => setSpecialPickerFor(l.key)}
                          showPrices={showSpecialPrices}
                          canEditPrice={canEditPrice}
                          onChange={(patch) => patchLine(l.key, patch)}
                          onDdateChange={(v) => setLineDdateManual(l.key, v)}
                          onRemove={async () => {
                            if (!(await confirm({ title: "Remove this line?", body: l.name ? `"${l.name}" will be removed from the order.` : undefined, confirmLabel: "Remove", danger: true }))) return;
                            setDdateOverrides((prev) => {
                              if (!prev.has(l.key)) return prev;
                              const next = new Set(prev);
                              next.delete(l.key);
                              return next;
                            });
                            setLines((prev) => prev.filter((x) => x.key !== l.key));
                          }}
                        />
                      ))}
                    </div>
                    <button className="addline" onClick={() => setLines((p) => [...p, newLine()])}>+ Add Line Item</button>
                  </>
                )}
                <div className="so-sub-row"><span style={{ fontSize: 11, color: "var(--mut)" }}>Subtotal</span><span className="money" style={{ fontSize: 17, fontWeight: 800, color: "var(--brand-d)" }}>RM {fmt(subtotal / 100)}</span></div>
                <div style={{ fontSize: 10, color: "#9aa093" }}>Prices are recomputed by the system when you save.</div>
              </div>
            </div>

            {/* ── Payment ─────────────────────────────────────────────── */}
            <div className="card" style={{ marginBottom: 11 }}>
              <div className="card-h"><span className="card-t">Payments</span><span className="card-sub">Method · amount · slip</span></div>
              <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {isEdit && existingPays.length > 0 && (
                  <>
                    <div className="fld-l" style={{ marginBottom: 2 }}>Recorded</div>
                    {/* Owner 2026-07-16 ("我還沒有點 edit draft 可以 edit payment,
                        反而點了 edit draft 不給 edit") — recorded payments render
                        through the SHARED RecordedPaymentsList, the SAME component
                        the SO detail / scan-draft review screen uses, so entering
                        Edit keeps the pencil + trash instead of dropping to a
                        read-only box. This block used to be a second, read-only
                        copy of the row (info only) — the drift that inverted
                        editability. `inset` is layout only (rows sit inside this
                        padded card body); the gates below are desktop-verbatim. */}
                    <RecordedPaymentsList
                      docNo={docNo ?? ""}
                      payments={existingPays as RecordedPayment[]}
                      staff={pickableStaffQ.data ?? []}
                      /* Desktop parity (SalesOrderDetail renders PaymentsTable with
                         locked={!isDraftSo && (isLocked || !isEditing)}): inside the
                         editor isEditing is always true, so the rule collapses to
                         DRAFT ⇒ always editable, otherwise editable unless the SO is
                         terminal / has downstream children. */
                      canEdit={isDraftSo || !lineLocked}
                      draftUnlocked={isDraftSo}
                      inset
                      onChanged={reloadExistingPays}
                    />
                    <div style={{ height: 4 }} />
                  </>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                  {pays.map((p) => (
                    <PayCard
                      key={p.key}
                      pay={p}
                      staff={pickableStaffQ.data ?? []}
                      onChange={(patch) => setPays((prev) => prev.map((x) => (x.key === p.key ? { ...x, ...patch } : x)))}
                      onRemove={() => setPays((prev) => prev.filter((x) => x.key !== p.key))}
                    />
                  ))}
                </div>
                <button className="addline" onClick={() => setPays((p) => [...p, newPayment()])}>+ Add Payment</button>
                {/* Owner 2026-08-13 — the slip is optional, so this line no
                    longer claims a row without one is only "planned". Every
                    amount-bearing row is recorded; the slip can follow later
                    from the SO detail screen. */}
                {!!pays.length && (
                  <div style={{ fontSize: 10, color: "#767b6e", marginTop: 6 }}>
                    Payments are recorded on the order when you {isEdit ? "Save" : "Create"}. A slip is optional — attach one here, or add it later from the SO detail screen.
                  </div>
                )}
              </div>
            </div>

            {/* pre-line so a multi-reason message (humanApiError joins them with
                newlines) lists in full instead of collapsing onto one line. */}
            {error && <div style={{ marginTop: 4, fontSize: 12, color: "#b23a3a", textAlign: "center", padding: "0 4px", whiteSpace: "pre-line" }}>{error}</div>}
          </>
        )}
      </div>

      {/* Action bar — single primary action per mode+status. Balanced,
          full-width buttons (no Back/Next). */}
      {!loading && (
        <footer id="nso-footer" className="actbar" style={{ display: "flex", gap: 9 }}>
          {mode === "edit" ? (
            <button className="btn" disabled={submitting} onClick={() => save(false)} style={{ flex: 1, opacity: submitting ? 0.6 : 1 }}>
              {submitting ? (amendmentMode ? "Submitting…" : "Saving…") : amendmentMode ? "Submit Amendment" : "Save Changes"}
            </button>
          ) : (
            <>
              {/* Equal-width pair (owner 2026-07-03): flex:1 + flexBasis:0 +
                  minWidth:0 so both buttons take exactly half the row regardless
                  of label length, and a shared height so the pair reads balanced
                  (.btn sizes via padding, .btn-ghost via height — pin both to 48). */}
              <button className="btn-ghost" disabled={submitting} onClick={() => save(true)} style={{ flex: "1 1 0", minWidth: 0, height: 48, opacity: submitting ? 0.6 : 1 }}>
                {submitting ? "Saving…" : "Save draft"}
              </button>
              <button className="btn" disabled={submitting} onClick={() => save(false)} style={{ flex: "1 1 0", minWidth: 0, height: 48, padding: 0, opacity: submitting ? 0.6 : 1 }}>
                {submitting ? "Saving…" : "Create Sales Order"}
              </button>
            </>
          )}
        </footer>
      )}

      {pickerFor && (() => {
        /* FIX C — seed a base line with a picked SKU's REAL catalog identity so
           the line resolves to the actual product (was: after "Add product" the
           line stayed a blank "General item / RM 0.00" because the picked SKU
           wasn't applied). `itemCode` is the catalog code the whole form keys on
           (picked = Boolean(itemCode), the save() unpicked-line guard, the line
           variant panels, and the create/edit item body all read it). `cat`
           derives from the picked group so the right variant panel shows; the
           unit price defaults from the catalog (server recompute is authoritative
           on save). Changing the SKU resets the variant blob (a bedframe's divan
           pool differs from a sofa's) but seeds same-category followers from the
           FIRST line's variants (mirrors SoLineCard.pickProduct inherit);
           overriddenKeys resets on a fresh pick. Shared by single-pick and
           multi-pick so every seeded line is identical.
           GUARD: a SKU with no code can't identify a product — never overwrite
           the base line with a phantom "picked-but-blank" row (that is the exact
           state the owner reported); leave the base line untouched instead. */
        const seedLine = (base: LineItem, sku: PickedSku): LineItem => {
          const code = (sku.itemCode ?? "").trim();
          if (!code) return base; // never silently seed an unidentifiable line
          const group = (sku.itemGroup ?? "").trim().toLowerCase();
          const nextCat = catForGroup(group);
          const inherited = inheritVariantsByCategory[group];
          /* seedFollowerVariants drops the keys that must never travel between
             lines (remark, and the build identity of another sofa). */
          const seededVariants = inherited && Object.keys(inherited).length > 0
            ? seedFollowerVariants(inherited)
            : seedFollowerVariants(nextCat === base.cat ? base.variants : {});
          return {
            ...base,
            itemCode: code,
            itemGroup: group,
            name: (sku.name ?? "").trim() || code,
            cat: nextCat,
            price: fromSen(sku.unitPriceSen),
            variants: seededVariants,
            overriddenKeys: [],
          };
        };
        return (
          <MobileSkuPicker
            initialCat={mapPickerCat(lines.find((l) => l.key === pickerFor)?.cat)}
            onClose={() => setPickerFor(null)}
            onPick={(sku: PickedSku) => {
              setLines((prev) => prev.map((x) => (x.key === pickerFor ? seedLine(x, sku) : x)));
              setPickerFor(null);
            }}
            onPickMany={(skus: PickedSku[]) => {
              // FIX E — `skus` already arrives in the order the operator TAPPED
              // the rows (MobileSkuPicker keeps an order-preserving pick list), so
              // the lines below land in selection order 1,2,3,4 (not catalog
              // order). Drop any code-less entries so a stray pick can't insert a
              // blank line.
              const valid = skus.filter((s) => (s.itemCode ?? "").trim());
              if (valid.length === 0) { setPickerFor(null); return; }
              setLines((prev) => {
                const idx = prev.findIndex((x) => x.key === pickerFor);
                if (idx < 0) return prev;
                // First selection fills the line the picker was opened for; the
                // rest append as fresh lines (each seeded off a blank newLine so
                // it's a proper pickable line). The follower-inherit effect then
                // cascades the first sofa line's fabric/seat/leg to these new
                // sofa followers, with any manual override winning.
                const next = [...prev];
                next[idx] = seedLine(next[idx]!, valid[0]!);
                const extras = valid.slice(1).map((sku) => seedLine(newLine(), sku));
                next.splice(idx + 1, 0, ...extras);
                return next;
              });
              setPickerFor(null);
            }}
          />
        );
      })()}

      {fabricPickerFor && (() => {
        const line = lines.find((l) => l.key === fabricPickerFor);
        return (
          <FabricPicker
            pools={pools}
            current={String(line?.variants.fabricCode ?? "")}
            onClose={() => setFabricPickerFor(null)}
            onPick={(c) => {
              const colourId = c.colourId;
              const seriesLabel = pools.fabricSeries.get(c.fabricId) ?? null;
              const patch: Record<string, unknown> = {
                fabricCode: colourId,
                colourId,
                fabricId: c.fabricId,
                ...(seriesLabel ? { fabricLabel: seriesLabel } : {}),
                ...(c.label ? { colourLabel: c.label } : {}),
                ...(c.swatchHex ? { colourHex: c.swatchHex } : {}),
              };
              const targetBk = (line?.variants as { buildKey?: unknown } | undefined)?.buildKey;
              const cascadeBk = typeof targetBk === "string" && targetBk !== "" ? targetBk : null;
              setLines((prev) => prev.map((x) => {
                if (x.key === fabricPickerFor) {
                  const overrides = Array.from(new Set([...x.overriddenKeys, ...Object.keys(patch)]));
                  return { ...x, variants: { ...x.variants, ...patch }, overriddenKeys: overrides };
                }
                /* Sofa compartment colour auto-sync — the other compartments of
                   the SAME sofa (same variants.buildKey) follow this colour,
                   unless a compartment manually overrode its own fabricCode. */
                const xbk = (x.variants as { buildKey?: unknown } | null)?.buildKey;
                if (cascadeBk && xbk === cascadeBk && !x.overriddenKeys.includes("fabricCode")) {
                  return { ...x, variants: { ...x.variants, ...patch } };
                }
                return x;
              }));
              setFabricPickerFor(null);
            }}
          />
        );
      })()}

      {specialPickerFor && (() => {
        const line = lines.find((l) => l.key === specialPickerFor);
        if (!line) return null;
        return (
          <SpecialOrderSheet
            line={line}
            pools={pools}
            showPrices={showSpecialPrices}
            onClose={() => setSpecialPickerFor(null)}
            onChange={(patch) => patchLine(specialPickerFor, patch)}
          />
        );
      })()}
    </div>
  );
}

/* LineCat → the SKU picker's category chip seed. */
function mapPickerCat(c: LineCat | undefined): "" | "sofa" | "bedframe" {
  return c === "sofa" ? "sofa" : c === "bedframe" ? "bedframe" : "";
}

/* The phone fields hold the CANONICAL E.164 string ("+60123456789"), not the
   national part. They used to hold national digits beside a hardcoded "+60"
   box, which meant a Singapore or Indonesian customer simply could not be
   entered on a phone — the country was a literal in the markup. PhoneInput
   owns the country now (defaulting to Malaysia), and it emits E.164, so every
   "+60" + digits concatenation this file used to perform is gone.

   Coercing a STORED value: rows written before the API normalised hold the
   local "0…" form (the 2026-07-22 audit found sales_orders.phone was 2916 of
   2916 like that), so normalizePhone is applied on the way in. It returns null
   for anything it cannot read, and the raw value is kept in that case rather
   than blanked — an unreadable number is still the customer's number. */
function toE164(p: string | null | undefined): string {
  return normalizePhone(p) ?? (p ?? "").trim();
}

/** The raw form values the SO header fields are built from. Every transform
    (trim, "+60" phone, '' -> null) lives in soHeaderPatchFrom below, so the
    EDIT patch, the CREATE body and the pristine baseline the edit diffs against
    can never drift apart — they are one function called three times. */
type SoHeaderPatchInput = {
  name: string; custRef: string; phone: string; email: string;
  custType: string; buildingType: string;
  venueId: string | null; venueName: string;
  note: string; addr1: string; addr2: string; state: string;
  city: string; postcode: string; salesLocation: string;
  procDate: string; delivDate: string;
  ecName: string; ecPhone: string; ecRel: string;
  salespersonId: string | null;
};

/** The SO header fields exactly as the API takes them. PURE — same input, same
    object, so an untouched form yields a byte-identical baseline and only a
    genuine edit survives diffHeaderPayload. */
function soHeaderPatchFrom(v: SoHeaderPatchInput): Record<string, unknown> {
  return {
    debtorName: v.name.trim(),
    customerSoNo: v.custRef.trim() || null,
    phone: v.phone.trim(),
    email: v.email.trim() || null,
    customerType: v.custType || null,
    buildingType: v.buildingType || null,
    venueId: v.venueId ?? undefined,
    venue: v.venueName || null,
    note: v.note.trim() || null,
    address1: v.addr1.trim() || null,
    address2: v.addr2.trim() || null,
    customerState: v.state || null,
    city: v.city.trim() || null,
    postcode: v.postcode.trim() || null,
    salesLocation: v.salesLocation || undefined,
    processingDate: v.procDate || null,
    customerDeliveryDate: v.delivDate || null,
    emergencyContactName: v.ecName.trim() || null,
    emergencyContactPhone: v.ecPhone.trim() || null,
    emergencyContactRelationship: v.ecRel || null,
    salespersonId: v.salespersonId,
  };
}

// ---- Sub-components ---------------------------------------------------------

function Field({ label, error, scanned, onClear, style, children }: { label: string; error?: boolean; scanned?: boolean; onClear?: () => void; style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <label className="fld" style={style}>
      <span className="fld-l" style={{ display: "flex", alignItems: "center", gap: 6, ...(error ? { color: "#b23a3a" } : null) }}>
        {label}
        {scanned && <ScannedTag />}
        {/* A native date input has no way back once a value is set — the iOS
            wheel cannot land on "nothing". Owner, 2026-08-03: "当他不小心选了一个
            日期，它不能 reset 的吗?". A label-level Clear costs no row width, which
            the three-across line row has none of. */}
        {onClear && (
          <span
            role="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClear(); }}
            style={{ marginLeft: "auto", color: "#9aa093", fontSize: 9, fontWeight: 700, letterSpacing: ".04em", cursor: "pointer", padding: "0 2px" }}
          >
            CLEAR
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

function ScannedTag() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "1px 6px", borderRadius: 999, background: "#eaf2f0", color: "#16695f", fontSize: 8, fontWeight: 700, letterSpacing: ".04em" }}>
      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>
      SCANNED
    </span>
  );
}

/* ── Variant pool → option list builders (REAL sources) ─────────────────── */
/* The restrict step is the SHARED restrictStringsToPool / restrictPricedToPool
   (the same helpers PoLineCard and PcVariantEditor call), not a private copy —
   a per-editor copy is how the allowed_options rule drifted before.
   `keep` is deliberately NOT passed here: desktop needs it because its raw
   <select> can only show what its <option> list holds, whereas SpecSel below
   re-adds an off-pool stored value as "<value> (current)" at the render layer.
   So the rule — a saved value the Model no longer permits stays VISIBLE — holds
   on both platforms; only the presentation differs, which is mobile's to own. */
function sortNumeric<T extends { value: string }>(opts: T[]): T[] {
  return [...opts].sort((a, b) => {
    const na = parseInches(a.value), nb = parseInches(b.value);
    if (na !== nb) return na - nb;
    return a.value.localeCompare(b.value, undefined, { sensitivity: "base" });
  });
}

function LineCard({
  line,
  index,
  pools,
  removable,
  showErrors,
  onOpenPicker,
  onOpenFabricPicker,
  onOpenSpecialPicker,
  showPrices,
  canEditPrice,
  onChange,
  onDdateChange,
  onRemove,
}: {
  line: LineItem;
  index: number;
  pools: VariantPools;
  removable: boolean;
  showErrors: boolean;
  onOpenPicker: () => void;
  onOpenFabricPicker: () => void;
  /* Unified special-order entry — opens the bottom sheet (presets + Custom /
     other). Replaces the old inline Specials accordion. */
  onOpenSpecialPicker: () => void;
  /* Owner-approved role gate — false for non-admin sales (hide RM amounts). */
  showPrices: boolean;
  /* Unit-price lock (SO-SKU spec D4) — false for everyone below admin, so the
     price follows the SKU Master sell price and cannot be hand-typed. */
  canEditPrice: boolean;
  onChange: (patch: Partial<LineItem>) => void;
  /* FIX D1(b) — a manual Item Delivery Date edit routes through here so the
     parent can flag the line as an override the header cascade won't touch. */
  onDdateChange: (value: string) => void;
  onRemove: () => void;
}) {
  const amt = fmt(num(line.qty) * num(line.price));
  const picked = Boolean(line.itemCode.trim());
  const v = line.variants;
  const photoInputRef = useRef<HTMLInputElement | null>(null);

  /* Per-SKU allowed_options (Modular ON/OFF), resolved by code. */
  const allowQ = useModelAllowedOptionsByCode(line.itemCode || undefined);
  const allow = allowQ.data ?? null;

  /* A variant edit marks the key as manually-overridden so the follower cascade
     leaves it alone (mirrors SoLineCard setVariants + overriddenKeys). */
  const setVar = (patch: Record<string, unknown>) => {
    const overrides = Array.from(new Set([...line.overriddenKeys, ...Object.keys(patch)]));
    onChange({ variants: { ...line.variants, ...patch }, overriddenKeys: overrides });
  };

  const maint = pools.maint;

  /* Recognise a generic-typed draft + seed the sofa Leg default (owner
     2026-07-13) — parity with the desktop SoLineCard heal. A scan/backdoor
     draft can persist a sofa/bedframe SKU under a generic item_group ('others'),
     which renders as a "General item" with no configurator. Resolve the SKU's
     REAL category by code and, when it disagrees with the line's cat, rewrite
     cat + itemGroup so the right panel shows and its variants become required.
     For sofa, also default Leg Height to the "Default" option (RM 0.00) when
     unset, so it is never an empty required field. */
  const skuCategoryQ = useSkuCategoryByCode(line.itemCode || undefined);
  useEffect(() => {
    if (!picked) return;
    const resolved = String(skuCategoryQ.data ?? "").toLowerCase();
    const patch: Partial<LineItem> = {};
    if ((resolved === "sofa" || resolved === "bedframe" || resolved === "mattress")
        && line.cat !== resolved) {
      patch.cat = resolved as LineCat;
      patch.itemGroup = resolved;
    }
    const effCat = patch.cat ?? line.cat;
    if (effCat === "sofa" && maint
        && isBlankVar(v.legHeight) && isBlankVar(v.sofaLegHeight)) {
      const def = defaultSofaLegValue(maint);
      if (def) patch.variants = { ...line.variants, ...(patch.variants ?? {}), legHeight: def };
    }
    if (Object.keys(patch).length > 0) onChange(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, skuCategoryQ.data, maint, line.cat, line.itemCode]);

  const fabVal = String(v.fabricCode ?? "");
  const fabColourLabel = String(v.colourLabel ?? "");

  // Sofa pools (real): seat = sofaSizes (string), leg = sofaLegHeights (priced)
  const sofaSeatOpts = maint
    ? restrictStringsToPool(maintPickerValues(maint.sofaSizes, String(v.seatHeight ?? "")), allow?.sizes).map((s) => ({ value: s, label: s }))
    : [];
  const sofaLegOpts = maint
    ? sortNumeric(restrictPricedToPool(activeOptions(maint.sofaLegHeights, String(v.legHeight ?? "")), allow?.leg_heights)).map((o) => ({ value: o.value, label: o.value }))
    : [];

  // Bedframe pools (real): gap (string), divan + leg (priced)
  const bfGapOpts = maint
    ? restrictStringsToPool(maintPickerValues(maint.gaps, String(v.gap ?? "")), allow?.gaps).map((g) => ({ value: g, label: g }))
    : [];
  const bfDivanOpts = maint
    ? sortNumeric(restrictPricedToPool(activeOptions(maint.divanHeights, String(v.divanHeight ?? "")), allow?.divan_heights)).map((o) => ({ value: o.value, label: o.value }))
    : [];
  const bfLegOpts = maint
    ? sortNumeric(restrictPricedToPool(activeOptions(maint.legHeights, String(v.legHeight ?? "")), allow?.leg_heights)).map((o) => ({ value: o.value, label: o.value }))
    : [];

  const missing = new Set(missingVariantAxes(line.itemGroup, line.variants, line.itemCode).map((a) => a.key));

  /* ── Special orders (unified entry) — the editing UI moved to the
     SpecialOrderSheet bottom sheet (owner-approved). Here we only derive a
     one-line summary for the tappable "Special order" row. Presets live on
     variants.specials; the "Custom / other" free-text order on the UNCHANGED
     variants.extraAddonNote + extraAddonAmountRM. */
  const specialsList = (val: unknown): string[] => {
    if (Array.isArray(val)) return val.map(String).filter(Boolean);
    if (typeof val === "string" && val) return [val];
    return [];
  };
  const pickedSpecials = specialsList(v.specials ?? v.special);
  const extraNote = String(v.extraAddonNote ?? "");
  const extraAmountRM = Number(v.extraAddonAmountRM ?? 0);
  const hasCustom = Boolean(extraNote.trim()) || extraAmountRM > 0;
  const specialCount = pickedSpecials.length + (hasCustom ? 1 : 0);

  const addPhotos = (files: File[]) => {
    if (files.length === 0) return;
    onChange({ photoFiles: [...line.photoFiles, ...files] });
  };
  const removeStagedPhoto = (idx: number) => {
    onChange({ photoFiles: line.photoFiles.filter((_, i) => i !== idx) });
  };

  return (
    /* Owner 2026-07-04 — hairline borders (--line2 #eceee9); the old
       rgba(34,31,32,.12) dividers read visually heavy on the phone. */
    <div style={{ border: "1px solid #eceee9", borderRadius: 11, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "#f4f6f3", borderBottom: "1px solid #eceee9" }}>
        <span style={{ width: 19, height: 19, flex: "none", borderRadius: 6, background: "#16695f", color: "#fff", fontSize: 10.5, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>{index + 1}</span>
        <button
          type="button"
          onClick={onOpenPicker}
          style={{
            flex: 1, minWidth: 0, textAlign: "left", fontFamily: "inherit", cursor: "pointer",
            background: "#fff", border: picked ? "1px solid #bcdcd7" : "1px dashed #c2c6bd",
            borderRadius: 9, padding: "6px 9px", display: "flex", alignItems: "center", gap: 7,
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            {picked ? (
              /* SUPERSEDED, owner 2026-07-17 ("根據你的") — this button used to
                 show ONLY the product Code (owner 2026-07-03), because the long
                 name got squeezed/truncated in this narrow row. That was a fix for
                 TRUNCATION, and the truncation was self-inflicted: the row forced
                 the name through overflow:hidden + ellipsis + nowrap, so of course
                 it never fit. #626 solved the same tension on the SKU picker the
                 right way — let the name take the full width and WRAP. This row
                 now does that (overflowWrap; the header grows a line taller, it
                 has no fixed height), so the code-swap is unnecessary and the
                 button reads the same rule as every other surface.
                 The name is only DISPLAY here: `line.itemCode` is what the form
                 keys on (picked, the save() guard, the variant panels, the
                 create/edit body) and is untouched. `lineIdentity` falls back to
                 the code when a line has no name, so a row is never unidentifiable.
                 The variant is NOT shown here on purpose — the variant panels sit
                 directly below in this same card, so repeating it would duplicate. */
              <span style={{ display: "block", fontSize: 12.5, fontWeight: 700, color: "#11140f", overflowWrap: "anywhere" }}>
                {lineIdentity({ code: line.itemCode, description: line.name }).primary}
              </span>
            ) : (
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "#9aa093" }}>Pick a product{"…"}</span>
            )}
          </span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><polyline points="9 6 15 12 9 18" /></svg>
        </button>
        {removable && <span onClick={onRemove} style={{ fontSize: 14, color: "#9aa093", cursor: "pointer", padding: "0 2px" }}>{"✕"}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7, padding: 10 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <Field label="Qty" style={{ flex: 0.5 }}>
            <input className="fld-i" inputMode="numeric" value={line.qty} onChange={(e) => onChange({ qty: e.target.value })} />
          </Field>
          <Field label="Unit Price" style={{ flex: 1 }}>
            <input
              className="fld-i money"
              value={line.price}
              disabled={!canEditPrice}
              title={!canEditPrice ? "Price follows the SKU Master sell price — admin can override" : undefined}
              onChange={(e) => onChange({ price: e.target.value, priceAuthored: true })}
            />
          </Field>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <Field label="Line Delivery Date" style={{ flex: 1 }} onClear={line.ddate ? () => onDdateChange("") : undefined}>
            <DateField fullWidth className="fld-i" value={line.ddate} onChange={(iso) => onDdateChange(iso)}/>
          </Field>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, color: "#9aa093" }}>
            {LINE_CATS.find((c) => c.value === line.cat)?.label ?? "General item"}
            {picked ? "" : " — pick a product"}
          </span>
          <span style={{ fontSize: 11, color: "#9aa093" }}>
            Amount <b className="money" style={{ fontSize: 13, fontWeight: 800, color: "#0c3f39" }}>RM {amt}</b>
          </span>
        </div>

        {/* Category-aware variant panels — REAL hooks. */}
        {picked && !pools.ready && (
          <div style={{ fontSize: 10.5, color: "#9aa093", padding: "4px 0" }}>Loading options{"…"}</div>
        )}

        {picked && pools.ready && line.cat === "sofa" && (
          <>
            <FabricField
              value={fabVal} colourLabel={fabColourLabel}
              invalid={showErrors && missing.has("fabricCode")} onOpen={onOpenFabricPicker}
            />
            {/* Colour KIV (owner 2026-07-24, SO-2607-016) — series committed,
                colour still open; the server blocks a Processing Date until
                the colour is confirmed. Same hint as desktop SoLineCard. */}
            {isColourKiv(v) && (
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#B8331F" }}>
                Colour KIV — confirm the colour before a Processing Date can be set.
              </div>
            )}
            <div style={{ display: "flex", gap: 9 }}>
              <SpecSel label="Seat height" required invalid={showErrors && missing.has("seatHeight")}
                value={String(v.seatHeight ?? "")} opts={sofaSeatOpts} onChange={(x) => setVar({ seatHeight: x })} />
              {/* Owner 2026-07-13 — sofa Leg Height carries a standing "Default"
                  option and auto-seeds, so it is not a required-empty field. */}
              <SpecSel label="Leg height" invalid={showErrors && missing.has("legHeight")}
                value={String(v.legHeight ?? "")} opts={sofaLegOpts} onChange={(x) => setVar({ legHeight: x })} />
            </div>
          </>
        )}

        {picked && pools.ready && line.cat === "bedframe" && (
          <>
            <FabricField
              value={fabVal} colourLabel={fabColourLabel}
              invalid={showErrors && missing.has("fabricCode")} onOpen={onOpenFabricPicker}
            />
            {isColourKiv(v) && (
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#B8331F" }}>
                Colour KIV — confirm the colour before a Processing Date can be set.
              </div>
            )}
            {/* Bedframe build — 3 selects stacked in a responsive grid so DIVAN /
                LEG / GAP each get full width and read completely (owner: the old
                3-in-a-row cramped them to "No Le"). */}
            <div style={{ background: "#f4f6f3", border: "1px solid #eceee9", borderRadius: 10, padding: "9px 10px" }}>
              <div className="fld-l" style={{ marginBottom: 7 }}>Bedframe build</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <SpecSel label="Divan" required invalid={showErrors && missing.has("divanHeight")}
                  value={String(v.divanHeight ?? "")} opts={bfDivanOpts} onChange={(x) => setVar({ divanHeight: x })} />
                <SpecSel label="Leg" required invalid={showErrors && missing.has("legHeight")}
                  value={String(v.legHeight ?? "")} opts={bfLegOpts} onChange={(x) => setVar({ legHeight: x })} />
                <SpecSel label="Gap" required invalid={showErrors && missing.has("gap")}
                  value={String(v.gap ?? "")} opts={bfGapOpts} onChange={(x) => setVar({ gap: x })} />
              </div>
            </div>
          </>
        )}

        {/* Special order — unified entry (owner-approved). A full-width row that
            opens the bottom sheet (presets + Custom / other). Replaces the old
            inline accordion + the standalone Extra input; the data path is
            unchanged (variants.specials + extraAddonNote/extraAddonAmountRM).
            Shown for sofa + bedframe (where specials apply). */}
        {picked && pools.ready && (line.cat === "sofa" || line.cat === "bedframe") && (
          <button
            type="button"
            onClick={onOpenSpecialPicker}
            style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
              padding: "9px 11px", background: "#fff", border: "1px solid #eceee9", borderRadius: 10,
              fontFamily: "inherit", cursor: "pointer",
            }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 700, color: "#11140f" }}>Special order</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: specialCount > 0 ? "#16695f" : "#9aa093" }}>
              {specialCount > 0 ? `${specialCount} added` : "None"}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><polyline points="9 6 15 12 9 18" /></svg>
            </span>
          </button>
        )}

        {picked && pools.ready && line.cat === "mattress" && (
          <div style={{ fontSize: 10.5, color: "#767b6e", background: "#f4f6f3", border: "1px solid #eceee9", borderRadius: 9, padding: "7px 9px" }}>
            Mattress SKUs carry their spec in the item itself — no per-line variants to pick.
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
          <Field label="Remark" style={{ flex: 1 }}>
            <input className="fld-i" value={line.remark} onChange={(e) => onChange({ remark: e.target.value })} placeholder="e.g. LHF chaise facing window" />
          </Field>
          {/* Per-line reference photo — the camera opens the file picker and each
              chosen file becomes a thumbnail (owner: the old button just toggled
              a green tick and never uploaded). Staged files upload against the
              line's itemId after the SO saves. */}
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => { addPhotos(Array.from(e.target.files ?? [])); e.target.value = ""; }}
          />
          <button
            type="button"
            onClick={() => photoInputRef.current?.click()}
            title="Attach a reference photo"
            style={{ width: 46, flex: "none", alignSelf: "flex-end", height: 38, border: "1px solid #d6d9d2", borderRadius: 9, background: "#f4f6f3", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>
          </button>
        </div>

        {/* Photo thumbnails — already-saved (edit prefill) + staged (this session) */}
        {(line.photoKeys.length > 0 || line.photoFiles.length > 0) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 1 }}>
            {line.photoKeys.map((k) => (
              <div key={k} style={photoTile}>
                <div style={{ ...photoTileInner, background: "#e1efed", color: "#16695f", fontSize: 8, fontWeight: 700, letterSpacing: ".04em" }}>SAVED</div>
              </div>
            ))}
            {line.photoFiles.map((f, i) => (
              <StagedPhotoThumb key={`${f.name}-${i}`} file={f} onRemove={() => removeStagedPhoto(i)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* Read-only tile style for a persisted (edit) photo — the full thumbnail lives
   on the SO detail screen; here we show a compact marker so the operator knows
   photos exist without a signed-URL round-trip. */
const photoTile: React.CSSProperties = {
  width: 52, height: 52, flex: "none", borderRadius: 9, overflow: "hidden",
  border: "1px solid #d6d9d2", position: "relative",
};
const photoTileInner: React.CSSProperties = {
  width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
};

/* Staged (this-session) photo — object-URL preview + a delete X. Revokes the
   URL on unmount / file change (mirrors the desktop pendingPreviews). */
function StagedPhotoThumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div style={photoTile}>
      <img src={url} alt={file.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      <button
        type="button"
        onClick={onRemove}
        title="Remove (not uploaded yet)"
        style={{ position: "absolute", top: 2, right: 2, width: 16, height: 16, borderRadius: 999, border: "none", background: "rgba(17,20,15,.7)", color: "#fff", fontSize: 10, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
      >{"✕"}</button>
    </div>
  );
}

/* FabricField — a tappable read-only row that opens the searchable FabricPicker
   modal (native <select> with 700+ options is unusable per owner). Shows the
   picked fabric code (+ colour label) or a "Select fabric" placeholder. */
function FabricField({ value, colourLabel, invalid, onOpen }: {
  value: string; colourLabel: string; invalid: boolean; onOpen: () => void;
}) {
  return (
    <Field label="Fabric / colour *">
      <button
        type="button"
        onClick={onOpen}
        className="fld-i"
        style={{
          textAlign: "left", fontFamily: "inherit", cursor: "pointer", display: "flex",
          alignItems: "center", gap: 8, background: "#fff",
          ...(invalid ? { borderColor: "#b23a3a", boxShadow: "0 0 0 2px rgba(178,58,58,.12)" } : null),
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: value ? "#11140f" : "#9aa093", fontWeight: value ? 700 : 400 }}>
          {value ? (colourLabel ? `${value} — ${colourLabel}` : value) : "Select fabric…"}
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
      </button>
    </Field>
  );
}

/* FabricPicker — server-typeahead bottom-sheet (owner #1 scaling pain
   2026-07-14). Converged onto the SAME logic layer as the desktop
   FabricColourCombobox: the sheet's search box drives useFabricColoursSearch
   (GET /fabric-colours?q=…, capped 50 server-side) — it fires only at >= 2 typed
   chars (debounced), so the old "pull EVERY active colour + render capped 60"
   pass is gone. The mobile bottom-sheet chrome is kept (tappable rows fit a
   phone); only the data source moved from the preloaded pool to the server.
   The picked value itself lives on the SO line (FabricField reads it), so a
   saved line always renders its fabric even with no active search here. */
function FabricPicker({ pools, current, onPick, onClose }: {
  pools: VariantPools; current: string; onPick: (c: FabricColourRow) => void; onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  /* Same debounce + length>=2 gate the desktop combobox uses, so the query only
     fires while the operator is actively typing. The sheet only mounts while
     open, so no extra `open` gate is needed. */
  const debounced = useDebouncedValue(search, 200);
  const trimmed = debounced.trim();
  const coloursQ = useFabricColoursSearch(trimmed, { enabled: trimmed.length >= 2 });
  const rows = useMemo(() => (coloursQ.data ?? []).slice(0, 50), [coloursQ.data]);

  return (
    <div className="sheet-bd" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="sheet-head">
          <div>
            <div className="ey" style={{ color: "#a16a2e" }}>Fabric</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#11140f", marginTop: 2 }}>Pick a fabric / colour</div>
          </div>
          <button className="sheet-x" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>

        <div style={{ padding: "0 14px 10px", flex: "none" }}>
          <div className="searchbar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type 2+ chars — fabric code or colour" autoFocus />
          </div>
        </div>

        <div className="sheet-scroll" style={{ gap: 7 }}>
          {rows.length === 0 ? (
            <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "28px 0" }}>
              {trimmed.length < 2
                ? "Type at least 2 characters to search…"
                : coloursQ.isFetching
                  ? "Searching…"
                  : `No fabrics match "${trimmed}".`}
            </div>
          ) : (
            <>
            {rows.map((c) => {
              const on = c.colourId === current;
              const series = pools.fabricSeries.get(c.fabricId) ?? "";
              return (
                <button
                  key={c.colourId}
                  type="button"
                  onClick={() => { onPick(c); onClose(); }}
                  style={{
                    textAlign: "left", width: "100%", boxSizing: "border-box",
                    border: on ? "1px solid #16695f" : "1px solid rgba(34,31,32,.12)",
                    background: on ? "#e1efed" : "#fff",
                    borderRadius: 11, padding: "10px 12px", cursor: "pointer", fontFamily: "inherit",
                    display: "flex", alignItems: "center", gap: 10,
                  }}
                >
                  {c.swatchHex && (
                    <span style={{ width: 22, height: 22, flex: "none", borderRadius: 6, background: c.swatchHex, border: "1px solid rgba(34,31,32,.15)" }} />
                  )}
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: "#11140f" }}>{c.colourId}</span>
                    {(c.label || series) && (
                      <span style={{ display: "block", fontSize: 10.5, color: "#767b6e", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {[series, c.label].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </span>
                  {on && <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M20 6 9 17l-5-5" /></svg>}
                </button>
              );
            })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* SpecialOrderSheet — unified special-order entry as a bottom sheet
   (owner-approved). Lists the active special_addons presets for this line's
   category ∩ the Model's allowed_options.specials, PLUS a "Custom / other"
   free-text order. Mirrors the FabricPicker sheet chrome.

   DATA MODEL UNCHANGED: presets write variants.specials + specialChoices +
   specialLabels; Custom / other writes variants.extraAddonNote +
   extraAddonAmountRM — the SAME fields the desktop SoLineCard writes and the
   server honest-pricing recompute reads. No migration, no backend change.

   ROLE GATE (owner): showPrices=false (non-admin sales) hides every RM amount —
   presets show the NAME ONLY, and the Custom flow shows the description but NO
   Extra-charge field. Sales just describes what the customer needs. */
function SpecialOrderSheet({ line, pools, showPrices, onChange, onClose }: {
  line: LineItem;
  pools: VariantPools;
  showPrices: boolean;
  onChange: (patch: Partial<LineItem>) => void;
  onClose: () => void;
}) {
  const allowQ = useModelAllowedOptionsByCode(line.itemCode || undefined);
  const allow = allowQ.data ?? null;
  const v = line.variants;

  /* setVar — merge one or more variant keys + track overriddenKeys so the
     sofa-compartment follower cascade leaves a manual pick alone (mirrors
     LineCard.setVar). */
  const setVar = (patch: Record<string, unknown>) => {
    const overrides = Array.from(new Set([...line.overriddenKeys, ...Object.keys(patch)]));
    onChange({ variants: { ...line.variants, ...patch }, overriddenKeys: overrides });
  };

  const specialsList = (val: unknown): string[] => {
    if (Array.isArray(val)) return val.map(String).filter(Boolean);
    if (typeof val === "string" && val) return [val];
    return [];
  };
  const catUpper = line.itemGroup.toUpperCase();
  const specialOptions: SpecialAddonRow[] = useMemo(() => {
    // Owner 2026-07-14 — opt-out pool (mirrors SoLineCard/main): empty/absent
    // allowed_options.specials ⇒ offer ALL active specials for the category;
    // a non-empty pool restricts to the ticked codes.
    const pool = allow?.specials;
    const restricted = Array.isArray(pool) && pool.length > 0;
    const allowed = new Set(pool ?? []);
    return pools.specialAddons.filter(
      (a) => a.active && a.categories.includes(catUpper) && (!restricted || allowed.has(a.code)),
    );
  }, [pools.specialAddons, catUpper, allow]);
  const pickedSpecials = specialsList(v.specials ?? v.special);
  const specialChoicesMap: Record<string, string[]> =
    v.specialChoices && typeof v.specialChoices === "object"
      ? (v.specialChoices as Record<string, string[]>)
      : {};
  const toggleSpecial = (code: string) => {
    const has = pickedSpecials.includes(code);
    const nextPicked = has ? pickedSpecials.filter((c) => c !== code) : [...pickedSpecials, code];
    const nextChoices: Record<string, string[]> = { ...specialChoicesMap };
    if (has) {
      delete nextChoices[code];
    } else {
      const def = pools.specialAddons.find((d) => d.code === code);
      if (def && def.optionGroups.length > 0) {
        nextChoices[code] = def.optionGroups.map((g) => (g.required && g.choices[0] ? g.choices[0].label : ""));
      }
    }
    setVar({
      specials: nextPicked,
      specialChoices: nextChoices,
      specialLabels: nextPicked.map((c) => pools.specialAddons.find((d) => d.code === c)?.label ?? c),
    });
  };

  /* Change one option-group choice for a ticked add-on (owner 2026-07-20 parity
     with desktop SpecialOrders.changeChoice). Each choice can carry its own
     extraSen, so a special order MUST expose its groups — otherwise it silently
     locks to choices[0] (the default toggleSpecial seeds). */
  const changeChoice = (code: string, groupIdx: number, label: string) => {
    const def = specialOptions.find((d) => d.code === code);
    const entry = [...(specialChoicesMap[code] ?? (def?.optionGroups ?? []).map(() => ""))];
    entry[groupIdx] = label;
    setVar({ specialChoices: { ...specialChoicesMap, [code]: entry } });
  };

  const extraNote = String(v.extraAddonNote ?? "");
  const extraAmountRM = Number(v.extraAddonAmountRM ?? 0);
  const hasCustom = Boolean(extraNote.trim()) || extraAmountRM > 0;
  const [customOpen, setCustomOpen] = useState(hasCustom);
  const ghostPicks = pickedSpecials.filter((c) => !specialOptions.some((a) => a.code === c));

  return (
    <div className="sheet-bd" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="sheet-head">
          <div>
            <div className="ey" style={{ color: "#a16a2e" }}>Special order</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#11140f", marginTop: 2 }}>Add special orders</div>
          </div>
          <button className="sheet-x" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>

        <div className="sheet-scroll" style={{ gap: 9 }}>
          {specialOptions.length === 0 && ghostPicks.length === 0 && (
            <div style={{ fontSize: 12, color: "#767b6e" }}>
              No preset special orders for this model — use “Custom / other” below.
            </div>
          )}
          {specialOptions.map((a) => {
            const on = pickedSpecials.includes(a.code);
            return (
              <label
                key={a.code}
                style={{
                  display: "flex", alignItems: "center", gap: 10, fontSize: 13, cursor: "pointer",
                  border: on ? "1px solid #16695f" : "1px solid rgba(34,31,32,.12)",
                  background: on ? "#e1efed" : "#fff", borderRadius: 11, padding: "11px 12px",
                }}
              >
                <input type="checkbox" checked={on} onChange={() => toggleSpecial(a.code)} style={{ width: 18, height: 18, flex: "none", accentColor: "#16695f" }} />
                <span style={{ flex: 1, minWidth: 0, color: "#11140f", fontWeight: 600 }}>{a.label}</span>
                {/* Role gate — non-admin sales sees the NAME only (owner). */}
                {showPrices && a.sellingPriceSen !== 0 && (
                  <span className="money" style={{ fontSize: 12, color: "#767b6e", flex: "none" }}>+RM {(a.sellingPriceSen / 100).toFixed(2)}</span>
                )}
              </label>
            );
          })}
          {/* A previously-saved special the Model no longer offers — kept
              visible + untickable so edit never hides what the order carries. */}
          {ghostPicks.map((c) => (
            <label key={c} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, cursor: "pointer", border: "1px solid rgba(34,31,32,.12)", background: "#fff", borderRadius: 11, padding: "11px 12px" }}>
              <input type="checkbox" checked onChange={() => toggleSpecial(c)} style={{ width: 18, height: 18, flex: "none", accentColor: "#16695f" }} />
              <span style={{ flex: 1, minWidth: 0, color: "#11140f" }}>{String((v.specialLabels as string[] | undefined)?.[pickedSpecials.indexOf(c)] ?? c)}</span>
              <span style={{ fontSize: 11, color: "#9aa093", flex: "none" }}>not in model</span>
            </label>
          ))}

          {/* Follow-up choice pickers for ticked add-ons that carry option groups
              (owner 2026-07-20 parity with desktop SpecialOrders) — without these
              the special order silently locks to the first option even though each
              choice can carry its own surcharge. The RM delta rides showPrices. */}
          {specialOptions.filter((a) => pickedSpecials.includes(a.code) && a.optionGroups.length > 0).map((a) =>
            a.optionGroups.map((g, gi) => (
              <Field key={`${a.code}-${gi}`} label={`${a.label} · ${g.label}${g.required ? " *" : ""}`}>
                <select
                  className="fld-i"
                  value={(specialChoicesMap[a.code] ?? [])[gi] ?? ""}
                  onChange={(e) => changeChoice(a.code, gi, e.target.value)}
                >
                  {!g.required && <option value="">None</option>}
                  {g.required && <option value="" disabled>Select{"…"}</option>}
                  {g.choices.map((c) => (
                    <option key={c.label} value={c.label}>
                      {c.label}{showPrices && c.extraSen !== 0 ? ` (${c.extraSen > 0 ? "+" : "−"}RM ${(Math.abs(c.extraSen) / 100).toFixed(2)})` : ""}
                    </option>
                  ))}
                </select>
              </Field>
            )),
          )}

          {/* ── Custom / other ── */}
          <div style={{ borderTop: "1px dashed #d6d9d2", paddingTop: 11, marginTop: 2 }}>
            <button
              type="button"
              onClick={() => setCustomOpen((o) => !o)}
              style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "4px 2px", background: "transparent", border: "none", fontFamily: "inherit", cursor: "pointer" }}
            >
              <span style={{ fontSize: 13, fontWeight: 700, color: "#11140f" }}>Custom / other</span>
              <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 700, color: hasCustom ? "#16695f" : "#9aa093" }}>
                {hasCustom ? "1 added" : ""}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: (customOpen || hasCustom) ? "rotate(180deg)" : "none", transition: "transform .15s" }}><polyline points="6 9 12 15 18 9" /></svg>
              </span>
            </button>
            {(customOpen || hasCustom) && (
              <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 8 }}>
                <Field label="Description">
                  <textarea
                    className="fld-i"
                    rows={3}
                    style={{ resize: "vertical", minHeight: 64 }}
                    placeholder="Describe the special order the customer needs…"
                    value={extraNote}
                    onChange={(e) => setVar({ extraAddonNote: e.target.value })}
                  />
                </Field>
                {showPrices && (
                  <Field label="Extra charge (RM)" style={{ maxWidth: 160 }}>
                    <input
                      className="fld-i money"
                      inputMode="numeric"
                      placeholder="0"
                      value={extraAmountRM ? String(extraAmountRM) : ""}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const n = raw === "" ? 0 : Math.max(0, Math.round(Number(raw)) || 0);
                        setVar({ extraAddonAmountRM: n });
                      }}
                    />
                  </Field>
                )}
                {/* Clear hidden from non-admin sales when a price they can't see
                    is set — they must not silently wipe an admin-priced order. */}
                {hasCustom && (showPrices || extraAmountRM <= 0) && (
                  <button
                    type="button"
                    onClick={() => setVar({ extraAddonNote: "", extraAddonAmountRM: 0 })}
                    style={{ alignSelf: "flex-start", fontSize: 12, fontWeight: 600, color: "#b23a3a", background: "transparent", border: "1px solid #e3d2cf", borderRadius: 9, padding: "6px 12px", cursor: "pointer", fontFamily: "inherit" }}
                  >
                    Clear custom order
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="sheet-foot">
          <button type="button" className="btn" onClick={onClose} style={{ flex: 1, padding: "11px 16px" }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/* SpecSel — a labelled <select> bound to a real option list. */
function SpecSel({ label, value, opts, onChange, required = false, invalid = false, emptyHint }: {
  label: string; value: string; opts: Opt[]; onChange: (v: string) => void;
  required?: boolean; invalid?: boolean; emptyHint?: string;
}) {
  const hasCurrent = Boolean(value) && opts.some((o) => o.value === value);
  return (
    <Field label={label + (required ? " *" : "")} style={{ flex: 1, minWidth: 0 }}>
      <select
        className="fld-i"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={invalid ? { borderColor: "#b23a3a", boxShadow: "0 0 0 2px rgba(178,58,58,.12)" } : undefined}
      >
        <option value="" disabled>{opts.length === 0 && emptyHint ? emptyHint : "Select…"}</option>
        {value && !hasCurrent && <option value={value}>{value} (current)</option>}
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  );
}

function PayCard({ pay, staff, onChange, onRemove }: { pay: Payment; staff: Array<{ id: string; name: string }>; onChange: (patch: Partial<Payment>) => void; onRemove: () => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  /* Live payment dropdowns from the maintenance catalog (same API the desktop
     SalesOrderNew uses); FALLBACK_OPTIONS only backs an offline load. Was
     hardcoded ("Maybank"/"One Shot") and never hit the API — that was the drift. */
  const methodOpts = optionsOrFallback("payment_method", useSoDropdownOptions("payment_method").data);
  const bankOpts = optionsOrFallback("payment_merchant", useSoDropdownOptions("payment_merchant").data);
  const planOpts = optionsOrFallback("installment_plan", useSoDropdownOptions("installment_plan").data);
  const onlineOpts = optionsOrFallback("online_type", useSoDropdownOptions("online_type").data);
  const onPickSlip = async (f: File | null) => {
    if (!f) return;
    onChange({ slipName: f.name, slipSession: "", slipPhase: "uploading" });
    try {
      const { uploadSessionId } = await uploadSlipFull({ file: f });
      onChange({ slipSession: uploadSessionId, slipPhase: "done" });
    } catch {
      onChange({ slipPhase: "error" });
    }
  };
  return (
    /* Owner 2026-07-04 — hairline borders, matching the LineCard. */
    <div style={{ border: "1px solid #eceee9", borderRadius: 11, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "#f4f6f3", borderBottom: "1px solid #eceee9" }}>
        <span style={{ fontSize: 9, fontWeight: 700, color: "#767b6e", textTransform: "uppercase", letterSpacing: ".06em" }}>Method</span>
        <select className="fld-i" style={{ flex: 1, fontWeight: 600 }} value={pay.method} onChange={(e) => onChange({ method: e.target.value })}>
          {methodOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span onClick={onRemove} style={{ fontSize: 14, color: "#9aa093", cursor: "pointer", padding: "0 2px" }}>{"✕"}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7, padding: 10 }}>
        <div style={{ display: "flex", gap: 9, alignItems: "flex-end" }}>
          <Field label="Date" style={{ flex: 1.1 }} onClear={pay.date ? () => onChange({ date: "" }) : undefined}>
            <DateField fullWidth className="fld-i" value={pay.date} onChange={(iso) => onChange({ date: iso })}/>
          </Field>
          <Field label="Amount" style={{ flex: 1.1 }}>
            <input className="fld-i money" value={pay.amount} onChange={(e) => onChange({ amount: e.target.value })} />
          </Field>
        </div>
        {/* Merchant needs BOTH (missingMethodSubField); marked required now that
            they seed blank instead of inventing "MBB" / "One-off". */}
        {pay.method === "Merchant" && (
          <div style={{ display: "flex", gap: 9 }}>
            <SpecSel label="Bank" required value={pay.bank} opts={bankOpts} onChange={(vv) => onChange({ bank: vv })} />
            <SpecSel label="Plan" required value={pay.plan} opts={planOpts} onChange={(vv) => onChange({ plan: vv })} />
          </div>
        )}
        {/* Installment — Bank + Plan (owner 2026-07-19 "Installment 要能选银行的").
            Bank drives the EPP fee; same picker/source as Merchant. Optional (no
            required gate), matching desktop + the server. */}
        {pay.method === "Installment" && (
          <div style={{ display: "flex", gap: 9 }}>
            <SpecSel label="Bank" value={pay.bank} opts={bankOpts} onChange={(vv) => onChange({ bank: vv })} />
            <SpecSel label="Plan" value={pay.plan} opts={planOpts} onChange={(vv) => onChange({ plan: vv })} />
          </div>
        )}
        {pay.method === "Online" && (
          <SpecSel label="Sub-type" required value={pay.online} opts={onlineOpts} onChange={(vv) => onChange({ online: vv })} />
        )}
        <div style={{ display: "flex", gap: 9 }}>
          <Field label="Account Sheet" style={{ flex: 1 }}>
            <input className="fld-i" value={pay.account} onChange={(e) => onChange({ account: e.target.value })} placeholder="Sheet ref" />
          </Field>
          <Field label="Approval Code" style={{ flex: 1 }}>
            <input className="fld-i" value={pay.approval} onChange={(e) => onChange({ approval: e.target.value })} placeholder="Terminal no" />
          </Field>
        </div>
        <div style={{ display: "flex", gap: 9, alignItems: "flex-end" }}>
          <Field label="Collected By" style={{ flex: 1 }}>
            <select className="fld-i" value={pay.collectedBy} onChange={(e) => onChange({ collectedBy: e.target.value })}>
              <option value="">—</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <div style={{ flex: 1 }}>
            <div className="fld-l" style={{ color: "#9aa093" }}>Slip</div>
            <input ref={fileRef} type="file" accept="image/*,application/pdf" style={{ display: "none" }} onChange={(e) => { void onPickSlip(e.target.files?.[0] ?? null); e.target.value = ""; }} />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={pay.slipPhase === "uploading"}
              title={pay.slipName || "Attach a payment slip"}
              style={{
                width: "100%", boxSizing: "border-box", height: 38, borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700,
                border: pay.slipPhase === "done" ? "1px solid #bcdcd7" : "1px solid #d6d9d2",
                background: pay.slipPhase === "done" ? "#e1efed" : "#f4f6f3",
                color: pay.slipPhase === "done" ? "#16695f" : "#414539",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6, overflow: "hidden",
              }}
            >
              {pay.slipPhase === "uploading" ? "Uploading…"
                : pay.slipPhase === "done" ? "Slip attached ✓"
                : pay.slipPhase === "error" ? "Retry upload"
                : "Upload slip"}
            </button>
          </div>
        </div>
        {/* The per-row amber warning is gone (Owner 2026-08-13): it called a
            slip-less row a mere plan, which was true only while the writer
            filtered on the slip. The slip is optional and the row is recorded
            on its amount, so that line asked for something not required and
            implied the money would not book without it. */}
      </div>
    </div>
  );
}

// ---- Shared inline styles ---------------------------------------------------

const roItemBox: React.CSSProperties = {
  border: "1px solid #eceee9",
  borderRadius: 10,
  padding: "9px 11px",
  marginBottom: 7,
};

import { DateField } from "../vendor/scm/components/DateField";