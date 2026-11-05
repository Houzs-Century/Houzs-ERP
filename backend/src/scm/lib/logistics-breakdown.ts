// ----------------------------------------------------------------------------
// logistics-breakdown — the Logistics cost report's "By region & trip" and
// "Setup & Dismantle" for one month (owner 2026-11-05, demo approved). Pure:
// the route (scm/routes/acc-logistics-pnl.ts) reads, this decides;
// scm/lib/logistics-breakdown.test.ts pins it.
//
// BY REGION & TRIP — what delivery cost, so that its Total IS the Logistics
// P&L's TOTAL EXPENSE for the month (「logistics cost 一定要跟 P&L 一样」):
//   • OUR LORRIES carry the FULL in-house cost (petrol, upkeep, instalment, road
//     tax & insurance, manpower — the P&L's Total In-house Expenses) ÷ the
//     month's trips (one lorry, one day), each trip shared by its DOs, so a trip
//     into two regions splits by DO count. A month with in-house cost and no
//     trip keeps it on its own line, in the Total only.
//   • 3PL is the P&L's Outsource Expense — the ledger, by BILL month. An AP
//     invoice's outsource amount goes to its carrier, and to the regions of the
//     DOs its 3PL bill lines name (a line's amount shared by its DOs); what no
//     DO carries yet is "3PL bill lines on no DO yet", no region. A posting on
//     an outsource account with no 3PL bill read stays in its account's region.
// SETUP & DISMANTLE — each fair opened in the month, in its region: its sales
//   (Project Overview's), income = sales × the fair rate, and its cost from its
//   own books: the Logistics setup / dismantle charge, Setup, Dismantle, Transport.
// ----------------------------------------------------------------------------

import { REGIONS, delivererOf, share, type LogisticsDo, type LogisticsLorry, type RegionCode } from './logistics-cost';
import { coveredKinds, fairIncomeOf } from './logistics-pnl';

export type RegionSen = Record<RegionCode, number>;
const zero = (): RegionSen => ({ PG: 0, KL: 0, EM: 0, SG: 0 });
const sumOf = (r: RegionSen): number => r.PG + r.KL + r.EM + r.SG;

export type BreakdownTrip = { day: string; dos: number; doNumbers: string[]; sen: RegionSen };
export type LorryLine = { plate: string; trips: number; dos: number; sen: RegionSen; tripList: BreakdownTrip[] };
export type CarrierBill = { ref: string; day: string; sen: RegionSen; noDoSen: number };
export type CarrierLine = { name: string; bills: number; lines: number; dos: number; sen: RegionSen; billList: CarrierBill[] };

export type MonthCost = {
  month: string;
  dos: Record<RegionCode, number>;
  goodsSen: RegionSen;
  ownTrips: number;
  inHouseSen: number;
  lorries: LorryLine[];
  /** In-house cost of a month with no trip of ours: Total only. */
  inHouseNoTripSen: number;
  carriers: CarrierLine[];
  /** The 3PL bills' amount no DO carries yet: Total only. */
  threeplNoDo: { lines: number; sen: number };
  outsourceSen: number;
  /** DOs nobody took: no lorry picked and no 3PL charge. */
  noDeliverer: Record<RegionCode, number>;
};

/** One outsource leg of the month (P&L Outsource Expense), with what posted it. */
export type OutsourceLeg = { accountRegion: RegionCode; netSen: number; billNo: string | null; partyName: string | null };
/** An AP invoice the carrier sent, with its 3PL bill lines. */
export type ThreeplBill = {
  billNo: string; day: string; carrier: string | null; supplier: string | null;
  lines: Array<{ amountSen: number; assign: string | null; doIds: string[] }>;
};

/** Amounts scaled to a new total, whole sen, the remainder to the largest parts. */
export function scaleTo(parts: RegionSen, totalSen: number): RegionSen {
  const whole = sumOf(parts);
  if (whole === 0) return zero();
  const out = zero();
  const rest: Array<[RegionCode, number]> = [];
  let given = 0;
  for (const r of REGIONS) {
    const exact = (parts[r.code] * totalSen) / whole;
    out[r.code] = Math.trunc(exact);
    given += out[r.code];
    rest.push([r.code, Math.abs(exact - out[r.code])]);
  }
  rest.sort((a, b) => b[1] - a[1]);
  let left = totalSen - given;
  for (let i = 0; left !== 0; i = (i + 1) % rest.length) { const step = Math.sign(left); out[rest[i]![0]] += step; left -= step; }
  return out;
}

export function buildMonthCost(input: {
  month: string;
  /** The month's DOs (by delivery day). */
  dos: readonly LogisticsDo[];
  regionOf: ReadonlyMap<string, RegionCode>;
  lorries: readonly LogisticsLorry[];
  /** DOs a 3PL charge names. */
  charged: ReadonlySet<string>;
  /** The P&L's Total In-house Expenses for the month. */
  inHouseSen: number;
  legs: readonly OutsourceLeg[];
  bills: ReadonlyMap<string, ThreeplBill>;
}): MonthCost {
  const { regionOf } = input;
  const dos: Record<RegionCode, number> = { PG: 0, KL: 0, EM: 0, SG: 0 };
  const goodsSen = zero();
  const noDeliverer: Record<RegionCode, number> = { PG: 0, KL: 0, EM: 0, SG: 0 };

  /* Our trips: one lorry, one day. */
  const trips = new Map<string, { plate: string; day: string; dos: LogisticsDo[] }>();
  for (const d of input.dos) {
    const r = regionOf.get(d.id) ?? 'KL';
    dos[r] += 1;
    goodsSen[r] += d.valueSen;
    const w = delivererOf(d, input.lorries);
    if (w.kind === 'own') {
      const k = `${w.plate}|${d.day}`;
      const t = trips.get(k);
      if (t) t.dos.push(d); else trips.set(k, { plate: w.plate, day: d.day, dos: [d] });
    } else if ((w.kind === 'none' || w.kind === 'unlisted') && !input.charged.has(d.id)) noDeliverer[r] += 1;
  }
  const tripList = [...trips.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, t]) => t);
  const tripSen = share(input.inHouseSen, tripList.length);
  const byPlate = new Map<string, LorryLine>();
  tripList.forEach((t, i) => {
    const sen = zero();
    const its = [...t.dos].sort((a, b) => a.doNumber.localeCompare(b.doNumber));
    share(tripSen[i]!, its.length).forEach((x, j) => { sen[regionOf.get(its[j]!.id) ?? 'KL'] += x; });
    const line = byPlate.get(t.plate) ?? { plate: t.plate, trips: 0, dos: 0, sen: zero(), tripList: [] };
    line.trips += 1;
    line.dos += its.length;
    for (const r of REGIONS) line.sen[r.code] += sen[r.code];
    line.tripList.push({ day: t.day, dos: its.length, doNumbers: its.map((d) => d.doNumber), sen });
    byPlate.set(t.plate, line);
  });
  const lorries = [...byPlate.values()].sort((a, b) => a.plate.localeCompare(b.plate));
  for (const l of lorries) l.tripList.sort((a, b) => a.day.localeCompare(b.day));

  /* 3PL: the ledger's outsource, one bill at a time. */
  const byBill = new Map<string, OutsourceLeg[]>();
  const loose: OutsourceLeg[] = [];
  for (const l of input.legs) {
    if (l.billNo && input.bills.has(l.billNo) && input.bills.get(l.billNo)!.lines.length > 0) {
      const list = byBill.get(l.billNo) ?? [];
      list.push(l);
      byBill.set(l.billNo, list);
    } else loose.push(l);
  }
  const carriers = new Map<string, CarrierLine & { doSet: Set<string> }>();
  const carrierOf = (name: string) => {
    const c = carriers.get(name) ?? { name, bills: 0, lines: 0, dos: 0, sen: zero(), billList: [], doSet: new Set<string>() };
    carriers.set(name, c);
    return c;
  };
  const noDo = { lines: 0, sen: 0 };
  for (const [billNo, legs] of [...byBill.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const bill = input.bills.get(billNo)!;
    const amount = legs.reduce((s, l) => s + l.netSen, 0);
    const parts = zero();
    const c = carrierOf(bill.carrier || bill.supplier || '3PL');
    let unassigned = 0;
    for (const line of bill.lines) {
      if (line.assign === 'event') continue;
      if (line.assign !== 'do' || line.doIds.length === 0) { if (line.amountSen !== 0) unassigned += 1; continue; }
      c.lines += 1;
      share(line.amountSen, line.doIds.length).forEach((x, j) => {
        const id = line.doIds[j]!;
        const r = regionOf.get(id);
        if (r) { parts[r] += x; c.doSet.add(id); }
      });
    }
    const placed = sumOf(parts) > amount ? scaleTo(parts, amount) : parts;
    const left = amount - sumOf(placed);
    for (const r of REGIONS) c.sen[r.code] += placed[r.code];
    c.bills += 1;
    c.billList.push({ ref: billNo, day: bill.day, sen: placed, noDoSen: left });
    if (left !== 0) { noDo.sen += left; noDo.lines += Math.max(unassigned, 1); }
  }
  for (const l of loose) {
    const c = carrierOf(l.billNo && input.bills.get(l.billNo)?.supplier ? input.bills.get(l.billNo)!.supplier! : l.partyName || 'Other outsource postings');
    c.sen[l.accountRegion] += l.netSen;
    if (l.billNo && !c.billList.some((b) => b.ref === l.billNo)) { c.bills += 1; c.billList.push({ ref: l.billNo, day: input.bills.get(l.billNo)?.day ?? '', sen: zero(), noDoSen: 0 }); }
    const b = c.billList.find((x) => x.ref === (l.billNo ?? ''));
    if (b) b.sen[l.accountRegion] += l.netSen;
  }
  const carrierLines: CarrierLine[] = [...carriers.values()]
    .map(({ doSet, ...c }) => ({ ...c, dos: doSet.size }))
    .filter((c) => sumOf(c.sen) !== 0 || c.billList.some((b) => b.noDoSen !== 0))
    .sort((a, b) => sumOf(b.sen) - sumOf(a.sen) || a.name.localeCompare(b.name));

  return {
    month: input.month, dos, goodsSen,
    ownTrips: tripList.length, inHouseSen: input.inHouseSen,
    lorries, inHouseNoTripSen: tripList.length === 0 ? input.inHouseSen : 0,
    carriers: carrierLines, threeplNoDo: noDo,
    outsourceSen: input.legs.reduce((s, l) => s + l.netSen, 0),
    noDeliverer,
  };
}

/** Delivery cost by construction: lorries + the no-trip cost + carriers + no DO yet. */
export const monthCostTotal = (m: MonthCost): number =>
  m.lorries.reduce((s, l) => s + sumOf(l.sen), 0) + m.inHouseNoTripSen
  + m.carriers.reduce((s, c) => s + sumOf(c.sen), 0) + m.threeplNoDo.sen;

/* ── Setup & Dismantle ───────────────────────────────────────────────────── */
export type FairLineIn = { kind?: string | null; category?: string | null; amount?: number | null; auto_source?: string | null; source?: string | null; description?: string | null; doc_no?: string | null };
export type FairBlock = {
  id: number; code: string | null; name: string; venue: string | null; startDate: string | null; endDate: string | null;
  region: RegionCode; salesSen: number; incomeSen: number;
  /** The Logistics setup / dismantle charge: its trips and amount. */
  chargeTrips: number; chargeSen: number;
  setupSen: number; dismantleSen: number; transportSen: number;
  /** The fair's own books: Project Overview's Setup + Transport Setup & Dismantle rows. */
  booksSen: number;
  who: 'inhouse' | '3pl';
};

const toSen = (rm: number | null | undefined): number => Math.round(Number(rm ?? 0) * 100);

/** One fair's Setup & Dismantle from the lines its P&L summed. The charge is the
    books' Logistics lines (event-books chargeLegs); a Transport Setup & Dismantle
    line worded only as a dismantle is Dismantle, the rest Transport. */
export function fairBlock(input: {
  fair: { id: number; code: string | null; name: string; venue: string | null; startDate: string | null; endDate: string | null; region: RegionCode };
  salesRm: number; fairIncomeBp: number;
  lines: readonly FairLineIn[];
  books: { setupRm: number; transportSetupDismantleRm: number };
  chargeDocNo: string;
}): FairBlock {
  let chargeSen = 0; let chargeTrips = 0; let setupSen = 0; let dismantleSen = 0; let transportSen = 0;
  for (const l of input.lines) {
    if (l.kind !== 'cost' || l.auto_source) continue;
    const sen = toSen(l.amount);
    if (l.category === 'setup') setupSen += sen;
    else if (l.category === 'transport_setup_dismantle') {
      if (l.source === 'books' && l.doc_no === input.chargeDocNo) { chargeSen += sen; chargeTrips += 1; }
      else {
        const k = coveredKinds(null, l.description);
        if (k.length === 1 && k[0] === 'dismantle') dismantleSen += sen; else transportSen += sen;
      }
    }
  }
  const salesSen = toSen(input.salesRm);
  return {
    ...input.fair, salesSen, incomeSen: fairIncomeOf(salesSen, input.fairIncomeBp),
    chargeTrips, chargeSen, setupSen, dismantleSen, transportSen,
    booksSen: toSen(input.books.setupRm) + toSen(input.books.transportSetupDismantleRm),
    who: dismantleSen + transportSen !== 0 ? '3pl' : 'inhouse',
  };
}
