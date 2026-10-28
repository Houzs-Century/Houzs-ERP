// The home page's management watchlist (owner, 2026-10-17: the overviews exist
// so management can see where the business has a problem). Every module's
// overview contributes what it found; the list ranks them, says why each
// matters, and opens the page that shows the detail. A module the viewer cannot
// read contributes nothing (its data is null).
import { useNavigate } from "react-router-dom";
import { fmtSen } from "../../vendor/shared/format";
import { formatCurrency } from "../../lib/utils";
import { TONE } from "../../components/scm-v2/Charts";

export interface WatchInputs {
  logistic: {
    doNotClosed: { count: number; amountSen: number; over30: number };
    doNoCost: { count: number; amountSen: number };
    soNoProcessing?: { count: number; oldestDays: number };
    deliveredOwingOver30: { count: number; balanceSen: number; oldestDays: number };
  } | null;
  procurement: {
    asOf: string;
    total: { open: { lines: number; late: number; lateSen: number; buckets: { late5: { lines: number; sen: number } } }; due: { sen: number; openSen: number } };
    byCategory: Array<{ key: string; ordering: { canOrderLaterDays: number | null } }>;
    deadStock: { deadSen: number; deadSkus: number; totalSen: number };
  } | null;
  service: { active_count: number; breach_count: number } | null;
  projectGaps: {
    ended: number;
    noSales: { count: number; soSen: number; costBooked: number };
    noCogs: { count: number; salesAffected: number };
    noCommission: { count: number; salesAffected: number };
  } | null;
}

type Level = "bad" | "warn";
interface Item { level: Level; title: string; figure: string; why: string; to: string }

// Money reads like AutoCount everywhere: "RM 15,000.00" (owner 2026-09-15).
const rm = fmtSen;
const rmRinggit = formatCurrency;

export function watchItems(w: WatchInputs): Item[] {
  const out: Item[] = [];
  const g = w.projectGaps;
  if (g && g.noSales.count > 0) out.push({ level: "bad", title: "Finished events with no sales keyed", figure: `${g.noSales.count} of ${g.ended} events · ${rm(g.noSales.soSen)} in Sales Orders`, why: "Project Overview counts their rental and setup but none of their sales, so profit by brand, organizer and venue reads far too low.", to: "/projects?view=finances" });
  const l = w.logistic;
  if (l && l.doNotClosed.count > 0) out.push({ level: l.doNotClosed.over30 > 0 ? "bad" : "warn", title: "Delivery orders loaded but never closed", figure: `${l.doNotClosed.count} DO · ${rm(l.doNotClosed.amountSen)} · ${l.doNotClosed.over30} over 30 days`, why: "Without the POD the order never counts as delivered, so delivered and owing figures read low and the customer balance does not age.", to: "/scm/logistic-overview" });
  if (l && l.deliveredOwingOver30.count > 0) out.push({ level: "bad", title: "Delivered, still owing after 30 days", figure: `${l.deliveredOwingOver30.count} orders · ${rm(l.deliveredOwingOver30.balanceSen)} · oldest ${l.deliveredOwingOver30.oldestDays} days`, why: "Goods are with the customer and the money is not. Chase before it becomes bad debt.", to: "/scm/logistic-overview" });
  if (l?.soNoProcessing && l.soNoProcessing.count > 0) out.push({ level: "bad", title: "Confirmed orders never released for ordering", figure: `${l.soNoProcessing.count} orders · oldest ${l.soNoProcessing.oldestDays} days`, why: "No Processing Date, so purchasing never orders the goods and the lines stay Pending. Set the date, or close the order.", to: "/scm/sales-orders" });
  const s = w.service;
  if (s && s.breach_count > 0) out.push({ level: "bad", title: "Service cases past their SLA", figure: `${s.breach_count} of ${s.active_count} open cases`, why: "Customers waiting longer than promised.", to: "/assr?view=metrics" });
  const p = w.procurement;
  if (p && p.total.open.late > 0) out.push({ level: p.total.open.buckets.late5.lines > 0 ? "bad" : "warn", title: "Purchase order lines past their date", figure: `${p.total.open.late} lines · ${rm(p.total.open.lateSen)} · ${p.total.open.buckets.late5.lines} of them 5+ days late`, why: "Customer deliveries waiting on these will slip unless the supplier is chased.", to: "/scm/procurement-overview" });
  if (p && p.deadStock.deadSen > 0) out.push({ level: "warn", title: "Dead stock: no sale in over 90 days", figure: `${p.deadStock.deadSkus} items · ${rm(p.deadStock.deadSen)}`, why: "Cash sitting in the warehouse. Clear it before ordering more of the same.", to: "/scm/procurement-overview" });
  if (g && g.noCogs.count > 0) out.push({ level: "warn", title: "Events with sales but no COGS", figure: `${g.noCogs.count} events · ${rmRinggit(g.noCogs.salesAffected)} sales`, why: "Gross profit on these events is overstated by the full cost of the goods sold.", to: "/projects?view=finances" });
  if (l && l.doNoCost.count > 0) out.push({ level: "warn", title: "Delivery orders with no cost", figure: `${l.doNoCost.count} DO · ${rm(l.doNoCost.amountSen)} · last 90 days`, why: "Their margin reads 100%, so gross profit by delivery is overstated.", to: "/scm/logistic-overview" });
  if (g && g.noCommission.count > 0) out.push({ level: "warn", title: "Events with sales but no commission", figure: `${g.noCommission.count} events · ${rmRinggit(g.noCommission.salesAffected)} sales`, why: "Net profit on these events is overstated until commission is booked.", to: "/projects?view=finances" });
  const later = p?.byCategory.filter((c) => (c.ordering.canOrderLaterDays ?? 0) >= 3) ?? [];
  if (later.length > 0) out.push({ level: "warn", title: "We order earlier than we need to", figure: later.map((c) => `${c.key} ${c.ordering.canOrderLaterDays} days later`).join(" · "), why: "Goods arrive well before the customer needs them; ordering later holds less stock and cash, and 80% of lines would still arrive in time.", to: "/scm/procurement-overview" });
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "bad" ? -1 : 1));
}

export function ManagementWatch({ inputs, loading }: { inputs: WatchInputs; loading: boolean }) {
  const navigate = useNavigate();
  const items = watchItems(inputs);
  const bad = items.filter((i) => i.level === "bad").length;
  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-stone sm:p-5">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 className="text-[15px] font-bold text-ink">Where the business needs attention</h2>
        <span className="text-[12px] text-ink-muted">{loading ? "checking…" : `${bad} urgent · ${items.length - bad} to fix`}</span>
      </div>
      {!loading && items.length === 0 && <div className="py-4 text-center text-[12.5px] text-ink-muted">Nothing the overviews you can see would flag.</div>}
      <ul className="grid gap-2 lg:grid-cols-2">
        {items.map((it) => (
          <li key={it.title}>
            <button type="button" onClick={() => navigate(it.to)}
              className="group flex h-full w-full gap-3 rounded-lg border border-border px-3 py-2.5 text-left hover:border-primary/40">
              <span className="mt-1 h-full w-1 shrink-0 rounded-full" style={{ background: TONE[it.level] }} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-ink group-hover:text-primary">{it.title}</span>
                <span className="block text-[12.5px] font-medium tabular-nums" style={{ color: TONE[it.level] }}>{it.figure}</span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-muted">{it.why}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
