import { describe, expect, it } from 'vitest';
import { collapseSofaLines, type CollapsibleLine } from './autocount-sofa-collapse';
import { parseSofa } from '../../scripts/lib/parse-sofa.mjs';

/* A PIECE OF ANOTHER MODEL INSIDE ONE BOOK LINE (docs/bugs/0913).
 * Rows below are HC-SO-002861 as production held them on 2026-09-15, in ERP line
 * order (identity fields, Desc2 and variants only). The book holds the sofa as
 * ONE line, DSL-8060 SOFA 184398; an amendment approved 2026-09-14 turned one of
 * its pieces into a corner of model 8069. HC-PO-009827 carries the same rows
 * under book line 892697. */
const MOD = 'MODENZA-01 HOUSTON CREAM / SEAT 28 / LEG DEFAULT / SPECIAL:';
const variants = (over: Record<string, unknown>) => ({
  colourId: 'MODENZA-01', fabricId: 'MODENZA', legHeight: 'Default', fabricCode: 'MODENZA-01',
  seatHeight: '28', colourLabel: 'MODENZA-01 HOUSTON CREAM', fabricLabel: 'MODENZA', ...over,
});
const row = (over: Partial<CollapsibleLine> & { item_code: string }): CollapsibleLine => ({
  item_group: 'sofa', qty: 1, unit_price_sen: 0, location: null, delivery_date: null, linked_ac_dtlkey: 184398, ...over,
});

const so2861 = (): CollapsibleLine[] => [
  row({ item_code: '8060-1A(LHF)', description: 'SOFA ZANO 1A(LHF)', unit_price_sen: 808800, description2: `${MOD} Nylon Fabric + +WOODEN ARM`, variants: variants({ specials: ['Nylon Fabric'], extraAddonNote: '+WOODEN ARM' }) }),
  row({ item_code: '8069-CNR', description: 'SOFA SOLANO CNR', description2: `${MOD} Bottom wrap nylon`, variants: variants({ extraAddonNote: 'Bottom wrap nylon' }) }),
  row({ item_code: '8060-1NA', description: 'SOFA ZANO 1NA', description2: `${MOD} Nylon Fabric + Bottom wrap nylon`, variants: variants({ specials: ['Nylon Fabric'], extraAddonNote: 'Bottom wrap nylon' }) }),
  row({ item_code: '8060-Console', description: 'SOFA ZANO CONSOLE', description2: `${MOD} Bottom wrap nylon`, variants: variants({ extraAddonNote: 'Bottom wrap nylon' }) }),
  row({ item_code: '8060-1B(RHF)', description: 'SOFA ZANO 1B(RHF)', description2: `${MOD} Bottom wrap nylon`, variants: variants({ extraAddonNote: 'Bottom wrap nylon' }) }),
];

describe('a sofa whose book line holds a piece of another model', () => {
  it('HC-SO-002861: the build is one line under its own key, and the foreign corner is named in the text', () => {
    const { lines, refusals } = collapseSofaLines(so2861());
    expect(refusals).toEqual([]);
    expect(lines).toHaveLength(1);
    const [l] = lines;
    expect([l.item_code, String(l.linked_ac_dtlkey), l.via, l.unit_price_sen]).toEqual(['8060-1S', '184398', 'compose', 808800]);
    expect(l.sourceIndexes).toEqual([0, 1, 2, 3, 4]);
    expect(l.description2).toMatch(/ \/ CNR 8069$/);
    expect(String(l.description2).length).toBeLessThanOrEqual(100);
    expect(parseSofa(String(l.description2), '8060', false).pieces).toEqual(['1A(LHF)', 'CNR', '1NA', 'Console', '1B(RHF)']);
  });

  it('CONTROL: the same build with its own model corner carries no note', () => {
    const rows = so2861().map((r) => (r.item_code === '8069-CNR' ? { ...r, item_code: '8060-CNR' } : r));
    const { lines, refusals } = collapseSofaLines(rows);
    expect(refusals).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0].description2).not.toMatch(/8069/);
  });

  it('CONTROL: two models with no majority under one key are still refused', () => {
    const rows = [
      row({ item_code: '8060-1A(LHF)', description2: `${MOD} Bottom wrap nylon`, variants: variants({}), unit_price_sen: 100 }),
      row({ item_code: '8069-1A(RHF)', description2: `${MOD} Bottom wrap nylon`, variants: variants({}) }),
    ];
    const { refusals } = collapseSofaLines(rows);
    expect(refusals.length).toBeGreaterThan(0);
  });

  it('CONTROL: pieces of another model under a DIFFERENT key are not gathered', () => {
    const rows = so2861().map((r) => (r.item_code === '8069-CNR' ? { ...r, linked_ac_dtlkey: 184399 } : r));
    const { lines } = collapseSofaLines(rows);
    expect(lines.some((l) => String(l.description2 ?? '').includes('CNR 8069'))).toBe(false);
  });
});
