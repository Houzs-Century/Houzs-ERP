// ----------------------------------------------------------------------------
// delivery-propose-ui — the propose-flow presentation pieces shared by the
// Delivery Time Arrangement page (anonymous run cards) and the Last Mile
// Delivery page (crew assignment cards), split per the owner's final division
// (2026-08-08): the Time page sequences (排单) and must not name a lorry or a
// driver; Last Mile owns the intelligent driver + lorry assignment.
//
//   - AssignTripCard / OverflowSection / AssignSelect — the CREW machinery
//     (editable lorry / driver / helper with crew-leave marks, 3PL overflow
//     with captured cost). Rendered by Last Mile ONLY.
//   - MiniBadge / Th / Td / selStyle / fmtRm — small shared chrome both pages'
//     cards use.
// ----------------------------------------------------------------------------

import type { ReactNode, CSSProperties } from 'react';
import { CalendarCheck } from 'lucide-react';
import { Button } from '../../components/Button';
import type { AssignedTrip, OverflowGroup, ThreePlCarrier } from '../../vendor/scm/lib/delivery-zones-queries';
import { findCrewLeave, crewLeaveLabel, type CrewLeaveRow } from '../../vendor/shared/crew-leave';

const ICON = { size: 14, strokeWidth: 1.75 } as const;

export type CrewOpt = { id: string; name: string };
export type LorryOpt = { id: string; plate: string };

export const fmtRm = (centi: number): string => `RM ${(centi / 100).toLocaleString('en-MY', { maximumFractionDigits: 0 })}`;

export const selStyle: CSSProperties = {
  padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border, rgba(0,0,0,0.2))',
  background: 'var(--bg, #fff)', color: 'var(--fg, inherit)', fontSize: 'var(--fs-13)',
};

export const MiniBadge = ({ tone, children }: { tone: 'warn' | 'danger'; children: ReactNode }) => (
  <span style={{
    fontSize: 'var(--fs-11)', padding: '1px 7px', borderRadius: 999,
    background: tone === 'danger' ? 'rgba(220,38,38,0.12)' : 'rgba(217,119,6,0.14)',
    color: tone === 'danger' ? 'var(--c-danger, #b91c1c)' : 'var(--c-warning, #b45309)',
  }}>{children}</span>
);

export const Th = ({ children }: { children: ReactNode }) => (
  <th style={{ padding: '6px 10px', fontWeight: 500 }}>{children}</th>
);
export const Td = ({ children, colSpan }: { children: ReactNode; colSpan?: number }) => (
  <td colSpan={colSpan} style={{ padding: '6px 10px' }}>{children}</td>
);

/* `note` marks an option without removing it — an on-leave driver stays
   selectable because the dispatcher has always had the final say. */
export const AssignSelect = ({ label, value, onChange, options, placeholder }: {
  label: string; value: string | null; onChange: (v: string | null) => void;
  options: { id: string; label: string; note?: string }[]; placeholder: string;
}) => {
  const selectedNote = options.find((o) => o.id === value)?.note;
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>{label}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} style={{ ...selStyle, minWidth: 150 }}>
        <option value="">{placeholder}</option>
        {value && !options.some((o) => o.id === value) && <option value={value}>(current)</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.note ? `${o.label} · ${o.note}` : o.label}</option>
        ))}
      </select>
      {selectedNote && (
        <span style={{ fontSize: 'var(--fs-11)', color: 'var(--c-warning, #b45309)' }}>{selectedNote}</span>
      )}
    </label>
  );
};

/* The CREW assignment card — Last Mile Delivery's "Propose crew" unit. One
   proposed run with its editable lorry / driver / helper (crew-leave marked,
   never hidden), the ordered stop table (ETA + windows) and per-run Apply. */
export const AssignTripCard = ({ trip, eff, lorries, drivers, helpers, leaveRows, onOverride, onApply, applyBusy }: {
  trip: AssignedTrip;
  eff: { lorryId: string | null; driverId: string | null; helperId: string | null };
  lorries: LorryOpt[];
  drivers: CrewOpt[];
  helpers: CrewOpt[];
  leaveRows: CrewLeaveRow[] | undefined;
  onOverride: (patch: { lorryId?: string | null; driverId?: string | null; helperId?: string | null }) => void;
  onApply: () => void;
  applyBusy: boolean;
}) => {
  const seq = trip.sequence;

  // Leave is per-DATE, and this card owns one date — so the marking is computed
  // here, not at page level.
  const driverOpts = drivers.map((d) => ({
    id: d.id, label: d.name, note: crewLeaveLabel(findCrewLeave(leaveRows, 'driver', d.id, trip.date)),
  }));
  const helperOpts = helpers.map((h) => ({
    id: h.id, label: h.name, note: crewLeaveLabel(findCrewLeave(leaveRows, 'helper', h.id, trip.date)),
  }));
  // The ordered rows to show: the sequenced route if present, else the plain stops.
  const rows = seq
    ? seq.sequence.map((s) => {
        const info = trip.stops.find((st) => st.ref === s.ref);
        return {
          ref: s.ref, order: s.order, debtorName: info?.debtorName ?? null,
          buildingType: info?.buildingType ?? null,
          arrivalTime: s.arrivalTime, finishTime: s.finishTime,
          earliestTime: s.earliestTime, latestTime: s.latestTime, windowViolated: s.windowViolated,
        };
      })
    : trip.stops.map((s, i) => ({
        ref: s.ref, order: i + 1, debtorName: s.debtorName, buildingType: s.buildingType,
        arrivalTime: null as string | null, finishTime: null as string | null,
        earliestTime: s.earliestTime, latestTime: s.latestTime, windowViolated: false,
      }));

  return (
    <div style={{ borderRadius: 10, border: '1px solid var(--border, rgba(0,0,0,0.12))', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', background: 'var(--bg-subtle, rgba(0,0,0,0.03))' }}>
        <strong style={{ fontSize: 'var(--fs-13)' }}>{trip.date}</strong>
        <span style={{ fontSize: 'var(--fs-11)', padding: '2px 8px', borderRadius: 999, background: 'var(--bg, rgba(0,0,0,0.06))' }}>
          {trip.group === 'KLANG_VALLEY' ? 'Klang Valley (mixed)' : trip.group}
        </span>
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          {trip.stops.length} stop(s) · {trip.sets} sets · {fmtRm(trip.revenueSen)}
        </span>
        {trip.overCeiling && <MiniBadge tone="danger">Over ceiling</MiniBadge>}
        {seq && seq.windowViolations > 0 && <MiniBadge tone="warn">{seq.windowViolations} window issue(s)</MiniBadge>}
        <div style={{ flex: 1 }} />
        {seq && (
          <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
            back {seq.returnTime ?? '—'} · {Math.round(seq.totalDistanceMetres / 100) / 10} km
          </span>
        )}
      </div>

      {/* Editable crew + lorry — the auto-assignment, all overridable. */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '10px 14px', borderTop: '1px solid var(--border, rgba(0,0,0,0.08))' }}>
        <AssignSelect label="Lorry" value={eff.lorryId} onChange={(v) => onOverride({ lorryId: v })}
          options={lorries.map((l) => ({ id: l.id, label: l.plate }))} placeholder="— pick a lorry —" />
        <AssignSelect label="Driver" value={eff.driverId} onChange={(v) => onOverride({ driverId: v })}
          options={driverOpts} placeholder="— none —" />
        <AssignSelect label="Helper" value={eff.helperId} onChange={(v) => onOverride({ helperId: v })}
          options={helperOpts} placeholder="— none —" />
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <Button variant="primary" icon={<CalendarCheck {...ICON} />} onClick={onApply} disabled={applyBusy || !eff.lorryId}>
            {applyBusy ? 'Applying…' : 'Apply this run'}
          </Button>
        </div>
      </div>

      {trip.routeReason && (
        <div style={{ padding: '6px 14px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', borderTop: '1px solid var(--border, rgba(0,0,0,0.06))' }}>
          {trip.routeReason}
        </div>
      )}

      {/* Ordered stops with ETA + delivery window. */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-12)' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}>
              <Th>#</Th><Th>Order</Th><Th>Customer</Th><Th>House</Th><Th>ETA</Th><Th>Done</Th><Th>Window</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ref} style={{ borderTop: '1px solid var(--border, rgba(0,0,0,0.06))' }}>
                <Td>{r.order}</Td>
                <Td><strong>{r.ref}</strong></Td>
                <Td>{r.debtorName ?? '—'}</Td>
                <Td>{r.buildingType ?? '—'}</Td>
                <Td>{r.arrivalTime ?? '—'}</Td>
                <Td>{r.finishTime ?? '—'}</Td>
                <Td>
                  {r.earliestTime || r.latestTime ? `${r.earliestTime ?? ''}–${r.latestTime ?? ''}` : 'any'}
                  {r.windowViolated && <span style={{ color: 'var(--c-warning, #b45309)' }}> !</span>}
                </Td>
              </tr>
            ))}
            {rows.length > 0 && rows.filter((r) => trip.ungeocoded.includes(r.ref)).length === 0 && trip.ungeocoded.length > 0 && (
              <tr><Td>—</Td><Td colSpan={6}>Not geocoded: {trip.ungeocoded.join(', ')}</Td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// A3 — the day's overflow: runs the own fleet could not cover. The dispatcher
// picks a region 3PL carrier (an OUTSOURCE lorry) and captures the trip cost (the
// seam Module C's rate-card will compute against), then assigns it via the same
// schedule write-path — a 3PL trip does not consume an own-fleet slot.
export const OverflowSection = ({ overflow, carriers, pick, onPick, onAssign, assigningKey }: {
  overflow: OverflowGroup[];
  carriers: ThreePlCarrier[];
  pick: Record<string, { carrierId?: string | null; costRm?: string }>;
  onPick: (key: string, patch: { carrierId?: string | null; costRm?: string }) => void;
  onAssign: (o: OverflowGroup) => void;
  assigningKey: string | null;
}) => (
  <div style={{ borderRadius: 10, border: '1px solid rgba(217,119,6,0.4)', overflow: 'hidden' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', background: 'rgba(217,119,6,0.08)' }}>
      <strong style={{ fontSize: 'var(--fs-13)' }}>3PL overflow ({overflow.length})</strong>
      <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
        Own fleet is full for these — assign a 3PL carrier and capture the cost.
      </span>
    </div>
    {carriers.length === 0 && (
      <div style={{ padding: '8px 14px', fontSize: 'var(--fs-12)', color: 'var(--c-warning, #b45309)' }}>
        No 3PL carrier on file for this region. Add an OUTSOURCE lorry (non-internal) in Fleet to assign overflow.
      </div>
    )}
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {overflow.map((o) => {
        const p = pick[o.key] ?? {};
        const busy = assigningKey === o.key;
        return (
          <div key={o.key} style={{ padding: '10px 14px', borderTop: '1px solid var(--border, rgba(0,0,0,0.08))' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 'var(--fs-13)' }}>{o.date}</strong>
              <span style={{ fontSize: 'var(--fs-11)', padding: '2px 8px', borderRadius: 999, background: 'var(--bg, rgba(0,0,0,0.06))' }}>
                {o.group === 'KLANG_VALLEY' ? 'Klang Valley (mixed)' : o.group}
              </span>
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                {o.orders.length} order(s) · {o.sets} sets · {fmtRm(o.revenueSen)}
              </span>
            </div>
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', margin: '4px 0' }}>{o.orders.join(', ')}</div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <AssignSelect label="3PL carrier" value={p.carrierId ?? null} onChange={(v) => onPick(o.key, { carrierId: v })}
                options={carriers.map((c) => ({ id: c.id, label: c.plate }))} placeholder="— pick a carrier —" />
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>Captured cost (RM)</span>
                <input type="number" min="0" value={p.costRm ?? ''} onChange={(e) => onPick(o.key, { costRm: e.target.value })}
                  placeholder="0" style={{ ...selStyle, width: 120 }} />
              </label>
              <Button variant="primary" icon={<CalendarCheck {...ICON} />} onClick={() => onAssign(o)} disabled={busy || !p.carrierId || carriers.length === 0}>
                {busy ? 'Assigning…' : 'Assign 3PL'}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  </div>
);
