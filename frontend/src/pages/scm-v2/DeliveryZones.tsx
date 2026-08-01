// ----------------------------------------------------------------------------
// Delivery Zones — owner-maintained postcode -> area-zone map (Fleet A1, mig
// 0205 / route delivery-zones.ts). Each row maps a first-two-digit Malaysian
// postcode-prefix RANGE to one of the 14 area zones (KL / PJ / KLANG / KAJANG /
// ... / PENANG / JOHOR / EAST). The auto-propose packer derives each order's
// zone from its postcode through this map.
//
// The default Malaysian map ships as DATA (zone-classify.ts) and is installed by
// the seed script; until then the classifier falls back to that same default, so
// this page shows a "using the built-in default" banner with a one-click
// "Load the default map" to make the rows editable.
//
// Mirrors the Delivery Residence Rules master pattern: PageHeader + count + a
// create drawer, DataGrid with inline edit buffers committed on blur / Enter.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Plus, X, Trash2, Save } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useZoneMap,
  useCreateZoneRule,
  useUpdateZoneRule,
  useDeleteZoneRule,
  type ZoneRuleRow,
} from '../../vendor/scm/lib/delivery-zones-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const pad2 = (n: number) => String(n).padStart(2, '0');

type RowEdit = Partial<{ zone: string; prefixStart: string; prefixEnd: string; label: string }>;

export const DeliveryZones = ({ embedded = false }: { embedded?: boolean } = {}) => {
  const [creating, setCreating] = useState(false);
  const map = useZoneMap();
  const create = useCreateZoneRule();
  const update = useUpdateZoneRule();
  const del = useDeleteZoneRule();
  const notify = useNotify();
  const askConfirm = useConfirm();
  const updateMutate = update.mutate;

  const knownZones = map.data?.knownZones ?? [];
  const rows = map.data?.zones ?? [];
  const usingDefault = map.data?.usingDefault ?? false;

  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const patchField = (id: string, field: keyof RowEdit, value: string) =>
    setEdits((s) => ({ ...s, [id]: { ...s[id], [field]: value } }));
  const clearBuf = (id: string) =>
    setEdits((e) => { const next = { ...e }; delete next[id]; return next; });

  const failNotify = (err: unknown) =>
    notify({ title: 'Update failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });

  const parsePrefix = (v: string): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 99 ? n : null;
  };

  const commitRow = (row: ZoneRuleRow) => {
    const buf = edits[row.id];
    if (!buf) return;
    const patch: Parameters<typeof updateMutate>[0] = { id: row.id };
    if (buf.zone !== undefined) {
      const v = buf.zone.trim().toUpperCase();
      if (v && v !== row.zone) patch.zone = v;
    }
    if (buf.prefixStart !== undefined) {
      const n = parsePrefix(buf.prefixStart);
      if (n === null) { notify({ title: 'Invalid prefix', body: 'Prefix must be 0–99 (the first two digits of a postcode).', tone: 'error' }); clearBuf(row.id); return; }
      if (n !== row.prefixStart) patch.prefixStart = n;
    }
    if (buf.prefixEnd !== undefined) {
      const n = parsePrefix(buf.prefixEnd);
      if (n === null) { notify({ title: 'Invalid prefix', body: 'Prefix must be 0–99 (the first two digits of a postcode).', tone: 'error' }); clearBuf(row.id); return; }
      if (n !== row.prefixEnd) patch.prefixEnd = n;
    }
    if (buf.label !== undefined) {
      const v = buf.label.trim() === '' ? null : buf.label.trim();
      if (v !== (row.label ?? null)) patch.label = v;
    }
    if (Object.keys(patch).length === 1) { clearBuf(row.id); return; }
    updateMutate(patch, { onSuccess: () => clearBuf(row.id), onError: failNotify });
  };

  const removeRow = async (row: ZoneRuleRow) => {
    if (!(await askConfirm({
      title: `Delete zone rule ${row.zone} (${pad2(row.prefixStart)}–${pad2(row.prefixEnd)})?`,
      body: 'Postcodes in this range will fall back to the built-in default map (or become unzoned). You can re-add it later.',
      confirmLabel: 'Delete', danger: true,
    }))) return;
    del.mutate(row.id, { onError: (err) => notify({ title: 'Cannot delete rule', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }) });
  };

  const loadDefaults = async () => {
    const defs = map.data?.defaultMap ?? [];
    if (defs.length === 0) return;
    if (!(await askConfirm({
      title: `Load the default Malaysian map (${defs.length} rules)?`,
      body: 'Adds the built-in postcode ranges as editable rows. Existing rows are left untouched.',
      confirmLabel: 'Load defaults',
    }))) return;
    for (const d of defs) {
      // Sequential to keep the invalidation cheap; the set is small (18).
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => create.mutate(
        { zone: d.zone, prefixStart: d.prefixStart, prefixEnd: d.prefixEnd },
        { onSettled: () => resolve() },
      ));
    }
  };

  const columns = useMemo<DataGridColumn<ZoneRuleRow>[]>(() => [
    {
      key: 'zone', label: 'Zone', width: 150,
      accessor: (r) => {
        const buf = edits[r.id] ?? {};
        return (
          <select
            className={styles.fieldInput}
            value={buf.zone ?? r.zone}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => { patchField(r.id, 'zone', e.target.value); }}
            onBlur={() => commitRow(r)}
          >
            {!knownZones.includes(r.zone) && <option value={r.zone}>{r.zone}</option>}
            {knownZones.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        );
      },
      searchValue: (r) => r.zone,
      filterValue: (r) => r.zone,
      sortFn: (a, b) => a.zone.localeCompare(b.zone),
    },
    {
      key: 'prefixStart', label: 'Prefix from', width: 120, align: 'right',
      accessor: (r) => {
        const buf = edits[r.id] ?? {};
        return (
          <input type="number" min="0" max="99" className={styles.fieldInput} style={{ width: 72, textAlign: 'right' }}
            value={buf.prefixStart ?? pad2(r.prefixStart)}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => patchField(r.id, 'prefixStart', e.target.value)}
            onBlur={() => commitRow(r)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRow(r); }} />
        );
      },
      numberValue: (r) => r.prefixStart,
      sortFn: (a, b) => a.prefixStart - b.prefixStart,
    },
    {
      key: 'prefixEnd', label: 'Prefix to', width: 120, align: 'right',
      accessor: (r) => {
        const buf = edits[r.id] ?? {};
        return (
          <input type="number" min="0" max="99" className={styles.fieldInput} style={{ width: 72, textAlign: 'right' }}
            value={buf.prefixEnd ?? pad2(r.prefixEnd)}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => patchField(r.id, 'prefixEnd', e.target.value)}
            onBlur={() => commitRow(r)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRow(r); }} />
        );
      },
      numberValue: (r) => r.prefixEnd,
      sortFn: (a, b) => a.prefixEnd - b.prefixEnd,
    },
    {
      key: 'example', label: 'Covers', width: 150,
      accessor: (r) => (
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          {pad2(r.prefixStart)}000–{pad2(r.prefixEnd)}999
        </span>
      ),
      searchValue: (r) => `${pad2(r.prefixStart)} ${pad2(r.prefixEnd)}`,
    },
    {
      key: 'label', label: 'Label', width: 200,
      accessor: (r) => {
        const buf = edits[r.id] ?? {};
        return (
          <input className={styles.fieldInput} placeholder="—"
            value={buf.label ?? (r.label ?? '')}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => patchField(r.id, 'label', e.target.value)}
            onBlur={() => commitRow(r)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRow(r); }} />
        );
      },
      searchValue: (r) => r.label ?? '',
    },
    {
      key: 'active', label: 'Active', width: 110,
      accessor: (r) => (
        <label onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={r.isActive} onChange={(e) => updateMutate({ id: r.id, isActive: e.target.checked }, { onError: failNotify })} />
          <span style={{ fontSize: 'var(--fs-12)', color: r.isActive ? 'var(--c-secondary-a)' : 'var(--fg-muted)' }}>{r.isActive ? 'Active' : 'Inactive'}</span>
        </label>
      ),
      searchValue: (r) => (r.isActive ? 'Active' : 'Inactive'),
      filterValue: (r) => (r.isActive ? 'Active' : 'Inactive'),
      sortFn: (a, b) => Number(a.isActive) - Number(b.isActive),
    },
    {
      key: 'actions', label: '', width: 90,
      accessor: (r) => {
        const dirty = !!edits[r.id];
        return (
          <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', gap: 4 }}>
            {dirty && (
              <button type="button" className={styles.iconBtn} disabled={update.isPending} onClick={() => commitRow(r)} aria-label="Save rule">
                <Save {...ICON} />
              </button>
            )}
            <button type="button" className={styles.iconBtn} disabled={del.isPending} onClick={() => removeRow(r)} aria-label="Delete rule">
              <Trash2 {...ICON} />
            </button>
          </span>
        );
      },
    },
  ], [edits, updateMutate, update.isPending, del.isPending, knownZones]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      {!embedded && (
        <PageHeader
          eyebrow="Delivery"
          title="Delivery Zones"
          description="Map Malaysian postcode ranges to the 14 area zones the auto-scheduler clusters deliveries by. A rule maps the first two digits of a postcode (e.g. 43 = Kajang, 10–14 = Penang). The most specific matching range wins, so you can carve a finer zone (e.g. Puchong out of the 46–47 PJ block) without deleting the broad rule."
          actions={
            <Button variant="primary" size="md" onClick={() => setCreating(true)}>
              <Plus {...ICON} />
              <span>New Rule</span>
            </Button>
          }
        />
      )}

      {usingDefault && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--bg-subtle, rgba(0,0,0,0.04))', fontSize: 'var(--fs-13)' }}>
          No custom zone rules yet — classification is using the built-in default Malaysian map.{' '}
          <button type="button" onClick={loadDefaults} disabled={create.isPending}
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--c-primary-a, #2563eb)', cursor: 'pointer', textDecoration: 'underline', font: 'inherit' }}>
            Load the default map as editable rules
          </button>
        </div>
      )}

      <div className={styles.headerRow}>
        <p className={styles.eyebrow}>{rows.length} zone rules</p>
      </div>

      <DataGrid
        rows={rows}
        columns={columns}
        storageKey="dg-delivery-zones"
        exportName="DeliveryZones"
        rowKey={(r) => r.id}
        searchPlaceholder="Search zones…"
        groupBanner={false}
        isLoading={map.isLoading}
        emptyMessage="No zone rules yet — add one, or load the default Malaysian map above."
      />

      {creating && <CreateZoneDrawer knownZones={knownZones} onClose={() => setCreating(false)} />}
    </div>
  );
};

const CreateZoneDrawer = ({ knownZones, onClose }: { knownZones: string[]; onClose: () => void }) => {
  const create = useCreateZoneRule();
  const notify = useNotify();
  const [form, setForm] = useState({ zone: knownZones[0] ?? 'KL', prefixStart: '', prefixEnd: '', label: '' });
  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => setForm((s) => ({ ...s, [k]: v }));

  const submit = () => {
    const start = Number(form.prefixStart);
    const end = Number(form.prefixEnd === '' ? form.prefixStart : form.prefixEnd);
    if (!form.zone) { notify({ title: 'Zone required.', tone: 'error' }); return; }
    if (!Number.isInteger(start) || start < 0 || start > 99) { notify({ title: 'Invalid prefix', body: 'Prefix from must be 0–99.', tone: 'error' }); return; }
    if (!Number.isInteger(end) || end < 0 || end > 99 || end < start) { notify({ title: 'Invalid prefix', body: 'Prefix to must be 0–99 and >= prefix from.', tone: 'error' }); return; }
    create.mutate(
      { zone: form.zone, prefixStart: start, prefixEnd: end, label: form.label.trim() || null },
      { onSuccess: onClose, onError: (err) => notify({ title: 'Create failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }) },
    );
  };

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <aside className={styles.drawer}>
        <header className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>New Zone Rule</h2>
          <button type="button" className={styles.iconBtn} onClick={onClose}><X {...ICON} /></button>
        </header>
        <div className={styles.drawerBody}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Zone *</span>
            <select className={styles.fieldInput} value={form.zone} onChange={(e) => set('zone', e.target.value)}>
              {knownZones.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </label>
          <div className={styles.formGrid}>
            <Field label="Prefix from (00–99) *" value={form.prefixStart} onChange={(v) => set('prefixStart', v)} type="number" placeholder="e.g. 43" />
            <Field label="Prefix to (blank = same)" value={form.prefixEnd} onChange={(v) => set('prefixEnd', v)} type="number" placeholder="e.g. 43" />
          </div>
          <Field label="Label" value={form.label} onChange={(v) => set('label', v)} placeholder="e.g. Kajang / Semenyih" />
          <p style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', margin: 0 }}>
            The prefix is the first two digits of the 5-digit postcode. A single-prefix rule (e.g. 68) uses the same value for both ends.
            When two rules overlap, the narrower range wins.
          </p>
        </div>
        <footer className={styles.drawerFooter}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create Rule'}
          </Button>
        </footer>
      </aside>
    </>
  );
};

const Field = ({ label, value, onChange, placeholder, type }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) => (
  <label className={styles.field}>
    <span className={styles.fieldLabel}>{label}</span>
    <input className={styles.fieldInput} value={value} placeholder={placeholder} type={type} onChange={(e) => onChange(e.target.value)} />
  </label>
);
