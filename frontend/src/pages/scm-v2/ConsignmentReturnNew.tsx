// ----------------------------------------------------------------------------
// ConsignmentReturnNew — full-page Create Consignment Return at
// /scm/consignment-returns/new.
//
// Faithful clone of DeliveryReturnNew.tsx. It reuses the SAME shared components
// UNCHANGED — SoLineCard (+ emptySoLine / SoLineDraft) + PhoneInput — and the
// SAME generic data hooks (useStaff, useLocalities, useSoDropdownOptions). The
// Customer / Return Info / Emergency / Delivery Address cards + SoLineCard list
// are identical to the DR create flow. There is no payments ledger on a return.
//
// The DR-specific wiring is intentionally DROPPED here:
//   • the ?fromDo / ?fromPicks prefill + DO detail read-back
//   • the "From Delivery Order" header button + DO-line picker
//   • the per-line doItemId "every line needs a DO line" requirement
// A consignment return is always a blank Create form (free-entry lines), so the
// condition is entered free-hand per line.
//
// On Save: POST /consignment-returns (header + items). The backend route
// `/consignment-returns` mirrors `/delivery-returns` 1:1; numbering is
// CRN-YYMM-NNN.
// ----------------------------------------------------------------------------

import { transferFromLabel } from '../../lib/convertScope';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRightLeft, ChevronDown, Plus, Save, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useCreateConsignmentReturn } from '../../vendor/scm/lib/consignment-return-queries';
import { useIdempotencyKey } from '../../lib/idempotency';
import { readScmHandoff, removeScmHandoff } from '../../lib/scmHandoffStorage';
import { useConsignmentNoteDetail } from '../../vendor/scm/lib/consignment-note-queries';
import { usePickableStaff } from '../../vendor/scm/lib/admin-queries';
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
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { fmtMoneySen } from '@2990s/shared';
import { DateField } from "../../vendor/scm/components/DateField";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type DraftLine = SoLineDraft & { rid: string; condition?: string; doItemId?: string };

const newLine = (): DraftLine => ({
  ...emptySoLine(),
  rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
});

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneySen(centi, currency);

export const ConsignmentReturnNew = () => {
  const navigate = useNavigate();
  const notify = useNotify();
  const [searchParams] = useSearchParams();
  // Convert-from: a Consignment Note (=DO) this return collects back. Mirrors the
  // DR's ?fromDo= prefill — seed header + lines from the note, free-edit after.
  const fromConsignmentNote = searchParams.get('fromConsignmentNote');
  const fromPicks = searchParams.get('fromPicks') === '1';

  /* One key for the one return this page is open to raise (lib/idempotency.ts).
     Route-level form, navigates to the return detail on success, so the MOUNT is
     exactly one return: stable across re-renders and across a re-press after a
     stalled submit, fresh on remount. */
  const idemKey = useIdempotencyKey();
  const create = useCreateConsignmentReturn();
  const staffQ = usePickableStaff({ onlySales: true });
  const loc = useLocalities();
  const cnDetail = useConsignmentNoteDetail(fromConsignmentNote);

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

  // ── Return info ──
  const [buildingType, setBuildingType] = useState('');
  const [venue, setVenue] = useState('');
  const [venueId, setVenueId] = useState('');
  const [returnDate, setReturnDate] = useState(() => todayMyt());
  const [reason, setReason] = useState('');
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

  // ── Items ──
  const [lines, setLines] = useState<DraftLine[]>(() => [newLine()]);

  // ── Convert-from prefill (seed once when the source note arrives) ──
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (!fromConsignmentNote || prefilled) return;
    const cn = cnDetail.data?.deliveryOrder as Record<string, unknown> | undefined;
    const cnItems = (cnDetail.data?.items as Array<Record<string, unknown>> | undefined) ?? [];
    if (!cn) return;

    const str = (v: unknown): string => (v == null ? '' : String(v));
    setDebtorCode(str(cn.debtor_code));
    setDebtorName(str(cn.debtor_name));
    setPhone(str(cn.phone));
    setEmail(str(cn.email));
    setSalespersonId(str(cn.salesperson_id));
    setCustomerType(str(cn.customer_type));
    setCustomerSoNo(str(cn.customer_so_no));
    setBuildingType(str(cn.building_type));
    setVenue(str(cn.venue));
    setVenueId(str(cn.venue_id));
    setNote(str(cn.note));
    setAddress1(str(cn.address1));
    setAddress2(str(cn.address2));
    setState(str(cn.customer_state ?? cn.state));
    setCity(str(cn.city));
    setPostcode(str(cn.postcode));
    setSalesLocation(str(cn.sales_location));
    setBranding(str(cn.branding));
    setEmergencyName(str(cn.emergency_contact_name));
    setEmergencyRel(str(cn.emergency_contact_relationship));
    setEmergencyPhone(str(cn.emergency_contact_phone));
    if (cn.do_number) setReason(`Return from ${str(cn.do_number)}`);

    if (cnItems.length > 0) {
      setLines(cnItems.map((it, idx) => ({
        ...newLine(),
        rid: `l${Date.now()}-${idx}-${str(it.id).slice(0, 6)}`,
        itemGroup: str(it.item_group) || 'others',
        itemCode: str(it.item_code),
        description: str(it.description),
        uom: str(it.uom) || 'UNIT',
        qty: Number(it.qty ?? 1),
        unitPriceSen: Number(it.unit_price_sen ?? 0),
        discountSen: Number(it.discount_sen ?? 0),
        unitCostSen: Number(it.unit_cost_sen ?? 0),
        variants: (it.variants as Record<string, unknown>) ?? {},
        condition: 'NEW',
      })));
    }

    setPrefilled(true);
  }, [fromConsignmentNote, prefilled, cnDetail.data]);

  // ── From-Note multi-picker merge (fromPicks) — the operator chose specific
  //    note lines + quantities on /scm/consignment-returns/from-note. Seed lines from
  //    the stash, carrying each line's source note-line id so the backend links
  //    the return to the note line. Debtor comes from the first picked line —
  //    one debtor per return (the picker enforces it).
  useEffect(() => {
    if (!fromPicks || prefilled) return;
    type Stash = {
      noteItemId: string; consignmentDoId: string; noteNumber: string;
      debtorCode: string | null; debtorName: string | null;
      itemCode: string; itemGroup: string | null; description: string | null;
      uom: string | null; qty: number; condition: string;
      unitPriceSen: number; discountSen: number; unitCostSen: number; variants: unknown;
    };
    const stash = readScmHandoff<Stash[]>('crFromNotePicks');
    if (!stash || stash.length === 0) return;

    const first = stash[0];
    if (!first) return;
    setDebtorCode(first.debtorCode ?? '');
    setDebtorName(first.debtorName ?? '');
    setReason(`Return from ${first.noteNumber}`);
    setLines(stash.map((s, idx) => ({
      ...newLine(),
      rid: `l${Date.now()}-${idx}-${s.noteItemId.slice(0, 6)}`,
      itemGroup: (s.itemGroup as string) || 'others',
      itemCode: s.itemCode ?? '',
      description: s.description ?? '',
      uom: s.uom ?? 'UNIT',
      qty: Number(s.qty ?? 1),
      unitPriceSen: Number(s.unitPriceSen ?? 0),
      discountSen: Number(s.discountSen ?? 0),
      unitCostSen: Number(s.unitCostSen ?? 0),
      variants: (s.variants as Record<string, unknown>) ?? {},
      condition: s.condition || 'NEW',
      doItemId: s.noteItemId,
    })));
    removeScmHandoff('crFromNotePicks');
    setPrefilled(true);
  }, [fromPicks, prefilled]);

  const loadingPrefill = Boolean(fromConsignmentNote) && !prefilled && cnDetail.isLoading;

  const staffList = useMemo(() => (staffQ.data ?? []).filter((s) => s.active), [staffQ.data]);

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

  const subtotalSen = useMemo(
    () => lines.reduce((s, l) => s + Math.max(0, l.qty * l.unitPriceSen - l.discountSen), 0),
    [lines],
  );

  const canSave = debtorName.trim().length > 0;

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
        address1: address1 || undefined,
        address2: address2 || undefined,
        customerState: state || undefined,
        state: state || undefined,
        city: city || undefined,
        postcode: postcode || undefined,
        salesLocation: salesLocation || undefined,
        returnDate: returnDate || undefined,
        reason: reason || undefined,
        emergencyContactName: emergencyName || undefined,
        emergencyContactRelationship: emergencyRel || undefined,
        emergencyContactPhone: emergencyPhone || undefined,
        note: note || undefined,
        items: validLines.map((l) => ({
          itemGroup: l.itemGroup,
          itemCode: l.itemCode,
          description: l.description,
          uom: l.uom,
          qtyReturned: l.qty,
          condition: l.condition || 'NEW',
          unitPriceSen: l.unitPriceSen,
          discountSen: l.discountSen,
          unitCostSen: l.unitCostSen,
          variants: l.variants,
          consignmentDoItemId: l.doItemId,
        })),
      },
      {
        onSuccess: (res: { id: string; returnNumber: string }) => {
          navigate(`/scm/consignment-returns/${res.id}`);
        },
        onError: (err) => notify({ title: 'Save failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
      },
    );
  };

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Supply Chain"
        title={`New Consignment Return${
          fromConsignmentNote
            ? (loadingPrefill ? ' · loading note…' : ' · from Consignment Note')
            : ''
        }`}
        actions={
          <>
            <div className={styles.actions}>
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/consignment-returns/from-note')}>
                <ArrowRightLeft {...ICON} /> {transferFromLabel('cn')}
              </Button>
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/consignment-returns')}>
                <X {...ICON} /> Cancel
              </Button>
              <Button variant="primary" size="md" onClick={onSave} disabled={create.isPending || !canSave || loadingPrefill}>
                <Save {...ICON} />
                {create.isPending ? 'Saving…' : 'Create Consignment Return'}
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
                <SearchableSelect
                  className={styles.fieldSelect}
                  ariaLabel="Salesperson"
                  placeholder="— Pick staff —"
                  value={salespersonId}
                  onChange={setSalespersonId}
                  options={[
                    ...sortByText(staffList).map((s) => ({ value: s.id, label: `${s.name} (${s.staffCode})` })),
                    ...(salespersonId && !staffList.some((s) => s.id === salespersonId)
                      ? [{ value: salespersonId, label: '(former staff)' }]
                      : []),
                  ]}
                />
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
          </div>
        </div>
      </section>

      {/* ── RETURN INFO ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Return Info</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Return Date</span>
              <DateField fullWidth className={styles.fieldInput} value={returnDate} onChange={(iso) => setReturnDate(iso)}/>
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
              <span className={styles.fieldLabel}>Reason</span>
              <input className={styles.fieldInput} value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this being returned?" />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Note</span>
              <input className={styles.fieldInput} value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Internal notes — visible on the return detail page only" />
            </label>
          </div>
        </div>
      </section>

      {/* ── EMERGENCY CONTACT ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Emergency Contact</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            Used only if we cannot reach the customer on collection day
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
            {/* Owner spec 2026-07-23 — StatePicker (MY-default, click Others for CN/SG, Search). Same shared component as Warehouse / Supplier / Venue / MobileNewSO / SalesOrderNew / SalesOrderDetail. No `(legacy)` sneak-through, no free-text fallback. */}
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
          </div>
        </div>
      </section>

      {/* ── RETURNED ITEMS ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Returned Items ({lines.length})</h2></header>
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
            Returned Value: {fmtRm(subtotalSen)}
          </div>
        </div>
      </section>
    </div>
  );
};
