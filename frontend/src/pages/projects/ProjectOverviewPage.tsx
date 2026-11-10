// Project Overview (owner, 2026-10-17): one page for the whole project
// business — the period's P&L, the trend by month / quarter / year, where each
// ringgit of sales goes, the breakdowns, and every project with a click through
// to its page. Replaces the old Finances tabs: Finance lines live on each
// project, and the P&L by month / quarter / year is the trend here.
// Figures: keyed books when an event has them, otherwise its Sales Orders
// (projectOverviewModel.ts); every project row says which.
import { useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, buildQueryKey } from "../../hooks/useQuery";
import { CacheStamp } from "../../components/CacheStamp";
import { useCacheRefresh, withFresh } from "../../lib/cacheStamp";
import { api } from "../../api/client";
import { formatCurrency, cn } from "../../lib/utils";
import { todayMY } from "../../vendor/shared/format";
import { Panel, Th, Td, Toggle, SELECT_CLS, SortTh, useTableSort } from "../../components/scm-v2/OverviewKit";
import { VenueRentPanel } from "./VenueRentPanel";
import { Columns, TONE, PALETTE } from "../../components/scm-v2/Charts";
import { useDashboardPeriod } from "../../components/scm-v2/DashboardPeriod";
import { DateRangeButton } from "../../components/DateRangeButton";
import { REPORT_RANGE_PRESETS } from "../../lib/dateRangePresets";
import { ProjectOverviewTable } from "./ProjectOverviewTable";
import { ProjectDataGapsPanel, ProjectStuckPanel } from "./ProjectOverviewParts";
import { figuresOf, totalsOf, groupBy, drillOf, pctOf, type OvProject, type Drill } from "./projectOverviewModel";
import { VIEW_PARAMS, readView, rememberOpenedFrom, takeScroll, writeView, type Dim, type OverviewView } from "./projectOverviewView";

const DIMS: Array<[Dim, string]> = [["brand", "Brand"], ["eventType", "Event type"], ["organizer", "Organizer"], ["venue", "Venue"], ["state", "State"]];
const money = formatCurrency;
const pctTxt = (x: number | null) => (x == null ? "—" : `${x.toFixed(1)}%`);
export function ProjectOverviewPage() {
  const navigate = useNavigate();
  const today = todayMY();
  /* A new period drops the breakdown pick in the same URL write. */
  const [period, setPeriod] = useDashboardPeriod(today, "af_from", "af_to", [VIEW_PARAMS.pick]);
  const q = useQuery<{ projects: OvProject[]; cachedAt?: string }>("/api/projects/overview", () => api.get("/api/projects/overview"));
  /* Served from a copy up to 2 h old: say when, and offer figures computed now. */
  const { refresh, refreshing } = useCacheRefresh();
  const onRefresh = () => void refresh([{ queryKey: buildQueryKey("/api/projects/overview"), load: () => api.get(withFresh("/api/projects/overview")) }]);
  /* Every other choice lives in the URL too (owner 2026-10-21): Back keeps
     them, the menu link (no parameters) starts on the defaults — this month,
     Newest, no filter, the trend on this year by month (projectOverviewView.ts). */
  const [params, setParams] = useSearchParams();
  const { brand, type, organizer, venue, state, stage, drill, dim, pick } = readView(params, today);
  const setView = (patch: Partial<OverviewView>) => setParams((prev) => writeView(prev, patch, today), { replace: true });
  const setDrill = (d: Drill) => setView({ drill: d });

  /* And the place you were looking at: kept, with this page's address, when a
     project is opened; the project's Back button returns to that address
     (projectBackTo) — browser Back does too — and the place is given back once
     the figures are on the page (owner 2026-10-21: 我点9月的project，按 back
     后又跳回10月，然后会跑回最上面). The page scrolls inside the app's <main>;
     the project table in its own box. */
  const location = useLocation();
  const rootRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const pageScroller = () => rootRef.current?.closest("main") ?? null;
  const here = `${location.pathname}${location.search}`;
  const openProject = (id: number) => {
    rememberOpenedFrom(id, here, { page: pageScroller()?.scrollTop ?? 0, table: tableRef.current?.scrollTop ?? 0, tableLeft: tableRef.current?.scrollLeft ?? 0 });
    navigate(`/projects/${id}`);
  };
  useEffect(() => {
    if (restored.current || !q.data) return;
    restored.current = true;
    const pos = takeScroll(here);
    if (!pos) return;
    requestAnimationFrame(() => {
      const page = pageScroller();
      if (page) page.scrollTop = pos.page;
      if (tableRef.current) { tableRef.current.scrollTop = pos.table; tableRef.current.scrollLeft = pos.tableLeft; }
    });
  }, [q.data, here]);

  const all = useMemo(() => (q.data?.projects ?? []).filter((p) =>
    (!brand || p.brand === brand) && (!type || p.eventType === type) && (!organizer || p.organizer === organizer)
    && (!venue || p.venue === venue) && (!state || p.state === state) && (!stage || p.stage === stage)), [q.data, brand, type, organizer, venue, state, stage]);
  const inPeriod = useMemo(() => all.filter((p) => !!p.startDate && p.startDate >= period.from && p.startDate <= period.to), [all, period.from, period.to]);
  const t = totalsOf(inPeriod);
  const groups = groupBy(inPeriod, (p) => p[dim]);
  /* Click a Breakdown header to rank by it (owner 2026-10-23). */
  const gSort = useTableSort(groups, (g, k) =>
    k === "key" ? g.key : k === "projects" ? g.projects : k === "sales" ? g.sales : k === "gpPct" ? pctOf(g.gp, g.sales)
      : k === "rental" ? g.rental : k === "rentalPct" ? pctOf(g.rental, g.sales) : k === "cost" ? g.rental + g.otherCost : k === "np" ? g.np : pctOf(g.np, g.sales));
  /* A month that has not started is left off: a few early bookings drew a huge NP % (owner 2026-11-05). */
  const trend = drillOf(all, drill, today).filter((b) => b.from <= today);
  /* Breadcrumb back up the drill: All years > 2026 > Q4 > Oct. */
  const crumbs: Array<[string, Drill]> = [["All years", { level: "years" }]];
  if (drill.level !== "years") {
    const year = drill.level === "weeks" ? Number(drill.month.slice(0, 4)) : drill.year;
    crumbs.push([String(year), drill.level === "yearMonths" ? drill : { level: "quarters", year }]);
    const quarter = drill.level === "months" ? drill.quarter : drill.level === "weeks" ? Math.ceil(Number(drill.month.slice(5, 7)) / 3) : null;
    if (quarter) crumbs.push([`Q${quarter}`, { level: "months", year, quarter }]);
    if (drill.level === "weeks") crumbs.push([drill.month, drill]);
  }
  const unit = drill.level === "years" ? "Year" : drill.level === "quarters" ? "Quarter" : drill.level === "months" || drill.level === "yearMonths" ? "Month" : "Week";
  const yearView = drill.level === "quarters" || drill.level === "yearMonths" ? drill.year : null;
  const openBucket = (b: (typeof trend)[number]) => { if (b.next) setDrill(b.next); else setPeriod(b.from, b.to > today ? today : b.to); };
  /* Running costs after COGS, only the ones that are not zero. */
  /* The lines of the Financial Snapshot, each against sales (owner 2026-10-19). */
  const cogsLines: Array<[string, number, string]> = [
    ["COGS — Matt / Sofa", t.cogsMattSofa, PALETTE[1]!], ["COGS — Bedframe", t.cogsBedframe, "#c98a4b"], ["COGS — Accessories", t.cogsAccessories, "#e0b184"],
    ...(Math.abs(t.cogsFromSo) >= 1 ? [["COGS — order cost not on a line", t.cogsFromSo, "#b07a3f"] as [string, number, string]] : []),
  ];
  const costLines: Array<[string, number, string]> = [
    ["Rental", t.rental, PALETTE[2]!], ["Setup", t.setup, PALETTE[5]!], ["Transport fee", t.transportFee, PALETTE[8]!],
    ["Transport setup & dismantle", t.transportSetup, "#7a9cc6"], ["Commission", t.commission, PALETTE[3]!], ["Merchandise", t.merchandise, PALETTE[7]!], ["Others costing", t.other, "#c9cdc4"],
  ];
  const running = costLines.reduce((a, [, v]) => a + v, 0);
  const npMax = Math.max(1, ...groups.map((g) => Math.abs(g.np)));
  const listed = inPeriod.filter((p) => !pick || (p[dim] || "—") === pick).map((p) => ({ p, f: figuresOf(p) }));
  /* Collected: what the period's orders have been paid, of what they ordered. */
  const paidSen = inPeriod.reduce((a, p) => a + p.collection.paidSen, 0);
  const orderedSen = inPeriod.reduce((a, p) => a + p.collection.totalSen, 0);
  const options = (key: "brand" | "eventType" | "organizer" | "venue" | "state" | "stage") => [...new Set((q.data?.projects ?? []).map((p) => p[key]).filter((x): x is string => !!x))].sort();

  return (
    <div ref={rootRef} className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <DateRangeButton from={period.from} to={period.to} presets={REPORT_RANGE_PRESETS} today={today} label="Event dates"
          onChange={(f, to) => { if (f && to) setPeriod(f, to); }} />
        <select className={SELECT_CLS} value={brand} onChange={(e) => setView({ brand: e.target.value })} aria-label="Brand"><option value="">All brands</option>{options("brand").map((b) => <option key={b}>{b}</option>)}</select>
        <select className={SELECT_CLS} value={type} onChange={(e) => setView({ type: e.target.value })} aria-label="Event type"><option value="">All event types</option>{options("eventType").map((b) => <option key={b}>{b}</option>)}</select>
        <select className={SELECT_CLS} value={organizer} onChange={(e) => setView({ organizer: e.target.value })} aria-label="Organizer"><option value="">All organizers</option>{options("organizer").map((b) => <option key={b}>{b}</option>)}</select>
        {/* Venue, state and stage too (owner 2026-11-01: every filter the page can take). */}
        <select className={SELECT_CLS} value={venue} onChange={(e) => setView({ venue: e.target.value })} aria-label="Venue"><option value="">All venues</option>{options("venue").map((b) => <option key={b}>{b}</option>)}</select>
        <select className={SELECT_CLS} value={state} onChange={(e) => setView({ state: e.target.value })} aria-label="State"><option value="">All states</option>{options("state").map((b) => <option key={b}>{b}</option>)}</select>
        <select className={SELECT_CLS} value={stage} onChange={(e) => setView({ stage: e.target.value })} aria-label="Stage"><option value="">All stages</option>{options("stage").map((b) => <option key={b} value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>)}</select>
        {q.loading && <span className="text-[11.5px] text-ink-muted">Loading…</span>}
        {q.data && <CacheStamp cachedAt={q.data.cachedAt} onRefresh={onRefresh} refreshing={refreshing} />}
      </div>
      {q.error && <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px] text-err">Could not load: {q.error}</div>}

      {/* The period's P&L, on the dark slab the home page uses for its hero. */}
      <section className="relative overflow-hidden rounded-2xl bg-sidebar px-5 py-5 text-sidebar-ink shadow-slab sm:px-7">
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full opacity-50 blur-2xl" style={{ background: "radial-gradient(circle, rgba(22,105,95,0.6), transparent 70%)" }} />
        <div className="relative">
          <div className="font-mono text-[10px] font-bold uppercase tracking-brand text-accent-bright">{period.label} · {t.projects} projects</div>
          <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            <Hero label="Sales" value={money(t.sales)} sub={t.fromSalesOrders ? `${t.fromSalesOrders} projects from Sales Orders` : "all from keyed books"} />
            <Hero label="Gross profit %" value={pctTxt(pctOf(t.gp, t.sales))} sub={`GP ${money(t.gp)}`} tone={t.gp >= 0 ? "good" : "bad"} />
            <Hero label="Net profit" value={money(t.np)} sub={`NP ${pctTxt(pctOf(t.np, t.sales))}`} tone={t.np >= 0 ? "good" : "bad"} />
            <Hero label="Collected" value={pctTxt(pctOf(paidSen, orderedSen))} sub={`${money(paidSen / 100)} of ${money(orderedSen / 100)} ordered`} />
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
          <Columns axes valueLabels={false} height={250} stacked={false} format={money} highlight={trend.findIndex((b) => today >= b.from && today <= b.to)}
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
          <RinggitBar sales={t.sales} parts={[["COGS", t.cogs, PALETTE[1]!], ...costLines.map(([l, v, c]) => [l, v, c] as [string, number, string]), ["Net profit", Math.max(0, t.np), "#2f8a5b"]]} />
          <table className="mt-3 w-full border-collapse text-[12.5px] tabular-nums"><tbody>
            <tr className="font-semibold"><Td left>Sales</Td><Td>{money(t.sales)}</Td><Td className="w-[64px] text-ink-muted">100.0%</Td></tr>
            {cogsLines.map(([l, v]) => <tr key={l} className={v ? "" : "text-ink-muted"}><Td left className="pl-6">{l}</Td><Td>{money(v)}</Td><Td className="text-ink-muted">{pctTxt(pctOf(v, t.sales))}</Td></tr>)}
            <tr className="bg-surface-2/70 font-semibold"><Td left className="border-t border-border">Total COGS</Td><Td className="border-t border-border">{money(t.cogs)}</Td><Td className="border-t border-border">{pctTxt(pctOf(t.cogs, t.sales))}</Td></tr>
            <tr className="bg-surface-2 font-bold"><Td left>Gross profit</Td><Td>{money(t.gp)}</Td><Td>{pctTxt(pctOf(t.gp, t.sales))}</Td></tr>
            {t.serviceRevenue !== 0 && <tr><Td left className="pl-6">Service revenue</Td><Td>{money(t.serviceRevenue)}</Td><Td className="text-ink-muted">{pctTxt(pctOf(t.serviceRevenue, t.sales))}</Td></tr>}
            {costLines.map(([l, v]) => <tr key={l} className={v ? "" : "text-ink-muted"}><Td left className="pl-6">{l}</Td><Td>{money(v)}</Td><Td className="text-ink-muted">{pctTxt(pctOf(v, t.sales))}</Td></tr>)}
            <tr className="bg-surface-2/70 font-semibold"><Td left className="border-t border-border">Total cost</Td><Td className="border-t border-border">{money(running)}</Td><Td className="border-t border-border">{pctTxt(pctOf(running, t.sales))}</Td></tr>
            <tr className="bg-primary-soft/60 font-bold"><Td left className="border-t-2 border-primary/50">Net profit</Td><Td className={cn("border-t-2 border-primary/50", t.np < 0 ? "text-err" : "text-synced")}>{money(t.np)}</Td><Td className="border-t-2 border-primary/50">{pctTxt(pctOf(t.np, t.sales))}</Td></tr>
          </tbody></table>
          <p className="mt-2 pb-14 text-[11.5px] text-ink-muted">The lines of each event&apos;s Financial Snapshot, added up; % = share of sales. A grey line has nothing in this period.</p>
        </Panel>
      </div>

      <Panel title="Breakdown" hint="largest sales first · click a header to rank · click a row to list its projects below" right={<Toggle value={dim} options={DIMS} onChange={(v) => setView({ dim: v, pick: null })} />}>
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface"><tr>
              <SortTh left k="key" sort={gSort.sort} onSort={gSort.toggle}>{DIMS.find(([d]) => d === dim)?.[1]}</SortTh><SortTh k="projects" sort={gSort.sort} onSort={gSort.toggle}>Projects</SortTh>
              <SortTh k="sales" sort={gSort.sort} onSort={gSort.toggle}>Sales</SortTh><SortTh k="gpPct" sort={gSort.sort} onSort={gSort.toggle}>GP %</SortTh>
              <SortTh k="rental" sort={gSort.sort} onSort={gSort.toggle}>Rental</SortTh><SortTh k="rentalPct" sort={gSort.sort} onSort={gSort.toggle}>Rental %</SortTh>
              <SortTh k="cost" sort={gSort.sort} onSort={gSort.toggle}>Event costs</SortTh><SortTh k="np" sort={gSort.sort} onSort={gSort.toggle}>Net profit</SortTh>
              <Th left> </Th><SortTh k="npPct" sort={gSort.sort} onSort={gSort.toggle}>NP %</SortTh>
            </tr></thead>
            <tbody>{gSort.sorted.map((g) => (
              <tr key={g.key} onClick={() => setView({ pick: pick === g.key ? null : g.key })} className={cn("cursor-pointer hover:bg-surface-2/50", pick === g.key && "bg-primary-soft/50")}>
                <Td left className="max-w-[220px] truncate">{g.key}</Td><Td>{g.projects}</Td><Td>{money(g.sales)}</Td><Td>{pctTxt(pctOf(g.gp, g.sales))}</Td><Td>{money(g.rental)}</Td><Td className="text-ink-secondary">{pctTxt(pctOf(g.rental, g.sales))}</Td><Td>{money(g.rental + g.otherCost)}</Td>
                <Td className={g.np < 0 ? "font-semibold text-err" : "font-semibold text-synced"}>{money(g.np)}</Td>
                <Td left className="w-[18%]"><div className="h-2 rounded-full bg-surface-2"><div className="h-2 rounded-full" style={{ width: `${(Math.abs(g.np) / npMax) * 100}%`, background: g.np < 0 ? TONE.bad : TONE.good }} /></div></Td>
                <Td>{pctTxt(pctOf(g.np, g.sales))}</Td>
              </tr>))}
              {groups.length === 0 && <tr><Td left className="text-ink-muted">No projects in this period.</Td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* The project list first, the venue rent after it (owner 2026-10-25:
          把venue rent 和 project 倒反位置). */}
      <Panel title={`Projects${pick ? ` · ${pick}` : ""}`} hint={`${listed.length} projects · amounts in RM · click one to open it`}
        right={pick ? <button type="button" className="text-[12px] text-primary hover:underline" onClick={() => setView({ pick: null })}>Show all</button> : undefined}>
        <div ref={tableRef}>
          <ProjectOverviewTable rows={listed} loading={q.loading} onOpen={openProject} />
        </div>
      </Panel>

      <VenueRentPanel projects={inPeriod} periodLabel={period.label} />

      <ProjectStuckPanel onOpen={openProject} />
      <ProjectDataGapsPanel onOpen={openProject} />
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

/** Where the sales went, as one bar of shares (owner 2026-11-05): each cost and the net
 *  profit as its part of sales, the same lines as the table under it. */
function RinggitBar({ sales, parts }: { sales: number; parts: Array<[string, number, string]> }) {
  if (sales <= 0) return null;
  const shown = parts.filter(([, v]) => v > 0);
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-2" role="img" aria-label="Share of sales">
        {shown.map(([l, v, c]) => <div key={l} style={{ width: `${Math.min(100, (v / sales) * 100)}%`, background: c }} title={`${l}: ${pctTxt(pctOf(v, sales))}`} />)}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-muted">
        {shown.map(([l, v, c]) => <span key={l} className="inline-flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: c }} />{l} {pctTxt(pctOf(v, sales))}</span>)}
      </div>
    </div>
  );
}
