// ----------------------------------------------------------------------------
// A SOFA WITH NO GEOMETRY STILL COMES OUT LEFT TO RIGHT.
//
// The owner, 2026-08-28, looking at a purchase order whose chaise sat on the
// wrong side: 「排版都要从L开始啊 Left to right」 — and then the sharper diagnosis,
// which is the one this test encodes: 「这个的问题是跟着 SKU 排版下来…所以我们只需
// 要 control SKU 的顺序」. The plan follows the lines; fix the lines.
//
// `orderSofaCellsLeftToRight` sorts by real x/y and deliberately keeps the
// stored order when there is none — correct for a POS build, where a customer
// placed the furniture. A sofa built in the ERP never had geometry, so its
// modules stayed in whatever order somebody typed.
//
// AND THE BOUNDARY THE OWNER DREW: 「只针对新的order生效 旧的就不理了」. The new
// order applies where LINES ARE BORN and nowhere else — teaching the display
// path to reorder would re-sequence every existing order the next time anyone
// opened it. The last test here is that boundary.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { orderSofaCellsForNewLines, orderSofaCellsLeftToRight, sofaModuleHand } from './sofa-build';

type C = { moduleId: string; x?: number; y?: number; rot?: 0 };
const bare = (...ids: string[]): C[] => ids.map((moduleId) => ({ moduleId }));
const ids = (cells: readonly { moduleId: string }[]) => cells.map((c) => c.moduleId);

describe('a geometry-less sofa is ordered by its own handedness', () => {
  test('the case off the owner’s purchase order', () => {
    /* Typed L-first; must draw 2A on the left because 2A is LEFT-hand facing. */
    expect(ids(orderSofaCellsForNewLines(bare('L(RHF)', '2A(LHF)') as never, '24')))
      .toEqual(['2A(LHF)', 'L(RHF)']);
  });

  test('an armless middle stays between the two ends', () => {
    expect(ids(orderSofaCellsForNewLines(bare('L(RHF)', '1NA', '2A(LHF)') as never, '24')))
      .toEqual(['2A(LHF)', '1NA', 'L(RHF)']);
    expect(ids(orderSofaCellsForNewLines(bare('CNR', '1A(RHF)', '2A(LHF)') as never, '24')))
      .toEqual(['2A(LHF)', 'CNR', '1A(RHF)']);
  });

  test('an order that is ALREADY right is left alone', () => {
    const already = ['2A(LHF)', '1NA', 'L(RHF)'];
    expect(ids(orderSofaCellsForNewLines(bare(...already) as never, '24'))).toEqual(already);
  });

  test('it is STABLE — two pieces of the same hand keep the caller’s order', () => {
    /* Nothing distinguishes them, so the document is the only evidence there
       is. Reversing them would be inventing an answer. */
    expect(ids(orderSofaCellsForNewLines(bare('1A(LHF)', '1B(LHF)', 'L(RHF)') as never, '24')))
      .toEqual(['1A(LHF)', '1B(LHF)', 'L(RHF)']);
  });

  test('REAL GEOMETRY STILL WINS — a POS build is never re-sequenced', () => {
    /* A customer placed this furniture. The x coordinates say the RHF piece is
       on the left, and that is a fact about their living room, not a typo. */
    const placed = [
      { moduleId: '2A(LHF)', x: 200, y: 0, rot: 0 },
      { moduleId: '1A(RHF)', x: 0, y: 0, rot: 0 },
    ];
    expect(ids(orderSofaCellsForNewLines(placed as never, '24')))
      .toEqual(ids(orderSofaCellsLeftToRight(placed as never, '24')));
    expect(ids(orderSofaCellsForNewLines(placed as never, '24'))[0]).toBe('1A(RHF)');
  });

  test('hands are read off the code, not guessed', () => {
    expect(sofaModuleHand('2A(LHF)')).toBe('LHF');
    expect(sofaModuleHand('l(rhf)')).toBe('RHF');
    for (const mid of ['1NA', '2NA', 'CNR', 'STOOL', 'Console', '']) {
      expect(sofaModuleHand(mid), mid).toBe('MID');
    }
  });

  test('ONLY the line-creation path uses it — the display path is untouched', () => {
    /* 「只针对新的order生效 旧的就不理了」. so-line-display and the label builder
       must keep calling the geometry-only sorter, or every existing order would
       re-sequence the next time somebody opened it. */
    const split = readFileSync(new URL('./so-sofa-split.ts', import.meta.url), 'utf8');
    const display = readFileSync(new URL('./so-line-display.ts', import.meta.url), 'utf8');
    expect(split).toContain('orderSofaCellsForNewLines');
    expect(display).not.toContain('orderSofaCellsForNewLines');
    expect(display).toContain('orderSofaCellsLeftToRight');
  });
});
