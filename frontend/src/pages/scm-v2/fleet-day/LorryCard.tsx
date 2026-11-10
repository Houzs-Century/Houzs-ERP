import { useState } from 'react';
import { Printer, Users, QrCode, Camera, ChevronDown, ChevronRight, Phone } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { fmtSen } from '../../../vendor/shared/format';
import type { StopStatus } from '../../../vendor/scm/lib/delivery-stop-status';
import { RUN_STATUS_LABEL, progressPct, departureDeltaMin, isDepartLate } from '../../../vendor/scm/lib/fleet-day-cards';
import { clockMY, actualDepartOf, fmtMinutes, stopTimes, type LorryRunVM, type DocRowVM } from './vm';

const STATUS_META: Record<StopStatus, { label: string; dot: string; text: string }> = {
  done: { label: 'Delivered', dot: 'bg-synced', text: 'text-synced' },
  active: { label: 'On the way', dot: 'bg-learning', text: 'text-learning' },
  overdue: { label: 'Late', dot: 'bg-err', text: 'text-err' },
  scheduled: { label: 'Not started', dot: 'bg-ink-muted', text: 'text-ink-muted' },
};

function RunStatusPill({ run }: { run: LorryRunVM }) {
  const cls =
    run.status === 'COMPLETED' ? 'bg-synced-bg text-synced'
      : run.status === 'ON_THE_WAY' ? 'bg-[#e6eaf4] text-learning'
        : 'bg-surface-dim text-ink-muted';
  return <span className={cn('rounded-full px-2 py-0.5 text-[10.5px] font-bold', cls)}>{RUN_STATUS_LABEL[run.status]}</span>;
}

function SlotTag({ label }: { label: string }) {
  if (!label) return null;
  return <span className="rounded bg-surface-dim px-1.5 py-0.5 text-[10px] font-bold text-ink-secondary">{label}</span>;
}

/** The job-type tag on a NON-SO drop (Setup / Dismantle / Transfer item / Supplier
 *  pickup / Service…). A plain SO delivery carries no tag — it is the board's bulk
 *  and reads as a delivery already; the tag is what makes the other job types
 *  stand out on their lorry's card. */
function JobTag({ label }: { label: string | null }) {
  if (!label) return null;
  return <span className="shrink-0 rounded bg-[#e6eaf4] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-brand text-learning">{label}</span>;
}

function CardBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface px-2 text-[12px] text-ink-secondary hover:border-border-strong hover:text-ink"
    >
      {icon}{label}
    </button>
  );
}

/** The stop's number, the same one its pin carries on the map, in the lorry's colour:
 *  solid once the stop is done, a light tint while it is still to deliver (owner 2026-11-10). */
export function StopNo({ no, color, done }: { no: number | null; color: string; done: boolean }) {
  return (
    <span
      data-done={done ? 'true' : 'false'}
      className="flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 text-[10px] font-bold"
      style={done
        ? { borderColor: color, backgroundColor: color, color: '#fff' }
        : { borderColor: color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
    >
      {no ?? '•'}
    </span>
  );
}

function UndeliveredRow({ d, no, color, selected, hasRemark, leg, onOpen }: { d: DocRowVM; no: number | null; color: string; selected: boolean; hasRemark: boolean; leg: string | null; onOpen: () => void }) {
  const meta = STATUS_META[d.status];
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'grid w-full grid-cols-[24px_1fr_auto] items-center gap-3 border-t border-border-subtle px-4 py-2.5 text-left hover:bg-surface-2',
        selected && 'bg-primary-soft',
        d.late && !selected && 'bg-err-bg/40',
      )}
    >
      <StopNo no={no ?? d.stopNo} color={color} done={false} />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <JobTag label={d.jobLabel} />
          <span className="truncate text-[13px] font-semibold text-ink">{d.customer || '—'}</span>
          {d.late && <span className="shrink-0 rounded-full bg-err-bg px-1.5 py-0.5 text-[9px] font-bold text-err" title={d.lateReason ?? undefined}>LATE</span>}
          {hasRemark && <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] font-bold text-accent-ink" title="Has dispatch / CS remarks">REMARK</span>}
        </span>
        {d.codeLine && <span className="block truncate font-mono text-[11px] text-ink-muted">{d.codeLine}</span>}
        {d.address && <span className="block truncate text-[12px] text-ink-secondary">{d.address}</span>}
        {leg && <span className="block text-[11px] text-ink-muted">Google <span className="font-semibold text-ink-secondary">{leg}</span></span>}
      </span>
      <span className="flex flex-col items-end gap-1">
        {d.rowType === 'so' && <span className="font-mono text-[13px] font-semibold tabular-nums text-ink">{fmtSen(d.amountSen)}</span>}
        <span className="flex items-center gap-1.5">
          <SlotTag label={d.slotLabel} />
          <span className="flex items-center gap-1 text-[11px] font-semibold">
            <span className={cn('h-2 w-2 rounded-full', meta.dot)} />
            <span className={meta.text}>{meta.label}</span>
          </span>
        </span>
      </span>
    </button>
  );
}

function DeliveredRow({ d, no, color, times, selected, leg, onOpen }: { d: DocRowVM; no: number | null; color: string; times: { roadMin: number | null; siteMin: number | null } | null; selected: boolean; leg: string | null; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn('grid w-full grid-cols-[24px_1fr_auto] items-center gap-3 border-t border-border-subtle px-4 py-2 text-left hover:bg-surface-2', selected && 'bg-primary-soft')}
    >
      <StopNo no={no} color={color} done />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <JobTag label={d.jobLabel} />
          <span className="truncate text-[12.5px] font-semibold text-ink">{d.customer || '—'}</span>
        </span>
        {d.codeLine && <span className="block truncate font-mono text-[11px] text-ink-muted">{d.codeLine}</span>}
        {times && (times.roadMin != null || times.siteMin != null) && (
          <span className="block text-[11px] text-ink-secondary">
            {[times.roadMin != null ? `Drive time ${fmtMinutes(times.roadMin)}` : null, d.arrivedAt ? `Arrived ${clockMY(d.arrivedAt)}` : null, times.siteMin != null ? `On-site time ${fmtMinutes(times.siteMin)}` : null].filter(Boolean).join(' · ')}
          </span>
        )}
        {leg && <span className="block text-[11px] text-ink-muted">Google <span className="font-semibold text-ink-secondary">{leg}</span></span>}
      </span>
      <span className="flex items-center gap-2">
        {d.rowType === 'so' && <span className="font-mono text-[12.5px] tabular-nums text-ink-secondary">{fmtSen(d.amountSen)}</span>}
        {d.deliveredAt && <span className="text-[11px] text-synced">Done {clockMY(d.deliveredAt)}</span>}
        {d.hasPod && <Camera size={14} strokeWidth={1.75} className="text-ink-muted" aria-label="POD photo" />}
      </span>
    </button>
  );
}

/** One lorry run as a card. `run` carries the full rollup (header); `visibleDocs`
 *  are the filter-row-narrowed drops the list shows. */
export function LorryCard({
  run, routeColor, visibleDocs, filtersActive, searchActive, actionable, focused, selectedKey, remarkKeys, road, legByRef, mapNoByRef,
  onFocus, onOpenDoc, onCrew, onRunSheet, onQr,
}: {
  run: LorryRunVM;
  /** The lorry's colour in the lorry list and on the map; the stop numbers wear it. */
  routeColor: string;
  /** The run by road from the lorry's home and back (Google); null when not worked out. */
  road: string | null;
  /** Each order's drive from the stop before, by sales order number (server-worked). */
  legByRef: ReadonlyMap<string, string>;
  /** Each order's pin number on the day map, by sales order number. */
  mapNoByRef: ReadonlyMap<string, number>;
  visibleDocs: DocRowVM[];
  filtersActive: boolean;
  searchActive: boolean;
  /** True when the card is backed by a trip — map-focus, crew edit, run-sheet
   *  and QR all need one. A no-trip lorry card is read-only (its drops still
   *  open the drawer). */
  actionable: boolean;
  focused: boolean;
  selectedKey: string | null;
  /** so_doc_no set of orders that carry >=1 remark — drives the REMARK pill. */
  remarkKeys: Set<string>;
  onFocus: () => void;
  onOpenDoc: (d: DocRowVM) => void;
  onCrew: () => void;
  onRunSheet: () => void;
  onQr: () => void;
}) {
  const [doneOpen, setDoneOpen] = useState(false);
  const undelivered = visibleDocs.filter((d) => d.status !== 'done');
  const delivered = visibleDocs.filter((d) => d.status === 'done');
  const times = stopTimes(run.docs);
  const showDone = doneOpen || searchActive;
  const plannedAt = run.trip?.planned_depart_at ?? null;
  const actualAt = run.trip?.clock_in_at ?? actualDepartOf(run.docs);
  const deltaMin = departureDeltaMin(plannedAt, actualAt);
  const departLate = isDepartLate(deltaMin);
  const r = run.rollup;
  const units = run.docs.reduce((n, d) => n + d.units, 0);

  return (
    <div
      className={cn('overflow-hidden rounded-lg border bg-surface shadow-stone', focused ? 'border-primary' : 'border-border')}
      style={{ borderTop: `4px solid ${run.color}` }}
    >
      {/* header */}
      <div className="flex flex-wrap items-center gap-2 p-3.5">
        {run.docs.length > 0 ? (
          <button
            type="button"
            onClick={onFocus}
            title="Focus this lorry on the map"
            className="rounded-md bg-ink px-3 py-1 font-mono text-[18px] font-bold tracking-wider text-white"
            style={{ borderBottom: `3px solid ${run.color}` }}
          >
            {run.plate}
          </button>
        ) : (
          <span
            className="rounded-md bg-ink px-3 py-1 font-mono text-[18px] font-bold tracking-wider text-white"
            style={{ borderBottom: `3px solid ${run.color}` }}
          >
            {run.plate}
          </span>
        )}
        <RunStatusPill run={run} />
        {run.tripNo && <span className="font-mono text-[11px] text-accent">{run.tripNo}</span>}
        <span className="flex-1" />
        {actionable ? (
          <>
            <CardBtn icon={<Users size={13} strokeWidth={1.75} />} label="Crew" onClick={onCrew} />
            <CardBtn icon={<Printer size={13} strokeWidth={1.75} />} label="Run-sheet" onClick={onRunSheet} />
            <CardBtn icon={<QrCode size={13} strokeWidth={1.75} />} label="QR" onClick={onQr} />
          </>
        ) : (
          <span className="rounded-full bg-surface-dim px-2 py-0.5 text-[10.5px] font-semibold text-ink-muted">No run yet</span>
        )}
      </div>

      {/* driver + crew */}
      <div className="px-3.5 pb-2">
        <div className="text-[15px] font-bold text-ink">{run.driverName ?? 'No driver assigned'}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-ink-secondary">
          {run.driverIc && <span className="font-mono text-ink-muted">IC {run.driverIc}</span>}
          {run.driverPhone && (
            <a href={`tel:${run.driverPhone}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 font-semibold text-primary">
              <Phone size={11} strokeWidth={2} />{run.driverPhone}
            </a>
          )}
          {run.driver2Name && <span>Driver 2: {run.driver2Name}</span>}
          {run.helpers.length > 0 && <span>Helpers: {run.helpers.join(', ')}</span>}
        </div>
      </div>

      {/* depart strip — planned vs actual (clock-in), delta red when >15 min late */}
      <div className="mx-3.5 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-surface-2 px-2.5 py-2 text-[12px]">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Depart</span>
        {plannedAt && <span className="text-ink-secondary">Plan <span className="font-semibold text-ink">{clockMY(plannedAt)}</span></span>}
        {actualAt
          ? <span className="text-ink-secondary">Actual <span className="font-semibold text-ink">{clockMY(actualAt)}</span></span>
          : <span className="text-ink-muted">Actual not yet</span>}
        {deltaMin != null && deltaMin !== 0 && (
          <span className={departLate ? 'font-semibold text-err' : 'text-ink-muted'}>
            {deltaMin > 0 ? `+${deltaMin} min` : `${deltaMin} min`}
          </span>
        )}
        {!plannedAt && !actualAt && <span className="text-ink-muted">Not departed yet</span>}
        {road && <span className="ml-auto text-ink-secondary"><span className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Google</span> <span className="font-semibold text-ink">{road}</span></span>}
      </div>

      {/* progress */}
      <div className="px-3.5 pb-3">
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="font-semibold text-ink">{r.delivered}/{r.drops} delivered</span>
          {r.late > 0 && <span className="rounded-full bg-err-bg px-1.5 py-0.5 text-[9px] font-bold text-err">{r.late} late</span>}
          <span className="flex-1" />
          <span className="font-mono tabular-nums text-ink-secondary">{fmtSen(r.totalSen)}</span>
          {r.drops > 0 && <span className="text-[11.5px] text-ink-muted">· {units} units</span>}
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-dim">
          <div className="h-full rounded-full bg-synced" style={{ width: `${progressPct(r.delivered, r.drops)}%` }} />
        </div>
      </div>

      {/* docs */}
      {visibleDocs.length === 0 ? (
        <div className="border-t border-border-subtle px-4 py-3 text-[12px] text-ink-muted">
          {filtersActive ? 'No documents match the current filters.' : 'No drops on this run yet.'}
        </div>
      ) : (
        <>
          {undelivered.map((d) => (
            <UndeliveredRow key={d.key} d={d} no={mapNoByRef.get(d.soDocNo) ?? null} color={routeColor} selected={selectedKey === d.key} hasRemark={remarkKeys.has(d.soDocNo)} leg={legByRef.get(d.soDocNo) ?? null} onOpen={() => onOpenDoc(d)} />
          ))}
          {delivered.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setDoneOpen((v) => !v)}
                className="flex w-full items-center gap-2 border-t border-border-subtle bg-surface-2 px-4 py-2 text-left text-[12px] font-semibold text-synced"
              >
                {showDone ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {delivered.length} delivered
              </button>
              {showDone && delivered.map((d) => (
                <DeliveredRow key={d.key} d={d} no={mapNoByRef.get(d.soDocNo) ?? null} color={routeColor} times={times.get(d.key) ?? null} selected={selectedKey === d.key} leg={legByRef.get(d.soDocNo) ?? null} onOpen={() => onOpenDoc(d)} />
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
