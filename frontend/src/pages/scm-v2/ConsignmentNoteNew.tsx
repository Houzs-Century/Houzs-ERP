// ----------------------------------------------------------------------------
// ConsignmentNoteNew — full-page Create Consignment Note at /scm/consignment-notes/new.
//
// Faithful clone of DeliveryOrderNew.tsx. It reuses the SAME shared components
// UNCHANGED — SoLineCard (+ emptySoLine / SoLineDraft), PaymentsTable,
// PhoneInput — and the SAME generic data hooks (useStaff, useDrivers,
// useLocalities, useSoDropdownOptions). The Customer / Delivery Info / Emergency
// / Delivery Address cards + SoLineCard list + PaymentsTable (draft mode) are
// identical to the DO create flow.
//
// The DO-specific "from Sales Order" wiring is intentionally DROPPED here:
//   • the ?fromSo / ?fromPicks prefill + SO detail/payments read-back
//   • the "From Sales Order" header button + SO-line pickers
//   • the short-stock "Ship anyway?" 409 handling on save
// A consignment note is always a blank Create form (free-entry lines).
//
// On Save: POST /consignment-notes (header + items), then replay the payment
// drafts through POST /:id/payments before navigating to the new note's detail.
// The backend route `/consignment-notes` mirrors `/delivery-orders-mfg` 1:1;
// numbering is CN-YYMM-NNN.
// ----------------------------------------------------------------------------

import { todayMyt } from '../../vendor/scm/lib/dates';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRightLeft, ChevronDown, Plus, Save, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useIdempotencyKey } from '../../lib/idempotency';
import { readScmHandoff, removeScmHandoff } from '../../lib/scmHandoffStorage';
import {
  useCreateConsignmentNote, useAddConsignmentNotePayment,
} from '../../vendor/scm/lib/consignment-note-queries';
import { useConsignmentOrderDetail } from '../../vendor/scm/lib/consignment-order-queries';
import { usePickableStaff } from '../../vendor/scm/lib/admin-queries';
import { useDrivers } from '../../vendor/scm/lib/drivers-queries';
import { useLocalities } from '../../vendor/scm/lib/localities-queries';
import {
  useAddressCascade, pickState, pickCity, pickPostcode,
  cityPlaceholder, postcodePlaceholder,
} from '../../vendor/scm/lib/address-cascade';
import { StatePicker } from '../../vendor/scm/components/StatePicker';
import {
  useSoDropdownOptions, optionsOrFallback,
} from '../../vendor/scm/lib/so-dropdown-options-queries';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import { SearchableSelect } from '../../vendor/scm/components/SearchableSelect';
import { SoLineCard, emptySoLine, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import {
  PaymentsTable, labelToApi, draftMethodFields, type PaymentDraft,
} from '../../vendor/scm/components/PaymentsTable';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { fmtMoneyCenti } from '@2990s/shared';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type DraftLine = SoLineDraft & { rid: string; soItemId?: string };

const newLine = (): DraftLine => ({
  ...emptySoLine(),
  rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
});

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneyCenti(centi, currency);

export const ConsignmentNoteNew = () => {
  const navigate = useNavigate();
  const notify = useNotify();
  const [searchParams] = useSearchParams();
  // Convert-from: a Consignment Order (=SO) this note ships against. Mirrors the
  // DO's ?fromSo= prefill — seed header + lines from the order, free-edit after.
  const fromConsignmentOrder = searchParams.get('fromConsignmentOrder');
  const fromPicks = searchParams.get('fromPicks') === '1';

  /* One key for the one note this page is open to raise (lib/idempotency.ts).
     Route-level form, navigates to the note detail on success, so the MOUNT is
     exactly one note: stable across re-renders and across a re-press after a
     stalled submit, fresh on remount. */
  const idemKey = useIdempotencyKey();
  const create = useCreateConsignmentNote();
  const addPayment = useAddConsignmentNotePayment();
  const staffQ = usePickableStaff({ onlySales: true });
  const driversQ = useDrivers();
  const loc = useLocalities();
  const coDetail = useConsignmentOrderDetail(fromConsignmentOrder);

  const customerTypeOptsQ = useSoDropdownOptions('customer_type');
  const buildingTypeOptsQ = useSoDropdownOptions('building_type');
  const relationshipOptsQ = useSoDropdownOptions('relationship');
  const customerTypeOpts = optionsOrFallback('customer_type', customerTypeOptsQ.data);
  const buildingTypeOpts = optionsOrFallback('building_type', buildingTypeOptsQ.data);
  const relationshipOpts = optionsOrFallback('relationship', relationshipOptsQ.data);

  // ── Customer ──
  const [debtorCode, setDebtorCode] = useState('');
  const [debtorName, setDebtorName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [salespersonId, setSalespersonId] = useState('');
  const [customerType, setCustomerType] = useState('');
  const [customerSoNo, setCustomerSoNo] = useState('');

  // ── Delivery info ──
  const [doDate, setDoDate] = useState(() => todayMyt());
  const [driverId, setDriverId] = useState('');
  const [driverName, setDriverName] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [buildingType, setBuildingType] = useState('');
  const [venue, setVenue] = useState('');
  const [venueId, setVenueId] = useState('');
  const [expectedDeliveryAt, setExpectedDeliveryAt] = useState('');
  const [customerDeliveryDate, setCustomerDeliveryDate] = useState('');
  const [note, setNote] = useState('');

  // ── Address ──
  const [address1, setAddress1] = useState('');
  const [address2, setAddress2] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [postcode, setPostcode] = useState('');
  const [salesLocation, setSalesLocation] = useState('');
  const [branding, setBranding] = useState('');

  // ── Emergency ──
  const [emergencyName, setEmergencyName] = useState('');
  const [emergencyRel, setEmergencyRel] = useState('');
  const [emergencyPhone, setEmergencyPhone] = useState('');

  // ── Items + payments ──
  const [lines, setLines] = useState<DraftLine[]>(() => [newLine()]);
  const [paymentDrafts, setPaymentDrafts] = useState<PaymentDraft[]>([]);

  // ── Convert-from prefill (seed once when the source order arrives) ──
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (!fromConsignmentOrder || prefilled) return;
    const co = coDetail.data?.salesOrder as Record<string, unknown> | undefined;
    const coItems = (coDetail.data?.items as Array<Record<string, unknown>> | undefined) ?? [];
    if (!co) return;

    const str = (v: unknown): string => (v == null ? '' : String(v));
    setDebtorCode(str(co.debtor_code));
    setDebtorName(str(co.debtor_name));
    setPhone(str(co.phone));
    setEmail(str(co.email));
    setSalespersonId(str(co.salesperson_id));
    setCustomerType(str(co.customer_type));
    setCustomerSoNo(str(co.customer_so_no));
    setBuildingType(str(co.building_type));
    setVenue(str(co.venue));
    setVenueId(str(co.venue_id));
    setExpectedDeliveryAt(str(co.customer_delivery_date));
    setCustomerDeliveryDate(str(co.customer_delivery_date));
    setNote(str(co.note));
    setAddress1(str(co.address1));
    setAddress2(str(co.address2));
    setState(str(co.customer_state ?? co.state));
    setCity(str(co.city));
    setPostcode(str(co.postcode));
    setSalesLocation(str(co.sales_location));
    setBranding(str(co.branding));
    setEmergencyName(str(co.emergency_contact_name));
    setEmergencyRel(str(co.emergency_contact_relationship));
    setEmergencyPhone(str(co.emergency_contact_phone));

    // When we arrived from the multi-line picker (fromPicks) the operator already
    // chose specific order lines + quantities — the picker-merge effect below
    // drives the lines. Here we only seed the HEADER from the first order.
    if (!fromPicks && coItems.length > 0) {
      setLines(coItems.map((it, idx) => ({
        ...newLine(),
        rid: `l${Date.now()}-${idx}-${str(it.id).slice(0, 6)}`,
        itemGroup: str(it.item_group) || 'others',
        itemCode: str(it.item_code),
        description: str(it.description),
        uom: str(it.uom) || 'UNIT',
        qty: Number(it.qty ?? 1),
        unitPriceCenti: Number(it.unit_price_centi ?? 0),
        discountCenti: Number(it.discount_centi ?? 0),
        unitCostCenti: Number(it.unit_cost_centi ?? 0),
        variants: (it.variants as Record<string, unknown>) ?? {},
      })));
    }

    setPrefilled(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed-once from the nav prefill; the loaded-flag guard makes any re-run a no-op
  }, [fromConsignmentOrder, prefilled, coDetail.data]);

  // From-Order multi-picker merge (fromPicks): seed lines from the stash, each
  // carrying its source CO-line id so the note links back (delivery tracking).
  const [picksLoaded, setPicksLoaded] = useState(false);
  useEffect(() => {
    if (!fromPicks || picksLoaded) return;
    type Stash = {
      orderItemId: string; orderDocNo: string;
      debtorCode: string | null; debtorName: string | null;
      itemCode: string; itemGroup: string | null; description: string | null;
      uom: string | null; qty: number;
      unitPriceCenti: number; discountCenti: number; unitCostCenti: number; variants: unknown;
    };
    const stash = readScmHandoff<Stash[]>('cnFromOrderPicks');
    if (!stash || stash.length === 0) return;
    setLines(stash.map((s, idx) => ({
      ...newLine(),
      rid: `l${Date.now()}-${idx}-${s.orderItemId.slice(0, 6)}`,
      itemGroup: (s.itemGroup as string) || 'others',
      itemCode: s.itemCode ?? '',
      description: s.description ?? '',
      uom: s.uom ?? 'UNIT',
      qty: Number(s.qty ?? 1),
      unitPriceCenti: Number(s.unitPriceCenti ?? 0),
      discountCenti: Number(s.discountCenti ?? 0),
      unitCostCenti: Number(s.unitCostCenti ?? 0),
      variants: (s.variants as Record<string, unknown>) ?? {},
      soItemId: s.orderItemId,
    })));
    removeScmHandoff('cnFromOrderPicks');
    setPicksLoaded(true);
  }, [fromPicks, picksLoaded]);

  const loadingPrefill = Boolean(fromConsignmentOrder) && !prefilled && coDetail.isLoading;

  const staffList = useMemo(() => (staffQ.data ?? []).filter((s) => s.active), [staffQ.data]);
  const drivers = driversQ.data ?? [];

  const locRows = useMemo(() => loc.data ?? [], [loc.data]);
  /* Shared address cascade, BOTH directions (address-cascade.ts). Three atoms,
     so each pick writes all three back — the raw setters keep the value just
     chosen, which routing through the State picker's handler would clear. */
  const { cities, postcodes } = useAddressCascade(locRows, state, city);
  const applyTriple = (next: { state: string; city: string; postcode: string }) => {
    setState(next.state); setCity(next.city); setPostcode(next.postcode);
  };
  const onCityPick = (next: string) => applyTriple(pickCity(locRows, { state, city, postcode }, next));
  const onPostcodePick = (next: string) => applyTriple(pickPostcode(locRows, { state, city, postcode }, next));

  const updateLine = (rid: string, patch: Partial<SoLineDraft>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const addLine = () => setLines((prev) => [...prev, newLine()]);
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));

  const subtotalCenti = useMemo(
    () => lines.reduce((s, l) => s + Math.max(0, l.qty * l.unitPriceCenti - l.discountCenti), 0),
    [lines],
  );

  const canSave = debtorName.trim().length > 0;

  const flushPaymentDrafts = async (id: string): Promise<{ failed: number }> => {
    if (paymentDrafts.length === 0) return { failed: 0 };
    const tasks = paymentDrafts
      .filter((d) => d.amountCenti > 0)
      .map(async (d) => {
        const { method } = labelToApi(d.methodLabel);
        const body: { id: string } & Record<string, unknown> = {
          id,
          paidAt: d.paidAt,
          method,
          amountCenti: d.amountCenti,
          accountSheet: d.accountSheet || null,
          approvalCode: d.approvalCode || null,
          collectedBy: d.collectedBy || null,
          // Per-draft key — see lib/idempotency.ts. The note is created first and
          // the payments posted after, so a retry of the save re-posts these.
          idempotencyKey: d.idempotencyKey,
        };
        Object.assign(body, draftMethodFields(method, d));
        try { await addPayment.mutateAsync(body); return true; }
        catch (e) {
          // eslint-disable-next-line no-console
          console.error('[consignment-note-payment] post failed for new note:', e);
          return false;
        }
      });
    const results = await Promise.all(tasks);
    return { failed: results.filter((ok) => !ok).length };
  };

  const onSave = () => {
    if (!canSave) { notify({ title: 'Customer name is required.', tone: 'error' }); return; }
    const validLines = lines.filter((l) => l.itemCode.trim() && l.qty > 0);
    if (validLines.length === 0) {
      notify({ title: 'Add at least one item via "+ Add Line Item".', tone: 'error' });
      return;
    }

    create.mutate(
      {
        idempotencyKey: idemKey,
        doDate: doDate || undefined,
        debtorName,
        debtorCode: debtorCode || undefined,
        phone: phone || undefined,
        email: email || undefined,
        salespersonId: salespersonId || undefined,
        customerType: customerType || undefined,
        customerSoNo: customerSoNo || undefined,
        buildingType: buildingType || undefined,
        venue: venue || undefined,
        venueId: venueId || undefined,
        branding: branding || undefined,
        driverId: driverId || undefined,
        driverName: driverName || undefined,
        vehicle: vehicle || undefined,
        address1: address1 || undefined,
        address2: address2 || undefined,
        customerState: state || undefined,
        state: state || undefined,
        city: city || undefined,
        postcode: postcode || undefined,
        salesLocation: salesLocation || undefined,
        expectedDeliveryAt: expectedDeliveryAt || undefined,
        customerDeliveryDate: customerDeliveryDate || undefined,
        emergencyContactName: emergencyName || undefined,
        emergencyContactRelationship: emergencyRel || undefined,
        emergencyContactPhone: emergencyPhone || undefined,
        note: note || undefined,
        items: validLines.map((l) => ({
          itemGroup: l.itemGroup,
          itemCode: l.itemCode,
          description: l.description,
          uom: l.uom,
          qty: l.qty,
          unitPriceCenti: l.unitPriceCenti,
          discountCenti: l.discountCenti,
          unitCostCenti: l.unitCostCenti,
          variants: l.variants,
          consignmentSoItemId: l.soItemId,
        })),
      },
      {
        onSuccess: async (res: { id: string; doNumber: string }) => {
          const { failed } = await flushPaymentDrafts(res.id);
          if (failed > 0) {
            await notify({
              title: 'Some payments failed to save',
              body:
                `Consignment note ${res.doNumber} was created, but ${failed} payment ` +
                `row${failed === 1 ? '' : 's'} failed to save. Please re-enter ` +
                `${failed === 1 ? 'it' : 'them'} on the Detail page.`,
              tone: 'error',
            });
          }
          navigate(`/scm/consignment-notes/${res.id}`);
        },
        onError: (err) => notify({ title: 'Save failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
      },
    );
  };

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Supply Chain"
        title={`New Consignment Note${
          fromConsignmentOrder
            ? (loadingPrefill ? ` · loading ${fromConsignmentOrder}…` : ` · from ${fromConsignmentOrder}`)
            : ''
        }`}
        actions={
          <>
            <div className={styles.actions}>
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/consignment-notes/from-order')}>
                <ArrowRightLeft {...ICON} /> From Consignment Order
              </Button>
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/consignment-notes')}>
                <X {...ICON} /> Cancel
              </Button>
              <Button variant="primary" size="md" onClick={onSave} disabled={create.isPending || loadingPrefill}>
                <Save {...ICON} />
                {create.isPending ? 'Saving…' : 'Create Consignment Note'}
              </Button>
            </div>
          </>
        }
      />

      {/* ── CUSTOMER ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Customer</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: 'span 3' }}>
              <span className={styles.fieldLabel}>Customer Name *</span>
              <input className={styles.fieldInput} value={debtorName}
                onChange={(e) => setDebtorName(e.target.value)} placeholder="e.g. Lim Mei Hua" required />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Ref</span>
              <input className={styles.fieldInput} value={customerSoNo}
                placeholder="Their PO / order number" onChange={(e) => setCustomerSoNo(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Phone</span>
              <PhoneInput className={styles.fieldInput} value={phone} onChange={setPhone} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Email</span>
              <input type="email" className={styles.fieldInput} value={email}
                onChange={(e) => setEmail(e.target.value)} placeholder="customer@example.com" />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={customerType} onChange={(e) => setCustomerType(e.target.value)}>
                  <option value="">—</option>
                  {customerTypeOpts.map((t) => <option key={t.id} value={t.value}>{t.label}</option>)}
                  {customerType && !customerTypeOpts.some((t) => t.value === customerType) && <option value={customerType}>{customerType}</option>}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Salesperson</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={salespersonId} onChange={(e) => setSalespersonId(e.target.value)}>
                  <option value="">— Pick staff —</option>
                  {sortByText(staffList).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.staffCode})</option>)}
                  {salespersonId && !staffList.some((s) => s.id === salespersonId) && <option value={salespersonId}>(former staff)</option>}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
          </div>
        </div>
      </section>

      {/* ── DELIVERY INFO ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Delivery Info</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Note Date</span>
              <input type="date" className={styles.fieldInput} value={doDate}
                onChange={(e) => setDoDate(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Driver</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={driverId}
                  onChange={(e) => {
                    const d = drivers.find((x) => x.id === e.target.value);
                    setDriverId(e.target.value);
                    setDriverName(d?.name ?? '');
                    if (d?.vehicle) setVehicle(d.vehicle);
                  }}>
                  <option value="">— Pick driver —</option>
                  {sortByText(drivers).map((d) => <option key={d.id} value={d.id}>{d.name}{d.vehicle ? ` · ${d.vehicle}` : ''}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Vehicle</span>
              <input className={styles.fieldInput} value={vehicle} onChange={(e) => setVehicle(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Building Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={buildingType} onChange={(e) => setBuildingType(e.target.value)}>
                  <option value="">—</option>
                  {buildingTypeOpts.map((b) => <option key={b.id} value={b.value}>{b.label}</option>)}
                  {buildingType && !buildingTypeOpts.some((b) => b.value === buildingType) && <option value={buildingType}>{buildingType}</option>}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Venue</span>
              <input className={styles.fieldInput} value={venue} onChange={(e) => setVenue(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Expected Delivery</span>
              <input type="date" className={styles.fieldInput} value={expectedDeliveryAt} onChange={(e) => setExpectedDeliveryAt(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Delivery Date</span>
              <input type="date" className={styles.fieldInput} value={customerDeliveryDate} onChange={(e) => setCustomerDeliveryDate(e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Note</span>
              <input className={styles.fieldInput} value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Internal notes — visible on the consignment note detail page only" />
            </label>
          </div>
        </div>
      </section>

      {/* ── EMERGENCY CONTACT ── */}
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
              <input className={styles.fieldInput} value={emergencyName} placeholder="e.g. Lim Mei Hua"
                onChange={(e) => setEmergencyName(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Relationship</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={emergencyRel} onChange={(e) => setEmergencyRel(e.target.value)}>
                  <option value="">—</option>
                  {relationshipOpts.map((r) => <option key={r.id} value={r.value}>{r.label}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Phone</span>
              <PhoneInput className={styles.fieldInput} value={emergencyPhone} onChange={setEmergencyPhone} />
            </label>
          </div>
        </div>
      </section>

      {/* ── DELIVERY ADDRESS ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Delivery Address</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Address Line 1</span>
              <input className={styles.fieldInput} value={address1} onChange={(e) => setAddress1(e.target.value)} placeholder="Unit, street, area" />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Address Line 2</span>
              <input className={styles.fieldInput} value={address2} onChange={(e) => setAddress2(e.target.value)} placeholder="Apt, floor, building (optional)" />
            </label>
            {/* Owner spec 2026-07-23 — StatePicker (MY-default, click Others for CN/SG, Search). Same shared component as Warehouse / Supplier / Venue / MobileNewSO / SalesOrderNew. No `(legacy)` sneak-through, no free-text fallback. */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>State</span>
              <StatePicker
                value={state}
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
                  placeholder={cityPlaceholder(state)}
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
                  onChange={onPostcodePick}
                  placeholder={postcodePlaceholder(state, city)}
                  options={sortByNumeric(postcodes).map((p) => ({ value: p, label: p }))}
                />
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Sales Location</span>
              <span className={styles.fieldInput} style={{
                display: 'inline-flex', alignItems: 'center', height: 26,
                color: 'var(--fg-muted)',
              }}>
                {salesLocation || '—'}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ── LINE ITEMS ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Line Items ({lines.length})</h2></header>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {lines.map((line, idx) => (
            <SoLineCard
              key={line.rid}
              index={idx}
              draft={line}
              onChange={(patch) => updateLine(line.rid, patch)}
              onRemove={() => dropLine(line.rid)}
              canRemove={lines.length > 1}
              /* Downstream document: the items were already specified on the
              originating order and their variants ride in with them, so they
              are NOT re-required here. Same rule DeliveryOrderNewV2 states
              for the DO. Verified 2026-08-13: this document's server does no
              variant enforcement at all (findIncompleteVariantLines appears
              0 times in its route), so the default `= true` was pure
              client-side invention - a red ring and a ` *` for a field the
              backend never asked for. */
              variantsRequired={false}
            />
          ))}
          <button type="button" onClick={addLine}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%',
              padding: '12px 14px', background: 'transparent', border: '1px dashed var(--c-orange)',
              borderRadius: 'var(--radius-md)', color: 'var(--c-orange)', fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-13)', fontWeight: 600, cursor: 'pointer',
            }}>
            <Plus {...ICON} /> Add Line Item
          </button>
          <div style={{
            display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-2)', paddingTop: 'var(--space-3)',
            borderTop: '1px solid var(--line)', fontFamily: 'var(--font-mark)', fontSize: 'var(--fs-20)',
            fontWeight: 800, color: 'var(--c-burnt)',
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
