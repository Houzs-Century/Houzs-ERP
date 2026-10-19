// Quality Overview · the top (owner, 2026-10-17). Every performance figure
// follows the picked period, so it shows how the team does NOW:
//   opened / closed in the period; average to close over the cases OPENED in
//   the period; time per stage over the stages that ENDED in it; suppliers'
//   cases against the items received from them in the same period. The open
//   cases, their age and the overdue list are as of today.
// Data: GET /api/assr/quality-overview (backend routes/lib/assr-quality.ts).
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DrillDrawer, col, type Drill } from "../components/scm-v2/DrillDrawer";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import { Panel, Th, Td, Toggle, StepTabs } from "../components/scm-v2/OverviewKit";
import { Columns, HBars, TONE, PALETTE } from "../components/scm-v2/Charts";

type StageDays = Partial<Record<string, { avgDays: number | null; cases: number }>>;
type Supplier = {
  creditor: string; name: string; receivedQty: number; receivedLines: number; cases: number; items: number;
  ratePct: number | null; open: number; overdue: number; closed: number; avgDaysToClose: number | null; stageDays: StageDays;
  months: Array<{ month: string; receivedQty: number; items: number; ratePct: number | null }>;
};
type Overdue = {
  id: number; assrNo: string | null; customer: string | null; supplier: string | null; stage: string;
  complaint: string | null; issueCategory: string | null;
  enteredAt: string; targetDays: number; daysInStage: number; daysOver: number; caseAgeDays: number;
};
type Quality = {
  opened: number; closed: number; ongoingNow: number; openedStillOpen: number;
  avgDaysToClose: number | null; avgDaysToCloseCases: number; avgDaysToClosePrev30: number | null; stageDays: StageDays;
  avgDaysToClose90: number | null; avgDaysToClose90Cases: number; stageDays90: StageDays;
  ages: Array<{ label: string; count: number }>;
  trend: Array<{ month: string; opened: number; closed: number; backlog: number; avgDaysToClose: number | null }>;
  overdue: Overdue[]; suppliers: Supplier[]; unattributed: number; rateFrom: string;
  caseList: CaseRow[];
};
type CaseRow = {
  id: number; assrNo: string | null; customer: string | null; creditor: string | null; supplier: string | null;
  complaint: string | null; issueCategory: string | null;
  stage: string; openedAt: string; closedAt: string | null; open: boolean; openedInPeriod: boolean; ageDays: number;
};

const STAGES: Array<[string, string]> = [
  ["pending_review", "Review"], ["under_verification", "Verification"], ["pending_solution", "Solution"],
  ["pending_supplier_pickup", "Pickup / Return"], ["pending_item_ready", "Item ready"], ["pending_delivery_service", "Delivery / Service"],
];
const stageLabel = (k: string) => STAGES.find(([s]) => s === k)?.[1] ?? k.replace(/_/g, " ");
const dayTxt = (x: number | null | undefined) => (x == null ? "—" : `${x} days`);
/* A rate over 100% means the receipts sit under another supplier code (e.g. a
   renamed company), not that every item came back. */
const AGE_COLOR = ["#4f8a5b", "#7fa86a", "#c9a77c", "#d9b25c", TONE.warn, TONE.bad, "#8f2d2d"];

/** `breakdowns` (issue categories, resolution mix) sit under the trend;
 *  `repeats` (items / customers coming back) under the suppliers; the long
 *  overdue list is last (owner 2026-10-17). */
export function QualitySummary({ from, to, periodLabel, breachNow, funnel, breakdowns, repeats, onDrill }: {
  from: string; to: string; periodLabel: string; breachNow: number | null; funnel: ReactNode; breakdowns: ReactNode; repeats: ReactNode; onDrill: (metric: string) => void;
}) {
  const q = useQuery<Quality>("/api/assr/quality-overview?from=:&to=:", () => api.get(`/api/assr/quality-overview?from=${from}&to=${to}`), [from, to]);
  const d = q.data;
  const [stageTab, setStageTab] = useState<string>("all");
  /* Time per stage over the last 30 or 90 days (owner 2026-10-18). */
  const [win, setWin] = useState<"30" | "90">("30");
  const stageDays = d ? (win === "30" ? d.stageDays : d.stageDays90) : {};
  const navigate = useNavigate();
  /* The second layer (owner 2026-10-18): a bar or a supplier opens its cases. */
  const [drill, setDrill] = useState<Drill<CaseRow> | null>(null);
  const openCases = (title: string, keep: (c: CaseRow) => boolean) => setDrill({
    title, subtitle: periodLabel, rows: (d?.caseList ?? []).filter(keep).sort((a, b) => b.ageDays - a.ageDays), rowKey: (c) => String(c.id),
    onRow: (c) => navigate(`/assr/${c.id}`),
    columns: [
      col<CaseRow>("Case", true, (c) => <span className="text-primary">{c.assrNo ?? `#${c.id}`}</span>, (c) => c.assrNo ?? "", null, null),
      col<CaseRow>("Customer", true, (c) => c.customer ?? "—", (c) => c.customer ?? "", null, null),
      col<CaseRow>("Complaint", true, (c) => <span title={c.complaint ?? ""}>{c.complaint ?? "—"}</span>, (c) => `${c.complaint ?? ""} ${c.issueCategory ?? ""}`, null, null),
      col<CaseRow>("Supplier", true, (c) => c.supplier ?? "—", (c) => c.supplier ?? "", null, null),
      col<CaseRow>("Stage", true, (c) => (c.stage === "completed" ? "Completed" : stageLabel(c.stage)), (c) => c.stage, null, null),
      col<CaseRow>("Opened", false, (c) => c.openedAt, null, null, null),
      col<CaseRow>("Closed", false, (c) => c.closedAt ?? "—", null, null, null),
      col<CaseRow>("Days", false, (c) => c.ageDays, null, null, null),
    ],
  });
  const ageRange = (label: string): [number, number] => {
    const m = label.match(/(\d+)\D+(\d+)/);
    return m ? [Number(m[1]), Number(m[2])] : [91, 100000];
  };
  const v = (x: number | undefined) => (d && x != null ? x.toLocaleString() : "…");
  const openTotal = d ? d.ages.reduce((a, x) => a + x.count, 0) : 0;
  const overdue = d ? d.overdue.filter((o) => stageTab === "all" || o.stage === stageTab) : [];
  return (
    <div className="mb-4 space-y-4">
      {q.error && <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px] text-err">Could not load the quality summary: {q.error}</div>}
      {/* The headline on the dark slab the home page and Project Overview use. */}
      <section className="relative overflow-hidden rounded-2xl bg-sidebar px-5 py-5 text-sidebar-ink shadow-slab sm:px-7">
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full opacity-50 blur-2xl" style={{ background: "radial-gradient(circle, rgba(22,105,95,0.6), transparent 70%)" }} />
        <div className="relative">
          <div className="font-mono text-[10px] font-bold uppercase tracking-brand text-accent-bright">Service cases · {periodLabel}</div>
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-5">
            <HeroStat label="Opened" value={v(d?.opened)} sub={d ? `${d.openedStillOpen} of them still open` : ""} onClick={() => onDrill("total_period")} tone={null} />
            <HeroStat label="Closed" value={v(d?.closed)} sub="completed in the period" onClick={() => onDrill("closed_period")} tone="good" />
            <HeroStat label="Ongoing now" value={v(d?.ongoingNow)} sub="every open case today" onClick={() => onDrill("open_now")} tone={null} />
            <HeroStat label="Overdue now" value={d ? String(d.overdue.length) : breachNow != null ? String(breachNow) : "…"} sub="past the stage's target days"
              onClick={() => document.getElementById("quality-overdue")?.scrollIntoView({ behavior: "smooth" })} tone={d?.overdue.length ? "bad" : "good"} />
            <HeroStat label="Average to close · 30 days" value={dayTxt(d?.avgDaysToClose)}
              sub={d ? (d.avgDaysToClosePrev30 != null && d.avgDaysToClose != null
                ? `${d.avgDaysToClose <= d.avgDaysToClosePrev30 ? "faster" : "slower"} than the 30 days before (${d.avgDaysToClosePrev30} days) · ${d.avgDaysToCloseCases} cases`
                : `${d.avgDaysToCloseCases} cases closed`) : ""}
              onClick={() => openCases("Closed in the last 30 days", (c) => !c.open && !!c.closedAt)}
              tone={d && d.avgDaysToClosePrev30 != null && d.avgDaysToClose != null ? (d.avgDaysToClose <= d.avgDaysToClosePrev30 ? "good" : "bad") : null} />
          </div>
        </div>
      </section>

      <SectionTitle eyebrow="Now" title="Where the open cases are" />
      <Panel title="Where the cases are" hint="open cases by stage, with those completed in the period · red = past the stage's target days">{funnel}</Panel>

      <SectionTitle eyebrow="Speed" title="How fast cases move" />

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Time spent in each stage" hint={`average days, stages finished in the last ${win} days · average to close over them: ${d ? dayTxt(win === "30" ? d.avgDaysToClose : d.avgDaysToClose90) : "…"} · the slow leg shows red`}
          right={<Toggle value={win} options={[["30", "Last 30 days"], ["90", "Last 90 days"]]} onChange={setWin} />}>
          {d && <HBars format={(x) => `${x} days`} empty="No stage finished in this period."
            rows={STAGES.filter(([k]) => stageDays[k]?.avgDays != null).map(([k, label]) => {
              const s = stageDays[k] as { avgDays: number; cases: number };
              return { key: k, label: `${label} · ${s.cases} cases`, value: s.avgDays, color: s.avgDays > 10 ? TONE.bad : s.avgDays > 5 ? TONE.warn : TONE.good, right: dayTxt(s.avgDays), onClick: () => openCases(`At ${label} now`, (c) => c.open && c.stage === k) };
            })} />}
          <p className="mt-2 text-[11px] text-ink-muted">The last 30 or 90 days, whatever period is picked, so an older, slower pace does not hide today&apos;s. The monthly trend shows each month&apos;s average.</p>
        </Panel>
        <Panel title="How old the open cases are" hint={`${openTotal} open cases today · days since the complaint`}>
          {d && <HBars format={(x) => `${x} cases`} empty="No open cases."
            rows={d.ages.map((a, i) => ({ key: a.label, label: a.label, value: a.count, color: AGE_COLOR[i] ?? PALETTE[0]!, right: `${a.count} ${a.count === 1 ? "case" : "cases"}`, onClick: () => { const [lo, hi] = ageRange(a.label); openCases(`Open, ${a.label} old`, (c) => c.open && c.ageDays >= lo && c.ageDays <= hi); } }))} />}
          {d && <p className="mt-2 text-[11.5px] text-err">{d.ages.slice(4).reduce((a, x) => a + x.count, 0)} open cases are over a month old (click any bar to list its cases).</p>}
        </Panel>
      </div>

      <SectionTitle eyebrow="Volume" title="Cases coming in and going out" />
      <div>
        <Panel title="Monthly trend" hint="cases opened and closed each month · line = that month's average days to close (cases closed in it)">
          {d && <Columns valueLabels height={230} stacked={false} format={(x) => `${x} cases`} highlight={d.trend.length - 1}
            labels={d.trend.map((t) => `${t.month.slice(2, 4)}/${t.month.slice(5)}`)}
            series={[{ name: "Opened", color: "#c9a77c" }, { name: "Closed", color: TONE.good }]}
            values={[d.trend.map((t) => t.opened), d.trend.map((t) => t.closed)]}
            line={{ name: "Average days to close", color: TONE.bad, values: d.trend.map((t) => t.avgDaysToClose), format: (x) => `${x} days` }} />}
          {d && (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full border-collapse">
                <thead><tr><Th left>Month</Th>{d.trend.map((t) => <Th key={t.month}>{`${t.month.slice(2, 4)}/${t.month.slice(5)}`}</Th>)}</tr></thead>
                <tbody>
                  <tr><Td left>Opened</Td>{d.trend.map((t) => <Td key={t.month}>{t.opened}</Td>)}</tr>
                  <tr><Td left>Closed</Td>{d.trend.map((t) => <Td key={t.month}>{t.closed}</Td>)}</tr>
                  <tr className="font-semibold"><Td left>Average to close</Td>{d.trend.map((t) => <Td key={t.month}>{t.avgDaysToClose ?? "—"}</Td>)}</tr>
                  <tr className="text-ink-secondary"><Td left>Open at month end</Td>{d.trend.map((t) => <Td key={t.month}>{t.backlog}</Td>)}</tr>
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <SectionTitle eyebrow="Why" title="What the cases are about" />
      {breakdowns}

      <SectionTitle eyebrow="Suppliers" title="Whose goods come back" />
      {d && (
        <Panel title="Suppliers" hint={`cases opened ${d.rateFrom} – ${to} against goods received from the same supplier over the same dates · at least 3 months, since a defect shows up weeks after delivery`}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead><tr><Th left>Supplier</Th><Th>Service case rate</Th><Th>Items in cases / received</Th><Th>Cases</Th><Th>Still open</Th><Th>Overdue</Th><Th>Average to close</Th></tr></thead>
              <tbody>{d.suppliers.map((s) => (
                <tr key={s.creditor} className="cursor-pointer hover:bg-surface-2/50" onClick={() => openCases(`${s.name} · cases opened`, (c) => c.openedInPeriod && c.creditor === s.creditor)}>
                  <Td left className="max-w-[260px] truncate text-primary">{s.name}</Td>
                  <Td className={s.ratePct == null ? "text-ink-muted" : s.ratePct > 100 ? "text-warning-text" : s.ratePct >= 5 ? "font-semibold text-err" : s.ratePct >= 2 ? "text-warning-text" : "text-synced"}>{s.ratePct == null ? "—" : s.ratePct > 100 ? "check code" : `${s.ratePct}%`}</Td>
                  <Td className="text-ink-secondary">{s.items} / {s.receivedQty.toLocaleString()}</Td>
                  <Td>{s.cases}</Td><Td>{s.open}</Td><Td className={s.overdue ? "text-err" : ""}>{s.overdue}</Td><Td>{dayTxt(s.avgDaysToClose)}</Td>
                </tr>
              ))}
                {d.suppliers.length === 0 && <tr><Td left className="text-ink-muted">No case with a supplier opened in this period.</Td></tr>}
              </tbody>
            </table>
          </div>
          {d.suppliers.length > 0 && (d.suppliers[0]?.months.length ?? 0) > 1 && (
            <div className="mt-4 overflow-x-auto">
              <div className="mb-1 text-[12px] font-semibold text-ink">Month by month · service case rate (items in cases / items received)</div>
              <table className="w-full border-collapse">
                <thead><tr><Th left>Supplier</Th>{(d.suppliers[0]?.months ?? []).map((m) => <Th key={m.month}>{m.month}</Th>)}</tr></thead>
                <tbody>{d.suppliers.map((s) => (
                  <tr key={s.creditor}>
                    <Td left className="max-w-[220px] truncate">{s.name}</Td>
                    {s.months.map((m) => (
                      <Td key={m.month} className={m.ratePct == null ? "text-ink-muted" : m.ratePct > 100 ? "text-warning-text" : m.ratePct >= 5 ? "font-semibold text-err" : ""}>
                        {m.ratePct == null ? (m.items ? `${m.items} / 0` : "—") : m.ratePct > 100 ? "check code" : `${m.ratePct}%`}
                        <span className="block text-[10.5px] text-ink-muted">{m.items} / {m.receivedQty.toLocaleString()}</span>
                      </Td>
                    ))}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[11.5px] text-ink-muted">
            <li>Service case rate = items in that supplier&apos;s cases ÷ items received from them over the same dates (1,000 received, 50 in cases = 5%). Red from 5%. At least the last 3 months, so a month with no delivery does not read as 100%.</li>
            <li>Average to close = the supplier&apos;s cases opened in the period and already closed, opened to closed. &quot;—&quot; rate = nothing received from them in the period.</li>
            <li>&quot;check code&quot; = more items in cases than received under this supplier code: the goods are booked under another code (a renamed or new company). {d.unattributed} cases opened in the period have no supplier set and are not counted.</li>
          </ul>
        </Panel>
      )}

      {d && (
        <section id="quality-overdue">
          <Panel title="Overdue cases" hint="open cases whose current stage has run past its target days · tab = open cases at the stage, red = how many are overdue · most overdue first">
            {/* Each stage: open cases at it, and in red how many of them are overdue. */}
            <StepTabs value={stageTab} onChange={setStageTab}
              tabs={[["all", "All", d.caseList.filter((c) => c.open).length, d.overdue.length] as [string, string, number, number],
                ...STAGES.map(([k, label]) => [k, label, d.caseList.filter((c) => c.open && c.stage === k).length, d.overdue.filter((o) => o.stage === k).length] as [string, string, number, number])]} />
            {overdue.length === 0 ? <p className="text-[12.5px] text-ink-muted">Nothing is overdue.</p> : (
              <div className="max-h-[440px] overflow-y-auto">
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 bg-surface"><tr>
                    <Th left>Case</Th><Th left>Customer</Th><Th left>Complaint</Th><Th left>Supplier</Th><Th left>Stage</Th><Th>In stage since</Th><Th>Target</Th><Th>Days in stage</Th><Th>Days overdue</Th><Th>Case age</Th>
                  </tr></thead>
                  <tbody>{overdue.map((o) => (
                    <tr key={`${o.id}-${o.stage}`}>
                      <Td left><Link to={`/assr/${o.id}`} className="text-primary hover:underline">{o.assrNo ?? `#${o.id}`}</Link></Td>
                      <Td left className="max-w-[160px] truncate">{o.customer ?? "—"}</Td>
                      <Td left className="max-w-[280px] truncate"><span title={`${o.issueCategory ?? ""}${o.issueCategory && o.complaint ? " · " : ""}${o.complaint ?? ""}`}>{o.complaint ?? "—"}</span>{o.issueCategory && <span className="block truncate text-[10.5px] text-ink-muted">{o.issueCategory}</span>}</Td>
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

      <SectionTitle eyebrow="Chase" title="Who and what to chase" />
      {repeats}

      <DrillDrawer drill={drill} onClose={() => setDrill(null)} />
    </div>
  );
}

function HeroStat({ label, value, sub, onClick, tone }: { label: string; value: string; sub: string; onClick: () => void; tone: "good" | "bad" | null }) {
  return (
    <button type="button" onClick={onClick} className="min-w-0 rounded-lg p-1 text-left transition-colors hover:bg-white/5">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-sidebar-ink/70">{label}</div>
      <div className={cn("mt-1 whitespace-nowrap font-display text-[24px] font-bold leading-tight tabular-nums", tone === "bad" ? "text-[#f0a39b]" : tone === "good" ? "text-[#8fe0b5]" : "text-sidebar-ink")}>{value}</div>
      <div className="mt-0.5 text-[11.5px] text-sidebar-ink/70">{sub}</div>
    </button>
  );
}

function SectionTitle({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="flex items-baseline gap-2 pt-2">
      <span className="font-mono text-[10px] font-bold uppercase tracking-brand text-accent">{eyebrow}</span>
      <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
    </div>
  );
}
