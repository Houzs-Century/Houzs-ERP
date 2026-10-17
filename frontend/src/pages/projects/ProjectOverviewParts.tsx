// Project Overview: the finished events whose books are incomplete (owner,
// 2026-10-17), shown under the overview so its figures can be read honestly.
import { Panel, Th, Td } from "../../components/scm-v2/OverviewKit";
import { Columns, Tile, TONE } from "../../components/scm-v2/Charts";
import { formatCurrency } from "../../lib/utils";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";

// Money reads like AutoCount everywhere: "RM 15,000.00" (owner 2026-09-15).
const money = formatCurrency;
const monthLabel = (k: string) => `${k.slice(2, 4)}/${k.slice(5, 7)}`;

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
