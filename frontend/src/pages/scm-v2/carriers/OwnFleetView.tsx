// ----------------------------------------------------------------------------
// Carriers & Rates — Own fleet tab. Owner 2026-11-24: 「你可以吧自己的lorry 当做是
// 一个3pl，就是我会有一个内部的算法」 and 「我不是应该算是一个3pl吗」. Our own lorries
// priced like a 3PL by the own fleet rate card he keeps on the Rate Cards tab:
// each lorry's day is one trip, priced once (GET /delivery-rate-cards/own-fleet),
// month by month beside what the 3PLs billed for orders that ran the same days.
// Shown only: nothing is posted and nothing reaches COGS.
// ----------------------------------------------------------------------------
import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { fmtDate, fmtSen } from '@2990s/shared';
import { useOwnFleetCosts, type OwnFleetCosts, type OwnFleetMonth, type OwnFleetRun } from '../../../vendor/scm/lib/delivery-rate-card-queries';
import { todayMyt } from '../../../vendor/scm/lib/dates';
import { DateField } from '../../../vendor/scm/components/DateField';
import { DataTable, type Column } from '../../../components/DataTable';
import { ResizableDrawer } from '../../../components/ResizableDrawer';
import { cn } from '../../../lib/utils';
import { BTN_PRI, CARD, Field, FilterBar, HINT, INPUT, Kpi, KpiStrip, TableCard } from './ui';
import { companySplit, defaultOwnFleetRange, jobsText, ownFleetTotals, perDo } from './ownFleet';
import { monthLabel } from '../../../vendor/scm/lib/report-monthly';

const money = (v: number) => <span className="tabular-nums">{fmtSen(v)}</span>;
const exportMoney = (v: number | null) => (v == null ? null : v / 100);

const MONTH_COLUMNS: Column<OwnFleetMonth>[] = [
  { key: 'month', label: 'Month', render: (m) => <span className="font-semibold">{monthLabel(m.month)}</span>, getValue: (m) => m.month },
  { key: 'trips', label: 'Trips', align: 'right', render: (m) => m.trips, getValue: (m) => m.trips },
  { key: 'dos', label: 'DOs', align: 'right', render: (m) => m.dos, getValue: (m) => m.dos },
  {
    key: 'cost', label: 'Own fleet cost', align: 'right', render: (m) => (m.pricedTrips ? money(m.costSen) : '—'),
    getValue: (m) => (m.pricedTrips ? m.costSen : null), exportValue: (m) => (m.pricedTrips ? exportMoney(m.costSen) : null), exportFormat: 'money',
  },
  {
    key: 'perdo', label: 'Own fleet per DO', align: 'right', render: (m) => fmtSen(perDo(m.deliveryCostSen, m.pricedDos)),
    getValue: (m) => perDo(m.deliveryCostSen, m.pricedDos), exportValue: (m) => exportMoney(perDo(m.deliveryCostSen, m.pricedDos)), exportFormat: 'money',
  },
  { key: 'tpl-dos', label: '3PL DOs', align: 'right', render: (m) => m.threePlDos, getValue: (m) => m.threePlDos },
  {
    key: 'tpl-billed', label: '3PL billed', align: 'right', render: (m) => (m.threePlDos ? money(m.threePlBilledSen) : '—'),
    getValue: (m) => m.threePlBilledSen, exportValue: (m) => exportMoney(m.threePlBilledSen), exportFormat: 'money',
  },
  {
    key: 'tpl-perdo', label: '3PL per DO', align: 'right', render: (m) => fmtSen(perDo(m.threePlBilledSen, m.threePlDos)),
    getValue: (m) => perDo(m.threePlBilledSen, m.threePlDos), exportValue: (m) => exportMoney(perDo(m.threePlBilledSen, m.threePlDos)), exportFormat: 'money',
  },
  {
    key: 'tpl-card', label: '3PL rate card', align: 'right', render: (m) => (m.threePlPricedDos ? money(m.threePlCardSen) : '—'),
    getValue: (m) => (m.threePlPricedDos ? m.threePlCardSen : null), exportValue: (m) => (m.threePlPricedDos ? exportMoney(m.threePlCardSen) : null), exportFormat: 'money',
  },
];

const RUN_COLUMNS: Column<OwnFleetRun>[] = [
  { key: 'date', label: 'Date', render: (r) => fmtDate(r.runDate), getValue: (r) => r.runDate, exportFormat: 'date' },
  { key: 'lorry', label: 'Lorry', render: (r) => <span className="font-semibold">{r.plate || '—'}</span>, getValue: (r) => r.plate },
  { key: 'trip', label: 'Trip', render: (r) => (r.tripNos.length ? r.tripNos.join(', ') : <span className="text-ink-muted">Last Mile</span>), getValue: (r) => r.tripNos.join(', ') },
  { key: 'dos', label: 'DOs', align: 'right', render: (r) => companySplit(r.dos), getValue: (r) => r.dos.length },
  { key: 'sets', label: 'Sets', align: 'right', render: (r) => r.setCount, getValue: (r) => r.setCount },
  { key: 'jobs', label: 'Other jobs', render: (r) => jobsText(r.jobs) || '—', getValue: (r) => jobsText(r.jobs) },
  { key: 'zone', label: 'Zone', render: (r) => r.zones.join(' · ') || '—', getValue: (r) => r.zones.join(' · ') },
  {
    key: 'cost', label: 'Cost', align: 'right',
    render: (r) => (r.costSen == null ? <span className="text-ink-muted">no card</span> : money(r.costSen)),
    getValue: (r) => r.costSen, exportValue: (r) => exportMoney(r.costSen), exportFormat: 'money',
  },
];

/* Nothing prices the trips yet: say why, and how to fix it. */
const NoOwnCard = ({ data, onCreate }: { data: OwnFleetCosts; onCreate: () => void }) => (
  <section aria-label="No own fleet card" className={cn(CARD, 'flex flex-wrap items-center justify-between gap-3 px-5 py-4')}>
    {data.severalCards.length > 1 ? (
      <p className="max-w-[760px] text-[13px] text-ink">
        <span className="font-semibold">{data.severalCards.length} own fleet cards are active</span> ({data.severalCards.map((c) => c.name).join(', ')}), so none of them prices the trips. Keep one active: open the other on Rate Cards, Edit settings, untick Active.
      </p>
    ) : (
      <>
        <p className="max-w-[760px] text-[13px] text-ink">
          <span className="font-semibold">No own fleet rate card yet.</span> The trips have no cost until you make one: Rate Cards, New Card, pick Own fleet / none, name it, then add its prices per category as you would for a 3PL. A job with no price on the card costs nothing.
        </p>
        <button type="button" className={BTN_PRI} onClick={onCreate}><Plus size={16} strokeWidth={1.75} />Create own fleet card</button>
      </>
    )}
  </section>
);

/* How one trip was priced: its orders and the card's lines. */
const RunDrawer = ({ run, onClose }: { run: OwnFleetRun; onClose: () => void }) => (
  <ResizableDrawer onClose={onClose} storageKey="carriers-own-fleet-trip" defaultWidth={480} ariaLabel="Own fleet trip"
    title={`${run.plate || 'Lorry'} · ${fmtDate(run.runDate)}`}
    subtitle={run.tripNos.length ? run.tripNos.join(', ') : 'Orders Last Mile put on the lorry'}>
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-semibold text-ink">{run.dos.length} {run.dos.length === 1 ? 'DO' : 'DOs'} · {run.setCount} sets</span>
        {run.dos.length > 0 && <p className={HINT}>{run.dos.map((d) => `${d.doNumber ?? d.doId}${d.companyCode ? ` (${d.companyCode})` : ''}`).join(', ')}</p>}
        {jobsText(run.jobs) && <p className={HINT}>Other jobs: {jobsText(run.jobs)}</p>}
      </div>
      {run.costSen == null ? (
        <p className="text-[13px] text-ink-muted">No own fleet card prices this lorry, so this trip has no cost.</p>
      ) : (
        <table className="w-full text-[13px]">
          <tbody>
            {run.lines.map((l, i) => (
              <tr key={i} className="border-b border-border">
                <td className="py-1.5 pr-3 text-ink">{l.label}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtSen(l.amountSen)}</td>
              </tr>
            ))}
            <tr>
              <td className="pt-2 font-semibold text-ink">Trip cost, {run.cardName}</td>
              <td className="pt-2 text-right font-semibold tabular-nums">{fmtSen(run.costSen)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  </ResizableDrawer>
);

export const OwnFleetView = ({ onCreateCard }: { onCreateCard: () => void }) => {
  const [range, setRange] = useState(() => defaultOwnFleetRange(todayMyt()));
  const [open, setOpen] = useState<OwnFleetRun | null>(null);
  const q = useOwnFleetCosts(range);
  const data = q.data ?? null;
  const t = useMemo(() => ownFleetTotals(data?.months ?? []), [data?.months]);
  const failed = q.isError ? `The own fleet trips did not load: ${(q.error as Error).message}` : null;

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[900px] text-[13px] text-ink-muted">
        Our own lorries, priced like a 3PL by the own fleet rate card. Each lorry&rsquo;s day is one trip, priced once: the sets of all its DOs on one ladder, the farthest zone once, each other job once. Beside it, what the 3PLs billed for DOs that ran the same days. Shown only: nothing is posted and nothing reaches COGS.
      </p>
      <FilterBar>
        {(['from', 'to'] as const).map((k) => (
          <Field key={k} label={k === 'from' ? 'From' : 'To'} className="min-w-[140px] flex-1 sm:w-[170px] sm:flex-none">
            <DateField className={INPUT} value={range[k]} onChange={(v) => setRange((s) => ({ ...s, [k]: v }))} fullWidth />
          </Field>
        ))}
        <span className={cn(HINT, 'pb-2.5')}>The day the lorry ran. At most 186 days at a time.</span>
      </FilterBar>

      {data && !data.card && <NoOwnCard data={data} onCreate={onCreateCard} />}

      {data && (
        <KpiStrip>
          <Kpi label="Own fleet trips" value={t.trips} sub={`${t.dos} DOs · ${t.sets} sets`} tone={null} />
          <Kpi label="Own fleet cost" value={t.pricedTrips ? fmtSen(t.costSen) : '—'}
            sub={t.pricedTrips === t.trips ? (data.card?.name ?? 'By the own fleet card') : `${t.pricedTrips} of ${t.trips} trips priced`} tone={null} />
          <Kpi label="Own fleet per DO" value={fmtSen(perDo(t.deliveryCostSen, t.pricedDos))} sub="Deliveries only, other jobs left out" tone={null} />
          <Kpi label="3PL billed per DO" value={fmtSen(perDo(t.threePlBilledSen, t.threePlDos))} sub={`${t.threePlDos} DOs · ${fmtSen(t.threePlBilledSen)}`} tone={null} />
        </KpiStrip>
      )}

      <TableCard title="By month" count={null} label={null} actions={null}
        hint="Own fleet per DO leaves the other jobs (ASSR, supplier, transfer) out, so it compares with what a 3PL bills for a DO.">
        <DataTable<OwnFleetMonth>
          tableId="own-fleet-months" exportName="own-fleet-by-month" exportXlsx
          columns={MONTH_COLUMNS} rows={data ? data.months : null} loading={q.isLoading} error={failed}
          emptyLabel="No own fleet trips or 3PL bills in range."
          getRowKey={(m) => m.month}
        />
      </TableCard>

      <TableCard title="Own fleet trips" count={data ? `(${data.runs.length})` : null} label={null} actions={null}
        hint="One lorry, one day: the DOs Last Mile put on it and its Delivery Planning jobs. Click a trip to see how it was priced. Sofa compartments and disposal are not on the order, so they are not priced.">
        <DataTable<OwnFleetRun>
          tableId="own-fleet-trips" exportName="own-fleet-trips" exportXlsx
          columns={RUN_COLUMNS} rows={data ? data.runs : null} loading={q.isLoading} error={failed}
          emptyLabel="No own fleet trips in range."
          getRowKey={(r) => r.key}
          onRowClick={setOpen}
        />
      </TableCard>

      {open && <RunDrawer run={open} onClose={() => setOpen(null)} />}
    </div>
  );
};
