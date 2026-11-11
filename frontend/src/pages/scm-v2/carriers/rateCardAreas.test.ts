// Areas on a rate card (mig 20261111T1000): an area's prices laid out like the
// Delivery tab's, the boxes a new area asks for, a typed town list, and the
// towns worth a second look. Amounts are made up.
import { describe, expect, it } from 'vitest';
import type { RateArea, RateRule } from '../../../vendor/scm/lib/delivery-rate-card-queries';
import {
  areaBlocks, areaOfTown, areaTemplate, missingBoxes, parseTowns, surchargesInAreas, townsInTwoAreas,
} from './rateCardAreas';

const rule = (over: Partial<RateRule>): RateRule => ({
  id: 'r', cardId: 'c', ruleType: 'POSITIONAL_TIER', tierPosition: null, bracketMin: null, bracketMax: null,
  zone: null, amountSen: 0, params: null, sortOrder: 0, areaId: null, ...over,
});
const area = (over: Partial<RateArea>): RateArea => ({ id: 'a1', cardId: 'c', name: 'Far', towns: [], sortOrder: 0, ...over });

/* A card priced the 3-position way, with two sofa bands. */
const LADDER_CARD = [
  rule({ id: 't1', tierPosition: 1, amountSen: 10_000 }),
  rule({ id: 't2', tierPosition: 2, amountSen: 0 }),
  rule({ id: 't3', tierPosition: 3, amountSen: 3_000 }),
  rule({ id: 's1', ruleType: 'SOFA_BRACKET', bracketMin: 1, bracketMax: 3, amountSen: 12_000 }),
  rule({ id: 's2', ruleType: 'SOFA_BRACKET', bracketMin: 4, bracketMax: null, amountSen: 14_000 }),
  rule({ id: 'o1', ruleType: 'OUTSTATION', zone: 'LABUAN', amountSen: 6_000 }),
];

describe('areaTemplate', () => {
  it('asks for the card’s own positions and sofa bands, in order', () => {
    expect(areaTemplate(LADDER_CARD, 'set').map((b) => [b.key, b.label])).toEqual([
      ['tier-1', '1st set'], ['tier-2', '2nd set'], ['tier-3', '3rd set and after'],
      ['sofa-1-3', 'Sofa, 1 to 3 compartments'], ['sofa-4-', 'Sofa, 4 or more'],
    ]);
  });

  it('a card with one price per set asks for one, and for Dispose when the card charges it', () => {
    const card = [rule({ tierPosition: 1, amountSen: 9_000 }), rule({ id: 'd', ruleType: 'DISPOSE', amountSen: 1_000 })];
    expect(areaTemplate(card, 'set').map((b) => b.label)).toEqual(['Each set', 'Dispose']);
  });

  it('a card with no ladder yet still asks for a price per unit; area prices are not the card’s', () => {
    expect(areaTemplate([rule({ tierPosition: 2, amountSen: 1, areaId: 'a1' })], 'item').map((b) => b.label)).toEqual(['Each item']);
  });
});

describe('an area’s prices', () => {
  const rules = [
    ...LADDER_CARD,
    rule({ id: 'a-t1', tierPosition: 1, amountSen: 30_000, areaId: 'a1' }),
    rule({ id: 'a-t3', tierPosition: 3, amountSen: 6_000, areaId: 'a1' }),
    rule({ id: 'a-s1', ruleType: 'SOFA_BRACKET', bracketMin: 1, bracketMax: 3, amountSen: 35_000, areaId: 'a1' }),
    rule({ id: 'b-t1', tierPosition: 1, amountSen: 20_000, areaId: 'a2' }),
  ];

  it('are laid out as tiles in blocks, only the area’s own', () => {
    const blocks = areaBlocks(rules, 'a1', 'set');
    expect(blocks.map((b) => [b.id, b.cells.map((c) => [c.label, c.rule.amountSen])])).toEqual([
      ['tiers', [['1st set', 30_000], ['3rd set and after', 6_000]]],
      ['sofa', [['1 to 3 compartments', 35_000]]],
    ]);
  });

  it('a position the card names keeps the card’s word: a 1st-set-only area reads "1st set"', () => {
    const template = areaTemplate(LADDER_CARD, 'set');
    expect(areaBlocks(rules, 'a2', 'set').map((b) => b.cells.map((c) => c.label))).toEqual([['Each set']]);
    expect(areaBlocks(rules, 'a2', 'set', template).map((b) => b.cells.map((c) => c.label))).toEqual([['1st set']]);
  });

  it('and the boxes it has no price for are offered as dashed tiles', () => {
    const template = areaTemplate(LADDER_CARD, 'set');
    expect(missingBoxes(template, rules, 'a1').map((b) => b.key)).toEqual(['tier-2', 'sofa-4-']);
    expect(missingBoxes(template, rules, 'a2').map((b) => b.key)).toEqual(['tier-2', 'tier-3', 'sofa-1-3', 'sofa-4-']);
  });
});

describe('towns', () => {
  it('a typed list is split on commas, semicolons and lines, in capitals, once each', () => {
    expect(parseTowns(' batu kawah, Padawan;\nPADAWAN ,, kota   samarahan ')).toEqual(['BATU KAWAH', 'PADAWAN', 'KOTA SAMARAHAN']);
  });

  it('a town finds its area', () => {
    const areas = [area({ id: 'a1', towns: ['BINTULU', 'TATAU'] }), area({ id: 'a2', name: 'Near', towns: ['MARUDI'] })];
    expect(areaOfTown(areas, 'tatau')?.id).toBe('a1');
    expect(areaOfTown(areas, 'KUCHING')).toBeNull();
    expect(areaOfTown(areas, '')).toBeNull();
  });

  it('a town in two areas is named, and so is a town price inside an area', () => {
    const areas = [area({ id: 'a1', name: 'Zone 3', towns: ['SERIAN', 'PADAWAN'] }), area({ id: 'a2', name: 'Zone 4', towns: ['SERIAN', 'BAU'] }),
      area({ id: 'a3', name: 'Zone 5', towns: ['LABUAN'] })];
    expect(townsInTwoAreas(areas)).toEqual([{ town: 'SERIAN', areas: ['Zone 3', 'Zone 4'] }]);
    expect(surchargesInAreas(areas, LADDER_CARD)).toEqual([{ town: 'LABUAN', areas: ['Zone 5'] }]);
  });
});
