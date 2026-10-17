// Project Overview, the bottom lists (owner, 2026-10-17): live events behind
// schedule by checklist step, and finished events whose books are incomplete.
import { Panel, Th, Td } from "../../components/scm-v2/OverviewKit";
import { useState } from "react";
import { formatCurrency, cn } from "../../lib/utils";
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

interface StuckEvent {
  projectId: number; project: string; brand: string | null; start: string | null; end: string | null;
  stepsDone: number; steps: number; waitingAt: string | null; pending: number; daysOver: number;
  late: Array<{ title: string; step: string; role: string | null; due: string; daysOver: number; waitingReview: boolean }>;
}
const titleStep = (s: string) => s.toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase()).replace(/ — /g, " · ");

/** Live events behind schedule (owner 2026-10-17): which step each is waiting
 *  at, how many steps are done, and its tasks past their SLA due date. */
export function ProjectStuckPanel({ onOpen }: { onOpen: (id: number) => void }) {
  const q = useQuery<{ today: string; steps: string[]; events: StuckEvent[] }>("/api/projects/overview/tasks", () => api.get("/api/projects/overview/tasks"));
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const d = q.data;
  if (q.error) return <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px] text-err">Could not load the event tasks: {q.error}</div>;
  if (!d) return null;
  const s = search.trim().toLowerCase();
  const shown = d.events.filter((e) => (tab === "all" || e.waitingAt === tab) && (!s || e.project.toLowerCase().includes(s) || e.late.some((t) => t.title.toLowerCase().includes(s))));
  return (
    <Panel title={`Events behind schedule · ${d.events.length}`} hint="live events with a checklist task past its due date (the SLA: event start + the days set on that task in the checklist template) · most late first · waiting at = the first step not done"
      right={<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search event or task" className="h-8 w-56 rounded-md border border-border bg-surface px-2 text-[12.5px]" />}>
      <StepTabs tabs={[["all", "All", d.events.length] as [string, string, number], ...d.steps.map((st) => [st, titleStep(st), d.events.filter((e) => e.waitingAt === st).length] as [string, string, number])]} value={tab} onChange={setTab} />
      {shown.length === 0 ? <p className="text-[12.5px] text-ink-muted">Nothing behind schedule here.</p> : (
        <div className="max-h-[520px] overflow-y-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface"><tr><Th left>Event</Th><Th>Starts</Th><Th left>Waiting at</Th><Th>Steps done</Th><Th left>Tasks past due</Th><Th>Days late</Th></tr></thead>
            <tbody>{shown.map((e) => (
              <tr key={e.projectId} className="cursor-pointer align-top hover:bg-surface-2/50" onClick={() => onOpen(e.projectId)}>
                <Td left className="max-w-[300px]"><span className="block truncate text-primary">{e.project}</span></Td>
                <Td>{e.start ?? "—"}</Td>
                <Td left>{e.waitingAt ? titleStep(e.waitingAt) : "—"}</Td>
                <Td>{e.stepsDone} / {e.steps}</Td>
                <Td left className="max-w-[360px] text-[12px] text-ink-secondary">
                  {e.late.slice(0, 3).map((t) => <span key={t.title + t.due} className="block truncate">{t.title} <span className="text-ink-muted">· {t.daysOver} d{t.waitingReview ? " · waiting review" : ""}</span></span>)}
                  {e.late.length > 3 && <span className="text-ink-muted">+{e.late.length - 3} more</span>}
                </Td>
                <Td><span className={cn("rounded-full px-2 py-0.5 text-[11.5px] font-semibold", e.daysOver >= 7 ? "bg-err/10 text-err" : "bg-warning-bg text-warning-text")}>{e.daysOver} d</span></Td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
