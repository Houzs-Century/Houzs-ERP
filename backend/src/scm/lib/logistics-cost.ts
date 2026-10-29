// ----------------------------------------------------------------------------
// logistics-cost — the Logistics cost report's arithmetic (owner 2026-10-29:
// 物流报告 按地区、每趟、setup & dismantle —「都需要」; 自己罗厘的成本（油、过路费、
// 司机）也要算 →「那就先算 overall … trip 除成本」). Pure: the route reads the
// rows, this decides; scm/lib/logistics-cost.test.ts pins it.
//
//   A DO goes out on its DELIVERY DAY — the customer delivery date Delivery
//   Planning schedules, else the DO's own date — and lands in its state's
//   delivery-planning REGION.
//   WHO TOOK IT is the DO's crew (scm.delivery_order_crew): the lorry picked from
//   the list, else the plate typed ("VRH 9058", "W 1591 T / MCF 3084"), matched
//   to the list with spaces and case ignored. An internal lorry is OURS.
//   A TRIP of ours is one lorry on one day — the DOs are the record; Delivery
//   Planning's own trips are barely used. OWN-LORRY COST is OVERALL (the
//   owner's word): what the ticked accounts (fuel / toll / parking and upkeep per
//   lorry; a driver salary account once there is one) booked in the month,
//   divided by the month's trips — the cost of one trip, shared equally by the
//   DOs on it. A month with cost and no trip keeps its cost unallocated, said so.
//   3PL COST of a DO is its charge from the carrier's bill (threepl_do_charges —
//   a bill line's amount already split over the DOs it names); a 3PL RUN is one
//   bill line, as the carrier billed it.
//   SETUP & DISMANTLE is each fair's own books — the Setup and Transport Setup &
//   Dismantle rows Project Overview shows (scm/lib/event-books.ts).
// ----------------------------------------------------------------------------

/** "VRH 9058" / "vrh-9058" → "VRH9058". */
export const normalisePlate = (s: string | null | undefined): string => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Every plate a typed cell names — "W 1591 T / MCF 3084" is two lorries. */
export const platesOf = (text: string | null | undefined): string[] =>
  String(text ?? '').split(/[/,&+]|\bAND\b/i).map(normalisePlate).filter(Boolean);

export const monthOf = (day: string): string => day.slice(0, 7);

export type LogisticsDo = {
  id: string; doNumber: string; soDocNo: string | null;
  /** The delivery day, YYYY-MM-DD. */
  day: string;
  state: string | null;
  /** What the DO carries, from its lines. */
  valueSen: number;
  crewLorryId: string | null;
  crewPlate: string | null;
};
export type LogisticsLorry = { id: string; plate: string; isInternal: boolean };
export type LogisticsRegion = { code: string; name: string; sortOrder: number; states: string[] };
export type ThreeplCharge = { doId: string; billedSen: number };
export type ThreeplRun = {
  lineId: string; apInvoiceNo: string | null; carrier: string | null; lineDate: string | null; invoiceDate: string | null;
  amountSen: number; doIds: string[]; text: string;
};
export type OwnCostLeg = { month: string; accountCode: string; accountName: string | null; amountSen: number };
export type EventCost = { id: number; code: string | null; name: string; startDate: string | null; endDate: string | null; setupSen: number; transportSen: number };

export type LogisticsInput = {
  from: string; to: string;
  /** Every DO of the whole months the range touches — a month's trips divide its whole cost. */
  dos: LogisticsDo[];
  lorries: LogisticsLorry[];
  regions: LogisticsRegion[];
  charges: ThreeplCharge[];
  runs: ThreeplRun[];
  ownCost: OwnCostLeg[];
  events: EventCost[];
  /** 3PL bill lines nobody assigned yet, and fair lines with no fair. */
  openLines: { count: number; sen: number };
  eventLinesNoFair: { count: number; sen: number };
};

export type Deliverer =
  | { kind: 'own'; plate: string }
  | { kind: 'outside'; plate: string }
  | { kind: 'unlisted'; text: string }
  | { kind: 'none' };

export type RegionRow = { code: string; name: string; dos: number; valueSen: number; ownSen: number; threeplSen: number; totalSen: number };
export type TripRow = {
  kind: 'own' | '3pl'; day: string; who: string; ref: string | null;
  dos: number; doNumbers: string[]; regions: string[]; amountSen: number | null;
};
export type MonthRow = { month: string; ownCostSen: number; trips: number; perTripSen: number | null; accounts: Array<{ code: string; name: string | null; sen: number }> };
export type EventRow = EventCost & { totalSen: number };
export type LogisticsReport = {
  from: string; to: string;
  months: MonthRow[];
  regions: RegionRow[];
  trips: TripRow[];
  events: EventRow[];
  gaps: {
    dosNoDeliverer: number;
    dosOutsideNoBill: number;
    unlistedPlates: string[];
    openLines: { count: number; sen: number };
    eventLinesNoFair: { count: number; sen: number };
    monthsWithoutTrips: string[];
  };
  totals: { dos: number; valueSen: number; ownSen: number; threeplSen: number; totalSen: number; setupSen: number; transportSen: number };
};

export const NO_REGION = { code: 'NONE', name: 'No state / region' } as const;

/** Who took one DO, from its crew. */
export function delivererOf(d: Pick<LogisticsDo, 'crewLorryId' | 'crewPlate'>, lorries: readonly LogisticsLorry[]): Deliverer {
  const byId = d.crewLorryId ? lorries.find((l) => l.id === d.crewLorryId) : undefined;
  if (byId) return byId.isInternal ? { kind: 'own', plate: normalisePlate(byId.plate) } : { kind: 'outside', plate: normalisePlate(byId.plate) };
  const typed = platesOf(d.crewPlate);
  if (typed.length === 0) return { kind: 'none' };
  const known = typed.map((p) => lorries.find((l) => normalisePlate(l.plate) === p)).filter((l): l is LogisticsLorry => !!l);
  const ours = known.find((l) => l.isInternal);
  if (ours) return { kind: 'own', plate: normalisePlate(ours.plate) };
  if (known.length > 0) return { kind: 'outside', plate: normalisePlate(known[0]!.plate) };
  return { kind: 'unlisted', text: String(d.crewPlate ?? '').trim() };
}

/** State → region, by the state's own key with case and spaces ignored. A state
    in several regions takes the first in the regions' order. */
export function regionIndex(regions: readonly LogisticsRegion[]): (state: string | null) => { code: string; name: string } {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
  const map = new Map<string, { code: string; name: string }>();
  for (const r of [...regions].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))) {
    for (const s of r.states) if (!map.has(key(s))) map.set(key(s), { code: r.code, name: r.name });
  }
  return (state) => (state && map.get(key(state))) || NO_REGION;
}

/** An amount shared over n parts in whole sen, the remainder to the first. */
export function share(totalSen: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.trunc(totalSen / n);
  const out = new Array<number>(n).fill(base);
  let rest = totalSen - base * n;
  for (let i = 0; rest !== 0 && i < n; i += 1) { const step = Math.sign(rest); out[i]! += step; rest -= step; }
  return out;
}

const inRange = (day: string, from: string, to: string) => day >= from && day <= to;

export function buildLogisticsReport(input: LogisticsInput): LogisticsReport {
  const { from, to } = input;
  const regionOf = regionIndex(input.regions);
  const who = new Map(input.dos.map((d) => [d.id, delivererOf(d, input.lorries)] as const));

  /* Our trips, every one of the whole months: lorry + day. */
  const trips = new Map<string, { plate: string; day: string; dos: LogisticsDo[] }>();
  for (const d of input.dos) {
    const w = who.get(d.id)!;
    if (w.kind !== 'own') continue;
    const k = `${w.plate}|${d.day}`;
    const t = trips.get(k);
    if (t) t.dos.push(d); else trips.set(k, { plate: w.plate, day: d.day, dos: [d] });
  }
  const tripsByMonth = new Map<string, number>();
  for (const t of trips.values()) tripsByMonth.set(monthOf(t.day), (tripsByMonth.get(monthOf(t.day)) ?? 0) + 1);

  /* The months: what the ticked accounts booked, per account. */
  const monthCost = new Map<string, Map<string, { name: string | null; sen: number }>>();
  for (const l of input.ownCost) {
    const m = monthCost.get(l.month) ?? new Map<string, { name: string | null; sen: number }>();
    const a = m.get(l.accountCode) ?? { name: l.accountName, sen: 0 };
    a.sen += l.amountSen;
    m.set(l.accountCode, a);
    monthCost.set(l.month, m);
  }
  const monthsInRange: string[] = [];
  for (let m = monthOf(from); m <= monthOf(to); m = nextMonth(m)) monthsInRange.push(m);
  const months: MonthRow[] = monthsInRange.map((month) => {
    const accounts = [...(monthCost.get(month) ?? new Map()).entries()]
      .map(([code, a]) => ({ code, name: a.name, sen: a.sen }))
      .sort((a, b) => a.code.localeCompare(b.code));
    const ownCostSen = accounts.reduce((s, a) => s + a.sen, 0);
    const n = tripsByMonth.get(month) ?? 0;
    return { month, ownCostSen, trips: n, perTripSen: n > 0 ? Math.round(ownCostSen / n) : null, accounts };
  });
  const perTrip = new Map(months.map((m) => [m.month, m.perTripSen] as const));

  /* Each own DO's share of its trip. */
  const ownShare = new Map<string, number>();
  const tripRows: TripRow[] = [];
  for (const t of trips.values()) {
    const cost = perTrip.get(monthOf(t.day)) ?? null;
    if (cost != null) share(cost, t.dos.length).forEach((s, i) => ownShare.set(t.dos[i]!.id, s));
    if (!inRange(t.day, from, to)) continue;
    tripRows.push({
      kind: 'own', day: t.day, who: t.plate, ref: null, dos: t.dos.length,
      doNumbers: t.dos.map((d) => d.doNumber).sort(),
      regions: [...new Set(t.dos.map((d) => regionOf(d.state).name))].sort(),
      amountSen: cost,
    });
  }

  /* The DOs of the report's own days. */
  const shown = input.dos.filter((d) => inRange(d.day, from, to));
  const shownIds = new Set(shown.map((d) => d.id));
  const charged = new Map<string, number>();
  for (const ch of input.charges) if (shownIds.has(ch.doId)) charged.set(ch.doId, (charged.get(ch.doId) ?? 0) + ch.billedSen);

  const byRegion = new Map<string, RegionRow>();
  for (const d of shown) {
    const r = regionOf(d.state);
    const row = byRegion.get(r.code) ?? { code: r.code, name: r.name, dos: 0, valueSen: 0, ownSen: 0, threeplSen: 0, totalSen: 0 };
    row.dos += 1;
    row.valueSen += d.valueSen;
    row.ownSen += ownShare.get(d.id) ?? 0;
    row.threeplSen += charged.get(d.id) ?? 0;
    row.totalSen = row.ownSen + row.threeplSen;
    byRegion.set(r.code, row);
  }
  const regionOrder = new Map(input.regions.map((r) => [r.code, r.sortOrder] as const));
  const regions = [...byRegion.values()].sort((a, b) =>
    (a.code === NO_REGION.code ? 1 : 0) - (b.code === NO_REGION.code ? 1 : 0)
    || (regionOrder.get(a.code) ?? 999) - (regionOrder.get(b.code) ?? 999) || a.name.localeCompare(b.name));

  /* The 3PL runs: one bill line each, on its own date — else its DOs' first day,
     else the bill's. A run whose DOs all fall outside the range stays out. */
  const doById = new Map(input.dos.map((d) => [d.id, d] as const));
  for (const run of input.runs) {
    const its = run.doIds.map((id) => doById.get(id)).filter((d): d is LogisticsDo => !!d);
    const firstDay = its.map((d) => d.day).sort()[0] ?? null;
    const day = run.lineDate ?? firstDay ?? run.invoiceDate;
    if (!day || !inRange(day, from, to)) continue;
    tripRows.push({
      kind: '3pl', day, who: run.carrier ?? '3PL', ref: run.apInvoiceNo, dos: run.doIds.length,
      doNumbers: its.map((d) => d.doNumber).sort(),
      regions: [...new Set(its.map((d) => regionOf(d.state).name))].sort(),
      amountSen: run.amountSen,
    });
  }
  tripRows.sort((a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind) || a.who.localeCompare(b.who));

  const unlisted = new Set<string>();
  let dosNoDeliverer = 0;
  let dosOutsideNoBill = 0;
  for (const d of shown) {
    const w = who.get(d.id)!;
    if (w.kind === 'unlisted') unlisted.add(w.text);
    if ((w.kind === 'none' || w.kind === 'unlisted') && !charged.has(d.id)) dosNoDeliverer += 1;
    if (w.kind === 'outside' && !charged.has(d.id)) dosOutsideNoBill += 1;
  }

  const events: EventRow[] = input.events.map((e) => ({ ...e, totalSen: e.setupSen + e.transportSen }));
  const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
  return {
    from, to, months, regions, trips: tripRows, events,
    gaps: {
      dosNoDeliverer, dosOutsideNoBill, unlistedPlates: [...unlisted].sort(),
      openLines: input.openLines, eventLinesNoFair: input.eventLinesNoFair,
      monthsWithoutTrips: months.filter((m) => m.ownCostSen !== 0 && m.trips === 0).map((m) => m.month),
    },
    totals: {
      dos: shown.length, valueSen: sum(regions, (r) => r.valueSen), ownSen: sum(regions, (r) => r.ownSen),
      threeplSen: sum(regions, (r) => r.threeplSen), totalSen: sum(regions, (r) => r.totalSen),
      setupSen: sum(events, (e) => e.setupSen), transportSen: sum(events, (e) => e.transportSen),
    },
  };
}

function nextMonth(m: string): string {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

/* ── The accounts that make up OUR lorries' cost ──────────────────────────────
   Until Finance ticks its own list (Logistics cost › Own-lorry cost accounts),
   the chart answers: an expense account whose name says LORI / LORRY, or names
   one of our lorries' plates — the per-lorry fuel / toll / parking and upkeep
   accounts. A driver salary account counts once Finance ticks it. */
export type ChartAccount = { account_code: string; account_name: string | null; account_type: string | null; is_active?: boolean | null };

export function defaultOwnCostAccounts(chart: readonly ChartAccount[], lorries: readonly LogisticsLorry[]): string[] {
  const plates = lorries.filter((l) => l.isInternal).map((l) => normalisePlate(l.plate)).filter(Boolean);
  return chart
    .filter((a) => String(a.account_type ?? '').toUpperCase() === 'EXPENSE' && a.is_active !== false)
    .filter((a) => {
      const name = String(a.account_name ?? '');
      return /\bLOR(I|RY|RIES)\b/i.test(name) || plates.some((p) => normalisePlate(name).includes(p));
    })
    .map((a) => a.account_code)
    .sort();
}
