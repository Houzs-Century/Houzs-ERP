// ----------------------------------------------------------------------------
// DeliveryReturnDetail — the Delivery Return EDITOR.
//
// No route of its own: DeliveryReturnDetailV2 (read-only) lazy-loads this page
// when ?edit=1 lands on /scm/delivery-returns/:id. Save or Cancel returns to
// the read-only page, so this file is edit-only (the read view, totals, print
// and status actions all live on V2).
//
// Editable: Customer / Return Info / Emergency Contact / Delivery Address and
// each line's product, qty, price, discount and remark. A line can be removed.
// Lines cannot be ADDED here: every return line must name a delivered DO line
// (409 do_link_required), so new goods come in through "From Delivery Order".
// Stock is re-synced server-side on every line write.
// ----------------------------------------------------------------------------

import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Save, Undo2, ChevronDown } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { DateField } from '../../vendor/scm/components/DateField';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import {
  useDeliveryReturnDetail,
  useUpdateDeliveryReturnHeader,
  useUpdateDeliveryReturnItem,
  useDeleteDeliveryReturnItem,
} from '../../vendor/scm/lib/delivery-return-queries';
import { SoLineCard, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import { fmtDateOrDash } from '@2990s/shared';
import {
  useLocalities, citiesInState, postcodesInCity,
} from '../../vendor/scm/lib/localities-queries';
import {
  useSoDropdownOptions, optionsOrFallback,
} from '../../vendor/scm/lib/so-dropdown-options-queries';
import { StatePicker } from '../../vendor/scm/components/StatePicker';
import { pickState } from '../../vendor/scm/lib/address-cascade';
import { useStaff } from '../../vendor/scm/lib/admin-queries';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import styles from './SalesOrderDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* Closed returns. The V2 page hides Edit for these; a typed ?edit=1 URL gets a
   notice instead of an editor. CANCELLED is final server-side. */
const LOCKED_STATUSES = ['REFUNDED', 'CREDIT_NOTED', 'CANCELLED', 'REJECTED'];

type DrHeader = {
  id: string;
  return_number: string;
  do_doc_no: string | null;
  status: string;
  return_date: string;
  reason: string | null;
  debtor_code: string | null;
  debtor_name: string;
  salesperson_id: string | null;
  email: string | null;
  customer_type: string | null;
  building_type: string | null;
  venue: string | null;
  customer_so_no: string | null;
  sales_location: string | null;
  customer_state: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  phone: string | null;
  note: string | null;
  notes: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  line_count: number;
};

type DrItem = {
  id: string;
  item_group: string | null;
  item_code: string;
  description: string | null;
  uom: string | null;
  qty_returned: number;
  unit_price_sen: number;
  discount_sen: number;
  /* Stripped from the payload for a non-finance caller; the server keeps the
     stored cost when such a caller posts it back, so 0 here is harmless. */
  unit_cost_sen?: number | null;
  variants: Record<string, unknown> | null;
  notes: string | null;
};

const draftFromItem = (it: DrItem): SoLineDraft => ({
  itemCode: it.item_code,
  itemGroup: it.item_group ?? 'others',
  description: it.description ?? '',
  uom: it.uom ?? 'UNIT',
  qty: it.qty_returned,
  unitPriceSen: it.unit_price_sen,
  discountSen: it.discount_sen,
  unitCostSen: it.unit_cost_sen ?? 0,
  variants: it.variants ?? {},
  remark: it.notes ?? '',
});

export const DeliveryReturnDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const askConfirm = useConfirm();
  const detail = useDeliveryReturnDetail(id ?? null);
  const updateHeader = useUpdateDeliveryReturnHeader();
  const updateItem = useUpdateDeliveryReturnItem();
  const deleteItem = useDeleteDeliveryReturnItem();

  const header = (detail.data?.deliveryReturn as DrHeader | undefined) ?? null;
  const items = useMemo(() => (detail.data?.items as DrItem[] | undefined) ?? [], [detail.data]);

  const [drafts, setDrafts] = useState<Record<string, SoLineDraft | undefined>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const customerCardRef = useRef<CustomerCardHandle | null>(null);

  /* Seed a draft for any line that has none yet and drop drafts for lines that
     are gone (a removed line). Existing drafts keep the operator's typing. */
  useEffect(() => {
    setDrafts((prev) => {
      const next: Record<string, SoLineDraft | undefined> = {};
      for (const it of items) next[it.id] = prev[it.id] ?? draftFromItem(it);
      return next;
    });
  }, [items]);

  const readPath = `/scm/delivery-returns/${id ?? ''}`;
  const exitEditor = () => navigate(readPath, { replace: true });

  const handleHeaderSave = useCallback(
    (patch: Record<string, unknown>, cb?: { onSuccess?: () => void; onError?: (msg: string) => void }) => {
      updateHeader.mutate(
        { id: id ?? '', ...patch },
        {
          onSuccess: () => cb?.onSuccess?.(),
          onError: (e) => cb?.onError?.(e instanceof Error ? e.message : String(e)),
        },
      );
    },
    [id, updateHeader],
  );

  const patchDraft = useCallback((lineId: string, patch: Partial<SoLineDraft>) => {
    setDrafts((prev) => {
      const cur = prev[lineId];
      return cur ? { ...prev, [lineId]: { ...cur, ...patch } } : prev;
    });
  }, []);

  const rowCallbacks = useMemo(() => {
    const map = new Map<string, { onChange: (patch: Partial<SoLineDraft>) => void; onRemove: () => void }>();
    for (const it of items) {
      map.set(it.id, {
        onChange: (patch) => patchDraft(it.id, patch),
        onRemove: () => {
          void (async () => {
            if (await askConfirm({ title: `Remove ${it.item_code} from this return?`, body: 'The returned stock for this line is taken back out.', confirmLabel: 'Remove', danger: true })) {
              deleteItem.mutate({ id: id ?? '', itemId: it.id });
            }
          })();
        },
      });
    }
    return map;
  }, [items, id, patchDraft, deleteItem, askConfirm]);

  if (detail.isPending) return <SkeletonDetailPage />;
  if (detail.isError || !header) {
    return (
      <div className={styles.page}>
        <Link to="/scm/delivery-returns" className={styles.backBtn}>
          <ArrowLeft {...ICON} /><span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Delivery return not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  if (LOCKED_STATUSES.includes(header.status.toUpperCase())) {
    return (
      <div className={styles.page}>
        <Link to={readPath} className={styles.backBtn}>
          <ArrowLeft {...ICON} /><span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>{header.return_number} is closed ({header.status}) and cannot be edited.</strong>
        </div>
      </div>
    );
  }

  const saveEdit = () => {
    const handle = customerCardRef.current;
    if (!handle || saving) return;
    setSaveError(null);
    const lineEntries = Object.entries(drafts).filter((e): e is [string, SoLineDraft] => e[1] !== undefined);
    if (lineEntries.some(([, d]) => !d.itemCode.trim())) {
      setSaveError('Every line must have a product selected before saving.');
      return;
    }
    setSaving(true);
    handle.save({
      onSuccess: () => {
        Promise.all(lineEntries.map(([lineId, d]) => updateItem.mutateAsync({
          id: header.id, itemId: lineId,
          itemCode: d.itemCode, itemGroup: d.itemGroup, description: d.description,
          uom: d.uom, qtyReturned: d.qty, unitPriceSen: d.unitPriceSen, discountSen: d.discountSen,
          unitCostSen: d.unitCostSen, variants: d.variants, notes: d.remark,
        })))
          .then(() => { setSaving(false); exitEditor(); })
          .catch((e: unknown) => {
            setSaving(false);
            setSaveError(`Lines failed to save: ${e instanceof Error ? e.message : String(e)}`);
          });
      },
      onError: (msg) => { setSaving(false); setSaveError(msg); },
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to={readPath} className={styles.backBtn}>
            <ArrowLeft {...ICON} /><span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              <Undo2 size={16} strokeWidth={1.75} style={{ color: 'var(--c-burnt)' }} />
              Edit {header.return_number} — {header.debtor_name}
            </h1>
            <p className={styles.subtitle}>
              Return date {fmtDateOrDash(header.return_date)} · {header.line_count} {header.line_count === 1 ? 'line' : 'lines'}
              {header.do_doc_no && ` · Transfer From ${header.do_doc_no}`}
            </p>
          </div>
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" size="md" onClick={exitEditor} disabled={saving}>
            <span>Cancel</span>
          </Button>
          <Button variant="primary" size="md" onClick={saveEdit} disabled={saving}>
            <Save {...ICON} />
            <span>{saving ? 'Saving…' : 'Save'}</span>
          </Button>
        </div>
      </div>

      {saveError && (
        <div className={styles.bannerWarn}>
          <strong>Save failed.</strong>
          <span>{saveError}</span>
        </div>
      )}

      <CustomerCard
        ref={customerCardRef}
        header={header}
        onSave={handleHeaderSave}
        locked={false}
        isEditing={true}
      />

      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Returned Items ({items.length})</h2>
        </header>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-3)' }}>
          {items.map((it, idx) => {
            const draft = drafts[it.id];
            const cb = rowCallbacks.get(it.id);
            if (!draft || !cb) return null;
            return (
              <SoLineCard
                key={it.id}
                index={idx}
                draft={draft}
                onChange={cb.onChange}
                onRemove={cb.onRemove}
                canRemove={true}
                /* Downstream document: the variants rode in from the DO line;
                   they are not re-required or re-seeded here. */
                variantsRequired={false}
                lineDateLocked={false}
                seedSofaLegDefault={false}
                attachOptions={null}
              />
            );
          })}
          {items.length === 0 && <p className={styles.emptyRow}>No items on this return.</p>}
        </div>
      </section>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Customer / Return Info / Emergency / Delivery Address — editable cards.
   Mirrors DeliveryOrderDetail's CustomerCard (adapted to DR fields).
   ════════════════════════════════════════════════════════════════════════ */

type CustomerCardHandle = {
  save: (cb: { onSuccess: () => void; onError: (msg: string) => void }) => void;
  reset: () => void;
};

type CustomerCardProps = {
  header: DrHeader;
  onSave: (patch: Record<string, unknown>, cb?: { onSuccess?: () => void; onError?: (msg: string) => void }) => void;
  locked?: boolean;
  isEditing?: boolean;
};

const CustomerCardInner = forwardRef<CustomerCardHandle, CustomerCardProps>(({
  header, onSave, locked = false, isEditing = false,
}, ref) => {
  const localities = useLocalities();
  const localityRows = useMemo(() => localities.data ?? [], [localities.data]);
  const staffQ = useStaff();
  const staffList = (staffQ.data ?? []).filter((s) => s.active);

  const customerTypeOptsQ = useSoDropdownOptions('customer_type');
  const buildingTypeOptsQ = useSoDropdownOptions('building_type');
  const relationshipOptsQ = useSoDropdownOptions('relationship');
  const customerTypeOpts = optionsOrFallback('customer_type', customerTypeOptsQ.data);
  const buildingTypeOpts = optionsOrFallback('building_type', buildingTypeOptsQ.data);
  const relationshipOpts = optionsOrFallback('relationship', relationshipOptsQ.data);

  const initialFormFor = (h: DrHeader) => ({
    customerCode: h.debtor_code ?? '',
    customerName: h.debtor_name,
    customerSoNo: h.customer_so_no ?? '',
    email: h.email ?? '',
    customerType: h.customer_type ?? '',
    salespersonId: h.salesperson_id ?? '',
    buildingType: h.building_type ?? '',
    venue: h.venue ?? '',
    phone: h.phone ?? '',
    address1: h.address1 ?? '',
    address2: h.address2 ?? '',
    city: h.city ?? '',
    postcode: h.postcode ?? '',
    state: h.customer_state ?? '',
    emergencyContactName: h.emergency_contact_name ?? '',
    emergencyContactPhone: h.emergency_contact_phone ?? '',
    emergencyContactRelationship: h.emergency_contact_relationship ?? '',
    returnDate: h.return_date,
    reason: h.reason ?? '',
    note: h.note ?? h.notes ?? '',
    salesLocation: h.sales_location ?? '',
  });

  const [form, setForm] = useState(() => initialFormFor(header));

  useEffect(() => {
    setForm(initialFormFor(header));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header]);

  const set = <K extends keyof typeof form>(k: K, v: string) =>
    setForm((s) => ({ ...s, [k]: v }));

  const cities = useMemo(() => (form.state ? citiesInState(localityRows, form.state) : []), [localityRows, form.state]);
  const postcodes = useMemo(
    () => (form.state && form.city ? postcodesInCity(localityRows, form.state, form.city) : []),
    [localityRows, form.state, form.city],
  );

  const buildPayload = () => ({
    debtorCode: form.customerCode,
    debtorName: form.customerName,
    customerSoNo: form.customerSoNo || null,
    email: form.email,
    customerType: form.customerType,
    salespersonId: form.salespersonId || null,
    buildingType: form.buildingType,
    venue: form.venue,
    phone: form.phone,
    address1: form.address1,
    address2: form.address2,
    city: form.city,
    postcode: form.postcode,
    customerState: form.state,
    state: form.state,
    emergencyContactName: form.emergencyContactName,
    emergencyContactPhone: form.emergencyContactPhone,
    emergencyContactRelationship: form.emergencyContactRelationship,
    returnDate: form.returnDate || null,
    reason: form.reason,
    note: form.note,
    salesLocation: form.salesLocation || null,
  });

  useImperativeHandle(ref, () => ({
    save: (cb) => onSave(buildPayload(), cb),
    reset: () => setForm(initialFormFor(header)),
  }));

  const inputsDisabled = !isEditing || locked;

  return (
    <>
      {/* ── CUSTOMER ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Customer</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: 'span 3' }}>
              <span className={styles.fieldLabel}>Customer Name *</span>
              <input className={styles.fieldInput} value={form.customerName}
                disabled={inputsDisabled} onChange={(e) => set('customerName', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Ref No.</span>
              <input className={styles.fieldInput} value={form.customerSoNo}
                placeholder="Their PO / SO number" disabled={inputsDisabled}
                onChange={(e) => set('customerSoNo', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Phone *</span>
              <PhoneInput className={styles.fieldInput} value={form.phone} disabled={inputsDisabled} onChange={(v) => set('phone', v)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Email</span>
              <input type="email" className={styles.fieldInput} value={form.email}
                disabled={inputsDisabled} onChange={(e) => set('email', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.customerType}
                  disabled={inputsDisabled} onChange={(e) => set('customerType', e.target.value)}>
                  <option value="">—</option>
                  {customerTypeOpts.map((t) => <option key={t.id} value={t.value}>{t.label}</option>)}
                  {form.customerType && !customerTypeOpts.some((t) => t.value === form.customerType) && (
                    <option value={form.customerType}>{form.customerType}</option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Salesperson</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.salespersonId}
                  disabled={inputsDisabled} onChange={(e) => set('salespersonId', e.target.value)}>
                  <option value="">— Pick staff —</option>
                  {sortByText(staffList).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.staffCode})</option>)}
                  {form.salespersonId && !staffList.some((s) => s.id === form.salespersonId) && (
                    <option value={form.salespersonId}>(former staff)</option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
          </div>
        </div>
      </section>

      {/* ── RETURN INFO (date / reason / note) ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Return Info</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Return Date</span>
              <DateField className={styles.fieldInput} fullWidth value={form.returnDate}
                disabled={inputsDisabled} onChange={(iso) => set('returnDate', iso)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Building Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.buildingType}
                  disabled={inputsDisabled} onChange={(e) => set('buildingType', e.target.value)}>
                  <option value="">—</option>
                  {buildingTypeOpts.map((b) => <option key={b.id} value={b.value}>{b.label}</option>)}
                  {form.buildingType && !buildingTypeOpts.some((b) => b.value === form.buildingType) && (
                    <option value={form.buildingType}>{form.buildingType}</option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Venue</span>
              <input className={styles.fieldInput} value={form.venue}
                disabled={inputsDisabled} onChange={(e) => set('venue', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Reason</span>
              <input className={styles.fieldInput} value={form.reason}
                placeholder="Why is this being returned?" disabled={inputsDisabled}
                onChange={(e) => set('reason', e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Note</span>
              <input className={styles.fieldInput} value={form.note}
                disabled={inputsDisabled} onChange={(e) => set('note', e.target.value)} />
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
              <input className={styles.fieldInput} value={form.emergencyContactName}
                placeholder="e.g. Lim Mei Hua" disabled={inputsDisabled}
                onChange={(e) => set('emergencyContactName', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Relationship</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.emergencyContactRelationship}
                  disabled={inputsDisabled} onChange={(e) => set('emergencyContactRelationship', e.target.value)}>
                  <option value="">—</option>
                  {relationshipOpts.map((r) => <option key={r.id} value={r.value}>{r.label}</option>)}
                  {form.emergencyContactRelationship && !relationshipOpts.some((r) => r.value === form.emergencyContactRelationship) && (
                    <option value={form.emergencyContactRelationship}>{form.emergencyContactRelationship}</option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Phone</span>
              <PhoneInput className={styles.fieldInput} value={form.emergencyContactPhone}
                disabled={inputsDisabled} onChange={(v) => set('emergencyContactPhone', v)} />
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
              <input className={styles.fieldInput} value={form.address1}
                placeholder="Unit, street, area" disabled={inputsDisabled}
                onChange={(e) => set('address1', e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Address Line 2</span>
              <input className={styles.fieldInput} value={form.address2}
                placeholder="Apt, floor, building (optional)" disabled={inputsDisabled}
                onChange={(e) => set('address2', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>State</span>
              <StatePicker
                value={form.state}
                onChange={(next) => setForm((s) => ({ ...s, ...pickState(next) }))}
                disabled={inputsDisabled}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>City</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.city}
                  onChange={(e) => setForm((s) => ({ ...s, city: e.target.value, postcode: '' }))}
                  disabled={inputsDisabled || !form.state}>
                  <option value="">{form.state ? 'Pick city' : '— pick state first'}</option>
                  {sortByText(cities).map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Postcode</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.postcode}
                  onChange={(e) => set('postcode', e.target.value)}
                  disabled={inputsDisabled || !form.city}>
                  <option value="">{form.city ? 'Pick postcode' : '— pick city first'}</option>
                  {sortByNumeric(postcodes).map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Sales Location</span>
              <span className={styles.fieldInput} style={{ display: 'inline-flex', alignItems: 'center', height: 26, color: 'var(--fg-muted)' }}>
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

