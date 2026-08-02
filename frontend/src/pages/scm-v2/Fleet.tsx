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

import { useCallback, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { formatPhone } from '@2990s/shared/phone';
import {
  useDrivers,
  useCreateDriver,
  useUpdateDriver,
  type DriverRow,
} from '../../vendor/scm/lib/drivers-queries';
import {
  useHelpers,
  useCreateHelper,
  useUpdateHelper,
  type HelperRow,
} from '../../vendor/scm/lib/helpers-queries';
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
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { DATA_GRID_LAYOUT_KEYS } from '../../vendor/scm/components/dataGridLayoutKeys';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { LorryDetail } from './LorryDetail';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/** Snake-case reads with a dead camel fallback — see the header note. */
const isInternalOf = (l: LorryRow) => (l.isInternal ?? l.is_internal) !== false;
const warehouseIdOf = (l: LorryRow) => l.warehouseId ?? l.warehouse_id ?? null;
const capM3Of = (l: LorryRow) => l.capacityM3 ?? l.capacity_m3 ?? null;
const capKgOf = (l: LorryRow) => l.capacityKg ?? l.capacity_kg ?? null;

const fmtNum = (v: number | string | null): string => {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '—';
};

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
// Drivers section (logic from the former Drivers.tsx).
// ─────────────────────────────────────────────────────────────────────────────

const DriversSection = () => {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const drivers = useDrivers({ includeInactive });
  const update = useUpdateDriver();
  const notify = useNotify();

  /* This toggle used to fire and forget. When the server started refusing to
     mark a 3PL's driver in-house (409 linked_to_carrier — the row would
     otherwise carry in_house=true beside a live threepl_company_id), an
     unhandled rejection meant the tick simply sprang back with no explanation.
     Say why. */
  const updateMutate = useCallback<typeof update.mutate>((vars, opts) => {
    update.mutate(vars, {
      ...opts,
      onError: (err, ...rest) => {
        const msg = err instanceof Error ? err.message : '';
        notify(/linked_to_carrier|3PL company/i.test(msg)
          ? {
              title: 'This driver belongs to a 3PL company',
              body: 'Detach them from the carrier first, then mark them in-house.',
              tone: 'error',
            }
          : { title: 'Could not save', body: msg || 'Something went wrong.', tone: 'error' });
        opts?.onError?.(err, ...rest);
      },
    });
  }, [update, notify]);

  /* Shared DataGrid columns — sort / per-column filter / column show-hide /
     reorder / pin / persisted layout. The Active toggle stays an inline
     checkbox; stopPropagation so it never reads as a row click. IC Number ships
     default-hidden (low-value) — re-enable via the Columns popover. */
  const columns = useMemo<DataGridColumn<DriverRow>[]>(() => [
    {
      key: 'code',
      label: 'Code',
      width: 110,
      accessor: (d) => <span className={styles.codeChip}>{d.driver_code}</span>,
      searchValue: (d) => d.driver_code,
      filterValue: (d) => d.driver_code,
      sortFn: (a, b) => (a.driver_code ?? '').localeCompare(b.driver_code ?? ''),
    },
    {
      key: 'name',
      label: 'Name',
      width: 200,
      accessor: (d) => d.name,
      sortFn: (a, b) => (a.name ?? '').localeCompare(b.name ?? ''),
    },
    {
      key: 'phone',
      label: 'Phone',
      width: 160,
      accessor: (d) => formatPhone(d.phone),
    },
    {
      key: 'ic',
      label: 'IC Number',
      width: 150,
      accessor: (d) => d.ic_number ?? '—',
      defaultHidden: true,
    },
    {
      key: 'vehicle',
      label: 'Vehicle',
      width: 170,
      accessor: (d) => d.vehicle ?? '—',
    },
    {
      // EDITABLE, not a label. The retired /scm/drivers page (Drivers.tsx) grew
      // an inline In-house/Outsource checkbox on 2026-07-01 (1521453) — three
      // days AFTER this merged page was ported (2d57c45, 2026-06-28) — and the
      // commit touched only that file, so this column stayed a read-only <span>
      // and was the ONE thing the old page could do that Fleet could not. Ported
      // here BEFORE unmounting it; the backend already accepted the write
      // (scm/routes/drivers.ts:91 maps body.inHouse → in_house). Kept under the
      // 'fleet' key so an existing dg-drivers saved layout still resolves it.
      // stopPropagation so the toggle never reads as a row click.
      key: 'fleet',
      label: 'Fleet',
      width: 130,
      accessor: (d) => {
        const inHouse = (d.inHouse ?? d.in_house) !== false;
        return (
          <label
            onClick={(e) => e.stopPropagation()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
          >
            <input type="checkbox" checked={inHouse}
              onChange={(e) => updateMutate({ id: d.id, inHouse: e.target.checked })} />
            <span style={{ fontSize: 'var(--fs-12)', color: inHouse ? 'var(--fg-muted)' : 'var(--c-secondary-a)' }}>
              {inHouse ? 'In-house' : 'Outsource'}
            </span>
          </label>
        );
      },
      searchValue: (d) => ((d.inHouse ?? d.in_house) !== false ? 'In-house' : 'Outsource'),
      filterValue: (d) => ((d.inHouse ?? d.in_house) !== false ? 'In-house' : 'Outsource'),
      sortFn: (a, b) => Number((a.inHouse ?? a.in_house) !== false) - Number((b.inHouse ?? b.in_house) !== false),
    },
    {
      key: 'active',
      label: 'Active',
      width: 130,
      accessor: (d) => (
        <label
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
        >
          <input type="checkbox" checked={d.active}
            onChange={(e) => updateMutate({ id: d.id, active: e.target.checked })} />
          <span style={{ fontSize: 'var(--fs-12)', color: d.active ? 'var(--c-secondary-a)' : 'var(--fg-muted)' }}>
            {d.active ? 'Active' : 'Inactive'}
          </span>
        </label>
      ),
      searchValue: (d) => (d.active ? 'Active' : 'Inactive'),
      filterValue: (d) => (d.active ? 'Active' : 'Inactive'),
      sortFn: (a, b) => Number(a.active) - Number(b.active),
    },
  ], [updateMutate]);

  return (
    <section className={styles.section}>
      <div className={styles.headerRow}>
        <h2 className={styles.title}>Drivers</h2>
        <Button variant="primary" size="md" onClick={() => setCreating(true)}>
          <Plus {...ICON} />
          <span>New Driver</span>
        </Button>
      </div>

      <div className={styles.headerRow}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--fs-13)' }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          <span>Show inactive</span>
        </label>
        <p className={styles.eyebrow}>{drivers.data?.length ?? 0} drivers</p>
      </div>

      <DataGrid
        rows={drivers.data ?? []}
        columns={columns}
        storageKey={DATA_GRID_LAYOUT_KEYS.fleetDrivers}
        exportName="Drivers"
        rowKey={(d) => d.id}
        searchPlaceholder="Search code, name, phone, IC…"
        groupBanner={false}
        isLoading={drivers.isLoading}
        emptyMessage="No drivers yet."
      />

      {creating && <CreateDriverDrawer onClose={() => setCreating(false)} />}
    </section>
  );
};

const CreateDriverDrawer = ({ onClose }: { onClose: () => void }) => {
  const create = useCreateDriver();
  const notify = useNotify();
  const [form, setForm] = useState({
    driverCode: '', name: '', phone: '', icNumber: '', vehicle: '',
  });
  const [inHouse, setInHouse] = useState(true);
  const set = <K extends keyof typeof form>(k: K, v: string) => setForm((s) => ({ ...s, [k]: v }));

  const submit = () => {
    if (!form.driverCode.trim()) { notify({ title: 'Code required.', tone: 'error' }); return; }
    if (!form.name.trim()) { notify({ title: 'Name required.', tone: 'error' }); return; }
    if (!form.phone.trim()) { notify({ title: 'Phone required.', tone: 'error' }); return; }
    create.mutate({
      driverCode: form.driverCode.trim(),
      name: form.name.trim(),
      phone: form.phone.trim(),
      icNumber: form.icNumber.trim() || undefined,
      vehicle: form.vehicle.trim() || undefined,
      inHouse,
      active: true,
    }, { onSuccess: onClose });
  };

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <aside className={styles.drawer}>
        <header className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>New Driver</h2>
          <button type="button" className={styles.iconBtn} onClick={onClose}><X {...ICON} /></button>
        </header>
        <div className={styles.drawerBody}>
          <div className={styles.formGrid}>
            <Field label="Code *" value={form.driverCode} onChange={(v) => set('driverCode', v)} placeholder="DRV-01" />
            <Field label="Name *" value={form.name} onChange={(v) => set('name', v)} />
            <Field label="Phone *" value={form.phone} onChange={(v) => set('phone', v)} placeholder="+60 12-345-6789" />
            <Field label="IC Number" value={form.icNumber} onChange={(v) => set('icNumber', v)} />
            <Field label="Vehicle" value={form.vehicle} onChange={(v) => set('vehicle', v)} placeholder="e.g. Hilux WMN1234" />
            <label className={styles.field} style={{ flexDirection: 'row', alignItems: 'center', gap: 'var(--space-2)' }}>
              <input type="checkbox" checked={inHouse} onChange={(e) => setInHouse(e.target.checked)} />
              <span className={styles.fieldLabel}>In-house (uncheck for outsourced)</span>
            </label>
          </div>
        </div>
        <footer className={styles.drawerFooter}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create Driver'}
          </Button>
        </footer>
      </aside>
    </>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers section (logic from the former Helpers.tsx).
// ─────────────────────────────────────────────────────────────────────────────

const HelpersSection = () => {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const helpers = useHelpers({ includeInactive });
  const update = useUpdateHelper();
  const updateMutate = update.mutate;

  const columns = useMemo<DataGridColumn<HelperRow>[]>(() => [
    {
      key: 'code',
      label: 'Code',
      width: 110,
      accessor: (h) => <span className={styles.codeChip}>{h.helper_code}</span>,
      searchValue: (h) => h.helper_code,
      filterValue: (h) => h.helper_code,
      sortFn: (a, b) => (a.helper_code ?? '').localeCompare(b.helper_code ?? ''),
    },
    {
      key: 'name',
      label: 'Name',
      width: 200,
      accessor: (h) => h.name,
      sortFn: (a, b) => (a.name ?? '').localeCompare(b.name ?? ''),
    },
    {
      key: 'contact',
      label: 'Contact',
      width: 160,
      accessor: (h) => h.contact ?? '—',
    },
    {
      key: 'ic',
      label: 'IC Number',
      width: 150,
      accessor: (h) => h.ic_number ?? '—',
      defaultHidden: true,
    },
    {
      key: 'fleet',
      label: 'Fleet',
      width: 130,
      accessor: (h) => {
        const inHouse = (h.inHouse ?? h.in_house) !== false;
        return (
          <span style={{ fontSize: 'var(--fs-12)', color: inHouse ? 'var(--c-secondary-a)' : 'var(--fg-muted)' }}>
            {inHouse ? 'In-house' : 'Outsource'}
          </span>
        );
      },
      searchValue: (h) => ((h.inHouse ?? h.in_house) !== false ? 'In-house' : 'Outsource'),
      filterValue: (h) => ((h.inHouse ?? h.in_house) !== false ? 'In-house' : 'Outsource'),
      sortFn: (a, b) => Number((a.inHouse ?? a.in_house) !== false) - Number((b.inHouse ?? b.in_house) !== false),
    },
    {
      key: 'active',
      label: 'Active',
      width: 130,
      accessor: (h) => (
        <label
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
        >
          <input type="checkbox" checked={h.active}
            onChange={(e) => updateMutate({ id: h.id, active: e.target.checked })} />
          <span style={{ fontSize: 'var(--fs-12)', color: h.active ? 'var(--c-secondary-a)' : 'var(--fg-muted)' }}>
            {h.active ? 'Active' : 'Inactive'}
          </span>
        </label>
      ),
      searchValue: (h) => (h.active ? 'Active' : 'Inactive'),
      filterValue: (h) => (h.active ? 'Active' : 'Inactive'),
      sortFn: (a, b) => Number(a.active) - Number(b.active),
    },
  ], [updateMutate]);

  return (
    <section className={styles.section}>
      <div className={styles.headerRow}>
        <h2 className={styles.title}>Helpers</h2>
        <Button variant="primary" size="md" onClick={() => setCreating(true)}>
          <Plus {...ICON} />
          <span>New Helper</span>
        </Button>
      </div>

      <div className={styles.headerRow}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--fs-13)' }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          <span>Show inactive</span>
        </label>
        <p className={styles.eyebrow}>{helpers.data?.length ?? 0} helpers</p>
      </div>

      <DataGrid
        rows={helpers.data ?? []}
        columns={columns}
        storageKey="dg-helpers"
        exportName="Helpers"
        rowKey={(h) => h.id}
        searchPlaceholder="Search code, name, contact, IC…"
        groupBanner={false}
        isLoading={helpers.isLoading}
        emptyMessage="No helpers yet."
      />

      {creating && <CreateHelperDrawer onClose={() => setCreating(false)} />}
    </section>
  );
};

const CreateHelperDrawer = ({ onClose }: { onClose: () => void }) => {
  const create = useCreateHelper();
  const notify = useNotify();
  const [form, setForm] = useState({
    helperCode: '', name: '', contact: '', icNumber: '',
  });
  const [inHouse, setInHouse] = useState(true);
  const set = <K extends keyof typeof form>(k: K, v: string) => setForm((s) => ({ ...s, [k]: v }));

  const submit = () => {
    if (!form.helperCode.trim()) { notify({ title: 'Code required.', tone: 'error' }); return; }
    if (!form.name.trim()) { notify({ title: 'Name required.', tone: 'error' }); return; }
    create.mutate({
      helperCode: form.helperCode.trim(),
      name: form.name.trim(),
      contact: form.contact.trim() || undefined,
      icNumber: form.icNumber.trim() || undefined,
      inHouse,
      active: true,
    }, { onSuccess: onClose });
  };

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <aside className={styles.drawer}>
        <header className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>New Helper</h2>
          <button type="button" className={styles.iconBtn} onClick={onClose}><X {...ICON} /></button>
        </header>
        <div className={styles.drawerBody}>
          <div className={styles.formGrid}>
            <Field label="Code *" value={form.helperCode} onChange={(v) => set('helperCode', v)} placeholder="HLP-01" />
            <Field label="Name *" value={form.name} onChange={(v) => set('name', v)} />
            <Field label="Contact" value={form.contact} onChange={(v) => set('contact', v)} placeholder="+60 12-345-6789" />
            <Field label="IC Number" value={form.icNumber} onChange={(v) => set('icNumber', v)} />
            <label className={styles.field} style={{ flexDirection: 'row', alignItems: 'center', gap: 'var(--space-2)' }}>
              <input type="checkbox" checked={inHouse} onChange={(e) => setInHouse(e.target.checked)} />
              <span className={styles.fieldLabel}>In-house (uncheck for outsourced)</span>
            </label>
          </div>
        </div>
        <footer className={styles.drawerFooter}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create Helper'}
          </Button>
        </footer>
      </aside>
    </>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Lorries section (logic from the former Lorries.tsx — incl. the Fleet filter).
// ─────────────────────────────────────────────────────────────────────────────

const LorriesSection = () => {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [fleet, setFleet] = useState<FleetFilter>('all');
  const [creating, setCreating] = useState(false);
  /* The open lorry is held by ID, not by the row object: the row object is a
     snapshot from the list query, so holding it would leave the detail showing
     stale compliance dates after a save until the drawer was reopened. */
  const [openId, setOpenId] = useState<string | null>(null);
  const lorries = useLorries({ includeInactive, fleet });
  const warehouses = useWarehouses();
  const update = useUpdateLorry();
  const updateMutate = update.mutate;

  /* Map warehouse id → code/name for the column display. */
  const whName = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of warehouses.data ?? []) m.set(w.id, w.code || w.name);
    return m;
  }, [warehouses.data]);

  /* Re-resolved from the live list each render, so an edit in the detail is
     reflected as soon as the lorries query is invalidated. Undefined once the
     row leaves the filtered set (e.g. toggled inactive while open) — the drawer
     then unmounts rather than showing a row that is no longer in the list. */
  const openLorry = useMemo(
    () => (openId ? (lorries.data ?? []).find((l) => l.id === openId) : undefined),
    [openId, lorries.data],
  );

  const columns = useMemo<DataGridColumn<LorryRow>[]>(() => [
    {
      key: 'plate',
      label: 'Plate',
      width: 130,
      accessor: (l) => <span className={styles.codeChip}>{l.plate}</span>,
      searchValue: (l) => l.plate,
      filterValue: (l) => l.plate,
      sortFn: (a, b) => (a.plate ?? '').localeCompare(b.plate ?? ''),
    },
    {
      key: 'type',
      label: 'Type',
      width: 140,
      accessor: (l) => LORRY_TYPE_LABEL[l.type] ?? l.type,
      searchValue: (l) => LORRY_TYPE_LABEL[l.type] ?? l.type,
      filterValue: (l) => LORRY_TYPE_LABEL[l.type] ?? l.type,
      sortFn: (a, b) => (LORRY_TYPE_LABEL[a.type] ?? a.type).localeCompare(LORRY_TYPE_LABEL[b.type] ?? b.type),
    },
    {
      key: 'fleet',
      label: 'Fleet',
      width: 130,
      accessor: (l) => {
        const internal = isInternalOf(l);
        return (
          <span style={{ fontSize: 'var(--fs-12)', color: internal ? 'var(--c-secondary-a)' : 'var(--fg-muted)' }}>
            {internal ? 'In-house' : 'Outsource'}
          </span>
        );
      },
      searchValue: (l) => (isInternalOf(l) ? 'In-house' : 'Outsource'),
      filterValue: (l) => (isInternalOf(l) ? 'In-house' : 'Outsource'),
      sortFn: (a, b) => Number(isInternalOf(a)) - Number(isInternalOf(b)),
    },
    {
      key: 'warehouse',
      label: 'Home Warehouse',
      width: 160,
      accessor: (l) => {
        const id = warehouseIdOf(l);
        return id ? (whName.get(id) ?? '—') : '—';
      },
    },
    {
      key: 'capM3',
      label: 'Cap. m³',
      width: 110,
      accessor: (l) => fmtNum(capM3Of(l)),
      defaultHidden: true,
    },
    {
      key: 'capKg',
      label: 'Cap. kg',
      width: 110,
      accessor: (l) => fmtNum(capKgOf(l)),
      defaultHidden: true,
    },
    {
      key: 'active',
      label: 'Active',
      width: 130,
      accessor: (l) => (
        <label
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
        >
          <input type="checkbox" checked={l.active}
            onChange={(e) => updateMutate({ id: l.id, active: e.target.checked })} />
          <span style={{ fontSize: 'var(--fs-12)', color: l.active ? 'var(--c-secondary-a)' : 'var(--fg-muted)' }}>
            {l.active ? 'Active' : 'Inactive'}
          </span>
        </label>
      ),
      searchValue: (l) => (l.active ? 'Active' : 'Inactive'),
      filterValue: (l) => (l.active ? 'Active' : 'Inactive'),
      sortFn: (a, b) => Number(a.active) - Number(b.active),
    },
  ], [updateMutate, whName]);

  return (
    <section className={styles.section}>
      <div className={styles.headerRow}>
        <h2 className={styles.title}>Lorries</h2>
        <Button variant="primary" size="md" onClick={() => setCreating(true)}>
          <Plus {...ICON} />
          <span>New Lorry</span>
        </Button>
      </div>

      <div className={styles.headerRow}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-4)' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--fs-13)' }}>
            <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
            <span>Show inactive</span>
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--fs-13)' }}>
            <span>Fleet</span>
            <select className={styles.fieldInput} style={{ width: 'auto' }}
              value={fleet} onChange={(e) => setFleet(e.target.value as FleetFilter)}>
              <option value="all">All</option>
              <option value="internal">In-house</option>
              <option value="outsourced">Outsourced</option>
            </select>
          </label>
        </div>
        <p className={styles.eyebrow}>{lorries.data?.length ?? 0} lorries</p>
      </div>

      <DataGrid
        rows={lorries.data ?? []}
        columns={columns}
        storageKey="dg-lorries"
        exportName="Lorries"
        rowKey={(l) => l.id}
        searchPlaceholder="Search plate, type, fleet…"
        groupBanner={false}
        isLoading={lorries.isLoading}
        emptyMessage="No lorries yet."
        onRowClick={(l) => setOpenId(l.id)}
      />

      {creating && <CreateLorryDrawer onClose={() => setCreating(false)} />}
      {openLorry && <LorryDetail lorry={openLorry} onClose={() => setOpenId(null)} />}
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
      maxRevenueCenti: revRm !== null && Number.isFinite(revRm) && revRm >= 0 ? Math.round(revRm * 100) : null,
      capacityLayer,
      notes: form.notes.trim() || undefined,
      active: true,
    }, { onSuccess: onClose });
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
                  <option key={w.id} value={w.id}>{w.code || w.name}</option>
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
