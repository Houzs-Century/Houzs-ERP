// ---------------------------------------------------------------------------
// delivery-rate-card.ts — PURE delivery-cost calculator. Fleet Module C.
//
// computeDeliveryCost(card, facts) turns a carrier's configured rate card + a
// drop/trip's delivery facts into an ITEMISED cost breakdown. PURE and
// unit-tested — no DB, no clock, no I/O — so a card's arithmetic is deterministic
// and defensible against a 3PL's invoice.
//
// The rule dimensions are the owner's exact ones (see migration 0207):
//   - POSITIONAL_TIER  price of the 1st / 2nd / 3rd+ charging unit (set or item)
//   - OVERAGE          a cap N per drop; each unit beyond N is a flat surcharge
//                      (it CAPS the tier ladder — beyond-cap units price at the
//                      overage rate, not the top tier)
//   - SOFA_BRACKET     a sofa priced by its compartment count band (one bracket
//                      per sofa; additive across sofas)
//   - OUTSTATION       a destination-zone surcharge (reuse the A1 classifier for
//                      the zone)
//   - DISPOSE / SETUP / DISMANTLE  occurrence charges (rate x count)
//   - SERVICE / PICKUP / INSPECTION / TRANSFER  the owner's order-type charges,
//      own rate each (rate x count)
//   - DO_CHARGE        a named charge on each delivery order: an amount per DO
//                      and/or a share of the DOs' goods value (the Singapore
//                      carriers' SST and cost shares of the goods, a permit)
// plus the card-level min-charge / cap / rounding envelope.
//
// SEPARATION OF CONCERNS. The charging units the positional tiers count over
// (setCount / itemCount) EXCLUDE sofas — a sofa is priced only by its compartment
// bracket, exactly as the owner's worked example prices "1st set + 2nd set + sofa
// 3-comp" (the sofa is not a third set). The caller derives the facts; this
// module only prices them.
//
// AREAS (mig 20261111T1000; owner 2026-11-11 on the 3PL quotations: 做). A
// carrier prices each area with its own ladder — "RM X the first 2 sets, RM Y
// each item after, sofa RM Z" for each group of towns — not the city ladder plus
// one surcharge. A card may carry areas (a name and its towns); a
// rule may name one. A delivery in an area prices each rule type the area
// carries with the area's rules and every other type with the card's own, so a
// card with no area prices exactly as before. Town surcharges (OUTSTATION,
// OUTSTATION_TRIP) stay the card's own and add on top, as Labuan's customs fee does.
//
// PLACES (mig 20261111T1100; owner 2026-11-11: the 3PL areas aligned with the
// Delivery Zones maintenance, 做). Given the addresses a drop reaches (stops,
// each with its zone from the postcode) and the company's places (a town and
// the zone it lies in), a name a card prices is read per address: a zone name
// covers its whole zone by postcode, spelled in the address or not; a place
// counts only inside its own zone, so a Kuala Lumpur street called Jalan Ipoh
// is not Ipoh. Without stops the calculator reads destinationZone(s) and the
// address text exactly as before.
// ---------------------------------------------------------------------------

import { ZONE_SET } from './zone-classify';
import { OUTSTATION_DEFAULT_APPLIES_TO } from './rate-rule-taxonomy';

/** A place under a delivery zone: the town a card may price and the zone its
 *  postcodes fall in (null = in no zone, e.g. abroad). */
export interface PlaceSpec {
  name: string;
  zone: string | null;
}

/** One address a drop or trip reaches: its zone from the postcode (null when
 *  the postcode is missing or no zone rule covers it) and its text. */
export interface DeliveryStop {
  zone: string | null;
  addressText: string | null;
  jobType?: string | null;
}

/** The card-level dimensions the calculator needs (a subset of the stored card). */
export interface RateCardSpec {
  basis: 'ITEM' | 'SET';
  /**
   * WHAT THE TIER LADDER COUNTS (mig 0244). Owner, 2026-08-02, describing all
   * three modes as "how much per X":
   *
   *   UNIT     — sets or items, per `basis`. The only behaviour this
   *              calculator ever had; it simply had no name, so every card
   *              said DROP or CUSTOMER while the code counted sets regardless.
   *   DROP     — delivery orders. "一张 DO 多少钱" — five drops at RM100 is
   *              RM500, whatever each drop contains.
   *   CUSTOMER — distinct (customer + address) that day. The second drop to the
   *              same doorstep continues down the ladder instead of restarting
   *              at the first-item price.
   *   TRIP     — 1. "我 assign 给你一个 trip 就是多少钱" — one trip is one
   *              charging unit, so tier 1 is the flat trip price.
   */
  aggregation?: AggregationUnit;
  minChargeSen?: number | null;
  capSen?: number | null;
  rounding?: 'NONE' | 'NEAREST_10C' | 'NEAREST_RM' | null;
  rules: readonly RateRuleSpec[];
  areas?: readonly RateAreaSpec[];
  places?: readonly PlaceSpec[];
}

/** One priced area of a card: the towns it covers, each matched as a whole word
 *  in the delivery address, as a town OUTSTATION rule is. */
export interface RateAreaSpec {
  id: string;
  name: string;
  towns: readonly string[];
}

export type RateRuleType =
  | 'POSITIONAL_TIER'
  | 'OVERAGE'
  | 'SOFA_BRACKET'
  | 'OUTSTATION'
  | 'OUTSTATION_TRIP'
  | 'DISPOSE'
  | 'SETUP'
  | 'DISMANTLE'
  | 'SERVICE'
  | 'PICKUP'
  | 'INSPECTION'
  | 'SUPPLIER_PICKUP'
  | 'TRANSFER'
  | 'DO_CHARGE';

export interface RateRuleSpec {
  ruleType: RateRuleType;
  tierPosition?: number | null;
  bracketMin?: number | null;
  bracketMax?: number | null;
  zone?: string | null;
  areaId?: string | null;
  appliesTo?: readonly string[] | null;
  amountSen: number;
  bps?: number | null;
  label?: string | null;
}

/** A drop/trip's delivery facts. The caller derives these; the tiers count over
 *  setCount (basis SET) or itemCount (basis ITEM), which EXCLUDE sofas. */
export interface DeliveryFacts {
  setCount?: number | null;
  itemCount?: number | null;
  sofaCompartments?: readonly number[] | null;
  dropCount?: number | null;
  customerCount?: number | null;
  destinationZone?: string | null;
  /**
   * EVERY zone this trip touches, when it touches more than one.
   *
   * Owner, 2026-08-02: "如果是多区行程的话，不是按每个 drop 算，它一定是以最远的
   * 地方来看... 柔佛 500、马六甲 300，那我肯定是算柔佛 500，不可能再算近的，只是算
   * 一次而已". One surcharge, for the FARTHEST place.
   *
   * When given, it wins over destinationZone. When absent, destinationZone is
   * used unchanged — the single-drop case is unaffected.
   */
  destinationZones?: readonly (string | null | undefined)[] | null;
  addressText?: string | null;
  areaId?: string | null;
  stops?: readonly DeliveryStop[] | null;
  jobType?: string | null;
  goodsValueSen?: number | null;
  disposeCount?: number | null;
  setupCount?: number | null;
  dismantleCount?: number | null;
  serviceCount?: number | null;
  pickupCount?: number | null;
  inspectionCount?: number | null;
  supplierPickupCount?: number | null;
  transferCount?: number | null;
}

export interface CostLine {
  ruleType: RateRuleType | 'MIN_CHARGE' | 'CAP' | 'ROUNDING';
  label: string;
  amountSen: number;
  detail?: Record<string, unknown>;
}

export interface CostBreakdown {
  totalSen: number;
  subtotalSen: number;
  lines: CostLine[];
  area?: { id: string; name: string } | null;
}

function intOf(v: number | null | undefined): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function tierAmountForPosition(tiers: readonly RateRuleSpec[], n: number): RateRuleSpec | null {
  let best: RateRuleSpec | null = null;
  for (const t of tiers) {
    const pos = intOf(t.tierPosition);
    if (pos >= 1 && pos <= n && (best === null || pos > intOf(best.tierPosition))) best = t;
  }
  return best;
}

/**
 * What the tier ladder counts. Mig 0244; see RateCardSpec.aggregation.
 *
 * Unknown / absent falls back to UNIT — the computation this file has always
 * done — so a card written before 0244, or one carrying a value a later
 * migration adds, prices the way it did rather than silently becoming free.
 */
export type AggregationUnit = 'UNIT' | 'DROP' | 'CUSTOMER' | 'TRIP';
export const AGGREGATION_UNITS: ReadonlySet<string> = new Set(['UNIT', 'DROP', 'CUSTOMER', 'TRIP']);

export function chargingUnitCount(
  card: Pick<RateCardSpec, 'basis' | 'aggregation'>,
  facts: DeliveryFacts,
): number {
  switch (card.aggregation) {
    case 'TRIP':
      return 1;
    case 'DROP':
      return intOf(facts.dropCount);
    case 'CUSTOMER':
      return intOf(facts.customerCount) || intOf(facts.dropCount);
    default:
      return card.basis === 'ITEM' ? intOf(facts.itemCount) : intOf(facts.setCount);
  }
}

export function chargingUnitLabel(card: Pick<RateCardSpec, 'basis' | 'aggregation'>): string {
  switch (card.aggregation) {
    case 'TRIP': return 'trip';
    case 'DROP': return 'drop';
    case 'CUSTOMER': return 'customer';
    default: return card.basis === 'ITEM' ? 'item' : 'set';
  }
}

/**
 * Which of a trip's zones to charge for. PURE.
 *
 * Owner's rule, 2026-08-02: a multi-zone trip is charged ONCE, for the
 * FARTHEST place — "柔佛 500、马六甲 300，那我肯定是算柔佛 500，不可能再算近的".
 *
 * DISTANCE IS NOT IN THIS SYSTEM. Zones are labels; nothing stores how far
 * away one is. So "farthest" is read off the only ordering the data actually
 * carries: the SURCHARGE ITSELF. The zone this card charges most for is the one
 * it considers farthest, which reproduces the owner's example exactly and needs
 * no table nobody maintains.
 *
 * KNOWN LIMIT, stated rather than hidden: if a NEARER zone were ever priced
 * higher than a farther one, this picks the nearer. Fixing that properly means
 * storing a distance or an explicit ordering per zone — worth doing only if
 * that case turns out to be real.
 *
 * A zone with no rule on this card contributes nothing, so an in-town drop on a
 * multi-zone trip cannot win by accident.
 */
export function farthestZone(
  rules: readonly RateRuleSpec[],
  ruleType: 'OUTSTATION' | 'OUTSTATION_TRIP',
  facts: Pick<DeliveryFacts, 'destinationZone' | 'destinationZones' | 'addressText' | 'stops' | 'jobType'>,
  places?: readonly PlaceSpec[],
): string | null {
  if (facts.stops && facts.stops.length > 0) {
    const homes = placeZones(places);
    let found: { zone: string; amount: number } | null = null;
    for (const r of rules) {
      const z = String(r.zone ?? '').trim().toUpperCase();
      if (r.ruleType !== ruleType || !z) continue;
      if (!facts.stops.some((s) => outstationApplies(r, s.jobType) && reaches(z, s, homes))) continue;
      const amount = intOf(r.amountSen);
      if (!found || amount > found.amount) found = { zone: z, amount };
    }
    return found ? found.zone : null;
  }
  const candidates = [
    ...((facts.destinationZones && facts.destinationZones.length > 0)
      ? facts.destinationZones
      : [facts.destinationZone]),
    ...townsInAddress(rules, ruleType, facts.addressText),
  ];

  let best: { zone: string; amount: number } | null = null;
  for (const raw of candidates) {
    const z = String(raw ?? '').trim().toUpperCase();
    if (!z) continue;
    const rule = rules.find((r) => r.ruleType === ruleType && String(r.zone ?? '').toUpperCase() === z && outstationApplies(r, facts.jobType));
    const amount = rule ? intOf(rule.amountSen) : 0;
    if (!best || amount > best.amount) best = { zone: z, amount };
  }
  return best ? best.zone : null;
}

/** Rule zones (towns) that appear as a whole word in the address. A postcode
 *  zone name that happens to appear (MELAKA in "Jalan Melaka") just adds a
 *  candidate that farthestZone already weighs — the highest charge still wins. */
export function townsInAddress(
  rules: readonly RateRuleSpec[],
  ruleType: 'OUTSTATION' | 'OUTSTATION_TRIP',
  addressText: string | null | undefined,
): string[] {
  const text = ` ${String(addressText ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ')} `;
  if (!text.trim()) return [];
  return rules
    .filter((r) => r.ruleType === ruleType && r.zone)
    .map((r) => String(r.zone).toUpperCase())
    .filter((zone) => {
      const town = zone.replace(/[^A-Z0-9]+/g, ' ').trim();
      return town && text.includes(` ${town} `);
    });
}

const jobOf = (j: string | null | undefined): string => (j ? String(j).trim().toUpperCase() : 'DELIVERY');

/** Whether an outstation rule adds to this job: the jobs it names, or the
 *  default (delivery orders) when it names none. PURE. */
export function outstationApplies(rule: Pick<RateRuleSpec, 'appliesTo'>, jobType: string | null | undefined): boolean {
  const list: readonly string[] = rule.appliesTo && rule.appliesTo.length > 0
    ? rule.appliesTo.map((t) => String(t).trim().toUpperCase())
    : OUTSTATION_DEFAULT_APPLIES_TO;
  return list.includes(jobOf(jobType));
}

const asWords = (v: unknown): string => ` ${String(v ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()} `;

function placeZones(places: readonly PlaceSpec[] | undefined): ReadonlyMap<string, string | null> {
  return new Map((places ?? []).map((p) => [p.name.trim().toUpperCase(), p.zone ? p.zone.trim().toUpperCase() : null]));
}

/**
 * Whether a name a card prices (a zone or a town) is reached by this address.
 * PURE. A zone name: the address's postcode zone is that zone (its words only
 * when the postcode tells no zone). A place: spelled in the address, and the
 * address is in the place's zone (or either zone is unknown). A town not yet a
 * place: spelled anywhere, as before places.
 */
export function reaches(name: string, stop: DeliveryStop, homes: ReadonlyMap<string, string | null>): boolean {
  const n = name.trim().toUpperCase();
  if (!n) return false;
  const spelled = asWords(stop.addressText).includes(asWords(n));
  const zone = stop.zone ? stop.zone.trim().toUpperCase() : null;
  if (ZONE_SET.has(n)) return zone ? zone === n : spelled;
  if (!homes.has(n)) return spelled;
  const home = homes.get(n) ?? null;
  return spelled && (home === null || zone === null || zone === home);
}

/**
 * The area a delivery is priced in, or null. PURE.
 *
 * Named by the caller (facts.areaId) when it knows it. Otherwise the area one of
 * whose towns appears as a whole word in the delivery address. When the address
 * names towns of two areas — a trip's several addresses — the area whose first
 * charging unit costs most: as farthestZone reads "farthest" off a surcharge,
 * the dearest area is the farthest one, priced once. Given stops, each town of
 * an area is read per address against the places (see PLACES).
 */
export function areaOf(
  card: Pick<RateCardSpec, 'areas' | 'rules' | 'places'>,
  facts: Pick<DeliveryFacts, 'areaId' | 'addressText' | 'stops'>,
): RateAreaSpec | null {
  const areas = card.areas ?? [];
  if (areas.length === 0) return null;
  if (facts.areaId) return areas.find((a) => a.id === facts.areaId) ?? null;
  const stops = (facts.stops ?? []).filter((s) => jobOf(s.jobType) === 'DELIVERY');
  const homes = placeZones(card.places);
  const text = asWords(facts.addressText);
  const inArea = (a: RateAreaSpec): boolean => (stops.length > 0
    ? a.towns.some((t) => stops.some((s) => reaches(t, s, homes)))
    : a.towns.some((t) => asWords(t).trim() !== '' && text.includes(asWords(t))));
  if (stops.length === 0 && !text.trim()) return null;
  let best: RateAreaSpec | null = null;
  let bestSen = -1;
  for (const a of areas) {
    if (!inArea(a)) continue;
    const first = (card.rules ?? [])
      .filter((r) => r.areaId === a.id && r.ruleType === 'POSITIONAL_TIER')
      .sort((x, y) => intOf(x.tierPosition) - intOf(y.tierPosition))[0];
    const sen = first ? intOf(first.amountSen) : 0;
    if (sen > bestSen) { best = a; bestSen = sen; }
  }
  return best;
}

/** How the caller is pricing: one DROP, or a whole TRIP. */
export interface CostOptions {
  perTrip?: boolean;
}

/**
 * Price a drop/trip against a rate card. PURE.
 *
 * Order of the itemised lines: charging-unit tiers (+ overage) → sofa brackets →
 * outstation → dispose → setup → dismantle → service/pickup/inspection/transfer
 * → the per-trip outstation fee when pricing a trip, then the min/cap/rounding
 * envelope. The returned `subtotalSen` is the sum of the priced lines before
 * the envelope; `totalSen` is after it.
 */
export function computeDeliveryCost(card: RateCardSpec, facts: DeliveryFacts, opts: CostOptions = {}): CostBreakdown {
  const lines: CostLine[] = [];
  const rules = (card.rules ?? []).filter((r) => r.areaId == null);
  const area = areaOf(card, facts);
  const inArea = area ? (card.rules ?? []).filter((r) => r.areaId === area.id) : [];

  const rulesOf = (t: RateRuleType) => {
    const mine = inArea.filter((r) => r.ruleType === t);
    return mine.length > 0 ? mine : rules.filter((r) => r.ruleType === t);
  };
  const at = (r: RateRuleSpec): string => (area && r.areaId === area.id ? ` · ${area.name}` : '');

  const unitCount = chargingUnitCount(card, facts);
  const tiers = rulesOf('POSITIONAL_TIER');
  const overage = rulesOf('OVERAGE')[0] ?? null;
  const cap = overage ? intOf(overage.tierPosition) : null;
  const unitLabel = chargingUnitLabel(card);
  const ordinal = (n: number) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);
  for (let n = 1; n <= unitCount; n++) {
    if (cap !== null && n > cap) {
      lines.push({
        ruleType: 'OVERAGE',
        label: `Overage ${ordinal(n)} ${unitLabel} (beyond cap ${cap})${at(overage!)}`,
        amountSen: intOf(overage!.amountSen),
        detail: { position: n, cap },
      });
      continue;
    }
    const tier = tierAmountForPosition(tiers, n);
    if (tier) {
      lines.push({
        ruleType: 'POSITIONAL_TIER',
        label: `${ordinal(n)} ${unitLabel}${at(tier)}`,
        amountSen: intOf(tier.amountSen),
        detail: { position: n, tierPosition: intOf(tier.tierPosition) },
      });
    }
  }

  const sofaBrackets = rulesOf('SOFA_BRACKET');
  for (const comp of facts.sofaCompartments ?? []) {
    const c = intOf(comp);
    if (c <= 0) continue;
    const bracket = sofaBrackets.find((b) => {
      const lo = intOf(b.bracketMin);
      const hi = b.bracketMax === null || b.bracketMax === undefined ? Infinity : intOf(b.bracketMax);
      return c >= lo && c <= hi;
    });
    if (bracket) {
      const hi = bracket.bracketMax === null || bracket.bracketMax === undefined ? '+' : `-${intOf(bracket.bracketMax)}`;
      lines.push({
        ruleType: 'SOFA_BRACKET',
        label: `Sofa ${c}-compartment (${intOf(bracket.bracketMin)}${hi} band)${at(bracket)}`,
        amountSen: intOf(bracket.amountSen),
        detail: { compartments: c, bracketMin: intOf(bracket.bracketMin), bracketMax: bracket.bracketMax ?? null },
      });
    }
  }

  const homes = placeZones(card.places);
  const appliesHere = (r: RateRuleSpec): boolean => (facts.stops && facts.stops.length > 0
    ? facts.stops.some((st) => outstationApplies(r, st.jobType) && reaches(String(r.zone ?? ''), st, homes))
    : outstationApplies(r, facts.jobType));
  const surcharges = rules.filter((r) => (r.ruleType !== 'OUTSTATION' && r.ruleType !== 'OUTSTATION_TRIP') || appliesHere(r));
  const farZone = farthestZone(surcharges, 'OUTSTATION', facts, card.places);
  if (farZone) {
    const os = rulesOf('OUTSTATION').find((r) => String(r.zone ?? '').toUpperCase() === farZone && surcharges.includes(r));
    if (os) {
      lines.push({
        ruleType: 'OUTSTATION',
        label: `Outstation ${farZone}`,
        amountSen: intOf(os.amountSen),
        detail: { zone: farZone, ...(facts.destinationZones ? { pickedFrom: [...facts.destinationZones] } : {}) },
      });
    }
  }

  const occurrence: Array<[RateRuleType, number, string]> = [
    ['DISPOSE', intOf(facts.disposeCount), 'Dispose'],
    ['SETUP', intOf(facts.setupCount), 'Setup'],
    ['DISMANTLE', intOf(facts.dismantleCount), 'Dismantle'],
    ['SERVICE', intOf(facts.serviceCount), 'Service'],
    ['PICKUP', intOf(facts.pickupCount), 'Pickup'],
    ['INSPECTION', intOf(facts.inspectionCount), 'Inspection'],
    ['SUPPLIER_PICKUP', intOf(facts.supplierPickupCount), 'Supplier pickup'],
    ['TRANSFER', intOf(facts.transferCount), 'Transfer'],
  ];
  for (const [type, count, label] of occurrence) {
    if (count <= 0) continue;
    const rule = rulesOf(type)[0];
    if (!rule) continue;
    const each = intOf(rule.amountSen);
    lines.push({
      ruleType: type,
      label: `${count > 1 ? `${label} x${count}` : label}${at(rule)}`,
      amountSen: each * count,
      detail: { count, eachSen: each },
    });
  }

  // ── Named charges on each delivery order (DO_CHARGE) ─────────────────────
  // Owner 2026-11-24, the Singapore carriers: 「based on good」 — shares of the
  // goods value, plus a fixed charge per order (a permit).
  // The amount is per DO on the trip; the share is of all their goods.
  const doCount = intOf(facts.dropCount);
  const goodsSen = intOf(facts.goodsValueSen);
  for (const rule of rulesOf('DO_CHARGE')) {
    const each = intOf(rule.amountSen);
    const bps = intOf(rule.bps);
    const amountSen = each * doCount + Math.round((goodsSen * bps) / 10_000);
    if (amountSen <= 0) continue;
    const name = String(rule.label ?? '').trim() || 'Per DO charge';
    const share = bps > 0 ? ` ${bps / 100}% of goods` : '';
    lines.push({
      ruleType: 'DO_CHARGE',
      label: `${name}${share}${each > 0 && doCount > 1 ? ` x${doCount}` : ''}${at(rule)}`,
      amountSen,
      detail: { bps, goodsValueSen: goodsSen, eachSen: each, count: doCount },
    });
  }

  if (opts.perTrip) {
    const tripZone = farthestZone(surcharges, 'OUTSTATION_TRIP', facts, card.places);
    const tripFee = tripOutstationFeeSen(surcharges, tripZone);
    if (tripFee > 0) {
      lines.push({
        ruleType: 'OUTSTATION_TRIP',
        label: `Outstation trip ${String(tripZone).toUpperCase()}`,
        amountSen: tripFee,
        detail: { zone: tripZone, perTrip: true },
      });
    }
  }

  const subtotalSen = lines.reduce((s, l) => s + l.amountSen, 0);
  let total = subtotalSen;

  const minCharge = card.minChargeSen != null ? intOf(card.minChargeSen) : null;
  if (minCharge != null && total < minCharge) {
    lines.push({ ruleType: 'MIN_CHARGE', label: `Minimum charge`, amountSen: minCharge - total, detail: { minChargeSen: minCharge } });
    total = minCharge;
  }

  const capSen = card.capSen != null ? intOf(card.capSen) : null;
  if (capSen != null && total > capSen) {
    lines.push({ ruleType: 'CAP', label: `Charge cap`, amountSen: capSen - total, detail: { capSen } });
    total = capSen;
  }

  const rounding = card.rounding ?? 'NONE';
  if (rounding !== 'NONE' && total > 0) {
    const step = rounding === 'NEAREST_RM' ? 100 : 10;
    let rounded = Math.round(total / step) * step;
    if (capSen != null && rounded > capSen) rounded = Math.floor(total / step) * step;
    if (rounded !== total) {
      lines.push({ ruleType: 'ROUNDING', label: `Rounding (${rounding === 'NEAREST_RM' ? 'nearest RM' : 'nearest 10 sen'})`, amountSen: rounded - total, detail: { rounding } });
      total = rounded;
    }
  }

  return { totalSen: total, subtotalSen, lines, area: area ? { id: area.id, name: area.name } : null };
}

export function tripOutstationFeeSen(
  rules: readonly RateRuleSpec[],
  destinationZone: string | null | undefined,
): number {
  if (!destinationZone) return 0;
  const z = String(destinationZone).toUpperCase();
  const r = rules.find((x) => x.ruleType === 'OUTSTATION_TRIP' && String(x.zone ?? '').toUpperCase() === z);
  if (!r) return 0;
  const amt = Math.round(Number(r.amountSen) || 0);
  return amt > 0 ? amt : 0;
}
