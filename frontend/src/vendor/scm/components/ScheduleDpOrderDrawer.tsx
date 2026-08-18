// ----------------------------------------------------------------------------
// ScheduleDpOrderDrawer — schedule a DP Order (setup / dismantle / supplier
// pickup) onto a lorry + date, minting its DP number.
//
// P0 of docs/delivery-planning-jobtypes-spec.md. The backend
// POST /dp-orders/:id/schedule has always existed (it mints the DP number and,
// when a trip is given, appends the job as a trip stop) but had NO caller, so DP
// jobs were stuck at "Pending Schedule" forever. This drawer is that caller.
//
// A lorry + trip date are REQUIRED (the plate + date mint the number). Attaching
// to an existing trip is OPTIONAL — a header-only schedule (number, no stop) is
// valid; the endpoint only writes a stop when a trip is given, and reports back
// whether that stop actually attached (never a silent failure).
//
// Mirrors NewDpOrderDrawer's chrome + the Suppliers CSS module. In-app
// NotifyDialog only.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useScheduleDpOrder,
  dpJobTypeLabel,
  type PlanningOrder,
} from '../lib/delivery-planning-queries';
import { useLorries } from '../lib/lorries-queries';
import { useTrips } from '../lib/trips-queries';
import { useNotify } from './NotifyDialog';
import styles from '../../../pages/scm-v2/Suppliers.module.css';
import { DateField } from "./DateField";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* The exact subset of a board row this drawer reads. Structural, so BOTH
   callers fit without adapters: the board passes its full PlanningOrder, and
   the /scm/dp-orders list synthesizes one from a raw dp_orders row. */
export type ScheduleDpOrderTarget = Pick<
  PlanningOrder,
  'so_doc_no' | 'dp_job_type' | 'debtor_name' | 'address'
  | 'effective_delivery_date' | 'customer_delivery_date'
>;

/* The DP order's id rides on the synthetic `DP:<id>` row key (the board stamps it
   as so_doc_no so the DataGrid has a stable rowKey) — same extraction the board's
   cancel action uses. */
const dpIdOf = (o: ScheduleDpOrderTarget): string => String(o.so_doc_no ?? '').replace(/^DP:/, '');

export const ScheduleDpOrderDrawer = ({ dpRow, onClose }: { dpRow: ScheduleDpOrderTarget; onClose: () => void }) => {
  const schedule = useScheduleDpOrder();
  const notify = useNotify();
  const { data: lorries = [] } = useLorries();

  const id = dpIdOf(dpRow);
  const [lorryId, setLorryId] = useState('');
  // Prefill the date with the job's requested/effective date when it has one.
  const [tripDate, setTripDate] = useState(
    (dpRow.effective_delivery_date ?? dpRow.customer_delivery_date ?? '').slice(0, 10),
  );
  const [tripId, setTripId] = useState('');

  /* Trips this job can be appended to: PLANNED trips for the CHOSEN lorry on the
     CHOSEN date. Attaching is optional — with none picked the endpoint still
     mints the number, just without a stop. */
  const { data: tripsResp } = useTrips(tripDate ? { from: tripDate, to: tripDate, status: 'PLANNED' } : {});
  const tripOptions = (tripsResp?.trips ?? []).filter(
    (t) => t.trip_date === tripDate && (!lorryId || t.lorry_id === lorryId),
  );

  const activeLorries = lorries.filter((l) => l.active);
  const canSubmit = !!id && !!lorryId && !!tripDate && !schedule.isPending;

  const submit = () => {
    if (!canSubmit) return;
    schedule.mutate(
      { id, lorryId, tripDate, tripId: tripId || undefined },
      {
        onSuccess: (res) => {
          if (res?.tripStop?.failed) {
            notify({
              title: `Scheduled ${res.dp_no ?? ''}`.trim(),
              body: `The job got its DP number but was NOT added to the trip: ${res.tripStop.reason ?? 'unknown error'}. Add it to the trip manually.`,
              tone: 'error',
            });
          /* A lorry service whose availability window failed to write is the
             more dangerous half-success of the two: the job looks scheduled
             while the lorry it takes in still shows as bookable that day. Say
             so, and name the manual fix. */
          } else if (res?.lorryBlocked?.failed) {
            notify({
              title: `Scheduled ${res.dp_no ?? ''}`.trim(),
              body: `The job is scheduled, but the lorry was NOT marked unavailable: ${res.lorryBlocked.reason ?? 'unknown error'}. Block it by hand in Fleet Maintenance, or the board will keep offering it that day.`,
              tone: 'error',
            });
          } else {
            notify({
              title: 'Job scheduled',
              body: res?.dp_no
                ? `${res.dp_no} is on the board${tripId ? ' and on its trip' : ' (no trip attached)'}.`
                : 'The job is scheduled.',
            });
          }
          onClose();
        },
        onError: (err) => notify({
          title: 'Schedule failed',
          body: err instanceof Error ? err.message : 'Something went wrong.',
          tone: 'error',
        }),
      },
    );
  };

  const fieldRow: CSSProperties = { display: 'block', marginBottom: 'var(--space-3)' };
  const inputStyle: CSSProperties = { width: '100%' };
  const hintStyle: CSSProperties = { textTransform: 'none', color: 'var(--c-muted, #767b6e)' };

  const jobType = dpJobTypeLabel(dpRow.dp_job_type);
  const summary = [dpRow.debtor_name, dpRow.address].filter(Boolean).join(' · ');

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>Schedule {jobType}</h2>
          <button type="button" onClick={onClose} className={styles.codeChip}><X {...ICON} /></button>
        </div>

        <div className={styles.drawerBody}>
          <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-3)', color: 'var(--c-burnt)' }}>
            {summary || 'DP Order'} — assign a lorry + date to mint its DP number
          </div>

          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Lorry</div>
            <select className={styles.searchInput} style={inputStyle}
              value={lorryId} onChange={(e) => { setLorryId(e.target.value); setTripId(''); }}>
              <option value="">Select a lorry…</option>
              {activeLorries.map((l) => <option key={l.id} value={l.id}>{l.plate}</option>)}
            </select>
          </label>

          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Trip date</div>
            <DateField
              fullWidth
              className={styles.searchInput}
              style={inputStyle}
              value={tripDate}
              onChange={(iso) => { setTripDate(iso); setTripId(''); }}
            />
          </label>

          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>
              Attach to trip <span style={hintStyle}>— optional</span>
            </div>
            <select className={styles.searchInput} style={inputStyle}
              value={tripId} onChange={(e) => setTripId(e.target.value)} disabled={!lorryId || !tripDate}>
              <option value="">No trip — schedule header only</option>
              {tripOptions.map((t) => (
                <option key={t.id} value={t.id}>{t.trip_no}{t.trip_type ? ` · ${t.trip_type}` : ''}</option>
              ))}
            </select>
            {lorryId && tripDate && tripOptions.length === 0 && (
              <div className={styles.eyebrow} style={{ marginTop: 'var(--space-1)', ...hintStyle }}>
                No planned trip for this lorry on this date — it will be scheduled without a trip.
              </div>
            )}
          </label>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={!canSubmit}>
            {schedule.isPending ? 'Scheduling…' : 'Schedule'}
          </Button>
        </div>
      </div>
    </div>
  );
};
