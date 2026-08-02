import { describe, it, expect } from 'vitest';
import {
  computeDeliveryCost,
  type RateCardSpec,
  type RateRuleSpec,
} from './delivery-rate-card';

// RM in sen.
const RM = (n: number) => Math.round(n * 100);

const tier = (position: number, rm: number): RateRuleSpec => ({ ruleType: 'POSITIONAL_TIER', tierPosition: position, amountCenti: RM(rm) });
const sofa = (min: number, max: number | null, rm: number): RateRuleSpec => ({ ruleType: 'SOFA_BRACKET', bracketMin: min, bracketMax: max, amountCenti: RM(rm) });
const outstation = (zone: string, rm: number): RateRuleSpec => ({ ruleType: 'OUTSTATION', zone, amountCenti: RM(rm) });
const occ = (ruleType: RateRuleSpec['ruleType'], rm: number): RateRuleSpec => ({ ruleType, amountCenti: RM(rm) });

describe('computeDeliveryCost — owner worked example (RM560)', () => {
  // 1st set RM120 + 2nd set RM80 + sofa 3-comp (2-4 band) RM90 + outstation
  // Melaka RM150 + setup RM50 + dismantle RM40 + dispose RM30 = RM560.
  const card: RateCardSpec = {
    basis: 'SET',
    aggregation: 'DROP',
    rules: [
      tier(1, 120),
      tier(2, 80),
      tier(3, 60),
      sofa(2, 4, 90),
      sofa(5, 6, 130),
      sofa(7, null, 170),
      outstation('MELAKA', 150),
      outstation('JOHOR', 200),
      occ('SETUP', 50),
      occ('DISMANTLE', 40),
      occ('DISPOSE', 30),
    ],
  };

  it('sums to exactly RM560', () => {
    const out = computeDeliveryCost(card, {
      setCount: 2,
      sofaCompartments: [3],
      destinationZone: 'MELAKA',
      setupCount: 1,
      dismantleCount: 1,
      disposeCount: 1,
    });
    expect(out.totalCenti).toBe(RM(560));
    expect(out.subtotalCenti).toBe(RM(560));
  });

  it('itemises each priced line', () => {
    const out = computeDeliveryCost(card, {
      setCount: 2,
      sofaCompartments: [3],
      destinationZone: 'MELAKA',
      setupCount: 1,
      dismantleCount: 1,
      disposeCount: 1,
    });
    const byAmount = out.lines.map((l) => [l.ruleType, l.amountCenti]);
    expect(byAmount).toEqual([
      ['POSITIONAL_TIER', RM(120)],
      ['POSITIONAL_TIER', RM(80)],
      ['SOFA_BRACKET', RM(90)],
      ['OUTSTATION', RM(150)],
      ['DISPOSE', RM(30)],
      ['SETUP', RM(50)],
      ['DISMANTLE', RM(40)],
    ]);
  });
});

describe('positional tiers — "3rd and beyond" ladder', () => {
  const card: RateCardSpec = {
    basis: 'SET',
    rules: [tier(1, 120), tier(2, 80), tier(3, 60)],
  };
  it('prices 1 set', () => {
    expect(computeDeliveryCost(card, { setCount: 1 }).totalCenti).toBe(RM(120));
  });
  it('prices 4 sets with the 3rd tier covering the 3rd and 4th', () => {
    // 120 + 80 + 60 + 60
    expect(computeDeliveryCost(card, { setCount: 4 }).totalCenti).toBe(RM(320));
  });
  it('prices by ITEM when basis is ITEM', () => {
    const itemCard: RateCardSpec = { basis: 'ITEM', rules: [tier(1, 30), tier(2, 20)] };
    // itemCount used, setCount ignored
    expect(computeDeliveryCost(itemCard, { itemCount: 2, setCount: 99 }).totalCenti).toBe(RM(50));
  });
});

describe('cap + overage', () => {
  // Max 2 sets/drop; each extra set +RM40. Tiers cap at position 2.
  const card: RateCardSpec = {
    basis: 'SET',
    rules: [tier(1, 120), tier(2, 80), { ruleType: 'OVERAGE', tierPosition: 2, amountCenti: RM(40) }],
  };
  it('within the cap uses tiers', () => {
    expect(computeDeliveryCost(card, { setCount: 2 }).totalCenti).toBe(RM(200));
  });
  it('beyond the cap charges the overage rate (caps the tier ladder)', () => {
    // 120 + 80 + 40 + 40 = 280 for 4 sets
    const out = computeDeliveryCost(card, { setCount: 4 });
    expect(out.totalCenti).toBe(RM(280));
    expect(out.lines.filter((l) => l.ruleType === 'OVERAGE')).toHaveLength(2);
  });
});

describe('sofa compartment brackets', () => {
  const card: RateCardSpec = {
    basis: 'SET',
    rules: [sofa(2, 4, 90), sofa(5, 6, 130), sofa(7, null, 170)],
  };
  it('picks the band containing the compartment count', () => {
    expect(computeDeliveryCost(card, { sofaCompartments: [3] }).totalCenti).toBe(RM(90));
    expect(computeDeliveryCost(card, { sofaCompartments: [5] }).totalCenti).toBe(RM(130));
    expect(computeDeliveryCost(card, { sofaCompartments: [9] }).totalCenti).toBe(RM(170)); // open-ended 7+
  });
  it('is additive across multiple sofas', () => {
    // 90 + 130
    expect(computeDeliveryCost(card, { sofaCompartments: [3, 6] }).totalCenti).toBe(RM(220));
  });
  it('charges nothing for a compartment count below the lowest band', () => {
    expect(computeDeliveryCost(card, { sofaCompartments: [1] }).totalCenti).toBe(0);
  });
});

describe('outstation zone surcharge', () => {
  const card: RateCardSpec = {
    basis: 'SET',
    rules: [outstation('MELAKA', 150), outstation('JOHOR', 200)],
  };
  it('matches the destination zone case-insensitively', () => {
    expect(computeDeliveryCost(card, { destinationZone: 'melaka' }).totalCenti).toBe(RM(150));
    expect(computeDeliveryCost(card, { destinationZone: 'JOHOR' }).totalCenti).toBe(RM(200));
  });
  it('adds nothing for an in-town (unlisted) zone', () => {
    expect(computeDeliveryCost(card, { destinationZone: 'KL' }).totalCenti).toBe(0);
  });
});

describe('occurrence charges scale by count', () => {
  const card: RateCardSpec = {
    basis: 'SET',
    rules: [occ('DISPOSE', 30), occ('SERVICE', 45), occ('PICKUP', 55), occ('INSPECTION', 25), occ('TRANSFER', 35)],
  };
  it('multiplies the rate by the count', () => {
    const out = computeDeliveryCost(card, { disposeCount: 2, serviceCount: 1, pickupCount: 1, inspectionCount: 3, transferCount: 1 });
    // 60 + 45 + 55 + 75 + 35
    expect(out.totalCenti).toBe(RM(270));
  });
});

describe('min / cap / rounding envelope', () => {
  it('lifts a small charge to the minimum', () => {
    const card: RateCardSpec = { basis: 'SET', minChargeCenti: RM(100), rules: [tier(1, 60)] };
    const out = computeDeliveryCost(card, { setCount: 1 });
    expect(out.totalCenti).toBe(RM(100));
    expect(out.subtotalCenti).toBe(RM(60));
    expect(out.lines.some((l) => l.ruleType === 'MIN_CHARGE')).toBe(true);
  });
  it('caps a large charge', () => {
    const card: RateCardSpec = { basis: 'SET', capCenti: RM(200), rules: [tier(1, 120), tier(2, 120)] };
    expect(computeDeliveryCost(card, { setCount: 2 }).totalCenti).toBe(RM(200));
  });
  it('rounds to the nearest RM', () => {
    const card: RateCardSpec = { basis: 'SET', rounding: 'NEAREST_RM', rules: [{ ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountCenti: RM(120.4) }] };
    expect(computeDeliveryCost(card, { setCount: 1 }).totalCenti).toBe(RM(120));
  });
});

describe('empty / defensive', () => {
  it('an empty card costs nothing', () => {
    expect(computeDeliveryCost({ basis: 'SET', rules: [] }, { setCount: 5 }).totalCenti).toBe(0);
  });
  it('ignores non-finite / negative facts', () => {
    const card: RateCardSpec = { basis: 'SET', rules: [tier(1, 120)] };
    expect(computeDeliveryCost(card, { setCount: -3 }).totalCenti).toBe(0);
    expect(computeDeliveryCost(card, { setCount: Number.NaN }).totalCenti).toBe(0);
  });
});

// ── WS4c: fixed per-trip outstation fee (applied by the reconcile, not per drop) ──
import { tripOutstationFeeCenti } from './delivery-rate-card';

describe('tripOutstationFeeCenti (WS4c) — fixed per-trip outstation', () => {
  const rules: RateRuleSpec[] = [
    tier(1, 120),
    outstation('MELAKA', 150),                                              // per-ORDER layer
    { ruleType: 'OUTSTATION_TRIP', zone: 'JOHOR', amountCenti: RM(200) },   // per-TRIP layer
  ];

  it('returns the fixed fee for a matching destination zone', () => {
    expect(tripOutstationFeeCenti(rules, 'JOHOR')).toBe(RM(200));
    expect(tripOutstationFeeCenti(rules, 'johor')).toBe(RM(200)); // case-insensitive
  });

  it('is 0 for a non-matching zone or a blank zone', () => {
    expect(tripOutstationFeeCenti(rules, 'MELAKA')).toBe(0); // MELAKA is a per-ORDER rule, not a trip rule
    expect(tripOutstationFeeCenti(rules, null)).toBe(0);
    expect(tripOutstationFeeCenti(rules, '')).toBe(0);
  });

  it('computeDeliveryCost does NOT price OUTSTATION_TRIP (it is per-trip, not per-drop)', () => {
    const card: RateCardSpec = { basis: 'SET', rules };
    // JOHOR trip fee must NOT appear in the per-drop breakdown; only the per-order
    // OUTSTATION would (and only for its own zone). With destinationZone JOHOR,
    // there is no per-order OUTSTATION for JOHOR, so the only line is the 1st set.
    const r = computeDeliveryCost(card, { setCount: 1, destinationZone: 'JOHOR' });
    expect(r.lines.some((l) => l.ruleType === 'OUTSTATION_TRIP')).toBe(false);
    expect(r.totalCenti).toBe(RM(120));
  });
});

/**
 * A cap that a later step can exceed is not a cap.
 *
 * Two ways the envelope leaked before 2026-08-02, both silent and both
 * money-affecting:
 *
 *  1. ROUNDING ran after CAP, and half-up rounding could push the total back
 *     over the ceiling on the very line labelled "Charge cap".
 *  2. The FIXED per-trip outstation fee was added by the reconcile AFTER this
 *     function returned, so it sat outside the envelope entirely — a capped
 *     card billed cap + fee. It also meant the UI calculator could never show
 *     an OUTSTATION_TRIP line, so the screen disagreed with the invoice.
 */
describe('the envelope actually contains everything', () => {
  const card = (extra: Partial<RateCardSpec> = {}): RateCardSpec => ({
    basis: 'SET',
    rules: [{ ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountCenti: 49_496 }],
    ...extra,
  });

  it('rounding rounds DOWN rather than breaching the cap', () => {
    // 494.96 capped at 494.95 -> 494.95; nearest-10-sen would round UP to
    // 495.00, which is over the cap.
    const r = computeDeliveryCost(
      card({ capCenti: 49_495, rounding: 'NEAREST_10C' }),
      { setCount: 1 },
    );
    expect(r.totalCenti).toBeLessThanOrEqual(49_495);
    expect(r.totalCenti).toBe(49_490);
  });

  it('rounding still rounds normally when it does not breach the cap', () => {
    const r = computeDeliveryCost(card({ capCenti: 100_000, rounding: 'NEAREST_10C' }), { setCount: 1 });
    expect(r.totalCenti).toBe(49_500); // 494.96 -> 495.00, well under the cap
  });

  it('no cap means rounding behaves exactly as before', () => {
    const r = computeDeliveryCost(card({ rounding: 'NEAREST_RM' }), { setCount: 1 });
    expect(r.totalCenti).toBe(49_500);
  });

  it('the per-trip outstation fee is INSIDE the cap', () => {
    const spec = card({
      capCenti: 60_000,
      rules: [
        { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountCenti: 50_000 },
        { ruleType: 'OUTSTATION_TRIP', zone: 'PENANG', amountCenti: 40_000 },
      ],
    });
    const r = computeDeliveryCost(spec, { setCount: 1, destinationZone: 'PENANG' }, { perTrip: true });
    // 500 + 400 = 900, capped at 600. Before the fix this billed 1000.
    expect(r.totalCenti).toBe(60_000);
    expect(r.lines.some((l) => l.ruleType === 'OUTSTATION_TRIP')).toBe(true);
    expect(r.lines.some((l) => l.ruleType === 'CAP')).toBe(true);
  });

  it('per-drop pricing does NOT apply the per-trip fee', () => {
    const spec = card({
      rules: [
        { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountCenti: 50_000 },
        { ruleType: 'OUTSTATION_TRIP', zone: 'PENANG', amountCenti: 40_000 },
      ],
    });
    const perDrop = computeDeliveryCost(spec, { setCount: 1, destinationZone: 'PENANG' });
    expect(perDrop.totalCenti).toBe(50_000);
    expect(perDrop.lines.some((l) => l.ruleType === 'OUTSTATION_TRIP')).toBe(false);
  });

  it('a per-trip fee for a DIFFERENT zone is not applied', () => {
    const spec = card({
      rules: [
        { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountCenti: 50_000 },
        { ruleType: 'OUTSTATION_TRIP', zone: 'PENANG', amountCenti: 40_000 },
      ],
    });
    const r = computeDeliveryCost(spec, { setCount: 1, destinationZone: 'JOHOR' }, { perTrip: true });
    expect(r.totalCenti).toBe(50_000);
  });

  it('the per-trip fee counts toward the MINIMUM charge too', () => {
    /* The minimum sits BETWEEN the two readings on purpose. At RM700:
         fee inside the envelope -> 500 + 400 = 900, already over, no top-up.
         fee outside             -> 500 topped to 700, then +400 = 1100.
       A minimum above both (e.g. RM1000) would produce RM1000 either way and
       the test would pass while the bug was present — which is what the first
       draft of this test did. */
    const spec = card({
      minChargeCenti: 70_000,
      rules: [
        { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountCenti: 50_000 },
        { ruleType: 'OUTSTATION_TRIP', zone: 'PENANG', amountCenti: 40_000 },
      ],
    });
    const r = computeDeliveryCost(spec, { setCount: 1, destinationZone: 'PENANG' }, { perTrip: true });
    expect(r.totalCenti).toBe(90_000);
    expect(r.lines.some((l) => l.ruleType === 'MIN_CHARGE')).toBe(false);
  });
});
