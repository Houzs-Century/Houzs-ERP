/* Logistic Overview · the period, day by day (owner, 2026-10-17): what went out
   each day (DOs issued) and what was closed as delivered, the average order,
   lorries and runs per day, the same by region, the average order per product
   category, and each lorry run.

   "Out" is a DO issued (LOADED or DELIVERED) on its DO date; "delivered" is a
   DO closed DELIVERED, on its delivered date when stamped, else its DO date.
   Lorries come from planned runs (trips); a DO not on any run still counts in
   the money, just not in the lorry figures. */

export interface PeriodDo {
  id: string; doDate: string; deliveredAt: string | null; status: string;
  amountSen: number; state: string | null;
  mattressSofaSen: number; bedframeSen: number; accessoriesSen: number; othersSen: number; serviceSen: number;
}
export interface PeriodTrip { id: string; date: string; lorry: string | null; driver: string | null; stops: number; amountSen: number; region: string | null }

/** The delivery region a customer state falls in (Delivery Planning's buckets). */
export function regionOf(state: string | null): string {
  const s = String(state ?? '').trim().toUpperCase();
  if (!s) return 'Unknown';
  if (/(KUALA LUMPUR|^KL$|SELANGOR|PUTRAJAYA|WILAYAH)/.test(s)) return 'KL / Selangor';
  if (/(PENANG|PULAU PINANG|KEDAH|PERLIS|PERAK|NORTH)/.test(s)) return 'Northern';
  if (/(JOHOR|MELAKA|MALACCA|NEGERI SEMBILAN|SINGAPORE)/.test(s)) return 'Southern';
  if (/(PAHANG|TERENGGANU|KELANTAN|EAST)/.test(s)) return 'East Coast';
  if (/(SABAH|SARAWAK|LABUAN)/.test(s)) return 'East Malaysia';
  return 'Other';
}

const addDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/** One DO line's product category and amount, for the average order per category. */
export interface DoCatLine { doId: string; category: string; sen: number }

export function logisticPeriod(dos: PeriodDo[], trips: PeriodTrip[], catLines: DoCatLine[], from: string, to: string) {
  const inPeriod = (d: string | null) => !!d && d >= from && d <= to;
  const out = dos.filter((d) => inPeriod(d.doDate));
  const delivered = dos.filter((d) => d.status === 'DELIVERED' && inPeriod((d.deliveredAt ?? d.doDate).slice(0, 10)));

  const days: Array<{ date: string; outCount: number; outSen: number; deliveredCount: number; deliveredSen: number; avgOrderSen: number | null; runs: number; lorries: number; runSen: number }> = [];
  for (let d = from; d <= to; d = addDay(d)) {
    const o = out.filter((x) => x.doDate === d);
    const dl = delivered.filter((x) => (x.deliveredAt ?? x.doDate).slice(0, 10) === d);
    const t = trips.filter((x) => x.date === d);
    const outSen = o.reduce((a, x) => a + x.amountSen, 0);
    days.push({
      date: d, outCount: o.length, outSen,
      deliveredCount: dl.length, deliveredSen: dl.reduce((a, x) => a + x.amountSen, 0),
      avgOrderSen: o.length ? Math.round(outSen / o.length) : null,
      runs: t.length, lorries: new Set(t.map((x) => x.lorry).filter(Boolean)).size, runSen: t.reduce((a, x) => a + x.amountSen, 0),
    });
  }

  const regions = new Map<string, { region: string; outCount: number; outSen: number; runs: number; runSen: number }>();
  for (const d of out) {
    const r = regionOf(d.state);
    const g = regions.get(r) ?? { region: r, outCount: 0, outSen: 0, runs: 0, runSen: 0 };
    g.outCount += 1; g.outSen += d.amountSen; regions.set(r, g);
  }
  for (const t of trips) {
    const r = t.region ?? 'Unknown';
    const g = regions.get(r) ?? { region: r, outCount: 0, outSen: 0, runs: 0, runSen: 0 };
    g.runs += 1; g.runSen += t.amountSen; regions.set(r, g);
  }

  /* Average order per category, from the DO lines: a DO counts in a category
     when it carries a charged line of it, with only that category's amount, so a mixed
     DO counts once in each of its categories. */
  const outIds = new Set(out.map((d) => d.id));
  const cats = new Map<string, Map<string, number>>();
  for (const l of catLines) {
    /* A free line (a bundled bedframe, a gift pillow) is not an order of that category. */
    if (!outIds.has(l.doId) || l.sen <= 0) continue;
    const m = cats.get(l.category) ?? new Map<string, number>();
    m.set(l.doId, (m.get(l.doId) ?? 0) + l.sen);
    cats.set(l.category, m);
  }
  const byCategory = [...cats.entries()].map(([category, m]) => {
    const sen = [...m.values()].reduce((x, y) => x + y, 0);
    return { category, orders: m.size, amountSen: sen, avgSen: m.size ? Math.round(sen / m.size) : null };
  }).sort((x, y) => y.amountSen - x.amountSen);

  return {
    days,
    byRegion: [...regions.values()].map((g) => ({ ...g, avgOrderSen: g.outCount ? Math.round(g.outSen / g.outCount) : null, avgRunSen: g.runs ? Math.round(g.runSen / g.runs) : null }))
      .sort((a, b) => b.outSen - a.outSen),
    byCategory,
    runList: [...trips].sort((a, b) => b.date.localeCompare(a.date) || b.amountSen - a.amountSen).slice(0, 200),
  };
}
