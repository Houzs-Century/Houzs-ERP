
import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useCreateWarehouse,
  useUpdateWarehouse,
  type StockBucket,
  type Warehouse,
  type WarehouseType,
} from '../lib/inventory-queries';
import { useLocalities, distinctCountries } from '../lib/localities-queries';
import { AddressTripleFields, type AddressTripleClasses } from './AddressTripleFields';
import { useNotify } from './NotifyDialog';
import styles from '../../../pages/scm-v2/Suppliers.module.css';
import { masterNeedsPostcode, masterPostcodeError } from '../../shared/master-postcode-rule';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const TRIPLE_CLASSES: AddressTripleClasses = {
  field: styles.tripleField,
  label: styles.eyebrow,
  select: styles.searchInput,
  input: styles.searchInput,
};

const TYPE_OPTIONS: { value: WarehouseType; label: string }[] = [
  { value: 'warehouse', label: 'Warehouse (stock)' },
  { value: 'showroom',  label: 'Showroom (sales + venue)' },
  { value: 'display',   label: 'Display (partner display stock)' },
  { value: 'service',   label: 'Service centre' },
  { value: 'others',    label: 'Others (HQ, etc.)' },
];

export const WarehouseFormDrawer = ({
  editing, onClose, onSaved,
}: {
  editing: Warehouse | null;
  onClose: () => void;
  onSaved?: () => void;
}) => {
  const create = useCreateWarehouse();
  const update = useUpdateWarehouse();
  const notify = useNotify();
  const initialType: WarehouseType =
    editing?.type ?? (editing?.is_showroom ? 'showroom' : 'warehouse');
  const [form, setForm] = useState({
    code: editing?.code ?? '',
    name: editing?.name ?? '',
    location: editing?.location ?? '',
    country: editing?.country ?? '',
    state: editing?.state ?? '',
    city: editing?.city ?? '',
    postcode: editing?.postcode ?? '',
    isActive: editing?.is_active ?? true,
    isDefault: editing?.is_default ?? false,
    type: initialType,
    venueName: editing?.venue_name ?? '',
    /* The closing-stock bucket (owner 2026-09-21); '' = by type. */
    stockBucket: editing?.stock_bucket ?? '',
  });

  const localities = useLocalities();
  const localityRows = localities.data ?? [];
  const countries = useMemo(() => distinctCountries(localityRows), [localityRows]);

  const done = () => { onSaved?.(); onClose(); };

  const submit = () => {
    if (!form.code.trim() || !form.name.trim()) {
      notify({ title: 'Code and Name are required.', tone: 'error' });
      return;
    }
    const pcErr = masterPostcodeError(form.country, form.postcode);
    if (pcErr) { void notify({ title: pcErr, tone: 'error' }); return; }
    const isShowroom = form.type === 'showroom';
    if (isShowroom && !form.venueName.trim()) {
      notify({
        title: 'A Showroom needs a Venue name.',
        body: 'Sales orders raised by salespeople parked under this showroom will be attributed to this venue.',
        tone: 'error',
      });
      return;
    }
    if (editing) {
      update.mutate({
        id: editing.id,
        code: form.code,
        name: form.name,
        location: form.location,
        country: form.country || null,
        state: form.state || null,
        city: form.city || null,
        postcode: form.postcode || null,
        isActive: form.isActive,
        isDefault: form.isDefault,
        type: form.type,
        venueName: isShowroom ? form.venueName.trim() : null,
        stockBucket: (form.stockBucket || null) as StockBucket | null,
      }, { onSuccess: done });
    } else {
      create.mutate({
        code: form.code,
        name: form.name,
        location: form.location || undefined,
        country: form.country || null,
        state: form.state || null,
        city: form.city || null,
        postcode: form.postcode || null,
        isDefault: form.isDefault,
        type: form.type,
        venueName: isShowroom ? form.venueName.trim() : null,
        stockBucket: (form.stockBucket || null) as StockBucket | null,
      }, { onSuccess: done });
    }
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>{editing ? 'Edit Warehouse' : 'New Warehouse'}</h2>
          <button type="button" onClick={onClose} className={styles.codeChip}>
            <X {...ICON} />
          </button>
        </div>
        <div className={styles.drawerBody}>
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
            <div className={styles.eyebrow}>Code *</div>
            <input className={styles.searchInput} style={{ width: '100%' }}
              value={form.code} placeholder="KL / PJ / JB"
              onChange={(e) => setForm((s) => ({ ...s, code: e.target.value.toUpperCase() }))} />
          </label>
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
            <div className={styles.eyebrow}>Name *</div>
            <input className={styles.searchInput} style={{ width: '100%' }}
              value={form.name} placeholder="KL Warehouse / 2990 PJ"
              onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))} />
          </label>
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
            <div className={styles.eyebrow}>Street / area</div>
            <input className={styles.searchInput} style={{ width: '100%' }}
              value={form.location ?? ''} placeholder="e.g. No. 12, Jalan …"
              onChange={(e) => setForm((s) => ({ ...s, location: e.target.value }))} />
          </label>
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
            <div className={styles.eyebrow}>Country</div>
            <select className={styles.searchInput} style={{ width: '100%' }}
              value={form.country ?? ''}
              disabled={countries.length === 0}
              onChange={(e) => setForm((s) => ({ ...s, country: e.target.value, state: '', city: '', postcode: '' }))}
            >
              <option value="">
                {countries.length === 0 ? 'No countries seeded' : '— pick country —'}
              </option>
              {countries.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          {/* State / City / Postcode — the Sales Order's controls and cascade
              (owner 2026-11-17: every DP job carries Postcode + City + State, and
              a TRANSFER takes them from here). Postcode is always shown; picking
              or typing one fills City and State back. */}
          <AddressTripleFields
            postcodeRequired={masterNeedsPostcode(form.country)}
            country={form.country}
            value={{ state: form.state, city: form.city, postcode: form.postcode }}
            onChange={(next, derivedCountry) => setForm((s) => ({
              ...s,
              ...next,
              country: derivedCountry ?? s.country,
            }))}
            classes={TRIPLE_CLASSES}
          />
          {/* ── Type (mig 0171) ───────────────────────────────────────────
              5-bucket classification: warehouse / showroom / display / service
              / others. Owner 2026-07-22: SO reports and delivery routing bucket
              by this, so it must be picked here (not derived from the code). */}
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
            <div className={styles.eyebrow}>Type *</div>
            <select className={styles.searchInput} style={{ width: '100%' }}
              value={form.type}
              onChange={(e) => setForm((s) => ({ ...s, type: e.target.value as WarehouseType }))}
            >
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          {/* The closing-stock bucket (owner 2026-09-21; showroom and others
              their own since 2026-09-30): which closing stock this warehouse's
              goods book on at month end. Blank follows the type — warehouse →
              customer, display → display, showroom → showroom, service →
              service, others → others. */}
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
            <div className={styles.eyebrow}>Closing stock bucket</div>
            <select className={styles.searchInput} style={{ width: '100%' }} aria-label="Closing stock bucket"
              value={form.stockBucket}
              onChange={(e) => setForm((s) => ({ ...s, stockBucket: e.target.value }))}
            >
              <option value="">Auto (by type)</option>
              <option value="customer">Customer stock</option>
              <option value="display">Display stock</option>
              <option value="service">Service stock</option>
              <option value="showroom">Showroom stock</option>
              <option value="others">Others stock</option>
            </select>
          </label>
          {form.type === 'showroom' && (
            <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
              <div className={styles.eyebrow}>Venue name *</div>
              <input className={styles.searchInput} style={{ width: '100%' }}
                value={form.venueName} placeholder="Kuala Lumpur Showroom"
                onChange={(e) => setForm((s) => ({ ...s, venueName: e.target.value }))} />
              <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
                Sales orders raised by salespeople parked under this showroom
                default to this venue. It also appears in the Sales Maintenance
                venue list.
              </div>
            </label>
          )}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 'var(--space-4)' }}>
            <input type="checkbox" checked={form.isDefault}
              onChange={(e) => setForm((s) => ({ ...s, isDefault: e.target.checked }))} />
            Default warehouse
          </label>
          {editing && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={form.isActive}
                onChange={(e) => setForm((s) => ({ ...s, isActive: e.target.checked }))} />
              Active
            </label>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={create.isPending || update.isPending}>
            {(create.isPending || update.isPending) ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
};
