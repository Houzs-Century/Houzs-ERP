// Project Overview, the bottom lists (owner, 2026-10-17): live events behind
// schedule by checklist step, and finished events whose books are incomplete.
import { Panel, Th, Td, StepTabs } from "../../components/scm-v2/OverviewKit";
import { useState } from "react";
import { formatCurrency, cn } from "../../lib/utils";
import { PROJECT_STAGES, projectStage, setupArrangedOf, driverKeyedOf } from "./projectStage";
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

/* What makes an event's P&L read wrong (owner 2026-10-20), three problems:
   Sales Orders not daily (per bill of the chat sales report: not opened, or
   opened under another event and to be moved), Rental (none keyed, or keyed
   with no sales against it), and No chat sales report (per event). */
interface ProblemBill { ref: string; amountSen: number; salesperson: string | null; problem: "not_opened" | "other_event"; soDocNo: string | null; otherEvent: string | null }
interface BookRow {
  id: number; code: string; name: string; brand: string | null; endDate: string; soSen: number; soDocs: string[];
  hasReport: boolean; reportBills: number; problemBills: ProblemBill[];
  /** The P&L's rental (Finance's books or a typed line), in RM. */
  rental: number;
}
type BooksTab = "daily" | "nocogs" | "rental" | "report";
/** A Sales Order of a recent event with a product line at no cost - its SKU has no cost in Product Maintenance. */
interface SoNoCogs { docNo: string; projectId: number; event: string; code: string; startDate: string; endDate: string; amountSen: number; items: string[] }
/** An event of the last 180 days whose chat report holds bills not opened under it. */
interface NotDailyEvent { id: number; code: string; name: string; startDate: string; endDate: string; reportBills: number; bills: ProblemBill[] }

/** Finished events and what still makes their P&L wrong. */
export function ProjectDataGapsPanel({ onOpen }: { onOpen: (id: number) => void }) {
  const q = useQuery<DataGaps & { books: BookRow[]; notDaily: NotDailyEvent[]; soNoCogs: SoNoCogs[]; recentFrom: string }>("/api/projects/data-gaps", () => api.get("/api/projects/data-gaps"));
  const [tab, setTab] = useState<BooksTab>("daily");
  const g = q.data;
  if (q.error) return <div className="mb-4 rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px] text-err">Could not check the event books: {q.error}</div>;
  if (!g) return null;
  const sen = (x: number) => money(x / 100);
  const bills = g.notDaily.flatMap((r) => r.bills.map((b) => ({ r, b })));
  const rentalRows = g.books.filter((r) => !(r.rental > 0) || !(r.soSen > 0));
  const noReport = g.books.filter((r) => !r.hasReport);
  /* One line per row (owner 2026-10-20: "不需要两排"): the event's name, its code on hover. */
  const eventCell = (r: { name: string; code: string }) => <Td left className="max-w-[320px] truncate"><span className="text-primary" title={r.code}>{r.name}</span></Td>;
  return (
    <Panel title="Books not complete" hint={`events that ended ${g.from} – ${g.to} (${g.books.length} events) · what still makes the P&L above read wrong`}>
      <StepTabs value={tab} onChange={(v) => setTab(v as BooksTab)}
        tabs={[["daily", "Sales Orders not daily", bills.length, 0], ["nocogs", "SO no COGS", g.soNoCogs.length, 0], ["rental", "Rental missing or no sales", rentalRows.length, 0], ["report", "No chat sales report", noReport.length, 0]] as Array<[string, string, number, number]>} />
      <div className="max-h-[460px] overflow-auto">
        {tab === "daily" && (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface"><tr><Th left>Event</Th><Th>Dates</Th><Th left>Bill</Th><Th>Amount</Th><Th left>Salesperson</Th><Th left>Problem</Th></tr></thead>
            <tbody>{bills.map(({ r, b }, i) => {
              /* An event's name and dates once, on its first bill; its other bills under it. */
              const first = i === 0 || bills[i - 1]!.r.id !== r.id;
              return (
              <tr key={`${r.id}-${b.ref}-${i}`} className={cn("cursor-pointer hover:bg-surface-2/50", first && i > 0 && "border-t-2 border-border")} onClick={() => onOpen(r.id)}>
                {first ? eventCell(r) : <Td left> </Td>}
                <Td>{first ? `${r.startDate.slice(5)}${r.endDate && r.endDate !== r.startDate ? ` – ${r.endDate.slice(5)}` : ""}` : ""}</Td><Td left className="font-mono">{b.ref}</Td><Td>{sen(b.amountSen)}</Td><Td left>{b.salesperson ?? "—"}</Td>
                <Td left className={b.problem === "not_opened" ? "font-semibold text-err" : "text-warning-text"}>
                  {b.problem === "not_opened" ? "Not opened as a Sales Order" : <>Opened under another event · <span className="font-mono">{b.soDocNo}</span> under {b.otherEvent} — move it</>}
                </Td>
              </tr>
              );
            })}
              {bills.length === 0 && <tr><Td left className="text-ink-muted">Every reported bill is opened under its event.</Td></tr>}
            </tbody>
          </table>
        )}
        {tab === "nocogs" && (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface"><tr><Th left>Event</Th><Th>Dates</Th><Th left>Sales Order</Th><Th>Amount</Th><Th left>SKU with no cost</Th></tr></thead>
            <tbody>{g.soNoCogs.map((o, i) => {
              const first = i === 0 || g.soNoCogs[i - 1]!.projectId !== o.projectId;
              return (
                <tr key={o.docNo} className={cn("cursor-pointer hover:bg-surface-2/50", first && i > 0 && "border-t-2 border-border")} onClick={() => onOpen(o.projectId)}>
                  {first ? eventCell({ name: o.event, code: o.code }) : <Td left> </Td>}
                  <Td>{first ? `${o.startDate.slice(5)}${o.endDate && o.endDate !== o.startDate ? ` – ${o.endDate.slice(5)}` : ""}` : ""}</Td>
                  <Td left className="font-mono">{o.docNo}</Td><Td>{sen(o.amountSen)}</Td>
                  <Td left className="max-w-[360px] truncate text-err"><span title={o.items.join(", ")}>{o.items.join(", ")}</span></Td>
                </tr>
              );
            })}
              {g.soNoCogs.length === 0 && <tr><Td left className="text-ink-muted">Every order line of these events carries a cost.</Td></tr>}
            </tbody>
          </table>
        )}
        {tab === "rental" && (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface"><tr><Th left>Event</Th><Th>Ended</Th><Th>Rental</Th><Th>Sales Orders</Th><Th left>Problem</Th></tr></thead>
            <tbody>{rentalRows.map((r) => (
              <tr key={r.id} className="cursor-pointer hover:bg-surface-2/50" onClick={() => onOpen(r.id)}>
                {/* A rental below zero shows its figure, never "missing" (owner
                    2026-10-22: 下面写missing，但是上面是有amount的). */}
                {eventCell(r)}<Td>{r.endDate}</Td><Td className={r.rental > 0 ? "" : "font-semibold text-err"}>{r.rental !== 0 && Number.isFinite(r.rental) ? money(r.rental) : "missing"}</Td>
                <Td className={r.soSen > 0 ? "" : "font-semibold text-err"}>{sen(r.soSen)}</Td>
                <Td left className="text-err">{r.rental < 0 ? "Rental below zero" : !(r.rental > 0) ? "No rental keyed" : "Rental keyed, no sales"}</Td>
              </tr>
            ))}
              {rentalRows.length === 0 && <tr><Td left className="text-ink-muted">Every finished event has its rental and sales.</Td></tr>}
            </tbody>
          </table>
        )}
        {tab === "report" && (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface"><tr><Th left>Event</Th><Th>Ended</Th><Th>Sales Orders</Th></tr></thead>
            <tbody>{noReport.map((r) => (
              <tr key={r.id} className="cursor-pointer hover:bg-surface-2/50" onClick={() => onOpen(r.id)}>
                {eventCell(r)}<Td>{r.endDate}</Td><Td>{sen(r.soSen)}</Td>
              </tr>
            ))}
              {noReport.length === 0 && <tr><Td left className="text-ink-muted">Every finished event has a chat sales report.</Td></tr>}
            </tbody>
          </table>
        )}
      </div>
      <p className="mt-1 text-[11px] text-ink-muted">Not daily = a bill in the event chat&apos;s sales report that is not a Sales Order under this event, matched as the event page matches it; every event since {g.recentFrom}, running ones included. Rental and chat report: the finished events above. Sales = the Sales Orders opened at the event. Click a row to open the event.</p>
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
    const st = projectStage(e.items, setupArrangedOf(e.setupCrew, e.setupStartAt), driverKeyedOf(e.setupCrew), e.start, d.today);
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
                <Td left className="max-w-[340px] truncate text-[12px] text-ink-secondary">
                  {/* One line: the most overdue task, the rest on hover. */}
                  {e.late.length === 0 ? <span className="text-ink-muted">—</span> : (
                    <span title={e.late.map((t) => `${t.title} · ${t.daysOver} d`).join("\n")}>
                      {e.late[0]!.title} <span className="text-ink-muted">· {e.late[0]!.daysOver} d{e.late.length > 1 ? ` · +${e.late.length - 1} more` : ""}</span>
                    </span>
                  )}
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
