// ----------------------------------------------------------------------------
// Auto-Schedule — Fleet Module A1. The dispatcher's daily "fit the pending
// orders into days" job, automated: pick a DEPOT + a START DATE, and the packer
// derives each pending order's ZONE (from its postcode) + SET count (from its SO
// lines) and PACKS them into lorry-days under each lorry's capacity ceiling
// (first-ceiling-wins; Klang Valley mixes, far zones run dedicated + accumulate).
//
// The result is a REVERSIBLE, DISPLAY-ONLY proposal grouped day -> group ->
// lorry. Nothing is written until the owner clicks "Apply proposed dates", which
// writes each order's amended_delivery_date through the ESTABLISHED schedule
// path (PATCH /delivery-planning/so/:id/schedule) — never customer_delivery_date,
// and no lorry assignment (that is A2). A day can be LOCKED (frozen) once the
// owner is happy, and unlocked again.
//
// Source of pending orders: the same board the dispatcher already uses
// (useDeliveryPlanning state=PENDING_SCHEDULE) — no parallel queue.
// ----------------------------------------------------------------------------

import { useMemo, useState, type ReactNode, type CSSProperties } from 'react';
import { Button } from '@2990s/design-system';
import { Lock, Unlock, Wand2, CalendarCheck } from 'lucide-react';
import { PageHeader } from '../../components/Layout';
import { useDeliveryPlanning } from '../../vendor/scm/lib/delivery-planning-queries';
import { useScheduleDelivery } from '../../vendor/scm/lib/delivery-planning-queries';
import {
  useProposeDelivery,
  useDayLocks,
  useLockDay,
  useUnlockDay,
  type ProposeResponse,
  type PackedDay,
} from '../../vendor/scm/lib/delivery-zones-queries';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const ALL_DEPOTS = '__ALL__';

function todayMY(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
const rm = (centi: number): string => `RM ${(centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

const groupLabel = (g: string): string => (g === 'KLANG_VALLEY' ? 'Klang Valley (mixed)' : g);

export const AutoSchedule = () => {
  const board = useDeliveryPlanning({ region: 'ALL', state: 'PENDING_SCHEDULE' });
  const propose = useProposeDelivery();
  const schedule = useScheduleDelivery();
  const notify = useNotify();
  const askConfirm = useConfirm();

  const [depot, setDepot] = useState<string>(ALL_DEPOTS);
  const [startDate, setStartDate] = useState<string>(todayMY());
  const [maxSets, setMaxSets] = useState<string>('10');
  const [maxRevenueRm, setMaxRevenueRm] = useState<string>('30000');
  const [result, setResult] = useState<ProposeResponse | null>(null);
  const [applying, setApplying] = useState(false);

  // SO pending-schedule orders, and the depot options derived from them.
  const soOrders = useMemo(
    () => (board.data?.orders ?? []).filter((o) => o.row_type === 'so' && o.so_doc_no),
    [board.data],
  );
  const depots = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of soOrders) {
      if (o.warehouse_id) m.set(o.warehouse_id, o.warehouse_name || o.warehouse_code || o.warehouse_id);
    }
    return [...m.entries()].map(([id, name]) => ({ id, name }));
  }, [soOrders]);

  const depotDocNos = useMemo(
    () => soOrders
      .filter((o) => depot === ALL_DEPOTS || o.warehouse_id === depot)
      .map((o) => o.so_doc_no)
      .filter((v): v is string => !!v),
    [soOrders, depot],
  );

  const locks = useDayLocks({ warehouseId: depot === ALL_DEPOTS ? null : depot });
  const lockedDates = useMemo(() => new Set((locks.data ?? []).map((l) => l.deliveryDate)), [locks.data]);
  const lockByDate = useMemo(() => new Map((locks.data ?? []).map((l) => [l.deliveryDate, l])), [locks.data]);
  const lockDay = useLockDay();
  const unlockDay = useUnlockDay();

  const runPropose = () => {
    if (depotDocNos.length === 0) { notify({ title: 'Nothing to schedule', body: 'No pending-schedule orders for this depot.', tone: 'error' }); return; }
    const sets = Number(maxSets);
    const revRm = Number(maxRevenueRm);
    propose.mutate({
      soDocNos: depotDocNos,
      depotWarehouseId: depot === ALL_DEPOTS ? null : depot,
      startDate,
      defaultMaxSets: Number.isInteger(sets) && sets > 0 ? sets : undefined,
      defaultMaxRevenueCenti: Number.isFinite(revRm) && revRm > 0 ? Math.round(revRm * 100) : undefined,
    }, {
      onSuccess: (r) => setResult(r),
      onError: (err) => notify({ title: 'Propose failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  const applyAll = async () => {
    if (!result || result.proposals.length === 0) return;
    if (!(await askConfirm({
      title: `Apply ${result.proposals.length} proposed delivery dates?`,
      body: 'Writes each order’s amended delivery date (never the customer date). No lorry is assigned. You can re-run and re-apply anytime.',
      confirmLabel: 'Apply dates',
    }))) return;
    setApplying(true);
    let ok = 0; let failed = 0;
    // Cap concurrency at 4, like the schedule drawer's fan-out.
    const queue = [...result.proposals];
    const worker = async () => {
      while (queue.length > 0) {
        const p = queue.shift()!;
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
    notify({
      title: failed === 0 ? 'Dates applied' : 'Applied with some failures',
      body: `${ok} order(s) dated${failed ? `, ${failed} failed` : ''}.`,
      tone: failed === 0 ? 'info' : 'error',
    });
    board.refetch();
  };

  const toggleLock = (date: string) => {
    const existing = lockByDate.get(date);
    if (existing) {
      unlockDay.mutate(existing.id, { onError: (e) => notify({ title: 'Unlock failed', body: e instanceof Error ? e.message : '', tone: 'error' }) });
    } else {
      lockDay.mutate({ deliveryDate: date, warehouseId: depot === ALL_DEPOTS ? null : depot }, {
        onError: (e) => notify({ title: 'Lock failed', body: e instanceof Error ? e.message : '', tone: 'error' }),
      });
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Delivery"
        title="Auto-Schedule"
        description="Fit the pending-schedule orders into delivery days automatically. Pick a depot and a start date; each order is grouped by its postcode zone and packed into lorry-days under your per-lorry capacity ceilings. The proposal is reversible — review it, then apply the dates (amended delivery date only) and lock the days you are happy with."
      />

      {/* Controls */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end', padding: '14px 16px', borderRadius: 10, background: 'var(--bg-subtle, rgba(0,0,0,0.03))' }}>
        <Ctl label="Depot (origin)">
          <select value={depot} onChange={(e) => { setDepot(e.target.value); setResult(null); }} style={selStyle}>
            <option value={ALL_DEPOTS}>All depots</option>
            {depots.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Ctl>
        <Ctl label="Start date">
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={selStyle} />
        </Ctl>
        <Ctl label="Default max sets / lorry">
          <input type="number" min="1" value={maxSets} onChange={(e) => setMaxSets(e.target.value)} style={{ ...selStyle, width: 90 }} />
        </Ctl>
        <Ctl label="Default max revenue / lorry (RM)">
          <input type="number" min="1" value={maxRevenueRm} onChange={(e) => setMaxRevenueRm(e.target.value)} style={{ ...selStyle, width: 120 }} />
        </Ctl>
        <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', flex: '1 1 auto' }}>
          {board.isLoading ? 'Loading pending orders…' : `${depotDocNos.length} pending order(s) for this depot`}
        </div>
        <Button variant="primary" size="md" onClick={runPropose} disabled={propose.isPending || board.isLoading}>
          <Wand2 {...ICON} />
          <span>{propose.isPending ? 'Proposing…' : 'Propose schedule'}</span>
        </Button>
      </div>

      {result && (
        <>
          {result.usingDefaultZoneMap && (
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
              Using the built-in default postcode zone map (no custom rules set). Refine it in Delivery Zones.
            </div>
          )}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--fs-13)' }}>
              {result.proposals.length} order(s) placed across {result.days.length} day-trip(s) · {result.lorryCount} lorry(ies) available
            </span>
            <Button variant="primary" size="md" onClick={applyAll} disabled={applying || result.proposals.length === 0}>
              <CalendarCheck {...ICON} />
              <span>{applying ? 'Applying…' : 'Apply proposed dates'}</span>
            </Button>
          </div>

          {result.days.length === 0 && (
            <p style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>
              Nothing could be packed — check that the depot has active in-house lorries and that orders carry a postcode.
            </p>
          )}

          {result.days.map((day, i) => (
            <DayCard
              key={`${day.date}-${day.group}-${i}`}
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
        </>
      )}
    </div>
  );
};

const DayCard = ({ day, locked, onToggleLock, lockBusy }: {
  day: PackedDay; locked: boolean; onToggleLock: () => void; lockBusy: boolean;
}) => {
  const daySets = day.lorries.reduce((s, l) => s + l.sets, 0);
  const dayRevenue = day.lorries.reduce((s, l) => s + l.revenueCenti, 0);
  return (
    <div style={{ borderRadius: 10, border: '1px solid var(--border, rgba(0,0,0,0.12))', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: locked ? 'rgba(37,99,235,0.08)' : 'var(--bg-subtle, rgba(0,0,0,0.03))' }}>
        <strong style={{ fontSize: 'var(--fs-14)' }}>{day.date}</strong>
        <span style={{ fontSize: 'var(--fs-12)', padding: '2px 8px', borderRadius: 999, background: 'var(--bg, rgba(0,0,0,0.06))' }}>{groupLabel(day.group)}</span>
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{day.lorries.length} lorry-trip(s) · {daySets} sets · {rm(dayRevenue)}</span>
        <div style={{ flex: 1 }} />
        <Button variant={locked ? 'primary' : 'ghost'} size="sm" onClick={onToggleLock} disabled={lockBusy}>
          {locked ? <Lock {...ICON} /> : <Unlock {...ICON} />}
          <span>{locked ? 'Locked' : 'Lock day'}</span>
        </Button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {day.lorries.map((l) => {
          const setPct = l.ceilingSets ? Math.min(100, Math.round((l.sets / l.ceilingSets) * 100)) : null;
          const revPct = l.ceilingRevenueCenti ? Math.min(100, Math.round((l.revenueCenti / l.ceilingRevenueCenti) * 100)) : null;
          return (
            <div key={l.lorryId} style={{ padding: '10px 14px', borderTop: '1px solid var(--border, rgba(0,0,0,0.08))' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 'var(--fs-13)' }}>{l.plate}</strong>
                <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                  {l.sets}{l.ceilingSets != null ? `/${l.ceilingSets}` : ''} sets
                  {setPct != null ? ` (${setPct}%)` : ''}
                  {l.ceilingRevenueCenti != null ? ` · ${rm(l.revenueCenti)}/${rm(l.ceilingRevenueCenti)}${revPct != null ? ` (${revPct}%)` : ''}` : ` · ${rm(l.revenueCenti)}`}
                </span>
                {l.partial && <Badge tone="warn">Partial — not a full load</Badge>}
                {l.overCeiling && <Badge tone="danger">Over ceiling — ships alone</Badge>}
              </div>
              <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', marginTop: 4 }}>
                {l.orders.join(', ')}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const Badge = ({ tone, children }: { tone: 'warn' | 'danger'; children: ReactNode }) => (
  <span style={{
    fontSize: 'var(--fs-11)', padding: '1px 7px', borderRadius: 999,
    background: tone === 'danger' ? 'rgba(220,38,38,0.12)' : 'rgba(217,119,6,0.14)',
    color: tone === 'danger' ? 'var(--c-danger, #b91c1c)' : 'var(--c-warning, #b45309)',
  }}>{children}</span>
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
