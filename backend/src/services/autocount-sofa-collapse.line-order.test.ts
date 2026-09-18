import { describe, expect, it } from 'vitest';
import { collapseSofaLines, type CollapsibleLine } from './autocount-sofa-collapse';

/* THE ARRANGEMENT FOLLOWS THE DOCUMENT'S LINE ORDER (docs/bugs/0920).
 * HC-SO-002861 on 2026-09-15: five pieces of one book line whose amendment
 * re-derived them at one instant, so the queue's read order (created_at, then
 * the row id) is effectively random. The book was sent
 * `1EL + C + 1B + CT + 1NA`; the salesperson's lines read 1A(LHF), CNR, 1NA,
 * Console, 1B(RHF). Rows below are in the order the queue read them. */
const TEXT = 'MODENZA-01 HOUSTON CREAM / SEAT 28 / LEG DEFAULT / SPECIAL: Bottom wrap nylon';
const variants = { colourLabel: 'MODENZA-01 HOUSTON CREAM', seatHeight: '28' };
const row = (item_code: string, line_no: number | null, over: Partial<CollapsibleLine> = {}): CollapsibleLine => ({
  item_code, line_no, item_group: 'sofa', qty: 1, unit_price_sen: 0, description2: TEXT, variants, linked_ac_dtlkey: 184398, ...over,
});

const asQueued = (): CollapsibleLine[] => [
  row('8060-1A(LHF)', 1, { unit_price_sen: 808800, variants: { ...variants, specials: ['Nylon Fabric'] } }),
  row('8069-CNR', 2),
  row('8060-1B(RHF)', 5),
  row('8060-Console', 4),
  row('8060-1NA', 3),
];

describe('a sofa composed from pieces read out of line order', () => {
  it('HC-SO-002861: the pieces are spelled in the order of the document lines', () => {
    const { lines, refusals } = collapseSofaLines(asQueued());
    expect(refusals).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0].description2).toMatch(/^1EL \+ C \+ 1NA \+ CT \+ 1B \(28"\)/);
  });

  it('CONTROL: pieces with no line numbers keep the order they arrived in', () => {
    const rows = asQueued().map((r) => ({ ...r, line_no: null }));
    const { lines } = collapseSofaLines(rows);
    expect(lines[0].description2).toMatch(/^1EL \+ C \+ 1B \+ CT \+ 1NA \(28"\)/);
  });
});
