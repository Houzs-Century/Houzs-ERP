// ----------------------------------------------------------------------------
// Delivery Date Arrangement — stage 2 of the delivery pipeline (Planning ->
// Date -> Time -> Last Mile). Owner spec 2026-08-07/08: dates first, lorries
// later, never lump-sum ("不用搞得太麻烦").
//
// The page IS the queue board — the EXACT shared DeliveryPlanningBoard locked
// to PENDING_SCHEDULE, split Pending Date Arrangement vs Date arranged over the
// server-stamped arrangement_stage. The flow: MULTISELECT rows -> "Propose
// dates (N)" -> a proposal grouped by DAY (postcode-zone based, NO lorry
// dimension anywhere) -> "Apply proposed dates" writes each order's
// amended_delivery_date through the ESTABLISHED schedule path (PATCH
// /delivery-planning/so/:id/schedule) — never customer_delivery_date.
//
// The backend propose endpoint is still the A1 capacity packer (that is how it
// knows how many orders fit a day); this page passes it only the selected SO
// doc numbers + a start date (default today, tucked beside the button) and lets
// the server defaults carry the capacity numbers silently. The per-lorry
// packing view, "Sequence & assign" and the 3PL overflow tools MOVED to the
// Delivery Time Arrangement page (Trips.tsx) — the lorry dimension lives THERE.
// Day locks stay (reversible freezes, per date).
// ----------------------------------------------------------------------------

import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@2990s/design-system';
import { Lock, Unlock, Wand2, CalendarCheck, Map as MapIcon } from 'lucide-react';
import { PageHeader } from '../../components/Layout';
import { DeliveryMapPanel, useMapPanelOpen, useMapCompactColumns } from '../../components/scm-v2/DeliveryMapPanel';
import { useDeliveryGeo } from '../../vendor/scm/lib/delivery-geo-queries';
import {
  pinsFromGeoPoints,
  geoTotals,
  zoneSummary,
  MAP_ESSENTIAL_COLUMNS,
} from '../../vendor/scm/lib/delivery-map-model';
import {
  useDeliveryPlanning,
  useScheduleDelivery,
  dateArrangementOf,
  DATE_ARRANGEMENT_LABEL,
  type DateArrangement,
  type PlanningOrder,
} from '../../vendor/scm/lib/delivery-planning-queries';
import {
  DeliveryPlanningBoard,
  regionTabsFrom,
  soDocNosFromSelection,
} from '../../vendor/scm/components/DeliveryPlanningBoard';
import { arrangementQueueCompare } from '../../vendor/scm/lib/arrangement-sort';
import {
  useProposeDelivery,
  useDayLocks,
  useLockDay,
  useUnlockDay,
  type ProposeResponse,
} from '../../vendor/scm/lib/delivery-zones-queries';
import { groupProposalsByDay, type ProposalDay } from '../../vendor/scm/lib/propose-days';
import { useDrivers } from '../../vendor/scm/lib/drivers-queries';
import { useLorries } from '../../vendor/scm/lib/lorries-queries';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { DateField } from "../../vendor/scm/components/DateField";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

function todayMY(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
const rm = (centi: number): string => `RM ${(centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

const groupLabel = (g: string): string => (g === 'KLANG_VALLEY' ? 'Klang Valley (mixed)' : g);

export const AutoSchedule = () => {
  const navigate = useNavigate();
  const propose = useProposeDelivery();
  const schedule = useScheduleDelivery();
  /* The board's inline Driver / Lorry cells share the fleet option lists — the
     cells are part of the shared board, not this page's propose flow. */
  const drivers = useDrivers();
  const lorries = useLorries();
  const notify = useNotify();
  const askConfirm = useConfirm();

  /* ── The queue: every Pending Schedule order, FULL board fidelity (owner
     pipeline 2026-08-07: "该有的资料全部都要进到去") — the EXACT shared board
     (columns, region chips, line-item drill-down, inline editors, multiselect),
     split by the server-stamped date side. */
  const [queueRegion, setQueueRegion] = useState<string>('ALL');
  const queue = useDeliveryPlanning({ region: queueRegion, state: 'PENDING_SCHEDULE' });
  const [dateSide, setDateSide] = useState<'ALL' | DateArrangement>('PENDING_DATE');
  const [queueSel, setQueueSel] = useState<Set<string>>(new Set());
  const queueOrders = useMemo<PlanningOrder[]>(() => queue.data?.orders ?? [], [queue.data]);
  const queueRegionTabs = useMemo(() => regionTabsFrom(queue.data?.regions), [queue.data?.regions]);
  const sideCounts = useMemo(() => {
    const c: Record<DateArrangement, number> = { PENDING_DATE: 0, DATE_ARRANGED: 0 };
    for (const o of queueOrders) {
      const side = dateArrangementOf(o);
      if (side) c[side] += 1;
    }
    return c;
  }, [queueOrders]);
  const sideRows = useMemo(
    () => (dateSide === 'ALL'
      ? queueOrders.filter((o) => dateArrangementOf(o) != null)
      : queueOrders.filter((o) => dateArrangementOf(o) === dateSide)),
    [queueOrders, dateSide],
  );

  /* ── Propose dates — over the SELECTED rows (SO-only, like every board bulk
     action). Start date defaults to today; everything else (depot, capacity
     ceilings) rides the server defaults silently. */
  const [startDate, setStartDate] = useState<string>(todayMY());
  const [result, setResult] = useState<ProposeResponse | null>(null);
  /* The proposal renders BELOW the whole queue board; without a scroll the
     click looks dead from the bulk bar (owner 2026-08-08: "点 proposed date
     没有反应"). Success scrolls the section into view + toasts the count. */
  const proposalRef = useRef<HTMLDivElement | null>(null);
  const [applying, setApplying] = useState(false);

  const selectedDocNos = soDocNosFromSelection(queueSel);

  const runPropose = () => {
    if (selectedDocNos.length === 0) {
      notify({ title: 'Nothing selected', body: 'Tick the orders to date first.', tone: 'error' });
      return;
    }
    propose.mutate({
      soDocNos: selectedDocNos,
      startDate: startDate || undefined,
    }, {
      onSuccess: (r) => {
        setResult(r);
        notify({
          title: `${r.proposals.length} date(s) proposed`,
          body: r.unassigned.length > 0
            ? `${r.unassigned.length} order(s) could not be placed — see the proposal below.`
            : 'Review the days below, then Apply.',
        });
        setTimeout(() => proposalRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
      },
      onError: (err) => notify({ title: 'Propose failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  /* The DAY-grouped proposal view (pure fold, propose-days.ts) — the lorry
     dimension is dropped before render, so it cannot leak onto this page. */
  const proposalDays = useMemo<ProposalDay[]>(
    () => (result ? groupProposalsByDay(result.proposals) : []),
    [result],
  );

  const applyAll = async () => {
    if (!result || result.proposals.length === 0) return;
    if (!(await askConfirm({
      title: `Apply ${result.proposals.length} proposed delivery dates?`,
      body: 'Writes each order’s amended delivery date (never the customer date). No lorry is assigned — that happens in Delivery Time Arrangement. You can re-run and re-apply anytime.',
      confirmLabel: 'Apply dates',
    }))) return;
    setApplying(true);
    let ok = 0; let failed = 0;
    // Cap concurrency at 4, like the schedule drawer's fan-out.
    const jobs = [...result.proposals];
    const worker = async () => {
      while (jobs.length > 0) {
        const p = jobs.shift()!;
        try {
          await schedule.mutateAsync({ type: 'so', id: p.ref, scheduleDate: p.deliveryDate });
          ok += 1;
        } catch {
          failed += 1;
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    setApplying(false);
    setQueueSel(new Set());
    notify({
      title: failed === 0 ? 'Dates applied' : 'Applied with some failures',
      body: `${ok} order(s) dated${failed ? `, ${failed} failed` : ''}. They now show under Date arranged and flow on to Delivery Time Arrangement.`,
      tone: failed === 0 ? 'info' : 'error',
    });
    queue.refetch();
  };

  /* ── Option B side map (owner 2026-08-08): board left, sticky map right.
     The map owns a REQUIRED picked date (default today) + its own region
     chips; the fetch is once per (date, region), only while OPEN. While open
     the board narrows to the essential columns (a render-time overlay — the
     user's own column prefs are untouched). */
  const [mapOpen, setMapOpen] = useMapPanelOpen('date-arrangement');
  /* Compact columns: a per-page-persisted DEFAULT, never a lock — the pill on
     the panel header toggles it, and any explicit Columns-panel choice while
     the map is open switches it off (the user's picks win instantly). */
  const [mapCompact, setMapCompact] = useMapCompactColumns('date-arrangement');
  const [mapDate, setMapDate] = useState<string>(todayMY());
  const [mapRegion, setMapRegion] = useState<string>('ALL');
  const geo = useDeliveryGeo({ date: mapDate, region: mapRegion, enabled: mapOpen });
  const mapPins = useMemo(() => pinsFromGeoPoints(geo.data?.points ?? []), [geo.data?.points]);
  const mapTotals = useMemo(() => geoTotals(geo.data?.points ?? []), [geo.data?.points]);
  const mapZones = useMemo(
    () => zoneSummary(geo.data?.points ?? [], queueRegionTabs, mapRegion),
    [geo.data?.points, queueRegionTabs, mapRegion],
  );
  /* Two-way linkage: board row click → enlarge + pan; pin click → scroll +
     highlight the board row (rowIdOf keys SO rows as `so:<docNo>`). */
  const [selectedPin, setSelectedPin] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<{ key: string; nonce: number } | null>(null);
  const onPinClick = (ref: string) => {
    setSelectedPin(ref);
    setScrollTo({ key: `so:${ref}`, nonce: Date.now() });
  };

  /* ── Day locks — reversible freezes per DATE (no depot dimension here). */
  const locks = useDayLocks({});
  const lockedDates = useMemo(() => new Set((locks.data ?? []).map((l) => l.deliveryDate)), [locks.data]);
  const lockByDate = useMemo(() => new Map((locks.data ?? []).map((l) => [l.deliveryDate, l])), [locks.data]);
  const lockDay = useLockDay();
  const unlockDay = useUnlockDay();

  const toggleLock = (date: string) => {
    const existing = lockByDate.get(date);
    if (existing) {
      unlockDay.mutate(existing.id, { onError: (e) => notify({ title: 'Unlock failed', body: e instanceof Error ? e.message : '', tone: 'error' }) });
    } else {
      lockDay.mutate({ deliveryDate: date }, {
        onError: (e) => notify({ title: 'Lock failed', body: e instanceof Error ? e.message : '', tone: 'error' }),
      });
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Delivery"
        title="Delivery Date Arrangement"
        description="Tick pending orders and propose delivery dates by postcode zone — apply writes the amended date only; lorries and times are arranged next in Delivery Time Arrangement."
      />

      {/* ── Option B split: board (left) / sticky map (right). ─────────────── */}
      <div className="lg:flex lg:items-start lg:gap-4">
      <div className="min-w-0 space-y-4 lg:flex-1">

      {/* Split chips — the derived date side of the pipeline. */}
      <div className="flex flex-wrap gap-1.5">
        {(['ALL', 'PENDING_DATE', 'DATE_ARRANGED'] as const).map((side) => (
          <button
            key={side}
            type="button"
            onClick={() => { setDateSide(side); setQueueSel(new Set()); }}
            className={[
              'rounded-full border px-3 py-1 text-[12px]',
              dateSide === side
                ? 'border-accent bg-accent/10 font-semibold text-accent'
                : 'border-border text-ink-secondary',
            ].join(' ')}
          >
            {side === 'ALL'
              ? `All (${sideCounts.PENDING_DATE + sideCounts.DATE_ARRANGED})`
              : `${DATE_ARRANGEMENT_LABEL[side]} (${sideCounts[side]})`}
          </button>
        ))}
        <span className="ml-2 self-center text-[11.5px] text-ink-muted">
          Date-arranged orders flow on to Delivery Time Arrangement automatically
        </span>
        <span className="flex-1" />
        {!mapOpen && (
          <Button variant="ghost" size="sm" onClick={() => setMapOpen(true)} title="Show the day map beside the board">
            <MapIcon {...ICON} />
            <span>Show map</span>
          </Button>
        )}
      </div>

      <DeliveryPlanningBoard
        orders={sideRows}
        counts={queue.data?.counts ?? {}}
        regionTabs={queueRegionTabs}
        activeRegion={queueRegion}
        onRegionChange={setQueueRegion}
        isLoading={queue.isLoading}
        error={queue.error}
        /* No stateTabs — the fetch is locked to PENDING_SCHEDULE, split above. */
        selectedKeys={queueSel}
        onToggle={(k) => setQueueSel((p) => {
          const n = new Set(p);
          if (n.has(k)) n.delete(k); else n.add(k);
          return n;
        })}
        onToggleAll={(keys, allSel) => setQueueSel((p) => {
          const n = new Set(p);
          if (allSel) { for (const k of keys) n.delete(k); }
          else { for (const k of keys) n.add(k); }
          return n;
        })}
        onClearSelection={() => setQueueSel(new Set())}
        sched={schedule}
        drivers={drivers.data ?? []}
        lorries={lorries.data ?? []}
        storageKey="dg-date-arrangement-v2"
        exportName="DeliveryDateArrangement"
        /* Map-open narrowing (a DEFAULT — the compact pill / an explicit
           Columns-panel choice turns it off) + two-way linkage (Option B). */
        visibleColumnsOverride={mapOpen && mapCompact ? MAP_ESSENTIAL_COLUMNS : null}
        onUserAdjustColumns={() => { if (mapOpen && mapCompact) setMapCompact(false); }}
        onRowClick={(o) => { if (mapOpen && o.row_type === 'so') setSelectedPin(o.so_doc_no); }}
        scrollToRow={scrollTo}
        /* Default queue order on entry (owner 2026-08-07): delivery date
           OLDEST first, then state, then postcode — both sides. A clicked
           column header still overrides. */
        defaultSort={arrangementQueueCompare}
        emptyMessage={dateSide === 'PENDING_DATE'
          ? 'No orders waiting for a delivery date.'
          : 'No date-arranged orders — confirm dates on the pending tab.'}
        onRowDoubleClick={(o) => { if (o.row_type === 'so') navigate('/scm/sales-orders/' + o.so_doc_no); }}
        bulkExtras={
          <>
            {/* The packer walks days forward from here — default today. */}
            <DateField
              value={startDate}
              onChange={(iso) => setStartDate(iso)}
              title="Propose dates from this day forward (default today)"
              style={{ ...selStyle, width: 140 }}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={propose.isPending || selectedDocNos.length === 0}
              onClick={runPropose}
              title={selectedDocNos.length === 0 ? 'Select one or more sales orders first' : 'Propose a delivery date per selected order, grouped by postcode zone'}
            >
              <Wand2 {...ICON} />
              <span>{propose.isPending ? 'Proposing…' : `Propose dates (${selectedDocNos.length})`}</span>
            </Button>
          </>
        }
        contextMenu={(row) => (row.row_type === 'so'
          ? [{ label: 'Open Sales Order', onClick: () => navigate('/scm/sales-orders/' + row.so_doc_no) }]
          : [])}
      />

      {/* ── The proposal: DAY -> orders (postcode-zone grouped). NO lorry
          dimension — sets / revenue appear only as day summary numbers. */}
      <div ref={proposalRef} />
      {result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {result.usingDefaultZoneMap && (
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
              Using the built-in default postcode zone map (no custom rules set). Refine it in Delivery Zones.
            </div>
          )}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--fs-13)' }}>
              {result.proposals.length} order(s) proposed across {proposalDays.length} day-group(s), from {result.startDate}
            </span>
            <Button variant="primary" size="md" onClick={applyAll} disabled={applying || result.proposals.length === 0}>
              <CalendarCheck {...ICON} />
              <span>{applying ? 'Applying…' : 'Apply proposed dates'}</span>
            </Button>
          </div>

          {proposalDays.length === 0 && (
            <p style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>
              Nothing could be dated — check that the selected orders carry a postcode.
            </p>
          )}

          {proposalDays.map((day) => (
            <ProposalDayCard
              key={`${day.date}-${day.group}`}
              day={day}
              locked={lockedDates.has(day.date)}
              onToggleLock={() => toggleLock(day.date)}
              lockBusy={lockDay.isPending || unlockDay.isPending}
            />
          ))}

          {result.unassigned.length > 0 && (
            <div style={{ padding: '12px 16px', borderRadius: 10, border: '1px solid var(--border, rgba(0,0,0,0.1))' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 'var(--fs-14)' }}>Needs attention ({result.unassigned.length})</h3>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                {result.unassigned.map((u) => (
                  <li key={u.ref}><strong>{u.ref}</strong>{u.zone ? ` (${u.zone})` : ''} — {u.reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      </div>{/* /board column */}

      {mapOpen && (
        <DeliveryMapPanel
          className="mt-4 lg:mt-0 lg:w-[40%] lg:flex-none"
          title="Delivery day map"
          onClose={() => setMapOpen(false)}
          headerControls={
            <>
              {/* REQUIRED picked date — the map always shows exactly one day. */}
              <DateField
                required
                value={mapDate}
                onChange={(iso) => { if (iso) setMapDate(iso); }}
                title="The day the map shows"
                style={{ ...selStyle, width: 140 }}
              />
              {/* Region chips zoom/filter the map viewport (server-side filter,
                  same buckets as the board's chips). */}
              {queueRegionTabs.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setMapRegion(r.key)}
                  className={[
                    'rounded-full border px-2.5 py-0.5 text-[11px]',
                    mapRegion === r.key ? 'border-accent bg-accent/10 font-semibold text-accent' : 'border-border text-ink-secondary',
                  ].join(' ')}
                >
                  {r.label}
                </button>
              ))}
            </>
          }
          pins={mapPins}
          depot={geo.data?.depot ? { lat: geo.data.depot.lat, lng: geo.data.depot.lng, label: geo.data.depot.name } : null}
          depotReason={geo.data?.depotReason ?? null}
          selectedRef={selectedPin}
          onPinClick={onPinClick}
          totals={mapTotals}
          regionKey={mapRegion}
          viewKey={`${mapDate}|${mapRegion}`}
          zoneSummary={mapZones}
          compactColumns={mapCompact}
          onCompactColumnsChange={setMapCompact}
          ungeocoded={geo.data?.ungeocoded ?? []}
          serverConfigured={geo.data?.configured ?? true}
          isLoading={geo.isLoading}
        />
      )}
      </div>{/* /split */}
    </div>
  );
};

/* One proposed DAY (+ zone group): the date, the zone, summary numbers, the
   orders — and the reversible day lock. No lorry appears here by design. */
const ProposalDayCard = ({ day, locked, onToggleLock, lockBusy }: {
  day: ProposalDay; locked: boolean; onToggleLock: () => void; lockBusy: boolean;
}) => (
  <div style={{ borderRadius: 10, border: `1px solid ${locked ? 'rgba(37,99,235,0.4)' : 'var(--border, rgba(0,0,0,0.12))'}`, overflow: 'hidden' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: locked ? 'rgba(37,99,235,0.08)' : 'var(--bg-subtle, rgba(0,0,0,0.03))' }}>
      <strong style={{ fontSize: 'var(--fs-14)' }}>{day.date}</strong>
      <span style={{ fontSize: 'var(--fs-12)', padding: '2px 8px', borderRadius: 999, background: 'var(--bg, rgba(0,0,0,0.06))' }}>{groupLabel(day.group)}</span>
      <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
        {day.orders.length} order(s) · {day.sets} sets · {rm(day.revenueSen)}
      </span>
      <div style={{ flex: 1 }} />
      <Button variant={locked ? 'primary' : 'ghost'} size="sm" onClick={onToggleLock} disabled={lockBusy}>
        {locked ? <Lock {...ICON} /> : <Unlock {...ICON} />}
        <span>{locked ? 'Locked' : 'Lock day'}</span>
      </Button>
    </div>
    <ul style={{ margin: 0, padding: '8px 14px', listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
      {day.orders.map((o) => (
        <li key={o.ref} style={{ fontSize: 'var(--fs-12)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{o.ref}</strong>
          <span>{o.debtorName ?? '—'}</span>
          <span style={{ color: 'var(--fg-muted)' }}>{o.zone}</span>
        </li>
      ))}
    </ul>
  </div>
);

const selStyle: CSSProperties = {
  padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border, rgba(0,0,0,0.2))',
  background: 'var(--bg, #fff)', color: 'var(--fg, inherit)', fontSize: 'var(--fs-13)',
};
