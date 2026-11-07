/* Logistic Overview · the period, day by day (owner, 2026-10-17): what was
   delivered each day (orders and amount), the average order, how many lorries
   went out and the average a lorry carried; the same by region; and the
   average order per product category.

   A delivery is a DO issued (LOADED or DELIVERED) on its DO date — the day the
   goods leave on the lorry. Waiting for the POD would make a day read low
   whenever the crew forgets to close the DO (that gap is shown on its own).
   The lorry is the one recorded on the DO's crew, else the lorry run it was
   placed on; a DO with neither counts in the money, not in the lorry figures.
   Each lorry's delivery days, revenue and occupancy show whether the fixed-cost
   fleet is kept busy. A delivery day is a day it carried at least one DO: Setup,
   Transfer item and the other board jobs are not DOs and carry no revenue, so
   they stay out of the average (owner 2026-11-04). A day in use also counts those
   other jobs, so a lorry reads delivery days (revenue) and days in use (occupancy)
   against the days it could work (owner 2026-11-07). */

import { regionOf } from '../shared/logistic-region';
import { PROCUREMENT_CATEGORY_LABEL } from './procurement-overview';
import { MAIN_CATEGORY_ORDER } from './so-readiness';

export interface PeriodDo {
  id: string; doDate: string; status: string; amountSen: number; state: string | null;
  /** The lorry that carried it, or null when not recorded. */
  lorry: string | null;
}

export { regionOf };

/** What an order is, when it carries several. Bedframe comes last: it names an order only
 *  when nothing bigger is on it. */
const MAIN_CATEGORY: string[] = [...MAIN_CATEGORY_ORDER].reverse().map((c) => PROCUREMENT_CATEGORY_LABEL[c as keyof typeof PROCUREMENT_CATEGORY_LABEL]);

const addDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/** One DO line's product category and amount, for the average order per category.
 *  Category `Charges` = transport, disposal, storage and similar fee lines. */
export interface DoCatLine { doId: string; category: string; sen: number }

/** A lorry of the fleet; `internal` = our own (its crew and instalment are fixed cost). */
export interface FleetLorry { plate: string; internal: boolean }

/** Working days in [from, to]: every day but Sunday (owner 2026-10-17). */
export function workingDays(from: string, to: string): number {
  let n = 0;
  for (let d = from; d <= to; d = addDay(d)) if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) n += 1;
  return n;
}

export function logisticPeriod(dos: PeriodDo[], catLines: DoCatLine[], from: string, to: string, fleet: FleetLorry[], today: string, downDatesOf: ReadonlyMap<string, ReadonlySet<string>>, usedDatesOf: ReadonlyMap<string, ReadonlySet<string>>) {
  const out = dos.filter((d) => d.doDate >= from && d.doDate <= to);

  const days: Array<{ date: string; orders: number; amountSen: number; avgOrderSen: number | null; lorries: number; lorryOrders: number; perLorrySen: number | null }> = [];
  for (let d = from; d <= to; d = addDay(d)) {
    const o = out.filter((x) => x.doDate === d);
    const amountSen = o.reduce((a, x) => a + x.amountSen, 0);
    const withLorry = o.filter((x) => x.lorry);
    const lorries = new Set(withLorry.map((x) => x.lorry)).size;
    days.push({
      date: d, orders: o.length, amountSen,
      avgOrderSen: o.length ? Math.round(amountSen / o.length) : null,
      lorries, lorryOrders: withLorry.length,
      /* Only the DOs whose lorry is known, over those lorries. */
      perLorrySen: lorries ? Math.round(withLorry.reduce((a, x) => a + x.amountSen, 0) / lorries) : null,
    });
  }

  const regions = new Map<string, { region: string; orders: number; amountSen: number }>();
  for (const d of out) {
    const r = regionOf(d.state);
    const g = regions.get(r) ?? { region: r, orders: 0, amountSen: 0 };
    g.orders += 1; g.amountSen += d.amountSen; regions.set(r, g);
  }

  /* Average order per category, from the DO lines. An order is one category with its
     whole amount (owner 2026-11-07): sofa and mattress never share one, and a bedframe
     is the main item only when the order delivers nothing bigger. Fee lines are not a
     product. */
  const categoriesOf = (list: PeriodDo[]) => {
    const outIds = new Set(list.map((d) => d.id));
    const linesOf = new Map<string, Map<string, number>>();
    let chargesSen = 0;
    for (const l of catLines) {
      /* A free line (a bundled bedframe, a gift pillow) is not an order of that category. */
      if (!outIds.has(l.doId) || l.sen <= 0) continue;
      if (l.category === 'Charges') { chargesSen += l.sen; continue; }
      const m = linesOf.get(l.doId) ?? new Map<string, number>();
      m.set(l.category, (m.get(l.category) ?? 0) + l.sen);
      linesOf.set(l.doId, m);
    }
    const cats = new Map<string, Map<string, number>>();
    for (const [doId, m] of linesOf) {
      const category = MAIN_CATEGORY.find((c) => m.has(c)) ?? [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!category) continue;
      const orders = cats.get(category) ?? new Map<string, number>();
      orders.set(doId, [...m.values()].reduce((x, y) => x + y, 0));
      cats.set(category, orders);
    }
    const byCategory = [...cats.entries()].map(([category, m]) => {
      const sen = [...m.values()].reduce((x, y) => x + y, 0);
      return { category, orders: m.size, amountSen: sen, avgSen: m.size ? Math.round(sen / m.size) : null };
    }).sort((x, y) => y.amountSen - x.amountSen);
    return { byCategory, chargesSen };
  };
  const categoryByRegion = Object.fromEntries([...regions.keys()].map((r) => [r, categoriesOf(out.filter((d) => regionOf(d.state) === r))]));

  /* Per lorry: each delivery day, what it carried; occupancy = days in use ÷ the
     working days so far it could work, so a day in the workshop is not held
     against it. A day it broke down after delivering still counts: it went out
     (owner 2026-11-04). Our own lorries are listed even on no delivery day, since
     an idle own lorry still costs its crew and instalment. */
  const work = workingDays(from, to < today ? to : today);
  const perDay = new Map<string, { date: string; lorry: string; orders: number; amountSen: number }>();
  for (const d of out) {
    if (!d.lorry) continue;
    const k = `${d.lorry}|${d.doDate}`;
    const g = perDay.get(k) ?? { date: d.doDate, lorry: d.lorry, orders: 0, amountSen: 0 };
    g.orders += 1; g.amountSen += d.amountSen; perDay.set(k, g);
  }
  const lorryDayList = [...perDay.values()].sort((a, b) => b.date.localeCompare(a.date) || b.amountSen - a.amountSen);
  const plates = new Set([...fleet.filter((l) => l.internal).map((l) => l.plate), ...lorryDayList.map((x) => x.lorry), ...[...usedDatesOf.keys()].filter((p) => fleet.some((l) => l.plate === p))]);
  const internal = new Set(fleet.filter((l) => l.internal).map((l) => l.plate));
  const byLorry = [...plates].map((plate) => {
    const ds = lorryDayList.filter((x) => x.lorry === plate);
    const amountSen = ds.reduce((a, x) => a + x.amountSen, 0);
    const used = new Set([...ds.map((x) => x.date), ...(usedDatesOf.get(plate) ?? [])]);
    const downDays = Math.min(work, [...(downDatesOf.get(plate) ?? [])].filter((d) => !used.has(d)).length);
    const available = work - downDays;
    return {
      lorry: plate, internal: internal.has(plate), daysOut: ds.length, usedDays: used.size, workingDays: available, downDays,
      occupancyPct: available ? Math.round((used.size / available) * 1000) / 10 : null,
      orders: ds.reduce((a, x) => a + x.orders, 0), amountSen,
      perDayOutSen: ds.length ? Math.round(amountSen / ds.length) : null,
    };
  }).sort((a, b) => Number(b.internal) - Number(a.internal) || b.amountSen - a.amountSen);

  const lorryDays = days.reduce((a, x) => a + x.lorries, 0);
  const lorrySen = out.filter((x) => x.lorry).reduce((a, x) => a + x.amountSen, 0);
  return {
    days,
    /* Average a lorry carried per day it went out, over the period. */
    lorry: { lorryDays, recordedOrders: out.filter((x) => x.lorry).length, perLorrySen: lorryDays ? Math.round(lorrySen / lorryDays) : null, workingDays: work },
    byLorry,
    lorryDayList: lorryDayList.slice(0, 400),
    byRegion: [...regions.values()].map((g) => ({ ...g, avgOrderSen: g.orders ? Math.round(g.amountSen / g.orders) : null }))
      .sort((a, b) => b.amountSen - a.amountSen),
    ...categoriesOf(out),
    categoryByRegion,
  };
}
