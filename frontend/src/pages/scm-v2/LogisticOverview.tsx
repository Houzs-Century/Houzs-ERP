// Logistic Overview (owner, 2026-10-16/17), in three parts:
//   1. delivered in the period — amount, orders, average order, average per
//      lorry, day by day, by region, by category, jobs by type;
//   2. still to deliver as of today — by when it is due (3 days, a week, two
//      weeks, a month, later), the overdue list with its delivery date, the
//      orders due in 3 days and not ready, and today's deliveries;
//   3. reports — weekly and monthly volume, and the process gaps.
// Data: the Delivery Planning board (open orders) and
// GET /api/scm/logistic-overview (the period, weeks, months, process gaps).
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "../../components/Layout";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { api } from "../../api/client";
import { useDeliveryPlanning, type PlanningOrder } from "../../vendor/scm/lib/delivery-planning-queries";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { cn } from "../../lib/utils";
import { Th, Td, Panel, SELECT_CLS, Toggle } from "../../components/scm-v2/OverviewKit";
import { DashboardPeriodPicker, useDashboardPeriod } from "../../components/scm-v2/DashboardPeriod";
import { LogisticPeriodSection, type PeriodTotals } from "./LogisticPeriodSection";
import { LogisticDailySection, LorrySection, type DoDrill } from "./LogisticDailySection";
import type { DoRow } from "./LogisticPeriodSection";
import { DrillDrawer, col, type Drill } from "../../components/scm-v2/DrillDrawer";
import { Columns, SplitBar, TONE, PALETTE } from "../../components/scm-v2/Charts";

type Week = { from: string; to: string; doCount: number; doAmountSen: number; delivered: number; current: boolean };
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
// Money reads like AutoCount everywhere: "RM 15,000.00" (owner 2026-09-15).
const rm = fmtSen;
const n = (v: number) => v.toLocaleString();
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

  const warehouses = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of board.data?.orders ?? []) if (o.warehouse_id && (!activeCode || !o.company_code || o.company_code === activeCode)) map.set(o.warehouse_id, [o.warehouse_name, o.warehouse_code].filter(Boolean).join(" · ") || o.warehouse_id);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [board.data, activeCode]);
  const allRows: PlanningOrder[] = useMemo(() => (board.data?.orders ?? [])
    .filter((o) => !activeCode || !o.company_code || o.company_code === activeCode)
    .filter((o) => !warehouse || o.warehouse_id === warehouse), [board.data, warehouse, activeCode]);
  const rows: PlanningOrder[] = useMemo(() => allRows.filter((o) => o.row_type === "so"), [allRows]);
  /* Every open sales order, as of today, by when it is due (owner 2026-10-17:
     3 days, a week, two weeks, a month, later), with how many are short of
     stock and how many have a date agreed with the customer. */
  const open = useMemo(() => rows.filter((o) => o.delivery_state !== "DELIVERED"), [rows]);
  const buckets = useMemo(() => {
    const defs: Array<{ key: string; label: string; color: string; test: (e: string | null) => boolean }> = [
      { key: "overdue", label: "Past delivery date", color: TONE.bad, test: (e) => !!e && e < today },
      { key: "d3", label: "Within 3 days", color: TONE.warn, test: (e) => !!e && e >= today && e <= addDays(today, 3) },
      { key: "d7", label: "4 – 7 days", color: "#d9b25c", test: (e) => !!e && e > addDays(today, 3) && e <= addDays(today, 7) },
      { key: "d14", label: "8 – 14 days", color: PALETTE[2]!, test: (e) => !!e && e > addDays(today, 7) && e <= addDays(today, 14) },
      { key: "d30", label: "15 – 30 days", color: PALETTE[0]!, test: (e) => !!e && e > addDays(today, 14) && e <= addDays(today, 30) },
      { key: "later", label: "After 30 days", color: "#9aa39a", test: (e) => !!e && e > addDays(today, 30) },
      { key: "none", label: "No date yet", color: "#c9cdc4", test: (e) => !e },
    ];
    return defs.map((b) => {
      const xs = open.filter((o) => b.test(o.effective_delivery_date ?? null));
      return { ...b, rows: xs, count: xs.length, sen: xs.reduce((a, o) => a + o.local_total_sen, 0), notReady: xs.filter((o) => !o.is_ship_ready).length, confirmed: xs.filter((o) => !!o.amended_delivery_date).length };
    });
  }, [open, today]);
  /* Overdue (owner 2026-10-17): the goods are ready but the order is not
     delivered and no delivery date has been confirmed with the customer yet —
     stock sitting in the warehouse waiting on us. Oldest customer date first. */
  const overdueRows = open.filter((o) => o.is_ship_ready && !o.amended_delivery_date)
    .sort((a, b) => String(a.customer_delivery_date ?? "9999").localeCompare(String(b.customer_delivery_date ?? "9999")));
  const overdueSen = overdueRows.reduce((a, o) => a + o.local_total_sen, 0);
  const urgent = (buckets[1]?.rows ?? []).filter((o) => !o.is_ship_ready);
  const todays = open.filter((o) => o.effective_delivery_date === today);
  const openSen = open.reduce((a, o) => a + o.local_total_sen, 0);
  const noPhone = open.filter((o) => !String(o.phone ?? "").trim()).length;
  const ready = open.filter((o) => o.is_ship_ready);

  const h = hist.data;
  /* The weekly report follows the picked period, by week of the month
     (owner 2026-10-18): W1 = 1st–7th, W2 = 8th–14th, W3 = 15th–21st,
     W4 = 22nd–28th, W5 = 29th to the month's end. */
  const weeks = useMemo(() => {
    const out: Array<{ key: string; label: string; from: string; to: string; doCount: number; doAmountSen: number; delivered: number; current: boolean }> = [];
    const pad = (n: number) => String(n).padStart(2, "0");
    const months: string[] = [];
    for (let m = period.from.slice(0, 7); m <= period.to.slice(0, 7);) {
      months.push(m);
      const y = Number(m.slice(0, 4)); const mm = Number(m.slice(5, 7));
      m = mm === 12 ? `${y + 1}-01` : `${y}-${pad(mm + 1)}`;
    }
    for (const m of months) {
      const last = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
      [[1, 7], [8, 14], [15, 21], [22, 28], [29, last]].forEach(([a, b], i) => {
        if (a! > last) return;
        const from = `${m}-${pad(a!)}`; const to = `${m}-${pad(b!)}`;
        const ds = (h?.period.doList ?? []).filter((d) => d.date >= from && d.date <= to);
        out.push({
          key: from, label: months.length > 1 ? `${m} · W${i + 1}` : `W${i + 1}`, from, to,
          doCount: ds.length, doAmountSen: ds.reduce((x, d) => x + d.amountSen, 0), delivered: ds.filter((d) => d.status === "DELIVERED").length,
          current: today >= from && today <= to,
        });
      });
    }
    return out;
  }, [h, period.from, period.to, today]);
  const months = h?.months ?? [];
  const loading = board.isLoading || hist.isLoading;
  const jump = (id: string) => () => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  const [monthBy, setMonthBy] = useState<"amount" | "orders">("amount");
  const [weekBy, setWeekBy] = useState<"amount" | "orders">("amount");
  /* The second layer (owner 2026-10-18): a figure opens the rows behind it. */
  const [doDrill, setDoDrill] = useState<Drill<DoRow> | null>(null);
  const [soDrill, setSoDrill] = useState<Drill<PlanningOrder> | null>(null);
  const openDos: DoDrill = (title, keep) => setDoDrill({
    title, subtitle: `${period.from} – ${period.to}`, rows: (h?.period.doList ?? []).filter(keep), rowKey: (d) => d.id,
    onRow: (d) => navigate(`/scm/delivery-orders/${d.id}`),
    columns: [
      col<DoRow>("DO", true, (d) => <span className="text-primary">{d.doNumber ?? "—"}</span>, (d) => d.doNumber ?? "", null, null),
      col<DoRow>("Date", false, (d) => d.date, null, null, null),
      col<DoRow>("Customer", true, (d) => d.customer ?? "—", (d) => d.customer ?? "", null, null),
      col<DoRow>("Region", true, (d) => d.region, (d) => d.region, null, null),
      col<DoRow>("Lorry", true, (d) => d.lorry ?? "—", (d) => d.lorry ?? "", null, null),
      col<DoRow>("Amount", false, (d) => fmtSen(d.amountSen), null, (d) => d.amountSen, fmtSen),
    ],
  });
  const openSos = (title: string, xs: PlanningOrder[]) => setSoDrill({
    title, subtitle: "open sales orders, as of today", rows: xs, rowKey: (o) => o.so_doc_no,
    onRow: (o) => navigate(`/scm/sales-orders/${o.so_doc_no}`),
    columns: [
      col<PlanningOrder>("Order", true, (o) => <span className="text-primary">{o.so_doc_no}</span>, (o) => o.so_doc_no, null, null),
      col<PlanningOrder>("Customer", true, (o) => o.debtor_name ?? "—", (o) => o.debtor_name ?? "", null, null),
      col<PlanningOrder>("Delivery", false, (o) => o.effective_delivery_date ?? "—", null, null, null),
      col<PlanningOrder>("Stock", true, (o) => (o.is_ship_ready ? "Ready" : o.stock_remark || o.stock_status || "Not ready"), (o) => o.stock_remark || o.stock_status || "", null, null),
      col<PlanningOrder>("Follow-up", true, (o) => followUpOf(o.delivery_message_status), (o) => followUpOf(o.delivery_message_status), null, null),
      col<PlanningOrder>("Amount", false, (o) => fmtSen(o.local_total_sen), null, (o) => o.local_total_sen, fmtSen),
    ],
  });
  const followMap = new Map<string, { count: number; sen: number }>();
  for (const o of open) { const k = followUpOf(o.delivery_message_status); const g = followMap.get(k) ?? { count: 0, sen: 0 }; g.count += 1; g.sen += o.local_total_sen; followMap.set(k, g); }
  const follow = [...followMap.entries()].sort((a, b) => b[1].count - a[1].count);
  const daysOver = (e: string | null) => (e ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${e}T00:00:00Z`)) / DAY) : 0);

  return (
    <div className="space-y-4">
      {!embedded && <PageHeader eyebrow="Supply chain · Transportation" title="Logistic Overview"
        description="What was delivered in the period, what is still to deliver and when, what is overdue, and the weekly report — straight from the orders and delivery orders." />}
      <div className="flex flex-wrap items-center gap-2">
        <DashboardPeriodPicker period={period} today={today} onChange={setPeriod} />
        <select className={SELECT_CLS} value={warehouse} onChange={(e) => setWarehouse(e.target.value)} aria-label="Warehouse">
          <option value="">All warehouses</option>
          {warehouses.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        {hist.isFetching && <span className="text-[11.5px] text-ink-muted">Loading…</span>}
      </div>
      {(board.error || hist.error) && <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px] text-err">Could not load: {((board.error ?? hist.error) as Error).message}</div>}

      <h2 className="pt-1 text-[14px] font-semibold text-ink">1 · Delivered in the period</h2>
      <LogisticPeriodSection rows={allRows} period={period} today={today} totals={h?.period ?? null}
        overdue={{ count: overdueRows.length, sen: overdueSen }} onOverdue={() => openSos("Overdue · ready, no delivery date confirmed", overdueRows)} onDrill={openDos} />
      {h?.period && <LogisticDailySection days={h.period.days} regions={h.period.byRegion} doList={h.period.doList} onDrill={openDos} />}
      {h?.period && <LorrySection lorries={h.period.byLorry} days={h.period.lorryDayList} recorded={h.period.lorry.recordedOrders} total={h.period.doCount} onDrill={openDos} />}

      <h2 className="pt-2 text-[14px] font-semibold text-ink">2 · Still to deliver · as of today</h2>
      <Panel title="Outstanding delivery, by when it is due" hint={`${warehouse ? "this warehouse" : "all warehouses"} · every sales order not yet delivered · by its delivery date`}>
        <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-[26px] font-bold tabular-nums text-ink">{loading ? "…" : n(open.length)}</span>
          <span className="text-[13px] text-ink-secondary">orders · {fmtSen(openSen)}</span>
          <span className="text-[12px] text-ink-muted">{ready.length} ready to ship · {noPhone} without a phone number</span>
        </div>
        <SplitBar format={n} parts={buckets.map((b) => ({ label: b.label, value: b.count, color: b.color }))} />
        <div className="mt-3 grid gap-4 xl:grid-cols-[1.5fr_1fr]">
          <table className="w-full self-start border-collapse">
            <thead><tr><Th left>Due</Th><Th>Orders</Th><Th>Amount</Th><Th>Not ready (stock)</Th><Th>Date agreed with customer</Th></tr></thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.key} onClick={() => openSos(`Due · ${b.label}`, b.rows)} className="cursor-pointer hover:bg-surface-2/50">
                  <Td left><span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: b.color }} />{b.label}</Td>
                  <Td className={b.key === "overdue" && b.count ? "font-semibold text-err" : ""}>{b.count}</Td>
                  <Td>{fmtSen(b.sen)}</Td>
                  <Td className={b.notReady && (b.key === "overdue" || b.key === "d3") ? "text-err" : ""}>{b.notReady}</Td>
                  <Td>{b.key === "none" ? "—" : b.confirmed}</Td>
                </tr>
              ))}
              <tr className="font-semibold"><Td left>Total</Td><Td>{open.length}</Td><Td>{fmtSen(openSen)}</Td><Td>{buckets.reduce((a, b) => a + b.notReady, 0)}</Td><Td>{buckets.reduce((a, b) => a + b.confirmed, 0)}</Td></tr>
            </tbody>
          </table>
          <div>
            <div className="mb-1 text-[12px] font-semibold text-ink">Customer follow-up</div>
            <table className="w-full border-collapse"><tbody>
              {follow.map(([k, g]) => <tr key={k}><Td left className={k.startsWith("Waiting") || k.startsWith("To reschedule") ? "text-warning-text" : ""}>{k}</Td><Td>{g.count}</Td><Td>{fmtSen(g.sen)}</Td></tr>)}
            </tbody></table>
            <p className="mt-1 text-[11px] text-ink-muted">From the message status on Delivery Planning.</p>
          </div>
        </div>
      </Panel>

      <h2 className="pt-2 text-[14px] font-semibold text-ink">3 · Reports</h2>
      <Panel title="Weekly logistic report" hint={`${period.label} by week of the month (W1 = 1st–7th … W5 = 29th to the end) · delivery orders issued, their amount, and how many are marked delivered · click a week for its orders`}
        right={<Toggle value={weekBy} options={[["amount", "By amount"], ["orders", "By orders"]]} onChange={setWeekBy} />}>
        <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
          <Columns valueLabels={weekBy === "orders"} height={200} labels={weeks.map((w) => w.label)} highlight={weeks.findIndex((w) => w.current)} stacked={false}
            format={weekBy === "amount" ? rm : (x) => `${x} DO`}
            series={weekBy === "amount" ? [{ name: "DO amount", color: PALETTE[0]! }] : [{ name: "DO issued", color: PALETTE[0]! }, { name: "Marked delivered", color: TONE.good }]}
            values={weekBy === "amount" ? [weeks.map((w) => w.doAmountSen)] : [weeks.map((w) => w.doCount), weeks.map((w) => w.delivered)]}
            line={weekBy === "amount" ? { name: "Average order", color: PALETTE[1]!, values: weeks.map((w) => (w.doCount ? Math.round(w.doAmountSen / w.doCount) : null)), format: rm } : null} />
          <table className="w-full border-collapse self-start">
            <thead><tr><Th left>Week</Th><Th>DO</Th><Th>Amount</Th><Th>Average order</Th><Th>Marked delivered</Th></tr></thead>
            <tbody>{weeks.map((w) => (
              <tr key={w.key} onClick={() => openDos(`Delivered · ${w.label} (${dd(w.from)} – ${dd(w.to)})`, (d) => d.date >= w.from && d.date <= w.to)}
                className={cn("cursor-pointer hover:bg-surface-2/50", w.current && "bg-primary-soft/40 font-semibold")}>
                <Td left>{w.label} <span className="text-ink-muted">{dd(w.from)} – {dd(w.to)}</span>{w.current ? " · now" : ""}</Td>
                <Td>{w.doCount}</Td><Td>{rm(w.doAmountSen)}</Td><Td>{w.doCount ? rm(Math.round(w.doAmountSen / w.doCount)) : "—"}</Td>
                <Td className={w.doCount > 5 && w.delivered === 0 && w.to < today ? "text-err" : ""}>{w.delivered}</Td>
              </tr>))}</tbody>
          </table>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Monthly delivery volume" hint="delivery orders issued each month"
          right={<Toggle value={monthBy} options={[["amount", "By amount"], ["orders", "By orders"]]} onChange={setMonthBy} />}>
          <Columns valueLabels={monthBy === "orders"} height={190} labels={months.map((x) => x.month.slice(2).replace("-", "/"))} highlight={months.length - 1} stacked={false} format={monthBy === "amount" ? rm : (x) => `${x} DO`}
            series={[{ name: monthBy === "amount" ? "DO amount" : "DO issued", color: PALETTE[0]! }]} values={[months.map((x) => (monthBy === "amount" ? x.doAmountSen : x.doCount))]}
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
                <p className="text-ink-muted">Loaded more than 7 days ago{h ? `, ${n(h.doNotClosed.over30)} of them over 30 days (${rm(h.doNotClosed.over30Sen)})` : ""}. Until the crew takes the POD the order never counts as delivered and its balance never ages as owing.</p>
              </li>
              <li>
                <div className="flex flex-wrap items-baseline justify-between gap-x-2"><b className="text-ink">Delivered, still owing after 30 days</b><span className="tabular-nums text-err">{h ? `${n(h.deliveredOwingOver30.count)} orders · ${rm(h.deliveredOwingOver30.balanceSen)}` : "…"}</span></div>
                <p className="text-ink-muted">{h ? `Oldest ${h.deliveredOwingOver30.oldestDays} days. ` : ""}Goods are with the customer and the balance is not paid.</p>
              </li>
              <li>
                <div className="flex flex-wrap items-baseline justify-between gap-x-2"><b className="text-ink">DO without cost · last 90 days</b><span className="tabular-nums text-warning-text">{h ? `${n(h.doNoCost.count)} DO · ${rm(h.doNoCost.amountSen)}` : "…"}</span></div>
                <p className="text-ink-muted">These carry a selling price but no cost, so their margin reads 100% and gross profit by delivery is overstated by up to that amount.</p>
              </li>
              <li>
                <div className="flex flex-wrap items-baseline justify-between gap-x-2"><b className="text-ink">Open orders without a phone number</b><span className="tabular-nums text-warning-text">{n(noPhone)} of {n(open.length)}</span></div>
                <p className="text-ink-muted">The customer cannot be called to agree a delivery date.</p>
              </li>
            </ul>
            <Link to="/scm/delivery-orders" className="mt-3 inline-block text-[12px] text-primary hover:underline">Open delivery orders</Link>
          </Panel>
        </section>
      </div>
      <h2 className="pt-2 text-[14px] font-semibold text-ink">4 · Lists to chase</h2>
      <div className="grid gap-4 xl:grid-cols-2">
        <section id="overdue">
          <Panel title="Overdue · ready, no delivery date confirmed" hint={`${overdueRows.length} orders · ${fmtSen(overdueSen)} · stock is ready, the date is not confirmed with the customer, not delivered · oldest customer date first`}>
            {overdueRows.length === 0 ? <p className="text-[12.5px] text-ink-muted">Every ready order has a confirmed delivery date.</p> : (
              <div className="max-h-[420px] overflow-y-auto">
                <table className="w-full border-collapse"><thead className="sticky top-0 bg-surface"><tr><Th left>Order</Th><Th left>Customer</Th><Th>Customer date</Th><Th>Days to / past</Th><Th>Amount</Th><Th left>Follow-up</Th></tr></thead>
                  <tbody>{overdueRows.map((o) => (
                    <tr key={o.so_doc_no}>
                      <Td left><Link to={`/scm/sales-orders/${o.so_doc_no}`} className="text-primary hover:underline">{o.so_doc_no}</Link></Td>
                      <Td left className="max-w-[160px] truncate">{o.debtor_name ?? "—"}</Td>
                      <Td>{o.customer_delivery_date ?? "—"}</Td>
                      <Td className={!o.customer_delivery_date ? "text-ink-muted" : daysOver(o.customer_delivery_date) > 0 ? "font-semibold text-err" : "text-ink-secondary"}>{!o.customer_delivery_date ? "—" : daysOver(o.customer_delivery_date) > 0 ? `${daysOver(o.customer_delivery_date)} past` : `in ${-daysOver(o.customer_delivery_date)}`}</Td>
                      <Td>{fmtSen(o.local_total_sen)}</Td>
                      <Td left className="text-ink-secondary">{followUpOf(o.delivery_message_status)}</Td>
                    </tr>
                  ))}</tbody></table>
              </div>
            )}
          </Panel>
        </section>
        <section id="urgent">
          <Panel title="Due in 3 days, not ready" hint={`${urgent.length} orders · chase stock or reschedule with the customer`}>
            {urgent.length === 0 ? <p className="text-[12.5px] text-ink-muted">Nothing due in the next 3 days is short of stock.</p> : (
              <div className="max-h-[420px] overflow-y-auto">
                <table className="w-full border-collapse"><thead className="sticky top-0 bg-surface"><tr><Th left>Order</Th><Th left>Customer</Th><Th>Delivery</Th><Th left>Stock</Th></tr></thead>
                  <tbody>{urgent.map((o) => <tr key={o.so_doc_no}><Td left><Link to={`/scm/sales-orders/${o.so_doc_no}`} className="text-primary hover:underline">{o.so_doc_no}</Link></Td><Td left className="max-w-[160px] truncate">{o.debtor_name ?? "—"}</Td><Td>{dd(o.effective_delivery_date ?? "")}</Td><Td left>{o.stock_remark || o.stock_status || "—"}</Td></tr>)}</tbody></table>
              </div>
            )}
          </Panel>
        </section>
      </div>

      <Panel title="Delivering today" hint={`${todays.length} orders dated ${today}, not yet delivered`}
        right={<Link to={`/scm/fleet-day?date=${today}`} className="text-[12px] text-primary hover:underline">Open Last Mile</Link>}>
        {todays.length === 0 ? <p className="text-[12.5px] text-ink-muted">No order is dated today.</p> : (
          <table className="w-full border-collapse"><thead><tr><Th left>Order</Th><Th left>Customer</Th><Th left>State</Th><Th>Amount</Th><Th left>Stock</Th><Th left>Follow-up</Th></tr></thead>
            <tbody>{todays.map((o) => (
              <tr key={o.so_doc_no}>
                <Td left><Link to={`/scm/sales-orders/${o.so_doc_no}`} className="text-primary hover:underline">{o.so_doc_no}</Link></Td>
                <Td left className="max-w-[180px] truncate">{o.debtor_name ?? "—"}</Td><Td left>{o.customer_state ?? "—"}</Td><Td>{fmtSen(o.local_total_sen)}</Td>
                <Td left className={o.is_ship_ready ? "text-synced" : "text-err"}>{o.is_ship_ready ? "Ready" : o.stock_remark || o.stock_status || "Not ready"}</Td>
                <Td left className="text-ink-secondary">{followUpOf(o.delivery_message_status)}</Td>
              </tr>
            ))}</tbody></table>
        )}
      </Panel>

      <DrillDrawer drill={doDrill} onClose={() => setDoDrill(null)} />
      <DrillDrawer drill={soDrill} onClose={() => setSoDrill(null)} />
    </div>
  );
}

export default LogisticOverview;
