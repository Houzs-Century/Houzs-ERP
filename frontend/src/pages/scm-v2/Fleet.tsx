// ----------------------------------------------------------------------------
// Fleet — consolidated "Driver & Helper" portal. ONE page that merges the three
// TMS fleet masters (Drivers · Helpers · Lorries) into a single place: three
// stacked sections, each a header (title + count + "New …" button) over the
// master's DataGrid and its own create drawer. The Lorry Capacity dashboard
// stays a separate page.
//
// Each section is a small, self-contained component that REUSES the existing
// query hooks (useDrivers/useHelpers/useLorries + create/update) and the exact
// columns, In-house/Outsource handling, and Fleet filter from 2990 — nothing
// about the CRUD or behaviour changed, only the layout (h1 → h2 section
// headers) and the co-location on one page.
//
// The `x.camelCase ?? x.snake_case` reads below are DEAD on their camel half,
// and the comment that used to sit here ("the pg driver camelCases result
// cols") was false for Houzs — it is Hookka's rule, copied in with the 2990
// port. Two independent reasons it cannot be true here: (1) Houzs deliberately
// does NOT install the camelCase transform (backend/src/db/pg.ts:5-10 — "fix
// the route, do not flip a global transform"; docs/UPGRADE-PLAN.md:105 lists
// the map as Hookka-specific, do-not-copy); (2) these rows never touch the pg
// driver anyway — they arrive over /api/scm/* from PostgREST, which returns the
// snake_case column names named in each route's COLS (backend/src/scm/routes/
// lorries.ts:20, drivers.ts:24, helpers.ts). The snake half is the ONLY half
// that ever resolves. Left in place because `?? ` costs nothing and every
// sibling SCM surface still carries the same shape; do not "restore" the claim.
// ----------------------------------------------------------------------------

import { LorriesBoard } from "./fleet/LorriesBoard";
import { DriversSection, HelpersSection } from './fleet/CrewBoard';
import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useLorries,
  useCreateLorry,
  useUpdateLorry,
  LORRY_TYPES,
  LORRY_TYPE_LABEL,
  CAPACITY_LAYERS,
  CAPACITY_LAYER_LABEL,
  type LorryRow,
  type LorryType,
  type CapacityLayer,
  type FleetFilter,
} from '../../vendor/scm/lib/lorries-queries';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { DataGridCompat, type GridColumn } from '../../components/DataGridCompat';
import { DATA_GRID_LAYOUT_KEYS } from '../../vendor/scm/components/dataGridLayoutKeys';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { LorryDetail, lorryWarehouseIds } from './LorryDetail';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';
import { warehouseLabel } from '../../vendor/scm/lib/warehouse-label';
import { writeFailedAs } from '../../vendor/scm/lib/mutation-error';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/** Snake-case reads with a dead camel fallback — see the header note. */
const isInternalOf = (l: LorryRow) => (l.isInternal ?? l.is_internal) !== false;
const capM3Of = (l: LorryRow) => l.capacityM3 ?? l.capacity_m3 ?? null;
const capKgOf = (l: LorryRow) => l.capacityKg ?? l.capacity_kg ?? null;

const fmtNum = (v: number | string | null): string => {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '—';
};

export { DriversSection, HelpersSection };

// ─────────────────────────────────────────────────────────────────────────────
// Page — three stacked sections.
// ─────────────────────────────────────────────────────────────────────────────

export const Fleet = ({ embedded = false }: { embedded?: boolean } = {}) => {
  return (
    <div className="space-y-4">
      {!embedded && (
        <PageHeader
          eyebrow="Delivery"
          title="Driver & Helper"
          description="Open and manage your drivers, helpers, and lorries."
        />
      )}

      <DriversSection />
      <HelpersSection />
      <LorriesSection />
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Lorries section (logic from the former Lorries.tsx — incl. the Fleet filter).
// ─────────────────────────────────────────────────────────────────────────────

export const LorriesSection = () => {
  const [creating, setCreating] = useState(false);
  return (
    <section className={styles.section}>
      <LorriesBoard onNew={() => setCreating(true)} />
      {creating && <CreateLorryDrawer onClose={() => setCreating(false)} />}
    </section>
  );
};

const CreateLorryDrawer = ({ onClose }: { onClose: () => void }) => {
  const create = useCreateLorry();
  const warehouses = useWarehouses();
  const notify = useNotify();
  const [form, setForm] = useState({
    plate: '', capacityM3: '', capacityKg: '', notes: '', warehouseId: '',
    maxSets: '', maxRevenueRm: '',
  });
  const [type, setType] = useState<LorryType>('LORRY_17FT');
  const [isInternal, setIsInternal] = useState(true);
  const [capacityLayer, setCapacityLayer] = useState<CapacityLayer>('SETS');
  const set = <K extends keyof typeof form>(k: K, v: string) => setForm((s) => ({ ...s, [k]: v }));

  const submit = () => {
    if (!form.plate.trim()) { notify({ title: 'Plate required.', tone: 'error' }); return; }
    const m3 = form.capacityM3.trim() ? Number(form.capacityM3) : null;
    const kg = form.capacityKg.trim() ? Number(form.capacityKg) : null;
    const sets = form.maxSets.trim() ? Number(form.maxSets) : null;
    const revRm = form.maxRevenueRm.trim() ? Number(form.maxRevenueRm) : null;
    create.mutate({
      plate: form.plate.trim(),
      type,
      isInternal,
      warehouseId: form.warehouseId || null,
      capacityM3: m3 !== null && Number.isFinite(m3) ? m3 : null,
      capacityKg: kg !== null && Number.isFinite(kg) ? kg : null,
      maxSets: sets !== null && Number.isInteger(sets) && sets >= 0 ? sets : null,
      maxRevenueSen: revRm !== null && Number.isFinite(revRm) && revRm >= 0 ? Math.round(revRm * 100) : null,
      capacityLayer,
      notes: form.notes.trim() || undefined,
      active: true,
    }, { onSuccess: onClose, onError: writeFailedAs("The lorry was not added") });
  };

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <aside className={styles.drawer}>
        <header className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>New Lorry</h2>
          <button type="button" className={styles.iconBtn} onClick={onClose}><X {...ICON} /></button>
        </header>
        <div className={styles.drawerBody}>
          <div className={styles.formGrid}>
            <Field label="Plate *" value={form.plate} onChange={(v) => set('plate', v)} placeholder="e.g. WMN1234" />
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Type</span>
              <select className={styles.fieldInput} value={type} onChange={(e) => setType(e.target.value as LorryType)}>
                {LORRY_TYPES.map((t) => (
                  <option key={t} value={t}>{LORRY_TYPE_LABEL[t]}</option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Home Warehouse</span>
              <select className={styles.fieldInput} value={form.warehouseId} onChange={(e) => set('warehouseId', e.target.value)}>
                <option value="">— None —</option>
                {(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>{warehouseLabel(w)}</option>
                ))}
              </select>
            </label>
            <Field label="Capacity (m³)" value={form.capacityM3} onChange={(v) => set('capacityM3', v)} placeholder="e.g. 14.5" />
            <Field label="Capacity (kg)" value={form.capacityKg} onChange={(v) => set('capacityKg', v)} placeholder="e.g. 3000" />
            <Field label="Max sets / trip" value={form.maxSets} onChange={(v) => set('maxSets', v)} placeholder="e.g. 10" />
            <Field label="Max revenue / trip (RM)" value={form.maxRevenueRm} onChange={(v) => set('maxRevenueRm', v)} placeholder="e.g. 30000" />
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Capacity layer</span>
              <select className={styles.fieldInput} value={capacityLayer} onChange={(e) => setCapacityLayer(e.target.value as CapacityLayer)}>
                {CAPACITY_LAYERS.map((l) => (<option key={l} value={l}>{CAPACITY_LAYER_LABEL[l]}</option>))}
              </select>
            </label>
            <Field label="Notes" value={form.notes} onChange={(v) => set('notes', v)} />
            <label className={styles.field} style={{ flexDirection: 'row', alignItems: 'center', gap: 'var(--space-2)' }}>
              <input type="checkbox" checked={isInternal} onChange={(e) => setIsInternal(e.target.checked)} />
              <span className={styles.fieldLabel}>In-house (uncheck for outsourced)</span>
            </label>
          </div>
        </div>
        <footer className={styles.drawerFooter}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create Lorry'}
          </Button>
        </footer>
      </aside>
    </>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared text field (identical across all three drawers).
// ─────────────────────────────────────────────────────────────────────────────

const Field = ({
  label, value, onChange, placeholder,
}: {
  label: string; value: string;
  onChange: (v: string) => void; placeholder?: string;
}) => (
  <label className={styles.field}>
    <span className={styles.fieldLabel}>{label}</span>
    <input className={styles.fieldInput} value={value} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)} />
  </label>
);
