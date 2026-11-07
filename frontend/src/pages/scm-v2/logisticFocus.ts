// Logistic Overview, narrowed to one region: the page's figures recomputed from the
// delivery orders of that region, so everything below a click follows it.
import type { DayRow, LorryDay, LorryRow } from "./LogisticDailySection";
import type { PeriodTotals } from "./LogisticPeriodSection";
import { countsForLorry, lorryTrips, type LorryJob, type LorryJobDetail } from "../../vendor/shared/logistic-region";

/* A region narrows what a lorry delivered, and a service job rides on a delivery run.
   A job with no region of its own (an event, a stock move) stays the lorry's. */
const jobsInRegion = <J extends LorryJob>(jobs: readonly J[], region: string | null): J[] =>
  region == null ? [...jobs] : jobs.filter((j) => j.kind !== "delivery" && j.kind !== "service");

/** The jobs behind a lorry's row that its delivery orders do not already list, so the
 *  lines under a lorry add up to the row's own figures. */
export function lorryOtherJobs(jobs: readonly LorryJobDetail[], plate: string, from: string, to: string, region: string | null, listedDoIds: ReadonlySet<string>): LorryJobDetail[] {
  return jobsInRegion(jobs.filter((j) => j.plate === plate && j.date >= from && j.date <= to), region).filter((j) => !(j.doId != null && listedDoIds.has(j.doId) && j.kind === "delivery"));
}

export function focusPeriod(p: PeriodTotals, region: string | null, day: string | null): PeriodTotals {
  if (region == null && day == null) return p;
  const inRegion = region == null ? p.doList : p.doList.filter((d) => d.region === region);
  const list = day == null ? inRegion : inRegion.filter((d) => d.date === day);
  const days: DayRow[] = p.days.map((x) => {
    const ds = inRegion.filter((d) => d.date === x.date);
    const withLorry = ds.filter((d) => d.lorry && countsForLorry(d.region));
    const lorries = new Set(withLorry.map((d) => d.lorry)).size;
    const amountSen = ds.reduce((a, d) => a + d.amountSen, 0);
    return {
      date: x.date, orders: ds.length, amountSen, avgOrderSen: ds.length ? Math.round(amountSen / ds.length) : null, lorries, lorryOrders: withLorry.length,
      perLorrySen: lorries ? Math.round(withLorry.reduce((a, d) => a + d.amountSen, 0) / lorries) : null,
    };
  });
  const perDay = new Map<string, LorryDay>();
  for (const d of list) {
    if (!d.lorry || !countsForLorry(d.region)) continue;
    const k = `${d.lorry}|${d.date}`;
    const g = perDay.get(k) ?? { date: d.date, lorry: d.lorry, orders: 0, amountSen: 0 };
    g.orders += 1; g.amountSen += d.amountSen; perDay.set(k, g);
  }
  const lorryDayList = [...perDay.values()].sort((a, b) => b.date.localeCompare(a.date) || b.amountSen - a.amountSen);
  /* A region narrows what a lorry delivered. A job has no region, so its other trips stay
     the lorry's own, and only a picked day narrows them. */
  const byLorry: LorryRow[] = p.byLorry.flatMap((l) => {
    const ds = lorryDayList.filter((x) => x.lorry === l.lorry);
    const jobs = p.lorryJobs.filter((j) => j.plate === l.lorry && (day == null || j.date === day));
    if (ds.length === 0 && (region != null || jobs.length === 0)) return [];
    const t = lorryTrips(ds.map((x) => x.date), jobsInRegion(jobs, region));
    const amountSen = ds.reduce((a, x) => a + x.amountSen, 0);
    const doOrders = ds.reduce((a, x) => a + x.orders, 0);
    const workingDays = day == null ? l.workingDays : 1;
    return [{
      ...l, ...t, daysOut: t.deliveryDays, workingDays, downDays: day == null ? l.downDays : 0,
      occupancyPct: workingDays ? Math.round((t.trips / workingDays) * 1000) / 10 : null,
      doOrders, orders: doOrders + t.serviceOrders, amountSen, perDayOutSen: t.deliveryDays ? Math.round(amountSen / t.deliveryDays) : null,
    }];
  });
  const lorryList = list.filter((d) => countsForLorry(d.region));
  const recorded = lorryList.filter((d) => d.lorry);
  const lorryDays = day == null ? days.reduce((a, x) => a + x.lorries, 0) : new Set(recorded.map((d) => d.lorry)).size;
  const lorrySen = recorded.reduce((a, d) => a + d.amountSen, 0);
  const cat = region == null ? { byCategory: p.byCategory, chargesSen: p.chargesSen } : p.categoryByRegion[region];
  return {
    ...p,
    doCount: list.length,
    doAmountSen: list.reduce((a, d) => a + d.amountSen, 0),
    podClosed: list.filter((d) => d.status === "DELIVERED").length,
    days, byLorry, lorryDayList, doList: inRegion,
    lorry: { ...p.lorry, lorryDays, recordedOrders: recorded.length, lorryRegionOrders: lorryList.length, perLorrySen: lorryDays ? Math.round(lorrySen / lorryDays) : null },
    byCategory: cat?.byCategory ?? [],
    chargesSen: cat?.chargesSen ?? 0,
  };
}

/** Split a month into report windows. Week: W1 = 1st to 7th ... W5 = 29th to the end. */
export function reportWindows(months: readonly string[], size: "week" | "fortnight" | "month"): Array<{ key: string; label: string; from: string; to: string }> {
  const pad = (n: number) => String(n).padStart(2, "0");
  return months.flatMap((m) => {
    const last = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
    if (size === "month") return [{ key: `${m}-01`, label: m, from: `${m}-01`, to: `${m}-${pad(last)}` }];
    const spans = size === "week" ? [[1, 7], [8, 14], [15, 21], [22, 28], [29, last]] : [[1, 14], [15, last]];
    return spans.flatMap(([a, b], i) => {
      if ((a as number) > last) return [];
      const prefix = size === "week" ? "W" : "B";
      return [{ key: `${m}-${pad(a as number)}`, label: months.length > 1 ? `${m} · ${prefix}${i + 1}` : `${prefix}${i + 1}`, from: `${m}-${pad(a as number)}`, to: `${m}-${pad(b as number)}` }];
    });
  });
}

/** The report windows of a date range: the months it touches, cut to the range, so a
 *  picked range never shows a day outside it. */
export function windowsInRange(from: string, to: string, size: "week" | "fortnight" | "month"): ReturnType<typeof reportWindows> {
  const months: string[] = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7);) {
    months.push(m);
    const y = Number(m.slice(0, 4)); const mm = Number(m.slice(5, 7));
    m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
  }
  return reportWindows(months, size).flatMap((w) => {
    const a = w.from < from ? from : w.from;
    const b = w.to > to ? to : w.to;
    return a <= b ? [{ ...w, from: a, to: b }] : [];
  });
}

/** The date a job falls on: its delivery date on Delivery Planning, the latest one set,
 *  else the sales exemption date until a more exact date is given (owner 2026-11-07). */
export const jobDate = (o: { effective_delivery_date: string | null; sales_exemption_expiry?: string | null; ac_sales_exemption_expiry?: string | null }): string | null =>
  o.effective_delivery_date ?? o.sales_exemption_expiry ?? o.ac_sales_exemption_expiry ?? null;
