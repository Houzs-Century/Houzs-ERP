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
// plus the card-level min-charge / cap / rounding envelope.
//
// SEPARATION OF CONCERNS. The charging units the positional tiers count over
// (setCount / itemCount) EXCLUDE sofas — a sofa is priced only by its compartment
// bracket, exactly as the owner's worked example prices "1st set + 2nd set + sofa
// 3-comp" (the sofa is not a third set). The caller derives the facts; this
// module only prices them.
// ---------------------------------------------------------------------------

/** The card-level dimensions the calculator needs (a subset of the stored card). */
export interface RateCardSpec {
  /** Price by ITEM or by SET (set = frame + mattress). Selects which fact the
   *  positional tiers count over. */
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
  /** Optional envelope applied to the summed cost. */
  minChargeSen?: number | null;
  capSen?: number | null;
  rounding?: 'NONE' | 'NEAREST_10C' | 'NEAREST_RM' | null;
  rules: readonly RateRuleSpec[];
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
  | 'TRANSFER';

export interface RateRuleSpec {
  ruleType: RateRuleType;
  /** POSITIONAL_TIER: the 1-based position (3 = "3rd and beyond"). OVERAGE: the
   *  cap N (max units/drop before the overage rate kicks in). */
  tierPosition?: number | null;
  /** SOFA_BRACKET: compartment band [min, max]; max null = open-ended "min+". */
  bracketMin?: number | null;
  bracketMax?: number | null;
  /** OUTSTATION: destination area zone this surcharge applies to. */
  zone?: string | null;
  /** The price, integer sen. */
  amountSen: number;
}

/** A drop/trip's delivery facts. The caller derives these; the tiers count over
 *  setCount (basis SET) or itemCount (basis ITEM), which EXCLUDE sofas. */
export interface DeliveryFacts {
  /** Charging units when basis === 'SET' (sofas excluded — priced by bracket). */
  setCount?: number | null;
  /** Charging units when basis === 'ITEM' (sofas excluded — priced by bracket). */
  itemCount?: number | null;
  /** One entry per sofa: its compartment count. Each maps to one SOFA_BRACKET. */
  sofaCompartments?: readonly number[] | null;
  /** Delivery orders on this trip. Read when aggregation is DROP. */
  dropCount?: number | null;
  /** Distinct (customer + address) on this trip. Read when aggregation is
   *  CUSTOMER — two drops to one doorstep are ONE customer, which is the whole
   *  point of that mode. */
  customerCount?: number | null;
  /** Destination area zone (from the A1 classifier) for the outstation surcharge. */
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
  disposeCount?: number | null;
  setupCount?: number | null;
  dismantleCount?: number | null;
  serviceCount?: number | null;
  pickupCount?: number | null;
  inspectionCount?: number | null;
  transferCount?: number | null;
}

export interface CostLine {
  ruleType: RateRuleType | 'MIN_CHARGE' | 'CAP' | 'ROUNDING';
  label: string;
  amountSen: number;
  /** Optional structured detail (unit index, zone, compartment band, count). */
  detail?: Record<string, unknown>;
}

export interface CostBreakdown {
  totalSen: number;
  /** The sum BEFORE the min/cap/rounding envelope — the raw priced lines. */
  subtotalSen: number;
  lines: CostLine[];
}

function intOf(v: number | null | undefined): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** The positional tier amount for the Nth unit: the greatest-position tier whose
 *  position is <= n (so tier 3 prices the 3rd unit and every unit beyond). */
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
      /* One trip IS the charging unit, so tier 1 is the flat trip price and
         nothing about the load changes it. A trip that carried nothing still
         costs a trip. */
      return 1;
    case 'DROP':
      return intOf(facts.dropCount);
    case 'CUSTOMER':
      /* Falls back to drops when the caller could not resolve customers — one
         customer per drop is the pessimistic reading and never under-counts,
         which for a COST is the safe direction. */
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
  facts: Pick<DeliveryFacts, 'destinationZone' | 'destinationZones'>,
): string | null {
  const candidates = (facts.destinationZones && facts.destinationZones.length > 0)
    ? facts.destinationZones
    : [facts.destinationZone];

  let best: { zone: string; amount: number } | null = null;
  for (const raw of candidates) {
    const z = String(raw ?? '').trim().toUpperCase();
    if (!z) continue;
    const rule = rules.find((r) => r.ruleType === ruleType && String(r.zone ?? '').toUpperCase() === z);
    const amount = rule ? intOf(rule.amountSen) : 0;
    /* Ties keep the FIRST seen so the result is deterministic — the whole point
       is that the same trip must not reconcile differently on a re-run. */
    if (!best || amount > best.amount) best = { zone: z, amount };
  }
  return best ? best.zone : null;
}

/** How the caller is pricing: one DROP, or a whole TRIP. */
export interface CostOptions {
  /**
   * Include the FIXED per-trip outstation fee (OUTSTATION_TRIP rules).
   *
   * It used to be bolted on by the reconcile AFTER this function returned,
   * which put it OUTSIDE the min/cap/rounding envelope — so a card with a
   * charge cap could still bill above it, and the fee never appeared in the
   * UI calculator at all because /compute never added it. Pricing a trip and
   * pricing a drop are the same computation with one extra line; making that
   * a flag keeps ONE envelope instead of two places that cap.
   *
   * Defaults to false, which is the per-DROP reading.
   */
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
  const rules = card.rules ?? [];

  const rulesOf = (t: RateRuleType) => rules.filter((r) => r.ruleType === t);

  // ── Charging-unit positional tiers (+ cap/overage) ────────────────────────
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
        label: `Overage ${ordinal(n)} ${unitLabel} (beyond cap ${cap})`,
        amountSen: intOf(overage!.amountSen),
        detail: { position: n, cap },
      });
      continue;
    }
    const tier = tierAmountForPosition(tiers, n);
    if (tier) {
      lines.push({
        ruleType: 'POSITIONAL_TIER',
        label: `${ordinal(n)} ${unitLabel}`,
        amountSen: intOf(tier.amountSen),
        detail: { position: n, tierPosition: intOf(tier.tierPosition) },
      });
    }
  }

  // ── Sofa compartment brackets (one per sofa, additive) ────────────────────
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
        label: `Sofa ${c}-compartment (${intOf(bracket.bracketMin)}${hi} band)`,
        amountSen: intOf(bracket.amountSen),
        detail: { compartments: c, bracketMin: intOf(bracket.bracketMin), bracketMax: bracket.bracketMax ?? null },
      });
    }
  }

  // ── Outstation destination-zone surcharge — ONCE, for the FARTHEST zone ───
  // The reconcile used to hand over whichever zone came FIRST out of the
  // query, which is not the first stop on the route — it is arbitrary, so the
  // same trip could reconcile differently on a re-run. A Melaka->Johor trip
  // could be charged Melaka's RM300 when the lorry went to Johor.
  const farZone = farthestZone(rules, 'OUTSTATION', facts);
  if (farZone) {
    const os = rulesOf('OUTSTATION').find((r) => String(r.zone ?? '').toUpperCase() === farZone);
    if (os) {
      lines.push({
        ruleType: 'OUTSTATION',
        label: `Outstation ${farZone}`,
        amountSen: intOf(os.amountSen),
        detail: { zone: farZone, ...(facts.destinationZones ? { pickedFrom: [...facts.destinationZones] } : {}) },
      });
    }
  }

  // ── Occurrence charges (rate x count) ─────────────────────────────────────
  const occurrence: Array<[RateRuleType, number, string]> = [
    ['DISPOSE', intOf(facts.disposeCount), 'Dispose'],
    ['SETUP', intOf(facts.setupCount), 'Setup'],
    ['DISMANTLE', intOf(facts.dismantleCount), 'Dismantle'],
    ['SERVICE', intOf(facts.serviceCount), 'Service'],
    ['PICKUP', intOf(facts.pickupCount), 'Pickup'],
    ['INSPECTION', intOf(facts.inspectionCount), 'Inspection'],
    ['TRANSFER', intOf(facts.transferCount), 'Transfer'],
  ];
  for (const [type, count, label] of occurrence) {
    if (count <= 0) continue;
    const rule = rulesOf(type)[0];
    if (!rule) continue;
    const each = intOf(rule.amountSen);
    lines.push({
      ruleType: type,
      label: count > 1 ? `${label} x${count}` : label,
      amountSen: each * count,
      detail: { count, eachSen: each },
    });
  }

  // ── The fixed per-TRIP outstation fee (once per trip, not per drop) ───────
  if (opts.perTrip) {
    const tripZone = farthestZone(rules, 'OUTSTATION_TRIP', facts);
    const tripFee = tripOutstationFeeSen(rules, tripZone);
    if (tripFee > 0) {
      lines.push({
        ruleType: 'OUTSTATION_TRIP',
        label: `Outstation trip ${String(tripZone).toUpperCase()}`,
        amountSen: tripFee,
        detail: { zone: tripZone, perTrip: true },
      });
    }
  }

  // ── Subtotal → min / cap / rounding envelope ──────────────────────────────
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
    /* ROUNDING MUST NOT BREACH THE CAP. Half-up rounding after a cap could push
       the charge back ABOVE the ceiling the card sets — RM499.96 capped at
       RM500 then rounded to the nearest ringgit came out at RM500, which is
       fine, but a cap of RM495 with 10-sen rounding on RM494.96 produced
       RM495.00 and a cap of RM494.95 produced RM495.00 too: over the cap, on a
       line labelled "cap". A cap that a later step can exceed is not a cap.
       Round DOWN instead when up would breach it. */
    if (capSen != null && rounded > capSen) rounded = Math.floor(total / step) * step;
    if (rounded !== total) {
      lines.push({ ruleType: 'ROUNDING', label: `Rounding (${rounding === 'NEAREST_RM' ? 'nearest RM' : 'nearest 10 sen'})`, amountSen: rounded - total, detail: { rounding } });
      total = rounded;
    }
  }

  return { totalSen: total, subtotalSen, lines };
}

// ── WS4c: fixed per-TRIP outstation surcharge ────────────────────────────────
// The owner's outstation charge has two layers: a per-ORDER surcharge (the
// existing OUTSTATION rule, applied inside computeDeliveryCost per costing unit)
// AND a FIXED fee per TRIP by destination zone. The trip fee applies ONCE per
// trip regardless of drop count, so it lives OUTSIDE computeDeliveryCost — the
// reconcile adds it once after summing the trip's expected cost. This is why
// computeDeliveryCost never processes OUTSTATION_TRIP. Pure, unit-tested.
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
