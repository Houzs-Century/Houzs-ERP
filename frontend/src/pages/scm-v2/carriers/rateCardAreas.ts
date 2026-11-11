// Areas on a rate card (mig 20261111T1000; owner 2026-11-11 on the 3PL
// quotations: 做). A carrier prices each group of towns with its own ladder —
// the first sets, each set after, a sofa — not the card's ladder plus one town
// surcharge. These helpers lay an area's prices out the way the Delivery tab
// lays out the card's, give the boxes a new area asks for (the card's own
// ladder, so the areas of one card read alike), read a typed town list, and
// say which towns need a second look. Pure.
import type { NewRateRule, RateArea, RateRule } from '../../../vendor/scm/lib/delivery-rate-card-queries';
import { ladderTitle, layoutRateCard, ordinal, sofaLabel, type PriceCell, type RuleBlock } from './rateCardLayout';

type Ladder = Extract<RuleBlock, { kind: 'ladder' }>;

/** One box a new area asks for, and the price it becomes. `label` stands alone
 *  (the Add area form); `tile` is the word under its block's title. */
export interface PriceBox { key: string; label: string; tile: string; rule: Omit<NewRateRule, 'amountSen' | 'areaId'> }

const keyOf = (r: Pick<RateRule, 'ruleType' | 'tierPosition' | 'bracketMin' | 'bracketMax'>): string =>
  r.ruleType === 'POSITIONAL_TIER' ? `tier-${r.tierPosition ?? 1}`
    : r.ruleType === 'SOFA_BRACKET' ? `sofa-${r.bracketMin ?? 0}-${r.bracketMax ?? ''}`
      : r.ruleType.toLowerCase();

/** The area's prices, as tiles in blocks: its ladder, its sofas, its extras.
 *  A position the card's own ladder names keeps the card's word for it, so an
 *  area priced for its 1st set only reads "1st set", not "Each set". */
export function areaBlocks(rules: readonly RateRule[], areaId: string, unit: string, template: readonly PriceBox[] = []): Ladder[] {
  const mine = rules.filter((r) => r.areaId === areaId);
  const delivery = layoutRateCard(mine, unit).find((s) => s.category === 'DELIVERY');
  const word = new Map(template.filter((b) => b.rule.ruleType === 'POSITIONAL_TIER').map((b) => [b.key, b.label]));
  return (delivery?.blocks ?? [])
    .filter((b): b is Ladder => b.kind === 'ladder')
    .map((b) => (b.id !== 'tiers' ? b : { ...b, cells: b.cells.map((c) => ({ ...c, label: word.get(keyOf(c.rule)) ?? c.label })) }));
}

/** The boxes a new area asks for: the positions and sofa bands of the card's
 *  own prices (a card with no ladder gets one price per unit), and Dispose when
 *  the card charges it. */
export function areaTemplate(cardRules: readonly RateRule[], unit: string): PriceBox[] {
  const own = cardRules.filter((r) => r.areaId == null);
  const found = [...new Set(own.filter((r) => r.ruleType === 'POSITIONAL_TIER').map((r) => r.tierPosition ?? 1))].sort((a, b) => a - b);
  const positions = found.length > 0 ? found : [1];
  const top = Math.max(...positions);
  const boxes: PriceBox[] = positions.map((p) => {
    const label = positions.length === 1 && p === 1 ? `Each ${unit}` : p === top ? `${ordinal(p)} ${unit} and after` : `${ordinal(p)} ${unit}`;
    return { key: `tier-${p}`, label, tile: label, rule: { ruleType: 'POSITIONAL_TIER', tierPosition: p } };
  });
  const bands = new Map<string, { min: number; max: number | null }>();
  for (const r of own.filter((x) => x.ruleType === 'SOFA_BRACKET')) {
    bands.set(keyOf(r), { min: r.bracketMin ?? 0, max: r.bracketMax });
  }
  for (const [key, b] of [...bands].sort((x, y) => x[1].min - y[1].min)) {
    boxes.push({ key, label: `Sofa, ${sofaLabel(b.min, b.max).toLowerCase()}`, tile: sofaLabel(b.min, b.max), rule: { ruleType: 'SOFA_BRACKET', bracketMin: b.min, bracketMax: b.max } });
  }
  if (own.some((r) => r.ruleType === 'DISPOSE')) boxes.push({ key: 'dispose', label: 'Dispose', tile: 'Dispose', rule: { ruleType: 'DISPOSE' } });
  return boxes;
}

/** The template's boxes this area has no price for yet. */
export function missingBoxes(template: readonly PriceBox[], rules: readonly RateRule[], areaId: string): PriceBox[] {
  const have = new Set(rules.filter((r) => r.areaId === areaId).map(keyOf));
  return template.filter((b) => !have.has(b.key));
}

export interface AreaGrid { id: Ladder['id']; title: string; cells: PriceCell[]; missing: PriceBox[] }

/** An area's tiles by block — its prices, then a dashed tile for each price the
 *  card's ladder has and the area does not, under the block it belongs to. */
export function areaGrids(rules: readonly RateRule[], areaId: string, unit: string, template: readonly PriceBox[]): AreaGrid[] {
  const blocks = areaBlocks(rules, areaId, unit, template);
  const missing = missingBoxes(template, rules, areaId);
  const blockOf = (b: PriceBox): Ladder['id'] => (b.rule.ruleType === 'POSITIONAL_TIER' ? 'tiers' : b.rule.ruleType === 'SOFA_BRACKET' ? 'sofa' : 'flat');
  const grids: AreaGrid[] = [];
  for (const id of ['tiers', 'overage', 'sofa', 'flat'] as const) {
    const block = blocks.find((b) => b.id === id);
    const add = missing.filter((m) => blockOf(m) === id);
    if (block || add.length > 0) grids.push({ id, title: block?.title ?? ladderTitle(id, unit), cells: block?.cells ?? [], missing: add });
  }
  return grids;
}

/** A typed town list as the server keeps it: commas, semicolons or new lines
 *  between towns; capitals, single spaces, no blanks or repeats. */
export function parseTowns(text: string): string[] {
  return [...new Set(text.split(/[,;\n]+/).map((t) => t.toUpperCase().replace(/\s+/g, ' ').trim()).filter((t) => t !== ''))];
}

/** The area a town belongs to; the first listed when a card has it twice. */
export function areaOfTown(areas: readonly RateArea[], town: string): RateArea | null {
  const t = town.trim().toUpperCase();
  return t === '' ? null : areas.find((a) => a.towns.includes(t)) ?? null;
}

export interface TownNote { town: string; areas: string[] }

/** Towns listed in two areas of the card: the address picks the dearer area. */
export function townsInTwoAreas(areas: readonly RateArea[]): TownNote[] {
  const by = new Map<string, string[]>();
  for (const a of areas) for (const t of a.towns) by.set(t, [...(by.get(t) ?? []), a.name]);
  return [...by].filter(([, names]) => names.length > 1).map(([town, names]) => ({ town, areas: names })).sort((a, b) => a.town.localeCompare(b.town));
}

/** Town surcharges on a town inside an area: they add on top of the area's
 *  price (right for a customs fee, a double charge otherwise). */
export function surchargesInAreas(areas: readonly RateArea[], cardRules: readonly RateRule[]): TownNote[] {
  const out = new Map<string, string[]>();
  for (const r of cardRules) {
    if (r.areaId != null || (r.ruleType !== 'OUTSTATION' && r.ruleType !== 'OUTSTATION_TRIP')) continue;
    const town = (r.zone ?? '').trim().toUpperCase();
    const names = areas.filter((a) => a.towns.includes(town)).map((a) => a.name);
    if (town && names.length) out.set(town, names);
  }
  return [...out].map(([town, names]) => ({ town, areas: names })).sort((a, b) => a.town.localeCompare(b.town));
}
