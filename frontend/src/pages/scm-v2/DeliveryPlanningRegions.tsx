// ----------------------------------------------------------------------------
// Delivery Planning Regions — the owner-maintained MASTER for the Delivery
// Planning board's region tabs (migration 0053 / route
// delivery-planning-regions.ts). One simple master editor: list the region
// buckets (Code · Name · Sort · Active) with create / edit-in-place / delete.
//
// The live buckets are the owner-maintained geographic regions (KL/SEL /
// Northern / Southern / East Coast / East Malaysia); the owner adds more here and
// they show up automatically as tabs on Delivery Planning (the board reads this
// master).
// Per-state → region(s) assignment lives in SO Maintenance (the multi-select),
// not here — this page only owns the bucket list itself.
//
// Mirrors the Fleet master pattern: a header (title + count + "New Region"),
// the master's DataGrid, and a create drawer. Delete guards the 409
// region_in_use (a state still maps to it) via the in-app NotifyDialog.
// Dual-read camelCase throughout (the pg driver camelCases result cols).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Plus, X, Trash2, Save } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useDeliveryPlanningRegions,
  useCreateDeliveryPlanningRegion,
  useUpdateDeliveryPlanningRegion,
  useDeleteDeliveryPlanningRegion,
  useStateDeliveryRegions,
  sortOrderOf,
  type RegionMasterRow,
} from '../../vendor/scm/lib/delivery-planning-regions-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

export const DeliveryPlanningRegions = ({ embedded = false }: { embedded?: boolean } = {}) => {
  const [creating, setCreating] = useState(false);
  const regions = useDeliveryPlanningRegions();
  const update = useUpdateDeliveryPlanningRegion();
  const del = useDeleteDeliveryPlanningRegion();
  const notify = useNotify();
  const askConfirm = useConfirm();
  const updateMutate = update.mutate;

  /* Read-only "Areas" column: which states fall under each region, derived LIVE
     from the state→region mapping (state_delivery_regions) — so it can never
     drift from the actual routing. Spelling variants (WP KL, Melaka/Malacca,
     Penang/Pulau Pinang, WP Labuan) collapse to one human label so the cell reads
     cleanly. The mapping itself is edited in SO Maintenance, not here. */
  const stateRegions = useStateDeliveryRegions();
  const areasByCode = useMemo<Record<string, string[]>>(() => {
    const AREA_LABEL: Record<string, string> = {
      'kuala lumpur': 'Kuala Lumpur', 'wp kuala lumpur': 'Kuala Lumpur', 'w p kuala lumpur': 'Kuala Lumpur',
      'pulau pinang': 'Penang', 'penang': 'Penang',
      'melaka': 'Melaka', 'malacca': 'Melaka',
      'labuan': 'Labuan', 'wp labuan': 'Labuan', 'w p labuan': 'Labuan',
    };
    const pretty = (s: string) => {
      const k = s.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
      return AREA_LABEL[k] ?? s;
    };
    const byCode: Record<string, Set<string>> = {};
    for (const s of stateRegions.data ?? []) {
      for (const code of s.regionCodes) {
        (byCode[code] ??= new Set<string>()).add(pretty(s.stateKey));
      }
    }
    const out: Record<string, string[]> = {};
    for (const [code, set] of Object.entries(byCode)) out[code] = [...set].sort();
    return out;
  }, [stateRegions.data]);

  /* Per-row uncommitted edits (name / sort_order), keyed by id — committed on
     blur / Enter / the Save affordance (matches the SO Maintenance dropdown
     edit-buffer pattern). Code is the unique key + drives the SG dashed style on
     the board, so it's edited inline too. */
  const [edits, setEdits] = useState<Record<string, Partial<{ code: string; name: string; sortOrder: number }>>>({});

  const commitRow = (row: RegionMasterRow) => {
    const buf = edits[row.id];
    if (!buf) return;
    const patch: Parameters<typeof updateMutate>[0] = { id: row.id };
    const curSort = sortOrderOf(row);
    if (buf.code !== undefined && buf.code.trim() && buf.code.trim() !== row.code) patch.code = buf.code.trim();
    if (buf.name !== undefined && buf.name.trim() && buf.name.trim() !== row.name) patch.name = buf.name.trim();
    if (buf.sortOrder !== undefined && buf.sortOrder !== curSort) patch.sortOrder = buf.sortOrder;
    const clearBuf = () => setEdits((e) => { const next = { ...e }; delete next[row.id]; return next; });
    if (Object.keys(patch).length === 1) { clearBuf(); return; }
    updateMutate(patch, {
      onSuccess: clearBuf,
      onError: (err) => notify({ title: 'Update failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  const removeRow = async (row: RegionMasterRow) => {
    if (!(await askConfirm({
      title: `Delete region "${row.name}" (${row.code})?`,
      body: 'The region disappears from the Delivery Planning tabs. Blocked if any state still maps to it.',
      confirmLabel: 'Delete',
      danger: true,
    }))) return;
    del.mutate(row.id, {
      // The route returns 409 region_in_use with a plain-language reason — surface it.
      onError: (err) => notify({ title: 'Cannot delete region', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  const columns = useMemo<DataGridColumn<RegionMasterRow>[]>(() => [
    {
      key: 'code',
      label: 'Code',
      width: 140,
      accessor: (r) => {
        const buf = edits[r.id] ?? {};
        return (
          <input
            className={styles.fieldInput}
            value={buf.code ?? r.code}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setEdits((s) => ({ ...s, [r.id]: { ...s[r.id], code: e.target.value } }))}
            onBlur={() => commitRow(r)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRow(r); }}
          />
        );
      },
      searchValue: (r) => r.code,
      filterValue: (r) => r.code,
      sortFn: (a, b) => a.code.localeCompare(b.code),
    },
    {
      key: 'name',
      label: 'Name',
      width: 220,
      accessor: (r) => {
        const buf = edits[r.id] ?? {};
        return (
          <input
            className={styles.fieldInput}
            value={buf.name ?? r.name}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setEdits((s) => ({ ...s, [r.id]: { ...s[r.id], name: e.target.value } }))}
            onBlur={() => commitRow(r)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRow(r); }}
          />
        );
      },
      searchValue: (r) => r.name,
      sortFn: (a, b) => a.name.localeCompare(b.name),
    },
    {
      key: 'areas',
      label: 'Areas',
      width: 300,
      accessor: (r) => {
        const areas = areasByCode[r.code] ?? [];
        if (areas.length === 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
        const text = areas.join(', ');
        return <span title={text} style={{ fontSize: 'var(--fs-12)' }}>{text}</span>;
      },
      searchValue: (r) => (areasByCode[r.code] ?? []).join(', '),
      filterValue: (r) => (areasByCode[r.code] ?? []).join(', '),
    },
    {
      key: 'sortOrder',
      label: 'Sort',
      width: 100,
      align: 'right',
      accessor: (r) => {
        const buf = edits[r.id] ?? {};
        return (
          <input
            type="number"
            className={styles.fieldInput}
            style={{ textAlign: 'right' }}
            value={String(buf.sortOrder ?? sortOrderOf(r))}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setEdits((s) => ({ ...s, [r.id]: { ...s[r.id], sortOrder: Number(e.target.value) } }))}
            onBlur={() => commitRow(r)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRow(r); }}
          />
        );
      },
      searchValue: (r) => String(sortOrderOf(r)),
      sortFn: (a, b) => sortOrderOf(a) - sortOrderOf(b),
      numberValue: (r) => sortOrderOf(r),
    },
    {
      key: 'active',
      label: 'Active',
      width: 130,
      accessor: (r) => (
        <label
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
        >
          <input type="checkbox" checked={r.active}
            onChange={(e) => updateMutate(
              { id: r.id, active: e.target.checked },
              { onError: (err) => notify({ title: 'Update failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }) },
            )} />
          <span style={{ fontSize: 'var(--fs-12)', color: r.active ? 'var(--c-secondary-a)' : 'var(--fg-muted)' }}>
            {r.active ? 'Active' : 'Inactive'}
          </span>
        </label>
      ),
      searchValue: (r) => (r.active ? 'Active' : 'Inactive'),
      filterValue: (r) => (r.active ? 'Active' : 'Inactive'),
      sortFn: (a, b) => Number(a.active) - Number(b.active),
    },
    {
      key: 'actions',
      label: '',
      width: 120,
      accessor: (r) => {
        const buf = edits[r.id];
        const dirty = !!buf && (
          (buf.code !== undefined && buf.code !== r.code) ||
          (buf.name !== undefined && buf.name !== r.name) ||
          (buf.sortOrder !== undefined && buf.sortOrder !== sortOrderOf(r))
        );
        return (
          <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', gap: 4 }}>
            {dirty && (
              <button type="button" className={styles.iconBtn} disabled={update.isPending}
                onClick={() => commitRow(r)} aria-label="Save region">
                <Save {...ICON} />
              </button>
            )}
            <button type="button" className={styles.iconBtn} disabled={del.isPending}
              onClick={() => removeRow(r)} aria-label="Delete region">
              <Trash2 {...ICON} />
            </button>
          </span>
        );
      },
    },
  // edits drives the inline buffers; updateMutate/del.isPending the controls.
  ], [edits, areasByCode, updateMutate, update.isPending, del.isPending]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      {!embedded && (
        <PageHeader
          eyebrow="Delivery"
          title="Delivery Regions"
          description="The region buckets (tabs) on Delivery Planning, with the areas each one covers. Assign which states fall under each region in SO Maintenance."
          actions={
            <Button variant="primary" size="md" onClick={() => setCreating(true)}>
              <Plus {...ICON} />
              <span>New Region</span>
            </Button>
          }
        />
      )}

      <div className={styles.headerRow}>
        <p className={styles.eyebrow}>{regions.data?.length ?? 0} regions</p>
      </div>

      <DataGrid
        rows={regions.data ?? []}
        columns={columns}
        storageKey="dg-delivery-planning-regions"
        exportName="DeliveryRegions"
        rowKey={(r) => r.id}
        searchPlaceholder="Search regions…"
        groupBanner={false}
        isLoading={regions.isLoading}
        emptyMessage="No regions yet — add your delivery buckets (e.g. KL/SEL / Northern / Southern) to get started."
      />

      {creating && <CreateRegionDrawer onClose={() => setCreating(false)} nextSort={(regions.data?.reduce((m, r) => Math.max(m, sortOrderOf(r)), 0) ?? 0) + 1} />}
    </div>
  );
};

const CreateRegionDrawer = ({ onClose, nextSort }: { onClose: () => void; nextSort: number }) => {
  const create = useCreateDeliveryPlanningRegion();
  const notify = useNotify();
  const [form, setForm] = useState({ code: '', name: '', sortOrder: String(nextSort) });
  const set = <K extends keyof typeof form>(k: K, v: string) => setForm((s) => ({ ...s, [k]: v }));

  const submit = () => {
    if (!form.code.trim()) { notify({ title: 'Code required.', tone: 'error' }); return; }
    if (!form.name.trim()) { notify({ title: 'Name required.', tone: 'error' }); return; }
    const sort = Number(form.sortOrder);
    create.mutate({
      code: form.code.trim(),
      name: form.name.trim(),
      sortOrder: Number.isFinite(sort) ? sort : nextSort,
      active: true,
    }, {
      onSuccess: onClose,
      onError: (err) => notify({ title: 'Create failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <aside className={styles.drawer}>
        <header className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>New Region</h2>
          <button type="button" className={styles.iconBtn} onClick={onClose}><X {...ICON} /></button>
        </header>
        <div className={styles.drawerBody}>
          <div className={styles.formGrid}>
            <Field label="Code *" value={form.code} onChange={(v) => set('code', v)} placeholder="e.g. JB" />
            <Field label="Name *" value={form.name} onChange={(v) => set('name', v)} placeholder="e.g. Johor Bahru" />
            <Field label="Sort order" value={form.sortOrder} onChange={(v) => set('sortOrder', v)} type="number" />
          </div>
          <p style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', margin: 0 }}>
            Code is normalised to upper-case and must be unique. A region with code <strong>SG</strong> gets the
            distinct dashed styling on the board.
          </p>
        </div>
        <footer className={styles.drawerFooter}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create Region'}
          </Button>
        </footer>
      </aside>
    </>
  );
};

const Field = ({
  label, value, onChange, placeholder, type,
}: {
  label: string; value: string;
  onChange: (v: string) => void; placeholder?: string; type?: string;
}) => (
  <label className={styles.field}>
    <span className={styles.fieldLabel}>{label}</span>
    <input className={styles.fieldInput} value={value} placeholder={placeholder} type={type}
      onChange={(e) => onChange(e.target.value)} />
  </label>
);
