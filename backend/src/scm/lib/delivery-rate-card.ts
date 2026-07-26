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
  /** Aggregation unit the tiers count over — per DROP or per CUSTOMER. Carried
   *  for the caller's fact aggregation; the pure calc prices whatever count it is
   *  handed. */
  aggregation?: 'DROP' | 'CUSTOMER';
  /** Optional envelope applied to the summed cost. */
  minChargeCenti?: number | null;
  capCenti?: number | null;
  rounding?: 'NONE' | 'NEAREST_10C' | 'NEAREST_RM' | null;
  rules: readonly RateRuleSpec[];
}

export type RateRuleType =
  | 'POSITIONAL_TIER'
  | 'OVERAGE'
  | 'SOFA_BRACKET'
  | 'OUTSTATION'
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
  amountCenti: number;
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
  /** Destination area zone (from the A1 classifier) for the outstation surcharge. */
  destinationZone?: string | null;
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
  amountCenti: number;
  /** Optional structured detail (unit index, zone, compartment band, count). */
  detail?: Record<string, unknown>;
}

export interface CostBreakdown {
  totalCenti: number;
  /** The sum BEFORE the min/cap/rounding envelope — the raw priced lines. */
  subtotalCenti: number;
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
 * Price a drop/trip against a rate card. PURE.
 *
 * Order of the itemised lines: charging-unit tiers (+ overage) → sofa brackets →
 * outstation → dispose → setup → dismantle → service/pickup/inspection/transfer,
 * then the min/cap/rounding envelope. The returned `subtotalCenti` is the sum of
 * the priced lines before the envelope; `totalCenti` is after it.
 */
export function computeDeliveryCost(card: RateCardSpec, facts: DeliveryFacts): CostBreakdown {
  const lines: CostLine[] = [];
  const rules = card.rules ?? [];

  const rulesOf = (t: RateRuleType) => rules.filter((r) => r.ruleType === t);

  // ── Charging-unit positional tiers (+ cap/overage) ────────────────────────
  const unitCount = card.basis === 'ITEM' ? intOf(facts.itemCount) : intOf(facts.setCount);
  const tiers = rulesOf('POSITIONAL_TIER');
  const overage = rulesOf('OVERAGE')[0] ?? null;
  const cap = overage ? intOf(overage.tierPosition) : null;
  const unitLabel = card.basis === 'ITEM' ? 'item' : 'set';
  const ordinal = (n: number) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);
  for (let n = 1; n <= unitCount; n++) {
    if (cap !== null && n > cap) {
      lines.push({
        ruleType: 'OVERAGE',
        label: `Overage ${ordinal(n)} ${unitLabel} (beyond cap ${cap})`,
        amountCenti: intOf(overage!.amountCenti),
        detail: { position: n, cap },
      });
      continue;
    }
    const tier = tierAmountForPosition(tiers, n);
    if (tier) {
      lines.push({
        ruleType: 'POSITIONAL_TIER',
        label: `${ordinal(n)} ${unitLabel}`,
        amountCenti: intOf(tier.amountCenti),
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
        amountCenti: intOf(bracket.amountCenti),
        detail: { compartments: c, bracketMin: intOf(bracket.bracketMin), bracketMax: bracket.bracketMax ?? null },
      });
    }
  }

  // ── Outstation destination-zone surcharge ─────────────────────────────────
  if (facts.destinationZone) {
    const z = String(facts.destinationZone).toUpperCase();
    const os = rulesOf('OUTSTATION').find((r) => String(r.zone ?? '').toUpperCase() === z);
    if (os) {
      lines.push({
        ruleType: 'OUTSTATION',
        label: `Outstation ${z}`,
        amountCenti: intOf(os.amountCenti),
        detail: { zone: z },
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
    const each = intOf(rule.amountCenti);
    lines.push({
      ruleType: type,
      label: count > 1 ? `${label} x${count}` : label,
      amountCenti: each * count,
      detail: { count, eachCenti: each },
    });
  }

  // ── Subtotal → min / cap / rounding envelope ──────────────────────────────
  const subtotalCenti = lines.reduce((s, l) => s + l.amountCenti, 0);
  let total = subtotalCenti;

  const minCharge = card.minChargeCenti != null ? intOf(card.minChargeCenti) : null;
  if (minCharge != null && total < minCharge) {
    lines.push({ ruleType: 'MIN_CHARGE', label: `Minimum charge`, amountCenti: minCharge - total, detail: { minChargeCenti: minCharge } });
    total = minCharge;
  }

  const capCenti = card.capCenti != null ? intOf(card.capCenti) : null;
  if (capCenti != null && total > capCenti) {
    lines.push({ ruleType: 'CAP', label: `Charge cap`, amountCenti: capCenti - total, detail: { capCenti } });
    total = capCenti;
  }

  const rounding = card.rounding ?? 'NONE';
  if (rounding !== 'NONE' && total > 0) {
    const step = rounding === 'NEAREST_RM' ? 100 : 10;
    const rounded = Math.round(total / step) * step;
    if (rounded !== total) {
      lines.push({ ruleType: 'ROUNDING', label: `Rounding (${rounding === 'NEAREST_RM' ? 'nearest RM' : 'nearest 10 sen'})`, amountCenti: rounded - total, detail: { rounding } });
      total = rounded;
    }
  }

  return { totalCenti: total, subtotalCenti, lines };
}
