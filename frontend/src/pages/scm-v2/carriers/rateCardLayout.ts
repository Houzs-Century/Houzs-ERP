// How a rate card's rules are laid out to be read at a glance (owner 2026-11-08:
// a card with 58 rules read as one long list). Each category becomes blocks:
//   ladder  a row of labelled prices: positional tiers as 1st / 2nd / 3rd+,
//           sofa brackets as 1-3 / 4+ compartments, flat charges by name
//   zones   outstation as a zone x (per order, per trip) table
// Pure, so the grouping is tested without rendering.
import type { RateRule } from '../../../vendor/scm/lib/delivery-rate-card-queries';
import {
  RATE_RULE_CATEGORIES, RULE_CATEGORY, RULE_LABEL, type RateRuleCategory,
} from '../../../vendor/scm/lib/rate-rule-taxonomy';

export interface PriceCell {
  /** What the price is for, inside its block: "1st", "4+ compartments", "Setup". */
  label: string;
  rule: RateRule;
  /** Another rule prices the same thing. The engine uses only one of them. */
  duplicate: boolean;
}
export interface ZoneRow {
  zone: string;
  perOrder: RateRule | null;
  perTrip: RateRule | null;
  /** More than one rule for this zone and kind; the engine uses only one. */
  duplicate: boolean;
}
export type RuleBlock =
  | { kind: 'ladder'; id: 'tiers' | 'overage' | 'sofa' | 'flat'; title: string; cells: PriceCell[] }
  | { kind: 'zones'; id: 'zones'; title: string; rows: ZoneRow[] };
export interface RuleSection { category: RateRuleCategory; count: number; blocks: RuleBlock[] }

const ord = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${s}`;
};
const categoryOf = (t: string): RateRuleCategory =>
  (RULE_CATEGORY as Partial<Record<string, RateRuleCategory>>)[t] ?? 'DELIVERY';
const labelOf = (t: string): string => (RULE_LABEL as Partial<Record<string, string>>)[t] ?? t;
const zoneKey = (z: string | null) => (z ?? '').trim().toUpperCase();

const markDuplicates = (cells: Array<Omit<PriceCell, 'duplicate'> & { key: string }>): PriceCell[] => {
  const seen = new Map<string, number>();
  for (const c of cells) seen.set(c.key, (seen.get(c.key) ?? 0) + 1);
  return cells.map(({ key, ...c }) => ({ ...c, duplicate: (seen.get(key) ?? 0) > 1 }));
};

/** The tier ladder: the highest position prices every unit beyond it too
 *  (delivery-rate-card.ts tierAmountForPosition), so it carries a "+". */
const tierCells = (tiers: RateRule[], unit: string): PriceCell[] => {
  const sorted = [...tiers].sort((a, b) => (a.tierPosition ?? 0) - (b.tierPosition ?? 0));
  const top = Math.max(0, ...sorted.map((r) => r.tierPosition ?? 0));
  if (sorted.length === 1 && top === 1) return [{ label: `Each ${unit}`, rule: sorted[0], duplicate: false }];
  return markDuplicates(sorted.map((r) => {
    const p = r.tierPosition ?? 0;
    return { key: String(p), label: p === top ? `${ord(p)}+` : ord(p), rule: r };
  }));
};

const sofaCells = (brackets: RateRule[]): PriceCell[] => markDuplicates(
  [...brackets]
    .sort((a, b) => (a.bracketMin ?? 0) - (b.bracketMin ?? 0) || (a.bracketMax ?? Infinity) - (b.bracketMax ?? Infinity))
    .map((r) => ({
      key: `${r.bracketMin}-${r.bracketMax}`,
      label: `${r.bracketMin ?? 0}${r.bracketMax == null ? '+' : r.bracketMax === r.bracketMin ? '' : `-${r.bracketMax}`} compartments`,
      rule: r,
    })),
);

const flatCells = (rules: RateRule[], order: readonly string[]): PriceCell[] => markDuplicates(
  [...rules]
    .sort((a, b) => {
      const ia = order.indexOf(a.ruleType); const ib = order.indexOf(b.ruleType);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.ruleType.localeCompare(b.ruleType);
    })
    .map((r) => ({ key: r.ruleType, label: labelOf(r.ruleType), rule: r })),
);

const FLAT_ORDER = ['DISPOSE', 'SETUP', 'DISMANTLE', 'SERVICE', 'PICKUP', 'INSPECTION', 'SUPPLIER_PICKUP', 'TRANSFER'];
const LADDER_TYPES = new Set(['POSITIONAL_TIER', 'OVERAGE', 'SOFA_BRACKET', 'OUTSTATION', 'OUTSTATION_TRIP']);

/** Every category, in the taxonomy's order, empty ones included so a rule can
 *  be added to any of them. An unknown rule type lands in Delivery as a flat
 *  charge rather than vanishing. */
export function layoutRateCard(rules: readonly RateRule[], unit: string): RuleSection[] {
  return RATE_RULE_CATEGORIES.map((category) => {
    const mine = rules.filter((r) => categoryOf(r.ruleType) === category);
    const of = (t: string) => mine.filter((r) => r.ruleType === t);
    const blocks: RuleBlock[] = [];
    const tiers = of('POSITIONAL_TIER');
    if (tiers.length) blocks.push({ kind: 'ladder', id: 'tiers', title: `Per ${unit} by position`, cells: tierCells(tiers, unit) });
    const overage = of('OVERAGE');
    if (overage.length) {
      blocks.push({
        kind: 'ladder', id: 'overage', title: 'Beyond the cap',
        cells: markDuplicates(overage.map((r) => ({ key: 'overage', label: `After ${r.tierPosition ?? 0}, each`, rule: r }))),
      });
    }
    const sofa = of('SOFA_BRACKET');
    if (sofa.length) blocks.push({ kind: 'ladder', id: 'sofa', title: 'Sofa, by compartments', cells: sofaCells(sofa) });
    const flat = mine.filter((r) => !LADDER_TYPES.has(r.ruleType));
    if (flat.length) blocks.push({ kind: 'ladder', id: 'flat', title: category === 'DELIVERY' ? 'Extras, each' : 'Each time', cells: flatCells(flat, FLAT_ORDER) });

    const zoneRules = [...of('OUTSTATION'), ...of('OUTSTATION_TRIP')];
    if (zoneRules.length) {
      const byZone = new Map<string, { zone: string; order: RateRule[]; trip: RateRule[] }>();
      for (const r of zoneRules) {
        const k = zoneKey(r.zone);
        const row = byZone.get(k) ?? { zone: (r.zone ?? '').trim() || '(no zone)', order: [], trip: [] };
        (r.ruleType === 'OUTSTATION' ? row.order : row.trip).push(r);
        byZone.set(k, row);
      }
      blocks.push({
        kind: 'zones', id: 'zones', title: 'By destination zone',
        rows: [...byZone.values()]
          .sort((a, b) => a.zone.localeCompare(b.zone))
          .map((z) => ({ zone: z.zone, perOrder: z.order[0] ?? null, perTrip: z.trip[0] ?? null, duplicate: z.order.length > 1 || z.trip.length > 1 })),
      });
    }
    return { category, count: mine.length, blocks };
  });
}

/** Rules of a zone that the zone table could not show, because a second rule
 *  for the same zone and kind exists. Listed under the table so none hides. */
export function hiddenZoneRules(rules: readonly RateRule[], rows: readonly ZoneRow[]): RateRule[] {
  const shown = new Set(rows.flatMap((r) => [r.perOrder?.id, r.perTrip?.id]).filter(Boolean));
  return rules.filter((r) => (r.ruleType === 'OUTSTATION' || r.ruleType === 'OUTSTATION_TRIP') && !shown.has(r.id));
}
