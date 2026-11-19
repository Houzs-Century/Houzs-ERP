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
import { PROJECT_REPORT_RANGE_PRESETS, monthEnd, presetLabel, presetOf } from "../../lib/dateRangePresets";
import { ProjectOverviewTable } from "./ProjectOverviewTable";
import { ProjectDataGapsPanel, ProjectStuckPanel } from "./ProjectOverviewParts";
import { figuresOf, totalsOf, groupBy, drillOf, heldVsComing, isHeld, forecastShareOf, pctOf, type OvProject, type Drill } from "./projectOverviewModel";
import { VIEW_PARAMS, readView, rememberOpenedFrom, takeScroll, writeView, type Dim, type OverviewView } from "./projectOverviewView";

type Part = "all" | "held" | "coming";
const PART_PARAM = "af_part";
const DIMS: Array<[Dim, string]> = [["brand", "Brand"], ["eventType", "Event type"], ["organizer", "Organizer"], ["venue", "Venue"], ["state", "State"]];
const money = formatCurrency;
const pctTxt = (x: number | null) => (x == null ? "—" : `${x.toFixed(1)}%`);
export function ProjectOverviewPage() {
  const navigate = useNavigate();
  const today = todayMY();
  /* A new period drops the breakdown pick in the same URL write. */
  const [period, setPeriod] = useDashboardPeriod(today, "af_from", "af_to", [VIEW_PARAMS.pick, PART_PARAM]);
  /* "This month" is the WHOLE month (owner 2026-11-19: 下个礼拜的 project 没进来):
     an event booked for next week belongs to it and carries its forecast. The
     shared period reads "This month" as the 1st to today, so that one (and the
     empty-URL default) widens here to the month's last day. */
  const win = period.key === "month" ? { from: period.from, to: monthEnd(today) } : { from: period.from, to: period.to };
  const winPreset = presetOf(win, PROJECT_REPORT_RANGE_PRESETS, today);
  const winLabel = winPreset === "wholeMonth" ? `This month (${today.slice(0, 7)})` : winPreset ? presetLabel(winPreset) : period.label;
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
  const inPeriod = useMemo(() => all.filter((p) => !!p.startDate && p.startDate >= win.from && p.startDate <= win.to), [all, win.from, win.to]);
  const t = totalsOf(inPeriod);
  const split = heldVsComing(inPeriod, today);
  /* Clicking Held so far / Still to come in the hero narrows every panel below
     to that part; Projected total (the default) shows all (owner 2026-11-19). */
  const partParam = params.get(PART_PARAM);
  const part: Part = split && (partParam === "held" || partParam === "coming") ? partParam : "all";
  const setPart = (next: Part) => setParams((prev) => { const n = new URLSearchParams(prev); if (next === "all") n.delete(PART_PARAM); else n.set(PART_PARAM, next); return n; }, { replace: true });
  const shown = useMemo(() => (part === "all" ? inPeriod : inPeriod.filter((p) => (part === "held" ? isHeld(p, today) : !isHeld(p, today)))), [inPeriod, part, today]);
  const ts = part === "all" ? t : totalsOf(shown);
  const partLabel = part === "held" ? " · held so far" : part === "coming" ? " · still to come" : "";
  const groups = groupBy(shown, (p) => p[dim]);
  /* Click a Breakdown header to rank by it (owner 2026-10-23). */
  const gSort = useTableSort(groups, (g, k) =>
    k === "key" ? g.key : k === "projects" ? g.projects : k === "sales" ? g.sales : k === "gpPct" ? pctOf(g.gp, g.sales)
      : k === "rental" ? g.rental : k === "rentalPct" ? pctOf(g.rental, g.sales) : k === "cost" ? g.rental + g.otherCost : k === "np" ? g.np : pctOf(g.np, g.sales));
  /* A month that has not started is left off: a few early bookings drew a huge NP % (owner 2026-11-05) -
     unless the period picked reaches it, where its events carry their forecast (owner 2026-11-18). */
  const trendEnd = win.to > today ? win.to : today;
  const trend = drillOf(all, drill, today).filter((b) => b.from <= trendEnd);
  /* The part of each bucket's sales still to come (events after today), on forecast. */
  const toCome = trend.map((b) => totalsOf(all.filter((p) => !!p.startDate && !isHeld(p, today) && p.startDate >= b.from && p.startDate <= b.to)).sales);
  const anyToCome = toCome.some((v) => v !== 0);
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
  const openBucket = (b: (typeof trend)[number]) => { if (b.next) setDrill(b.next); else setPeriod(b.from, b.to); };
  /* Running costs after COGS, only the ones that are not zero. */
  /* The lines of the Financial Snapshot, each against sales (owner 2026-10-19). */
  const cogsLines: Array<[string, number, string]> = [
    ["COGS — Matt / Sofa", ts.cogsMattSofa, PALETTE[1]!], ["COGS — Bedframe", ts.cogsBedframe, "#c98a4b"], ["COGS — Accessories", ts.cogsAccessories, "#e0b184"],
    ...(Math.abs(ts.cogsFromSo) >= 1 ? [["COGS — order cost not on a line", ts.cogsFromSo, "#b07a3f"] as [string, number, string]] : []),
  ];
  const costLines: Array<[string, number, string]> = [
    ["Rental", ts.rental, PALETTE[2]!], ["Setup", ts.setup, PALETTE[5]!], ["Transport fee", ts.transportFee, PALETTE[8]!],
    ["Transport setup & dismantle", ts.transportSetup, "#7a9cc6"], ["Commission", ts.commission, PALETTE[3]!], ["Merchandise", ts.merchandise, PALETTE[7]!], ["Others costing", ts.other, "#c9cdc4"],
  ];
  const running = costLines.reduce((a, [, v]) => a + v, 0);
  const npMax = Math.max(1, ...groups.map((g) => Math.abs(g.np)));
  const listed = shown.filter((p) => !pick || (p[dim] || "—") === pick).map((p) => ({ p, f: figuresOf(p) }));
  /* Collected: what the period's orders have been paid, of what they ordered. */
  const paidSen = shown.reduce((a, p) => a + p.collection.paidSen, 0);
  const orderedSen = shown.reduce((a, p) => a + p.collection.totalSen, 0);
  const options = (key: "brand" | "eventType" | "organizer" | "venue" | "state" | "stage") => [...new Set((q.data?.projects ?? []).map((p) => p[key]).filter((x): x is string => !!x))].sort();

  return (
    <div ref={rootRef} className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <DateRangeButton from={win.from} to={win.to} presets={PROJECT_REPORT_RANGE_PRESETS} today={today} label="Event dates"
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
          <div className="font-mono text-[10px] font-bold uppercase tracking-brand text-accent-bright">{winLabel}{partLabel} · {ts.projects} projects</div>
          <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* The big figures follow the part picked below (owner 2026-11-19: 我点了 上面不会跳). */}
            <Hero label="Sales" value={money(ts.sales)} sub={ts.split.sales.forecast + ts.split.sales.last_event !== 0 ? "includes forecast, split below" : ts.fromSalesOrders ? `${ts.fromSalesOrders} projects from Sales Orders` : "all from keyed books"} />
            <Hero label="Gross profit %" value={pctTxt(pctOf(ts.gp, ts.sales))} sub={`GP ${money(ts.gp)}`} tone={ts.gp >= 0 ? "good" : "bad"} />
            <Hero label="Net profit" value={money(ts.np)} sub={`NP ${pctTxt(pctOf(ts.np, ts.sales))}`} tone={ts.np >= 0 ? "good" : "bad"} />
            <Hero label="Collected" value={pctTxt(pctOf(paidSen, orderedSen))} sub={`${money(paidSen / 100)} of ${money(orderedSen / 100)} ordered`} />
          </div>
          {split && <HeldComingRow held={split.held} coming={split.coming} total={t} today={today} part={part} onPart={setPart} />}
          {ts.estimated > 0 && <LayerSplitRow t={ts} />}
          {ts.noSales > 0 && <p className="mt-3 text-[11.5px] text-sidebar-ink/70">{ts.noSales} projects in this period have neither keyed sales nor Sales Orders yet.</p>}
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
            forecast={{ share: trend.map(forecastShareOf) }}
            labels={trend.map((b) => b.label)}
            series={[{ name: "Sales", color: PALETTE[0]! }, { name: "Gross profit", color: "#8fb3ae" }]}
            values={[trend.map((b) => b.sales), trend.map((b) => Math.max(0, b.gp))]}
            line={{ name: "Net profit %", color: PALETTE[1]!, values: trend.map((b) => pctOf(b.np, b.sales)), format: (x) => `${x.toFixed(1)}%` }} />
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead><tr><Th left>{unit}</Th><Th>Projects</Th><Th>Sales</Th>{anyToCome && <Th>To come</Th>}<Th>GP</Th><Th>GP %</Th><Th>NP</Th><Th>NP %</Th></tr></thead>
              <tbody>{trend.map((b, i) => ({ b, come: toCome[i] ?? 0 })).reverse().map(({ b, come }) => (
                <tr key={b.key} className="cursor-pointer hover:bg-surface-2/50" onClick={() => openBucket(b)}>
                  <Td left className="text-primary">{b.label}{b.next ? " ›" : ""}</Td><Td>{b.projects}</Td><Td>{money(b.sales)}</Td>{anyToCome && <Td className="text-ink-muted">{come ? money(come) : "—"}</Td>}<Td>{money(b.gp)}</Td><Td>{pctTxt(pctOf(b.gp, b.sales))}</Td>
                  <Td className={b.np < 0 ? "text-err" : ""}>{money(b.np)}</Td><Td>{pctTxt(pctOf(b.np, b.sales))}</Td>
                </tr>))}</tbody>
            </table>
            <p className="mt-1 text-[11px] text-ink-muted">{drill.level === "weeks" ? "Click a week to show its projects across the page." : "Year, then its quarters, then its months, then the weeks of a month."}{anyToCome ? " To come = events not started or with no sales in yet, on their forecast. Hatched bar and dashed line = forecast." : ""}</p>
          </div>
        </Panel>
        <Panel title="Where each ringgit of sales goes" hint={`${winLabel}${partLabel}`}>
          <RinggitBar sales={ts.sales} parts={[["COGS", ts.cogs, PALETTE[1]!], ...costLines.map(([l, v, c]) => [l, v, c] as [string, number, string]), ["Net profit", Math.max(0, ts.np), "#2f8a5b"]]} />
          <table className="mt-3 w-full border-collapse text-[12.5px] tabular-nums"><tbody>
            <tr className="font-semibold"><Td left>Sales</Td><Td>{money(ts.sales)}</Td><Td className="w-[64px] text-ink-muted">100.0%</Td></tr>
            {cogsLines.map(([l, v]) => <tr key={l} className={v ? "" : "text-ink-muted"}><Td left className="pl-6">{l}</Td><Td>{money(v)}</Td><Td className="text-ink-muted">{pctTxt(pctOf(v, ts.sales))}</Td></tr>)}
            <tr className="bg-surface-2/70 font-semibold"><Td left className="border-t border-border">Total COGS</Td><Td className="border-t border-border">{money(ts.cogs)}</Td><Td className="border-t border-border">{pctTxt(pctOf(ts.cogs, ts.sales))}</Td></tr>
            <tr className="bg-surface-2 font-bold"><Td left>Gross profit</Td><Td>{money(ts.gp)}</Td><Td>{pctTxt(pctOf(ts.gp, ts.sales))}</Td></tr>
            {ts.serviceRevenue !== 0 && <tr><Td left className="pl-6">Service revenue</Td><Td>{money(ts.serviceRevenue)}</Td><Td className="text-ink-muted">{pctTxt(pctOf(ts.serviceRevenue, ts.sales))}</Td></tr>}
            {costLines.map(([l, v]) => <tr key={l} className={v ? "" : "text-ink-muted"}><Td left className="pl-6">{l}</Td><Td>{money(v)}</Td><Td className="text-ink-muted">{pctTxt(pctOf(v, ts.sales))}</Td></tr>)}
            <tr className="bg-surface-2/70 font-semibold"><Td left className="border-t border-border">Total cost</Td><Td className="border-t border-border">{money(running)}</Td><Td className="border-t border-border">{pctTxt(pctOf(running, ts.sales))}</Td></tr>
            <tr className="bg-primary-soft/60 font-bold"><Td left className="border-t-2 border-primary/50">Net profit</Td><Td className={cn("border-t-2 border-primary/50", ts.np < 0 ? "text-err" : "text-synced")}>{money(ts.np)}</Td><Td className="border-t-2 border-primary/50">{pctTxt(pctOf(ts.np, ts.sales))}</Td></tr>
          </tbody></table>
          <p className="mt-2 pb-14 text-[11.5px] text-ink-muted">The lines of each event&apos;s Financial Snapshot, added up; % = share of sales. A grey line has nothing in this period.</p>
        </Panel>
      </div>

      <Panel title={`Breakdown${partLabel}`} hint="largest sales first · click a header to rank · click a row to list its projects below" right={<Toggle value={dim} options={DIMS} onChange={(v) => setView({ dim: v, pick: null })} />}>
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
      <Panel title={`Projects${pick ? ` · ${pick}` : ""}${partLabel}`} hint={`${listed.length} projects · amounts in RM · click one to open it`}
        right={pick ? <button type="button" className="text-[12px] text-primary hover:underline" onClick={() => setView({ pick: null })}>Show all</button> : undefined}>
        <div ref={tableRef}>
          <ProjectOverviewTable rows={listed} loading={q.loading} onOpen={openProject} />
        </div>
      </Panel>

      <VenueRentPanel projects={shown} periodLabel={`${winLabel}${partLabel}`} />

      <ProjectStuckPanel onOpen={openProject} />
      <ProjectDataGapsPanel onOpen={openProject} />
    </div>
  );
}

/** A period that runs past today, in three plain figures (owner 2026-11-19):
 *  what has been held, what is still to come, and the projected total. */
function HeldComingRow({ held, coming, total, today, part, onPart }: { held: ReturnType<typeof totalsOf>; coming: ReturnType<typeof totalsOf>; total: ReturnType<typeof totalsOf>; today: string; part: Part; onPart: (p: Part) => void }) {
  const cells: Array<[Part, string, string, ReturnType<typeof totalsOf>]> = [
    ["held", "Held so far", `${held.projects} project${held.projects === 1 ? "" : "s"} with real sales, by ${today.slice(8)}/${today.slice(5, 7)}`, held],
    ["coming", "Still to come", `${coming.projects} project${coming.projects === 1 ? "" : "s"} · not started or no sales in yet · on forecast`, coming],
    ["all", "Projected total", "held + still to come", total],
  ];
  return (
    <div className="mt-4" data-testid="held-coming">
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {cells.map(([key, label, sub, x]) => (
        <button type="button" key={key} onClick={() => onPart(key)} aria-pressed={part === key}
          className={cn("rounded-lg px-3 py-2 text-left ring-1 transition-colors", part === key ? "bg-white/15 ring-accent-bright" : "bg-white/5 ring-transparent hover:bg-white/10")}>
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-sidebar-ink/70">{label}</div>
          <div className="mt-0.5 font-display text-[17px] font-bold tabular-nums">{money(x.sales)}</div>
          <div className="text-[11.5px] tabular-nums text-sidebar-ink/80">
            NP <span className={x.np < 0 ? "text-[#f0a39b]" : "text-[#8fe0b5]"}>{money(x.np)}</span> · {pctTxt(pctOf(x.np, x.sales))}
          </div>
          <div className="text-[11px] text-sidebar-ink/60">{sub}</div>
        </button>
      ))}
    </div>
    <p className="mt-1.5 text-[11px] text-sidebar-ink/60">Click one to show only that part in the panels below.</p>
    </div>
  );
}

/** The period's totals cut in two (owner 2026-11-19: last event 就是 forecast
 *  来的): what is real, and what is forecast - typed, or the last same event's
 *  result standing in for one. */
function LayerSplitRow({ t }: { t: ReturnType<typeof totalsOf> }) {
  const rows: Array<[string, ReturnType<typeof totalsOf>["split"]["sales"]]> = [["Sales", t.split.sales], ["Total cost", t.split.cost], ["Net profit", t.split.net]];
  return (
    <div className="mt-4 overflow-x-auto rounded-lg bg-white/5 px-3 py-2" data-testid="layer-split">
      <div className="mb-1 text-[11px] text-sidebar-ink/70">{t.estimated} of {t.projects} projects include a forecast (typed, or the last same event&apos;s result)</div>
      <table className="w-full min-w-[420px] border-collapse text-[12px] tabular-nums">
        <thead><tr className="text-left text-[10.5px] uppercase tracking-wider text-sidebar-ink/70">
          <th className="py-0.5 font-semibold"> </th><th className="py-0.5 text-right font-semibold">Actual</th><th className="py-0.5 text-right font-semibold">Forecast</th>
        </tr></thead>
        <tbody>{rows.map(([label, s]) => (
          <tr key={label}><td className="py-0.5 text-sidebar-ink/80">{label}</td><td className="py-0.5 text-right">{money(s.actual)}</td><td className="py-0.5 text-right">{money(s.forecast + s.last_event)}</td></tr>
        ))}</tbody>
      </table>
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
