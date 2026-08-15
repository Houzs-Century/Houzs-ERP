// ----------------------------------------------------------------------------
// ConsignmentOrderNew — full-page Create Consignment Order at /scm/consignment-orders/new.
//
// Faithful clone of SalesOrderNew.tsx. It reuses the SAME shared components
// UNCHANGED — SoLineCard (+ emptySoLine / missingRequiredVariants / SoLineDraft),
// PaymentsTable, PhoneInput — and the SAME generic data hooks (useStaff,
// useVenues, useLocalities, useSoDropdownOptions, useStateWarehouseMappings).
//
// Only the consignment-specific wiring differs from the SO page:
//   • create mutation → useCreateConsignmentOrder
//   • debtor search   → useConsignmentDebtorSearch
//   • copy-from / photo read-back → consignment detail + photo hooks
//   • page title / back link / post-save navigate → /scm/consignment-orders/:docNo
//
// The ENTIRE line editor / variant / colour / sofa / pricing / payments
// experience is identical to the SO create flow. The backend route
// `/consignment-orders` mirrors `/mfg-sales-orders` 1:1 (same create body,
// same detail shape, same line/payment endpoints); numbering is CS-YYMM-NNN.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, Plus, Save, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useIdempotencyKey } from '../../lib/idempotency';
import {
  useCreateConsignmentOrder, useConsignmentDebtorSearch, useAddConsignmentOrderPayment,
  useUploadConsignmentItemPhoto, useConsignmentOrderDetail,
  type DebtorSuggestion,
} from '../../vendor/scm/lib/consignment-order-queries';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { usePickableStaff } from '../../vendor/scm/lib/admin-queries';
import { useAuth } from '../../vendor/scm/lib/auth';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useVenues } from '../../vendor/scm/lib/venues-queries';
import {
  useLocalities, distinctStates, citiesInState, postcodesInCity,
  countryForState,
} from '../../vendor/scm/lib/localities-queries';
import { StatePicker } from '../../vendor/scm/components/StatePicker';
import {
  useSoDropdownOptions, optionsOrFallback,
} from '../../vendor/scm/lib/so-dropdown-options-queries';
import { useStateWarehouseMappings } from '../../vendor/scm/lib/state-warehouse-queries';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import { SearchableSelect } from '../../vendor/scm/components/SearchableSelect';
import { DebtorSuggestList } from '../../vendor/scm/components/DebtorSuggestList';
import { SoLineCard, emptySoLine, missingRequiredVariants, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import {
  PaymentsTable, labelToApi, draftMethodFields, type PaymentDraft,
} from '../../vendor/scm/components/PaymentsTable';
import { hasSofaMixConflict, SOFA_MIX_MESSAGE } from '@2990s/shared/so-variant-rule';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { fmtMoneyCenti } from '@2990s/shared';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type DraftLine = SoLineDraft & { rid: string };

const newLine = (deliveryDate: string | null = null): DraftLine => ({
  ...emptySoLine(),
  lineDeliveryDate: deliveryDate,
  lineDeliveryDateOverridden: false,
  rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
});

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneyCenti(centi, currency);

export const ConsignmentOrderNew = () => {
  const navigate = useNavigate();
  const notify = useNotify();
  /* Copy-to-new: ?copyFrom=<docNo> seeds this form from an existing consignment
     order (customer + line items only — dates, payments, customer ref, doc no
     and status are left blank so the operator starts fresh). */
  const [searchParams] = useSearchParams();
  const copyFromDocNo = searchParams.get('copyFrom');
  const copySource = useConsignmentOrderDetail(copyFromDocNo);
  /* One key for the one order this page is open to raise (lib/idempotency.ts).
     Route-level form, navigates to the order detail on success, so the MOUNT is
     exactly one order: stable across re-renders and across a re-press after a
     stalled submit, fresh on remount. */
  const idemKey    = useIdempotencyKey();
  const create     = useCreateConsignmentOrder();
  const addPayment = useAddConsignmentOrderPayment();
  const uploadPhoto = useUploadConsignmentItemPhoto();
  const staffQ   = usePickableStaff({ onlySales: true });
  const venuesQ  = useVenues();
  const loc      = useLocalities();
  const { staff: currentStaff } = useAuth();
  // Houzs-flavoured: gate on the flat permission key `scm.so.attribute_other`
  // (the 2990 bridge always reports either super_admin or sales). Owner + IT
  // Admin pass via `*`; grant to other positions via Team > Positions.
  const { can } = useHouzsAuth();
  const canChangeSalesperson = can('scm.so.attribute_other');

  const customerTypeOptsQ  = useSoDropdownOptions('customer_type');
  const buildingTypeOptsQ  = useSoDropdownOptions('building_type');
  const relationshipOptsQ  = useSoDropdownOptions('relationship');
  const customerTypeOpts = optionsOrFallback('customer_type', customerTypeOptsQ.data);
  const buildingTypeOpts = optionsOrFallback('building_type', buildingTypeOptsQ.data);
  const relationshipOpts = optionsOrFallback('relationship',  relationshipOptsQ.data);

  // ── Customer fields ────────────────────────────────────────────────
  const [debtorCode,    setDebtorCode]    = useState('');
  const [debtorName,    setDebtorName]    = useState('');
  const [phone,         setPhone]         = useState('');
  const [email,         setEmail]         = useState('');
  const [salespersonId, setSalespersonId] = useState('');
  const [customerType,  setCustomerType]  = useState<string>('');
  const [customerSoNo,  setCustomerSoNo]  = useState('');

  /* Autofill rescue — Chrome/Edge paint saved values into Customer
     Name / Phone / Email WITHOUT firing React's onChange; read them out of the
     DOM shortly after mount and push into state when still empty. */
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

  // ── Order Info fields ───────────────────────────────────────────────
  const [buildingType,   setBuildingType] = useState<string>('');
  const [processingDate, setProcessingDate] = useState('');
  const [deliveryDate,   setDeliveryDate]   = useState('');
  const [note,           setNote]           = useState('');

  // ── Delivery address ───────────────────────────────────────────────
  const [fillAddressLater, setFillAddressLater] = useState(false);
  const [address1,    setAddress1]    = useState('');
  const [address2,    setAddress2]    = useState('');
  const [state,       setState]       = useState('');
  const [city,        setCity]        = useState('');
  const [postcode,    setPostcode]    = useState('');
  const [salesLocation, setSalesLocation] = useState('');

  // ── Emergency contact ──────────────────────────────────────────────
  const [emergencyName,  setEmergencyName]   = useState('');
  const [emergencyRel,   setEmergencyRel]    = useState<string>('');
  const [emergencyPhone, setEmergencyPhone]  = useState('');

  // ── Items state ────────────────────────────────────────────────────
  const [lines, setLines] = useState<DraftLine[]>(() => [newLine()]);

  /* Copy-to-new seed — runs once when the source order finishes loading. */
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setLines(srcItems.map((it: any) => ({
        ...newLine(),
        itemCode:       it.item_code ?? '',
        itemGroup:      it.item_group ?? 'others',
        description:    it.description ?? '',
        uom:            it.uom ?? 'UNIT',
        qty:            it.qty ?? 1,
        unitPriceCenti: it.unit_price_centi ?? 0,
        discountCenti:  it.discount_centi ?? 0,
        unitCostCenti:  it.unit_cost_centi ?? 0,
        variants:       (it.variants as Record<string, unknown>) ?? {},
        remark:         it.remark ?? '',
      })));
    }
    setCopySeeded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copyFromDocNo, copySeeded, copySource.data]);

  // ── Payments draft state ───────────────────────────────────────────
  const [paymentDrafts, setPaymentDrafts] = useState<PaymentDraft[]>([]);

  // ── Debtor autocomplete ─────────────────────────────────────────────
  const debtors = useConsignmentDebtorSearch(debtorName.trim().length >= 2 ? debtorName.trim() : '');
  const [showDebtorSuggest, setShowDebtorSuggest] = useState(false);
  /* SalesOrderDetail's copy of this field was portalled in an earlier pass; this
     one and ConsignmentOrderDetail's were the twins that pass missed. */
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

  const updateLine = (rid: string, patch: Partial<SoLineDraft>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));

  const addLine  = () => setLines((prev) => [...prev, newLine(deliveryDate || null)]);
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));

  /* Client-side master-follower cascade for delivery date. */
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
     variant changes on subsequent lines unless a follower overrode a key. */
  useEffect(() => {
    const masterByCategory: Record<string, Record<string, unknown>> = {};
    const masterIdx: Record<string, number> = {};
    lines.forEach((l, idx) => {
      if (!l.itemGroup) return;
      if (masterIdx[l.itemGroup] !== undefined) return;
      masterIdx[l.itemGroup] = idx;
      if (l.variants) masterByCategory[l.itemGroup] = l.variants;
    });

    let didUpdate = false;
    const next = lines.map((l, idx) => {
      if (!l.itemGroup) return l;
      if (masterIdx[l.itemGroup] === idx) return l;
      const masterVariants = masterByCategory[l.itemGroup];
      if (!masterVariants) return l;
      const cur = (l.variants ?? {}) as Record<string, unknown>;
      const overridden = new Set(l.overriddenKeys ?? []);
      const patch: Record<string, unknown> = {};
      let hasChange = false;
      for (const k of Object.keys(masterVariants)) {
        if (overridden.has(k)) continue;
        const masterVal = masterVariants[k];
        if (masterVal === undefined || masterVal === null || masterVal === '') continue;
        if (cur[k] !== masterVal) {
          patch[k] = masterVal;
          hasChange = true;
        }
      }
      if (!hasChange) return l;
      didUpdate = true;
      return { ...l, variants: { ...cur, ...patch } };
    });
    if (didUpdate) setLines(next);
  }, [lines]);

  const subtotalCenti = useMemo(
    () => lines.reduce(
      (s, l) => s + Math.max(0, l.qty * l.unitPriceCenti - l.discountCenti),
      0,
    ),
    [lines],
  );

  const inheritVariantsByCategory = useMemo(() => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const l of lines) {
      const cat = l.itemGroup;
      if (!cat || out[cat]) continue;
      if (l.variants && Object.keys(l.variants).length > 0) {
        out[cat] = l.variants;
      }
    }
    return out;
  }, [lines]);

  // ── Locality cascades ──────────────────────────────────────────────
  const locRows = useMemo(() => loc.data ?? [], [loc.data]);
  const states  = useMemo(() => distinctStates(locRows), [locRows]);
  const cities  = useMemo(() => state ? citiesInState(locRows, state) : [], [locRows, state]);
  const postcodes = useMemo(
    () => (state && city) ? postcodesInCity(locRows, state, city) : [],
    [locRows, state, city],
  );

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

  // ── Salesperson + Venue resolution ─────────────────────────────────
  const staffList = useMemo(
    () => (staffQ.data ?? []).filter((s) => s.active),
    [staffQ.data],
  );

  useEffect(() => {
    if (!currentStaff?.id) return;
    // HOUZS VENDOR: the bridge's staff.id is `string | null`; coalesce to '' so
    // the `string`-typed salespersonId state stays string (verbatim seed).
    setSalespersonId((prev) => prev || currentStaff.id || '');
  }, [currentStaff?.id]);

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

  const datesXor = (processingDate.trim() !== '') !== (deliveryDate.trim() !== '');
  const today = new Date().toLocaleDateString('en-CA');

  const flushPendingPhotos = async (
    docNo: string,
    draftLines: DraftLine[],
  ): Promise<{ failed: number; skipped: number }> => {
    const linesWithPending = draftLines.filter(
      (l) => (l.pendingPhotoFiles?.length ?? 0) > 0,
    );
    if (linesWithPending.length === 0) return { failed: 0, skipped: 0 };

    // HOUZS VENDOR: read saved item IDs through the vendored authedFetch
    // (→ /api/scm) instead of the supabase session + raw VITE_API_URL.
    let savedItems: Array<{ id: string; item_code: string }> = [];
    try {
      const body = await authedFetch<{ items: Array<{ id: string; item_code: string }> }>(
        `/consignment-orders/${docNo}`,
      );
      savedItems = body.items ?? [];
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[consignment-line-photos] could not load saved item IDs:', e);
      return { failed: linesWithPending.length, skipped: 0 };
    }

    const validLines = draftLines.filter((l) => l.itemCode.trim() && l.qty > 0);
    let failed = 0;
    let skipped = 0;
    for (let i = 0; i < validLines.length; i++) {
      const line = validLines[i]!;
      const files = line.pendingPhotoFiles ?? [];
      if (files.length === 0) continue;
      const saved = savedItems[i];
      if (!saved || saved.item_code !== line.itemCode) {
        // eslint-disable-next-line no-console
        console.warn('[consignment-line-photos] index/item_code mismatch — skipping pending uploads', {
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
          console.error('[consignment-line-photos] upload failed', { file: f.name, err });
          failed++;
        }
      }
    }
    return { failed, skipped };
  };

  const flushPaymentDrafts = async (docNo: string): Promise<{ failed: number }> => {
    if (paymentDrafts.length === 0) return { failed: 0 };
    const tasks = paymentDrafts
      .filter((d) => d.amountCenti > 0)
      .map(async (d) => {
        const { method } = labelToApi(d.methodLabel);
        const body: { docNo: string } & Record<string, unknown> = {
          docNo,
          paidAt:       d.paidAt,
          method,
          amountCenti:  d.amountCenti,
          accountSheet: d.accountSheet || null,
          approvalCode: d.approvalCode || null,
          collectedBy:  d.collectedBy  || null,
          // Per-draft key — see lib/idempotency.ts. The order is created first
          // and the payments posted after, so a retry of the save re-posts these.
          idempotencyKey: d.idempotencyKey,
        };
        Object.assign(body, draftMethodFields(method, d));
        try {
          await addPayment.mutateAsync(body);
          return true;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[payment] post failed for new consignment order:', e);
          return false;
        }
      });
    const results = await Promise.all(tasks);
    return { failed: results.filter((ok) => !ok).length };
  };

  const onSave = () => {
    if (!debtorName.trim()) {
      notify({ title: 'Customer name is required.', tone: 'error' });
      return;
    }
    if (!phone.trim()) {
      notify({ title: 'Phone number is required', body: 'Every consignment order must have a contact number.', tone: 'error' });
      return;
    }
    if (datesXor) {
      notify({
        title: 'Processing Date and Delivery Date must be set together.',
        body:
          'Either fill in BOTH dates, or leave BOTH empty — partial dates ' +
          'cause scheduling issues.',
        tone: 'error',
      });
      return;
    }
    if (processingDate && processingDate < today) {
      notify({ title: 'Processing Date cannot be in the past', body: 'Pick today or a future date.', tone: 'error' });
      return;
    }
    if (deliveryDate && deliveryDate < today) {
      notify({ title: 'Delivery Date cannot be in the past', body: 'Pick today or a future date.', tone: 'error' });
      return;
    }
    if (processingDate && deliveryDate && processingDate > deliveryDate) {
      notify({ title: 'Processing Date cannot be later than the Delivery Date.', tone: 'error' });
      return;
    }
    const validLines = lines.filter((l) => l.itemCode.trim() && l.qty > 0);
    if (validLines.length === 0) {
      notify({ title: 'Add at least one item via "+ Add Line Item".', tone: 'error' });
      return;
    }
    // Sofa is exclusive among main products — the server 400s
    // `so_sofa_no_other_main` when a sofa line rides with a bedframe/mattress.
    // Block + warn here so the operator gets one plain sentence, not a raw 400.
    if (hasSofaMixConflict(validLines.map((l) => l.itemGroup))) {
      notify({ title: SOFA_MIX_MESSAGE, tone: 'error' });
      return;
    }
    if (processingDate) {
      const variantGaps = validLines
        .map((l) => ({ code: l.itemCode, miss: missingRequiredVariants(l.itemGroup, l.variants, l.itemCode) }))
        .filter((x) => x.miss.length > 0);
      if (variantGaps.length > 0) {
        notify({
          title: 'Complete all variant selections before saving',
          body: variantGaps.map((x) => `• ${x.code}: ${x.miss.join(', ')}`).join('\n'),
          tone: 'error',
        });
        return;
      }
    }

    create.mutate(
      {
        idempotencyKey: idemKey,
        debtorName,
        debtorCode: debtorCode || undefined,
        phone: phone || undefined,
        email: email || undefined,
        salespersonId: salespersonId || undefined,
        customerType: customerType || undefined,
        customerSoNo: customerSoNo || undefined,
        venueId: resolvedVenueId ?? undefined,
        venue: resolvedVenueName || undefined,
        address1: fillAddressLater ? undefined : (address1 || undefined),
        address2: fillAddressLater ? undefined : (address2 || undefined),
        customerState: state || undefined,
        city: city || undefined,
        postcode: postcode || undefined,
        salesLocation: salesLocation || undefined,
        buildingType: buildingType || undefined,
        emergencyContactName:         emergencyName  || undefined,
        emergencyContactRelationship: emergencyRel   || undefined,
        emergencyContactPhone:        emergencyPhone || undefined,
        processingDate:       processingDate || undefined,
        customerDeliveryDate: deliveryDate   || undefined,
        note: note || undefined,
        items: validLines.map((l) => ({
          itemGroup:      l.itemGroup,
          itemCode:       l.itemCode,
          description:    l.description,
          uom:            l.uom,
          qty:            l.qty,
          unitPriceCenti: l.unitPriceCenti,
          discountCenti:  l.discountCenti,
          unitCostCenti:  l.unitCostCenti,
          variants:       l.variants,
          remark:         l.remark,
          lineDeliveryDate:           l.lineDeliveryDate ?? null,
          lineDeliveryDateOverridden: l.lineDeliveryDateOverridden ?? false,
        })),
      },
      {
        onSuccess: async (res: { docNo: string }) => {
          const { failed } = await flushPaymentDrafts(res.docNo);
          const { failed: photoFailed, skipped: photoSkipped } =
            await flushPendingPhotos(res.docNo, validLines);
          if (failed > 0) {
            await notify({
              title: 'Some payments failed to save',
              body:
                `Consignment order ${res.docNo} was created, but ${failed} ` +
                `payment row${failed === 1 ? '' : 's'} failed to save. ` +
                `Please re-enter ${failed === 1 ? 'it' : 'them'} on the Detail page.`,
              tone: 'error',
            });
          }
          if (photoFailed > 0 || photoSkipped > 0) {
            await notify({
              title: 'Some photos could not be uploaded',
              body:
                `Consignment order ${res.docNo} was created, but ${photoFailed + photoSkipped} ` +
                `staged photo${(photoFailed + photoSkipped) === 1 ? '' : 's'} could not be ` +
                `uploaded. Please re-attach on the Detail page.`,
              tone: 'error',
            });
          }
          navigate(`/scm/consignment-orders/${res.docNo}`);
        },
        onError:   (err) => notify({ title: 'Save failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
      },
    );
  };

  return (
    <div className="space-y-4">
      {/* Top bar */}
      <PageHeader back
        eyebrow="Supply Chain"
        title="New Consignment Order"
        actions={
          <>
            <div className={styles.actions}>
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/consignment-orders')}>
                <X {...ICON} /> Cancel
              </Button>
              <Button
                variant="primary" size="md"
                onClick={onSave}
                disabled={create.isPending}
              >
                <Save {...ICON} />
                {create.isPending ? 'Saving…' : 'Create Consignment Order'}
              </Button>
            </div>
          </>
        }
      />

      {/* ── CUSTOMER ────────────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Customer</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4} ref={custGridRef}>
            <label className={styles.field} style={{ gridColumn: 'span 3' }}>
              <span className={styles.fieldLabel}>Customer Name *</span>
              <input
                ref={debtorInputRef}
                className={styles.fieldInput}
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
              <span className={styles.fieldLabel}>Customer Ref</span>
              <input
                className={styles.fieldInput}
                value={customerSoNo}
                placeholder="Their PO / order number"
                onChange={(e) => setCustomerSoNo(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Phone *</span>
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
                  className={styles.fieldSelect}
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
              <span className={styles.selectWrap}>
                <select
                  className={styles.fieldSelect}
                  value={salespersonId}
                  onChange={(e) => setSalespersonId(e.target.value)}
                  disabled={!canChangeSalesperson}
                >
                  {!canChangeSalesperson && currentStaff && (
                    <option value={currentStaff.id ?? ''}>
                      {currentStaff.name} ({currentStaff.staffCode})
                    </option>
                  )}
                  {canChangeSalesperson && <option value="">— Pick staff —</option>}
                  {canChangeSalesperson && sortByText(staffList).map((s) => (
                    <option key={s.id} value={s.id}>{s.name} ({s.staffCode})</option>
                  ))}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
          </div>
        </div>
      </section>

      {/* ── ORDER INFO ──────────────────────────────────────────────── */}
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
                  className={styles.fieldSelect}
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
              <input
                className={styles.fieldInput}
                value={resolvedVenueName || (resolvedVenueId ? 'Loading…' : '—')}
                disabled
                readOnly
                aria-label="Venue (auto-set from salesperson)"
              />
              <span style={{
                fontSize: 'var(--fs-11)',
                color: 'var(--fg-muted)',
                marginTop: 2,
              }}>
                Auto-set from the salesperson's assigned venue. Contact admin to change.
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Processing Date</span>
              <input
                type="date"
                className={styles.fieldInput}
                value={processingDate}
                min={today}
                onChange={(e) => setProcessingDate(e.target.value)}
                style={datesXor && !processingDate ? { borderColor: 'var(--c-festive-b, #B8331F)' } : undefined}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Delivery Date</span>
              <input
                type="date"
                className={styles.fieldInput}
                value={deliveryDate}
                min={today}
                onChange={(e) => setDeliveryDate(e.target.value)}
                style={datesXor && !deliveryDate ? { borderColor: 'var(--c-festive-b, #B8331F)' } : undefined}
              />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Note</span>
              <input
                className={styles.fieldInput}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Internal notes — visible on the consignment detail page only"
              />
            </label>
          </div>
          {datesXor && (
            <div
              style={{
                background: 'rgba(184, 51, 31, 0.08)',
                border: '1px solid var(--c-festive-b, #B8331F)',
                color: 'var(--c-festive-b, #B8331F)',
                padding: '4px var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--fs-11)',
                fontWeight: 600,
                marginTop: 'var(--space-2)',
              }}
            >
              ⚠ Processing Date and Delivery Date must be set together — Save is blocked.
            </div>
          )}
        </div>
      </section>

      {/* ── EMERGENCY CONTACT ─────────────────────────────────────────── */}
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

      {/* ── DELIVERY ADDRESS ──────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Delivery Address</h2>
        </header>
        <div className={styles.cardBody}>
          <label
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)',
              padding: 'var(--space-3)',
              background: fillAddressLater ? 'rgba(232, 107, 58, 0.08)' : 'var(--c-cream)',
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
                className={styles.fieldInput}
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
            {/* Owner spec 2026-07-23 — StatePicker (MY-default, click Others for CN/SG, Search). Same shared component as Warehouse / Supplier / Venue / MobileNewSO / SalesOrderNew / SalesOrderDetail. No `(legacy)` sneak-through, no free-text fallback. */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>State</span>
              <StatePicker
                value={state}
                onChange={(next) => { setState(next); setCity(''); setPostcode(''); }}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>City</span>
              <span className={styles.selectWrap}>
                <SearchableSelect
                  className={styles.fieldSelect}
                  value={city}
                  onChange={(v) => { setCity(v); setPostcode(''); }}
                  disabled={!state}
                  placeholder={state ? 'Pick city' : '— pick state first'}
                  options={sortByText(cities).map((c) => ({ value: c, label: c }))}
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
                  onChange={setPostcode}
                  disabled={!state || !city}
                  placeholder={(state && city) ? 'Pick postcode' : '— pick city first'}
                  options={sortByNumeric(postcodes).map((p) => ({ value: p, label: p }))}
                />
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
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

      {/* ── LINE ITEMS ────────────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({lines.length})</h2>
        </header>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {lines.map((line, idx) => (
            <SoLineCard
              key={line.rid}
              index={idx}
              draft={line}
              onChange={(patch) => updateLine(line.rid, patch)}
              onRemove={() => dropLine(line.rid)}
              canRemove={lines.length > 1}
              inheritVariantsByCategory={inheritVariantsByCategory}
              /* Mandatory ONLY once a Processing Date is set — which is exactly
                 what THIS document's own server does: consignment-orders.ts:687
                 runs findIncompleteVariantLines only `procDate ? ... : []`.
                 Omitting this prop took SoLineCard's `= true` default, so the
                 form demanded fabric/seat/leg on a dateless draft that the
                 server would have accepted. Same conditional rule as
                 SalesOrderNew; the CO is an ORDER, not a downstream document. */
              variantsRequired={!!processingDate}
            />
          ))}

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
            Subtotal: {fmtRm(subtotalCenti)}
          </div>
        </div>
      </section>

      {/* PAYMENTS removed (Wei Siang 2026-06-06): a consignment is goods placed
          on loan at the showroom, not a sale — no money is collected, so there
          is no payments ledger. */}

    </div>
  );
};
