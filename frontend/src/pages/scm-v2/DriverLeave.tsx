// ----------------------------------------------------------------------------
// Driver Leave — Fleet Module A3. The small master where the dispatcher records
// a driver's date-ranged absence (MC, annual leave, ...). The Auto-Schedule
// auto-assigner reads these rows and skips an on-leave driver on the covered
// days — the driver half of the A3 constraints (the lorry half is Module B's
// maintenance status, already folded into assignment).
//
// There is no structured HR leave/attendance source in this ERP, so this page +
// scm.driver_leave (mig 0206) is it. Route /scm/driver-leave, nav "Driver Leave"
// under Transportation. Mirrors the Residence Rules / Delivery Zones masters.
// ----------------------------------------------------------------------------

import { useMemo, useState, type ReactNode, type CSSProperties } from 'react';
import { Button } from '@2990s/design-system';
import { CalendarOff, Plus, Trash2 } from 'lucide-react';
import { PageHeader } from '../../components/Layout';
import { useDrivers } from '../../vendor/scm/lib/drivers-queries';
import { useHelpers } from '../../vendor/scm/lib/helpers-queries';
import {
  useDriverLeave,
  useCreateDriverLeave,
  useDeleteDriverLeave,
  type DriverLeaveRow,
} from '../../vendor/scm/lib/delivery-zones-queries';
import { DataTable, type Column } from '../../components/DataTable';
import { fmtDate } from '@2990s/shared';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { DateField } from "../../vendor/scm/components/DateField";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

function todayMY(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export const DriverLeave = () => {
  const drivers = useDrivers();
  const helpers = useHelpers();
  const leave = useDriverLeave();
  const createLeave = useCreateDriverLeave();
  const deleteLeave = useDeleteDriverLeave();
  const notify = useNotify();
  const askConfirm = useConfirm();

  // WS2: leave covers drivers AND helpers (storekeepers are in the helper list).
  const [crewKind, setCrewKind] = useState<'driver' | 'helper'>('driver');
  const [driverId, setDriverId] = useState<string>('');
  const [helperId, setHelperId] = useState<string>('');
  const [startDate, setStartDate] = useState<string>(todayMY());
  const [endDate, setEndDate] = useState<string>(todayMY());
  const [reason, setReason] = useState<string>('');

  // Leave is an internal-crew concept only — you do not track a 3PL's crew's
  // absences. Only in-house drivers are offered in the picker; the backend POST
  // rejects an external driver too. Helpers have no external case yet (all
  // internal today — see mig 0208), so every active helper is offered.
  const internalDrivers = useMemo(
    () => (drivers.data ?? []).filter((d) => (d.inHouse ?? d.in_house) !== false),
    [drivers.data],
  );
  const activeHelpers = useMemo(
    () => (helpers.data ?? []).filter((h) => h.active !== false),
    [helpers.data],
  );

  // Name maps keep ALL drivers/helpers so any historical leave row still resolves
  // a name in the list below, even for one later deactivated.
  const driverName = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of drivers.data ?? []) m.set(d.id, d.name);
    return m;
  }, [drivers.data]);
  const helperName = useMemo(() => {
    const m = new Map<string, string>();
    for (const h of helpers.data ?? []) m.set(h.id, h.name);
    return m;
  }, [helpers.data]);

  // Resolve a leave row to "who" + a driver/helper tag.
  const crewOf = (r: { driverId: string | null; helperId: string | null }): { kind: 'Driver' | 'Helper'; name: string } =>
    r.helperId
      ? { kind: 'Helper', name: helperName.get(r.helperId) ?? r.helperId }
      : { kind: 'Driver', name: driverName.get(r.driverId ?? '') ?? (r.driverId ?? '') };

  const submit = () => {
    if (crewKind === 'driver' && !driverId) { notify({ title: 'Pick a driver', body: 'Choose which driver is on leave.', tone: 'error' }); return; }
    if (crewKind === 'helper' && !helperId) { notify({ title: 'Pick a helper', body: 'Choose which helper is on leave.', tone: 'error' }); return; }
    if (startDate > endDate) { notify({ title: 'Check the dates', body: 'The start date must be on or before the end date.', tone: 'error' }); return; }
    const body = crewKind === 'driver'
      ? { driverId, startDate, endDate, reason: reason.trim() || null }
      : { helperId, startDate, endDate, reason: reason.trim() || null };
    createLeave.mutate(body, {
      onSuccess: () => { setReason(''); notify({ title: 'Leave recorded', body: `The ${crewKind} will be skipped by the auto-assigner on these days.`, tone: 'info' }); },
      onError: (err) => notify({ title: 'Could not record leave', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  const remove = async (id: string, label: string) => {
    if (!(await askConfirm({ title: 'Remove this leave?', body: `${label} — they become available for the auto-assigner again.`, confirmLabel: 'Remove' }))) return;
    deleteLeave.mutate(id, { onError: (err) => notify({ title: 'Could not remove', body: err instanceof Error ? err.message : '', tone: 'error' }) });
  };

  const rows = leave.data ?? [];
  const columns: Column<DriverLeaveRow>[] = [
    {
      key: 'type', label: 'Type',
      render: (r) => <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>{crewOf(r).kind}</span>,
      getValue: (r) => crewOf(r).kind,
    },
    { key: 'name', label: 'Name', render: (r) => <strong>{crewOf(r).name}</strong>, getValue: (r) => crewOf(r).name },
    { key: 'from', label: 'From', render: (r) => fmtDate(r.startDate), getValue: (r) => r.startDate, exportFormat: 'date' },
    { key: 'to', label: 'To', render: (r) => fmtDate(r.endDate), getValue: (r) => r.endDate, exportFormat: 'date' },
    { key: 'reason', label: 'Reason', render: (r) => r.reason ?? '—', getValue: (r) => r.reason ?? '' },
    {
      key: 'actions', label: '', exportLabel: 'Actions',
      render: (r) => (
        <Button variant="ghost" size="sm" onClick={() => remove(r.id, `${crewOf(r).name} (${r.startDate}–${r.endDate})`)} disabled={deleteLeave.isPending}>
          <Trash2 {...ICON} />
          <span>Remove</span>
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Delivery"
        title="Crew Leave"
        description="Record when a driver or helper is unavailable for delivery. On the covered days the Auto-Schedule assigner will not crew them, and the trip assignment pickers flag them as on leave — you can still hand-pick anyone, the flag is a warning, not a block."
      />

      {/* Create */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end', padding: '14px 16px', borderRadius: 10, background: 'var(--bg-subtle, rgba(0,0,0,0.03))' }}>
        <Ctl label="Who">
          <select value={crewKind} onChange={(e) => setCrewKind(e.target.value as 'driver' | 'helper')} style={{ ...selStyle, minWidth: 110 }}>
            <option value="driver">Driver</option>
            <option value="helper">Helper</option>
          </select>
        </Ctl>
        {crewKind === 'driver' ? (
          <Ctl label="Driver">
            <select value={driverId} onChange={(e) => setDriverId(e.target.value)} style={{ ...selStyle, minWidth: 180 }}>
              <option value="">— pick a driver —</option>
              {internalDrivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Ctl>
        ) : (
          <Ctl label="Helper">
            <select value={helperId} onChange={(e) => setHelperId(e.target.value)} style={{ ...selStyle, minWidth: 180 }}>
              <option value="">— pick a helper —</option>
              {activeHelpers.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </Ctl>
        )}
        <Ctl label="From">
          <DateField value={startDate} onChange={(iso) => setStartDate(iso)} style={selStyle}/>
        </Ctl>
        <Ctl label="To">
          <DateField value={endDate} onChange={(iso) => setEndDate(iso)} style={selStyle}/>
        </Ctl>
        <Ctl label="Reason (optional)">
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="MC, annual leave…" style={{ ...selStyle, width: 200 }} />
        </Ctl>
        <Button variant="primary" size="md" onClick={submit} disabled={createLeave.isPending}>
          <Plus {...ICON} />
          <span>{createLeave.isPending ? 'Saving…' : 'Record leave'}</span>
        </Button>
      </div>

      {/* List */}
      <DataTable<DriverLeaveRow>
        tableId="driver-leave"
        exportName="driver-leave"
        exportXlsx
        columns={columns}
        rows={leave.data ? rows : null}
        loading={leave.isLoading}
        error={leave.isError ? 'The leave list did not load.' : null}
        emptyLabel="No leave recorded. Add a row above when a driver or helper is off."
        getRowKey={(r) => r.id}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
        <CalendarOff {...ICON} />
        <span>On the covered days the auto-assigner will not crew them, and every trip assignment picker shows them marked "on leave" with the reason — the dispatcher can still override.</span>
      </div>
    </div>
  );
};

const Ctl = ({ label, children }: { label: string; children: ReactNode }) => (
  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>{label}</span>
    {children}
  </label>
);
const selStyle: CSSProperties = {
  padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border, rgba(0,0,0,0.2))',
  background: 'var(--bg, #fff)', color: 'var(--fg, inherit)', fontSize: 'var(--fs-13)',
};

export default DriverLeave;
