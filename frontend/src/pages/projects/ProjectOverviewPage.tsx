// Project Overview (owner, 2026-10-17): one page for the whole project
// business — the period's P&L, the trend by month / quarter / year, where each
// ringgit of sales goes, the breakdowns, and every project with a click through
// to its page. Replaces the old Finances tabs: Finance lines live on each
// project, and the P&L by month / quarter / year is the trend here.
// Figures: keyed books when an event has them, otherwise its Sales Orders
// (projectOverviewModel.ts); every project row says which.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { formatCurrency, cn } from "../../lib/utils";
import { todayMY } from "../../vendor/shared/format";
import { Panel, Th, Td, Toggle, SELECT_CLS } from "../../components/scm-v2/OverviewKit";
import { Columns, SplitBar, TONE, PALETTE } from "../../components/scm-v2/Charts";
import { DashboardPeriodPicker, useDashboardPeriod } from "../../components/scm-v2/DashboardPeriod";
import { ProjectDataGapsPanel, ProjectStuckPanel } from "./ProjectOverviewParts";
import { figuresOf, totalsOf, groupBy, drillOf, pctOf, type OvProject, type Drill } from "./projectOverviewModel";

type Dim = "brand" | "eventType" | "organizer" | "venue" | "state";
const DIMS: Array<[Dim, string]> = [["brand", "Brand"], ["eventType", "Event type"], ["organizer", "Organizer"], ["venue", "Venue"], ["state", "State"]];
const money = formatCurrency;
const pctTxt = (x: number | null) => (x == null ? "—" : `${x.toFixed(1)}%`);
type SortKey = "start" | "sales" | "np" | "npPct";

export function ProjectOverviewPage() {
  const navigate = useNavigate();
  const today = todayMY();
  const [period, setPeriod] = useDashboardPeriod(today, "af_from", "af_to", []);
  const q = useQuery<{ projects: OvProject[] }>("/api/projects/overview", () => api.get("/api/projects/overview"));
  const [brand, setBrand] = useState(""); const [type, setType] = useState(""); const [organizer, setOrganizer] = useState("");
  /* Opens on this year by month (owner 2026-10-17). */
  const [drill, setDrill] = useState<Drill>({ level: "yearMonths", year: Number(today.slice(0, 4)) });
  const [dim, setDim] = useState<Dim>("brand");
  const [pick, setPick] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("start");

  const all = useMemo(() => (q.data?.projects ?? []).filter((p) =>
    (!brand || p.brand === brand) && (!type || p.eventType === type) && (!organizer || p.organizer === organizer)), [q.data, brand, type, organizer]);
  const inPeriod = useMemo(() => all.filter((p) => !!p.startDate && p.startDate >= period.from && p.startDate <= period.to), [all, period.from, period.to]);
  const t = totalsOf(inPeriod);
  const groups = groupBy(inPeriod, (p) => p[dim]);
  const trend = drillOf(all, drill, today);
  /* Breadcrumb back up the drill: All years > 2026 > Q4 > Oct. */
  const crumbs: Array<[string, Drill]> = [["All years", { level: "years" }]];
  if (drill.level !== "years") {
    const year = drill.level === "weeks" ? Number(drill.month.slice(0, 4)) : drill.year;
    crumbs.push([String(year), drill.level === "yearMonths" ? drill : { level: "quarters", year }]);
    const quarter = drill.level === "months" ? drill.quarter : drill.level === "weeks" ? Math.ceil(Number(drill.month.slice(5, 7)) / 3) : null;
    if (quarter) crumbs.push([`Q${quarter}`, { level: "months", year, quarter }]);
    if (drill.level === "weeks") crumbs.push([new Date(`${drill.month}-01T00:00:00Z`).toLocaleString("en", { month: "short", timeZone: "UTC" }), drill]);
  }
  const unit = drill.level === "years" ? "Year" : drill.level === "quarters" ? "Quarter" : drill.level === "months" || drill.level === "yearMonths" ? "Month" : "Week";
  const yearView = drill.level === "quarters" || drill.level === "yearMonths" ? drill.year : null;
  const openBucket = (b: (typeof trend)[number]) => { if (b.next) setDrill(b.next); else { setPick(null); setPeriod(b.from, b.to > today ? today : b.to); } };
  /* Running costs after COGS, only the ones that are not zero. */
  const costs = ([["Rental", t.rental, PALETTE[2]!], ["Commission", t.commission, PALETTE[3]!], ["Setup", t.setup, PALETTE[5]!], ["Transport", t.transport, PALETTE[8]!], ["Merchandise", t.merchandise, PALETTE[7]!], ["Other", t.other, "#c9cdc4"]] as Array<[string, number, string]>).filter(([, v]) => v !== 0);
  const running = costs.reduce((a, [, v]) => a + v, 0);
  const npMax = Math.max(1, ...groups.map((g) => Math.abs(g.np)));
  const listed = inPeriod.filter((p) => !pick || (p[dim] || "—") === pick)
    .map((p) => ({ p, f: figuresOf(p) }))
    .sort((a, b) => sort === "sales" ? b.f.sales - a.f.sales : sort === "np" ? b.f.np - a.f.np : sort === "npPct" ? (pctOf(b.f.np, b.f.sales) ?? -1e9) - (pctOf(a.f.np, a.f.sales) ?? -1e9) : (b.p.startDate ?? "").localeCompare(a.p.startDate ?? ""));
  const options = (key: "brand" | "eventType" | "organizer") => [...new Set((q.data?.projects ?? []).map((p) => p[key]).filter((x): x is string => !!x))].sort();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <DashboardPeriodPicker period={period} today={today} onChange={(f, to) => { setPick(null); setPeriod(f, to); }} />
        <select className={SELECT_CLS} value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Brand"><option value="">All brands</option>{options("brand").map((b) => <option key={b}>{b}</option>)}</select>
        <select className={SELECT_CLS} value={type} onChange={(e) => setType(e.target.value)} aria-label="Event type"><option value="">All event types</option>{options("eventType").map((b) => <option key={b}>{b}</option>)}</select>
        <select className={SELECT_CLS} value={organizer} onChange={(e) => setOrganizer(e.target.value)} aria-label="Organizer"><option value="">All organizers</option>{options("organizer").map((b) => <option key={b}>{b}</option>)}</select>
        {q.loading && <span className="text-[11.5px] text-ink-muted">Loading…</span>}
      </div>
      {q.error && <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px] text-err">Could not load: {q.error}</div>}

      {/* The period's P&L, on the dark slab the home page uses for its hero. */}
      <section className="relative overflow-hidden rounded-2xl bg-sidebar px-5 py-5 text-sidebar-ink shadow-slab sm:px-7">
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full opacity-50 blur-2xl" style={{ background: "radial-gradient(circle, rgba(22,105,95,0.6), transparent 70%)" }} />
        <div className="relative">
          <div className="font-mono text-[10px] font-bold uppercase tracking-brand text-accent-bright">{period.label} · {t.projects} projects</div>
          <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
            <Hero label="Sales" value={money(t.sales)} sub={t.fromSalesOrders ? `${t.fromSalesOrders} projects from Sales Orders` : "all from keyed books"} />
            <Hero label="COGS" value={money(t.cogs)} sub={`${pctTxt(pctOf(t.cogs, t.sales))} of sales`} />
            <Hero label="Gross profit" value={money(t.gp)} sub={`GP ${pctTxt(pctOf(t.gp, t.sales))}`} tone={t.gp >= 0 ? "good" : "bad"} />
            <Hero label="Rental + other cost" value={money(t.rental + t.otherCost)} sub={`rental ${money(t.rental)}`} />
            <Hero label="Net profit" value={money(t.np)} sub={`NP ${pctTxt(pctOf(t.np, t.sales))}`} tone={t.np >= 0 ? "good" : "bad"} />
          </div>
          {t.noSales > 0 && <p className="mt-3 text-[11.5px] text-sidebar-ink/70">{t.noSales} projects in this period have neither keyed sales nor Sales Orders yet.</p>}
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Panel title="Trend" hint="sales, gross and net profit by event start · click a row to go one level down"
          right={<span className="flex flex-wrap items-center gap-1 text-[12px]">{crumbs.map(([label, d], i) => (
            <span key={label} className="flex items-center gap-1">
              {i > 0 && <span className="text-ink-muted">›</span>}
              {i === crumbs.length - 1 ? <b className="text-ink">{label}</b> : <button type="button" className="text-primary hover:underline" onClick={() => setDrill(d)}>{label}</button>}
            </span>
          ))}
            {yearView != null && <Toggle value={drill.level === "quarters" ? "q" : "m"} options={[["m", "By month"], ["q", "By quarter"]]}
              onChange={(v) => setDrill(v === "q" ? { level: "quarters", year: yearView } : { level: "yearMonths", year: yearView })} />}
          </span>}>
          <Columns valueLabels={false} height={230} stacked={false} format={money} highlight={trend.findIndex((b) => today >= b.from && today <= b.to)}
            labels={trend.map((b) => b.label)}
            series={[{ name: "Sales", color: PALETTE[0]! }, { name: "Gross profit", color: "#8fb3ae" }]}
            values={[trend.map((b) => b.sales), trend.map((b) => Math.max(0, b.gp))]}
            line={{ name: "Net profit %", color: PALETTE[1]!, values: trend.map((b) => pctOf(b.np, b.sales)), format: (x) => `${x.toFixed(1)}%` }} />
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead><tr><Th left>{unit}</Th><Th>Projects</Th><Th>Sales</Th><Th>GP</Th><Th>GP %</Th><Th>NP</Th><Th>NP %</Th></tr></thead>
              <tbody>{trend.slice().reverse().map((b) => (
                <tr key={b.key} className="cursor-pointer hover:bg-surface-2/50" onClick={() => openBucket(b)}>
                  <Td left className="text-primary">{b.label}{b.next ? " ›" : ""}</Td><Td>{b.projects}</Td><Td>{money(b.sales)}</Td><Td>{money(b.gp)}</Td><Td>{pctTxt(pctOf(b.gp, b.sales))}</Td>
                  <Td className={b.np < 0 ? "text-err" : ""}>{money(b.np)}</Td><Td>{pctTxt(pctOf(b.np, b.sales))}</Td>
                </tr>))}</tbody>
            </table>
            <p className="mt-1 text-[11px] text-ink-muted">{drill.level === "weeks" ? "Click a week to show its projects across the page." : "Year, then its quarters, then its months, then the weeks of a month."}</p>
          </div>
        </Panel>
        <Panel title="Where each ringgit of sales goes" hint={period.label}>
          <SplitBar format={money} parts={[
            { label: "COGS", value: t.cogs, color: PALETTE[1]! },
            ...costs.map(([label, value, color]) => ({ label, value, color })),
            { label: "Net profit", value: Math.max(0, t.np), color: TONE.good },
          ]} />
          <table className="mt-3 w-full border-collapse"><tbody>
            <tr><Td left>Sales</Td><Td>{money(t.sales)}</Td><Td className="text-ink-muted">100%</Td></tr>
            <tr><Td left>− COGS</Td><Td>{money(t.cogs)}</Td><Td className="text-ink-muted">{pctTxt(pctOf(t.cogs, t.sales))}</Td></tr>
            <tr className="font-semibold"><Td left>= Gross profit</Td><Td>{money(t.gp)}</Td><Td>{pctTxt(pctOf(t.gp, t.sales))}</Td></tr>
            <tr><Td left>− Event costs</Td><Td>{money(running)}</Td><Td className="text-ink-muted">{pctTxt(pctOf(running, t.sales))}</Td></tr>
            <tr className="font-semibold"><Td left>= Net profit</Td><Td className={t.np < 0 ? "text-err" : "text-synced"}>{money(t.np)}</Td><Td>{pctTxt(pctOf(t.np, t.sales))}</Td></tr>
          </tbody></table>
          {costs.length > 0 && <p className="mt-2 text-[11.5px] text-ink-muted">Event costs: {costs.map(([l, v]) => `${l} ${money(v)}`).join(" · ")}</p>}
        </Panel>
      </div>

      <Panel title="Breakdown" hint="largest sales first · click a row to list its projects below" right={<Toggle value={dim} options={DIMS} onChange={(v) => { setDim(v); setPick(null); }} />}>
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface"><tr><Th left>{DIMS.find(([d]) => d === dim)?.[1]}</Th><Th>Projects</Th><Th>Sales</Th><Th>GP %</Th><Th>Event costs</Th><Th>Net profit</Th><Th left> </Th><Th>NP %</Th></tr></thead>
            <tbody>{groups.map((g) => (
              <tr key={g.key} onClick={() => setPick(pick === g.key ? null : g.key)} className={cn("cursor-pointer hover:bg-surface-2/50", pick === g.key && "bg-primary-soft/50")}>
                <Td left className="max-w-[220px] truncate">{g.key}</Td><Td>{g.projects}</Td><Td>{money(g.sales)}</Td><Td>{pctTxt(pctOf(g.gp, g.sales))}</Td><Td>{money(g.rental + g.otherCost)}</Td>
                <Td className={g.np < 0 ? "font-semibold text-err" : "font-semibold text-synced"}>{money(g.np)}</Td>
                <Td left className="w-[18%]"><div className="h-2 rounded-full bg-surface-2"><div className="h-2 rounded-full" style={{ width: `${(Math.abs(g.np) / npMax) * 100}%`, background: g.np < 0 ? TONE.bad : TONE.good }} /></div></Td>
                <Td>{pctTxt(pctOf(g.np, g.sales))}</Td>
              </tr>))}
              {groups.length === 0 && <tr><Td left className="text-ink-muted">No projects in this period.</Td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title={`Projects${pick ? ` · ${pick}` : ""}`} hint={`${listed.length} projects · click one to open it`}
        right={<span className="flex items-center gap-2">
          {pick && <button type="button" className="text-[12px] text-primary hover:underline" onClick={() => setPick(null)}>Show all</button>}
          <Toggle value={sort} options={[["start", "Newest"], ["sales", "Sales"], ["np", "Net profit"], ["npPct", "NP %"]]} onChange={setSort} />
        </span>}>
        <div className="max-h-[560px] overflow-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface"><tr><Th left>Project</Th><Th left>Dates</Th><Th>Sales</Th><Th>COGS</Th><Th>Rental</Th><Th>Other cost</Th><Th>Net profit</Th><Th>NP %</Th><Th left>Figures from</Th></tr></thead>
            <tbody>
              {listed.map(({ p, f }) => (
                <tr key={p.id} onClick={() => navigate(`/projects/${p.id}`)} className="cursor-pointer hover:bg-surface-2/50">
                  <Td left className="max-w-[320px] truncate"><span className="text-primary">{p.name}</span><span className="ml-1.5 text-[10.5px] text-ink-muted">{p.eventType ?? ""}</span></Td>
                  <Td left className="text-ink-muted">{p.startDate?.slice(5) ?? "—"}{p.endDate && p.endDate !== p.startDate ? ` – ${p.endDate.slice(5)}` : ""}</Td>
                  <Td>{money(f.sales)}</Td><Td>{money(f.cogs)}</Td><Td>{money(f.rental)}</Td><Td>{money(f.otherCost)}</Td>
                  <Td className={f.np < 0 ? "font-semibold text-err" : "font-semibold"}>{money(f.np)}</Td><Td>{pctTxt(pctOf(f.np, f.sales))}</Td>
                  <Td left><Source s={f.salesSource} cogsSo={f.cogsFromSalesOrders} /></Td>
                </tr>
              ))}
              {listed.length === 0 && <tr><Td left className="text-ink-muted">No projects in this period.</Td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>

      <ProjectStuckPanel onOpen={(id) => navigate(`/projects/${id}`)} />
      <ProjectDataGapsPanel onOpen={(id) => navigate(`/projects/${id}`)} />
    </div>
  );
}

function Hero({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "good" | "bad" }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-sidebar-ink/70">{label}</div>
      <div className={cn("mt-1 whitespace-nowrap font-display text-[21px] font-bold leading-tight tabular-nums", tone === "bad" ? "text-[#f0a39b]" : tone === "good" ? "text-[#8fe0b5]" : "text-sidebar-ink")}>{value}</div>
      <div className="mt-0.5 text-[11.5px] text-sidebar-ink/70">{sub}</div>
    </div>
  );
}

function Source({ s, cogsSo }: { s: "keyed" | "sales_orders" | "none"; cogsSo: boolean }) {
  if (s === "keyed") return <span className="rounded-full bg-synced/10 px-2 py-0.5 text-[10.5px] text-synced">Books{cogsSo ? " · COGS from SO" : ""}</span>;
  if (s === "sales_orders") return <span className="rounded-full bg-warning-bg px-2 py-0.5 text-[10.5px] text-warning-text">Sales Orders · not settled</span>;
  return <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] text-ink-muted">No sales yet</span>;
}
