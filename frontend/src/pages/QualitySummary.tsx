// Quality Overview · the top (owner, 2026-10-17). Every performance figure
// follows the picked period, so it shows how the team does NOW:
//   opened / closed in the period; average to close over the cases OPENED in
//   the period; time per stage over the stages that ENDED in it; suppliers'
//   cases against the items received from them in the same period. The open
//   cases, their age and the overdue list are as of today.
// Data: GET /api/assr/quality-overview (backend routes/lib/assr-quality.ts).
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import { Panel, Th, Td } from "../components/scm-v2/OverviewKit";
import { Columns, HBars, Tile, TONE, PALETTE } from "../components/scm-v2/Charts";

type StageDays = Partial<Record<string, { avgDays: number | null; cases: number }>>;
type Supplier = {
  creditor: string; name: string; receivedQty: number; receivedLines: number; cases: number; items: number;
  ratePct: number | null; open: number; overdue: number; closed: number; avgDaysToClose: number | null; stageDays: StageDays;
};
type Overdue = {
  id: number; assrNo: string | null; customer: string | null; supplier: string | null; stage: string;
  enteredAt: string; targetDays: number; daysInStage: number; daysOver: number; caseAgeDays: number;
};
type Quality = {
  opened: number; closed: number; ongoingNow: number; openedStillOpen: number;
  avgDaysToClose: number | null; avgDaysToCloseCases: number; stageDays: StageDays;
  ages: Array<{ label: string; count: number }>;
  trend: Array<{ month: string; opened: number; closed: number; backlog: number }>;
  overdue: Overdue[]; suppliers: Supplier[]; unattributed: number;
};

const STAGES: Array<[string, string]> = [
  ["pending_review", "Review"], ["under_verification", "Verification"], ["pending_solution", "Solution"],
  ["pending_supplier_pickup", "Pickup / Return"], ["pending_item_ready", "Item ready"], ["pending_delivery_service", "Delivery / Service"],
];
const stageLabel = (k: string) => STAGES.find(([s]) => s === k)?.[1] ?? k.replace(/_/g, " ");
const dayTxt = (x: number | null | undefined) => (x == null ? "—" : `${x} days`);
/* A rate over 100% means the receipts sit under another supplier code (e.g. a
   renamed company), not that every item came back. */
const rateTxt = (x: number | null) => (x == null ? "no goods received" : x > 100 ? "check code" : `${x}%`);
const AGE_COLOR = ["#4f8a5b", "#7fa86a", "#c9a77c", "#d9b25c", TONE.warn, TONE.bad, "#8f2d2d"];

export function QualitySummary({ from, to, periodLabel, breachNow, funnel, onDrill }: {
  from: string; to: string; periodLabel: string; breachNow: number | null; funnel: ReactNode; onDrill: (metric: string) => void;
}) {
  const q = useQuery<Quality>("/api/assr/quality-overview?from=:&to=:", () => api.get(`/api/assr/quality-overview?from=${from}&to=${to}`), [from, to]);
  const d = q.data;
  const [stageTab, setStageTab] = useState<string>("all");
  const v = (x: number | undefined) => (d && x != null ? x.toLocaleString() : "…");
  const openTotal = d ? d.ages.reduce((a, x) => a + x.count, 0) : 0;
  const overdueStages = d ? STAGES.filter(([k]) => d.overdue.some((o) => o.stage === k)) : [];
  const overdue = d ? d.overdue.filter((o) => stageTab === "all" || o.stage === stageTab) : [];
  return (
    <div className="mb-4 space-y-4">
      {q.error && <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px] text-err">Could not load the quality summary: {q.error}</div>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile label={`Opened · ${periodLabel}`} value={v(d?.opened)} note={d ? `${d.openedStillOpen} of them still open` : ""} tone="main" trend={null} onClick={() => onDrill("total_period")} />
        <Tile label={`Closed · ${periodLabel}`} value={v(d?.closed)} note="completed in the period, whenever opened" tone="good" trend={null} onClick={() => onDrill("closed_period")} />
        <Tile label="Ongoing now" value={v(d?.ongoingNow)} note="every open case today" tone="warn" trend={null} onClick={() => onDrill("open_now")} />
        <Tile label="Overdue now" value={d ? String(d.overdue.length) : breachNow != null ? String(breachNow) : "…"} note="open and past the stage's target days · listed below" tone={d?.overdue.length ? "bad" : "good"} trend={null}
          onClick={() => document.getElementById("quality-overdue")?.scrollIntoView({ behavior: "smooth" })} />
        <Tile label="Average to close" value={dayTxt(d?.avgDaysToClose)} note={d ? `${d.avgDaysToCloseCases} cases opened ${periodLabel} and already closed` : ""} tone="brass" trend={null} onClick={null} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Time spent in each stage" hint={`average days, stages finished ${periodLabel} · the slow leg shows red`}>
          {d && <HBars format={(x) => `${x} days`} empty="No stage finished in this period."
            rows={STAGES.filter(([k]) => d.stageDays[k]?.avgDays != null).map(([k, label]) => {
              const s = d.stageDays[k] as { avgDays: number; cases: number };
              return { key: k, label: `${label} · ${s.cases} cases`, value: s.avgDays, color: s.avgDays > 10 ? TONE.bad : s.avgDays > 5 ? TONE.warn : TONE.good, right: dayTxt(s.avgDays), onClick: null };
            })} />}
          <p className="mt-2 text-[11px] text-ink-muted">Same window as Average to close: only what happened in the picked period, so last quarter&apos;s slow cases do not hide this month&apos;s pace. Pick a longer period to compare.</p>
        </Panel>
        <Panel title="How old the open cases are" hint={`${openTotal} open cases today · days since the complaint`}>
          {d && <HBars format={(x) => `${x} cases`} empty="No open cases."
            rows={d.ages.map((a, i) => ({ key: a.label, label: a.label, value: a.count, color: AGE_COLOR[i] ?? PALETTE[0]!, right: `${a.count} · ${openTotal ? Math.round((a.count / openTotal) * 100) : 0}%`, onClick: i >= 4 ? () => onDrill("over_1_month") : null }))} />}
          {d && <p className="mt-2 text-[11.5px] text-err">{d.ages.slice(4).reduce((a, x) => a + x.count, 0)} open cases are over a month old (click a bar over 30 days to list them).</p>}
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <Panel title="Monthly trend" hint="cases opened and closed each month · line = still open at month end">
          {d && <Columns valueLabels height={230} stacked={false} format={(x) => `${x} cases`} highlight={d.trend.length - 1}
            labels={d.trend.map((t) => `${t.month.slice(2, 4)}/${t.month.slice(5)}`)}
            series={[{ name: "Opened", color: "#c9a77c" }, { name: "Closed", color: TONE.good }]}
            values={[d.trend.map((t) => t.opened), d.trend.map((t) => t.closed)]}
            line={{ name: "Still open at month end", color: TONE.bad, values: d.trend.map((t) => t.backlog), format: (x) => `${x} open` }} />}
        </Panel>
        <Panel title="Where the cases are" hint="open cases by stage, with those completed in the period">{funnel}</Panel>
      </div>

      {d && (
        <section id="quality-overdue">
          <Panel title="Overdue cases" hint="open cases whose current stage has run past its target days · most overdue first">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {[["all", "All"] as [string, string], ...overdueStages].map(([k, label]) => {
                const n = k === "all" ? d.overdue.length : d.overdue.filter((o) => o.stage === k).length;
                return (
                  <button key={k} type="button" onClick={() => setStageTab(k)}
                    className={cn("rounded-full border px-3 py-1 text-[12px]", stageTab === k ? "border-primary bg-primary text-white" : "border-border text-ink-secondary hover:bg-surface-2")}>
                    {label} <span className="ml-1 tabular-nums opacity-80">{n}</span>
                  </button>
                );
              })}
            </div>
            {overdue.length === 0 ? <p className="text-[12.5px] text-ink-muted">Nothing is overdue.</p> : (
              <div className="max-h-[440px] overflow-y-auto">
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 bg-surface"><tr>
                    <Th left>Case</Th><Th left>Customer</Th><Th left>Supplier</Th><Th left>Stage</Th><Th>In stage since</Th><Th>Target</Th><Th>Days in stage</Th><Th>Days overdue</Th><Th>Case age</Th>
                  </tr></thead>
                  <tbody>{overdue.map((o) => (
                    <tr key={`${o.id}-${o.stage}`}>
                      <Td left><Link to={`/assr/${o.id}`} className="text-primary hover:underline">{o.assrNo ?? `#${o.id}`}</Link></Td>
                      <Td left className="max-w-[160px] truncate">{o.customer ?? "—"}</Td>
                      <Td left className="max-w-[160px] truncate text-ink-secondary">{o.supplier ?? "—"}</Td>
                      <Td left>{stageLabel(o.stage)}</Td>
                      <Td>{o.enteredAt}</Td><Td>{o.targetDays} days</Td><Td>{o.daysInStage}</Td>
                      <Td className={o.daysOver >= 7 ? "font-semibold text-err" : "text-warning-text"}>{o.daysOver}</Td>
                      <Td className="text-ink-secondary">{o.caseAgeDays} days</Td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Panel>
        </section>
      )}

      {d && (
        <Panel title="Suppliers" hint={`cases opened ${periodLabel} against goods received from the same supplier ${periodLabel}`}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead><tr>
                <Th left>Supplier</Th><Th>Items received</Th><Th>Cases</Th><Th>Items in cases</Th><Th>Service case rate</Th>
                <Th>Average to close</Th><Th>Open</Th><Th>Overdue</Th>
                {STAGES.map(([k, l]) => <Th key={k}>{l}</Th>)}
              </tr></thead>
              <tbody>{d.suppliers.map((s) => (
                <tr key={s.creditor}>
                  <Td left className="max-w-[220px] truncate">{s.name}</Td>
                  <Td>{s.receivedQty.toLocaleString()}</Td><Td>{s.cases}</Td><Td>{s.items}</Td>
                  <Td className={s.ratePct == null ? "text-ink-muted" : s.ratePct > 100 ? "text-warning-text" : s.ratePct >= 5 ? "font-semibold text-err" : s.ratePct >= 2 ? "text-warning-text" : "text-synced"}>{rateTxt(s.ratePct)}</Td>
                  <Td>{dayTxt(s.avgDaysToClose)}</Td><Td>{s.open}</Td><Td className={s.overdue ? "text-err" : ""}>{s.overdue}</Td>
                  {STAGES.map(([k]) => <Td key={k} className="text-ink-secondary">{s.stageDays[k]?.avgDays ?? "—"}</Td>)}
                </tr>
              ))}
                {d.suppliers.length === 0 && <tr><Td left className="text-ink-muted">No case with a supplier opened in this period.</Td></tr>}
              </tbody>
            </table>
          </div>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[11.5px] text-ink-muted">
            <li>Service case rate = items in that supplier&apos;s cases ÷ items received from them in the same period (1,000 received, 50 in cases = 5%). Red from 5%.</li>
            <li>Average to close = the supplier&apos;s cases opened in the period and closed, opened to closed. Stage columns = average days per stage, for stages finished in the period.</li>
            <li>&quot;check code&quot; = more items in cases than received under this supplier code: the goods are booked under another code (a renamed or new company). {d.unattributed} cases opened in the period have no supplier set and are not counted.</li>
          </ul>
        </Panel>
      )}
    </div>
  );
}
