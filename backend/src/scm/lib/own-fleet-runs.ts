// ----------------------------------------------------------------------------
// own-fleet-runs — our own lorries priced like a 3PL (owner 2026-11-24:
// 「你可以吧自己的lorry 当做是一个3pl，就是我会有一个内部的算法」; on the fair setup
// rates: 「内部送货的价格不可能那么高，我要能自己维护」; and 「我不是应该算是一个3pl吗」).
//
// A trip is one lorry on one day (delivery-tms.md). It carries the delivery
// orders our lorry ran that day (own-lorry-do-run.ts: Last Mile's crew record,
// plus the DO stops of our own Delivery Planning trips) and those trips' other
// jobs (trip-stop-jobs.ts). It is priced ONCE by the own fleet rate card, the
// way /reconcile prices a 3PL trip: its sets added up on one ladder, the
// farthest zone once, each other job once. A job the card has no price for
// costs nothing. Read-only: nothing here is posted and nothing reaches COGS.
// PURE.
// ----------------------------------------------------------------------------
import { computeDeliveryCost, type CostBreakdown, type DeliveryFacts, type DeliveryStop, type RateCardSpec } from './delivery-rate-card';
import type { BillableJobType } from './rate-rule-taxonomy';
import { JOB_COUNT_FACT, jobStopFacts, stopJob, type TripStopRow } from './trip-stop-jobs';
import { normalizePlate } from './plate-normalize';

/** One delivery order one of our lorries ran. */
export interface OwnDo {
  doId: string;
  doNumber: string | null;
  companyId: number;
  /** The day it ran: its run date (doRunDate), or its trip's date when a trip stop carries it. */
  runDate: string;
  lorryId: string | null;
  plate: string;
  /** The Delivery Planning trip whose stop carries it, else null (Last Mile's crew). */
  tripId: string | null;
  /** Its order's facts (threepl-do-charge.ts doFacts), null when it has no order to read. */
  facts: DeliveryFacts | null;
  /** The same buyer at the same doorstep: what a per-customer card charges once for. */
  customerKey: string;
}

/** One of our own Delivery Planning trips (not outsourced, not cancelled). */
export interface OwnTrip {
  tripId: string;
  tripNo: string | null;
  tripDate: string;
  lorryId: string | null;
  plate: string | null;
  /** Every stop; a delivery order stop is priced from its order (an OwnDo), so
      only the other jobs count here (stopJob). */
  stops: TripStopRow[];
}

/** One lorry's day. */
export interface OwnRun {
  key: string;
  runDate: string;
  lorryId: string | null;
  plate: string;
  tripNos: string[];
  dos: OwnDo[];
  stops: TripStopRow[];
}

/** The card a run is priced by, with what the page shows of it. */
export interface PricingCard { id: string; name: string; spec: RateCardSpec }

export interface PricedRun extends OwnRun {
  /** The other jobs on it, by job. */
  jobs: Partial<Record<Exclude<BillableJobType, 'DELIVERY'>, number>>;
  setCount: number;
  zones: string[];
  card: { id: string; name: string } | null;
  /** The card's price for the whole trip; null = no card prices this lorry. */
  costSen: number | null;
  /** The part of costSen the other jobs' prices make up (Setup ... Transfer). */
  otherJobsSen: number | null;
  breakdown: CostBreakdown | null;
}

/** The most days one read may cover: each day's orders are read with their crews and lines. */
export const OWN_FLEET_MAX_DAYS = 186;

/** The window asked for, or why it cannot be read. */
export function ownFleetWindow(from: string | null | undefined, to: string | null | undefined): { ok: true; from: string; to: string } | { ok: false; reason: string } {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const f = String(from ?? '');
  const t = String(to ?? '');
  const day = (s: string) => (iso.test(s) ? Date.parse(`${s}T00:00:00Z`) : Number.NaN);
  if (!Number.isFinite(day(f)) || !Number.isFinite(day(t))) return { ok: false, reason: 'Pick a From and a To date.' };
  if (f > t) return { ok: false, reason: 'From must be on or before To.' };
  if ((day(t) - day(f)) / 86_400_000 + 1 > OWN_FLEET_MAX_DAYS) return { ok: false, reason: `Pick at most ${OWN_FLEET_MAX_DAYS} days at a time.` };
  return { ok: true, from: f, to: t };
}

/** One lorry: its master id, else its plate; a trip with neither is a run of its own. */
export function lorryKeyOf(lorryId: string | null, plate: string | null, fallback: string): string {
  if (lorryId) return `lorry:${lorryId}`;
  const p = normalizePlate(plate);
  return p ? `plate:${p}` : fallback;
}

/** The buyer a per-customer card charges once for: the SAME debtor at the SAME
 *  address (owner: 「一样的顾客、一样的地址」), as /reconcile keys it. */
export function customerKeyOf(so: { doc_no?: unknown; debtor_code?: unknown; debtor_name?: unknown; address1?: unknown; address2?: unknown; postcode?: unknown }): string {
  const t = (v: unknown) => (v == null || v === '' ? '' : String(v));
  const who = t(so.debtor_code) || t(so.debtor_name) || t(so.doc_no);
  const where = [t(so.address1), t(so.address2), t(so.postcode)].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toUpperCase();
  return `${who}@@${where}`;
}

/** Each lorry's day: its trips' jobs and every delivery order it ran. A DO counts
 *  on one trip only, the first it is given on. Newest day first. */
export function buildOwnRuns(dos: readonly OwnDo[], trips: readonly OwnTrip[]): OwnRun[] {
  const runs = new Map<string, OwnRun>();
  const runOf = (date: string, lorryId: string | null, plate: string | null, fallback: string): OwnRun => {
    const key = `${date}|${lorryKeyOf(lorryId, plate, fallback)}`;
    let r = runs.get(key);
    if (!r) {
      r = { key, runDate: date, lorryId, plate: plate ?? '', tripNos: [], dos: [], stops: [] };
      runs.set(key, r);
    }
    if (!r.plate && plate) r.plate = plate;
    return r;
  };
  for (const t of trips) {
    const r = runOf(t.tripDate, t.lorryId, t.plate, `trip:${t.tripId}`);
    if (t.tripNo && !r.tripNos.includes(t.tripNo)) r.tripNos.push(t.tripNo);
    r.stops.push(...t.stops);
  }
  const seen = new Set<string>();
  for (const d of dos) {
    if (seen.has(d.doId)) continue;
    seen.add(d.doId);
    runOf(d.runDate, d.lorryId, d.plate, d.tripId ? `trip:${d.tripId}` : `do:${d.doId}`).dos.push(d);
  }
  return [...runs.values()].sort((a, b) => b.runDate.localeCompare(a.runDate) || a.plate.localeCompare(b.plate) || a.key.localeCompare(b.key));
}

/** A trip's facts for the card, as /reconcile derives a 3PL trip's: the sets
 *  and goods value of its orders added up, every zone it touches (the card
 *  charges the farthest, once), each other job once with its address. `zoneOf` reads an address's
 *  postcode zone (Delivery Zones). */
export function runFacts(run: OwnRun, zoneOf: (address: string | null) => string | null): DeliveryFacts {
  let setCount = 0;
  let itemCount = 0;
  let goodsValueSen = 0;
  const zones: string[] = [];
  const doStops: DeliveryStop[] = [];
  for (const d of run.dos) {
    setCount += d.facts?.setCount ?? 0;
    itemCount += d.facts?.itemCount ?? 0;
    goodsValueSen += d.facts?.goodsValueSen ?? 0;
    const z = d.facts?.destinationZone ?? null;
    if (z && !zones.includes(z)) zones.push(z);
    doStops.push({ zone: z, addressText: d.facts?.addressText ?? '', jobType: 'DELIVERY' });
  }
  const jobs = jobStopFacts(run.stops, zoneOf);
  return {
    setCount,
    itemCount,
    dropCount: run.dos.length,
    customerCount: new Set(run.dos.map((d) => d.customerKey)).size,
    goodsValueSen,
    destinationZone: zones[0] ?? null,
    destinationZones: zones,
    addressText: run.dos.map((d) => d.facts?.addressText ?? '').join(' | '),
    stops: [...doStops, ...jobs.stops],
    ...jobs.counts,
  };
}

/** The lines a card prices the other jobs with (their rule is named for the job) —
    what a trip costs beyond its deliveries. */
const OTHER_JOB_LINES: ReadonlySet<string> = new Set(Object.keys(JOB_COUNT_FACT));

/** Every trip priced once by its card (`cardFor`; null = no card, no cost). */
export function priceOwnRuns(
  runs: readonly OwnRun[],
  cardFor: (run: OwnRun) => PricingCard | null,
  zoneOf: (address: string | null) => string | null,
): PricedRun[] {
  return runs.map((run) => {
    const facts = runFacts(run, zoneOf);
    const jobs: PricedRun['jobs'] = {};
    for (const st of run.stops) {
      const job = stopJob(st);
      if (job) jobs[job] = (jobs[job] ?? 0) + 1;
    }
    const card = cardFor(run);
    /* perTrip: the fixed per-trip outstation fee is charged once, inside the
       card's min / cap / rounding, as on a 3PL trip. */
    const breakdown = card ? computeDeliveryCost(card.spec, facts, { perTrip: true }) : null;
    const otherJobsSen = breakdown ? breakdown.lines.filter((l) => OTHER_JOB_LINES.has(l.ruleType)).reduce((n, l) => n + l.amountSen, 0) : null;
    return {
      ...run,
      jobs,
      setCount: facts.setCount ?? 0,
      zones: (facts.destinationZones ?? []).filter((z): z is string => !!z),
      card: card ? { id: card.id, name: card.name } : null,
      costSen: breakdown ? breakdown.totalSen : null,
      otherJobsSen,
      breakdown,
    };
  });
}

/** Which own fleet card prices which lorry: a lorry's own card first, else the
 *  one card for the whole fleet. Two or more fleet cards active is a choice
 *  only the owner can make, so none of them prices and the page names them. */
export function ownFleetCardChoice<C extends { carrierLorryId: string | null }>(cards: readonly C[]): { fleet: C | null; several: C[]; byLorry: Map<string, C> } {
  const fleetCards = cards.filter((c) => !c.carrierLorryId);
  const byLorry = new Map<string, C>();
  for (const c of cards) if (c.carrierLorryId && !byLorry.has(c.carrierLorryId)) byLorry.set(c.carrierLorryId, c);
  return { fleet: fleetCards.length === 1 ? fleetCards[0]! : null, several: fleetCards.length > 1 ? fleetCards : [], byLorry };
}

/** A 3PL bill on a delivery order that ran in the window, for the comparison. */
export interface ThreePlDo {
  doId: string;
  runDate: string;
  setCount: number;
  billedSen: number;
  /** What the 3PLs' own cards say for it; null when one of them has no card. */
  expectedSen: number | null;
}

export interface OwnFleetMonth {
  month: string;
  trips: number;
  dos: number;
  sets: number;
  /** Trips a card priced, their DOs, their cost, and that cost less the other jobs. */
  pricedTrips: number;
  pricedDos: number;
  costSen: number;
  deliveryCostSen: number;
  threePlDos: number;
  threePlSets: number;
  threePlBilledSen: number;
  /** The 3PLs' own cards over the DOs they price. */
  threePlPricedDos: number;
  threePlBilledPricedSen: number;
  threePlCardSen: number;
}

/** Month by month (the day the lorry ran; the day the 3PL's DO ran), oldest first. */
export function ownFleetMonths(runs: readonly PricedRun[], threePl: readonly ThreePlDo[]): OwnFleetMonth[] {
  const by = new Map<string, OwnFleetMonth>();
  const monthOf = (ymd: string): OwnFleetMonth => {
    const month = ymd.slice(0, 7);
    let m = by.get(month);
    if (!m) {
      m = {
        month, trips: 0, dos: 0, sets: 0, pricedTrips: 0, pricedDos: 0, costSen: 0, deliveryCostSen: 0,
        threePlDos: 0, threePlSets: 0, threePlBilledSen: 0, threePlPricedDos: 0, threePlBilledPricedSen: 0, threePlCardSen: 0,
      };
      by.set(month, m);
    }
    return m;
  };
  for (const r of runs) {
    const m = monthOf(r.runDate);
    m.trips += 1;
    m.dos += r.dos.length;
    m.sets += r.setCount;
    if (r.costSen == null) continue;
    m.pricedTrips += 1;
    m.pricedDos += r.dos.length;
    m.costSen += r.costSen;
    m.deliveryCostSen += r.costSen - (r.otherJobsSen ?? 0);
  }
  for (const d of threePl) {
    const m = monthOf(d.runDate);
    m.threePlDos += 1;
    m.threePlSets += d.setCount;
    m.threePlBilledSen += d.billedSen;
    if (d.expectedSen == null) continue;
    m.threePlPricedDos += 1;
    m.threePlBilledPricedSen += d.billedSen;
    m.threePlCardSen += d.expectedSen;
  }
  return [...by.values()].sort((a, b) => a.month.localeCompare(b.month));
}
