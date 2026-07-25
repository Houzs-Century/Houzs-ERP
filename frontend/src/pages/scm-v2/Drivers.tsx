// ----------------------------------------------------------------------------
// Drivers — CRUD page. Replaces free-text driver names on DOs with a proper
// master list. Inline edit + add-new drawer. Inactive drivers can be toggled
// back on without losing history (the FK on DO is ON DELETE SET NULL).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { formatPhone } from '@2990s/shared/phone';
import {
  useDrivers,
  useCreateDriver,
  useUpdateDriver,
  type DriverRow,
} from '../../vendor/scm/lib/drivers-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { DATA_GRID_LAYOUT_KEYS } from '../../vendor/scm/components/dataGridLayoutKeys';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './Suppliers.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

export const Drivers = () => {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const drivers = useDrivers({ includeInactive });
  const update = useUpdateDriver();
  const updateMutate = update.mutate;

  /* Shared DataGrid conversion (2026-06-12) — sort / per-column filter /
     column show-hide / reorder / pin / persisted layout. The Active toggle
     stays an inline checkbox; stopPropagation so it never reads as a row
     click. IC Number ships default-hidden (low-value) — re-enable via the
     Columns popover. */
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
      // Migration 0195 — in-house company driver vs outsourced/3rd-party.
      // Checked = In-house; uncheck to mark the driver as Outsource. Mirrors
      // the Fleet page's in-house handling for lorries/helpers. stopPropagation
      // so the toggle never reads as a row click.
      key: 'type',
      label: 'Type',
      width: 150,
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
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Drivers</h1>
        </div>
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
        storageKey={DATA_GRID_LAYOUT_KEYS.driversStandalone}
        rowKey={(d) => d.id}
        searchPlaceholder="Search code, name, phone, IC, vehicle…"
        groupBanner={false}
        isLoading={drivers.isLoading}
        emptyMessage="No drivers yet."
      />

      {creating && <CreateDriverDrawer onClose={() => setCreating(false)} />}
    </div>
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
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Type</span>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 'var(--fs-13)' }}>
                <input type="checkbox" checked={inHouse} onChange={(e) => setInHouse(e.target.checked)} />
                <span>{inHouse ? 'In-house' : 'Outsource'} (uncheck for outsourced)</span>
              </label>
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
