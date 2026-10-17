// Logistic Overview (owner, 2026-10-16) — the weekly logistic report and the
// "HC Delivery Operations Dashboard" sheet, now from the ERP itself:
//   action tiles, order status, KPI scorecard against targets, the next 30 days,
//   the weekly report, monthly delivery volume, the process gaps that make some
//   of those figures read low, today's runs and the urgent list.
// Data: the Delivery Planning board (what is pending / ready / confirmed),
// GET /api/scm/logistic-overview (weekly + monthly history, delivered-but-owing,
// process gaps) and GET /api/scm/trips/day (today's runs).
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "../../components/Layout";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { api } from "../../api/client";
import { useDeliveryPlanning, type PlanningOrder } from "../../vendor/scm/lib/delivery-planning-queries";
import { useFleetDay } from "../../vendor/scm/lib/fleet-day-queries";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { cn } from "../../lib/utils";
import { Th, Td, Panel, SELECT_CLS, Toggle } from "../../components/scm-v2/OverviewKit";
import { DashboardPeriodPicker, useDashboardPeriod } from "../../components/scm-v2/DashboardPeriod";
import { LogisticPeriodSection, type PeriodTotals } from "./LogisticPeriodSection";
import { LogisticDailySection } from "./LogisticDailySection";
import { Donut, Columns, Bullet, SplitBar, Tile, TONE, PALETTE } from "../../components/scm-v2/Charts";

type Week = { from: string; to: string; doCount: number; doAmountSen: number; delivered: number; runs: number; current: boolean };
type History = {
  today: string; thisMonday: string; weeks: Week[];
  months: Array<{ month: string; doCount: number; doAmountSen: number }>;
  deliveredOwing: { count: number; balanceSen: number; oldestDays: number };
  deliveredOwingOver30: { count: number; balanceSen: number; oldestDays: number };
  doNotClosed: { count: number; amountSen: number; over30: number; over30Sen: number };
  doNoCost: { count: number; amountSen: number };
  period: PeriodTotals;
};

const DAY = 86400000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dd = (d: string) => d.slice(5).replace("-", "/");
const AVG_SALES_PER_RUN_TARGET_SEN = 30000_00;
// Money reads like AutoCount everywhere: "RM 15,000.00" (owner 2026-09-15).
const rm = fmtSen;
const n = (v: number) => v.toLocaleString();
const pctFmt = (x: number) => `${x.toFixed(1)}%`;
/* The customer follow-up an open order is waiting on, from its message status
   on Delivery Planning. */
const FOLLOW_UP: Array<[string, RegExp]> = [
  ["Waiting for the customer to reply", /Pending Customer Reply|To Remind Customer Reply/i],
  ["To reschedule", /Pending Reschedule|Postpone/i],
  ["Delivery date not sent yet", /To Send Delivery Date|Not Sent/i],
  ["Balance to collect", /Collect Balance|Balance Reminder/i],
  ["Date agreed", /Done Scheduling|Delivery Time|Driver|Reminder Sent|Done Remind/i],
  ["Address or contact wrong", /Invalid/i],
];
const followUpOf = (s: string | null) => (s ? FOLLOW_UP.find(([, rx]) => rx.test(s))?.[0] ?? "Other" : "No follow-up yet");

/** `embedded`: inside the phone shell, which draws its own header. */
export function LogisticOverview({ embedded }: { embedded: boolean }) {
  const today = todayMY();
  const navigate = useNavigate();
  const [period, setPeriod] = useDashboardPeriod(today, "from", "to", []);
  /* Every warehouse unless one is picked (owner 2026-10-17). */
  const [params, setParams] = useSearchParams();
  const warehouse = params.get("warehouse") ?? "";
  const setWarehouse = (w: string) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (w) next.set("warehouse", w); else next.delete("warehouse");
    return next;
  }, { replace: true });
  const board = useDeliveryPlanning({ region: "ALL", state: "ALL" });
  /* Delivery Planning is the shared queue of every company the caller may see;
     this page reports the active company, like its DO figures, so board rows
     of another company are left out. A row with no company tag stays. */
  const companies = useQuery({ queryKey: ["companies"], queryFn: () => api.get<{ activeCompanyCode: string | null }>("/api/companies"), staleTime: 300_000 });
  const activeCode = companies.data?.activeCompanyCode ?? null;
  const hist = useQuery({
    queryKey: ["logistic-overview", period.from, period.to, warehouse],
    queryFn: () => authedFetch<History>(`/logistic-overview?from=${period.from}&to=${period.to}${warehouse ? `&warehouse=${warehouse}` : ""}`),
    staleTime: 60_000,
  });
  const day = useFleetDay({ date: today });

  const warehouses = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of board.data?.orders ?? []) if (o.warehouse_id && (!activeCode || !o.company_code || o.company_code === activeCode)) map.set(o.warehouse_id, [o.warehouse_name, o.warehouse_code].filter(Boolean).join(" · ") || o.warehouse_id);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [board.data, activeCode]);
  const allRows: PlanningOrder[] = useMemo(() => (board.data?.orders ?? [])
    .filter((o) => !activeCode || !o.company_code || o.company_code === activeCode)
    .filter((o) => !warehouse || o.warehouse_id === warehouse), [board.data, warehouse, activeCode]);
  const rows: PlanningOrder[] = useMemo(() => allRows.filter((o) => o.row_type === "so"), [allRows]);
  /* Counted from the (warehouse-filtered) rows, so the status split always
     agrees with the rows the rest of the page reads. */
  const counts = useMemo(() => {
    const c: Partial<Record<string, number>> = {};
    for (const o of rows) c[o.delivery_state] = (c[o.delivery_state] ?? 0) + 1;
    return c;
  }, [rows]);

  const m = useMemo(() => {
    const open = rows.filter((o) => o.delivery_state !== "DELIVERED");
    const effective = (o: PlanningOrder) => (o.effective_delivery_date ?? null);
    const in3 = open.filter((o) => { const e = effective(o); return !!e && e >= today && e <= addDays(today, 3); });
    const urgent = in3.filter((o) => !o.is_ship_ready);
    const noPhone = open.filter((o) => !String(o.phone ?? "").trim());
    const nextMonday = hist.data ? addDays(hist.data.thisMonday, 7) : addDays(today, 7);
    const windowEnd = addDays(nextMonday, 29);
    const due30 = open.filter((o) => { const e = effective(o); return !!e && e >= nextMonday && e <= windowEnd; });
    const ready = due30.filter((o) => o.is_ship_ready);
    const confirmed = ready.filter((o) => !!o.amended_delivery_date);
    const nextWeekScheduled = open.filter((o) => { const e = effective(o); return !!o.trip_id && !!e && e >= nextMonday && e <= addDays(nextMonday, 6); });
    return {
      openCount: open.length, openSen: open.reduce((a, o) => a + o.local_total_sen, 0),
      in3: in3.length, urgent, noPhone,
      phoneComplete: open.length ? (open.length - noPhone.length) / open.length : null,
      nextMonday, windowEnd, due30: due30.length, notReady: due30.length - ready.length, ready: ready.length,
      confirmed: confirmed.length, pendingConfirm: ready.length - confirmed.length, nextWeekScheduled: nextWeekScheduled.length,
    };
  }, [rows, today, hist.data]);

  const h = hist.data;
  const weeks = h?.weeks ?? [];
  const months = h?.months ?? [];
  /* Average sales per lorry run over the picked period, from its runs. */
  const avgPerRun = h?.period.runs ? h.period.runAmountSen / h.period.runs : null;
  const lastWeek = h ? weeks.find((w) => w.to === addDays(h.thisMonday, -1)) : undefined;
  const nextWeek = h ? weeks.find((w) => w.from === addDays(h.thisMonday, 7)) : undefined;
  const runsToday = day.data?.trips ?? [];
  const status: Array<[string, string, string]> = [
    ["PENDING_DELIVERY", "Pending delivery", PALETTE[2]!], ["PENDING_SCHEDULE", "Pending schedule", TONE.warn],
    ["OVERDUE", "Overdue", TONE.bad], ["DELIVERED", "Delivered", TONE.good],
  ];
  const statusTotal = status.reduce((a, [k]) => a + ((counts[k] ?? 0)), 0);
  const loading = board.isLoading || hist.isLoading;
  const v = (x: number | undefined) => (loading || x == null ? "…" : n(x));
  const jump = (id: string) => () => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  const [monthBy, setMonthBy] = useState<"amount" | "orders">("amount");
  /* Outstanding delivery orders: every open sales order, split by where it
     stands and by the customer follow-up it waits on. */
  const open = rows.filter((o) => o.delivery_state !== "DELIVERED");
  const openSen = open.reduce((a, o) => a + o.local_total_sen, 0);
  const byState = status.filter(([k]) => k !== "DELIVERED").map(([k, label, color]) => {
    const xs = open.filter((o) => o.delivery_state === k);
    return { label, color, count: xs.length, sen: xs.reduce((a, o) => a + o.local_total_sen, 0) };
  });
  const followMap = new Map<string, { count: number; sen: number }>();
  for (const o of open) { const k = followUpOf(o.delivery_message_status); const g = followMap.get(k) ?? { count: 0, sen: 0 }; g.count += 1; g.sen += o.local_total_sen; followMap.set(k, g); }
  const follow = [...followMap.entries()].sort((a, b) => b[1].count - a[1].count);

  return (
    <div className="space-y-4">
      {!embedded && <PageHeader eyebrow="Supply chain · Transportation" title="Logistic Overview"
        description="What needs action, where every order stands, the weekly logistic report and today's runs — straight from the orders and delivery orders." />}
      <div className="flex flex-wrap items-center gap-2">
        <DashboardPeriodPicker period={period} today={today} onChange={setPeriod} />
        <select className={SELECT_CLS} value={warehouse} onChange={(e) => setWarehouse(e.target.value)} aria-label="Warehouse">
          <option value="">All warehouses</option>
          {warehouses.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        {hist.isFetching && <span className="text-[11.5px] text-ink-muted">Loading…</span>}
      </div>
      {(board.error || hist.error) && <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px] text-err">Could not load: {((board.error ?? hist.error) as Error).message}</div>}

      <LogisticPeriodSection rows={allRows} period={period} today={today} totals={hist.data?.period ?? null} />

      {hist.data?.period && <LogisticDailySection days={hist.data.period.days} regions={hist.data.period.byRegion} runs={hist.data.period.runList} />}

      <Panel title="Outstanding delivery orders" hint={`${warehouse ? "this warehouse" : "all warehouses"} · every sales order not yet delivered, today`}>
        <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-[26px] font-bold tabular-nums text-ink">{loading ? "…" : n(open.length)}</span>
          <span className="text-[13px] text-ink-secondary">orders · {fmtSen(openSen)}</span>
          {m.urgent.length > 0 && <button type="button" onClick={jump("urgent")} className="text-[12px] text-err hover:underline">{m.urgent.length} due in 3 days and not ready</button>}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <div className="mb-1 text-[12px] font-semibold text-ink">Where they stand</div>
            <SplitBar format={n} parts={byState.map((x) => ({ label: x.label, value: x.count, color: x.color }))} />
            <table className="mt-2 w-full border-collapse"><tbody>
              {byState.map((x) => <tr key={x.label}><Td left>{x.label}</Td><Td>{x.count}</Td><Td>{fmtSen(x.sen)}</Td></tr>)}
            </tbody></table>
          </div>
          <div>
            <div className="mb-1 text-[12px] font-semibold text-ink">Customer follow-up</div>
            <table className="w-full border-collapse"><tbody>
              {follow.map(([k, g]) => <tr key={k}><Td left className={k.startsWith("Waiting") || k.startsWith("To reschedule") ? "text-warning-text" : ""}>{k}</Td><Td>{g.count}</Td><Td>{fmtSen(g.sen)}</Td></tr>)}
            </tbody></table>
          </div>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="KPI scorecard" hint="actual against target">
          <div className="space-y-3">
            <Bullet label="Phone completeness" actual={m.phoneComplete != null ? m.phoneComplete * 100 : null} target={100} max={100} format={pctFmt} higherIsBetter />
            <Bullet label="Ready orders with a confirmed date" actual={m.ready ? (m.confirmed / m.ready) * 100 : null} target={100} max={100} format={pctFmt} higherIsBetter />
            <Bullet label="Overdue share" actual={statusTotal ? ((counts.OVERDUE ?? 0) / statusTotal) * 100 : null} target={5} max={20} format={pctFmt} higherIsBetter={false} />
            <Bullet label={`Avg sales per lorry run · ${period.label}`} actual={avgPerRun} target={AVG_SALES_PER_RUN_TARGET_SEN} max={AVG_SALES_PER_RUN_TARGET_SEN * 2} format={fmtSen} higherIsBetter />
          </div>
          {avgPerRun == null && <p className="mt-2 text-[11px] text-ink-muted">Avg sales per run fills in once lorry runs are planned in Delivery Time Arrangement.</p>}
        </Panel>
        <Panel title={`Orders due ${dd(m.nextMonday)} – ${dd(m.windowEnd)}`} hint={`${m.due30} orders`}>
          <SplitBar format={n} parts={[
            { label: "Not ready", value: m.notReady, color: TONE.bad },
            { label: "Ready, date not confirmed", value: m.pendingConfirm, color: TONE.warn },
            { label: "Ready and confirmed", value: m.confirmed, color: TONE.good },
          ]} />
          <div className="mt-4 text-[12.5px] font-semibold text-ink">Next week</div>
          <table className="mt-1 w-full border-collapse"><tbody>
            <tr><Td left>Orders placed on a lorry run</Td><Td>{m.nextWeekScheduled}</Td></tr>
            <tr><Td left>Lorry runs planned</Td><Td>{nextWeek?.runs ?? 0}</Td></tr>
            <tr><Td left>DO already issued</Td><Td>{nextWeek?.doCount ?? 0}</Td></tr>
          </tbody></table>
          <Link to="/scm/trips" className="mt-2 inline-block text-[12px] text-primary hover:underline">Plan runs in Delivery Time Arrangement</Link>
        </Panel>
      </div>

      <Panel title="Weekly logistic report" hint="Monday to Sunday · this week highlighted">
        <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
          <Columns height={200} labels={weeks.map((w) => dd(w.from))} highlight={weeks.findIndex((w) => w.current)} stacked={false} format={n}
            series={[{ name: "DO issued", color: PALETTE[0] }, { name: "Marked delivered", color: TONE.good }]}
            values={[weeks.map((w) => w.doCount), weeks.map((w) => w.delivered)]}
            line={{ name: "DO amount", color: PALETTE[2], values: weeks.map((w) => w.doAmountSen), format: rm }} />
          <table className="w-full border-collapse self-start">
            <thead><tr><Th left>Week</Th><Th>DO</Th><Th>Amount</Th><Th>Delivered</Th><Th>Runs</Th></tr></thead>
            <tbody>{weeks.map((w) => (
              <tr key={w.from} className={cn(w.current && "bg-primary-soft/40 font-semibold")}>
                <Td left>{dd(w.from)} – {dd(w.to)}{w.current ? " · now" : w.from > (h?.thisMonday ?? "") ? " · next" : ""}</Td>
                <Td>{w.doCount}</Td><Td>{rm(w.doAmountSen)}</Td>
                <Td className={w.doCount > 5 && w.delivered === 0 && w.from < (h?.thisMonday ?? "") ? "text-err" : ""}>{w.delivered}</Td><Td>{w.runs}</Td>
              </tr>))}</tbody>
          </table>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Monthly delivery volume" hint="delivery orders issued each month"
          right={<Toggle value={monthBy} options={[["amount", "By amount"], ["orders", "By orders"]]} onChange={setMonthBy} />}>
          <Columns height={190} labels={months.map((x) => x.month.slice(2).replace("-", "/"))} highlight={months.length - 1} stacked={false} format={monthBy === "amount" ? rm : (x) => `${x} DO`}
            series={[{ name: monthBy === "amount" ? "DO amount" : "DO issued", color: PALETTE[0] }]} values={[months.map((x) => (monthBy === "amount" ? x.doAmountSen : x.doCount))]}
            line={null} />
          <table className="mt-2 w-full border-collapse">
            <thead><tr><Th left>Month</Th><Th>DO</Th><Th>Amount</Th><Th>Average order</Th></tr></thead>
            <tbody>{months.slice().reverse().map((x) => <tr key={x.month}><Td left>{x.month}</Td><Td>{x.doCount}</Td><Td>{rm(x.doAmountSen)}</Td><Td>{x.doCount ? rm(Math.round(x.doAmountSen / x.doCount)) : "—"}</Td></tr>)}</tbody>
          </table>
          <p className="mt-1 text-[11px] text-ink-muted">Counts delivery orders raised in the ERP; months before the ERP took over delivery orders read low.</p>
        </Panel>
        <section id="gaps">
          <Panel title="Process gaps" hint="why some figures above read low">
            <ul className="space-y-3 text-[12.5px]">
              <li>
                <div className="flex flex-wrap items-baseline justify-between gap-x-2"><b className="text-ink">DO loaded, never closed as delivered</b><span className="tabular-nums text-warning-text">{h ? `${n(h.doNotClosed.count)} DO · ${rm(h.doNotClosed.amountSen)}` : "…"}</span></div>
                <p className="text-ink-muted">Loaded more than 7 days ago{h ? `, ${n(h.doNotClosed.over30)} of them over 30 days (${rm(h.doNotClosed.over30Sen)})` : ""}. Until the crew takes the POD the order never counts as delivered, its balance never ages as owing, and "Marked delivered" above stays near zero.</p>
              </li>
              <li>
                <div className="flex flex-wrap items-baseline justify-between gap-x-2"><b className="text-ink">Delivered, still owing after 30 days</b><span className="tabular-nums text-err">{h ? `${n(h.deliveredOwingOver30.count)} orders · ${rm(h.deliveredOwingOver30.balanceSen)}` : "…"}</span></div>
                <p className="text-ink-muted">{h ? `Oldest ${h.deliveredOwingOver30.oldestDays} days. ` : ""}Goods are with the customer and the balance is not paid.</p>
              </li>
              <li>
                <div className="flex flex-wrap items-baseline justify-between gap-x-2"><b className="text-ink">DO without cost · last 90 days</b><span className="tabular-nums text-warning-text">{h ? `${n(h.doNoCost.count)} DO · ${rm(h.doNoCost.amountSen)}` : "…"}</span></div>
                <p className="text-ink-muted">These carry a selling price but no cost, so their margin reads 100% and gross profit by delivery is overstated by up to that amount.</p>
              </li>
            </ul>
            <Link to="/scm/delivery-orders" className="mt-3 inline-block text-[12px] text-primary hover:underline">Open delivery orders</Link>
          </Panel>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Today's runs" right={<Link to={`/scm/fleet-day?date=${today}`} className="text-[12px] text-primary hover:underline">Open Last Mile</Link>}>
          {runsToday.length === 0 ? <p className="text-[12.5px] text-ink-muted">No lorry runs today.</p> : (
            <table className="w-full border-collapse"><thead><tr><Th left>Lorry</Th><Th left>Driver</Th><Th>Stops</Th><Th left>Status</Th></tr></thead>
              <tbody>{runsToday.map((t) => <tr key={t.id}><Td left>{t.lorry?.plate ?? "—"}</Td><Td left>{t.driver?.name ?? "—"}</Td><Td>{t.stops.length}</Td><Td left>{t.status}</Td></tr>)}</tbody></table>
          )}
        </Panel>
        <section id="urgent">
          <Panel title="Due in 3 days, not ready" hint="chase stock or reschedule with the customer">
            {m.urgent.length === 0 ? <p className="text-[12.5px] text-ink-muted">Nothing due in the next 3 days is short of stock.</p> : (
              <table className="w-full border-collapse"><thead><tr><Th left>Order</Th><Th left>Customer</Th><Th>Delivery</Th><Th left>Stock</Th></tr></thead>
                <tbody>{m.urgent.slice(0, 30).map((o) => <tr key={o.so_doc_no}><Td left><Link to={`/scm/sales-orders/${o.so_doc_no}`} className="text-primary hover:underline">{o.so_doc_no}</Link></Td><Td left>{o.debtor_name ?? "—"}</Td><Td>{dd(o.effective_delivery_date ?? "")}</Td><Td left>{o.stock_remark || o.stock_status || "—"}</Td></tr>)}</tbody></table>
            )}
          </Panel>
        </section>
      </div>
    </div>
  );
}

export default LogisticOverview;
