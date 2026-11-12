// Price check — what a rate card says one delivery should cost, to hold a 3PL's
// bill against. Owner 2026-11-11: 「check a drop 是check 价钱？」 (yes — so it is
// named Price check) and 「做多一个categories按钮」 (its own tab beside the four
// categories). The boxes a card prices, read into the /compute facts, and the
// answer grouped the way the tabs are. Pure.
import type { CostBreakdown, CostLine, DeliveryFacts, RateArea, RateCard, RateRule } from '../../../vendor/scm/lib/delivery-rate-card-queries';
import {
  CATEGORY_LABEL, RULE_CATEGORY, RULE_LABEL, type RateRuleCategory,
} from '../../../vendor/scm/lib/rate-rule-taxonomy';
import type { ChargingUnit } from './cardSettings';
import { CATEGORY_ORDER, FLAT_ORDER, ordinal, type FlatRuleType } from './rateCardLayout';
import { areaOfTown } from './rateCardAreas';

type CountFact =
  | 'disposeCount' | 'setupCount' | 'dismantleCount' | 'serviceCount'
  | 'pickupCount' | 'inspectionCount' | 'supplierPickupCount' | 'transferCount';
/** The /compute fact a flat rule type's count box fills, by the server's naming
 *  (DISPOSE → disposeCount, SUPPLIER_PICKUP → supplierPickupCount). Derived from
 *  the type, so the list of flat types stays FLAT_ORDER alone. */
export const countFact = (t: FlatRuleType): CountFact =>
  `${t.toLowerCase().replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())}Count` as CountFact;

export interface PriceCheckForm {
  /** Sets or items — what a per-unit card counts. */
  count: string;
  /** Compartments of each sofa, comma-separated: "3, 6". */
  sofas: string;
  /** An outstation town or zone of this card, or a town of one of its areas;
   *  '' is in town. */
  town: string;
  counts: Partial<Record<FlatRuleType, string>>;
}
export const EMPTY_FORM: PriceCheckForm = { count: '1', sofas: '', town: '', counts: {} };

/** A count box takes 0 to MAX_COUNT: a typo like 10000 sets would otherwise
 *  ask the engine for ten thousand lines on every keystroke. */
export const MAX_COUNT = 99;
const WHOLE = /^\d+$/;
export const COUNT_ERROR = `Enter a whole number from 0 to ${MAX_COUNT}.`;
export const SOFA_ERROR = 'Enter each sofa’s compartments as a number, separated by commas, like 3, 6.';

/** What is wrong with each box, by box. */
export type CheckErrors = Partial<Record<'count' | 'sofas' | FlatRuleType, string>>;
export type FactsRead = { ok: true; facts: DeliveryFacts } | { ok: false; errors: CheckErrors };

/** Which boxes this card prices: only those are shown and sent. */
export function pricedTypes(rules: readonly RateRule[]): ReadonlySet<string> {
  return new Set(rules.map((r) => r.ruleType));
}

/** The form read into /compute facts, or what is wrong with it. Only the boxes
 *  this card prices are read; the rest stay out of the facts. A town of one of
 *  the card's areas names that area, so the delivery is priced in it. */
export function readFacts(
  form: PriceCheckForm, card: Pick<RateCard, 'basis' | 'aggregation'>, priced: ReadonlySet<string>, areas: readonly RateArea[] = [],
): FactsRead {
  const errors: CheckErrors = {};
  const whole = (key: 'count' | FlatRuleType, raw: string): number => {
    const t = raw.trim();
    if (t === '') return 0;
    const n = Number(t);
    if (!WHOLE.test(t) || n > MAX_COUNT) { errors[key] = COUNT_ERROR; return 0; }
    return n;
  };
  const facts: DeliveryFacts = {};
  /* Only a per-unit card counts sets or items; a per-trip card prices the trip
     whatever it carries, and the calculator has no drop count to send. */
  if (card.aggregation === 'UNIT') facts[card.basis === 'ITEM' ? 'itemCount' : 'setCount'] = whole('count', form.count);
  if (priced.has('SOFA_BRACKET')) {
    const parts = form.sofas.split(',').map((s) => s.trim()).filter((s) => s !== '');
    if (parts.some((p) => !WHOLE.test(p) || Number(p) < 1 || Number(p) > MAX_COUNT)) errors.sofas = SOFA_ERROR;
    else facts.sofaCompartments = parts.length ? parts.map(Number) : null;
  }
  for (const t of FLAT_ORDER) {
    if (priced.has(t)) facts[countFact(t)] = whole(t, form.counts[t] ?? '');
  }
  facts.destinationZone = form.town.trim() || null;
  const area = areaOfTown(areas, form.town);
  if (area) facts.areaId = area.id;
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, facts };
}

/** The card's outstation towns for the Destination list, A to Z. */
export function outstationTowns(rules: readonly RateRule[]): string[] {
  const towns = new Map<string, string>();
  for (const r of rules) {
    if ((r.ruleType !== 'OUTSTATION' && r.ruleType !== 'OUTSTATION_TRIP') || !r.zone?.trim()) continue;
    const z = r.zone.trim();
    if (!towns.has(z.toUpperCase())) towns.set(z.toUpperCase(), z);
  }
  return [...towns.values()].sort((a, b) => a.localeCompare(b));
}

export interface DestinationGroup { label: string | null; towns: string[] }

/** Price check's Destination list: each area's towns under the area's name,
 *  then the card's town-price towns that are in no area. A card with no area
 *  lists its towns alone, as before. Empty groups are left out. */
export function destinationGroups(areas: readonly RateArea[], rules: readonly RateRule[]): DestinationGroup[] {
  const inArea = new Set(areas.flatMap((a) => a.towns));
  const other = outstationTowns(rules).filter((t) => !inArea.has(t.toUpperCase()));
  if (areas.length === 0) return other.length > 0 ? [{ label: null, towns: other }] : [];
  return [
    ...areas.map((a) => ({ label: a.name, towns: [...a.towns].sort((x, y) => x.localeCompare(y)) })),
    { label: 'Other towns', towns: other },
  ].filter((g) => g.towns.length > 0);
}

export interface CheckLine { key: string; label: string; amountSen: number }
export interface CheckGroup { id: RateRuleCategory | 'ENVELOPE'; title: string; lines: CheckLine[] }

const ENVELOPE = new Set(['MIN_CHARGE', 'CAP', 'ROUNDING']);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** A breakdown line in the words of the tiles, with a correct ordinal (the
 *  engine's own label says "21th"). Falls back to the engine's label. */
export function lineLabel(line: CostLine, unit: ChargingUnit): string {
  const d = line.detail ?? {};
  const position = num(d.position);
  switch (line.ruleType) {
    case 'POSITIONAL_TIER':
      return position == null ? line.label : `${ordinal(position)} ${unit}`;
    case 'OVERAGE': {
      const cap = num(d.cap);
      return position == null || cap == null ? line.label : `${ordinal(position)} ${unit}, beyond the first ${cap}`;
    }
    case 'SOFA_BRACKET': {
      const c = num(d.compartments);
      return c == null ? line.label : `Sofa, ${c} ${c === 1 ? 'compartment' : 'compartments'}`;
    }
    case 'OUTSTATION': {
      const z = text(d.zone);
      return z == null ? line.label : `${z}, per order`;
    }
    case 'OUTSTATION_TRIP': {
      const z = text(d.zone);
      return z == null ? line.label : `${z}, per trip`;
    }
    default: {
      const name = (RULE_LABEL as Partial<Record<string, string>>)[line.ruleType];
      const count = num(d.count);
      if (name == null) return line.label;
      return count != null && count > 1 ? `${name} × ${count}` : name;
    }
  }
}

/** The breakdown grouped by the card's categories, then the minimum / cap /
 *  rounding adjustments; empty groups are left out. A line the engine priced in
 *  an area keeps the area's name: "1st set · Kuching zone 3". */
export function groupBreakdown(b: CostBreakdown, unit: ChargingUnit): CheckGroup[] {
  const inArea = b.area ? ` · ${b.area.name}` : null;
  const groups = new Map<RateRuleCategory | 'ENVELOPE', CheckGroup>();
  for (const c of CATEGORY_ORDER) groups.set(c, { id: c, title: CATEGORY_LABEL[c], lines: [] });
  const envelope: CheckGroup = { id: 'ENVELOPE', title: 'Minimum, cap and rounding', lines: [] };
  groups.set('ENVELOPE', envelope);
  b.lines.forEach((l, i) => {
    const suffix = inArea && l.label.endsWith(inArea) ? inArea : '';
    const line = { key: `${l.ruleType}-${i}`, label: `${lineLabel(l, unit)}${suffix}`, amountSen: l.amountSen };
    const cat = ENVELOPE.has(l.ruleType)
      ? 'ENVELOPE'
      : (RULE_CATEGORY as Partial<Record<string, RateRuleCategory>>)[l.ruleType] ?? 'DELIVERY';
    (groups.get(cat) ?? envelope).lines.push(line);
  });
  return [...groups.values()].filter((g) => g.lines.length > 0);
}
