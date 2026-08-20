// ----------------------------------------------------------------------------
// DeliveryReturnNew — full-page Create Delivery Return at /delivery-returns/new.
//
// DO-style editable Create form (clone of DeliveryOrderNew): the same Customer /
// Return Info / Emergency / Delivery Address cards + SoLineCard list. There is
// no payments ledger on a return (unlike the DO), so PaymentsTable is omitted.
//
// Prefill: when navigated with ?fromDo=<DO id>, it fetches the DO header +
// items and seeds every field (debtor, salesperson, address, phone, line items
// with variants + prices/costs) so the operator can review/edit before Saving.
// Without ?fromDo it is a blank Create-Return form (free-entry lines).
//
// On Save: POST /delivery-returns (header + items). The server INCREASES stock
// on create (idempotent) and lands us on the new return's Detail page.
//
// NOTE: the primary "from a DO" path is the dedicated picker
// (/delivery-returns/from-do). This page is the blank form + the ?fromDo
// prefill convenience (mirrors DeliveryOrderNew's ?fromSo).
// ----------------------------------------------------------------------------

import { transferFromLabel } from '../../lib/convertScope';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRightLeft, ChevronDown, Save, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { DateField } from '../../vendor/scm/components/DateField';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import {
  useCreateDeliveryReturn, useMfgDeliveryOrderDetail,
} from '../../vendor/scm/lib/delivery-return-queries';
import { useIdempotencyKey } from '../../lib/idempotency';
import { readScmHandoff, removeScmHandoff } from '../../lib/scmHandoffStorage';
import { usePickableStaff } from '../../vendor/scm/lib/admin-queries';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import { useLocalities } from '../../vendor/scm/lib/localities-queries';
import {
  useAddressCascade, pickState, pickCity, pickPostcode,
  cityPlaceholder, postcodePlaceholder,
} from '../../vendor/scm/lib/address-cascade';
import { StatePicker } from '../../vendor/scm/components/StatePicker';
import {
  useSoDropdownOptions, optionsOrFallback,
} from '../../vendor/scm/lib/so-dropdown-options-queries';
import { SoLineCard, emptySoLine, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { fmtMoneySen } from '@2990s/shared';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type DraftLine = SoLineDraft & { rid: string; doItemId?: string; condition?: string };

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneySen(centi, currency);

export const DeliveryReturnNew = () => {
  const navigate = useNavigate();
  const notify = useNotify();
  const [searchParams] = useSearchParams();
  const fromDo = searchParams.get('fromDo');
  const fromPicks = searchParams.get('fromPicks') === '1';

  const create = useCreateDeliveryReturn();
  /* One key for the one return this page is open to raise (lib/idempotency.ts).
     Route-level form, navigates to the return detail on success, so the MOUNT is
     exactly one return. Load-bearing: the create increases stock inline (see
     useCreateDeliveryReturn), so a re-press after a stalled submit books the
     goods back IN twice unless it replays. */
  const idemKey = useIdempotencyKey();
  const staffQ = usePickableStaff({ onlySales: true });
  const loc = useLocalities();

  // Prefill source — the DO this return is being issued from (if any).
  const doDetail = useMfgDeliveryOrderDetail(fromDo);

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

  // ── Source DO snapshot (carried through to the API) ──
  const [doDocNo, setDoDocNo] = useState('');

  // ── Items ──
  // A Delivery Return line MUST come from a delivered Delivery Order line (the
  // server rejects free-entry lines with 409 do_link_required). So there is no
  // blank starter line and no free "Add Line Item" affordance — lines are only
  // ever seeded from a DO (via ?fromDo prefill or the From-DO picker).
  const [lines, setLines] = useState<DraftLine[]>(() => []);

  /* Prefill from the DO once its detail loads. Guarded so we only seed once
     (when the form is still pristine) — re-fetches don't clobber edits. */
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (!fromDo || prefilled) return;
    const dval = doDetail.data?.deliveryOrder as Record<string, unknown> | undefined;
    const doItems = (doDetail.data?.items as Array<Record<string, unknown>> | undefined) ?? [];
    if (!dval) return;

    setDebtorCode((dval.debtor_code as string) ?? '');
    setDebtorName((dval.debtor_name as string) ?? '');
    setPhone((dval.phone as string) ?? '');
    setEmail((dval.email as string) ?? '');
    setSalespersonId((dval.salesperson_id as string) ?? '');
    setCustomerType((dval.customer_type as string) ?? '');
    setCustomerSoNo((dval.customer_so_no as string) ?? '');
    setBuildingType((dval.building_type as string) ?? '');
    setVenue((dval.venue as string) ?? '');
    setVenueId((dval.venue_id as string) ?? '');
    setNote((dval.note as string) ?? '');
    setAddress1((dval.address1 as string) ?? '');
    setAddress2((dval.address2 as string) ?? '');
    setState((dval.customer_state as string) ?? (dval.state as string) ?? '');
    setCity((dval.city as string) ?? '');
    setPostcode((dval.postcode as string) ?? '');
    setSalesLocation((dval.sales_location as string) ?? '');
    setBranding((dval.branding as string) ?? '');
    setEmergencyName((dval.emergency_contact_name as string) ?? '');
    setEmergencyRel((dval.emergency_contact_relationship as string) ?? '');
    setEmergencyPhone((dval.emergency_contact_phone as string) ?? '');
    setDoDocNo((dval.do_number as string) ?? '');
    setReason(`Return from DO ${(dval.do_number as string) ?? ''}`);

    // When we arrived from the DO→Return picker (fromPicks) the operator already
    // chose specific lines, quantities and conditions — build from that stash,
    // carrying each line's doItemId (the server's remaining-to-return tracking
    // depends on it) and its condition. Otherwise (plain ?fromDo) seed every DO
    // line at full quantity, condition NEW.
    type Stash = {
      doItemId: string; itemCode: string; itemGroup: string | null;
      description: string | null; uom: string | null; qty: number; condition: string;
      unitPriceSen: number; discountSen: number; unitCostSen: number; variants: unknown;
    };
    const stash = fromPicks ? readScmHandoff<Stash[]>('drFromDoPicks') : null;

    if (stash && stash.length > 0) {
      setLines(stash.map((s, i) => ({
        ...emptySoLine(),
        rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${i}`,
        itemCode: s.itemCode ?? '',
        itemGroup: (s.itemGroup as string) ?? 'others',
        description: s.description ?? '',
        uom: s.uom ?? 'UNIT',
        qty: Number(s.qty ?? 1),
        unitPriceSen: Number(s.unitPriceSen ?? 0),
        discountSen: Number(s.discountSen ?? 0),
        unitCostSen: Number(s.unitCostSen ?? 0),
        variants: (s.variants as Record<string, unknown>) ?? {},
        remark: '',
        doItemId: s.doItemId,
        condition: s.condition || 'NEW',
      })));
      removeScmHandoff('drFromDoPicks');
    } else if (doItems.length > 0) {
      setLines(doItems.map((it) => ({
        ...emptySoLine(),
        rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${String(it.id)}`,
        itemCode: (it.item_code as string) ?? '',
        itemGroup: (it.item_group as string) ?? 'others',
        description: (it.description as string) ?? '',
        uom: (it.uom as string) ?? 'UNIT',
        qty: Number(it.qty ?? 1),
        unitPriceSen: Number(it.unit_price_sen ?? 0),
        discountSen: 0,
        unitCostSen: Number(it.unit_cost_sen ?? 0),
        variants: (it.variants as Record<string, unknown>) ?? {},
        remark: '',
        doItemId: (it.id as string) ?? undefined,
        condition: 'NEW',
      })));
    }

    setPrefilled(true);
  }, [fromDo, fromPicks, prefilled, doDetail.data]);

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
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));

  const subtotalSen = useMemo(
    () => lines.reduce((s, l) => s + Math.max(0, l.qty * l.unitPriceSen - l.discountSen), 0),
    [lines],
  );

  const canSave = debtorName.trim().length > 0;

  const onSave = () => {
    if (loadingPrefill) { notify({ title: 'Still loading the Delivery Order', body: 'please wait a moment.' }); return; }
    if (!canSave) { notify({ title: 'Customer name is required.', tone: 'error' }); return; }
    const validLines = lines.filter((l) => l.itemCode.trim() && l.qty > 0);
    if (validLines.length === 0) {
      notify({ title: 'Pick the returned items from a delivered Delivery Order.', tone: 'error' });
      return;
    }
    // Server rule (delivery-returns.ts → 409 do_link_required): every return line
    // MUST reference a delivered DO line. Block here so free/edited lines that
    // lost their doItemId can never reach the server as an unsaveable request.
    if (validLines.some((l) => !l.doItemId)) {
      notify({ title: 'Every return line must be picked from a delivered Delivery Order — start from a DO.', tone: 'error' });
      return;
    }

    create.mutate(
      {
        idempotencyKey: idemKey,
        doDocNo: doDocNo || undefined,
        deliveryOrderId: fromDo || undefined,
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
          doItemId: l.doItemId,
        })),
      },
      {
        onSuccess: (res: { id: string; returnNumber: string }) => {
          navigate(`/scm/delivery-returns/${res.id}`);
        },
        onError: (err) => notify({ title: 'Save failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
      },
    );
  };

  const loadingPrefill = Boolean(fromDo) && !prefilled && doDetail.isLoading;

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Supply Chain"
        title={`New Delivery Return${doDocNo ? ` — from ${doDocNo}` : ''}`}
        actions={
          <>
            <div className={styles.actions}>
              {/* Pull lines from a Delivery Order — mirrors New GRN's "From Purchase Order". */}
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/delivery-returns/from-do')}>
                <ArrowRightLeft {...ICON} /> {transferFromLabel('do')}
              </Button>
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/delivery-returns')}>
                <X {...ICON} /> Cancel
              </Button>
              <Button variant="primary" size="md" onClick={onSave} disabled={create.isPending || !canSave || loadingPrefill}>
                <Save {...ICON} />
                {create.isPending ? 'Saving…' : 'Create Delivery Return'}
              </Button>
            </div>
          </>
        }
      />

      {loadingPrefill && (
        <div className={styles.bannerWarn} style={{ background: 'var(--c-cream)', border: '1px solid var(--line)', color: 'var(--fg-muted)' }}>
          Loading DO…
        </div>
      )}

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
              <span className={styles.fieldLabel}>Customer SO Ref</span>
              <input className={styles.fieldInput} value={customerSoNo}
                placeholder="Their PO / SO number" onChange={(e) => setCustomerSoNo(e.target.value)} />
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

      {/* ── RETURN INFO ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Return Info</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Return Date</span>
              <DateField fullWidth className={styles.fieldInput} value={returnDate ?? ''} onChange={(iso) => setReturnDate(iso)} />
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
                <select className={styles.fieldSelect} value={city}
                  onChange={(e) => onCityPick(e.target.value)}>
                  <option value="">{cityPlaceholder(state)}</option>
                  {sortByText(cities).map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Postcode</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={postcode}
                  onChange={(e) => onPostcodePick(e.target.value)}>
                  <option value="">{postcodePlaceholder(state, city)}</option>
                  {sortByNumeric(postcodes).map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
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
          {/* No free "Add Line Item": a return line must come from a delivered DO
              (server 409 do_link_required). When empty, steer to the From-DO picker. */}
          {lines.length === 0 && (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-3)',
              padding: '24px 14px', border: '1px dashed var(--line)', borderRadius: 'var(--radius-md)',
              color: 'var(--fg-muted)', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', textAlign: 'center',
            }}>
              <span>Every return line must be picked from a delivered Delivery Order — start from a DO.</span>
              <Button variant="primary" size="md" onClick={() => navigate('/scm/delivery-returns/from-do')}>
                <ArrowRightLeft {...ICON} /> {transferFromLabel('do')}
              </Button>
            </div>
          )}
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
