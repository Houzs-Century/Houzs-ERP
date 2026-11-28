/* A supplier's rebates estimated from purchases (owner 2026-11-27: the sponsor rebate
   on everything bought less the named products and accessories, 「这3款不算」; the sales
   rebate by tier on everything bought less the display sets, 「这个减的就是display set」),
   with a made-up supplier and figures. Pinned:
     • the stored rules read leniently, a save checked strictly with words to fix;
     • a bill line is a named product, an accessory or counted;
     • each month: the sponsor base and rebate, the display sets from the display
       notes, the sales base, the tier it reaches and the rebate;
     • the display discount on the month's POs (owner 2026-11-28: the PO's own discount):
       a PO line whose discount is the display rate of its price, within RM 1;
     • the figures the selling department's other income shows, and their working. */

import { describe, expect, test } from 'vitest';
import {
  displayPoLines, displayPoWorking, isDisplayDiscountLine, parseSupplierRebates, readSupplierRebateRules, rebateFigures,
  rebateLineKind, rebateMonths, rebateWorking, tierBp,
  type RebateDisplayNote, type RebatePoLine, type RebatePurchaseLine, type SupplierRebateRule,
} from './supplier-rebates';

const RULE: SupplierRebateRule = {
  supplierCode: '400-R001', label: 'REBATE CO', sponsorBp: 1200, namedWords: ['ALPHA', 'BETA'], accessoryWords: ['PILLOW'],
  salesTiers: [{ fromSen: 8_000_000, bp: 200 }, { fromSen: 16_000_000, bp: 400 }, { fromSen: 24_000_000, bp: 600 }],
  displayDiscountBp: 4000,
};
const line = (month: string, sen: number, kind: RebatePurchaseLine['kind'], text = 'GOODS'): RebatePurchaseLine =>
  ({ month, day: `${month}-10`, docNo: `PI-${month}`, text, sen, kind });
const note = (month: string, sen: number): RebateDisplayNote => ({ month, day: `${month}-20`, noteNo: `SCN-${month}`, sen });
const poLine = (id: string, month: string, grossSen: number, discountSen: number): RebatePoLine =>
  ({ id, month, day: `${month}-05`, poNo: `HC-PO-${id}`, text: 'RC-MAT-K RC MATTRESS K', grossSen, discountSen });

describe('the stored rules', () => {
  test('read leniently: a rule without a supplier or with nothing to earn is dropped; codes and words upper-cased, tiers sorted', () => {
    const rules = parseSupplierRebates([
      { supplierCode: ' 400-r001 ', label: '', sponsorBp: 1200, namedWords: ['alpha', 'alpha', ' beta '], salesTiers: [{ fromSen: 200, bp: 5 }, { fromSen: 100, bp: 3 }, { fromSen: -1, bp: 9 }] },
      { supplierCode: '', sponsorBp: 1000 },
      { supplierCode: '400-R002', sponsorBp: 0, salesTiers: [] },
      'not a rule',
    ]);
    expect(rules).toEqual([{
      supplierCode: '400-R001', label: '400-R001', sponsorBp: 1200, namedWords: ['ALPHA', 'BETA'], accessoryWords: [],
      salesTiers: [{ fromSen: 100, bp: 3 }, { fromSen: 200, bp: 5 }], displayDiscountBp: 0,
    }]);
    expect(parseSupplierRebates(null)).toEqual([]);
    expect(parseSupplierRebates({ supplierCode: '400-R001' })).toEqual([]);
  });

  test('a save is checked strictly, every refusal naming what to fix', () => {
    const ok = readSupplierRebateRules([{ ...RULE, supplierCode: '400-r001', label: ' Rebate Co ' }]);
    expect(ok).toEqual({ ok: true, rules: [{ ...RULE, label: 'Rebate Co' }] });
    const bad = (rules: unknown) => { const r = readSupplierRebateRules(rules); return r.ok ? null : r.message; };
    expect(bad({})).toBe('Send the rules as a list.');
    expect(bad([{ sponsorBp: 100 }])).toBe('Rule 1: which supplier? Give its code.');
    expect(bad([RULE, RULE])).toBe('400-R001 has two rules — keep one.');
    expect(bad([{ ...RULE, sponsorBp: 10_001 }])).toMatch(/sponsor rebate is a percentage from 0 to 100/);
    expect(bad([{ ...RULE, displayDiscountBp: 1.5 }])).toMatch(/display discount is a percentage/);
    expect(bad([{ ...RULE, salesTiers: [{ fromSen: 200, bp: 5 }, { fromSen: 100, bp: 3 }] }])).toMatch(/from the lowest amount up/);
    expect(bad([{ ...RULE, salesTiers: [{ fromSen: 100, bp: 0 }] }])).toMatch(/rate is above 0/);
    expect(bad([{ ...RULE, sponsorBp: 0, salesTiers: [], displayDiscountBp: 0 }])).toBe('400-R001 earns nothing — give a sponsor rebate rate, a sales rebate tier or a display discount.');
    expect(bad([{ ...RULE, namedWords: 'ALPHA' }])).toMatch(/products left out is a list/);
    expect(readSupplierRebateRules([])).toEqual({ ok: true, rules: [] });
  });

  test('a rule with a display discount alone earns something, read or saved', () => {
    const displayOnly = { ...RULE, sponsorBp: 0, salesTiers: [] };
    expect(parseSupplierRebates([displayOnly])).toEqual([displayOnly]);
    expect(readSupplierRebateRules([displayOnly])).toEqual({ ok: true, rules: [displayOnly] });
  });
});

describe('a bill line, as the sponsor rebate reads it', () => {
  test('a named product by a word of its name; an accessory by its product\'s category, or by a word when it names no product', () => {
    expect(rebateLineKind(RULE, 'XYZ ALPHA MATTRESS (K)', 'MATTRESS')).toBe('named');
    expect(rebateLineKind(RULE, 'XYZ ALPHA PILLOW', 'ACCESSORY')).toBe('named');
    expect(rebateLineKind(RULE, 'XYZ SOFT COVER', 'ACCESSORY')).toBe('accessory');
    expect(rebateLineKind(RULE, 'XYZ PILLOW', 'MATTRESS')).toBe('counted');
    expect(rebateLineKind(RULE, 'Soft pillow', null)).toBe('accessory');
    expect(rebateLineKind(RULE, 'Gamma mattress', null)).toBe('counted');
  });
});

describe('each month', () => {
  test('the tier is the highest the base reaches; below the first there is none', () => {
    expect(tierBp(RULE.salesTiers, 7_999_999)).toBe(0);
    expect(tierBp(RULE.salesTiers, 8_000_000)).toBe(200);
    expect(tierBp(RULE.salesTiers, 23_999_999)).toBe(400);
    expect(tierBp(RULE.salesTiers, 45_000_000)).toBe(600);
  });

  test('the sponsor on purchases less named and accessories; the sales on purchases less display sets, at the tier that base reaches', () => {
    const months = rebateMonths(RULE, ['2026-09', '2026-10', '2026-11'], [
      line('2026-09', 30_000_000, 'counted'),
      line('2026-09', 5_000_000, 'named'),
      line('2026-09', 2_000_000, 'accessory'),
      line('2026-10', 1_000_000, 'counted'),
    ], [note('2026-09', 1_000_000)], []);
    expect(months[0]).toEqual({
      month: '2026-09', purchasesSen: 37_000_000, namedSen: 5_000_000, accessorySen: 2_000_000,
      sponsorBaseSen: 30_000_000, sponsorSen: 3_600_000,
      displayNotesSen: 1_000_000, displaySetSen: 2_500_000, salesBaseSen: 34_500_000, salesBp: 600, salesSen: 2_070_000,
      poDisplayLines: 0, poDisplaySen: 0,
    });
    expect(months[1]).toMatchObject({ purchasesSen: 1_000_000, sponsorSen: 120_000, salesBaseSen: 1_000_000, salesBp: 0, salesSen: 0 });
    expect(months[2]).toMatchObject({ purchasesSen: 0, sponsorSen: 0, salesSen: 0 });
  });

  test('a rule with no display discount takes no display sets off', () => {
    const [m] = rebateMonths({ ...RULE, displayDiscountBp: 0 }, ['2026-09'], [line('2026-09', 30_000_000, 'counted')], [note('2026-09', 1_000_000)], []);
    expect(m).toMatchObject({ displaySetSen: 0, salesBaseSen: 30_000_000, salesBp: 600, salesSen: 1_800_000 });
  });
});

describe('the display discount on the month\'s POs', () => {
  test('a PO line\'s own discount is the display discount when it is the display rate of its price, within RM 1', () => {
    expect(isDisplayDiscountLine(4000, 1_000_000, 400_000)).toBe(true);
    expect(isDisplayDiscountLine(4000, 1_000_000, 399_900)).toBe(true);
    expect(isDisplayDiscountLine(4000, 1_000_000, 400_100)).toBe(true);
    expect(isDisplayDiscountLine(4000, 1_000_000, 399_899)).toBe(false);
    expect(isDisplayDiscountLine(4000, 1_000_000, 100_000)).toBe(false);
    expect(isDisplayDiscountLine(0, 1_000_000, 0)).toBe(false);
    expect(isDisplayDiscountLine(4000, 0, 0)).toBe(false);
  });

  test('each month adds up its display-set lines\' discounts, by the PO\'s date; a rule without a display discount reads none', () => {
    const po = [
      poLine('a', '2026-09', 2_000_000, 800_000),
      poLine('b', '2026-09', 1_000_000, 399_950),
      poLine('c', '2026-09', 1_000_000, 100_000),
      poLine('d', '2026-10', 500_000, 200_000),
    ];
    expect(displayPoLines(RULE, po).map((l) => l.id)).toEqual(['a', 'b', 'd']);
    const months = rebateMonths(RULE, ['2026-09', '2026-10', '2026-11'], [], [], po);
    expect(months.map((m) => [m.month, m.poDisplayLines, m.poDisplaySen])).toEqual([
      ['2026-09', 2, 1_199_950], ['2026-10', 1, 200_000], ['2026-11', 0, 0],
    ]);
    expect(rebateMonths({ ...RULE, displayDiscountBp: 0 }, ['2026-09'], [], [], po)[0]).toMatchObject({ poDisplayLines: 0, poDisplaySen: 0 });
  });
});

describe('what the selling department shows', () => {
  const months = rebateMonths(RULE, ['2026-09', '2026-10'], [line('2026-09', 30_000_000, 'counted'), line('2026-10', 1_000_000, 'counted')], [], []);

  test('the figures under its other income, a month with nothing left out; a figure with nothing in it is not shown', () => {
    const figures = rebateFigures(RULE, months);
    expect(figures.map((f) => [f.id, f.cells])).toEqual([
      ['rebate:400-R001:sponsor', { '2026-09': 3_600_000, '2026-10': 120_000 }],
      ['rebate:400-R001:sales', { '2026-09': 1_800_000 }],
    ]);
    expect(figures[0]!.label).toBe('REBATE CO sponsor rebate (estimate) — 12% of purchases, less ALPHA, BETA and accessories');
    expect(figures[1]!.label).toBe('REBATE CO sales rebate (estimate) — 2% from 80,000, 4% from 160,000, 6% from 240,000 of purchases less display sets');
    expect(rebateFigures({ ...RULE, sponsorBp: 0 }, months).map((f) => f.id)).toEqual(['rebate:400-R001:sales']);
  });

  test('the display discount on the POs, a third figure', () => {
    const withPo = rebateMonths(RULE, ['2026-09', '2026-10'], [], [], [poLine('a', '2026-10', 2_000_000, 800_000)]);
    const display = rebateFigures(RULE, withPo).find((f) => f.id === 'rebate:400-R001:display');
    expect(display).toEqual({
      id: 'rebate:400-R001:display', label: "REBATE CO display discount (estimate) — 40% off the display sets on the month's POs", cells: { '2026-10': 800_000 },
    });
    expect(rebateFigures({ ...RULE, displayDiscountBp: 0 }, withPo).find((f) => f.id === 'rebate:400-R001:display')).toBeUndefined();
  });

  test('the working behind each, in words', () => {
    expect(rebateWorking(RULE, months[0]!, 'sponsor')).toBe("12% of RM 300,000.00: the month's REBATE CO bills RM 300,000.00, less ALPHA, BETA RM 0.00 and accessories RM 0.00");
    expect(rebateWorking(RULE, months[0]!, 'sales')).toBe("6% of RM 300,000.00: the month's REBATE CO bills RM 300,000.00, less display sets RM 0.00 (display discount notes RM 0.00 at 40%)");
    expect(displayPoWorking(RULE, poLine('a', '2026-10', 2_000_000, 800_000))).toBe('RC-MAT-K RC MATTRESS K: 40% off RM 20,000.00');
    expect(displayPoWorking(RULE, { ...poLine('a', '2026-10', 2_000_000, 800_000), text: '' })).toBe('40% off RM 20,000.00');
  });
});
