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
import { cascadeLineDeliveryDate } from '../../vendor/scm/lib/line-delivery-date-cascade';
import { postScanLearningSample, reportScanLearningSkipped } from '../../vendor/scm/lib/scan-learning';
import {
  cascadeMasterVariants,
  seedFollowerVariants,
  seedableMasterVariants,
  CASCADE_CATEGORIES,
  FABRIC_IDENTITY_KEYS,
  type MasterVariantSnapshot,
} from '../../vendor/scm/lib/so-variant-cascade';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery as useTanstackQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Camera, ChevronDown, Save, X } from 'lucide-react';
import { AddLineButton } from '../../vendor/scm/components/AddLineButton';
import { useAddLineHotkey } from '../../vendor/scm/lib/useAddLineHotkey';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { api } from '../../api/client';
import type { Department, TeamMember } from '../../types';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { useNotify } from '../../vendor/scm/components/NotifyDialog'; import { copySeedLines, soCopyHeaderSeed } from '../../lib/soCopyLines';
import { useConfirm, usePrompt } from '../../vendor/scm/components/ConfirmDialog';
import { passesSoffioReminder } from '../../vendor/scm/lib/soffio-reminder';
import { askNewSoBackdateReason, draftRequestBody, isBackdateRequestRow, sendNewSoBackdateRequests } from '../../vendor/scm/lib/new-so-backdate';
import {
  useCreateMfgSalesOrder, useDebtorSearch, useAddSalesOrderPayment,
  useUploadSoItemPhoto, useMfgSalesOrderDetail,
  type DebtorSuggestion,
} from '../../vendor/scm/lib/sales-order-queries';
import { zeroPriceClaim } from '../../vendor/scm/lib/zeroPriceClaim';
import { authedFetch, humanApiError, type SaveProblem } from '../../vendor/scm/lib/authed-fetch';
import {
  photoLabel,
  photoUploadFailure,
  photoUploadFailureMessage,
  unmatchedLinePhotos,
  type PhotoUploadFailure,
} from '../../vendor/scm/lib/photo-upload-failures';
import { notifySaveProblems, SaveProblemsList, saveProblemsTitle } from '../../vendor/scm/components/SaveProblemsList';
import { SaveBlockedIndicator } from '../../vendor/scm/components/SaveBlockedIndicator';
import { useSoValidate } from '../../vendor/scm/lib/use-so-validate';
import { notifyAcNotSent } from '../../vendor/scm/lib/ac-not-sent';
import { useIdempotencyKey } from '../../lib/idempotency';
import { settleMutation, useSubmitLock } from '../../lib/submitLock';
import { DebtorSuggestList } from '../../vendor/scm/components/DebtorSuggestList';
import { readScmHandoff, removeScmHandoff } from '../../lib/scmHandoffStorage';
import { completePaymentRetryDraft, paymentRetryNavigationState, writePaymentRetryHandoff } from '../../lib/paymentRetryHandoff';
import { usePickableStaff } from '../../vendor/scm/lib/admin-queries';
import { resolveSelfStaff } from '../../vendor/scm/lib/self-staff';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { SoAddressLines } from '../../components/SoAddressLines';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
import { deriveProcessingDate } from '../../lib/processingDate';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { SearchableSelect } from '../../vendor/scm/components/SearchableSelect';
import { AddressPostcodeField } from '../../vendor/scm/components/AddressPostcodeField';
import { useAuth } from '../../vendor/scm/lib/auth';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useVenues, type AutoVenue } from '../../vendor/scm/lib/venues-queries';
import { FairDayPicker, FairPicker, useAutoFair, type FairPickValue } from '../../components/FairPicker';
import { FairFallback } from '../../components/FairFallback';
import { fairDayCheck, fairEditPatch, fairEventOf } from '../../components/fairPick';
import {
  useLocalities, countryForState,
} from '../../vendor/scm/lib/localities-queries';
import {
  useAddressCascade, pickState, pickCity, pickPostcode,
  cityPlaceholder, postcodePlaceholder,
} from '../../vendor/scm/lib/address-cascade';
import { StatePicker } from '../../vendor/scm/components/StatePicker'; import { TransportFeeField } from '../../vendor/scm/components/TransportFeeField';
import {
  useSoDropdownOptions, optionsOrFallback, preferredCustomerTypeValue,
} from '../../vendor/scm/lib/so-dropdown-options-queries';
import { useStateWarehouseMappings } from '../../vendor/scm/lib/state-warehouse-queries';
import { SoLineCard, emptySoLine, missingRequiredVariants, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import { hasSofaMixConflict, SOFA_MIX_MESSAGE } from '@2990s/shared/so-variant-rule';
import { pickDefaultVariants } from '../../vendor/shared/model-default-variants';
import { useFabricColoursActive } from '../../vendor/scm/lib/fabric-queries';
import { useFabricLibrary } from '../../vendor/scm/lib/queries';
import { useSpecialAddons, type MfgProductRow } from '../../vendor/scm/lib/mfg-products-queries';
import { type ScanPrefill, type ExtractedSlip } from '../../vendor/scm/components/ScanOrderModal';
import {
  PaymentsTable, labelToApi, draftMethodFields, newPaymentDraft, convertDraftsFrom,
  missingMethodSubField, parseInstallmentMonths, slipDateProblem, type PaymentDraft,
} from '../../vendor/scm/components/PaymentsTable';
import { useOrdersWithMoney } from '../../vendor/scm/lib/so-money-queries';
import { SLIP_REQUIRED_REASON, slipMissingProblem } from '../../vendor/scm/lib/payment-slip-gate';
import { useBranding } from '../../hooks/useBranding';
import styles from './SalesOrderNew.module.css';
import { consoleAttachOptions, fmtMoneySen } from '@2990s/shared';
import { DateField } from "../../vendor/scm/components/DateField";
import { isSofaGroup, pieceShareSen, SOFA_PIECES_SPLIT_NOTICE, splitSofaPieceLines } from '../../vendor/scm/lib/sofa-piece-lines';
import { FormTouchScope } from '../../components/FormTouchScope';
import { useFormTouched, useLeaveGuard } from '../../hooks/useLeaveGuard';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type DraftLine = SoLineDraft & { rid: string };

const newLine = (deliveryDate: string | null = null): DraftLine => ({
  ...emptySoLine(),
  lineDeliveryDate: deliveryDate,
  lineDeliveryDateOverridden: false,
  rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
});

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneySen(centi, currency);

export const SalesOrderNew = () => {
  const navigate = useNavigate();
  const { touched: formTouched, markTouched } = useFormTouched();
  const { allowLeave } = useLeaveGuard(formTouched, null);
  const notify = useNotify(); const prompt = usePrompt(); const askConfirm = useConfirm();
  const [searchParams] = useSearchParams();
  const copyFromDocNo = searchParams.get('copyFrom');
  const copySource = useMfgSalesOrderDetail(copyFromDocNo);
  const create   = useCreateMfgSalesOrder();
  const idemKey  = useIdempotencyKey();
  const saveLock = useSubmitLock();
  const addPayment = useAddSalesOrderPayment();
  const uploadPhoto = useUploadSoItemPhoto();
  // onlySales=true — owner 2026-07-22: the salesperson dropdown was showing
  // every ACTIVE staff granted to the active company (Bernard, HOUZS CENTURY,
  // Kris, Test Admin, …). Narrow to Sales-position / Sales-department only.
  const staffQ   = usePickableStaff({ onlySales: true });
  const venuesQ  = useVenues();
  const loc      = useLocalities();
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
  const { user: currentUser, can } = useHouzsAuth();
  const canChangeSalesperson = can('scm.so.attribute_other');

  const customerTypeOptsQ  = useSoDropdownOptions('customer_type');
  const buildingTypeOptsQ  = useSoDropdownOptions('building_type');
  const relationshipOptsQ  = useSoDropdownOptions('relationship');
  const customerTypeOpts = optionsOrFallback('customer_type', customerTypeOptsQ.data);
  const buildingTypeOpts = optionsOrFallback('building_type', buildingTypeOptsQ.data);
  const relationshipOpts = optionsOrFallback('relationship',  relationshipOptsQ.data);

  const [debtorCode,    setDebtorCode]    = useState('');
  const [debtorName,    setDebtorName]    = useState('');
  const [phone,         setPhone]         = useState('');
  const [email,         setEmail]         = useState('');
  const [salespersonId, setSalespersonId] = useState('');
  const [customerType,  setCustomerType]  = useState<string>('');
  const [customerSoNo,  setCustomerSoNo]  = useState('');

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

  const [fillAddressLater, setFillAddressLater] = useState(false);
  const [address1,    setAddress1]    = useState('');
  const [address2,    setAddress2]    = useState('');
  const [address3,    setAddress3]    = useState('');
  const [address4,    setAddress4]    = useState('');
  const [state,       setState]       = useState('');
  const [city,        setCity]        = useState('');
  const [postcode,    setPostcode]    = useState('');
  const [salesLocation, setSalesLocation] = useState('');
  /* Active company — decides whether the stock-location gate applies at all
     (owner 2026-08-13: company 1 only). Already cached app-wide by the chrome,
     so this costs no extra request. */
  const branding = useBranding();

  const [emergencyName,  setEmergencyName]   = useState('');
  const [emergencyRel,   setEmergencyRel]    = useState<string>('');
  const [emergencyPhone, setEmergencyPhone]  = useState('');

  const [lines, setLines] = useState<DraftLine[]>(() => [newLine()]);

  const [scanSampleId,    setScanSampleId]    = useState<string | null>(null);
  const [scanSalesperson, setScanSalesperson] = useState<string | null>(null);
  const [scanAiOriginal,  setScanAiOriginal]  = useState<ExtractedSlip | null>(null);
  type ScanBaseline = {
    debtorName?: string; address1?: string; note?: string;
    deliveryDate?: string; processingDate?: string;
    customerType?: string; buildingType?: string; venueId?: string;
    customerSoNo?: string; state?: string;
  };
  const [scanBaseline, setScanBaseline] = useState<ScanBaseline | null>(null);
  type ScanLineMeta = { rawText: string; suggestedCode: string; confidence: number; seededCode: string };
  const [scanLineMeta, setScanLineMeta] = useState<Record<string, ScanLineMeta>>({});
  const [scanCity, setScanCity] = useState('');
  const [scanPostcode, setScanPostcode] = useState('');

  const [copySeeded, setCopySeeded] = useState(false);
  useEffect(() => {
    if (!copyFromDocNo || copySeeded) return;
    const h = copySource.data?.salesOrder;
    const srcItems = copySource.data?.items;
    if (!h) return;
    const seed = soCopyHeaderSeed(h);
    setDebtorCode(seed.debtorCode); setDebtorName(seed.debtorName); setPhone(seed.phone); setEmail(seed.email);
    setSalespersonId(seed.salespersonId); setCustomerType(seed.customerType); setBuildingType(seed.buildingType); setNote(seed.note);
    setAddress1(seed.address1); setAddress2(seed.address2); setAddress3(seed.address3); setAddress4(seed.address4);
    setState(seed.state); setCity(seed.city); setPostcode(seed.postcode);
    setEmergencyName(seed.emergencyName); setEmergencyRel(seed.emergencyRel); setEmergencyPhone(seed.emergencyPhone);
    const copyKept = copySeedLines(srcItems, h.status, (n) => void notify(n));
    if (copyKept.length > 0) {
      setLines(copyKept.map((it: any) => ({
        ...newLine(),
        itemCode:       it.item_code ?? '',
        itemGroup:      it.item_group ?? 'others',
        description:    it.description ?? '',
        uom:            it.uom ?? 'UNIT',
        qty:            it.qty ?? 1,
        unitPriceSen: it.unit_price_sen ?? 0,
        priceAuthored: true,
        discountSen:  it.discount_sen ?? 0,
        unitCostSen:  it.unit_cost_sen ?? 0,
        variants:       (it.variants as Record<string, unknown>) ?? {},
        remark:         it.remark ?? '',
      })));
    }
    /* Money moved from cancelled orders (docs/bugs/0931): ?convert=SO-a:sen,… seeds one converted row each. */
    if (searchParams.get('convert')) setPaymentDrafts(convertDraftsFrom(searchParams.get('convert')));
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

  const fromScan = searchParams.get('fromScan') === '1';
  const [scanSeeded, setScanSeeded] = useState(false);
  const [scanSlipImageKey, setScanSlipImageKey] = useState('');
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
    if (payload.phones && payload.phones[1]) setEmergencyPhone(payload.phones[1]);
    if (payload.address1) setAddress1(payload.address1);
    if (payload.customerSoRef) setCustomerSoNo(payload.customerSoRef);
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
    if (payload.customerType) setCustomerType(payload.customerType);
    if (payload.buildingType) setBuildingType(payload.buildingType);
    if (payload.venueId) setPickedVenueId(payload.venueId);
    if (payload.payment?.methodValue) {
      const p = payload.payment;
      setPaymentDrafts([{
        ...newPaymentDraft(),
        methodLabel:            p.methodValue,
        merchantProvider:       p.bankValue || '',
        installmentMonthsLabel: p.installmentLabel || '',
        onlineType:             p.onlineTypeValue || '',
        approvalCode:           p.approvalCode || '',
        amountSen:            p.depositSen > 0 ? p.depositSen : 0,
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
    setScanSampleId(payload.sampleId ?? null);
    setScanSalesperson(payload.salesperson ?? null);
    setScanAiOriginal(payload.aiOriginal ?? null);
    setScanLineMeta(lineMeta);
    setScanBaseline({
      debtorName:     payload.customerName || '',
      address1:       payload.address1 || '',
      note:           payload.note || '',
      deliveryDate:   payload.deliveryDate ?? '',
      processingDate: payload.deliveryDate ? deriveProcessingDate(payload.deliveryDate) : '',
      customerType:   payload.customerType || '',
      buildingType:   payload.buildingType || '',
      venueId:        payload.venueId || '',
      customerSoNo:   payload.customerSoRef || '',
      state:          payload.addressState || '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromScan, scanSeeded]);

  const editedClass = (key: keyof ScanBaseline, current: string): string => {
    if (!scanBaseline) return '';
    const base = scanBaseline[key];
    if (base === undefined) return '';
    return current !== base ? styles.edited : '';
  };

  const [paymentDrafts, setPaymentDrafts] = useState<PaymentDraft[]>([]);
  /* This customer's orders with money to give — what a "Convert from another SO" row may draw on (docs/bugs/0931; live orders too since 2026-09-16). */
  const cancelledForCustomer = useOrdersWithMoney(phone.trim() || null, phone.trim().length >= 6);
  const [createdDocNo, setCreatedDocNo] = useState<string | null>(null);

  const debouncedDebtorName = useDebouncedValue(debtorName, 200);
  const debtors = useDebtorSearch(debouncedDebtorName.trim().length >= 2 ? debouncedDebtorName.trim() : '');
  const [showDebtorSuggest, setShowDebtorSuggest] = useState(false);
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

  const FABRIC_SYNC_KEYS = FABRIC_IDENTITY_KEYS;

  const updateLine = (rid: string, patch: Partial<SoLineDraft>) =>
    setLines((prev) => {
      const target = prev.find((l) => l.rid === rid);
      const bk =
        target && 'remark' in patch
          ? (target.variants as { buildKey?: unknown } | null)?.buildKey
          : undefined;
      const cascadeRemark = typeof bk === 'string' && bk !== '';

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

  const addLine  = () => setLines((prev) => [...prev, newLine(deliveryDate || null)]);
  useAddLineHotkey(addLine);
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));

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
          variants: { ...pickDefaultVariants(p.category, p.model_default_variants, p.allowed_options), ...seedFollowerVariants(inheritVariantsByCategory[category]) },
          overriddenKeys: [],
        };
      });
      return [...prev, ...seed];
    });
  };

  useEffect(() => {
    setLines((prev) => cascadeLineDeliveryDate(prev, deliveryDate) ?? prev);
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
      lines.map((l) => ({ category: l.itemGroup ?? '', variants: (l.variants ?? {}) as Record<string, unknown>, itemCode: l.itemCode })),
      masterSnapshotRef.current,
      /* The ONE set, shared with mobile (owner 2026-09-09: cascade is for sofa
         only). This used to be `null` — EVERY category, a mattress line's
         specials included — while mobile scoped it to sofa + bedframe. */
      CASCADE_CATEGORIES,
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

  const inheritVariantsByCategory = useMemo(
    () => seedableMasterVariants(
      lines.map((l) => ({ category: l.itemGroup ?? '', variants: (l.variants ?? {}) as Record<string, unknown> })),
      CASCADE_CATEGORIES,
    ),
    [lines],
  );

  const locRows = useMemo(() => loc.data ?? [], [loc.data]);
  const { cities: cityChoices, postcodes: postcodeChoices } =
    useAddressCascade(locRows, state, city);
  const applyTriple = (next: { state: string; city: string; postcode: string }) => {
    setState(next.state);
    setCity(next.city);
    setPostcode(next.postcode);
  };
  const onCityPick = (nextCity: string) =>
    applyTriple(pickCity(locRows, { state, city, postcode }, nextCity));
  const onPostcodePick = (nextPostcode: string) =>
    applyTriple(pickPostcode(locRows, { state, city, postcode }, nextPostcode));

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
  const country = useMemo(
    () => (state ? countryForState(locRows, state) : null) ?? 'Malaysia',
    [locRows, state],
  );

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
  const salespersonAllowedDeptIds = useMemo(() => {
    const rows = departmentsQ.data?.departments ?? [];
    const ids = new Set<number>();
    for (const d of rows) {
      const n = (d.name ?? '').trim().toLowerCase();
      if (n.includes('sales') || n.includes('management')) ids.add(d.id);
    }
    return ids;
  }, [departmentsQ.data]);
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

  useEffect(() => {
    if (selfStaffMatch) setSalespersonId((prev) => prev || selfStaffMatch.id);
  }, [selfStaffMatch]);

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
  /* FAIR PICKER (owner 2026-09-13) — the operator now picks an EVENT (place +
     organizer), not a bare place, so the order can record WHICH FAIR it was
     written at and not merely where. The venue NAME is what the row carries, so
     it leads here and the master id follows it by name for back-compat with the
     `venue_id` column and the reports that read it. */
  const [fairPick, setFairPick] = useState<FairPickValue>({
    venue: null, organizer: null, startDate: null, endDate: null, day: null,
  });
  /* Fair is compulsory on submit (owner 2026-09-26): the operator must pick a
     fair OR tick No-fair (showroom). Picking a fair clears the No-fair mark. */
  const [noFair, setNoFair] = useState(false);
  const [fairDate, setFairDate] = useState<string | null>(null);
  const onFairChange = useCallback((next: FairPickValue) => {
    setFairPick(next);
    if (next.organizer) setNoFair(false);
  }, []);
  const autoFair = useAutoFair(!noFair, fairPick, onFairChange); // the keyer's fair (owner 2026-10-19)
  const effectiveVenueName: string = useMemo(() => {
    if (fairPick.venue) return fairPick.venue;
    const id = pickedVenueId ?? resolvedVenueId;
    if (!id) return '';
    return (venuesQ.data ?? []).find((r) => r.id === id)?.name ?? '';
  }, [fairPick.venue, pickedVenueId, resolvedVenueId, venuesQ.data]);
  const effectiveVenueId = useMemo(() => {
    if (!fairPick.venue) return pickedVenueId ?? resolvedVenueId;
    const byName = (venuesQ.data ?? []).find(
      (r) => r.name.trim().toLowerCase() === fairPick.venue!.trim().toLowerCase(),
    );
    return byName?.id ?? null;
  }, [fairPick.venue, pickedVenueId, resolvedVenueId, venuesQ.data]);

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
    if (autoVenue?.venueName && fairPick.venue == null) {
      setFairPick({ venue: autoVenue.venueName, organizer: null, startDate: null, endDate: null, day: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoVenue]);


  const datesXor = (processingDate.trim() !== '') !== (deliveryDate.trim() !== '');
  const today = todayMyt();

  /* RETURNS THE REASONS, not a count. It used to answer `{ failed, skipped }`
     and the caller rebuilt a sentence out of the sum — the same defect #3303
     fixed for line writes, on the photo path. Wording and the retry/refusal
     decision live in vendor/scm/lib/photo-upload-failures.ts, shared with the
     phone editor so the two surfaces cannot drift apart. */
  const flushPendingPhotos = async (
    docNo: string,
    draftLines: DraftLine[],
  ): Promise<PhotoUploadFailure[]> => {
    const linesWithPending = draftLines.filter(
      (l) => (l.pendingPhotoFiles?.length ?? 0) > 0,
    );
    if (linesWithPending.length === 0) return [];

    let savedItems: Array<{ id: string; item_code: string }> = [];
    try {
      const body = await authedFetch<{ items: Array<{ id: string; item_code: string }> }>(
        `/mfg-sales-orders/${docNo}`,
      );
      savedItems = body.items ?? [];
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[so-line-photos] could not load saved item IDs:', e);
      return linesWithPending.flatMap((l) => (l.pendingPhotoFiles ?? []).map(
        (f) => photoUploadFailure(photoLabel(l.itemCode, f.name), e)));
    }

    const validLines = draftLines.filter((l) => l.itemCode.trim() && l.qty > 0);
    const failures: PhotoUploadFailure[] = [];
    for (let i = 0; i < validLines.length; i++) {
      const line = validLines[i]!;
      const files = line.pendingPhotoFiles ?? [];
      if (files.length === 0) continue;
      const saved = savedItems[i];
      if (!saved || saved.item_code !== line.itemCode) {
        // eslint-disable-next-line no-console
        console.warn('[so-line-photos] index/item_code mismatch — skipping pending uploads', {
          index: i, expected: line.itemCode, got: saved?.item_code,
        });
        failures.push(...unmatchedLinePhotos(line.itemCode, files));
        continue;
      }
      for (const f of files) {
        try {
          await uploadPhoto.mutateAsync({ docNo, itemId: saved.id, file: f });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[so-line-photos] upload failed', { file: f.name, err });
          failures.push(photoUploadFailure(photoLabel(line.itemCode, f.name), err));
        }
      }
    }
    return failures;
  };

  const backdateRows = () => paymentDrafts.filter((d) => d.amountSen > 0 && isBackdateRequestRow({ ...d, receiptBacked: Boolean(d.receiptImageKey) }, can('scm.payment.backdate')));
  const paymentIntents = () => paymentDrafts.filter((d) => d.amountSen > 0 && !d.receiptImageKey && !backdateRows().includes(d));

  const flushPaymentDrafts = async (docNo: string, drafts: PaymentDraft[]): Promise<{ failedDrafts: PaymentDraft[] }> => {
    const tasks = drafts
      .map((d) => async () => {
        const { method } = labelToApi(d.methodLabel);
        const body: { docNo: string } & Record<string, unknown> = {
          docNo,
          idempotencyKey:  d.idempotencyKey,
          paidAt:          d.paidAt,
          method,
          amountSen:     d.amountSen,
          accountSheet:    d.accountSheet || null,
          approvalCode:    d.approvalCode || null,
          collectedBy:     d.collectedBy  || null,
          /* The slip is required (owner 2026-10-13) but gated BEFORE the save (slipMissingExtras);
             a row is posted on its AMOUNT alone — never filter on the slip, or the payment silently never books. */
          uploadSessionId: d.slipUploadSessionId,
        };
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

  const maybeLearnFromScan = (validLines: DraftLine[]) => {
    if (!fromScan) return;
    if (!scanSampleId) { reportScanLearningSkipped('no-sample-id', 'desktop'); return; }
    if (!scanAiOriginal) { reportScanLearningSkipped('no-ai-original', 'desktop'); return; }
    const ai = scanAiOriginal;

    const optMatch = (v: string) =>
      v ? { value: v, confidence: 1, reason: 'operator-confirmed' } : null;
    const phones = phone.trim() ? [phone.trim()] : ai.phones;
    const norm = (s: string | null | undefined) => (s ?? '').trim();

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
    if (validLines.length !== ai.lines.length) changed = true;
    for (const l of validLines) {
      const meta = scanLineMeta[l.rid];
      if (!meta) { changed = true; continue; }
      if (l.itemCode !== meta.seededCode) changed = true;
    }

    const corrected: ExtractedSlip = {
      customerName: debtorName.trim() || null,
      address: address1.trim() || null,
      addressLine1: address1.trim() || null,
      city: city.trim() || null,
      postcode: postcode.trim() || null,
      addressStateMatch: optMatch(state),
      phones,
      location: ai.location,
      deliveryDate: deliveryDate || ai.deliveryDate,
      slipDate: processingDate || ai.slipDate,
      salesRep: scanSalesperson || ai.salesRep,
      customerSoRef: customerSoNo.trim() || ai.customerSoRef,
      paymentMethod: ai.paymentMethod,
      depositRm: ai.depositRm,
      totalRm: ai.totalRm,
      remarks: ai.remarks,
      approvalCode: ai.approvalCode,
      paymentMethodMatch:   optMatch(paymentDrafts[0]?.methodLabel ?? '') ?? ai.paymentMethodMatch,
      bankMatch:            optMatch(paymentDrafts[0]?.merchantProvider ?? '') ?? ai.bankMatch,
      onlineTypeMatch:      optMatch(paymentDrafts[0]?.onlineType ?? '') ?? ai.onlineTypeMatch,
      installmentPlanMatch: optMatch(paymentDrafts[0]?.installmentMonthsLabel ?? '') ?? ai.installmentPlanMatch,
      customerTypeMatch:    optMatch(customerType),
      buildingTypeMatch:    optMatch(buildingType),
      locationMatch:        ai.locationMatch,
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

  /* Backend is the sole authority for the submit-blocked problem list (owner
     2026-09-16: 「跟 backend 串通, frontend 只是显示问题」). buildValidateDraft turns
     the current form state into the payload the POST /mfg-sales-orders/validate
     dry-run reads; the frontend holds NO validation rules — every problem + its
     wording is the server's collectSoSubmitProblems. */
  const buildValidateDraft = useCallback((asDraftFlag: boolean) => ({
    debtorName,
    phone,
    items: lines.map((l) => ({ itemCode: l.itemCode, itemGroup: l.itemGroup, variants: l.variants, qty: l.qty, description: l.description, unitPriceSen: l.unitPriceSen, discountSen: l.discountSen })),
    asDraft: asDraftFlag,
    hasVenue: !!effectiveVenueId,
    ...fairDayCheck(fairEditPatch(fairEventOf(fairPick)), {}),
    noFair, fairWhy: autoFair.why,
    hasSalesperson: !!salespersonId,
    companyCode: branding.companyCode,
    salesLocation,
    customerState: state, customerCountry: country,
    processingDate,
    customerDeliveryDate: deliveryDate,
    fillAddressLater,
    address1,
    postcode,
    payments: paymentDrafts.map((d) => ({
      methodLabel: d.methodLabel,
      merchantProvider: d.merchantProvider,
      installmentMonthsLabel: d.installmentMonthsLabel,
      onlineType: d.onlineType,
      convertedFromDocNo: d.convertedFromDocNo,
      amountSen: d.amountSen,
    })),
  }), [debtorName, phone, lines, effectiveVenueId, fairPick, noFair, autoFair.why, salespersonId, branding.companyCode, salesLocation, state, country, processingDate, deliveryDate, fillAddressLater, address1, postcode, paymentDrafts]);

  const liveValidateDraft = useMemo(() => buildValidateDraft(false), [buildValidateDraft]);
  const { problems: backendLiveProblems } = useSoValidate(liveValidateDraft, !createdDocNo);
  const scannedExtras = useMemo<SaveProblem[]>(() => {
    const unpicked = lines.filter((l) => !l.itemCode.trim() && (scanLineMeta[l.rid]?.rawText ?? '').trim() !== '');
    return unpicked.length > 0
      ? [{
          code: 'scanned_line_unpicked',
          message:
            `${unpicked.length} scanned line${unpicked.length === 1 ? '' : 's'} ` +
            `${unpicked.length === 1 ? 'has' : 'have'} no product picked — pick a real SKU from the dropdown ` +
            '(the slip text is shown as a hint) or remove the line.',
          field: 'Line items',
        }]
      : [];
  }, [lines, scanLineMeta]);
  /* A slip date the backend cannot see (validate carries no dates) blocks the SAVE,
     as mobile's does — except a too-old row, which goes to an admin as a request
     after the order is created (owner 2026-10-01, lib/new-so-backdate). */
  const slipDateExtras = useMemo<SaveProblem[]>(() => {
    const mayBackdate = can('scm.payment.backdate');
    const problems = paymentDrafts
      .filter((d) => d.amountSen > 0 && !isBackdateRequestRow({ ...d, receiptBacked: Boolean(d.receiptImageKey) }, mayBackdate))
      .map((d) => slipDateProblem(d, todayMyt(), mayBackdate))
      .filter((m): m is string => m !== null);
    return problems.length > 0
      ? [{ code: 'slip_date_out_of_window', message: problems[0]!, field: 'Payment date' }]
      : [];
  }, [paymentDrafts, can]);
  /* The proof (owner 2026-10-13, lib/payment-slip-required): every keyed row carries its slip
     before the order is saved (the rows post AFTER the create). A scanned receipt or a converted row needs none. */
  const slipMissingExtras = useMemo<SaveProblem[]>(() => {
    const missing = paymentDrafts.filter((d) => d.amountSen > 0 && slipMissingProblem(d) !== null).length;
    return missing > 0 ? [{ code: 'slip_required', message: `${missing} payment${missing === 1 ? ' has' : 's have'} no slip attached. ${SLIP_REQUIRED_REASON}`, field: 'Payment slip' }] : [];
  }, [paymentDrafts]);
  const blockingProblems = useMemo(
    () => [...backendLiveProblems, ...scannedExtras, ...slipMissingExtras, ...slipDateExtras],
    [backendLiveProblems, scannedExtras, slipDateExtras, slipMissingExtras],
  );
  const openBlockingList = () => {
    void notify({ title: saveProblemsTitle(blockingProblems.length), body: <SaveProblemsList problems={blockingProblems} />, tone: 'error' });
  };

  const runSave = async (asDraft: boolean) => {
    if (createdDocNo) {
      const intents = paymentIntents();
      if (intents.length === 0) {
        allowLeave();
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
      allowLeave();
      navigate(`/scm/sales-orders/${createdDocNo}?payments=1&retryPayments=1`, {
        state: paymentRetryNavigationState('so', createdDocNo, intents),
      });
      return;
    }
    const pieces = splitSofaPieceLines(lines, {
      shouldSplit: (l) => isSofaGroup(l.itemGroup),
      qtyOf: (l) => l.qty,
      asPiece: (l, i, n) => ({
        ...l,
        qty: 1,
        discountSen: pieceShareSen(l.discountSen, i, n),
        ...(i === 0 ? {} : { rid: newLine().rid, photoUrls: [], pendingPhotoFiles: [] }),
      }),
    });
    if (pieces) {
      setLines(pieces);
      await notify({ title: 'Sofa pieces split', body: SOFA_PIECES_SPLIT_NOTICE });
      return;
    }
    const validLines = lines.filter((l) => l.itemCode.trim() && l.qty > 0);
    /* Backend is the authority for what blocks this submit (owner 2026-09-16).
       Ask the validate dry-run for the definitive list for THIS press (draft vs
       confirmed differ), and merge the one client-only extra (a NO-MATCH scanned
       line, Task #73, whose scan metadata the backend cannot see). A failed
       validate does not block — the create call below is the authoritative
       backstop and returns the same problems[] shape. Shown in the SAME
       SaveProblemsList popup the live indicator and the server refusal use. */
    let serverProblems: SaveProblem[] = [];
    try {
      const r = await authedFetch<{ problems: SaveProblem[] }>('/mfg-sales-orders/validate', {
        method: 'POST',
        body: JSON.stringify(buildValidateDraft(asDraft)),
      });
      serverProblems = r.problems;
    } catch {
      // silent-write-ok: validate is a READ-ONLY dry-run (it writes nothing); its
      // failure must not block the operator, and the create call below is the
      // authoritative gate that surfaces any real refusal.
    }
    const problems = [...serverProblems, ...scannedExtras, ...slipMissingExtras, ...slipDateExtras];
    if (problems.length > 0) {
      void notify({ title: saveProblemsTitle(problems.length), body: <SaveProblemsList problems={problems} />, tone: 'error' });
      return;
    }
    const backdateReason = await askNewSoBackdateReason(prompt, backdateRows().length);
    if (backdateReason === null) return;
    if (!asDraft && !(await passesSoffioReminder(askConfirm, validLines.map((l) => l.itemCode)))) return;

    maybeLearnFromScan(validLines);

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

    const pendingDepositSen = paymentIntents()
      .reduce((sum, d) => sum + d.amountSen, 0);

    await settleMutation(create.mutate,
      {
        idempotencyKey: idemKey,
        ...receiptDepositBody,
        pendingDepositSen: pendingDepositSen > 0 ? pendingDepositSen : undefined,
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
        salespersonId: salespersonId || undefined,
        customerType: customerType || undefined,
        customerSoNo: customerSoNo || undefined,
        venueId: effectiveVenueId ?? undefined,
        venue: effectiveVenueName || undefined,
        noFair: noFair || undefined,
        fairOrganizer: fairPick.organizer ?? undefined,
        fairStart: fairPick.startDate ?? undefined,
        fairEnd: fairPick.endDate ?? undefined,
        /* Which DAY of that event (owner 2026-09-24) — kept only as one of its days. */
        fairDate: fairPick.day ?? undefined,
        fairProjectId: fairPick.booth ?? undefined,
        address1: fillAddressLater ? undefined : (address1 || undefined),
        address2: fillAddressLater ? undefined : (address2 || undefined),
        address3: fillAddressLater ? undefined : (address3 || undefined),
        address4: fillAddressLater ? undefined : (address4 || undefined),
        customerState: state || undefined,
        city: city || undefined,
        postcode: postcode || undefined,
        salesLocation: salesLocation || undefined,
        buildingType: buildingType || undefined,
        emergencyContactName:         emergencyName  || undefined,
        emergencyContactRelationship: emergencyRel   || undefined,
        emergencyContactPhone:        emergencyPhone || undefined,
        processingDate:   processingDate || undefined,
        customerDeliveryDate: deliveryDate   || undefined,
        note: note || undefined,
        slipImageKey: scanSlipImageKey || undefined,
        receiptImageKey: scanReceiptImageKey || undefined,
        items: validLines.map((l) => ({
          itemGroup:      l.itemGroup,
          itemCode:       l.itemCode,
          description:    l.description,
          uom:            l.uom,
          qty:            l.qty,
          unitPriceSen: l.unitPriceSen,
          ...zeroPriceClaim(l.unitPriceSen, l.priceAuthored === true),
          discountSen:  l.discountSen,
          unitCostSen:  l.unitCostSen,
          variants:       l.variants,
          remark:         l.remark,
          lineDeliveryDate:           l.lineDeliveryDate ?? null,
          lineDeliveryDateOverridden: l.lineDeliveryDateOverridden ?? false,
        })),
      },
      {
        onSuccess: async (res: { docNo: string }) => {
          await notifyAcNotSent(notify, res, 'Sales order');
          const intents = paymentIntents();
          const staged = intents.length === 0 || writePaymentRetryHandoff('so', res.docNo, intents);
          const { failedDrafts } = staged
            ? await flushPaymentDrafts(res.docNo, intents)
            : { failedDrafts: intents };
          const failed = failedDrafts.length;
          await sendNewSoBackdateRequests(res.docNo, backdateRows().map(draftRequestBody), backdateReason, notify);
          const photoFailures = await flushPendingPhotos(res.docNo, validLines);
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
          if (photoFailures.length > 0) {
            await notify({
              title: `Sales order ${res.docNo} was created, but ${photoFailures.length} ` +
                `staged photo${photoFailures.length === 1 ? '' : 's'} could not be uploaded.`,
              body: photoUploadFailureMessage(photoFailures),
              tone: 'error',
            });
          }
          if (!staged) {
            setCreatedDocNo(res.docNo);
            return;
          }
          allowLeave();
          navigate(
            `/scm/sales-orders/${res.docNo}${failed > 0 ? '?payments=1&retryPayments=1' : ''}`,
            { state: failed > 0 ? paymentRetryNavigationState('so', res.docNo, failedDrafts) : undefined },
          );
        },
        onError: (err) => { void notifySaveProblems(notify, err,
          (m) => { void notify({ title: 'Save failed', body: m, tone: 'error' }); }); },
      },
    );
  };
  const onSave = (asDraft = false) => saveLock.run(() => runSave(asDraft));

  return (
    <FormTouchScope onTouch={markTouched}>
    <div>
      <PageHeader back
        eyebrow="Sales order"
        title={createdDocNo ? `Complete Sales Order ${createdDocNo}` : 'New Sales Order'}
        description={createdDocNo
          ? 'The order already exists. Finish or remove the retained payment rows, then continue to its Detail page.'
          : 'Customer, order info, delivery address, line items and payments — saved as one order.'}
        actions={
          <>
            <Link
              to="/scm/sales-orders"
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary"
            >
              <ArrowLeft size={14} /> Sales Orders
            </Link>
            <Button variant="ghost" onClick={() => navigate('/scm/sales-orders')}>
              <X {...ICON} /> Cancel
            </Button>
            {/* Persistent "Can't save — N to fix · tap to see" (owner 2026-09-16):
                a blocked Save is never silent. Count + list are backend-authored
                (useSoValidate), so it clears itself as fields are fixed. Renders
                nothing when the order is complete. */}
            <SaveBlockedIndicator problems={blockingProblems} onOpen={openBlockingList} />
            <Button
              variant={fromScan ? 'secondary' : 'primary'}
              onClick={() => { void onSave(false); }}
              disabled={create.isPending || saveLock.locked}
            >
              <Save {...ICON} />
              {create.isPending || saveLock.locked
                ? 'Saving…'
                : createdDocNo
                  ? (paymentIntents().length > 0 ? 'Continue payment retry' : 'Open created order')
                  : 'Create Sales Order'}
            </Button>
            <Button
              variant={fromScan ? 'primary' : 'secondary'}
              onClick={() => { void onSave(true); }}
              disabled={create.isPending || saveLock.locked || !!createdDocNo}
            >
              <Save {...ICON} />
              {create.isPending || saveLock.locked ? 'Saving…' : 'Save as Draft'}
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
              <span className={styles.fieldLabel}>Ref No.</span>
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
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Fair</span>
              {/* Owner 2026-09-13: a row is a PLACE plus an ORGANIZER, no dates,
                  and nothing here is typed — "Others" is a second PICK over the
                  venue master. The brand is never asked for: the server derives
                  it from the SKUs and uses it to decide which brand booth at the
                  picked event this order belongs to. FairPicker.tsx has the
                  rules; it is the SAME component the mobile form renders. */}
              <FairPicker
                id="so-fair"
                value={fairPick}
                soDate={fairDate}
                onChange={onFairChange}
                boothFor={{ docNo: null, items: lines.filter((l) => l.itemCode).map((l) => ({ itemCode: l.itemCode, itemGroup: l.itemGroup })) }}
                wrapClassName={styles.selectWrap}
                selectClassName={`${styles.fieldSelect} ${editedClass('venueId', effectiveVenueId ?? '')}`}
              />
              {autoFair.hint}
              {autoVenue?.venueName && !autoFair.hint && (
                <span style={{ fontSize: '11px', marginTop: '4px', opacity: 0.7 }}>
                  {autoVenue.venueId
                    ? `Auto-filled from ${autoVenue.source === 'PMS' ? (autoVenue.projectName ?? 'your fair') : `your showroom${autoVenue.showroomName ? ` (${autoVenue.showroomName})` : ''}`} — change it if you are somewhere else today`
                    : `${autoVenue.venueName} is not in the venue list yet — it still saves on the order; add it in Project Maintenance to show it here.`}
                </span>
              )}
              {/* When no fair is picked: the back-keying date + the No-fair escape
                  (owner 2026-09-26). Shared with the mobile form. */}
              <FairFallback enabled value={fairPick} orderDate={fairDate} onOrderDate={setFairDate}
                maxDate={today} noFair={noFair} onNoFair={setNoFair} />
            </label>
            {/* Which DAY of the picked event (owner 2026-09-24) — shown once an
                event is picked, in the slot the row keeps free for it. */}
            {fairEventOf(fairPick) && (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Fair Day</span>
                <FairDayPicker id="so-fair-day" value={fairPick} soDate={fairDate} onChange={setFairPick}
                  wrapClassName={styles.selectWrap} selectClassName={styles.fieldSelect} />
              </label>
            )}
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

          <div className={styles.formGrid4}>
            <SoAddressLines lines={[address1, address2, address3, address4]}
              town={{ postcode, city, state }}
              onChange={(line, v) => ({ 1: setAddress1, 2: setAddress2, 3: setAddress3, 4: setAddress4 })[line](v)}
              fieldClassName={styles.field} labelClassName={styles.fieldLabel}
              inputClassName={(i) => (i === 0 ? `${styles.fieldInput} ${editedClass('address1', address1)}` : styles.fieldInput)}
              style={{ opacity: fillAddressLater ? 0.4 : 1, pointerEvents: fillAddressLater ? 'none' : 'auto' }} />
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
            <AddressPostcodeField
              country={country}
              value={postcode}
              onChange={setPostcode}
              onCascadePick={onPostcodePick}
              onResolve={(r) => { setAddress1(r.address); if (r.state && r.city) { setState(r.state); setCity(r.city); } }}
              postcodeChoices={postcodeChoices}
              placeholder={loc.isLoading ? 'Loading…' : postcodePlaceholder(state, city)}
              disabled={loc.isLoading}
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

      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({lines.length})</h2>
        </header>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {lines.map((line, idx) => {
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
                  specLockedReason={null}
                  lineDateLocked={!processingDate}
                  seedSofaLegDefault={true} attachOptions={consoleAttachOptions(lines, idx)}
                  searchHint={!line.itemCode && meta?.rawText ? meta.rawText : undefined}
                />
              </div>
            );
          })}

          <AddLineButton variant="block" onClick={addLine} />
          <TransportFeeField companyCode={branding.companyCode} state={state} country={country} lines={lines} setLines={setLines} read={(l) => ({ itemCode: l.itemCode, description: l.description, itemGroup: l.itemGroup, amountSen: l.unitPriceSen })} priced={(l, sen) => ({ ...l, unitPriceSen: sen, priceAuthored: true })} make={(sen) => ({ ...newLine(deliveryDate || null), description: 'TRANSPORTATION CHARGES', qty: 1, unitPriceSen: sen, priceAuthored: true })} classes={{ field: styles.field, label: `${styles.fieldLabel} ${styles.fieldLabelReq}`, input: styles.fieldInput }} style={{ maxWidth: 260, marginTop: 'var(--space-3)' }} />

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

      <PaymentsTable
        docNo={null}
        payments={paymentDrafts}
        onChange={setPaymentDrafts}
        grandTotalSen={subtotalSen}
        currency="MYR"
        slipUpload
        collectedByAllowedIds={paymentsCollectedByAllowedIds}
        defaultCollectedBy={selfStaffMatch?.id ?? ''}
        convertSources={cancelledForCustomer.data?.orders ?? []}
      />
      </div>
    </div>
    </FormTouchScope>
  );
};
