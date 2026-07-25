// ----------------------------------------------------------------------------
// Delivery Residence Rules — owner-maintained CONFIG for the TMS scheduler's
// per-residence delivery rules (migration 0196 / route
// delivery-residence-rules.ts). One master editor: each residence / building
// type (Condo / Landed / Apartment / Office / Shop / Other — the SO's
// building_type values) with its service duration (shown in HOURS, stored as
// minutes), optional no-delivery time windows, and the lift-booking /
// registration access flags.
//
// The exact numbers are the OWNER's to set; the migration seeds sensible
// defaults (~1.5h / 90 min for most, 1h / 60 min for Landed) and this page is
// how the owner adjusts them later. The Phase 3 scheduler reads this table; it
// is NOT wired to any scheduler here.
//
// Mirrors the Delivery Regions master pattern (DeliveryPlanningRegions.tsx): a
// PageHeader + count + "New Type", the master's DataGrid with inline edit
// buffers committed on blur / Enter, and a create drawer.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Plus, X, Trash2, Save } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useDeliveryResidenceRules,
  useCreateDeliveryResidenceRule,
  useUpdateDeliveryResidenceRule,
  useDeleteDeliveryResidenceRule,
  durationLabel,
  hoursToMinutes,
  minutesToHours,
  type ResidenceRuleRow,
} from '../../vendor/scm/lib/delivery-residence-rules-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

// The uncommitted per-row buffer. Duration is held as an HOURS string while
// editing (what the operator types); it converts to minutes on commit.
type RowEdit = Partial<{
  buildingType: string;
  durationHours: string;
  earliestDeliveryTime: string; // "" means cleared → null
  latestDeliveryTime: string;
  notes: string;
}>;

export const DeliveryResidenceRules = () => {
  const [creating, setCreating] = useState(false);
  const rules = useDeliveryResidenceRules();
  const update = useUpdateDeliveryResidenceRule();
  const del = useDeleteDeliveryResidenceRule();
  const notify = useNotify();
  const askConfirm = useConfirm();
  const updateMutate = update.mutate;

  const [edits, setEdits] = useState<Record<string, RowEdit>>({});

  const patchField = (id: string, field: keyof RowEdit, value: string) =>
    setEdits((s) => ({ ...s, [id]: { ...s[id], [field]: value } }));

  const clearBuf = (id: string) =>
    setEdits((e) => { const next = { ...e }; delete next[id]; return next; });

  const failNotify = (err: unknown) =>
    notify({ title: 'Update failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });

  // Commit the text/number buffer for a row (building type, duration, windows,
  // notes). Toggles (flags / active) write immediately elsewhere, not here.
  const commitRow = (row: ResidenceRuleRow) => {
    const buf = edits[row.id];
    if (!buf) return;
    const patch: Parameters<typeof updateMutate>[0] = { id: row.id };

    if (buf.buildingType !== undefined) {
      const v = buf.buildingType.trim();
      if (v && v !== row.buildingType) patch.buildingType = v;
    }
    if (buf.durationHours !== undefined) {
      const mins = hoursToMinutes(buf.durationHours);
      if (mins === null) {
        notify({ title: 'Invalid duration', body: 'Enter the service time in hours (e.g. 1.5).', tone: 'error' });
        clearBuf(row.id);
        return;
      }
      if (mins !== row.serviceDurationMinutes) patch.serviceDurationMinutes = mins;
    }
    if (buf.earliestDeliveryTime !== undefined) {
      const v = buf.earliestDeliveryTime === '' ? null : buf.earliestDeliveryTime;
      if (v !== row.earliestDeliveryTime) patch.earliestDeliveryTime = v;
    }
    if (buf.latestDeliveryTime !== undefined) {
      const v = buf.latestDeliveryTime === '' ? null : buf.latestDeliveryTime;
      if (v !== row.latestDeliveryTime) patch.latestDeliveryTime = v;
    }
    if (buf.notes !== undefined) {
      const v = buf.notes.trim() === '' ? null : buf.notes.trim();
      if (v !== (row.notes ?? null)) patch.notes = v;
    }

    if (Object.keys(patch).length === 1) { clearBuf(row.id); return; }
    updateMutate(patch, { onSuccess: () => clearBuf(row.id), onError: failNotify });
  };

  const removeRow = async (row: ResidenceRuleRow) => {
    if (!(await askConfirm({
      title: `Delete residence rule "${row.buildingType}"?`,
      body: 'The scheduler will fall back to its default for this residence type. You can re-add it later.',
      confirmLabel: 'Delete',
      danger: true,
    }))) return;
    del.mutate(row.id, {
      onError: (err) => notify({ title: 'Cannot delete rule', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  const columns = useMemo<DataGridColumn<ResidenceRuleRow>[]>(() => [
    {
      key: 'buildingType',
      label: 'Residence Type',
      width: 170,
      accessor: (r) => {
        const buf = edits[r.id] ?? {};
        return (
          <input
            className={styles.fieldInput}
            value={buf.buildingType ?? r.buildingType}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => patchField(r.id, 'buildingType', e.target.value)}
            onBlur={() => commitRow(r)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRow(r); }}
          />
        );
      },
      searchValue: (r) => r.buildingType,
      filterValue: (r) => r.buildingType,
      sortFn: (a, b) => a.buildingType.localeCompare(b.buildingType),
    },
    {
      key: 'duration',
      label: 'Service (hours)',
      width: 150,
      align: 'right',
      accessor: (r) => {
        const buf = edits[r.id] ?? {};
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
            <input
              type="number"
              step="0.25"
              min="0"
              className={styles.fieldInput}
              style={{ width: 72, textAlign: 'right' }}
              value={buf.durationHours ?? minutesToHours(r.serviceDurationMinutes)}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => patchField(r.id, 'durationHours', e.target.value)}
              onBlur={() => commitRow(r)}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRow(r); }}
            />
            <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
              {durationLabel(r.serviceDurationMinutes)}
            </span>
          </span>
        );
      },
      searchValue: (r) => durationLabel(r.serviceDurationMinutes),
      sortFn: (a, b) => a.serviceDurationMinutes - b.serviceDurationMinutes,
      numberValue: (r) => r.serviceDurationMinutes,
    },
    {
      key: 'earliest',
      label: 'Earliest',
      width: 120,
      accessor: (r) => {
        const buf = edits[r.id] ?? {};
        return (
          <input
            type="time"
            className={styles.fieldInput}
            value={buf.earliestDeliveryTime ?? (r.earliestDeliveryTime ?? '')}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => patchField(r.id, 'earliestDeliveryTime', e.target.value)}
            onBlur={() => commitRow(r)}
          />
        );
      },
      searchValue: (r) => r.earliestDeliveryTime ?? '',
      sortFn: (a, b) => (a.earliestDeliveryTime ?? '').localeCompare(b.earliestDeliveryTime ?? ''),
    },
    {
      key: 'latest',
      label: 'Latest',
      width: 120,
      accessor: (r) => {
        const buf = edits[r.id] ?? {};
        return (
          <input
            type="time"
            className={styles.fieldInput}
            value={buf.latestDeliveryTime ?? (r.latestDeliveryTime ?? '')}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => patchField(r.id, 'latestDeliveryTime', e.target.value)}
            onBlur={() => commitRow(r)}
          />
        );
      },
      searchValue: (r) => r.latestDeliveryTime ?? '',
      sortFn: (a, b) => (a.latestDeliveryTime ?? '').localeCompare(b.latestDeliveryTime ?? ''),
    },
    {
      key: 'lift',
      label: 'Lift booking',
      width: 120,
      accessor: (r) => (
        <FlagToggle
          checked={r.requiresLiftBooking}
          onChange={(v) => updateMutate({ id: r.id, requiresLiftBooking: v }, { onError: failNotify })}
        />
      ),
      searchValue: (r) => (r.requiresLiftBooking ? 'Yes' : 'No'),
      filterValue: (r) => (r.requiresLiftBooking ? 'Lift required' : 'No lift'),
      sortFn: (a, b) => Number(a.requiresLiftBooking) - Number(b.requiresLiftBooking),
    },
    {
      key: 'registration',
      label: 'Registration',
      width: 120,
      accessor: (r) => (
        <FlagToggle
          checked={r.requiresRegistration}
          onChange={(v) => updateMutate({ id: r.id, requiresRegistration: v }, { onError: failNotify })}
        />
      ),
      searchValue: (r) => (r.requiresRegistration ? 'Yes' : 'No'),
      filterValue: (r) => (r.requiresRegistration ? 'Registration required' : 'No registration'),
      sortFn: (a, b) => Number(a.requiresRegistration) - Number(b.requiresRegistration),
    },
    {
      key: 'notes',
      label: 'Notes',
      width: 240,
      accessor: (r) => {
        const buf = edits[r.id] ?? {};
        return (
          <input
            className={styles.fieldInput}
            placeholder="—"
            value={buf.notes ?? (r.notes ?? '')}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => patchField(r.id, 'notes', e.target.value)}
            onBlur={() => commitRow(r)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRow(r); }}
          />
        );
      },
      searchValue: (r) => r.notes ?? '',
    },
    {
      key: 'active',
      label: 'Active',
      width: 120,
      accessor: (r) => (
        <label
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
        >
          <input type="checkbox" checked={r.isActive}
            onChange={(e) => updateMutate({ id: r.id, isActive: e.target.checked }, { onError: failNotify })} />
          <span style={{ fontSize: 'var(--fs-12)', color: r.isActive ? 'var(--c-secondary-a)' : 'var(--fg-muted)' }}>
            {r.isActive ? 'Active' : 'Inactive'}
          </span>
        </label>
      ),
      searchValue: (r) => (r.isActive ? 'Active' : 'Inactive'),
      filterValue: (r) => (r.isActive ? 'Active' : 'Inactive'),
      sortFn: (a, b) => Number(a.isActive) - Number(b.isActive),
    },
    {
      key: 'actions',
      label: '',
      width: 100,
      accessor: (r) => {
        const dirty = !!edits[r.id];
        return (
          <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', gap: 4 }}>
            {dirty && (
              <button type="button" className={styles.iconBtn} disabled={update.isPending}
                onClick={() => commitRow(r)} aria-label="Save rule">
                <Save {...ICON} />
              </button>
            )}
            <button type="button" className={styles.iconBtn} disabled={del.isPending}
              onClick={() => removeRow(r)} aria-label="Delete rule">
              <Trash2 {...ICON} />
            </button>
          </span>
        );
      },
    },
  ], [edits, updateMutate, update.isPending, del.isPending]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Delivery"
        title="Residence Rules"
        description="Per residence type, how long a delivery takes (service duration, in hours) and any access rules — no-delivery time windows, service-lift booking, gated-community registration. The scheduler will use these; set the values to match your operation."
        actions={
          <Button variant="primary" size="md" onClick={() => setCreating(true)}>
            <Plus {...ICON} />
            <span>New Type</span>
          </Button>
        }
      />

      <div className={styles.headerRow}>
        <p className={styles.eyebrow}>{rules.data?.length ?? 0} residence types</p>
      </div>

      <DataGrid
        rows={rules.data ?? []}
        columns={columns}
        storageKey="dg-delivery-residence-rules"
        exportName="ResidenceRules"
        rowKey={(r) => r.id}
        searchPlaceholder="Search residence types…"
        groupBanner={false}
        isLoading={rules.isLoading}
        emptyMessage="No residence rules yet — add a building type (e.g. Condo, Landed) to set its service duration and access rules."
      />

      {creating && <CreateRuleDrawer onClose={() => setCreating(false)} />}
    </div>
  );
};

const FlagToggle = ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
  <label
    onClick={(e) => e.stopPropagation()}
    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
  >
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span style={{ fontSize: 'var(--fs-12)', color: checked ? 'var(--c-secondary-a)' : 'var(--fg-muted)' }}>
      {checked ? 'Required' : 'No'}
    </span>
  </label>
);

const CreateRuleDrawer = ({ onClose }: { onClose: () => void }) => {
  const create = useCreateDeliveryResidenceRule();
  const notify = useNotify();
  const [form, setForm] = useState({
    buildingType: '',
    durationHours: '1.5',
    earliestDeliveryTime: '',
    latestDeliveryTime: '',
    requiresLiftBooking: false,
    requiresRegistration: false,
    notes: '',
  });
  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => setForm((s) => ({ ...s, [k]: v }));

  const submit = () => {
    if (!form.buildingType.trim()) { notify({ title: 'Residence type required.', tone: 'error' }); return; }
    const mins = hoursToMinutes(form.durationHours);
    if (mins === null) { notify({ title: 'Invalid duration', body: 'Enter the service time in hours (e.g. 1.5).', tone: 'error' }); return; }
    create.mutate({
      buildingType: form.buildingType.trim(),
      serviceDurationMinutes: mins,
      earliestDeliveryTime: form.earliestDeliveryTime || null,
      latestDeliveryTime: form.latestDeliveryTime || null,
      requiresLiftBooking: form.requiresLiftBooking,
      requiresRegistration: form.requiresRegistration,
      notes: form.notes.trim() || null,
      isActive: true,
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
          <h2 className={styles.drawerTitle}>New Residence Type</h2>
          <button type="button" className={styles.iconBtn} onClick={onClose}><X {...ICON} /></button>
        </header>
        <div className={styles.drawerBody}>
          <div className={styles.formGrid}>
            <Field label="Residence type *" value={form.buildingType} onChange={(v) => set('buildingType', v)} placeholder="e.g. Serviced Apartment" />
            <Field label="Service duration (hours)" value={form.durationHours} onChange={(v) => set('durationHours', v)} type="number" />
            <Field label="Earliest delivery" value={form.earliestDeliveryTime} onChange={(v) => set('earliestDeliveryTime', v)} type="time" />
            <Field label="Latest delivery" value={form.latestDeliveryTime} onChange={(v) => set('latestDeliveryTime', v)} type="time" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.requiresLiftBooking} onChange={(e) => set('requiresLiftBooking', e.target.checked)} />
              <span style={{ fontSize: 'var(--fs-13)' }}>Service-lift booking required</span>
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.requiresRegistration} onChange={(e) => set('requiresRegistration', e.target.checked)} />
              <span style={{ fontSize: 'var(--fs-13)' }}>Gate / guardhouse registration required</span>
            </label>
          </div>
          <label className={styles.field} style={{ marginTop: 4 }}>
            <span className={styles.fieldLabel}>Notes</span>
            <input className={styles.fieldInput} value={form.notes} placeholder="e.g. Condo: no delivery before 10:00, book lift at management office"
              onChange={(e) => set('notes', e.target.value)} />
          </label>
          <p style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', margin: 0 }}>
            Duration is stored in minutes and shown in hours (1.5h = 90 minutes). Leave the time windows blank for
            no restriction. Every value stays editable here later.
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
