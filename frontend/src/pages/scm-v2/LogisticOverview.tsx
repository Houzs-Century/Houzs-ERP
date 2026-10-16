// Logistic Overview (owner, 2026-10-16) — the weekly logistic report and the
// "HC Delivery Operations Dashboard" sheet, now from the ERP itself:
//   action alerts, key metrics, order status, the weekly report (DO last week,
//   orders due next, ready / confirmed, next week's runs), KPI scorecard,
//   monthly delivery volume and today's runs.
// Data: the Delivery Planning board (what is pending / ready / confirmed),
// GET /api/scm/logistic-overview (weekly + monthly history, delivered-but-owing)
// and GET /api/scm/trips/day (today's runs).
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "../../components/Layout";
import { StatCard } from "../../components/StatCard";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { useDeliveryPlanning, type PlanningOrder } from "../../vendor/scm/lib/delivery-planning-queries";
import { useFleetDay } from "../../vendor/scm/lib/fleet-day-queries";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { cn } from "../../lib/utils";
import { Th, Td, Panel } from "../../components/scm-v2/OverviewKit";

type Week = { from: string; to: string; doCount: number; doAmountSen: number; delivered: number; runs: number; current: boolean };
type History = {
  today: string; thisMonday: string; weeks: Week[];
  months: Array<{ month: string; doCount: number; doAmountSen: number }>;
  deliveredOwing: { count: number; balanceSen: number; oldestDays: number };
  deliveredOwingOver30: { count: number; balanceSen: number; oldestDays: number };
};

const DAY = 86400000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "—");
const dd = (d: string) => d.slice(5).replace("-", "/");
const AVG_SALES_PER_RUN_TARGET_SEN = 30000_00;

export function LogisticOverview() {
  const today = todayMY();
  const board = useDeliveryPlanning({ region: "ALL", state: "ALL" });
  const hist = useQuery({ queryKey: ["logistic-overview"], queryFn: () => authedFetch<History>("/logistic-overview"), staleTime: 60_000 });
  const day = useFleetDay({ date: today });

  const rows: PlanningOrder[] = useMemo(() => (board.data?.orders ?? []).filter((o) => o.row_type === "so"), [board.data]);
  const counts = board.data?.counts as Record<string, number> | undefined;

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

  const thisMonth = today.slice(0, 7);
  const monthRow = hist.data?.months.find((x) => x.month === thisMonth);
  const monthRuns = (hist.data?.weeks ?? []).filter((w) => w.from.slice(0, 7) === thisMonth || w.to.slice(0, 7) === thisMonth).reduce((a, w) => a + w.runs, 0);
  const avgPerRun = monthRuns && monthRow ? monthRow.doAmountSen / monthRuns : null;
  const lastWeek = hist.data?.weeks.find((w) => w.to === addDays(hist.data!.thisMonday, -1));
  const nextWeek = hist.data?.weeks.find((w) => w.from === addDays(hist.data!.thisMonday, 7));
  const runsToday = day.data?.trips ?? [];
  const status: Array<[string, string, string]> = [
    ["PENDING_DELIVERY", "Pending delivery", "bg-primary"], ["PENDING_SCHEDULE", "Pending schedule", "bg-warning-text"],
    ["OVERDUE", "Overdue", "bg-err"], ["DELIVERED", "Delivered", "bg-synced"],
  ];
  const statusTotal = status.reduce((a, [k]) => a + (counts?.[k] ?? 0), 0);
  const maxMonth = Math.max(1, ...(hist.data?.months ?? []).map((x) => x.doAmountSen));
  const loading = board.isLoading || hist.isLoading;

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Supply chain · Transportation" title="Logistic Overview"
        description="What needs action, where every order stands, the weekly logistic report and today's runs — straight from the orders and delivery orders." />
      {(board.error || hist.error) && <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px] text-err">Could not load: {((board.error ?? hist.error) as Error).message}</div>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Due in 3 days, not ready" value={String(m.urgent.length)} subtitle={`of ${m.in3} orders due by ${dd(addDays(today, 3))}`} tone={m.urgent.length ? "error" : "default"} rail={m.urgent.length ? "bg-err" : undefined} pending={loading} />
        <StatCard label="Overdue deliveries" value={String(counts?.OVERDUE ?? 0)} subtitle="past the delivery date, not delivered" tone={counts?.OVERDUE ? "error" : "default"} pending={loading} />
        <StatCard label="Missing phone" value={String(m.noPhone.length)} subtitle="fill in before the lorry goes" tone={m.noPhone.length ? "warning" : "default"} pending={loading} />
        <StatCard label="Delivered, owing > 30 days" value={hist.data ? String(hist.data.deliveredOwingOver30.count) : "—"} subtitle={hist.data ? `${fmtSen(hist.data.deliveredOwingOver30.balanceSen)} · oldest ${hist.data.deliveredOwingOver30.oldestDays} days` : undefined} tone={hist.data?.deliveredOwingOver30.count ? "error" : "default"} pending={loading} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Orders to deliver" value={String(m.openCount)} subtitle={fmtSen(m.openSen)} pending={loading} />
        <StatCard label="DO last week" value={lastWeek ? String(lastWeek.doCount) : "—"} subtitle={lastWeek ? `${fmtSen(lastWeek.doAmountSen)} · ${dd(lastWeek.from)}–${dd(lastWeek.to)}` : undefined} pending={loading} />
        <StatCard label="Runs today" value={String(runsToday.length)} subtitle={`${runsToday.reduce((a, t) => a + t.stops.length, 0)} stops`} pending={day.isLoading} />
        <StatCard label="Delivered, still owing" value={hist.data ? fmtSen(hist.data.deliveredOwing.balanceSen) : "—"} subtitle={hist.data ? `${hist.data.deliveredOwing.count} orders` : undefined} pending={loading} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Order status" hint="Delivery Planning, all regions">
          <div className="flex h-3.5 overflow-hidden rounded">{status.map(([k, , bg]) => <i key={k} className={bg} style={{ flex: counts?.[k] ?? 0 }} />)}</div>
          <table className="mt-2 w-full border-collapse"><thead><tr><Th left>Status</Th><Th>Orders</Th><Th>Share</Th></tr></thead>
            <tbody>{status.map(([k, label]) => <tr key={k}><Td left>{label}</Td><Td>{counts?.[k] ?? 0}</Td><Td>{pct(counts?.[k] ?? 0, statusTotal)}</Td></tr>)}
              <tr className="font-semibold"><Td left>Total</Td><Td>{statusTotal}</Td><Td>100%</Td></tr></tbody></table>
        </Panel>
        <Panel title="KPI scorecard">
          <table className="w-full border-collapse"><thead><tr><Th left>KPI</Th><Th>Target</Th><Th>Actual</Th><Th left> </Th></tr></thead>
            <tbody>
              <tr><Td left>Phone completeness</Td><Td>100%</Td><Td>{m.phoneComplete != null ? `${Math.round(m.phoneComplete * 1000) / 10}%` : "—"}</Td><Td left>{m.phoneComplete != null && <Pill ok={m.phoneComplete >= 0.99} />}</Td></tr>
              <tr><Td left>Avg sales per run · {thisMonth}</Td><Td>{fmtSen(AVG_SALES_PER_RUN_TARGET_SEN)}</Td><Td>{avgPerRun != null ? fmtSen(avgPerRun) : "no runs yet"}</Td><Td left>{avgPerRun != null && <Pill ok={avgPerRun >= AVG_SALES_PER_RUN_TARGET_SEN} />}</Td></tr>
              <tr><Td left>Ready orders with a confirmed date</Td><Td>100%</Td><Td>{pct(m.confirmed, m.ready)}</Td><Td left>{m.ready > 0 && <Pill ok={m.confirmed === m.ready} />}</Td></tr>
              <tr><Td left>Overdue share</Td><Td>≤ 5%</Td><Td>{pct(counts?.OVERDUE ?? 0, statusTotal)}</Td><Td left>{statusTotal > 0 && <Pill ok={(counts?.OVERDUE ?? 0) / statusTotal <= 0.05} />}</Td></tr>
            </tbody></table>
          <p className="mt-2 text-[11.5px] text-ink-muted">Avg sales per run counts real lorry runs, so it fills in once runs are planned in Delivery Time Arrangement.</p>
        </Panel>
      </div>

      <Panel title="Weekly logistic report" hint="Monday to Sunday · this week highlighted">
        <table className="w-full border-collapse">
          <thead><tr><Th left>Week</Th><Th>DO issued</Th><Th>DO amount</Th><Th>Delivered</Th><Th>Lorry runs</Th></tr></thead>
          <tbody>{(hist.data?.weeks ?? []).map((w) => (
            <tr key={w.from} className={cn(w.current && "bg-primary-soft/40 font-semibold")}>
              <Td left>{dd(w.from)} – {dd(w.to)}{w.current ? " · this week" : w.from > (hist.data?.thisMonday ?? "") ? " · next week" : ""}</Td>
              <Td>{w.doCount}</Td><Td>{fmtSen(w.doAmountSen)}</Td><Td>{w.delivered}</Td><Td>{w.runs}</Td>
            </tr>))}</tbody>
        </table>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="rounded-md border border-border p-3">
            <div className="text-[12.5px] font-semibold text-ink">Orders due {dd(m.nextMonday)} – {dd(m.windowEnd)}</div>
            <table className="mt-1 w-full border-collapse"><tbody>
              <tr><Td left>Total</Td><Td>{m.due30}</Td></tr>
              <tr><Td left>Not ready</Td><Td className={m.notReady ? "text-warning-text" : ""}>{m.notReady}</Td></tr>
              <tr><Td left>Ready</Td><Td>{m.ready}</Td></tr>
              <tr><Td left>· delivery date confirmed</Td><Td>{m.confirmed}</Td></tr>
              <tr><Td left>· waiting for confirmation</Td><Td className={m.pendingConfirm ? "text-warning-text" : ""}>{m.pendingConfirm}</Td></tr>
            </tbody></table>
          </div>
          <div className="rounded-md border border-border p-3">
            <div className="text-[12.5px] font-semibold text-ink">Next week</div>
            <table className="mt-1 w-full border-collapse"><tbody>
              <tr><Td left>Orders placed on a lorry run</Td><Td>{m.nextWeekScheduled}</Td></tr>
              <tr><Td left>Lorry runs planned</Td><Td>{nextWeek?.runs ?? 0}</Td></tr>
              <tr><Td left>DO already issued</Td><Td>{nextWeek?.doCount ?? 0}</Td></tr>
            </tbody></table>
            <Link to="/scm/trips" className="mt-2 inline-block text-[12px] text-primary hover:underline">Plan runs in Delivery Time Arrangement</Link>
          </div>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Monthly delivery volume" hint="DO amount by month">
          <div className="flex h-36 items-end gap-1.5">
            {(hist.data?.months ?? []).map((x) => (
              <div key={x.month} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${x.month}: ${x.doCount} DO · ${fmtSen(x.doAmountSen)}`}>
                <div className="w-full rounded-t bg-primary/60" style={{ height: `${Math.max(2, (x.doAmountSen / maxMonth) * 120)}px` }} />
                <span className="text-[10px] text-ink-muted">{x.month.slice(5)}</span>
              </div>))}
          </div>
          <p className="mt-1 text-[11.5px] text-ink-muted">Counts delivery orders raised in the ERP; months before the ERP took over delivery orders read low.</p>
        </Panel>
        <Panel title="Today's runs" right={<Link to={`/scm/fleet-day?date=${today}`} className="text-[12px] text-primary hover:underline">Open Last Mile</Link>}>
          {runsToday.length === 0 ? <p className="text-[12.5px] text-ink-muted">No lorry runs today.</p> : (
            <table className="w-full border-collapse"><thead><tr><Th left>Lorry</Th><Th left>Driver</Th><Th>Stops</Th><Th left>Status</Th></tr></thead>
              <tbody>{runsToday.map((t) => <tr key={t.id}><Td left>{t.lorry?.plate ?? "—"}</Td><Td left>{t.driver?.name ?? "—"}</Td><Td>{t.stops.length}</Td><Td left>{t.status}</Td></tr>)}</tbody></table>
          )}
        </Panel>
      </div>

      {m.urgent.length > 0 && (
        <Panel title="Due in 3 days, not ready" hint="chase stock or reschedule with the customer">
          <table className="w-full border-collapse"><thead><tr><Th left>Order</Th><Th left>Customer</Th><Th>Delivery</Th><Th left>Stock</Th></tr></thead>
            <tbody>{m.urgent.slice(0, 30).map((o) => <tr key={o.so_doc_no}><Td left><Link to={`/scm/sales-orders/${o.so_doc_no}`} className="text-primary hover:underline">{o.so_doc_no}</Link></Td><Td left>{o.debtor_name ?? "—"}</Td><Td>{o.effective_delivery_date ?? "—"}</Td><Td left>{o.stock_remark || o.stock_status || "—"}</Td></tr>)}</tbody></table>
        </Panel>
      )}
    </div>
  );
}

const Pill = ({ ok }: { ok: boolean }) => <span className={cn("rounded-full px-2 py-0.5 text-[10.5px]", ok ? "bg-synced/10 text-synced" : "bg-err/10 text-err")}>{ok ? "On target" : "Below target"}</span>;

export default LogisticOverview;
