// ----------------------------------------------------------------------------
// Warehouses — CRUD page (PR #37). Manages physical stock locations.
//
// Default seed: KL Warehouse + 2990 PJ (from migration 0050). Add new
// warehouses here; deactivate (don't delete) when retired to preserve
// historical movements + lots.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Layers, Plus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useWarehouses,
  type Warehouse,
  type WarehouseType,
} from '../../vendor/scm/lib/inventory-queries';
import { DataGridCompat, type GridColumn } from '../../components/DataGridCompat';
import { WarehouseFormDrawer } from '../../vendor/scm/components/WarehouseFormDrawer';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* Human labels for the Type column (mig 0171). Falls back to the raw value if
   a legacy / unknown enum somehow lands here. */
const TYPE_LABELS: Record<WarehouseType, string> = {
  warehouse: 'Warehouse',
  showroom:  'Showroom',
  display:   'Display',
  service:   'Service',
  others:    'Others',
};
const typeLabel = (w: Warehouse): string =>
  w.type ? (TYPE_LABELS[w.type] ?? w.type) : (w.is_showroom ? 'Showroom' : 'Warehouse');

export const Warehouses = () => {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const warehouses = useWarehouses({ includeInactive });

  /* Shared DataGrid conversion (2026-06-12) — sort / per-column filter /
     column show-hide / reorder / pin / persisted layout. The Edit button
     stopPropagations so it never reads as a row click. */
  const columns = useMemo<GridColumn<Warehouse>[]>(() => [
    {
      key: 'code',
      label: 'Code',
      width: 100,
      accessor: (w) => <span className={styles.codeChip}>{w.code}</span>,
      searchValue: (w) => w.code,
      filterValue: (w) => w.code,
      sortFn: (a, b) => (a.code ?? '').localeCompare(b.code ?? ''),
    },
    {
      key: 'name',
      label: 'Name',
      width: 200,
      accessor: (w) => w.name,
      sortFn: (a, b) => (a.name ?? '').localeCompare(b.name ?? ''),
    },
    {
      key: 'type',
      label: 'Type',
      width: 130,
      accessor: (w) => <span className={styles.codeChip}>{typeLabel(w)}</span>,
      searchValue: (w) => typeLabel(w),
      filterValue: (w) => typeLabel(w),
      sortFn: (a, b) => typeLabel(a).localeCompare(typeLabel(b)),
    },
    {
      key: 'country',
      label: 'Country',
      width: 110,
      accessor: (w) => w.country ?? '—',
      searchValue: (w) => w.country ?? '',
      filterValue: (w) => w.country ?? '—',
      sortFn: (a, b) => (a.country ?? '').localeCompare(b.country ?? ''),
    },
    {
      key: 'state',
      label: 'State',
      width: 130,
      accessor: (w) => w.state ?? '—',
      searchValue: (w) => w.state ?? '',
      filterValue: (w) => w.state ?? '—',
      sortFn: (a, b) => (a.state ?? '').localeCompare(b.state ?? ''),
    },
    {
      key: 'location',
      label: 'Address',
      width: 220,
      accessor: (w) => {
        const line = [w.location, w.city, w.postcode].filter(Boolean).join(', ');
        return line || '—';
      },
    },
    {
      key: 'default',
      label: 'Default',
      width: 110,
      accessor: (w) => (w.is_default ? '★ Default' : '—'),
      filterValue: (w) => (w.is_default ? 'Default' : '—'),
      sortFn: (a, b) => Number(a.is_default) - Number(b.is_default),
    },
    {
      key: 'status',
      label: 'Status',
      width: 110,
      accessor: (w) => (
        <span className={`${styles.statusPill} ${w.is_active ? styles.statusActive : styles.statusInactive}`}>
          {w.is_active ? 'Active' : 'Inactive'}
        </span>
      ),
      searchValue: (w) => (w.is_active ? 'Active' : 'Inactive'),
      filterValue: (w) => (w.is_active ? 'Active' : 'Inactive'),
      sortFn: (a, b) => Number(a.is_active) - Number(b.is_active),
    },
    {
      key: 'actions',
      label: '',
      width: 80,
      align: 'right',
      sortable: false,
      groupable: false,
      accessor: (w) => (
        <span onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" onClick={() => setEditing(w)}>Edit</Button>
        </span>
      ),
      searchValue: () => '',
    },
  ], []);

  return (
    /* Page shell matches Inventory (PageHeader + space-y-4), NOT the vendored
       .page card. Owner 2026-07-18: the framed look "弄得整个看起来很丑" and
       Inventory is the reference. 68 of the /scm pages still use the vendored
       shell and 33 use this one — Warehouses moves across; the rest are a
       separate sweep, not smuggled into this diff. */
    <div className="space-y-4">
      <PageHeader
        eyebrow="Stock"
        title="Warehouses"
        actions={
          <div className={styles.actionsRow}>
            <Link to="/scm/warehouses/racks" style={{ textDecoration: 'none' }}>
              <Button variant="ghost" size="md">
                <Layers {...ICON} />
                <span>Racks &amp; Bins</span>
              </Button>
            </Link>
            <Button variant="primary" size="md" onClick={() => setCreating(true)}>
              <Plus {...ICON} />
              <span>New Warehouse</span>
            </Button>
          </div>
        }
      />

      <div className={styles.headerRow}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--fs-13)' }}>
          <input type="checkbox" checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>
      </div>

      <DataGridCompat
        rows={warehouses.data ?? []}
        columns={columns}
        storageKey="dg-warehouses"
        rowKey={(w) => w.id}
        searchPlaceholder="Search warehouses…"
        groupBanner={false}
        isLoading={warehouses.isLoading}
        emptyMessage="No warehouses yet."
      />

      {(creating || editing) && (
        <WarehouseFormDrawer
          editing={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
        />
      )}
    </div>
  );
};
