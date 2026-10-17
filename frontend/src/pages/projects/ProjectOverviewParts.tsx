// Project Overview, the bottom lists (owner, 2026-10-17): live events behind
// schedule by checklist step, and finished events whose books are incomplete.
import { Panel, Th, Td } from "../../components/scm-v2/OverviewKit";
import { useState } from "react";
import { formatCurrency, cn } from "../../lib/utils";
import { PROJECT_STAGES, projectStage, setupArrangedOf } from "./projectStage";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";

// Money reads like AutoCount everywhere: "RM 15,000.00" (owner 2026-09-15).
const money = formatCurrency;

interface GapRow { id: number; code: string; name: string; brand: string | null; endDate: string; income: number; cost: number; soSen: number }
interface DataGaps {
  from: string; to: string; ended: number;
  noSales: { count: number; costBooked: number; soSen: number; rows: GapRow[] };
  noCogs: { count: number; salesAffected: number; rows: GapRow[] };
  noCommission: { count: number; salesAffected: number; rows: GapRow[] };
  byMonth: Array<{ month: string; ended: number; withSales: number }>;
}

type GapTab = "noSales" | "noCogs" | "noCommission";
const GAP_TABS: Array<[GapTab, string, string]> = [
  ["noSales", "No sales keyed", "Sales not keyed in the books, so the page falls back to its Sales Orders"],
  ["noCogs", "Sales, no COGS", "Gross profit reads too high"],
  ["noCommission", "Sales, no commission", "Net profit reads too high"],
];

/** Finished events whose books are incomplete, listed so it is clear which
 *  event still owes which line (owner 2026-10-17). */
export function ProjectDataGapsPanel({ onOpen }: { onOpen: (id: number) => void }) {
  const q = useQuery<DataGaps>("/api/projects/data-gaps", () => api.get("/api/projects/data-gaps"));
  const [tab, setTab] = useState<GapTab>("noSales");
  const g = q.data;
  if (q.error) return <div className="mb-4 rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px] text-err">Could not check the event books: {q.error}</div>;
  if (!g || (g.noSales.count === 0 && g.noCogs.count === 0 && g.noCommission.count === 0)) return null;
  const sen = (s: number) => money(s / 100);
  const rows = g[tab].rows;
  return (
    <Panel title="Books not complete" hint={`events that ended ${g.from} – ${g.to} (${g.ended} events) · each one listed here makes the figures above read wrong until its books are keyed`}>
      <StepTabs tabs={GAP_TABS.map(([k, label]) => [k, label, g[k].count])} value={tab} onChange={(k) => setTab(k as GapTab)} />
      <p className="mb-2 text-[12px] text-ink-muted">{GAP_TABS.find(([k]) => k === tab)?.[2]}.</p>
      <div className="max-h-[420px] overflow-y-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-surface"><tr><Th left>Event</Th><Th left>Brand</Th><Th>Ended</Th><Th>Sales keyed</Th><Th>Cost keyed</Th><Th>Sales Orders at the event</Th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className="cursor-pointer hover:bg-surface-2/50" onClick={() => onOpen(r.id)}>
              <Td left className="max-w-[340px] truncate text-primary">{r.name}</Td><Td left className="text-ink-secondary">{r.brand ?? "—"}</Td>
              <Td>{r.endDate}</Td><Td className={r.income > 0 ? "" : "text-err"}>{money(r.income)}</Td><Td>{money(r.cost)}</Td><Td>{sen(r.soSen)}</Td>
            </tr>))}</tbody>
        </table>
      </div>
      {g[tab].count > rows.length && <p className="mt-1 text-[11px] text-ink-muted">{rows.length} of {g[tab].count}.</p>}
    </Panel>
  );
}

/** Pill tabs with a count, like the production overdue screen. */
export function StepTabs({ tabs, value, onChange }: { tabs: Array<[string, string, number]>; value: string; onChange: (k: string) => void }) {
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {tabs.map(([k, label, n]) => (
        <button key={k} type="button" onClick={() => onChange(k)}
          className={cn("rounded-full border px-3 py-1 text-[12px]", value === k ? "border-primary bg-primary text-white" : "border-border text-ink-secondary hover:bg-surface-2")}>
          {label} <span className="ml-1 tabular-nums opacity-80">{n}</span>
        </button>
      ))}
    </div>
  );
}

interface LiveEvent {
  projectId: number; project: string; brand: string | null; start: string | null; end: string | null;
  setupCrew: string | null; setupStartAt: string | null;
  items: Array<{ title: string; status: string; review_status: string | null }>;
  pending: number; late: Array<{ title: string; role: string | null; due: string; daysOver: number }>;
}

/** Every live event by its project stage (owner 2026-10-17), the same 9-step
 *  tracker as the project page: the stage it is at, its deadline (event start
 *  + the stage's T-offset), how late, and its checklist tasks past due. */
export function ProjectStuckPanel({ onOpen }: { onOpen: (id: number) => void }) {
  const q = useQuery<{ today: string; events: LiveEvent[] }>("/api/projects/overview/tasks", () => api.get("/api/projects/overview/tasks"));
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const d = q.data;
  if (q.error) return <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px] text-err">Could not load the event tasks: {q.error}</div>;
  if (!d) return null;
  const rows = d.events.map((e) => ({ e, st: projectStage(e.items, setupArrangedOf(e.setupCrew, e.setupStartAt), e.start, d.today) }))
    .sort((a, b) => b.st.daysLate - a.st.daysLate || String(a.e.start).localeCompare(String(b.e.start)));
  const behind = rows.filter((r) => r.st.daysLate > 0);
  const s = search.trim().toLowerCase();
  const shown = rows.filter((r) => (tab === "all" || (tab === "behind" ? r.st.daysLate > 0 : String(r.st.currentIdx) === tab))
    && (!s || r.e.project.toLowerCase().includes(s) || r.e.late.some((t) => t.title.toLowerCase().includes(s))));
  return (
    <Panel title={`Events by stage · ${rows.length} · ${behind.length} behind`} hint="every event not cancelled and not ended over 30 days ago · stage = the project page's tracker (Floorplan T-21 … Event complete T+7) · late = today past the current stage's deadline · most late first"
      right={<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search event or task" className="h-8 w-56 rounded-md border border-border bg-surface px-2 text-[12.5px]" />}>
      <StepTabs tabs={[["all", "All", rows.length] as [string, string, number], ["behind", "Behind", behind.length] as [string, string, number],
        ...PROJECT_STAGES.map((st, i) => [String(i), `${st.label} ${st.offset >= 0 ? `T+${st.offset}` : `T${st.offset}`}`, rows.filter((r) => r.st.currentIdx === i).length] as [string, string, number])]}
        value={tab} onChange={setTab} />
      {shown.length === 0 ? <p className="text-[12.5px] text-ink-muted">No event here.</p> : (
        <div className="max-h-[520px] overflow-y-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface"><tr><Th left>Event</Th><Th>Starts</Th><Th left>Stage</Th><Th>Stage deadline</Th><Th>Steps done</Th><Th left>Tasks past due</Th><Th>Days late</Th></tr></thead>
            <tbody>{shown.map(({ e, st }) => (
              <tr key={e.projectId} className="cursor-pointer align-top hover:bg-surface-2/50" onClick={() => onOpen(e.projectId)}>
                <Td left className="max-w-[300px]"><span className="block truncate text-primary">{e.project}</span></Td>
                <Td>{e.start ?? "—"}</Td>
                <Td left className={st.daysLate > 0 ? "font-semibold text-err" : st.allDone ? "text-synced" : ""}>{PROJECT_STAGES[st.currentIdx]?.label}</Td>
                <Td>{st.allDone ? "—" : st.deadline ?? "—"}</Td>
                <Td>{st.allDone ? st.lastIdx : st.currentIdx} / {st.lastIdx}</Td>
                <Td left className="max-w-[340px] text-[12px] text-ink-secondary">
                  {e.late.slice(0, 3).map((t) => <span key={t.title + t.due} className="block truncate">{t.title} <span className="text-ink-muted">· {t.daysOver} d</span></span>)}
                  {e.late.length > 3 && <span className="text-ink-muted">+{e.late.length - 3} more</span>}
                  {e.late.length === 0 && <span className="text-ink-muted">—</span>}
                </Td>
                <Td>{st.daysLate === 0 ? <span className="text-[11.5px] text-synced">on time</span> : <span className={cn("rounded-full px-2 py-0.5 text-[11.5px] font-semibold", st.daysLate >= 7 ? "bg-err/10 text-err" : "bg-warning-bg text-warning-text")}>{st.daysLate} d</span>}</Td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
