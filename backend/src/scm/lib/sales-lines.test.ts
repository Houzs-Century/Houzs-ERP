/* The 2990 POS Marketing sales lines. Shapes from company 2's live orders
 * (2026-10-08): builds stamped with buildKey + cellIndex, the older unkeyed
 * pairs that store the priced compartment first whichever side it sits on
 * (2990-SO-2607-003), and headrests added after a build was keyed
 * (2990-SO-2608-064). Pinned: one row per sofa build, compartments left to
 * right; everything else 1:1; age on the order date, never the birthday. */
import { describe, expect, it } from 'vitest';
import { foldSalesLines, type SalesLinesItem, type SalesLinesOrder, type SalesLinesProduct } from './sales-lines';

const order = (docNo: string, extra: Partial<SalesLinesOrder> = {}): SalesLinesOrder => ({
  docNo, soDate: '2026-10-04', venue: '2990s PJ', customerId: 'cust-1',
  race: 'Chinese', birthday: '1990-10-05', gender: 'Female', state: 'Selangor', ...extra,
});

const item = (docNo: string, itemCode: string, extra: Partial<SalesLinesItem> = {}): SalesLinesItem => ({
  docNo, lineNo: null, itemCode, itemGroup: null, qty: 1, totalSen: 0, buildKey: null, cellIndex: null, ...extra,
});

const products = new Map<string, SalesLinesProduct>([
  ['XAMMAR-1A(LHF)', { category: 'SOFA', modelId: 'm-xammar', sizeCode: null, sizeLabel: null, baseModel: 'Xammar' }],
  ['XAMMAR-2A(RHF)', { category: 'SOFA', modelId: 'm-xammar', sizeCode: null, sizeLabel: null, baseModel: 'Xammar' }],
  ['TRRBU-2A(RHF)', { category: 'SOFA', modelId: null, sizeCode: null, sizeLabel: null, baseModel: 'Trrbu' }],
  ['TRRBU-L(LHF)', { category: 'SOFA', modelId: null, sizeCode: null, sizeLabel: null, baseModel: 'Trrbu' }],
  ['ANNSA-2S', { category: 'SOFA', modelId: 'm-annsa', sizeCode: null, sizeLabel: null, baseModel: 'Annsa' }],
  ['ANNSA-HEADREST', { category: 'SOFA', modelId: 'm-annsa', sizeCode: null, sizeLabel: null, baseModel: 'Annsa' }],
  ['AM-9036-2A(LHF)', { category: 'SOFA', modelId: null, sizeCode: null, sizeLabel: null, baseModel: 'AM-9036' }],
  ['AKKA-FIRM-(K)', { category: 'MATTRESS', modelId: 'm-akka', sizeCode: 'K', sizeLabel: '6FT', baseModel: 'AKKA-FIRM' }],
]);
const models = new Map([['m-xammar', 'XAMMAR'], ['m-annsa', 'ANNSA'], ['m-akka', 'AKKA-FIRM']]);

describe('foldSalesLines', () => {
  it('folds a keyed sofa build into one row, compartments in the order the POS laid them out', () => {
    const rows = foldSalesLines(
      [order('SO-1')],
      [
        // Stored rows come back in uuid order, not line order.
        item('SO-1', 'XAMMAR-2A(RHF)', { lineNo: 1, cellIndex: 1, buildKey: 'build-1', totalSen: 157111 }),
        item('SO-1', 'XAMMAR-1A(LHF)', { lineNo: 0, cellIndex: 0, buildKey: 'build-1', totalSen: 104389 }),
      ],
      products, models,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: 'SOFA', model: 'XAMMAR', modules: ['1A(LHF)', '2A(RHF)'], qty: 1, totalSen: 261500,
      sizeCode: null, sizeLabel: null,
    });
  });

  it('orders an unplaced build left arm, armless, right arm — line order is not reliable there', () => {
    const rows = foldSalesLines(
      [order('SO-2607-003')],
      [
        item('SO-2607-003', 'TRRBU-2A(RHF)', { lineNo: 0, totalSen: 299000 }),
        item('SO-2607-003', 'TRRBU-L(LHF)', { lineNo: 1, totalSen: 0 }),
      ],
      products, models,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: 'Trrbu', modules: ['L(LHF)', '2A(RHF)'], totalSen: 299000 });
  });

  it('joins an unkeyed compartment of the same Model to that order\'s keyed build', () => {
    const rows = foldSalesLines(
      [order('SO-2608-064')],
      [
        item('SO-2608-064', 'ANNSA-2S', { lineNo: 0, cellIndex: 0, buildKey: 'build-1', totalSen: 306500 }),
        item('SO-2608-064', 'ANNSA-HEADREST', { lineNo: 2, cellIndex: 0, qty: 2 }),
      ],
      products, models,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: 'ANNSA', modules: ['2S', 'HEADREST'], qty: 1, totalSen: 306500 });
  });

  it('keeps two keyed builds on one order apart', () => {
    const rows = foldSalesLines(
      [order('SO-3')],
      [
        item('SO-3', 'ANNSA-2S', { lineNo: 0, cellIndex: 0, buildKey: 'build-1', totalSen: 100 }),
        item('SO-3', 'ANNSA-2S', { lineNo: 1, cellIndex: 0, buildKey: 'build-2', totalSen: 200 }),
      ],
      products, models,
    );
    expect(rows.map((r) => r.totalSen).sort()).toEqual([100, 200]);
  });

  it('counts sets: a build is as many sets as its scarcest compartment', () => {
    const rows = foldSalesLines(
      [order('SO-4')],
      [
        item('SO-4', 'XAMMAR-1A(LHF)', { lineNo: 0, qty: 2, totalSen: 1 }),
        item('SO-4', 'XAMMAR-2A(RHF)', { lineNo: 1, qty: 1, totalSen: 1 }),
      ],
      products, models,
    );
    expect(rows[0]!.qty).toBe(1);
  });

  it('reads the compartment after a base model that itself contains a dash', () => {
    const rows = foldSalesLines([order('SO-5')], [item('SO-5', 'AM-9036-2A(LHF)', { lineNo: 0 })], products, models);
    expect(rows[0]!.modules).toEqual(['2A(LHF)']);
  });

  it('maps every other line 1:1 with its size and the order\'s customer facts', () => {
    const rows = foldSalesLines(
      [order('SO-6', { venue: ' 2990s PJ ', state: '', race: null })],
      [item('SO-6', 'AKKA-FIRM-(K)', { lineNo: 0, qty: 2, totalSen: 298000 })],
      products, models,
    );
    expect(rows).toEqual([{
      docNo: 'SO-6', soDate: '2026-10-04', venue: '2990s PJ', category: 'MATTRESS', model: 'AKKA-FIRM',
      modules: [], sizeCode: 'K', sizeLabel: '6FT', qty: 2, totalSen: 298000,
      customerId: 'cust-1', race: null, age: 35, gender: 'Female', state: null,
    }]);
  });

  it('sends the age on the order date and never the birthday', () => {
    const [before] = foldSalesLines(
      [order('SO-7', { soDate: '2026-10-04', birthday: '1990-10-05' })],
      [item('SO-7', 'AKKA-FIRM-(K)')], products, models,
    );
    const [onBirthday] = foldSalesLines(
      [order('SO-8', { soDate: '2026-10-05', birthday: '1990-10-05' })],
      [item('SO-8', 'AKKA-FIRM-(K)')], products, models,
    );
    expect(before!.age).toBe(35);
    expect(onBirthday!.age).toBe(36);
    expect(JSON.stringify(before)).not.toContain('1990');
    for (const birthday of ['not-a-date', '2027-01-01', null]) {
      const [row] = foldSalesLines([order('SO-9', { birthday })], [item('SO-9', 'AKKA-FIRM-(K)')], products, models);
      expect(row!.age, String(birthday)).toBeNull();
    }
  });

  it('drops lines whose order is not in the loaded set (cancelled, draft, on hold)', () => {
    expect(foldSalesLines([order('SO-10')], [item('SO-11', 'AKKA-FIRM-(K)')], products, models)).toEqual([]);
  });

  it('names a line with no product row by its item code', () => {
    const [row] = foldSalesLines([order('SO-12')], [item('SO-12', 'LATEX-PILLOW', { itemGroup: 'accessory' })], products, models);
    expect(row).toMatchObject({ category: 'ACCESSORY', model: 'LATEX-PILLOW', modules: [] });
  });
});
