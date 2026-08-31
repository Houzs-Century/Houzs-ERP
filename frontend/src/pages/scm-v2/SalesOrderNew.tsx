// ----------------------------------------------------------------------------
// SalesOrderNew — full-page Create SO at /scm/sales-orders/new.
//
// Task #105 — Commander 2026-05-27: "Edit SO 和 New SO 界面一定要一样的啊
// 为什么一直不一样 sales 怎么会习惯呢 payment 你只改了 edit SO 没有改 new SO".
// This page is now restructured to render the SAME 4 customer cards + the
// SAME Houzs PaymentsTable as SalesOrderDetail.tsx, so the Create flow and
// the Edit flow are visually identical (only the page title differs).
//
// Card order (matches Detail):
//   1. CUSTOMER         — Name * / Phone * / Email * / Customer Type /
//                         Salesperson / Customer SO Ref
//   2. ORDER INFO       — Building Type / Venue / Processing Date /
//                         Delivery Date (XOR validation) / Note
//   3. EMERGENCY        — Contact Name / Relationship / Phone
//   4. DELIVERY ADDRESS — "Fill in address later" affordance (New-SO only) /
//                         Address Line 1 / Address Line 2 / State / City /
//                         Postcode  (Sales Location is Detail-only)
//   5. LINE ITEMS       — SoLineCard list (already shared with Detail)
//   6. PAYMENTS         — <PaymentsTable docNo={null} /> draft mode. After
//                         POST /mfg-sales-orders succeeds, batch POST every
//                         draft to /:docNo/payments before navigating.
//
// ── HOUZS VENDOR ADAPTATIONS ───────────────────────────────────────────────
//   • react-router → react-router-dom.
//   • flow-queries hooks → the vendored sales-order-queries slice.
//   • The dead `supabase` import is dropped; flushPendingPhotos reads the
import { postScanLearningSample, reportScanLearningSkipped } from '../../vendor/scm/lib/scan-learning';
import {
  cascadeMasterVariants,
  seedFollowerVariants,
  seedableMasterVariants,
  FABRIC_IDENTITY_KEYS,
  type MasterVariantSnapshot,
} from '../../vendor/scm/lib/so-variant-cascade';
//     freshly-created SO back through the vendored authedFetch (→ /api/scm)
//     instead of a hand-rolled supabase token + VITE_API_URL fetch.
//   • Navigation repointed to /scm/sales-orders/*.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery as useTanstackQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Camera, ChevronDown, Plus, Save, X } from 'lucide-react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { api } from '../../api/client';
import type { Department, TeamMember } from '../../types';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import {
  useCreateMfgSalesOrder, useDebtorSearch, useAddSalesOrderPayment,
  useUploadSoItemPhoto, useMfgSalesOrderDetail,
  type DebtorSuggestion,
} from '../../vendor/scm/lib/sales-order-queries';
import { zeroPriceClaim } from '../../vendor/scm/lib/zeroPriceClaim';
import { authedFetch, humanApiError } from '../../vendor/scm/lib/authed-fetch';
import { notifySaveProblems } from '../../vendor/scm/components/SaveProblemsList';
import { notifyAcNotSent } from '../../vendor/scm/lib/ac-not-sent';
import { useIdempotencyKey } from '../../lib/idempotency';
import { DebtorSuggestList } from '../../vendor/scm/components/DebtorSuggestList';
import { readScmHandoff, removeScmHandoff } from '../../lib/scmHandoffStorage';
import { completePaymentRetryDraft, paymentRetryNavigationState, writePaymentRetryHandoff } from '../../lib/paymentRetryHandoff';
import { usePickableStaff } from '../../vendor/scm/lib/admin-queries';
import { resolveSelfStaff } from '../../vendor/scm/lib/self-staff';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
import { deriveProcessingDate } from '../../lib/processingDate';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import { SearchableSelect } from '../../vendor/scm/components/SearchableSelect';
import { useAuth } from '../../vendor/scm/lib/auth';
/* Houzs auth — the REAL logged-in user (name + id). The vendored 2990 auth
   bridge (useAuth above) has no staff row for the owner (id:null), which left
   Salesperson blank for anyone without a scm.staff row. We read the Houzs
   AuthUser to default + name the creator so the field is never blank. */
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useVenues, type AutoVenue } from '../../vendor/scm/lib/venues-queries';
import {
  useLocalities, countryForState,
} from '../../vendor/scm/lib/localities-queries';
import {
  useAddressCascade, pickState, pickCity, pickPostcode,
  cityPlaceholder, postcodePlaceholder,
} from '../../vendor/scm/lib/address-cascade';
import { StatePicker } from '../../vendor/scm/components/StatePicker';
import {
  useSoDropdownOptions, optionsOrFallback, preferredCustomerTypeValue,
} from '../../vendor/scm/lib/so-dropdown-options-queries';
import { useStateWarehouseMappings } from '../../vendor/scm/lib/state-warehouse-queries';
import { SoLineCard, emptySoLine, missingRequiredVariants, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import { hasSofaMixConflict, SOFA_MIX_MESSAGE } from '@2990s/shared/so-variant-rule';
/* FIX (d) scan fabric seed — resolve a scanned fabric code (e.g. "BO315-22")
   to the SAME fabric_colours / fabric_library rows SoLineCard's pickFabricColour
   uses, so the matched colour rides onto the seeded line's variants instead of
   being dropped. */
import { useFabricColoursActive } from '../../vendor/scm/lib/fabric-queries';
import { useFabricLibrary } from '../../vendor/scm/lib/queries';
/* OCR specials seed — the active special_addons pool resolves a scanned
   specialCode to its label + required option groups, so the seeded line writes
   the SAME variant keys SoLineCard.toggleSpecial does and the special renders
   checked on the New SO line. */
import { useSpecialAddons, type MfgProductRow } from '../../vendor/scm/lib/mfg-products-queries';
import { type ScanPrefill, type ExtractedSlip } from '../../vendor/scm/components/ScanOrderModal';
import {
  PaymentsTable, labelToApi, draftMethodFields, newPaymentDraft,
  missingMethodSubField, parseInstallmentMonths, type PaymentDraft,
} from '../../vendor/scm/components/PaymentsTable';
import { soDateGuardError, soStockLocationError, soRequiredFieldErrors, soRequiredFieldsMessage, soProceedingAddressErrors } from '../../vendor/scm/lib/so-form-validate';
import { useBranding } from '../../hooks/useBranding';
import styles from './SalesOrderNew.module.css';
import { fmtMoneySen } from '@2990s/shared';
import { DateField } from "../../vendor/scm/components/DateField";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* PR #114/#125 — Draft line shape mirrors SoLineDraft from SoLineCard but
   adds a stable React id so the local list can re-order / edit inline. */
type DraftLine = SoLineDraft & { rid: string };

/* PR-E — New lines inherit the SO header's delivery date by default.
   The header date isn't persisted until the SO is saved, so we seed the
   line client-side; once the SO exists, the server-side cascade in
   PATCH /:docNo takes over. */
const newLine = (deliveryDate: string | null = null): DraftLine => ({
  ...emptySoLine(),
  lineDeliveryDate: deliveryDate,
  lineDeliveryDateOverridden: false,
  rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
});

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneySen(centi, currency);

export const SalesOrderNew = () => {
  const navigate = useNavigate();
  const notify = useNotify();
  /* Copy-to-new-SO: ?copyFrom=<docNo> seeds this form from an existing SO
     (customer + line items only — dates, payments, customer SO ref, doc no
     and status are intentionally left blank so the operator starts fresh). */
  const [searchParams] = useSearchParams();
  const copyFromDocNo = searchParams.get('copyFrom');
  const copySource = useMfgSalesOrderDetail(copyFromDocNo);
  const create   = useCreateMfgSalesOrder();
  /* One key for the one order this page is open to raise (lib/idempotency.ts).
     Route-level form; onSuccess navigates to the SO detail, so the MOUNT is
     exactly one order — the same rule mobile MobileNewSO applies, one logic
     layer. Load-bearing here beyond the double-tap: onSuccess below deliberately
     does NOT gate navigation on flushPaymentDrafts / flushPendingPhotos, so a
     re-press after one of those warns re-fires the create — with a stable key
     that REPLAYS the first docNo instead of raising a second order, and the
     payment drafts carry their own per-draft keys so they don't double either. */
  const idemKey  = useIdempotencyKey();
  const addPayment = useAddSalesOrderPayment();
  const uploadPhoto = useUploadSoItemPhoto();
  // onlySales=true — owner 2026-07-22: the salesperson dropdown was showing
  // every ACTIVE staff granted to the active company (Bernard, HOUZS CENTURY,
  // Kris, Test Admin, …). Narrow to Sales-position / Sales-department only.
  const staffQ   = usePickableStaff({ onlySales: true });
  const venuesQ  = useVenues();
  const loc      = useLocalities();
  /* FIX (d) — fabric colour + library lookups for the scan seed (same sources
     as SoLineCard.pickFabricColour). Lets a matched scan fabric code resolve to
     fabricId / colour label / hex before it lands on the seeded line. */
  const scanFabricColoursQ = useFabricColoursActive();
  const scanFabricLibQ     = useFabricLibrary();
  const scanSpecialsQ      = useSpecialAddons();
  /* Commander 2026-05-27: "他们都要有自己的account... 用自己的account开单
     都是自己的名字...salesperson 还是可以换 只是default跳出来 venue就不能换
     自动跳出来". The current logged-in staff drives:
       1. Default salesperson (admin/director can still pick another).
       2. The locked Venue (always derived from the picked salesperson's
          venue_id — non-admin roles also can't change the salesperson, so
          the venue is fully locked to their home venue). */
  const { staff: currentStaff } = useAuth();
  /* The REAL logged-in user (Houzs auth) — drives the never-blank Salesperson
     default. The 2990 bridge's currentStaff is null/role-only for a user with
     no scm.staff row (e.g. the owner), so we fall back to this for the name. */
  const { user: currentUser, can } = useHouzsAuth();
  /* Houzs-flavoured: gate on the flat permission key `scm.so.attribute_other`
     (the 2990 bridge always reports either super_admin or sales). Owner + IT
     Admin pass via `*`; grant to other positions via Team > Positions. */
  const canChangeSalesperson = can('scm.so.attribute_other');

  /* Task #118 — these 3 dropdowns used to be `as const` arrays in this
     file. Now sourced from so_dropdown_options via TanStack. Each call
     falls back to the migration 0081 seed list during loading + when
     the DB row count is 0 so the user never sees an empty select. */
  const customerTypeOptsQ  = useSoDropdownOptions('customer_type');
  const buildingTypeOptsQ  = useSoDropdownOptions('building_type');
  const relationshipOptsQ  = useSoDropdownOptions('relationship');
  const customerTypeOpts = optionsOrFallback('customer_type', customerTypeOptsQ.data);
  const buildingTypeOpts = optionsOrFallback('building_type', buildingTypeOptsQ.data);
  const relationshipOpts = optionsOrFallback('relationship',  relationshipOptsQ.data);
  /* Commander 2026-05-27: Venue is no longer user-pickable on New SO —
     it's locked to the salesperson's staff.venue_id. The `venue`
     so_dropdown_options category remains for legacy back-compat but
     this page no longer reads it. */

  // ── Customer fields ────────────────────────────────────────────────
  const [debtorCode,    setDebtorCode]    = useState('');
  const [debtorName,    setDebtorName]    = useState('');
  const [phone,         setPhone]         = useState('');
  const [email,         setEmail]         = useState('');
  const [salespersonId, setSalespersonId] = useState('');
  const [customerType,  setCustomerType]  = useState<string>('');
  /* PR-A on Detail exposed Customer SO Ref inside the Customer card —
     mirror that here so the two pages line up. */
  const [customerSoNo,  setCustomerSoNo]  = useState('');

  /* Autofill rescue (Wei Siang 2026-06-03) — Chrome/Edge "paint" saved values
     into the Customer Name / Phone / Email inputs WITHOUT firing React's
     onChange, so state stays empty and the Create button is stuck disabled even
     though the fields look filled. Right after mount we read the inputs straight
     from the DOM and push any autofilled value into state (only when state is
     still empty, so we never clobber what the operator typed). Two delayed reads
     cover the browser's autofill timing. */
  const custGridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sync = () => {
      const root = custGridRef.current;
      if (!root) return;
      const nameEl  = root.querySelector('input[required]') as HTMLInputElement | null;
      const emailEl = root.querySelector('input[type="email"]') as HTMLInputElement | null;
      const phoneEl = root.querySelector('input[type="tel"]') as HTMLInputElement | null;
      if (nameEl?.value)  setDebtorName((prev) => prev || nameEl.value);
      if (emailEl?.value) setEmail((prev) => prev || emailEl.value);
      if (phoneEl?.value) setPhone((prev) => prev || phoneEl.value);
    };
    const t1 = setTimeout(sync, 250);
    const t2 = setTimeout(sync, 800);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  // ── Order Info fields (Building Type / Venue / Dates / Note) ───────
  const [buildingType,   setBuildingType] = useState<string>('');
  /* PR #156 — Commander 2026-05-27: "开单的 venue 呢也没有". Detail page
     keeps Venue as a free-text field separate from Building Type — match
     that here so the two layouts line up.

     Commander 2026-05-27 follow-up: "venue就不能换 自动跳出来". The venue
     is now derived from the picked salesperson's staff.venue_id and is
     read-only. We keep the free-text `venue` column on the row for
     back-compat (we send the resolved venue name) and also send
     `venueId` (FK) so the API persists the master link. */
  const [processingDate, setProcessingDate] = useState('');
  const [deliveryDate,   setDeliveryDate]   = useState('');
  const [note,           setNote]           = useState('');

  // ── Delivery address ───────────────────────────────────────────────
  /* "Fill in address later" affordance: New-SO only (the address can be
     unknown at quote time). Detail doesn't need it because by the time
     someone is editing a saved SO, the address can be left blank without
     a special toggle. */
  const [fillAddressLater, setFillAddressLater] = useState(false);
  const [address1,    setAddress1]    = useState('');
  const [address2,    setAddress2]    = useState('');
  const [state,       setState]       = useState('');
  const [city,        setCity]        = useState('');
  const [postcode,    setPostcode]    = useState('');
  /* Commander 2026-05-27 (Fix 5) — Sales Location auto-derives from the
     state_warehouse_mappings entry for the picked state. Held in local
     state so the cascade effect can overwrite it whenever State changes
     while still allowing future manual override. */
  const [salesLocation, setSalesLocation] = useState('');
  /* Active company — decides whether the stock-location gate applies at all
     (owner 2026-08-13: company 1 only). Already cached app-wide by the chrome,
     so this costs no extra request. */
  const branding = useBranding();

  // ── Emergency contact ──────────────────────────────────────────────
  const [emergencyName,  setEmergencyName]   = useState('');
  const [emergencyRel,   setEmergencyRel]    = useState<string>('');
  const [emergencyPhone, setEmergencyPhone]  = useState('');

  // ── Items state ────────────────────────────────────────────────────
  /* HOOKKA pattern — each line is an inline editable card. First card is
     seeded on mount so commander immediately sees the variant editor
     instead of needing to click "+ Add line item" first. */
  const [lines, setLines] = useState<DraftLine[]>(() => [newLine()]);

  /* ── Scan-Order review state (fromScan only) ───────────────────────────
     Task #73 — the OCR review now happens HERE, in the real form (no separate
     free-text modal). We carry the frozen AI-original slip + sampleId +
     salesperson so the SAVE can run the edit-gate learning POST, the
     AI-prefilled baseline (per field) so changed fields show the blue
     `.edited` diff, and per-line confidence so each line shows a
     "scanned · NN%" chip. Keyed by the line's rid (set during seed). */
  const [scanSampleId,    setScanSampleId]    = useState<string | null>(null);
  const [scanSalesperson, setScanSalesperson] = useState<string | null>(null);
  const [scanAiOriginal,  setScanAiOriginal]  = useState<ExtractedSlip | null>(null);
  /* AI-prefilled baseline for the blue diff — only the header fields the form
     exposes as editable inputs. A field whose current value differs from its
     baseline is marked `.edited`. Undefined entries = the scan didn't touch
     that field (so it never shows as edited). */
  type ScanBaseline = {
    debtorName?: string; address1?: string; note?: string;
    deliveryDate?: string; processingDate?: string;
    customerType?: string; buildingType?: string; venueId?: string;
    customerSoNo?: string; state?: string;
  };
  const [scanBaseline, setScanBaseline] = useState<ScanBaseline | null>(null);
  /* Per-line scan meta, keyed by the seeded line's rid: the verbatim slip row,
     the SKU Claude suggested, its confidence, and the itemCode the scan seeded
     (so the chip can tell a still-AI match from an operator override). */
  type ScanLineMeta = { rawText: string; suggestedCode: string; confidence: number; seededCode: string };
  const [scanLineMeta, setScanLineMeta] = useState<Record<string, ScanLineMeta>>({});
  /* Scanned city / postcode held until the localities cascade for the chosen
     state has options to match against — they only land in the dropdowns when
     they exist in the live my_localities list for that state (catalog-validated,
     never free-text into a dropdown). Cleared after a successful apply. */
  const [scanCity, setScanCity] = useState('');
  const [scanPostcode, setScanPostcode] = useState('');

  /* Copy-to-new-SO seed — runs once when the source SO finishes loading.
     Fills customer + address + emergency + line items. Deliberately omits
     processing/delivery dates, payments, customer SO ref, doc no and status
     so the new order is a clean draft. Guarded so it can't re-seed and stomp
     edits the operator has already made. */
  const [copySeeded, setCopySeeded] = useState(false);
  useEffect(() => {
    if (!copyFromDocNo || copySeeded) return;
    const h = copySource.data?.salesOrder;
    const srcItems = copySource.data?.items;
    if (!h) return;
    setDebtorCode(h.debtor_code ?? '');
    setDebtorName(h.debtor_name ?? '');
    setPhone(h.phone ?? '');
    setEmail(h.email ?? '');
    setSalespersonId(h.salesperson_id ?? '');
    setCustomerType(h.customer_type ?? '');
    setBuildingType(h.building_type ?? '');
    setNote(h.note ?? '');
    setAddress1(h.address1 ?? '');
    setAddress2(h.address2 ?? '');
    setState(h.customer_state ?? '');
    setCity(h.city ?? h.address3 ?? '');
    setPostcode(h.postcode ?? h.address4 ?? '');
    setEmergencyName(h.emergency_contact_name ?? '');
    setEmergencyRel(h.emergency_contact_relationship ?? '');
    setEmergencyPhone(h.emergency_contact_phone ?? '');
    if (Array.isArray(srcItems) && srcItems.length > 0) {
      setLines(srcItems.map((it: any) => ({
        ...newLine(),
        itemCode:       it.item_code ?? '',
        itemGroup:      it.item_group ?? 'others',
        description:    it.description ?? '',
        uom:            it.uom ?? 'UNIT',
        qty:            it.qty ?? 1,
        unitPriceSen: it.unit_price_sen ?? 0,
        priceAuthored: true, // copied off the SOURCE order's persisted row: a 0 IS its price
        discountSen:  it.discount_sen ?? 0,
        unitCostSen:  it.unit_cost_sen ?? 0,
        variants:       (it.variants as Record<string, unknown>) ?? {},
        remark:         it.remark ?? '',
      })));
    }
    setCopySeeded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copyFromDocNo, copySeeded, copySource.data]);

  /* Customer Type default (owner 2026-07-16: "customer type default new
     customer") — this page is CREATE-only, so a blank select just costs the
     operator a pick on every SO. Defaults to the live catalog's "New Customer"
     option via the SHARED preferredCustomerTypeValue, the same rule mobile
     (MobileNewSO) applies — one logic layer, no per-platform drift. Editing a
     saved SO lives in SalesOrderDetail and is untouched.

     Only ever fills a BLANK (`prev || preferred`), so it never overwrites a
     real value: a ?copyFrom= source's customer type and a scan-matched
     customerType both win. Waits for a pending copy to seed first — that seed
     sets the field unconditionally (`h.customer_type ?? ''`), so defaulting
     ahead of it would be clobbered back to blank when the source SO carries no
     customer type. */
  useEffect(() => {
    if (copyFromDocNo && !copySeeded) return;
    const preferred = preferredCustomerTypeValue(customerTypeOpts);
    if (preferred) setCustomerType((prev) => prev || preferred);
  }, [copyFromDocNo, copySeeded, customerTypeOpts]);

  /* Scan-Order prefill — ?fromScan=1 + scoped browser handoff from
     ScanOrderModal ("Scan Order" on the SO list). Same one-shot seeding
     idea as copyFrom above, but via the short-lived handoff store because the source is
     an OCR'd handwritten slip, not an existing SO. The key is consumed
     (removed) immediately so a refresh starts clean. Everything seeded
     here is a DRAFT the operator reviews — normal pricing/validation
     still runs on Save. */
  const fromScan = searchParams.get('fromScan') === '1';
  const [scanSeeded, setScanSeeded] = useState(false);
  /* Original-slip R2 key from the scan handoff — survives in state past the
     one-shot handoff consume so it can ride onto the create body and
     become the SO's "Original Slip" proof. '' for a non-scan / PDF order. */
  const [scanSlipImageKey, setScanSlipImageKey] = useState('');
  /* Payment-receipt R2 key from the scan handoff — parallel to the slip key
     above; rides onto the create body to become the SO's "Payment Receipt"
     proof. '' when the scan carried no card-terminal receipt photo. */
  const [scanReceiptImageKey, setScanReceiptImageKey] = useState('');
  useEffect(() => {
    if (!fromScan || scanSeeded) return;
    setScanSeeded(true);
    const payload = readScmHandoff<ScanPrefill>('soScanPrefill');
    removeScmHandoff('soScanPrefill');
    if (!payload) return;
    if (payload.slipImageKey) setScanSlipImageKey(payload.slipImageKey);
    if (payload.receiptImageKey) setScanReceiptImageKey(payload.receiptImageKey);
    if (payload.customerName) setDebtorName(payload.customerName);
    if (payload.phone) setPhone(payload.phone);
    /* Owner: the slip often has TWO numbers (customer + spouse/other). The first
       is the main phone; the SECOND goes to the EMERGENCY CONTACT phone (its
       proper home) — previously it was dropped (or piled into the Note). */
    if (payload.phones && payload.phones[1]) setEmergencyPhone(payload.phones[1]);
    if (payload.address1) setAddress1(payload.address1);
    /* Customer's own order reference (e.g. "HC14032") from the slip top-right. */
    if (payload.customerSoRef) setCustomerSoNo(payload.customerSoRef);
    /* Structured address → State / City / Postcode. State is a server-validated
       my_localities value; the city/postcode cascade depends on the chosen
       state, so they're applied by the locality-reconcile effect below once the
       localities list has loaded (setting them here directly would be cleared
       by the State onChange cascade). */
    if (payload.addressState) setState(payload.addressState);
    if (payload.addressCity) setScanCity(payload.addressCity);
    if (payload.addressPostcode) setScanPostcode(payload.addressPostcode);
    if (payload.note) setNote(payload.note);
    /* Coupled dates (spec 3, owner 2026-06-24) — the two dates are both-set or
       both-empty. A scanned slip may carry a Delivery date but never a
       Processing date, so we DERIVE Processing from Delivery: set Delivery, and
       Processing = max(today, Delivery − 6 weeks). When the slip has NO Delivery
       date, leave BOTH empty (the order is un-proceeded — customer not ready).
       The earlier "force Processing = today on every scan" default is removed:
       seeding a lone Processing date violated the both-or-neither rule. */
    if (payload.deliveryDate) {
      setDeliveryDate(payload.deliveryDate);
      setProcessingDate(deriveProcessingDate(payload.deliveryDate));
    }
    /* SO-Maintenance matches from the scan (2026-06-12) — both land in
       normal editable selects, same as a manual pick. */
    if (payload.customerType) setCustomerType(payload.customerType);
    if (payload.buildingType) setBuildingType(payload.buildingType);
    /* VENUE UNIFY (Task #73) — the modal resolved the OCR venue text to a REAL
       venue id from the same useVenues() master this form's Venue dropdown
       renders, so it seeds the dropdown with a valid selection (not free text).
       '' = no confident match → leave the salesperson-default venue alone. */
    if (payload.venueId) setPickedVenueId(payload.venueId);
    /* Matched payment → ONE draft row in the Payments table (visible,
       editable, deletable — flushed only on Create, and only when it
       carries an amount + slip like any manually-added draft). */
    if (payload.payment?.methodValue) {
      const p = payload.payment;
      /* 3-method model (spec 1 + 6, 2026-06-24) — top-level method is only
         Merchant / Online / Cash. The modal already folds any legacy
         "Installment" match to Merchant and defaults a tenure-less Merchant
         card to "One Shot" (not 12 months); we carry its values straight
         through. A Merchant swipe with no tenure arrives as One Shot; Online /
         Cash carry no plan. */
      setPaymentDrafts([{
        ...newPaymentDraft(),
        methodLabel:            p.methodValue,
        merchantProvider:       p.bankValue || '',
        installmentMonthsLabel: p.installmentLabel || '',
        onlineType:             p.onlineTypeValue || '',
        approvalCode:           p.approvalCode || '',
        amountSen:            p.depositSen > 0 ? p.depositSen : 0,
        /* Bug #3 (2026-06-24) — the card receipt scanned in the modal IS this
           deposit's slip. Tag the draft with the receipt's R2 key so the save
           records the deposit through the SO-create proof (receiptImageKey on
           the header) rather than the per-payment slip route. This used to be
           what satisfied the slip-required guard; that guard is gone (Owner
           2026-08-13) but the ROUTING still matters — without the tag the row
           would post as an ordinary payment and the receipt would never land
           on it. */
        receiptImageKey:        payload.receiptImageKey || '',
      }]);
    }
    const lineMeta: Record<string, ScanLineMeta> = {};
    if (Array.isArray(payload.lines) && payload.lines.length > 0) {
      const dd = payload.deliveryDate ?? null;
      setLines(payload.lines.map((l) => {
        const seeded = newLine(dd);
        lineMeta[seeded.rid] = {
          rawText:       l.rawText ?? '',
          suggestedCode: l.suggestedCode ?? '',
          confidence:    l.confidence ?? 0,
          seededCode:    l.itemCode,
        };
        /* FIX (d) — carry the OCR-matched fabric colour onto the line's variants.
           BO315-22 is the WHOLE code: fabric_colours.colourId === the matched
           code (do NOT split it). fabricCode + colourId satisfy SoLineCard's
           Fabrics dropdown + the server's allowed-fabric gate + pricing lookup.
           When the colours/library queries have loaded, ALSO resolve fabricId /
           colour label / hex the way pickFabricColour does so the dropdown shows
           a fully-rehydrated selection (not a bare "(current)" code). If they
           haven't loaded yet, seed fabricCode/colourId alone — SoLineCard's
           "(current)" rehydrate + pickedFabric pricing still work on mount. */
        const fabricCode = l.fabricCode ?? '';
        let fabricVariants: Record<string, unknown> = {};
        if (fabricCode) {
          const colour = (scanFabricColoursQ.data ?? []).find((c) => c.colourId === fabricCode);
          const seriesLabel =
            (scanFabricLibQ.data ?? []).find((f) => f.id === colour?.fabricId)?.label ?? null;
          fabricVariants = {
            fabricCode,
            colourId: fabricCode,
            ...(colour ? { fabricId: colour.fabricId } : {}),
            ...(seriesLabel ? { fabricLabel: seriesLabel } : {}),
            ...(colour?.label ? { colourLabel: colour.label } : {}),
            ...(colour?.swatchHex ? { colourHex: colour.swatchHex } : {}),
          };
        }
        /* OCR specials seed — write the SAME variant keys SoLineCard.toggleSpecial
           does (specials = codes; specialChoices = required option-group defaults
           [first choice]; specialLabels = display snapshot), so a "nylon" slip
           renders the special CHECKED on the line. Codes are already model-gated
           server-side; we just resolve labels + required groups from the live
           special_addons pool. Keep only codes that resolve to a known add-on. */
        const specialCodes = (l.specialCodes ?? []).filter((code) =>
          (scanSpecialsQ.data ?? []).some((d) => d.code === code),
        );
        let specialVariants: Record<string, unknown> = {};
        if (specialCodes.length > 0) {
          const choices: Record<string, string[]> = {};
          for (const code of specialCodes) {
            const def = (scanSpecialsQ.data ?? []).find((d) => d.code === code);
            if (def && def.optionGroups.length > 0) {
              choices[code] = def.optionGroups.map((g) =>
                g.required && g.choices[0] ? g.choices[0].label : '',
              );
            }
          }
          specialVariants = {
            specials: specialCodes,
            specialChoices: choices,
            specialLabels: specialCodes.map(
              (code) => (scanSpecialsQ.data ?? []).find((d) => d.code === code)?.label ?? code,
            ),
          };
        }
        return {
          ...seeded,
          itemCode:       l.itemCode,
          itemGroup:      l.itemGroup || 'others',
          description:    l.description,
          qty:            l.qty > 0 ? l.qty : 1,
          unitPriceSen: l.unitPriceSen,
          remark:         l.remark,
          ...((fabricCode || specialCodes.length > 0)
            ? { variants: { ...seeded.variants, ...fabricVariants, ...specialVariants } }
            : {}),
        };
      }));
    }
    /* Stash the edit-gate carry-through + the blue-diff baseline + per-line
       confidence. The learning POST fires from onSave (below) only when the
       operator's final values differ from this AI-original snapshot. */
    setScanSampleId(payload.sampleId ?? null);
    setScanSalesperson(payload.salesperson ?? null);
    setScanAiOriginal(payload.aiOriginal ?? null);
    setScanLineMeta(lineMeta);
    setScanBaseline({
      debtorName:     payload.customerName || '',
      address1:       payload.address1 || '',
      note:           payload.note || '',
      deliveryDate:   payload.deliveryDate ?? '',
      /* Match the DERIVED Processing Date (Delivery − 6 weeks, floored at today;
         empty when there's no Delivery date) so the blue `.edited` diff doesn't
         falsely flag a field the operator never touched. */
      processingDate: payload.deliveryDate ? deriveProcessingDate(payload.deliveryDate) : '',
      customerType:   payload.customerType || '',
      buildingType:   payload.buildingType || '',
      venueId:        payload.venueId || '',
      customerSoNo:   payload.customerSoRef || '',
      state:          payload.addressState || '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromScan, scanSeeded]);

  /* Blue-diff helper — a field whose current value differs from the
     AI-prefilled baseline gets the `.edited` class (only meaningful on a
     fromScan SO; null baseline → never edited). Compares the live value to
     the snapshot the scan seeded so the operator sees exactly what they
     changed from the AI's guess. */
  const editedClass = (key: keyof ScanBaseline, current: string): string => {
    if (!scanBaseline) return '';
    const base = scanBaseline[key];
    if (base === undefined) return '';
    return current !== base ? styles.edited : '';
  };

  // ── Payments draft state ───────────────────────────────────────────
  /* Task #105 — Same Houzs PaymentsTable used on Detail, but in DRAFT mode
     since the SO doesn't have a docNo yet. We hold the rows here, then
     batch POST them to /:docNo/payments after create succeeds. */
  const [paymentDrafts, setPaymentDrafts] = useState<PaymentDraft[]>([]);
  const [createdDocNo, setCreatedDocNo] = useState<string | null>(null);

  // ── Debtor autocomplete + warehouse lookup ─────────────────────────
  // Debounce before hitting the server: debtorName updates on every keystroke,
  // so passing it raw fired one /debtors/search per character. Measured on prod
  // 2026-08-20, one customer name = 35 requests and the serialized API answered
  // 34 of them 503 (silent — the suggestion list just stayed empty). The
  // consignment sibling (ConsignmentOrderDetail) already debounces at 200ms;
  // match it so a name is 2-3 requests, not one per keystroke.
  const debouncedDebtorName = useDebouncedValue(debtorName, 200);
  const debtors = useDebtorSearch(debouncedDebtorName.trim().length >= 2 ? debouncedDebtorName.trim() : '');
  const [showDebtorSuggest, setShowDebtorSuggest] = useState(false);
  /* Portalled, because this module has no `.field { position: relative }` and
     `.card { overflow: hidden }` left 130px of room for a 260px list. */
  const debtorInputRef = useRef<HTMLInputElement>(null);
  const debtorSuggestions: DebtorSuggestion[] = (debtors.data?.debtors ?? []).filter(
    (d) => (d.debtor_name ?? '').toLowerCase() !== debtorName.trim().toLowerCase(),
  );
  const applyDebtorSuggestion = (d: DebtorSuggestion) => {
    setDebtorCode(d.debtor_code ?? '');
    setDebtorName(d.debtor_name ?? '');
    setPhone(d.phone ?? '');
    setAddress1(d.address1 ?? '');
    setAddress2(d.address2 ?? '');
    setCity(d.address3 ?? '');
    setPostcode(d.address4 ?? '');
    setShowDebtorSuggest(false);
  };

  /* Fabric-identity keys a colour pick writes (SoLineCard.pickFabricColour).
     When one sofa compartment picks a colour we mirror exactly these onto the
     sibling compartments (item 1) — the same keys, so the sibling dropdowns +
     swatches + pricing tier all follow. */
  const FABRIC_SYNC_KEYS = FABRIC_IDENTITY_KEYS;

  const updateLine = (rid: string, patch: Partial<SoLineDraft>) =>
    setLines((prev) => {
      const target = prev.find((l) => l.rid === rid);
      /* Loo 2026-06-09 — sofa remark auto-fills every compartment. A POS sofa
         is split into one line per compartment, all sharing variants.buildKey.
         When the operator types a remark on any one compartment, mirror it onto
         the other compartments of the SAME sofa so every piece carries the note.
         Scoped by buildKey, so a second, different sofa keeps its own remark.
         Only sofas that came in as a split build have a buildKey — manually
         added stand-alone lines have none and never cascade. */
      const bk =
        target && 'remark' in patch
          ? (target.variants as { buildKey?: unknown } | null)?.buildKey
          : undefined;
      const cascadeRemark = typeof bk === 'string' && bk !== '';

      /* Owner — sofa compartment colour auto-sync. When any compartment of a
         sofa sets its fabric COLOUR, the other compartments of the SAME sofa
         (same variants.buildKey) auto-fill the SAME colour. Scoped by buildKey
         so a second, different sofa keeps its own colour; a manually-added
         stand-alone sofa (no buildKey) never cascades. The sibling is left
         alone if it has manually overridden its own fabricCode (overriddenKeys),
         so a deliberately-different compartment colour is never stomped. */
      const patchVariants =
        patch.variants && typeof patch.variants === 'object'
          ? (patch.variants as Record<string, unknown>)
          : null;
      const fbk =
        target && patchVariants && 'fabricCode' in patchVariants
          ? (patchVariants as { buildKey?: unknown }).buildKey
              ?? (target.variants as { buildKey?: unknown } | null)?.buildKey
          : undefined;
      const newFabricCode =
        patchVariants && typeof patchVariants.fabricCode === 'string'
          ? patchVariants.fabricCode
          : '';
      const cascadeFabric =
        typeof fbk === 'string' && fbk !== '' && newFabricCode !== '';
      const fabricSync: Record<string, unknown> = {};
      if (cascadeFabric && patchVariants) {
        for (const k of FABRIC_SYNC_KEYS) {
          if (k in patchVariants) fabricSync[k] = patchVariants[k];
        }
      }

      return prev.map((l) => {
        if (l.rid === rid) return { ...l, ...patch };
        const lbk = (l.variants as { buildKey?: unknown } | null)?.buildKey;
        let next = l;
        if (cascadeRemark && lbk === bk) {
          next = { ...next, remark: patch.remark as string };
        }
        if (
          cascadeFabric &&
          lbk === fbk &&
          !(l.overriddenKeys ?? []).includes('fabricCode')
        ) {
          next = {
            ...next,
            variants: { ...(next.variants ?? {}), ...fabricSync },
          };
        }
        return next;
      });
    });

  /* PR-E — New lines seed their lineDeliveryDate from the current header
     deliveryDate (null until the user fills it in). The cascade effect
     below keeps non-overridden lines in sync with subsequent header
     changes. */
  const addLine  = () => setLines((prev) => [...prev, newLine(deliveryDate || null)]);
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));

  /* Desktop sofa multi-add (MobileSkuPicker.onPickMany parity). SoLineCard's
     multi-select commits the FIRST tick to the current line and hands the REST
     here — each becomes a fresh line seeded exactly like a single pick: real
     itemGroup, SKU sell price, and the same category variant inherit (so a
     second, third… sofa in the same shot follows LINE 1's seat/leg the way a
     manually-added follower line would; the per-sofa colour sync stays scoped
     to real split builds). */
  const addProducts = (rows: MfgProductRow[]) => {
    if (rows.length === 0) return;
    setLines((prev) => {
      const seed: DraftLine[] = rows.map((p) => {
        const category = p.category.toLowerCase();
        const base = newLine(deliveryDate || null);
        return {
          ...base,
          itemCode:       p.code,
          itemGroup:      category,
          description:    p.name,
          unitPriceSen: p.sell_price_sen ?? 0,
          variants:       seedFollowerVariants(inheritVariantsByCategory[category]),
          overriddenKeys: [],
        };
      });
      return [...prev, ...seed];
    });
  };

  /* PR-E — Client-side master-follower cascade for delivery date. Mirrors
     the server-side cascade in PATCH /mfg-sales-orders/:docNo. */
  useEffect(() => {
    setLines((prev) => {
      let didUpdate = false;
      const target = deliveryDate || null;
      const next = prev.map((l) => {
        if (l.lineDeliveryDateOverridden) return l;
        if ((l.lineDeliveryDate ?? null) === target) return l;
        didUpdate = true;
        return { ...l, lineDeliveryDate: target };
      });
      return didUpdate ? next : prev;
    });
  }, [deliveryDate]);

  /* Master-follower cascade for line variants — LINE 1 of each category drives
     the rest. The rule itself is the shared layer (vendor/scm/lib/
     so-variant-cascade); this is only the wiring, and MobileNewSO imports the
     same module rather than carrying a second copy of it.

     Owner ruling 2026-08-21 — the master's LATEST change always wins, so a
     follower the operator had already typed by hand IS overwritten when line 1
     moves again. `overriddenKeys` no longer vetoes this cascade; it still
     guards the per-sofa colour sync in updateLine above, which is a different
     rule (one physical sofa, not one category).

     masterSnapshotRef is what makes "latest" mean anything: it holds the master
     variants as of the previous run, so a key the MASTER just moved is forced
     onto the followers while a key it did not is only used to fill a blank —
     without it a follower could never be edited at all. */
  const masterSnapshotRef = useRef<MasterVariantSnapshot>({});
  useEffect(() => {
    const { variants, masters } = cascadeMasterVariants(
      lines.map((l) => ({ category: l.itemGroup ?? '', variants: (l.variants ?? {}) as Record<string, unknown> })),
      masterSnapshotRef.current,
      /* Desktop cascades EVERY category — a mattress line's specials included.
         Passed explicitly because mobile answers this differently. */
      null,
    );
    masterSnapshotRef.current = masters;
    let didUpdate = false;
    const next = lines.map((l, idx) => {
      if (variants[idx] === l.variants) return l;
      didUpdate = true;
      return { ...l, variants: variants[idx]! };
    });
    if (didUpdate) setLines(next);
  }, [lines]);

  const subtotalSen = useMemo(
    () => lines.reduce(
      (s, l) => s + Math.max(0, l.qty * l.unitPriceSen - l.discountSen),
      0,
    ),
    [lines],
  );

  /* PR #141 — Per-category variants captured from the FIRST line of that
     category that has any variants set. Shared with mobile + SoLineCard, and
     deliberately NOT the same question the cascade's master asks (that one
     takes the first line of the category even when it is still empty). */
  const inheritVariantsByCategory = useMemo(
    () => seedableMasterVariants(
      lines.map((l) => ({ category: l.itemGroup ?? '', variants: (l.variants ?? {}) as Record<string, unknown> })),
    ),
    [lines],
  );

  // ── Locality cascade — shared layer, both directions (address-cascade.ts) ──
  const locRows = useMemo(() => loc.data ?? [], [loc.data]);
  const { cities: cityChoices, postcodes: postcodeChoices } =
    useAddressCascade(locRows, state, city);
  /* This form holds the triple as three separate atoms, so each pick writes all
     three back. The raw setters are deliberate: routing a back-filled State
     through the State picker's own onChange would clear the City/Postcode the
     operator just chose, because that handler exists to reset the cascade. The
     existing state→warehouse effect below then fills Sales Location. */
  const applyTriple = (next: { state: string; city: string; postcode: string }) => {
    setState(next.state);
    setCity(next.city);
    setPostcode(next.postcode);
  };
  const onCityPick = (nextCity: string) =>
    applyTriple(pickCity(locRows, { state, city, postcode }, nextCity));
  const onPostcodePick = (nextPostcode: string) =>
    applyTriple(pickPostcode(locRows, { state, city, postcode }, nextPostcode));

  /* Scan address reconcile (fromScan only) — once the locality cascade for the
     scanned State has options, snap the scanned City to a REAL my_localities
     city for that state (case-insensitive), then snap the scanned Postcode to a
     real postcode for that city. Catalog-validated: a city/postcode the live
     localities list doesn't contain is dropped (never free-typed into a
     dropdown). Each holder is cleared once consumed so a later manual edit
     isn't clobbered. */
  /* Both effects bail unless the State (and, for the postcode, the City) is
     already set, so the lists they read are the state-scoped ones — the same
     values the old state-only memos held. */
  useEffect(() => {
    if (!scanCity || !state || cityChoices.length === 0) return;
    const hit = cityChoices.find((cc) => cc.toLowerCase() === scanCity.trim().toLowerCase());
    if (hit) setCity((prev) => prev || hit);
    setScanCity('');
  }, [scanCity, state, cityChoices]);
  useEffect(() => {
    if (!scanPostcode || !state || !city || postcodeChoices.length === 0) return;
    const want = scanPostcode.trim();
    const hit = postcodeChoices.find((p) => p === want);
    if (hit) setPostcode((prev) => prev || hit);
    setScanPostcode('');
  }, [scanPostcode, state, city, postcodeChoices]);

  /* Commander 2026-05-27 (Fix 5) — State → Sales Location cascade. Same
     rule as Edit SO: pick a state, the Sales Location auto-fills with the
     warehouse code from state_warehouse_mappings. No-op when the state has
     no mapping (commander needs to wire it up in Maintenance first). */
  const stateWarehousesQ = useStateWarehouseMappings();
  useEffect(() => {
    if (!state) return;
    const list = stateWarehousesQ.data?.mappings ?? [];
    if (list.length === 0) return;
    const hit = list.find((m) => m.state === state);
    const code = hit?.warehouse?.code ?? null;
    if (!code) return;
    if (salesLocation === code) return;
    setSalesLocation(code);
  }, [state, stateWarehousesQ.data, salesLocation]);
  /* Task #121 — country derives from the picked state. Display-only on the
     SO form; the API re-derives + snapshots it on POST/PATCH. Falls back
     to 'Malaysia' when no state is picked yet so the field doesn't sit
     visibly blank before the cascade fires. */
  const country = useMemo(
    () => (state ? countryForState(locRows, state) : null) ?? 'Malaysia',
    [locRows, state],
  );

  // ── Salesperson + Venue resolution ─────────────────────────────────
  /* Commander 2026-05-27: default Salesperson to the current user; the
     Venue is then resolved from that staff row's venue_id and locked. */
  const staffList = useMemo(
    () => (staffQ.data ?? []).filter((s) => s.active),
    [staffQ.data],
  );

  /* Nick 2026-07-09 — "sales person 选项只出现 sales department 和 management
     department 的成员". Cross-reference /api/users (Houzs member roster with
     department_ids) against /api/departments so only staff belonging to a
     Sales or Management department show up in the picker. Non-admins already
     see a locked-to-self dropdown, so the queries only run for admins who can
     re-pick. Any failure (403 for a user without users.read, offline, etc.)
     falls back to the unfiltered staff list — better to show too many than
     block SO creation. */
  const houzsUsersQ = useTanstackQuery<{ users: TeamMember[] }>({
    queryKey: ['salesperson-dept-filter', 'users'],
    queryFn: () => api.get<{ users: TeamMember[] }>('/api/users'),
    enabled: canChangeSalesperson,
    staleTime: 10 * 60_000,
    retry: false,
  });
  const departmentsQ = useTanstackQuery<{ departments: Department[] }>({
    queryKey: ['salesperson-dept-filter', 'departments'],
    queryFn: () => api.get<{ departments: Department[] }>('/api/departments'),
    enabled: canChangeSalesperson,
    staleTime: 10 * 60_000,
    retry: false,
  });
  /* IDs of the "Sales" and "Management" departments — matched by name
     case-insensitively so a rename to e.g. "Sales & Marketing" or
     "Management Team" still lands. Empty when the queries are still
     loading or an unrelated dept setup lacks either name. */
  const salespersonAllowedDeptIds = useMemo(() => {
    const rows = departmentsQ.data?.departments ?? [];
    const ids = new Set<number>();
    for (const d of rows) {
      const n = (d.name ?? '').trim().toLowerCase();
      if (n.includes('sales') || n.includes('management')) ids.add(d.id);
    }
    return ids;
  }, [departmentsQ.data]);
  /* Lowercase emails of Houzs users who belong (via department_ids or the
     legacy single department_id) to at least one allowed dept — that's the
     set we cross-reference against StaffRow.email. */
  const salespersonAllowedEmails = useMemo(() => {
    if (salespersonAllowedDeptIds.size === 0) return null;
    const set = new Set<string>();
    for (const u of houzsUsersQ.data?.users ?? []) {
      const deptIds = u.department_ids ?? (u.department_id != null ? [u.department_id] : []);
      const hit = deptIds.some((id) => salespersonAllowedDeptIds.has(id));
      if (!hit) continue;
      const em = (u.email ?? '').trim().toLowerCase();
      if (em) set.add(em);
    }
    return set;
  }, [houzsUsersQ.data, salespersonAllowedDeptIds]);
  /* The SAME cohort, keyed by Houzs user id instead of email — because email is
     not a key that exists on this data. Measured on production 2026-08-12: of
     140 scm.staff rows only 18 carry an email at all, while 102 carry user_id;
     of the 102 ACTIVE rows, 98 have no email. Cross-referencing staff.email
     against the Sales/Management users' emails therefore matched ZERO rows and
     collapsed the picker to nothing but the synthesized self-option. staff.user_id
     IS the link (staff.ts exposes it as `userId` for exactly this), so it is the
     primary match and email is kept only as the fallback for the 18. */
  const salespersonAllowedUserIds = useMemo(() => {
    if (salespersonAllowedDeptIds.size === 0) return null;
    const set = new Set<number>();
    for (const u of houzsUsersQ.data?.users ?? []) {
      const deptIds = u.department_ids ?? (u.department_id != null ? [u.department_id] : []);
      if (!deptIds.some((id) => salespersonAllowedDeptIds.has(id))) continue;
      if (u.id != null) set.add(Number(u.id));
    }
    return set;
  }, [houzsUsersQ.data, salespersonAllowedDeptIds]);

  /* Staff subset the dropdown iterates. Always keep the currently-picked
     staff (grandfather edit-mode / scan-seed rows whose original salesperson
     is no longer in Sales/Management) and always keep the creator (they need
     to see themselves as the default). Filter falls open when the queries
     haven't produced a set yet — we don't want to hide every option while
     loading. */
  const filteredStaffList = useMemo(() => {
    const haveIds = !!salespersonAllowedUserIds && salespersonAllowedUserIds.size > 0;
    const haveEmails = !!salespersonAllowedEmails && salespersonAllowedEmails.size > 0;
    if (!haveIds && !haveEmails) return staffList;
    const selfEmail = (currentUser?.email ?? '').trim().toLowerCase();
    const selfUserId = currentUser?.id != null ? Number(currentUser.id) : null;
    return staffList.filter((s) => {
      if (s.id === salespersonId) return true;
      if (selfUserId != null && s.userId != null && Number(s.userId) === selfUserId) return true;
      if (selfEmail && (s.email ?? '').trim().toLowerCase() === selfEmail) return true;
      if (haveIds && s.userId != null && salespersonAllowedUserIds!.has(Number(s.userId))) return true;
      return haveEmails && salespersonAllowedEmails!.has((s.email ?? '').trim().toLowerCase());
    });
  }, [staffList, salespersonAllowedEmails, salespersonAllowedUserIds, salespersonId, currentUser?.email, currentUser?.id]);

  /* Same Sales+Management filter, projected to staff IDs — piped into
     PaymentsTable so the "Collected By" dropdown mirrors the salesperson
     picker's roster. Null = don't restrict (loading / no dept data). */
  const paymentsCollectedByAllowedIds = useMemo(() => {
    if (!salespersonAllowedEmails || salespersonAllowedEmails.size === 0) return null;
    const selfEmail = (currentUser?.email ?? '').trim().toLowerCase();
    const set = new Set<string>();
    for (const s of staffList) {
      const em = (s.email ?? '').trim().toLowerCase();
      if (em && salespersonAllowedEmails.has(em)) set.add(s.id);
      if (em && selfEmail && em === selfEmail) set.add(s.id);
    }
    return set;
  }, [staffList, salespersonAllowedEmails, currentUser?.email]);

  /* Owner 2026-06-23 — the Salesperson must NEVER be blank for whoever creates
     the order: the creator IS the salesperson.

     Owner 2026-08-21 — and it must never be the word "me" either: it has to be
     a REAL employee. This used to synthesize a UI-only `__self__` option
     labelled "<name> (me)" whenever the creator was missing from the roster,
     and then drop it at submit time so the backend re-derived the id. The
     creator was missing for one reason only — GET /staff/pickable?onlySales=1
     narrows to Sales positions and the owner is not one — so the sentinel was
     papering over a roster that had been asked the wrong question. The roster
     now ALWAYS carries the caller (staff.ts, THE ALWAYS-HOLDS RULE), so this
     resolves to a real staff id on every account and the sentinel is gone.

     The ladder itself is the SHARED `resolveSelfStaff` (vendor/scm/lib) — user_id
     FIRST, then the bridge staff id, then email, then name. It was written here
     and mobile MobileNewSO carried a THIRD, older copy that stopped at
     email-then-name; one module is what stops them disagreeing again. */
  const selfStaffMatch = useMemo(
    () => resolveSelfStaff(staffList, {
      userId: currentUser?.id,
      staffId: currentStaff?.id,
      email: currentUser?.email,
      name: currentUser?.name,
      staffName: currentStaff?.name,
    }),
    [staffList, currentStaff?.id, currentStaff?.name, currentUser?.email, currentUser?.name, currentUser?.id],
  );

  /* Seed salespersonId to the creator once auth/staff resolve — always their
     canonical staff id. Only seeds when the user hasn't already picked someone
     (don't stomp an admin's manual choice on re-render). */
  useEffect(() => {
    if (selfStaffMatch) setSalespersonId((prev) => prev || selfStaffMatch.id);
  }, [selfStaffMatch]);

  /* Derive the resolved venue from whichever salesperson is currently
     picked. Falls back to the auth user's own venue_id if the staff list
     hasn't loaded yet — which is the common case on first paint. */
  const selectedStaff = useMemo(
    () => staffList.find((s) => s.id === salespersonId) ?? null,
    [staffList, salespersonId],
  );
  const resolvedVenueId: string | null =
    selectedStaff?.venueId ?? currentStaff?.venueId ?? null;
  const resolvedVenueName: string = useMemo(() => {
    if (!resolvedVenueId) return '';
    const v = (venuesQ.data ?? []).find((r) => r.id === resolvedVenueId);
    return v?.name ?? '';
  }, [resolvedVenueId, venuesQ.data]);

  /* Houzs 2026-06-22 (owner: "houzs 的 venue 是 manually 選的") — unlike 2990,
     where Commander locked Venue to the salesperson's home venue, Houzs picks
     Venue manually. Defaults to the salesperson's venue but stays changeable. */
  const [pickedVenueId, setPickedVenueId] = useState<string | null>(null);
  const effectiveVenueId = pickedVenueId ?? resolvedVenueId;
  const effectiveVenueName: string = useMemo(() => {
    if (!effectiveVenueId) return '';
    return (venuesQ.data ?? []).find((r) => r.id === effectiveVenueId)?.name ?? '';
  }, [effectiveVenueId, venuesQ.data]);

  /* Houzs venue auto-fill (owner 2026-06-25) — the logged-in salesperson is
     assigned to an exhibition project (Sales Attending), so the system already
     knows that week's venue; the operator shouldn't have to type it. Resolve
     the active project's venue (latest project by start_date <= today they
     attend; attribution stays on the previous event until the next one starts)
     and pre-select it in the Venue dropdown. A venue present in the
     project_venues master gets its option auto-selected; one not in the master
     is still stamped server-side on save (we show a hint). OCR / a manual pick
     still wins — we only auto-apply while nothing is picked. */
  const [autoVenue, setAutoVenue] = useState<AutoVenue | null>(null);
  useEffect(() => {
    let alive = true;
    authedFetch<AutoVenue>(
      '/mfg-sales-orders/active-venue',
    )
      .then((r) => { if (alive) setAutoVenue(r); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (autoVenue?.venueId && pickedVenueId == null) setPickedVenueId(autoVenue.venueId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoVenue]);

  /* Phone is compulsory on every SO; name too. We no longer pre-disable the Save
     button on these — onSave validates and tells the operator exactly what's
     missing (a silently-greyed button left them guessing). The server also
     enforces phone (400 phone_required). */

  /* Mirror Detail's XOR rule (PR #156): Processing Date and Delivery Date
     must both be filled in or both empty. */
  const datesXor = (processingDate.trim() !== '') !== (deliveryDate.trim() !== '');
  /* Commander 2026-05-28 — Processing/Delivery dates may only be today or a
     future date (input min + Save guard). todayMyt() = Malaysia (UTC+8)
     calendar date, so the floor is right regardless of the browser's own
     timezone (a browser set off-GMT+8 could otherwise let yesterday through). */
  const today = todayMyt();

  /* Task #105 — After POST /mfg-sales-orders succeeds, replay every payment
     draft through POST /:docNo/payments in parallel via the existing mutation
     hook (useAddSalesOrderPayment.mutateAsync). Failures don't roll the SO
     back (the SO is already created), but we surface them so commander can
     re-enter the affected rows on the Detail page. */
  /* Line-card-redesign (Commander 2026-05-27) — Photos can now be staged
     on a brand-new line BEFORE the SO is saved. The SoLineCard component
     stages them as File objects on `draft.pendingPhotoFiles`. After
     POST /mfg-sales-orders succeeds we GET /:docNo to read back the saved
     item IDs, match each saved item to a draft line by index, then upload
     every staged File via the existing per-item /photos endpoint.

     Item ordering: the API inserts items in the order we send them and
     returns them ordered by created_at, so positional matching is safe.
     If the counts ever drift (server-side filtering of bad rows, etc.)
     we surface a soft warning and skip the mismatched lines rather than
     guess. The SO is already created so we don't roll back. */
  const flushPendingPhotos = async (
    docNo: string,
    draftLines: DraftLine[],
  ): Promise<{ failed: number; skipped: number }> => {
    const linesWithPending = draftLines.filter(
      (l) => (l.pendingPhotoFiles?.length ?? 0) > 0,
    );
    if (linesWithPending.length === 0) return { failed: 0, skipped: 0 };

    // HOUZS VENDOR — read the saved item IDs back through the vendored
    // authedFetch (→ /api/scm/mfg-sales-orders/:docNo), bypassing the
    // TanStack cache (the freshly-created detail may not be cached yet).
    let savedItems: Array<{ id: string; item_code: string }> = [];
    try {
      const body = await authedFetch<{ items: Array<{ id: string; item_code: string }> }>(
        `/mfg-sales-orders/${docNo}`,
      );
      savedItems = body.items ?? [];
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[so-line-photos] could not load saved item IDs:', e);
      void humanApiError;
      return { failed: linesWithPending.length, skipped: 0 };
    }

    /* Positional match — `validLines` is the same slice we sent to
       POST /mfg-sales-orders so `savedItems[i]` corresponds to
       `validLines[i]`. We only iterate over validLines so cancelled
       drafts (no itemCode) are skipped without breaking the index. */
    const validLines = draftLines.filter((l) => l.itemCode.trim() && l.qty > 0);
    let failed = 0;
    let skipped = 0;
    for (let i = 0; i < validLines.length; i++) {
      const line = validLines[i]!;
      const files = line.pendingPhotoFiles ?? [];
      if (files.length === 0) continue;
      const saved = savedItems[i];
      if (!saved || saved.item_code !== line.itemCode) {
        // Mismatch — log + skip rather than upload to the wrong line.
        // eslint-disable-next-line no-console
        console.warn('[so-line-photos] index/item_code mismatch — skipping pending uploads', {
          index: i, expected: line.itemCode, got: saved?.item_code,
        });
        skipped += files.length;
        continue;
      }
      for (const f of files) {
        try {
          await uploadPhoto.mutateAsync({ docNo, itemId: saved.id, file: f });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[so-line-photos] upload failed', { file: f.name, err });
          failed++;
        }
      }
    }
    return { failed, skipped };
  };

  const paymentIntents = () => paymentDrafts.filter((d) => d.amountSen > 0 && !d.receiptImageKey);

  const flushPaymentDrafts = async (docNo: string, drafts: PaymentDraft[]): Promise<{ failedDrafts: PaymentDraft[] }> => {
    const tasks = drafts
      /* Bug #3 (2026-06-24) — a receipt-backed deposit (scanned in the modal) is
         recorded through the SO-create body's deposit fields, where the receipt
         becomes its proof. `paymentIntents()` has already excluded it, so this
         list never double-books it. */
      .map((d) => async () => {
        const { method } = labelToApi(d.methodLabel);
        const body: { docNo: string } & Record<string, unknown> = {
          docNo,
          /* The draft IS the intent — newPaymentDraft minted this key when the
             operator added the row, and it survives a failed submit, so a
             re-pressed Save replays rather than books twice. The hook
             destructures it OUT of the body into the header. */
          idempotencyKey:  d.idempotencyKey,
          paidAt:          d.paidAt,
          method,
          amountSen:     d.amountSen,
          accountSheet:    d.accountSheet || null,
          approvalCode:    d.approvalCode || null,
          collectedBy:     d.collectedBy  || null,
          /* Null when the operator attached none — the slip is OPTIONAL
             (Owner 2026-08-13) and the route records a slip-less payment.
             A row is posted on its AMOUNT alone; never filter this list on the
             slip, or the payment silently never books. */
          uploadSessionId: d.slipUploadSessionId,
        };
        /* Task #122 (cascade) — replay the L2 picks per method so the
           created payment row carries the bank + plan / sub-type that
           commander entered during the draft. */
        Object.assign(body, draftMethodFields(method, d));
        try {
          await addPayment.mutateAsync(body);
          if (d.idempotencyKey) completePaymentRetryDraft('so', docNo, d.idempotencyKey);
          return null;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[payment] post failed for new SO:', e);
          return d;
        }
      });
    const results: Array<PaymentDraft | null> = [];
    for (const task of tasks) results.push(await task());
    return { failedDrafts: results.filter((draft): draft is PaymentDraft => draft !== null) };
  };

  /* ── Scan-review learning (fromScan only) ──────────────────────────────
     Task #73 — the OCR review now happens in THIS form, so the learning POST
     that used to fire from the modal fires HERE, on save. We rebuild the
     operator's FINAL values into the ExtractedSlip shape and compare against
     the frozen AI-original, then POST /scan-so/samples/:id/confirm so the
     review becomes a few-shot example (+ re-distills the rep's rules when the
     operator actually corrected something). Fire-and-forget — it never blocks
     or fails the save.

     This used to fire ONLY when something changed, which threw away every scan
     the operator accepted as-is — the strongest evidence extraction was right.
     It now always fires and sends `accepted` so the backend can tell the two
     outcomes apart (scan-so.ts SAMPLE_* header).

     The corrected blob mirrors the extracted-slip shape the distiller pairs
     against the AI-original (customer block, option matches, per-line
     rawText→code). Only the fields the form actually exposes are reconciled;
     everything else is carried straight from the AI-original so the diff is
     limited to what the operator genuinely touched. */
  const maybeLearnFromScan = (validLines: DraftLine[]) => {
    if (!fromScan) return;
    if (!scanSampleId) { reportScanLearningSkipped('no-sample-id', 'desktop'); return; }
    if (!scanAiOriginal) { reportScanLearningSkipped('no-ai-original', 'desktop'); return; }
    const ai = scanAiOriginal;

    const optMatch = (v: string) =>
      v ? { value: v, confidence: 1, reason: 'operator-confirmed' } : null;
    const phones = phone.trim() ? [phone.trim()] : ai.phones;
    const norm = (s: string | null | undefined) => (s ?? '').trim();

    /* Did the operator GENUINELY correct something? Compare their final values
       against the AI's on the dimensions that actually teach the OCR: customer
       block, the option matches, and per-line SKU/qty/price. (The form reshapes
       the slip, so a structural stringify diff would always "differ" — we
       compare field-by-field.)
       This is no longer a GATE — it is the sample's LABEL. An unchanged scan is
       the operator confirming the AI read the slip perfectly, which is a
       positive example worth learning from, not a non-event; it POSTs with
       accepted:true and lands as ACCEPTED. The backend keeps the two apart
       because they teach different things (see scan-so.ts's SAMPLE_* header). */
    let changed = false;
    const mark = (a: string, b: string) => { if (a !== b) changed = true; };
    mark(norm(debtorName), norm(ai.customerName));
    mark(norm(address1), norm(ai.addressLine1 ?? ai.address));
    mark(norm(state), norm(ai.addressStateMatch?.value));
    mark(norm(city), norm(ai.city));
    mark(norm(postcode), norm(ai.postcode));
    mark(norm(customerSoNo), norm(ai.customerSoRef));
    mark(norm(customerType), norm(ai.customerTypeMatch?.value));
    mark(norm(buildingType), norm(ai.buildingTypeMatch?.value));
    mark(norm(paymentDrafts[0]?.methodLabel), norm(ai.paymentMethodMatch?.value));
    mark(norm(paymentDrafts[0]?.merchantProvider), norm(ai.bankMatch?.value));
    mark(norm(paymentDrafts[0]?.onlineType), norm(ai.onlineTypeMatch?.value));
    mark(norm(paymentDrafts[0]?.installmentMonthsLabel), norm(ai.installmentPlanMatch?.value));
    // Line count differing (operator added/removed a row) is itself a correction.
    if (validLines.length !== ai.lines.length) changed = true;
    for (const l of validLines) {
      const meta = scanLineMeta[l.rid];
      // A line with no scan meta was added by the operator → a correction.
      if (!meta) { changed = true; continue; }
      if (l.itemCode !== meta.seededCode) changed = true;
    }

    const corrected: ExtractedSlip = {
      customerName: debtorName.trim() || null,
      address: address1.trim() || null,
      /* Operator-final structured address — the form's State is a real
         my_localities value, so it's a confirmed addressStateMatch; city /
         postcode are the dropdown-validated picks. */
      addressLine1: address1.trim() || null,
      city: city.trim() || null,
      postcode: postcode.trim() || null,
      addressStateMatch: optMatch(state),
      phones,
      location: ai.location,
      deliveryDate: deliveryDate || ai.deliveryDate,
      /* UNCHANGED MAPPING, made visible by the 2026-08-13 rename: the SO's
         Processing Date (DERIVED here as Delivery − 6 weeks) is written back
         into the slip's own `slipDate` — the day the rep wrote the slip. Those
         are two different facts; the backend's CARRIED_NOT_INVERTED lists
         slipDate so this never reaches the distillers. Rewiring it is a
         behaviour change, not a rename, so it is deliberately left alone. */
      slipDate: processingDate || ai.slipDate,
      salesRep: scanSalesperson || ai.salesRep,
      customerSoRef: customerSoNo.trim() || ai.customerSoRef,
      paymentMethod: ai.paymentMethod,
      depositRm: ai.depositRm,
      totalRm: ai.totalRm,
      remarks: ai.remarks,
      approvalCode: ai.approvalCode,
      /* Operator-confirmed option picks win; the form's selects are the
         dropdown-validated source of truth now. */
      paymentMethodMatch:   optMatch(paymentDrafts[0]?.methodLabel ?? '') ?? ai.paymentMethodMatch,
      bankMatch:            optMatch(paymentDrafts[0]?.merchantProvider ?? '') ?? ai.bankMatch,
      onlineTypeMatch:      optMatch(paymentDrafts[0]?.onlineType ?? '') ?? ai.onlineTypeMatch,
      installmentPlanMatch: optMatch(paymentDrafts[0]?.installmentMonthsLabel ?? '') ?? ai.installmentPlanMatch,
      customerTypeMatch:    optMatch(customerType),
      buildingTypeMatch:    optMatch(buildingType),
      locationMatch:        ai.locationMatch,
      /* Per-line correction — pair the slip's verbatim rawText (carried from
         the scan) with the operator's FINAL itemCode/qty/price so the
         distiller learns this rep's handwriting → catalog mapping. */
      lines: validLines.map((l) => {
        const meta = scanLineMeta[l.rid];
        const rawText = meta?.rawText ?? l.remark;
        const codeChanged = !meta || l.itemCode !== meta.seededCode;
        return {
          rawText,
          qtyGuess: l.qty,
          priceRmGuess: l.unitPriceSen > 0 ? l.unitPriceSen / 100 : null,
          skuMatch: l.itemCode
            ? {
                code: l.itemCode,
                confidence: codeChanged ? 1 : (meta?.confidence ?? 1),
                reason: codeChanged ? 'operator-picked' : 'operator-confirmed',
              }
            : null,
          fabricMatch: null,
          /* Operator-confirmed specials on this line (variants.specials carries
             the checked codes) → the distiller learns the corrected set. */
          specialsMatch: (Array.isArray(l.variants.specials)
            ? (l.variants.specials as unknown[]).filter(
                (c): c is string => typeof c === 'string' && c.trim() !== '',
              )
            : []
          ).map((code) => ({ code, confidence: 1, reason: 'operator-confirmed' })),
          notes: null,
        };
      }),
    };

    void postScanLearningSample(
      authedFetch,
      scanSampleId,
      { corrected, salesperson: scanSalesperson || null, accepted: !changed },
      'desktop',
    );
  };

  /* DRAFT flow — `asDraft` adds `asDraft: true` to the create body so the SO
     lands as DRAFT (excluded from KPI/MRP/PO/DO until Confirmed on Detail).
     The two header buttons both call onSave; only the flag differs. When the
     form was opened from a scan (fromScan), "Save as Draft" is the primary
     button so scanned orders default to draft for operator review. */
  const onSave = (asDraft = false) => {
    if (createdDocNo) {
      const intents = paymentIntents();
      if (intents.length === 0) {
        navigate(`/scm/sales-orders/${createdDocNo}`);
        return;
      }
      if (!writePaymentRetryHandoff('so', createdDocNo, intents)) {
        void notify({
          title: `Sales order ${createdDocNo} already exists; payments were not sent.`,
          body: 'Browser storage is still unavailable. This page is keeping the payment rows; retry Save after storage is available.',
          tone: 'error',
        });
        return;
      }
      navigate(`/scm/sales-orders/${createdDocNo}?payments=1&retryPayments=1`, {
        state: paymentRetryNavigationState('so', createdDocNo, intents),
      });
      return;
    }
    /* One-pass required-field check (owner 2026-08-20 live QA: "为什么要慢慢爆呢"
       — the form popped ONE missing field per click). Collect EVERY always-required
       field the operator is missing and show them together. The CONDITIONAL guards
       below (date sanity, scanned-SKU, sofa-mix, Processing-Date proceed gate, the
       "State has no warehouse" config case, payment sub-fields) still run one at a
       time, because each only applies once an earlier choice is made. Shared with
       mobile via soRequiredFieldErrors so the required set can't drift. */
    const validLines = lines.filter((l) => l.itemCode.trim() && l.qty > 0);
    const missingRequired = soRequiredFieldErrors({
      customerName: debtorName,
      phone,
      hasNamedLine: validLines.length > 0,
      asDraft,
      hasVenue: !!effectiveVenueId,
      hasSalesperson: !!salespersonId,
      location: { companyCode: branding.companyCode, salesLocation, state, mappingsLoaded: !!stateWarehousesQ.data, asDraft },
    });
    /* BOTH lists, ONE dialog. The proceeding-address group's condition is
       `processingDate`, which is known right here — it only READ like a
       sequential guard because it sat in a second `if` further down that the
       return above never reached. Owner 2026-08-23: 「create salesorder 要两
       次？」 — Venue and State on the first press, address and postcode on the
       second. */
    const missingProceeding = soProceedingAddressErrors({
      processingDate,
      customerName: debtorName,
      fillAddressLater,
      address1,
      postcode,
      deliveryDate,
    });
    if (missingRequired.length > 0 || missingProceeding.length > 0) {
      void notify({ ...soRequiredFieldsMessage(missingRequired, missingProceeding), tone: 'error' });
      return;
    }
    // Date sanity (set-together / not-past / processing≤delivery) — shared with
    // mobile via soDateGuardError so the rule can't drift between surfaces.
    const dateErr = soDateGuardError({ processingDate, deliveryDate, today });
    if (dateErr) {
      void notify({ ...dateErr, tone: 'error' });
      return;
    }
    /* Scan-Order core rule (Task #73) — a NO-MATCH scanned line seeds an empty
       SKU picker the operator MUST fill from the dropdown ("应该是 dropdown 而
       不是 manually 填写"). Block the save while any scanned line is still
       unpicked (it carries the slip rawText but no itemCode) rather than
       silently dropping it, so the operator is forced to pick a real SKU. */
    const unpickedScanned = lines.filter((l) => !l.itemCode.trim() && (scanLineMeta[l.rid]?.rawText ?? '').trim() !== '');
    if (unpickedScanned.length > 0) {
      void notify({
        title: 'Pick a SKU for every scanned line.',
        body:
          `${unpickedScanned.length} scanned line${unpickedScanned.length === 1 ? '' : 's'} ` +
          `${unpickedScanned.length === 1 ? "doesn't" : "don't"} have a product picked yet. ` +
          'Pick a real SKU from the dropdown (the slip text is shown as a hint) or remove the line, then try again.',
        tone: 'error',
      });
      return;
    }
    // Sofa is exclusive among main products — the server 400s
    // `so_sofa_no_other_main` when a sofa line rides with a bedframe/mattress.
    // Block + warn here so the operator gets one plain sentence, not a raw 400.
    if (hasSofaMixConflict(validLines.map((l) => l.itemGroup))) {
      void notify({ title: SOFA_MIX_MESSAGE, tone: 'error' });
      return;
    }
    /* Variant completeness is the PROCEED rule, and only the proceed rule
       (owner 2026-08-13: "只要是没有 proceed 这一张订单，其实都不一定是需要填写
       的，除非它是 proceed 了"). A Processing Date IS proceed, so it demands the
       full axis list — the same rule the server applies (so-variant-check via
       collectProcessingGateProblems), together with the address / postcode /
       delivery-date completeness the same date requires.

       It briefly ALSO ran at confirm, date or no date (2026-08-08,
       HC-SO-2607-008). That made a salesperson unable to book a real order
       from a real customer who had not yet picked a seat height. Removed:
       confirm means "this is a real order", proceed means "this is
       buildable". Save as Draft was never gated either way. */
    if (processingDate) {
      /* Delivery completeness is the SAME proceed rule, and the server has
         enforced it on procDate alone since 2026-07-31 (so-save-problems.ts).
         Check it HERE too, or a blank address — or "Fill in address later" left
         ticked, which BLANKS the address out of the payload — comes back as a
         bare validation_failed naming no field. */
      /* The address fields moved UP into the one-pass check above — see
         soProceedingAddressErrors. Nothing is checked twice: reaching here means
         that list was empty. The "untick Fill in address later" hint went with
         them into the shared message. */
      const missOf = (l: SoLineDraft): string[] =>
        missingRequiredVariants(l.itemGroup, l.variants, l.itemCode);
      const variantGaps = validLines
        .map((l) => ({ code: l.itemCode, miss: missOf(l) }))
        .filter((x) => x.miss.length > 0);
      if (variantGaps.length > 0) {
        void notify({
          title: 'Complete all variant selections before setting a Processing Date:',
          body: variantGaps.map((x) => `• ${x.code}: ${x.miss.join(', ')}`).join('\n'),
          tone: 'error',
        });
        return;
      }
    }
    /* Confirm gates (owner 2026-08-08) — a confirmed order needs a venue and a
       salesperson; drafts stay freely saveable. Both are now collected in the
       one-pass required-field check above (soRequiredFieldErrors), so the backend
       stays the authoritative gate and the operator sees them alongside the other
       missing fields rather than in two more separate dialogs. The SELF sentinel
       counts as a salesperson: the backend stamps the caller's own staff row. */
    /* Stock-location gate (owner 2026-08-13, company 1 only) — the order must
       ship from a warehouse or AutoCount refuses the whole document. SHARED
       with mobile via soStockLocationError; the backend is the authoritative
       gate (422 validation_failed) and this only saves the operator a
       round-trip with a form full of typing. Reads the SAME salesLocation the
       create body sends, so the two can never disagree. */
    const locationErr = soStockLocationError({
      companyCode: branding.companyCode,
      salesLocation,
      state,
      mappingsLoaded: !!stateWarehousesQ.data,
      asDraft,
    });
    if (locationErr) {
      void notify({ ...locationErr, tone: 'error' });
      return;
    }

    /* NO SLIP GUARD (Owner 2026-08-13) — "SalesOrder 所有的付款都不强制".
       A payment slip is optional on every SO path now, so an amount-bearing
       draft saves without one; the row is still POSTED (flushPaymentDrafts
       filters on amount, never on the slip), which is the half that matters.
       A scanned card receipt still rides along on its own path — see
       receiptDeposit below. */

    /* Cascade guard (spec 1) — a chosen payment method needs its required
       sub-field(s): Merchant → Bank + Plan; Online → Sub-Type; Cash → none.
       Block the save and name the first row + missing field so commander knows
       exactly what to pick. Only checks amount-bearing rows (a zeroed/blank row
       is dropped at flush time). */
    const methodGaps = paymentDrafts
      .map((d, i) => ({ row: i + 1, method: d.methodLabel, missing: d.amountSen > 0 ? missingMethodSubField(d) : null }))
      .filter((x) => x.missing !== null);
    if (methodGaps.length > 0) {
      const g = methodGaps[0]!;
      void notify({
        title: `Payment ${g.row} (${g.method}) needs a ${g.missing}.`,
        body: 'Pick the required sub-field for each payment method before saving.',
        tone: 'error',
      });
      return;
    }

    /* Edit-gate — operator committed to saving, so fold their corrections back
       into the few-shot pool (fire-and-forget, fromScan only). */
    maybeLearnFromScan(validLines);

    /* Bug #3 (2026-06-24) — the modal seeds ONE receipt-backed deposit (the card
       receipt scanned alongside the slip). Record it through the SO-create
       deposit fields so the backend books it WITHOUT demanding a second slip
       upload (the receipt, on the header as receipt_image_key, IS the proof).
       flushPaymentDrafts skips it. A manually-added row is unaffected. */
    const receiptDeposit = paymentDrafts.find(
      (d) => d.amountSen > 0 && Boolean(d.receiptImageKey),
    );
    const receiptDepositBody = receiptDeposit
      ? (() => {
          const { method } = labelToApi(receiptDeposit.methodLabel);
          return {
            depositSen:      receiptDeposit.amountSen,
            paymentMethod:     method,
            merchantProvider:  receiptDeposit.merchantProvider || undefined,
            installmentMonths: parseInstallmentMonths(receiptDeposit.installmentMonthsLabel) ?? undefined,
            approvalCode:      receiptDeposit.approvalCode || undefined,
            paymentDate:       receiptDeposit.paidAt || undefined,
          };
        })()
      : {};

    /* The money the create-time Processing-Date gate would otherwise not see.
       `receiptDepositBody` only carries a deposit that was SCANNED (it needs a
       receiptImageKey), so a hand-entered payment reached the backend as RM0 and
       the gate refused the save with the amount plainly on screen — and because
       the per-payment posts happen AFTER create, the create had to succeed first
       for the money to ever land. Deadlock.
       Counted for the GATE ONLY, server-side: it is never booked. The rows are
       exactly `paymentIntents()` — what flushPaymentDrafts is about to post,
       which by its own filter excludes the receipt-backed deposit the create
       body already carries — so this can neither claim money the client is not
       about to record nor count the same ringgit twice. It used to ALSO demand
       a slip session; once the slip became optional (Owner 2026-08-13) that
       would have re-opened the very deadlock this field exists to close, a
       slip-less deposit counting as RM0 against a Processing Date the operator
       can see is paid for. */
    const pendingDepositSen = paymentIntents()
      .reduce((sum, d) => sum + d.amountSen, 0);

    create.mutate(
      {
        idempotencyKey: idemKey,
        ...receiptDepositBody,
        pendingDepositSen: pendingDepositSen > 0 ? pendingDepositSen : undefined,
        /* DRAFT flow — backend reads `asDraft: true` to create the SO as 'DRAFT'
           not 'CONFIRMED'. Omitted on a normal Create, so that body is unchanged. */
        asDraft: asDraft || undefined,
        /* `manualEntry: true` stood here — a bare literal on EVERY create, which
           the backend read as "drop the deposit condition for this screen". The
           phone sent nothing and was refused the identical order. Owner ruling
           2026-08-20 (「以电脑为准 —— 两边都不查」) removed the condition itself,
           so there is nothing left to waive and no flag to send. */
        debtorName,
        debtorCode: debtorCode || undefined,
        phone: phone || undefined,
        email: email || undefined,
        /* Always a real scm.staff uuid now — the roster carries the caller, so
           there is no sentinel to strip. Omitted only when the field is
           genuinely empty (roster still loading), where the backend falls back
           to its own caller-based resolution. */
        salespersonId: salespersonId || undefined,
        customerType: customerType || undefined,
        customerSoNo: customerSoNo || undefined,
        /* Commander 2026-05-27: Venue is locked to the picked salesperson's
           home venue. Send the FK so the API persists `venue_id`; we also
           send the resolved name as the legacy free-text `venue` column
           for back-compat with reports / PDFs that still read it. */
        venueId: effectiveVenueId ?? undefined,
        venue: effectiveVenueName || undefined,
        /* Address handling: address1/2 skipped when fill-later is on, but
           State/City/Postcode/BuildingType always submit. */
        address1: fillAddressLater ? undefined : (address1 || undefined),
        address2: fillAddressLater ? undefined : (address2 || undefined),
        customerState: state || undefined,
        city: city || undefined,
        postcode: postcode || undefined,
        /* Commander 2026-05-27 (Fix 5) — auto-resolved from State via
           state_warehouse_mappings; persisted so reports + dispatch flows
           see it without a separate edit. */
        salesLocation: salesLocation || undefined,
        buildingType: buildingType || undefined,
        emergencyContactName:         emergencyName  || undefined,
        emergencyContactRelationship: emergencyRel   || undefined,
        emergencyContactPhone:        emergencyPhone || undefined,
        /* PR #121 — Processing Date → processing_date, Delivery Date →
           customer_delivery_date. */
        processingDate:   processingDate || undefined,
        customerDeliveryDate: deliveryDate   || undefined,
        note: note || undefined,
        /* Original-slip provenance — the scanned slip's R2 key (from the Scan
           Order handoff) so the SO detail page can show it as proof. */
        slipImageKey: scanSlipImageKey || undefined,
        /* Payment-receipt provenance — the scanned card-terminal receipt's R2
           key (from the Scan Order handoff) so the SO detail page can show it
           as "Payment Receipt" proof alongside the order slip. */
        receiptImageKey: scanReceiptImageKey || undefined,
        /* PR #114 — full variant payload preserved end-to-end. */
        items: validLines.map((l) => ({
          itemGroup:      l.itemGroup,
          itemCode:       l.itemCode,
          description:    l.description,
          uom:            l.uom,
          qty:            l.qty,
          unitPriceSen: l.unitPriceSen,
          /* A TYPED 0 is a free line; an untouched 0 is an unpriced SKU the server must still price. */
          ...zeroPriceClaim(l.unitPriceSen, l.priceAuthored === true),
          discountSen:  l.discountSen,
          unitCostSen:  l.unitCostSen,
          variants:       l.variants,
          remark:         l.remark,
          /* PR-E — per-item delivery date + cascade override flag. */
          lineDeliveryDate:           l.lineDeliveryDate ?? null,
          lineDeliveryDateOverridden: l.lineDeliveryDateOverridden ?? false,
        })),
      },
      {
        onSuccess: async (res: { docNo: string }) => {
          /* THE ACCOUNTS MAY HAVE REFUSED IT, and until 2026-08-19 only a queue
             behind a permission key knew. Never blocks — the order is saved. */
          await notifyAcNotSent(notify, res, 'Sales order');
          /* Task #105 — Fire the queued payment drafts as follow-up POSTs.
             We don't gate navigation on success — if a payment fails the
             SO still exists, so we navigate to the Detail page where
             commander can re-enter the affected row. */
          const intents = paymentIntents();
          const staged = intents.length === 0 || writePaymentRetryHandoff('so', res.docNo, intents);
          const { failedDrafts } = staged
            ? await flushPaymentDrafts(res.docNo, intents)
            : { failedDrafts: intents };
          const failed = failedDrafts.length;
          /* Line-card-redesign — Drain pendingPhotoFiles for every line
             after the SO + items exist. Same non-blocking pattern as
             payments: a photo failure leaves the SO intact and we
             surface a warning rather than rolling back. */
          const { failed: photoFailed, skipped: photoSkipped } =
            await flushPendingPhotos(res.docNo, validLines);
          if (failed > 0) {
            await notify({
              title: `Sales order ${res.docNo} was created, but ${failed} ` +
                `payment row${failed === 1 ? '' : 's'} ${staged ? 'failed to save' : 'was not sent'}.`,
              body: staged
                ? 'The failed rows will be available to retry on the Detail page.'
                : 'Browser storage was unavailable, so no payment request was attempted. The rows are carried to the Detail page for a safe retry.',
              tone: 'error',
            });
          }
          if (photoFailed > 0 || photoSkipped > 0) {
            await notify({
              title: `Sales order ${res.docNo} was created, but ${photoFailed + photoSkipped} ` +
                `staged photo${(photoFailed + photoSkipped) === 1 ? '' : 's'} could not be uploaded.`,
              body: 'Please re-attach on the Detail page.',
              tone: 'error',
            });
          }
          if (!staged) {
            setCreatedDocNo(res.docNo);
            return;
          }
          navigate(
            `/scm/sales-orders/${res.docNo}${failed > 0 ? '?payments=1&retryPayments=1' : ''}`,
            { state: failed > 0 ? paymentRetryNavigationState('so', res.docNo, failedDrafts) : undefined },
          );
        },
        /* Aggregated save-gate failure → every reason at once (owner
           2026-07-18); anything else keeps this page's own "Save failed" popup. */
        onError: (err) => { void notifySaveProblems(notify, err,
          (m) => { void notify({ title: 'Save failed', body: m, tone: 'error' }); }); },
      },
    );
  };

  return (
    <div>
      {/* Shared sticky page header — full-bleed, matches SalesOrderMaintenance
          + the PO/DO V2 lists. DRAFT flow: two create actions run the SAME
          create + post-create payment/photo flush + navigation; only the
          `asDraft` flag differs. From a scan handoff (fromScan) the scanned
          order defaults to DRAFT for operator review, so "Save as Draft" is
          the PRIMARY button and "Create" the secondary one; for a normal New
          SO, "Create" stays primary. The buttons stay CLICKABLE even when
          fields are missing (only blocked while a save is in flight) — onSave
          validates and tells the operator EXACTLY what's missing. */}
      <PageHeader back
        eyebrow="Sales order"
        title={createdDocNo ? `Complete Sales Order ${createdDocNo}` : 'New Sales Order'}
        description={createdDocNo
          ? 'The order already exists. Finish or remove the retained payment rows, then continue to its Detail page.'
          : 'Customer, order info, delivery address, line items and payments — saved as one order.'}
        actions={
          <>
            {/* h-9 = the <Button> height — this link shares the rail with
                Cancel / Create Sales Order / Save as Draft. */}
            <Link
              to="/scm/sales-orders"
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary"
            >
              <ArrowLeft size={14} /> Sales Orders
            </Link>
            <Button variant="ghost" onClick={() => navigate('/scm/sales-orders')}>
              <X {...ICON} /> Cancel
            </Button>
            <Button
              variant={fromScan ? 'secondary' : 'primary'}
              onClick={() => onSave(false)}
              disabled={create.isPending}
            >
              <Save {...ICON} />
              {create.isPending
                ? 'Saving…'
                : createdDocNo
                  ? (paymentIntents().length > 0 ? 'Continue payment retry' : 'Open created order')
                  : 'Create Sales Order'}
            </Button>
            <Button
              variant={fromScan ? 'primary' : 'secondary'}
              onClick={() => onSave(true)}
              disabled={create.isPending || !!createdDocNo}
            >
              <Save {...ICON} />
              {create.isPending ? 'Saving…' : 'Save as Draft'}
            </Button>
          </>
        }
      />

      <div className="space-y-3">
      {createdDocNo && (
        <div role="status" className="rounded-lg border border-warning-text/30 bg-warning-bg px-3 py-2 text-sm text-warning-text">
          Sales order {createdDocNo} already exists. This recovery view only keeps payment rows; customer, order and line-item fields are hidden so unsaved edits cannot be lost.
        </div>
      )}
      {!createdDocNo && (<>
      {/* ── SCAN BANNER (fromScan only) ───────────────────────────────
          Task #73 — the OCR review happens in THIS form now. Tell the operator
          to check every dropdown-bound field before saving. Changed fields show
          a blue highlight; each scanned line shows a "scanned · NN%" chip. */}
      {fromScan && (
        <div className="flex items-start gap-3 rounded-lg border border-learning/40 bg-learning/5 px-4 py-3 text-[13px] text-learning">
          <Camera size={18} strokeWidth={1.75} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">Prefilled from a scanned slip — check every dropdown before saving.</div>
            <div className="mt-0.5 text-learning/80">
              Confirm the venue, SKU, fabric, size and payment selections, then Create the Sales Order.
              Fields you change from the scan are highlighted in blue.
            </div>
          </div>
        </div>
      )}

      {/* ── CUSTOMER ──────────────────────────────────────────────────
          Matches SalesOrderDetail's Customer card: Name * / Phone * /
          Email * / Customer Type / Salesperson / Customer SO Ref.
          Same .formGrid4 column layout (1 wide + 1 + 1 + 1 + 1 + 1) so
          fields line up visually between the two pages. */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Customer</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4} ref={custGridRef}>
            <label className={styles.field} style={{ gridColumn: 'span 3' }}>
              <span className={`${styles.fieldLabel} ${styles.fieldLabelReq}`}>Customer Name <span className={styles.req}>*</span></span>
              <input
                ref={debtorInputRef}
                className={`${styles.fieldInput} ${editedClass('debtorName', debtorName)}`}
                value={debtorName}
                onChange={(e) => { setDebtorName(e.target.value); setShowDebtorSuggest(true); }}
                onFocus={() => setShowDebtorSuggest(true)}
                onBlur={() => setTimeout(() => setShowDebtorSuggest(false), 150)}
                placeholder="e.g. Lim Mei Hua"
                required
              />
              <DebtorSuggestList
                anchorRef={debtorInputRef}
                open={showDebtorSuggest}
                suggestions={debtorSuggestions}
                onPick={applyDebtorSuggestion}
                classes={{ list: styles.suggestList, item: styles.suggestItem, code: styles.suggestCode }}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer SO Ref</span>
              <input
                className={`${styles.fieldInput} ${editedClass('customerSoNo', customerSoNo)}`}
                value={customerSoNo}
                placeholder="Their PO / SO number"
                onChange={(e) => setCustomerSoNo(e.target.value)}
              />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={`${styles.fieldLabel} ${styles.fieldLabelReq}`}>Phone <span className={styles.req}>*</span></span>
              <PhoneInput
                className={styles.fieldInput}
                value={phone}
                onChange={setPhone}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Email</span>
              <input
                type="email"
                className={styles.fieldInput}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="customer@example.com"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Type</span>
              <span className={styles.selectWrap}>
                <select
                  className={`${styles.fieldSelect} ${editedClass('customerType', customerType)}`}
                  value={customerType}
                  onChange={(e) => setCustomerType(e.target.value)}
                >
                  <option value="">—</option>
                  {customerTypeOpts.map((t) => (
                    <option key={t.id} value={t.value}>{t.label}</option>
                  ))}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Salesperson</span>
              {/* Commander 2026-05-27: "salesperson 还是可以换 只是default
                  跳出来". Defaults to the current user; only admin /
                  sales_director can re-pick. Non-admin roles see a
                  disabled select pinned to themselves so the field is
                  visible-but-not-editable (UI parity with the editable
                  case). */}
              <span className={styles.selectWrap}>
                <select
                  className={styles.fieldSelect}
                  value={salespersonId}
                  onChange={(e) => setSalespersonId(e.target.value)}
                  disabled={!canChangeSalesperson}
                >
                  {/* Owner 2026-06-23 — the creator is ALWAYS a selectable
                      option so Salesperson is never blank; owner 2026-08-21 —
                      and always a REAL person. selfStaffMatch carries their
                      canonical id + staff code on every account, because
                      GET /staff/pickable appends the caller's own row whatever
                      narrowing it applied. */}
                  {/* Non-admin roles are pinned to themselves: only the creator
                      option renders. Admin / director / super-admin get the full
                      pickable list (which already contains the creator). */}
                  {!canChangeSalesperson && selfStaffMatch && (
                    <option value={selfStaffMatch.id}>
                      {selfStaffMatch.name} ({selfStaffMatch.staffCode})
                    </option>
                  )}
                  {canChangeSalesperson && sortByText(filteredStaffList).map((s) => (
                    <option key={s.id} value={s.id}>{s.name} ({s.staffCode})</option>
                  ))}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
          </div>
        </div>
      </section>

      {/* ── ORDER INFO (Building Type / Venue / Dates / Note) ────────
          Same card + same field layout as Detail's Order Info. */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Order Info</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Building Type</span>
              <span className={styles.selectWrap}>
                <select
                  className={`${styles.fieldSelect} ${editedClass('buildingType', buildingType)}`}
                  value={buildingType}
                  onChange={(e) => setBuildingType(e.target.value)}
                >
                  <option value="">—</option>
                  {buildingTypeOpts.map((b) => (
                    <option key={b.id} value={b.value}>{b.label}</option>
                  ))}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Venue</span>
              {/* Houzs 2026-06-22 (owner): Venue is manually pickable (was a
                  locked 2990 field). Defaults to the salesperson's home venue,
                  the operator can change it. */}
              <span className={styles.selectWrap}>
                <select
                  className={`${styles.fieldSelect} ${editedClass('venueId', effectiveVenueId ?? '')}`}
                  value={effectiveVenueId ?? ''}
                  onChange={(e) => setPickedVenueId(e.target.value || null)}
                  aria-label="Venue"
                >
                  <option value="">—</option>
                  {(venuesQ.data ?? []).map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
              {/* Name the SOURCE, not just the fact of an auto-fill. "Auto-filled
                  from Ipoh Fair" and "Auto-filled from your showroom" mean
                  different things, and the operator needs to know which default
                  they are being offered before deciding to override it. */}
              {autoVenue?.venueId && autoVenue.source === 'PMS' && autoVenue.projectName && (
                <span style={{ fontSize: '11px', marginTop: '4px', opacity: 0.7 }}>
                  Auto-filled from {autoVenue.projectName}
                </span>
              )}
              {autoVenue?.venueId && autoVenue.source === 'SHOWROOM' && (
                <span style={{ fontSize: '11px', marginTop: '4px', opacity: 0.7 }}>
                  Auto-filled from your showroom{autoVenue.showroomName ? ` (${autoVenue.showroomName})` : ''} — change it if you are somewhere else today
                </span>
              )}
              {/* KNOWN GAP, deliberately tolerated: projects reference ~60
                  distinct venues and the master holds ~38. The order still
                  saves with the venue text — refusing it would block real sales
                  to enforce a list nobody has finished filling in. */}
              {autoVenue && !autoVenue.venueId && autoVenue.venueName && (
                <span style={{ fontSize: '11px', marginTop: '4px', color: 'var(--c-festive-b, #B8331F)' }}>
                  Venue {autoVenue.venueName} is not in the venue list yet — it is still saved on the order; add it in Project Maintenance to show it here.
                </span>
              )}
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Processing Date</span>
              <DateField
                fullWidth
                className={`${styles.fieldInput} ${editedClass('processingDate', processingDate)}`}
                value={processingDate}
                min={today}
                onChange={(iso) => setProcessingDate(iso)}
                style={datesXor && !processingDate ? { borderColor: 'var(--c-festive-b, #B8331F)' } : undefined}
              />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Delivery Date</span>
              <DateField
                fullWidth
                className={`${styles.fieldInput} ${editedClass('deliveryDate', deliveryDate)}`}
                value={deliveryDate}
                min={today}
                onChange={(iso) => setDeliveryDate(iso)}
                style={datesXor && !deliveryDate ? { borderColor: 'var(--c-festive-b, #B8331F)' } : undefined}
              />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Note</span>
              <input
                className={`${styles.fieldInput} ${editedClass('note', note)}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Internal notes — visible on the SO detail page only"
              />
            </label>
          </div>
          {datesXor && (
            <div className="mt-2 rounded-md border border-err/40 bg-err-bg px-2 py-1 text-[11px] font-semibold text-err">
              ⚠ Processing Date and Delivery Date must be set together — Save is blocked.
            </div>
          )}
        </div>
      </section>

      {/* ── EMERGENCY CONTACT ─────────────────────────────────────────
          Mirrors Detail's Emergency Contact card field-for-field. */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Emergency Contact</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            Used only if we cannot reach the customer on delivery day
          </span>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Contact Name</span>
              <input
                className={styles.fieldInput}
                value={emergencyName}
                placeholder="e.g. Lim Mei Hua"
                onChange={(e) => setEmergencyName(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Relationship</span>
              <span className={styles.selectWrap}>
                <select
                  className={styles.fieldSelect}
                  value={emergencyRel}
                  onChange={(e) => setEmergencyRel(e.target.value)}
                >
                  <option value="">—</option>
                  {relationshipOpts.map((r) => (
                    <option key={r.id} value={r.value}>{r.label}</option>
                  ))}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Phone</span>
              <PhoneInput
                className={styles.fieldInput}
                value={emergencyPhone}
                onChange={setEmergencyPhone}
              />
            </label>
          </div>
        </div>
      </section>

      {/* ── DELIVERY ADDRESS ──────────────────────────────────────────
          Matches Detail's Delivery Address card. The one Detail-only
          field (Sales Location, read from auth) is omitted here. The
          one New-SO-only affordance ("Fill in address later") sits at
          the top of the card so commander can defer the address. */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Delivery Address</h2>
        </header>
        <div className={styles.cardBody}>
          <label
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)',
              padding: 'var(--space-3)',
              background: fillAddressLater ? 'rgba(22, 105, 95, 0.08)' : 'var(--c-cream)',
              border: '1px solid ' + (fillAddressLater ? 'var(--c-orange)' : 'var(--line)'),
              borderRadius: 'var(--radius-md)',
              marginBottom: 'var(--space-3)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={fillAddressLater}
              onChange={(e) => setFillAddressLater(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <div>
              <div style={{ fontWeight: 600, fontSize: 'var(--fs-14)' }}>Fill in address later</div>
              <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', marginTop: 2 }}>
                Customer hasn't confirmed delivery address yet — we'll capture it before dispatch.
              </div>
            </div>
          </label>

          {/* Address fields — only Address 1/2 dim when fill-later is on. */}
          <div className={styles.formGrid4}>
            <label
              className={styles.field}
              style={{
                gridColumn: 'span 4',
                opacity: fillAddressLater ? 0.4 : 1,
                pointerEvents: fillAddressLater ? 'none' : 'auto',
              }}
            >
              <span className={styles.fieldLabel}>Address Line 1</span>
              <input
                className={`${styles.fieldInput} ${editedClass('address1', address1)}`}
                value={address1}
                onChange={(e) => setAddress1(e.target.value)}
                placeholder="Unit, street, area"
              />
            </label>
            <label
              className={styles.field}
              style={{
                gridColumn: 'span 4',
                opacity: fillAddressLater ? 0.4 : 1,
                pointerEvents: fillAddressLater ? 'none' : 'auto',
              }}
            >
              <span className={styles.fieldLabel}>Address Line 2</span>
              <input
                className={styles.fieldInput}
                value={address2}
                onChange={(e) => setAddress2(e.target.value)}
                placeholder="Apt, floor, building (optional)"
              />
            </label>
            {/* Owner spec 2026-07-23 — StatePicker enforces "MY default listed,
                click Others for CN/SG, Search filters across all". Same shared
                component as Warehouse / Supplier / Venue / MobileNewSO — no
                (legacy) sneak-through, no free-text fallback. */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>State</span>
              <StatePicker
                value={state}
                selectClassName={styles.fieldSelect}
                onChange={(next) => applyTriple(pickState(next))}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>City</span>
              <span className={styles.selectWrap}>
                <SearchableSelect
                  className={styles.fieldSelect}
                  value={city}
                  onChange={onCityPick}
                  disabled={loc.isLoading}
                  placeholder={loc.isLoading ? 'Loading…' : cityPlaceholder(state)}
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
                  value={postcode}
                  onChange={onPostcodePick}
                  disabled={loc.isLoading}
                  placeholder={loc.isLoading ? 'Loading…' : postcodePlaceholder(state, city)}
                  options={sortByNumeric(postcodeChoices).map((p) => ({ value: p, label: p }))}
                />
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            {/* Task #121 — Country is auto-derived from the picked state via
                my_localities. Read-only display; the API re-derives + snaps
                it onto the SO header on POST. */}
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Country</span>
              <span className={styles.fieldInput} style={{
                display: 'inline-flex', alignItems: 'center', height: 26,
                color: 'var(--fg-muted)',
              }}>
                {country}
              </span>
            </div>
            {/* Commander 2026-05-27 (Fix 5) — Sales Location auto-derives
                from state_warehouse_mappings on state change. Read-only
                display (mappings live in Maintenance). Empty when the picked
                state has no warehouse wired up yet. */}
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Sales Location</span>
              <span className={styles.fieldInput} style={{
                display: 'inline-flex', alignItems: 'center', height: 26,
                color: 'var(--fg-muted)',
              }}
                title={salesLocation
                  ? `Auto-set from State → Warehouse mapping for "${state}"`
                  : 'Pick a State above to auto-set'}
              >
                {salesLocation || '—'}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ── LINE ITEMS ──────────────────────────────────────────────
          Same SoLineCard component Edit SO uses inline. Each line on
          New SO is already in inline-edit mode (no saved row exists
          yet), and "+ Add Line Item" appends a fresh card. Card header
          mirrors Detail — "Line Items ({n})" with no subtitle. */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({lines.length})</h2>
        </header>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {lines.map((line, idx) => {
            /* fromScan — the slip rawText still feeds the SKU picker's placeholder
               hint for a no-match line (searchHint below). The per-line
               "scanned · NN%" review chip was REMOVED: owner — it is scan-review
               metadata that won't exist on the created SO, so it must not clutter
               the create page. (A no-match line is still obvious: its SKU picker
               is empty + required.) */
            const meta = scanLineMeta[line.rid];
            return (
              <div key={line.rid} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <SoLineCard
                  index={idx}
                  draft={line}
                  onChange={(patch) => updateLine(line.rid, patch)}
                  onRemove={() => dropLine(line.rid)}
                  canRemove={lines.length > 1}
                  inheritVariantsByCategory={inheritVariantsByCategory}
                  onAddProducts={addProducts}
                  /* Variants are only mandatory once a Processing Date is set
                     (matches the backend gate + the Save block above), so the
                     ` *` marker + red ring stay off while the order is still a
                     no-date draft (owner 2026-07-14). */
                  variantsRequired={!!processingDate}
                  /* Scan-Order (Task #73) — a NO-MATCH scanned line seeds an
                     empty SKU picker; pass the slip rawText as the picker's
                     placeholder hint so the operator can pick a real SKU
                     (never free-text). Only while the line is still unpicked. */
                  searchHint={!line.itemCode && meta?.rawText ? meta.rawText : undefined}
                />
              </div>
            );
          })}

          <button
            type="button"
            onClick={addLine}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              width: '100%',
              padding: '12px 14px',
              background: 'transparent',
              border: '1px dashed var(--c-orange)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--c-orange)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-13)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <Plus {...ICON} /> Add Line Item
          </button>

          <div style={{
            display: 'flex',
            justifyContent: 'flex-end',
            marginTop: 'var(--space-2)',
            paddingTop: 'var(--space-3)',
            borderTop: '1px solid var(--line)',
            fontFamily: 'var(--font-mark)',
            fontSize: 'var(--fs-20)',
            fontWeight: 800,
            color: 'var(--c-burnt)',
          }}>
            Subtotal: {fmtRm(subtotalSen)}
          </div>
        </div>
      </section>

      </>)}

      {/* ── PAYMENTS (shared with Detail) ─────────────────────────────
          Task #105 — Same Houzs PaymentsTable rendered on Detail. In
          DRAFT mode it holds rows in local state; onSave (above) batches
          POST /:docNo/payments calls in parallel after the SO has been
          created and before navigating to the Detail page. */}
      <PaymentsTable
        docNo={null}
        payments={paymentDrafts}
        onChange={setPaymentDrafts}
        grandTotalSen={subtotalSen}
        currency="MYR"
        slipUpload
        collectedByAllowedIds={paymentsCollectedByAllowedIds}
        defaultCollectedBy={selfStaffMatch?.id ?? ''}
      />
      </div>
    </div>
  );
};
