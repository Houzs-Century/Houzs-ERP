// Logistic Overview, narrowed to one region: the page's figures recomputed from the
// delivery orders of that region, so everything below a click follows it.
import type { DayRow, LorryDay, LorryRow } from "./LogisticDailySection";
import type { PeriodTotals } from "./LogisticPeriodSection";

export function focusPeriod(p: PeriodTotals, region: string | null): PeriodTotals {
  if (region == null) return p;
  const list = p.doList.filter((d) => d.region === region);
  const days: DayRow[] = p.days.map((x) => {
    const ds = list.filter((d) => d.date === x.date);
    const withLorry = ds.filter((d) => d.lorry);
    const lorries = new Set(withLorry.map((d) => d.lorry)).size;
    const amountSen = ds.reduce((a, d) => a + d.amountSen, 0);
    return {
      date: x.date, orders: ds.length, amountSen, avgOrderSen: ds.length ? Math.round(amountSen / ds.length) : null, lorries, lorryOrders: withLorry.length,
      perLorrySen: lorries ? Math.round(withLorry.reduce((a, d) => a + d.amountSen, 0) / lorries) : null,
    };
  });
  const perDay = new Map<string, LorryDay>();
  for (const d of list) {
    if (!d.lorry) continue;
    const k = `${d.lorry}|${d.date}`;
    const g = perDay.get(k) ?? { date: d.date, lorry: d.lorry, orders: 0, amountSen: 0 };
    g.orders += 1; g.amountSen += d.amountSen; perDay.set(k, g);
  }
  const lorryDayList = [...perDay.values()].sort((a, b) => b.date.localeCompare(a.date) || b.amountSen - a.amountSen);
  /* Delivery days and revenue are this region's. Days in use stay the lorry's own:
     a lorry is in use or it is not, whichever region it went to. */
  const byLorry: LorryRow[] = p.byLorry.flatMap((l) => {
    const ds = lorryDayList.filter((x) => x.lorry === l.lorry);
    if (ds.length === 0) return [];
    const amountSen = ds.reduce((a, x) => a + x.amountSen, 0);
    return [{ ...l, daysOut: ds.length, orders: ds.reduce((a, x) => a + x.orders, 0), amountSen, perDayOutSen: Math.round(amountSen / ds.length) }];
  });
  const recorded = list.filter((d) => d.lorry);
  const lorryDays = days.reduce((a, x) => a + x.lorries, 0);
  const lorrySen = recorded.reduce((a, d) => a + d.amountSen, 0);
  const cat = p.categoryByRegion[region];
  return {
    ...p,
    doCount: list.length,
    doAmountSen: list.reduce((a, d) => a + d.amountSen, 0),
    podClosed: list.filter((d) => d.status === "DELIVERED").length,
    days, byLorry, lorryDayList, doList: list,
    lorry: { ...p.lorry, lorryDays, recordedOrders: recorded.length, perLorrySen: lorryDays ? Math.round(lorrySen / lorryDays) : null },
    byCategory: cat?.byCategory ?? [],
    chargesSen: cat?.chargesSen ?? 0,
  };
}

/** Split a month into report windows. Week: W1 = 1st to 7th ... W5 = 29th to the end. */
export function reportWindows(months: readonly string[], size: "week" | "fortnight"): Array<{ key: string; label: string; from: string; to: string }> {
  const pad = (n: number) => String(n).padStart(2, "0");
  return months.flatMap((m) => {
    const last = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
    const spans = size === "week" ? [[1, 7], [8, 14], [15, 21], [22, 28], [29, last]] : [[1, 14], [15, last]];
    return spans.flatMap(([a, b], i) => {
      if ((a as number) > last) return [];
      const prefix = size === "week" ? "W" : "B";
      return [{ key: `${m}-${pad(a as number)}`, label: months.length > 1 ? `${m} · ${prefix}${i + 1}` : `${prefix}${i + 1}`, from: `${m}-${pad(a as number)}`, to: `${m}-${pad(b as number)}` }];
    });
  });
}
