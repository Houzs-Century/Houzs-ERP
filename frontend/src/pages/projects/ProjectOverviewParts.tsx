// Project Overview (owner, 2026-10-16/17): the headline P&L of every project in
// a period, the Monthly / Quarterly / Yearly picker that sets the period, the
// period in charts, and the finished events whose books are incomplete.
import { Panel, Th, Td } from "../../components/scm-v2/OverviewKit";
import { DashboardPeriodPicker, resolvePeriod } from "../../components/scm-v2/DashboardPeriod";
import { Donut, Columns, HBars, SplitBar, Tile, TONE, PALETTE } from "../../components/scm-v2/Charts";
import { formatCurrency } from "../../lib/utils";
import { todayMyt } from "../../vendor/scm/lib/dates";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import type { ProfitabilityResponse } from "./financeViewModel";

const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—");
// Money reads like AutoCount everywhere: "RM 15,000.00" (owner 2026-09-15).
const money = formatCurrency;
const monthLabel = (k: string) => `${k.slice(2, 4)}/${k.slice(5, 7)}`;

/** Sales, COGS, GP, rental, other cost and NP, each with its share of sales. */
export function ProjectOverviewHeadline({ totals }: { totals: ProfitabilityResponse["totals"] }) {
  const t = totals;
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <Tile label="Sales" value={formatCurrency(t.income)} note={`${t.projects.toLocaleString()} projects`} tone="main" trend={null} onClick={null} />
      <Tile label="COGS" value={formatCurrency(t.cogs)} note={`${pct(t.cogs, t.income)} of sales`} tone="brass" trend={null} onClick={null} />
      <Tile label="Gross profit" value={formatCurrency(t.gp)} note={`GP ${pct(t.gp, t.income)}`} tone={t.gp >= 0 ? "good" : "bad"} trend={null} onClick={null} />
      <Tile label="Rental" value={formatCurrency(t.rental)} note={`${pct(t.rental, t.income)} of sales`} tone="warn" trend={null} onClick={null} />
      <Tile label="Other cost" value={formatCurrency(t.cost - t.rental)} note="Setup, transport, commission…" tone="warn" trend={null} onClick={null} />
      <Tile label="Net profit" value={formatCurrency(t.profit)} note={`NP ${pct(t.profit, t.income)}`} tone={t.profit >= 0 ? "good" : "bad"} trend={null} onClick={null} />
    </div>
  );
}

/** The dashboard period picker over the page's own From / To. A cleared range
 *  (all dates) shows as such until a period is picked. */
export function ProjectPeriodBar({ dateFrom, dateTo, onRange }: { dateFrom: string; dateTo: string; onRange: (from: string, to: string) => void }) {
  const today = todayMyt();
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <DashboardPeriodPicker period={resolvePeriod(dateFrom, dateTo, today)} today={today} onChange={onRange} />
      {(!dateFrom || !dateTo) && <span className="text-[11.5px] text-ink-muted">Showing every date — pick a period to narrow it.</span>}
    </div>
  );
}

type Breakdown = ProfitabilityResponse["by_organizer"];

/** The period in pictures: sales mix by brand and event type, the monthly P&L,
 *  and which organizers and venues make or lose money. */
export function ProjectOverviewCharts({ d, onDrill }: { d: ProfitabilityResponse; onDrill: (dim: "organizer" | "venue", key: string) => void }) {
  const months = d.by_month.slice().sort((a, b) => a.key.localeCompare(b.key));
  const ranked = (rows: Breakdown, dim: "organizer" | "venue") => {
    const s = rows.slice().sort((a, b) => b.profit - a.profit);
    const shown = s.length > 10 ? [...s.slice(0, 5), ...s.slice(-5)] : s;
    return shown.map((r) => ({
      key: r.key, label: `${r.key} · ${r.count}`, value: r.profit, color: r.profit < 0 ? TONE.bad : TONE.good,
      right: <>{money(r.profit)}<span className="ml-1.5 text-[11px] text-ink-muted">{r.margin != null ? `${r.margin.toFixed(0)}%` : ""}</span></>,
      onClick: () => onDrill(dim, r.key),
    }));
  };
  return (
    <div className="mb-4 space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Sales by brand" hint={`${d.by_brand.length} brands`}>
          <Donut size={124} format={money} center={{ value: String(d.by_brand.length), label: "brands" }}
            data={d.by_brand.slice().sort((a, b) => b.income - a.income).map((r) => ({ label: r.key, value: r.income, color: null }))} />
        </Panel>
        <Panel title="Where each ringgit of sales goes">
          <SplitBar format={money} parts={[
            { label: "COGS", value: d.totals.cogs, color: PALETTE[1]! },
            { label: "Rental", value: d.totals.rental, color: PALETTE[2]! },
            { label: "Other cost", value: Math.max(0, d.totals.cost - d.totals.rental), color: PALETTE[3]! },
            { label: "Net profit", value: Math.max(0, d.totals.profit), color: TONE.good },
          ]} />
          <div className="mt-4 text-[12px] font-semibold text-ink">Sales by event type</div>
          <div className="mt-1.5"><SplitBar format={money} parts={d.by_event_type.map((r) => ({ label: r.key, value: r.income, color: null }))} /></div>
        </Panel>
      </div>
        <Panel title="Monthly P&L" hint="bars: sales, COGS, other cost · line: NP %">
          <Columns height={220} stacked={false} format={money} highlight={null} labels={months.map((m) => monthLabel(m.key))}
            series={[{ name: "Sales", color: PALETTE[0]! }, { name: "COGS", color: PALETTE[1]! }, { name: "Other cost", color: PALETTE[2]! }]}
            values={[months.map((m) => m.income), months.map((m) => m.cogs), months.map((m) => m.cost)]}
            line={{ name: "NP %", color: TONE.bad, values: months.map((m) => (m.income > 0 ? (m.profit / m.income) * 100 : null)), format: (x) => `${x.toFixed(1)}%` }} />
        </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Net profit by organizer" hint="best 5 and worst 5 · click to open below">
          <HBars format={money} empty="No organizer in this period." rows={ranked(d.by_organizer, "organizer")} />
        </Panel>
        <Panel title="Net profit by venue" hint="best 5 and worst 5 · click to open below">
          <HBars format={money} empty="No venue in this period." rows={ranked(d.by_venue, "venue")} />
        </Panel>
      </div>
    </div>
  );
}

interface GapRow { id: number; code: string; name: string; brand: string | null; endDate: string; income: number; cost: number; soSen: number }
interface DataGaps {
  from: string; to: string; ended: number;
  noSales: { count: number; costBooked: number; soSen: number; rows: GapRow[] };
  noCogs: { count: number; salesAffected: number; rows: GapRow[] };
  noCommission: { count: number; salesAffected: number; rows: GapRow[] };
  byMonth: Array<{ month: string; ended: number; withSales: number }>;
}

/** Finished events whose books are incomplete, so Project Overview reads wrong. */
export function ProjectDataGapsPanel({ onOpen }: { onOpen: (id: number) => void }) {
  const q = useQuery<DataGaps>("/api/projects/data-gaps", () => api.get("/api/projects/data-gaps"));
  const g = q.data;
  if (q.error) return <div className="mb-4 rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px] text-err">Could not check the event books: {q.error}</div>;
  if (!g || (g.noSales.count === 0 && g.noCogs.count === 0 && g.noCommission.count === 0)) return null;
  const sen = (s: number) => money(s / 100);
  return (
    <div className="mb-4">
      <Panel title="Books not complete" hint={`events that ended ${g.from} – ${g.to} · these make the figures on this page read wrong`}>
        <div className="grid gap-4 xl:grid-cols-[1fr_1.3fr]">
          <div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Tile label="No sales keyed" value={`${g.noSales.count} / ${g.ended}`} note={`${sen(g.noSales.soSen)} of Sales Orders opened at them`} tone={g.noSales.count ? "bad" : "good"} trend={null} onClick={null} />
              <Tile label="Sales, no COGS" value={String(g.noCogs.count)} note={`${money(g.noCogs.salesAffected)} sales · GP overstated`} tone={g.noCogs.count ? "warn" : "good"} trend={null} onClick={null} />
              <Tile label="Sales, no commission" value={String(g.noCommission.count)} note={`${money(g.noCommission.salesAffected)} sales · NP overstated`} tone={g.noCommission.count ? "warn" : "good"} trend={null} onClick={null} />
            </div>
            <div className="mt-3">
              <Columns height={160} stacked format={(x) => `${x} events`} highlight={null} line={null}
                labels={g.byMonth.map((m) => monthLabel(m.month))}
                series={[{ name: "Sales keyed", color: TONE.good }, { name: "No sales keyed", color: TONE.bad }]}
                values={[g.byMonth.map((m) => m.withSales), g.byMonth.map((m) => m.ended - m.withSales)]} />
            </div>
          </div>
          <div>
            <div className="mb-1 text-[12px] font-semibold text-ink">Ended, no sales keyed · biggest first</div>
            <table className="w-full border-collapse">
              <thead><tr><Th left>Event</Th><Th>Ended</Th><Th>Cost booked</Th><Th>Sales Orders</Th></tr></thead>
              <tbody>{g.noSales.rows.slice(0, 10).map((r) => (
                <tr key={r.id} className="cursor-pointer hover:bg-surface-2/50" onClick={() => onOpen(r.id)}>
                  <Td left className="max-w-[260px] truncate text-primary">{r.name}</Td><Td>{r.endDate.slice(5)}</Td><Td>{money(r.cost)}</Td><Td>{sen(r.soSen)}</Td>
                </tr>))}</tbody>
            </table>
            {g.noSales.count > 10 && <p className="mt-1 text-[11px] text-ink-muted">10 of {g.noSales.count}. Cost already booked on them: {money(g.noSales.costBooked)}.</p>}
          </div>
        </div>
      </Panel>
    </div>
  );
}
