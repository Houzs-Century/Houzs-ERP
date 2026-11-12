// A rate card's settings, said in words. Owner 2026-11-11 on the card editor:
// 「先帮我重新design 这个UI 先，看了很乱」 — the six-box settings grid read as
// clutter for values that rarely change, so the card's header says them in one
// line and the boxes open from Edit settings. Pure.
import { fmtSen } from '@2990s/shared';
import type { RateAggregation, RateCard } from '../../../vendor/scm/lib/delivery-rate-card-queries';

/* What each charging unit means, in the operator's terms. The positional tiers
   run DOWN this unit — so "Customer" is what makes the second delivery to the
   same doorstep cheaper, and "Trip" is a flat price that ignores the load. */
export const AGGREGATION_HINT: Record<RateAggregation, string> = {
  UNIT: 'Tiers run down the goods — 1st, 2nd, 3rd item on the trip.',
  DROP: 'Tiers run down the delivery orders. Five DOs is five charges, whatever each contains.',
  CUSTOMER: 'Two drops to the same buyer at the same address count once, so the second is cheaper.',
  TRIP: 'One charge for the whole trip. Tier 1 is the price; the load does not change it.',
};

/* Server values can outrun this build's lists, so lookups fall back rather than render blank. */
export const aggHint = (a: string): string => (AGGREGATION_HINT as Partial<Record<string, string>>)[a] ?? AGGREGATION_HINT.UNIT;

export const centiToRM = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2));
export const rmToSen = (v: string): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

/** What the tier ladder counts, as a word — the backend's chargingUnitLabel
 *  (scm/lib/delivery-rate-card.ts), so a tile reads "1st set" where the card
 *  counts sets and "1st drop" where it counts delivery orders. */
export type ChargingUnit = 'set' | 'item' | 'drop' | 'customer' | 'trip';
export const chargingUnit = (card: Pick<RateCard, 'basis' | 'aggregation'>): ChargingUnit => {
  switch (card.aggregation) {
    case 'TRIP': return 'trip';
    case 'DROP': return 'drop';
    case 'CUSTOMER': return 'customer';
    default: return card.basis === 'ITEM' ? 'item' : 'set';
  }
};

const CHARGED_PER: Record<ChargingUnit, string> = {
  set: 'Charged per set (frame + mattress)',
  item: 'Charged per item',
  drop: 'Charged per drop (each DO)',
  customer: 'Charged per customer (same address, same day)',
  trip: 'Charged per trip (flat, whatever it carries)',
};
/* The two roundings in words; anything else (NONE, or a value this build does
   not know) reads as none — the server's list of roundings stays the one list. */
const roundingWords = (r: string) =>
  r === 'NEAREST_RM' ? 'Rounded to the nearest RM' : r === 'NEAREST_10C' ? 'Rounded to the nearest 10 sen' : 'No rounding';

/** The card's settings as one line under its name:
 *  "Charged per set (frame + mattress) · No minimum · No cap · No rounding". */
export function settingsSentence(card: Pick<RateCard, 'basis' | 'aggregation' | 'minChargeSen' | 'capSen' | 'rounding'>): string {
  return [
    CHARGED_PER[chargingUnit(card)],
    card.minChargeSen == null ? 'No minimum' : `Minimum ${fmtSen(card.minChargeSen)}`,
    card.capSen == null ? 'No cap' : `Cap ${fmtSen(card.capSen)}`,
    roundingWords(card.rounding),
  ].join(' · ');
}

/* own: our own cost structure. carrier: an active 3PL's card. removed: its 3PL
   company was deleted (carrier nulled, never own fleet). inactive: its 3PL
   company is set inactive, so the carrier list omits it. */
export type CardKind = 'own' | 'carrier' | 'removed' | 'inactive';
export const cardKind = (c: RateCard, listed: ReadonlySet<string>): CardKind =>
  c.carrierCompanyId ? (listed.has(c.carrierCompanyId) ? 'carrier' : 'inactive') : c.isOwnFleet ? 'own' : 'removed';
