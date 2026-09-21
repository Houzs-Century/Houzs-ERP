// ----------------------------------------------------------------------------
// WarehouseFormDrawer — shared create/edit warehouse form.
//
// Extracted from pages/scm-v2/Warehouses.tsx so the SAME form can be opened
// from more than one place (the Warehouses master page today; a Racks & Bins
// page later, which groups racks by warehouse, so creating a warehouse there
// is the natural entry point). onSaved fires after a successful create/update
// so a caller that reads warehouses from a different query can refetch.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useCreateWarehouse,
  useUpdateWarehouse,
  type Warehouse,
  type WarehouseType,
} from '../lib/inventory-queries';
import {
  useLocalities,
  distinctCountries,
  citiesInState,
  postcodesInCity,
} from '../lib/localities-queries';
import { StatePicker } from './StatePicker';
import { useNotify } from './NotifyDialog';
import styles from '../../../pages/scm-v2/Suppliers.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* Ordered for the dropdown — most-used first. Labels are the display text, the
   value is the enum literal stored in scm.warehouses.type (mig 0171). */
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
  /** Called after a successful create/update (before onClose). */
  onSaved?: () => void;
}) => {
  const create = useCreateWarehouse();
  const update = useUpdateWarehouse();
  const notify = useNotify();
  /* Derive the initial type from either the stored `type` (mig 0171) or the
     legacy is_showroom flag — a pre-migration edit still opens with a coherent
     choice. Default 'warehouse' for a fresh create. */
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

  /* Country / State / City / Postcode cascade off scm.my_localities — same
     source the SO Maintenance geo table maintains. Country picked first
     (defaults to Malaysia when unset); State picker is filtered by country;
     picking State auto-derives Country if it was blank so the operator
     doesn't have to reselect. Empty locality set (unseeded) → the state
     dropdown gracefully renders empty free-text so nothing breaks. */
  const localities = useLocalities();
  const localityRows = localities.data ?? [];
  const countries = useMemo(() => distinctCountries(localityRows), [localityRows]);
  const cities = useMemo(
    () => (form.state ? citiesInState(localityRows, form.state) : []),
    [localityRows, form.state],
  );
  const postcodes = useMemo(
    () => (form.state && form.city ? postcodesInCity(localityRows, form.state, form.city) : []),
    [localityRows, form.state, form.city],
  );

  const done = () => { onSaved?.(); onClose(); };

  const submit = () => {
    if (!form.code.trim() || !form.name.trim()) {
      notify({ title: 'Code and Name are required.', tone: 'error' });
      return;
    }
    /* Block the half-configured showroom at the point of creation. A warehouse
       classified as Showroom with no Venue name is not an error the database
       can see — it simply resolves to NO venue, so every order from every
       salesperson parked under it silently carries a blank venue. Catching it
       here, while someone is looking at the form, is the only cheap moment. */
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
        stockBucket: (form.stockBucket || null) as 'customer' | 'display' | 'service' | null,
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
        stockBucket: (form.stockBucket || null) as 'customer' | 'display' | 'service' | null,
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
          {/* ── Structured address (mig 0180 + StatePicker MVP2 2026-07-23)
              Country picked first (from seeded my_localities set — no free-
              text). State uses shared StatePicker component — MY default,
              Others expander for CN/SG, search across all. Picking State
              back-derives Country when Country was blank/mismatched. City
              + Postcode are still local cascades scoped to the picked state.
              NO `(legacy)` fallbacks — a state not in my_localities must
              first be added via the Localities Maintenance UI. */}
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
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
            <div className={styles.eyebrow}>State</div>
            <StatePicker
              country={form.country ?? ''}
              value={form.state ?? ''}
              onChange={(nextState, derivedCountry) => setForm((s) => ({
                ...s,
                state: nextState,
                country: derivedCountry ?? s.country,
                city: '',
                postcode: '',
              }))}
            />
          </label>
          {form.state && (
            <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
              <div className={styles.eyebrow}>City</div>
              <select className={styles.searchInput} style={{ width: '100%' }}
                value={form.city ?? ''}
                disabled={cities.length === 0}
                onChange={(e) => setForm((s) => ({ ...s, city: e.target.value, postcode: '' }))}
              >
                <option value="">
                  {cities.length === 0 ? 'No cities seeded for this state' : '— pick city —'}
                </option>
                {cities.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          )}
          {form.state && form.city && (
            <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
              <div className={styles.eyebrow}>Postcode</div>
              <select className={styles.searchInput} style={{ width: '100%' }}
                value={form.postcode ?? ''}
                disabled={postcodes.length === 0}
                onChange={(e) => setForm((s) => ({ ...s, postcode: e.target.value }))}
              >
                <option value="">
                  {postcodes.length === 0 ? 'No postcodes seeded for this city' : '— pick postcode —'}
                </option>
                {postcodes.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          )}
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
          {/* The closing-stock bucket (owner 2026-09-21): which of the three
              closing stocks this warehouse's goods book on at month end. Blank
              follows the type — warehouse / others → customer, showroom /
              display → display, service → service. */}
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
