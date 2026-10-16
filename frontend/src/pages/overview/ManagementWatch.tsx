// The home page's management watchlist (owner, 2026-10-17: the overviews exist
// so management can see where the business has a problem). Every module's
// overview contributes what it found; the list ranks them, says why each
// matters, and opens the page that shows the detail. A module the viewer cannot
// read contributes nothing (its data is null).
import { useNavigate } from "react-router-dom";
import { fmtSen } from "../../vendor/shared/format";
import { TONE } from "../../components/scm-v2/Charts";

export interface WatchInputs {
  logistic: {
    doNotClosed: { count: number; amountSen: number; over30: number };
    doNoCost: { count: number; amountSen: number };
    deliveredOwingOver30: { count: number; balanceSen: number; oldestDays: number };
  } | null;
  procurement: {
    open: { late5Lines: number; late5Suppliers: number; worstDaysLate: number };
    leadByCategory: Array<{ key: string; current?: number | null; suggested?: number | null; verdict?: string }>;
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

const rm = (sen: number) => fmtSen(sen).replace(/\.\d\d$/, "");
const rmRinggit = (v: number) => rm(Math.round(v * 100));

export function watchItems(w: WatchInputs): Item[] {
  const out: Item[] = [];
  const g = w.projectGaps;
  if (g && g.noSales.count > 0) out.push({ level: "bad", title: "Finished events with no sales keyed", figure: `${g.noSales.count} of ${g.ended} events · ${rm(g.noSales.soSen)} in Sales Orders`, why: "Project Overview counts their rental and setup but none of their sales, so profit by brand, organizer and venue reads far too low.", to: "/projects?view=finances" });
  const l = w.logistic;
  if (l && l.doNotClosed.count > 0) out.push({ level: l.doNotClosed.over30 > 0 ? "bad" : "warn", title: "Delivery orders loaded but never closed", figure: `${l.doNotClosed.count} DO · ${rm(l.doNotClosed.amountSen)} · ${l.doNotClosed.over30} over 30 days`, why: "Without the POD the order never counts as delivered, so delivered and owing figures read low and the customer balance does not age.", to: "/scm/logistic-overview" });
  if (l && l.deliveredOwingOver30.count > 0) out.push({ level: "bad", title: "Delivered, still owing after 30 days", figure: `${l.deliveredOwingOver30.count} orders · ${rm(l.deliveredOwingOver30.balanceSen)} · oldest ${l.deliveredOwingOver30.oldestDays} days`, why: "Goods are with the customer and the money is not. Chase before it becomes bad debt.", to: "/scm/logistic-overview" });
  const s = w.service;
  if (s && s.breach_count > 0) out.push({ level: "bad", title: "Service cases past their SLA", figure: `${s.breach_count} of ${s.active_count} open cases`, why: "Customers waiting longer than promised.", to: "/assr?view=metrics" });
  const p = w.procurement;
  if (p && p.open.late5Lines > 0) out.push({ level: "warn", title: "Purchase order lines 5+ days late", figure: `${p.open.late5Lines} lines · ${p.open.late5Suppliers} suppliers · worst ${p.open.worstDaysLate} days`, why: "Customer deliveries waiting on these will slip unless the supplier is chased.", to: "/scm/procurement-overview" });
  if (g && g.noCogs.count > 0) out.push({ level: "warn", title: "Events with sales but no COGS", figure: `${g.noCogs.count} events · ${rmRinggit(g.noCogs.salesAffected)} sales`, why: "Gross profit on these events is overstated by the full cost of the goods sold.", to: "/projects?view=finances" });
  if (l && l.doNoCost.count > 0) out.push({ level: "warn", title: "Delivery orders with no cost", figure: `${l.doNoCost.count} DO · ${rm(l.doNoCost.amountSen)} · last 90 days`, why: "Their margin reads 100%, so gross profit by delivery is overstated.", to: "/scm/logistic-overview" });
  if (g && g.noCommission.count > 0) out.push({ level: "warn", title: "Events with sales but no commission", figure: `${g.noCommission.count} events · ${rmRinggit(g.noCommission.salesAffected)} sales`, why: "Net profit on these events is overstated until commission is booked.", to: "/projects?view=finances" });
  const longLead = p?.leadByCategory.filter((c) => c.verdict === "can_shorten" || c.verdict === "too_short") ?? [];
  if (longLead.length > 0) out.push({ level: "warn", title: "Lead time settings out of line with real deliveries", figure: longLead.map((c) => `${c.key} ${c.current} → ${c.suggested} days`).join(" · "), why: "Too long orders stock early and ties up cash; too short promises customers dates the supplier cannot meet.", to: "/scm/procurement-overview" });
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
