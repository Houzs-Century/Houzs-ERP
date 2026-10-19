// Project Overview, the bottom lists (owner, 2026-10-17): live events behind
// schedule by checklist step, and finished events whose books are incomplete.
import { Panel, Th, Td, StepTabs } from "../../components/scm-v2/OverviewKit";
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

/* The books line by line, as in each event's Financial Snapshot (owner
   2026-10-19): which line is not keyed is the data problem, under the
   process problem (Events by stage) above. */
const BOOK_LINES: Array<[BookKey, string]> = [
  ["sales", "Sales"], ["cogs", "COGS"], ["rental", "Rental"], ["setup", "Setup"], ["transportFee", "Transport fee"],
  ["transportSetup", "Transport setup & dismantle"], ["commission", "Commission"], ["merchandise", "Merchandise"],
];
type BookKey = "sales" | "cogs" | "rental" | "setup" | "transportFee" | "transportSetup" | "commission" | "merchandise";
interface BookRow { id: number; name: string; brand: string | null; endDate: string; soSen: number; lines: Record<BookKey, number> }

/** Finished events and which lines of their books are still empty. */
export function ProjectDataGapsPanel({ onOpen }: { onOpen: (id: number) => void }) {
  const q = useQuery<DataGaps & { books: BookRow[] }>("/api/projects/data-gaps", () => api.get("/api/projects/data-gaps"));
  const [tab, setTab] = useState<string>("any");
  const g = q.data;
  if (q.error) return <div className="mb-4 rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px] text-err">Could not check the event books: {q.error}</div>;
  if (!g) return null;
  const missing = (r: BookRow) => BOOK_LINES.filter(([k]) => !(r.lines[k] > 0)).map(([k]) => k);
  const incomplete = g.books.filter((r) => missing(r).length > 0);
  const rows = incomplete.filter((r) => tab === "any" || missing(r).includes(tab as BookKey));
  const sen = (x: number) => money(x / 100);
  return (
    <Panel title="Books not complete" hint={`events that ended ${g.from} – ${g.to} (${g.books.length} events) · a red line has nothing keyed yet · the figures above read wrong until it is`}>
      <StepTabs value={tab} onChange={setTab}
        tabs={[["any", "Any line missing", incomplete.length, 0] as [string, string, number, number],
          ...BOOK_LINES.map(([k, label]) => [k, `${label} not keyed`, incomplete.filter((r) => missing(r).includes(k)).length, 0] as [string, string, number, number])]} />
      <div className="max-h-[460px] overflow-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-surface"><tr><Th left>Event</Th><Th>Ended</Th><Th>Sales Orders</Th>{BOOK_LINES.map(([k, l]) => <Th key={k}>{l}</Th>)}</tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className="cursor-pointer hover:bg-surface-2/50" onClick={() => onOpen(r.id)}>
              <Td left className="max-w-[300px] truncate text-primary">{r.name}</Td><Td>{r.endDate}</Td><Td className="text-ink-secondary">{sen(r.soSen)}</Td>
              {BOOK_LINES.map(([k]) => <Td key={k} className={r.lines[k] > 0 ? "" : "bg-err/5 font-semibold text-err"}>{r.lines[k] > 0 ? money(r.lines[k]) : "missing"}</Td>)}
            </tr>
          ))}
            {rows.length === 0 && <tr><Td left className="text-ink-muted">Every finished event has this line keyed.</Td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[11px] text-ink-muted">Sales Orders = what was sold at the event, for comparison when Sales is not keyed. Transport fee, commission and merchandise are auto rows (a % of sales) on the event page; they count as keyed once saved.</p>
    </Panel>
  );
}

interface LiveEvent {
  projectId: number; project: string; brand: string | null; start: string | null; end: string | null;
  setupCrew: string | null; setupStartAt: string | null;
  items: Array<{ title: string; status: string; review_status: string | null; due: string | null }>;
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
  /* Late is the checklist SLA (owner 2026-10-19): each task's own due date —
     event start + the days set on it in the template — not the tracker's
     fixed T-offsets. Days late = the task furthest past its date. */
  const rows = d.events.map((e) => {
    const st = projectStage(e.items, setupArrangedOf(e.setupCrew, e.setupStartAt), e.start, d.today);
    const mapped = e.items.filter((i) => (PROJECT_STAGES[st.currentIdx]?.titles ?? []).includes(i.title) && i.due);
    const stageDue = mapped.length ? mapped.map((i) => i.due as string).sort().at(-1) as string : st.deadline;
    return { e, st, stageDue, late: e.late[0]?.daysOver ?? 0 };
  }).sort((a, b) => b.late - a.late || String(a.e.start).localeCompare(String(b.e.start)));
  const behind = rows.filter((r) => r.late > 0);
  const s = search.trim().toLowerCase();
  const shown = rows.filter((r) => (tab === "all" || (tab === "behind" ? r.late > 0 : String(r.st.currentIdx) === tab))
    && (!s || r.e.project.toLowerCase().includes(s) || r.e.late.some((t) => t.title.toLowerCase().includes(s))));
  return (
    <Panel title={`Events by stage · ${rows.length} · ${behind.length} behind`} hint="every event not cancelled and not ended over 30 days ago · stage = the project page's tracker · late = a checklist task past its SLA date (event start + the days set on that task in the template) · red badge = how many are late · most late first"
      right={<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search event or task" className="h-8 w-56 rounded-md border border-border bg-surface px-2 text-[12.5px]" />}>
      <StepTabs tabs={[["all", "All", rows.length, behind.length] as [string, string, number, number], ["behind", "Behind", behind.length, 0] as [string, string, number, number],
        ...PROJECT_STAGES.map((st, i) => [String(i), st.label, rows.filter((r) => r.st.currentIdx === i).length, rows.filter((r) => r.st.currentIdx === i && r.late > 0).length] as [string, string, number, number])]}
        value={tab} onChange={setTab} />
      {shown.length === 0 ? <p className="text-[12.5px] text-ink-muted">No event here.</p> : (
        <div className="max-h-[520px] overflow-y-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface"><tr><Th left>Event</Th><Th>Starts</Th><Th left>Stage</Th><Th>Stage due (SLA)</Th><Th>Steps done</Th><Th left>Tasks past due</Th><Th>Days late</Th></tr></thead>
            <tbody>{shown.map(({ e, st, stageDue, late }) => (
              <tr key={e.projectId} className="cursor-pointer align-top hover:bg-surface-2/50" onClick={() => onOpen(e.projectId)}>
                <Td left className="max-w-[300px]"><span className="block truncate text-primary">{e.project}</span></Td>
                <Td>{e.start ?? "—"}</Td>
                <Td left className={!st.allDone && stageDue && stageDue < d.today ? "font-semibold text-err" : st.allDone ? "text-synced" : ""}>{PROJECT_STAGES[st.currentIdx]?.label}</Td>
                <Td className={!st.allDone && stageDue && stageDue < d.today ? "text-err" : ""}>{st.allDone ? "—" : stageDue ?? "—"}</Td>
                <Td>{st.allDone ? st.lastIdx : st.currentIdx} / {st.lastIdx}</Td>
                <Td left className="max-w-[340px] text-[12px] text-ink-secondary">
                  {e.late.slice(0, 3).map((t) => <span key={t.title + t.due} className="block truncate">{t.title} <span className="text-ink-muted">· {t.daysOver} d</span></span>)}
                  {e.late.length > 3 && <span className="text-ink-muted">+{e.late.length - 3} more</span>}
                  {e.late.length === 0 && <span className="text-ink-muted">—</span>}
                </Td>
                <Td>{late === 0 ? <span className="text-[11.5px] text-synced">on time</span> : <span className="rounded-full bg-err/10 px-2 py-0.5 text-[11.5px] font-semibold text-err">{late} d</span>}</Td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
