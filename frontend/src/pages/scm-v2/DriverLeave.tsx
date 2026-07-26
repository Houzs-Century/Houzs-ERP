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
import {
  useDriverLeave,
  useCreateDriverLeave,
  useDeleteDriverLeave,
} from '../../vendor/scm/lib/delivery-zones-queries';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

function todayMY(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export const DriverLeave = () => {
  const drivers = useDrivers();
  const leave = useDriverLeave();
  const createLeave = useCreateDriverLeave();
  const deleteLeave = useDeleteDriverLeave();
  const notify = useNotify();
  const askConfirm = useConfirm();

  const [driverId, setDriverId] = useState<string>('');
  const [startDate, setStartDate] = useState<string>(todayMY());
  const [endDate, setEndDate] = useState<string>(todayMY());
  const [reason, setReason] = useState<string>('');

  // Leave is an internal-driver concept only — you do not track a 3PL's drivers'
  // absences. Only in-house drivers are offered in the picker; the backend POST
  // rejects an external driver too. (Dual-read inHouse ?? in_house; only the
  // snake half resolves from /drivers, and a missing flag defaults to in-house.)
  const internalDrivers = useMemo(
    () => (drivers.data ?? []).filter((d) => (d.inHouse ?? d.in_house) !== false),
    [drivers.data],
  );

  // Name map keeps ALL drivers so any historical leave row still resolves a name
  // in the list below, even for a driver later marked external.
  const driverName = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of drivers.data ?? []) m.set(d.id, d.name);
    return m;
  }, [drivers.data]);

  const submit = () => {
    if (!driverId) { notify({ title: 'Pick a driver', body: 'Choose which driver is on leave.', tone: 'error' }); return; }
    if (startDate > endDate) { notify({ title: 'Check the dates', body: 'The start date must be on or before the end date.', tone: 'error' }); return; }
    createLeave.mutate(
      { driverId, startDate, endDate, reason: reason.trim() || null },
      {
        onSuccess: () => { setReason(''); notify({ title: 'Leave recorded', body: 'The driver will be skipped by the auto-assigner on these days.', tone: 'info' }); },
        onError: (err) => notify({ title: 'Could not record leave', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
      },
    );
  };

  const remove = async (id: string, label: string) => {
    if (!(await askConfirm({ title: 'Remove this leave?', body: `${label} — the driver becomes available for the auto-assigner again.`, confirmLabel: 'Remove' }))) return;
    deleteLeave.mutate(id, { onError: (err) => notify({ title: 'Could not remove', body: err instanceof Error ? err.message : '', tone: 'error' }) });
  };

  const rows = leave.data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Delivery"
        title="Driver Leave"
        description="Record when a driver is unavailable for delivery. The Auto-Schedule auto-assigner skips an on-leave driver on the covered days — you can still hand-pick anyone on the assignment screen."
      />

      {/* Create */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end', padding: '14px 16px', borderRadius: 10, background: 'var(--bg-subtle, rgba(0,0,0,0.03))' }}>
        <Ctl label="Driver">
          <select value={driverId} onChange={(e) => setDriverId(e.target.value)} style={{ ...selStyle, minWidth: 180 }}>
            <option value="">— pick a driver —</option>
            {internalDrivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Ctl>
        <Ctl label="From">
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={selStyle} />
        </Ctl>
        <Ctl label="To">
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={selStyle} />
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
      <div style={{ borderRadius: 10, border: '1px solid var(--border, rgba(0,0,0,0.12))', overflow: 'hidden' }}>
        {leave.isLoading ? (
          <p style={{ padding: '12px 16px', fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={{ padding: '12px 16px', fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>
            No leave recorded. Add a row above when a driver is off.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}>
                  <Th>Driver</Th><Th>From</Th><Th>To</Th><Th>Reason</Th><Th></Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ borderTop: '1px solid var(--border, rgba(0,0,0,0.06))' }}>
                    <Td><strong>{driverName.get(r.driverId) ?? r.driverId}</strong></Td>
                    <Td>{r.startDate}</Td>
                    <Td>{r.endDate}</Td>
                    <Td>{r.reason ?? '—'}</Td>
                    <Td>
                      <Button variant="ghost" size="sm" onClick={() => remove(r.id, `${driverName.get(r.driverId) ?? r.driverId} (${r.startDate}–${r.endDate})`)} disabled={deleteLeave.isPending}>
                        <Trash2 {...ICON} />
                        <span>Remove</span>
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
        <CalendarOff {...ICON} />
        <span>On-leave drivers are removed from the AUTO pick only — the dispatcher can always override on the Auto-Schedule assignment screen.</span>
      </div>
    </div>
  );
};

const Th = ({ children }: { children?: ReactNode }) => (
  <th style={{ padding: '8px 12px', fontWeight: 500 }}>{children}</th>
);
const Td = ({ children }: { children: ReactNode }) => (
  <td style={{ padding: '8px 12px' }}>{children}</td>
);
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
