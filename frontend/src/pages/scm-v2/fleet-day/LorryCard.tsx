import { Printer, Users, QrCode, Phone } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { fmtSen } from '../../../../../shared/src/vendor/shared/format';
import { RUN_STATUS_LABEL, progressPct, departureDeltaMin, isDepartLate } from '../../../vendor/scm/lib/fleet-day-cards';
import { clockMY, actualDepartOf, stopTimes, type LorryRunVM, type DocRowVM } from './vm';
import {
  FAMILY_STYLE, stopTagOf, stopTitleOf, stopRefLineOf, stopAddressOf, slotPillOf, statusPillOf, circleLookOf,
  stopMetaExtras, type CircleLook, type RowState, type StopLocation,
} from './stop-row';

function RunStatusPill({ run }: { run: LorryRunVM }) {
  const cls =
    run.status === 'COMPLETED' ? 'bg-synced-bg text-synced'
      : run.status === 'ON_THE_WAY' ? 'bg-[#e7eef9] text-[#1f4a8a]'
        : 'bg-surface-dim text-ink-muted';
  return <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-bold', cls)}>{RUN_STATUS_LABEL[run.status]}</span>;
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

const CIRCLE_STYLE: Record<CircleLook, React.CSSProperties> = {
  'open-blue': { borderColor: '#2563eb', borderStyle: 'solid', backgroundColor: '#ffffff', color: '#2563eb' },
  'solid-blue': { borderColor: '#2563eb', borderStyle: 'solid', backgroundColor: '#2563eb', color: '#ffffff' },
  'solid-green': { borderColor: '#15803d', borderStyle: 'solid', backgroundColor: '#15803d', color: '#ffffff' },
  'open-red': { borderColor: '#dc2626', borderStyle: 'solid', backgroundColor: '#ffffff', color: '#dc2626' },
  'dashed-grey': { borderColor: '#8a8f84', borderStyle: 'dashed', backgroundColor: '#ffffff', color: '#5b6056' },
};

/** The stop's run number (the same one its pin carries on the map); the circle's
 *  look says where the stop is (owner-approved redesign 2026-11-18). */
export function StopNo({ no, look }: { no: number | null; look: CircleLook }) {
  return (
    <span
      data-look={look}
      className="flex h-[26px] w-[26px] items-center justify-center rounded-full border-2 text-[11px] font-bold"
      style={CIRCLE_STYLE[look]}
    >
      {no ?? '•'}
    </span>
  );
}

const PILL_CLASS: Record<RowState, string> = {
  scheduled: 'bg-surface-dim text-ink-muted',
  active: 'bg-[#e7eef9] text-[#1f4a8a]',
  arrived: 'bg-[#e7eef9] text-[#1f4a8a]',
  done: 'bg-synced-bg text-synced',
  overdue: 'bg-err-bg text-err',
};

function StopTag({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <span className="shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-brand" style={{ backgroundColor: bg, color: fg }}>
      {label}
    </span>
  );
}

function StopRow({ d, no, selected, hasRemark, leg, location, siteMin, plannedDepartAt, clock, onOpen }: {
  d: DocRowVM; no: number | null; selected: boolean; hasRemark: boolean; leg: string | null;
  location: StopLocation; siteMin: number | null; plannedDepartAt: string | null;
  clock: { now: Date; day: string; today: string }; onOpen: () => void;
}) {
  const tag = stopTagOf(d.order);
  const fam = FAMILY_STYLE[tag.family];
  const pill = statusPillOf(d);
  const done = pill.state === 'done';
  const title = stopTitleOf(d);
  const refLine = stopRefLineOf(d);
  const address = stopAddressOf(d);
  const slot = slotPillOf(d.slotLabel);
  const meta = [
    ...(leg ? [{ text: `Google ${leg}`, tone: 'muted' as const }] : []),
    ...stopMetaExtras(d, { ...clock, plannedDepartAt, siteMin, location }),
  ];
  return (
    <button
      type="button"
      onClick={onOpen}
      data-stop={d.soDocNo}
      data-state={pill.state}
      className={cn(
        'grid w-full grid-cols-[28px_minmax(0,1fr)_104px] items-start gap-2.5 border-t border-border-subtle px-3.5 py-2.5 text-left hover:bg-surface-2',
        done && 'bg-[#f7f8f5]',
        selected && 'bg-primary-soft',
      )}
    >
      <span className="pt-0.5"><StopNo no={no} look={circleLookOf(pill.state, location)} /></span>
      <span className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <StopTag label={tag.label} bg={fam.bg} fg={fam.fg} />
          {d.draftDo && <StopTag label="DRAFT DO" bg="#fde8e8" fg="#b42318" />}
          {hasRemark && <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] font-bold text-accent-ink" title="Has dispatch / CS remarks">REMARK</span>}
          <span className={cn('min-w-[8rem] flex-1 basis-0 truncate text-[13px] font-semibold', done ? 'text-ink-muted' : 'text-ink')} title={title}>{title}</span>
        </span>
        {refLine && <span className="block truncate text-[11.5px] text-ink-muted" title={refLine}>{refLine}</span>}
        {address && <span className={cn('block truncate text-[12px]', done ? 'text-ink-muted' : 'text-ink-secondary')} title={address}>{address}</span>}
        <span className="mt-0.5 block truncate text-[11.5px] text-ink-muted">
          {slot && <span className="mr-1 rounded bg-surface-dim px-1.5 py-px text-[10px] font-bold text-ink-secondary" title={d.slotLabel}>{slot}</span>}
          {meta.map((b, i) => (
            <span key={b.text}>
              {i > 0 && ' · '}
              <span className={b.tone === 'err' ? 'font-semibold text-err' : undefined}>{b.text}</span>
            </span>
          ))}
        </span>
      </span>
      <span className="flex flex-col items-end gap-1">
        <span className={cn('whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-bold', PILL_CLASS[pill.state])} data-testid="stop-pill">{pill.label}</span>
        {d.rowType === 'so' && <span className={cn('font-mono text-[12.5px] font-semibold tabular-nums', done ? 'text-ink-muted' : 'text-ink')}>{fmtSen(d.amountSen)}</span>}
      </span>
    </button>
  );
}

/** One lorry run as a card. `run` carries the full rollup (header); `visibleDocs`
 *  are the filter-row-narrowed drops the list shows, always in run order. */
export function LorryCard({
  run, visibleDocs, filtersActive, searchActive, actionable, focused, selectedKey, remarkKeys, road, legByRef, mapNoByRef,
  approxRefs, unlocatedRefs, clock, hideDone, onToggleHideDone,
  onFocus, onOpenDoc, onCrew, onRunSheet, onQr,
}: {
  run: LorryRunVM;
  road: string | null;
  legByRef: ReadonlyMap<string, string>;
  mapNoByRef: ReadonlyMap<string, number>;
  approxRefs: ReadonlySet<string>;
  unlocatedRefs: ReadonlySet<string>;
  clock: { now: Date; day: string; today: string };
  hideDone: boolean;
  onToggleHideDone: () => void;
  visibleDocs: DocRowVM[];
  filtersActive: boolean;
  searchActive: boolean;
  actionable: boolean;
  focused: boolean;
  selectedKey: string | null;
  remarkKeys: Set<string>;
  onFocus: () => void;
  onOpenDoc: (d: DocRowVM) => void;
  onCrew: () => void;
  onRunSheet: () => void;
  onQr: () => void;
}) {
  const times = stopTimes(run.docs);
  const doneCount = visibleDocs.filter((d) => d.status === 'done').length;
  const foldDone = hideDone && !searchActive;
  const rows = foldDone ? visibleDocs.filter((d) => d.status !== 'done') : visibleDocs;
  const plannedAt = run.trip?.planned_depart_at ?? null;
  const actualAt = run.trip?.clock_in_at ?? actualDepartOf(run.docs);
  const deltaMin = departureDeltaMin(plannedAt, actualAt);
  const departLate = isDepartLate(deltaMin);
  const r = run.rollup;
  const units = run.docs.reduce((n, d) => n + d.units, 0);
  const crewLine = [run.driver2Name ? `Driver 2: ${run.driver2Name}` : null, run.helpers.length ? `Helpers: ${run.helpers.join(', ')}` : null].filter(Boolean).join(' · ');
  const progress = [`${r.delivered}/${r.drops} done`, r.late > 0 ? `${r.late} late` : null, r.drops > 0 ? `${units} unit${units === 1 ? '' : 's'}` : null, fmtSen(r.totalSen)].filter(Boolean) as string[];
  const departText = actualAt ? `Left ${clockMY(actualAt)}` : plannedAt ? `Plan ${clockMY(plannedAt)}` : null;

  const plate = (
    <span className="rounded-md bg-ink px-2.5 py-0.5 font-mono text-[17px] font-bold tracking-wider text-white" style={{ borderBottom: `3px solid ${run.color}` }}>
      {run.plate}
    </span>
  );

  return (
    <div
      className={cn('min-w-0 overflow-hidden rounded-lg border bg-surface shadow-stone', focused ? 'border-primary' : 'border-border')}
      style={{ borderTop: `4px solid ${run.color}` }}
    >
      <div className="space-y-1 px-3.5 pb-3 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          {run.docs.length > 0
            ? <button type="button" onClick={onFocus} title="Focus this lorry on the map" className="shrink-0">{plate}</button>
            : <span className="shrink-0">{plate}</span>}
          <RunStatusPill run={run} />
          {!actionable && <span className="shrink-0 rounded-full bg-surface-dim px-2 py-0.5 text-[10.5px] font-semibold text-ink-muted">No run yet</span>}
          <span className="flex-1" />
          {run.tripNo && <span className="truncate font-mono text-[11px] text-accent">{run.tripNo}</span>}
        </div>
        <div className="flex min-w-0 items-center gap-3 text-[13.5px]">
          <span className="truncate font-bold text-ink" title={run.driverIc ? `IC ${run.driverIc}` : undefined}>{run.driverName ?? 'No driver assigned'}</span>
          {run.driverPhone && (
            <a href={`tel:${run.driverPhone}`} onClick={(e) => e.stopPropagation()} className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold text-primary">
              <Phone size={11} strokeWidth={2} />{run.driverPhone}
            </a>
          )}
        </div>
        {crewLine && <div className="truncate text-[12px] text-ink-secondary" title={crewLine}>{crewLine}</div>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pt-1 text-[12px]">
          <span className="text-ink-secondary">
            {progress.map((t, i) => (
              <span key={t}>
                {i > 0 && ' · '}
                <span className={i === 0 ? 'font-semibold text-ink' : t.endsWith(' late') ? 'font-semibold text-err' : i === progress.length - 1 ? 'font-mono tabular-nums' : undefined}>{t}</span>
              </span>
            ))}
          </span>
          <span className="ml-auto text-[11.5px] text-ink-muted">
            {departText && <span className="text-ink-secondary">{departText}</span>}
            {deltaMin != null && deltaMin !== 0 && (
              <span className={departLate ? 'font-semibold text-err' : undefined}> {deltaMin > 0 ? `+${deltaMin} min` : `${deltaMin} min`}</span>
            )}
            {road && <span>{departText ? ' · ' : ''}Google <span className="font-semibold text-ink-secondary">{road}</span></span>}
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-dim">
          <div className="h-full rounded-full bg-synced" style={{ width: `${progressPct(r.delivered, r.drops)}%` }} />
        </div>
      </div>

      {visibleDocs.length === 0 ? (
        <div className="border-t border-border-subtle px-4 py-3 text-[12px] text-ink-muted">
          {filtersActive ? 'No documents match the current filters.' : 'No drops on this run yet.'}
        </div>
      ) : rows.map((d) => (
        <StopRow
          key={d.key}
          d={d}
          no={mapNoByRef.get(d.soDocNo) ?? d.stopNo}
          selected={selectedKey === d.key}
          hasRemark={remarkKeys.has(d.soDocNo)}
          leg={legByRef.get(d.soDocNo) ?? null}
          location={approxRefs.has(d.soDocNo) ? 'approx' : unlocatedRefs.has(d.soDocNo) ? 'none' : 'unknown'}
          siteMin={times.get(d.key)?.siteMin ?? null}
          plannedDepartAt={plannedAt}
          clock={clock}
          onOpen={() => onOpenDoc(d)}
        />
      ))}

      {(doneCount > 0 || actionable) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle bg-surface-2 px-3.5 py-2">
          {doneCount > 0 && (
            <button type="button" onClick={onToggleHideDone} aria-pressed={hideDone} className="text-[12px] font-semibold text-ink-secondary hover:text-ink">
              {hideDone ? `Show done (${doneCount})` : `Hide done (${doneCount})`}
            </button>
          )}
          <span className="flex-1" />
          {actionable && (
            <>
              <CardBtn icon={<Users size={13} strokeWidth={1.75} />} label="Crew" onClick={onCrew} />
              <CardBtn icon={<Printer size={13} strokeWidth={1.75} />} label="Run-sheet" onClick={onRunSheet} />
              <CardBtn icon={<QrCode size={13} strokeWidth={1.75} />} label="QR" onClick={onQr} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
