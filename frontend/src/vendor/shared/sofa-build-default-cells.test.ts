// buildDefaultSofaCells — the PO PDF's layout for a sofa booked as a bare
// module list. Corners turn the run (owner 2026-09-28, HC-SO-2609-221: a U with
// two CNRs was drawn as one straight row).
import { describe, expect, it } from 'vitest';
import { buildDefaultSofaCells, cellEdges } from './sofa-build';

const mods = (...ids: string[]) => ids.map((moduleId) => ({ moduleId }));
const shape = (ids: string[]) =>
  buildDefaultSofaCells(mods(...ids), '24').map((c) => [c.moduleId, c.x, c.y, c.rot]);

describe('buildDefaultSofaCells', () => {
  it('no corner: a straight row, left to right (unchanged)', () => {
    expect(shape(['2A(LHF)', 'L(RHF)'])).toEqual([['2A(LHF)', 0, 0, 0], ['L(RHF)', 158, 0, 0]]);
  });

  it('two corners in walking order draw a U, legs forward, arms at the front', () => {
    const cells = buildDefaultSofaCells(mods('1A(LHF)', 'CNR', '2NA', '1NA', 'CNR', '1A(RHF)'), '24');
    expect(cells.map((c) => [c.moduleId, c.x, c.y, c.rot])).toEqual([
      ['1A(LHF)', 0, 95, 270],
      ['CNR', 0, 0, 0],
      ['2NA', 95, 0, 0],
      ['1NA', 237, 0, 0],
      ['CNR', 312, 0, 90],
      ['1A(RHF)', 312, 95, 90],
    ]);
    // Each leg's arm is on its FRONT end (toward the TV), its back to the outside.
    const leftLeg = cellEdges(cells[0]!);
    const rightLeg = cellEdges(cells[5]!);
    expect([leftLeg[0], leftLeg[3]]).toEqual(['back', 'arm']);
    expect([rightLeg[2], rightLeg[3]]).toEqual(['back', 'arm']);
    // Corners have their backrests on the outside of the U.
    expect(cellEdges(cells[1]!).slice(0, 2)).toEqual(['arm', 'arm']);
    expect(cellEdges(cells[4]!).slice(1, 3)).toEqual(['arm', 'arm']);
  });

  it('a "CNR x2" line (corners adjacent, position lost) still draws the U', () => {
    expect(shape(['1A(LHF)', '2NA', '1NA', 'CNR', 'CNR', '1A(RHF)']))
      .toEqual(shape(['1A(LHF)', 'CNR', '2NA', '1NA', 'CNR', '1A(RHF)']));
  });

  it('one corner draws an L with the longer run along the back', () => {
    expect(shape(['1A(LHF)', 'CNR', '2NA', '1A(RHF)'])).toEqual([
      ['1A(LHF)', 0, 95, 270], ['CNR', 0, 0, 0], ['2NA', 95, 0, 0], ['1A(RHF)', 237, 0, 0],
    ]);
    expect(shape(['2A(LHF)', 'CNR'])).toEqual([['2A(LHF)', 0, 0, 0], ['CNR', 158, 0, 90]]);
  });
});
