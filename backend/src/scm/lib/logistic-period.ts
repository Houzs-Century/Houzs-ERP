/* Logistic Overview · the period, day by day (owner, 2026-10-17): what was
   delivered each day (orders and amount), the average order, how many lorries
   went out and the average a lorry carried; the same by region; and the
   average order per product category.

   A delivery is a DO issued (LOADED or DELIVERED) on its DO date — the day the
   goods leave on the lorry. Waiting for the POD would make a day read low
   whenever the crew forgets to close the DO (that gap is shown on its own).
   The lorry is the one recorded on the DO's crew, else the lorry run it was
   placed on; a DO with neither counts in the money, not in the lorry figures. */

export interface PeriodDo {
  id: string; doDate: string; status: string; amountSen: number; state: string | null;
  /** The lorry that carried it, or null when not recorded. */
  lorry: string | null;
}

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

/** One DO line's product category and amount, for the average order per category.
 *  Category `Charges` = transport, disposal, storage and similar fee lines. */
export interface DoCatLine { doId: string; category: string; sen: number }

export function logisticPeriod(dos: PeriodDo[], catLines: DoCatLine[], from: string, to: string) {
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

  /* Average order per category, from the DO lines: a DO counts in a category
     when it carries a charged line of it, with only that category's amount, so a mixed
     DO counts once in each of its categories. Fee lines are not a product. */
  const outIds = new Set(out.map((d) => d.id));
  const cats = new Map<string, Map<string, number>>();
  let chargesSen = 0;
  for (const l of catLines) {
    /* A free line (a bundled bedframe, a gift pillow) is not an order of that category. */
    if (!outIds.has(l.doId) || l.sen <= 0) continue;
    if (l.category === 'Charges') { chargesSen += l.sen; continue; }
    const m = cats.get(l.category) ?? new Map<string, number>();
    m.set(l.doId, (m.get(l.doId) ?? 0) + l.sen);
    cats.set(l.category, m);
  }
  const byCategory = [...cats.entries()].map(([category, m]) => {
    const sen = [...m.values()].reduce((x, y) => x + y, 0);
    return { category, orders: m.size, amountSen: sen, avgSen: m.size ? Math.round(sen / m.size) : null };
  }).sort((x, y) => y.amountSen - x.amountSen);

  const lorryDays = days.reduce((a, x) => a + x.lorries, 0);
  const lorrySen = out.filter((x) => x.lorry).reduce((a, x) => a + x.amountSen, 0);
  return {
    days,
    /* Average a lorry carried per day it went out, over the period. */
    lorry: { lorryDays, recordedOrders: out.filter((x) => x.lorry).length, perLorrySen: lorryDays ? Math.round(lorrySen / lorryDays) : null },
    byRegion: [...regions.values()].map((g) => ({ ...g, avgOrderSen: g.orders ? Math.round(g.amountSen / g.orders) : null }))
      .sort((a, b) => b.amountSen - a.amountSen),
    byCategory,
    chargesSen,
  };
}
