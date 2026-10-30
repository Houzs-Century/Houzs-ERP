/* HC-0182: the reader behind rehome-kiv-bedframe-lines.mjs. The texts are real
 * Desc2 values from the sales lines on "BEDFRAME KIV LV2" (diag run 40852980692).
 * A line moves only on one level AND one size; every other text stays put.
 */
import { describe, it, expect } from 'vitest';
import { lineTarget, lineText, planKivRehome, confirmPhrase, RENAMES, OLD_CODE } from '../scripts/lib/kiv-bedframe-line-target.mjs';

describe('lineTarget', () => {
  it.each([
    ['LVL 1 QUEEN', 'BEDFRAME KIV LV1-(Q)'],
    ['Lv1Queen/col:kiv/divan:8inch kiv/gap:14inch', 'BEDFRAME KIV LV1-(Q)'],
    ['lvl1queen/Divan:8\'\'+4"Leg/Gap:12\'\'/Col:KIV', 'BEDFRAME KIV LV1-(Q)'],
    ['king lv2 Col:tbc/gap:14inch/divan:8inch no leg', 'BEDFRAME KIV LV2-(K)'],
    ['Level 2 (Queen)', 'BEDFRAME KIV LV2-(Q)'],
    ['Lvl2(K) Drawer /Col: /Div:8" + /M\'GP: "', 'BEDFRAME KIV LV2-(K)'],
    ['Lvl 3king/Divan:8\'\'+4" Leg/Gap:14\'/Col:KIV', 'BEDFRAME KIV LV3-(K)'],
    ['Lv1 K', 'BEDFRAME KIV LV1-(K)'],
    ['Level 2 SK size', 'BEDFRAME KIV LV2-(SK)'],
    ['LVL 1 , size : super single ', 'BEDFRAME KIV LV1-(SS)'],
    ['SINGLE LVL1', 'BEDFRAME KIV LV1-(S)'],
    ['L3/210cmx210cm/Divan:8”+no leg/Mgap:14”/Col:tbc', 'BEDFRAME KIV LV3-(SP)'],
    ['KING LVL1/DIVAN:8"+2"LEG/MATTRESSGAP:14"/COLOR:PC151-', 'BEDFRAME KIV LV1-(K)'],
    ['LVL3 2.0/COL:KIV/GAP:14" / DIVAN 12+0', undefined],
  ])('%s -> %s', (text, code) => {
    expect(lineTarget(text).target).toBe(code);
  });

  it.each([
    ['tbc', 'NO_LEVEL_NO_SIZE'],
    ['', 'NO_LEVEL_NO_SIZE'],
    ['DIVAN 10" + LEG 6" / GAP 14" / T.Heights 30"', 'NO_LEVEL_NO_SIZE'],
    ['MATTRESSGAP:10"/DIVAN:8"+4"LEG/COLOR:PC151-', 'NO_LEVEL_NO_SIZE'],
    ['queen ', 'NO_LEVEL'],
    ['Q TBC', 'NO_LEVEL'],
    ['LEVEL 1 BEDFRAME', 'NO_SIZE'],
    ['K X1 Q X1/COL:KIV/DIVAN:8 NO LEG/GAP:10/12INCH', 'TWO_BEDS_OR_CHOICES'],
    ['lv3 k,lv1 q/col:kiv/gap:12inch/divan:8inch no leg', 'TWO_BEDS_OR_CHOICES'],
    ['level 2 or level 3 (Q)/ Col: KIV/ Gap: 14"', 'TWO_BEDS_OR_CHOICES'],
    ['LVL1 King & Queen', 'TWO_BEDS_OR_CHOICES'],
    ['1K LVL3 / 2Q LVL1 (ALL 8"+4"LEG)', 'TWO_BEDS_OR_CHOICES'],
    ['LV1 K x1 s x2/col:kiv/divan8+4/gap:12inch', 'TWO_BEDS_OR_CHOICES'],
  ])('%s stays (%s)', (text, reason) => {
    const t = lineTarget(text);
    expect(t.target).toBeUndefined();
    expect(t.stay).toBe(reason);
  });

  it('reads the costing model name as its level (LV1 Jager, LV2 Cody, LV3 Regal, LV4 Trion)', () => {
    expect(lineTarget('JAGER QUEEN').target).toBe('BEDFRAME KIV LV1-(Q)');
    expect(lineTarget('cody king').target).toBe('BEDFRAME KIV LV2-(K)');
    expect(lineTarget('Trion (Q)').target).toBe('BEDFRAME KIV LV4-(Q)');
    expect(lineTarget('regal or trion K').stay).toBe('TWO_BEDS_OR_CHOICES');
  });

  it('takes the size from the order\'s one mattress size when the text has none (SO-001223)', () => {
    const t = lineTarget('LVL 2 / DIVAN 8" / GAP 12"', { mattressSizes: ['Q', 'Q'] });
    expect(t.target).toBe('BEDFRAME KIV LV2-(Q)');
    expect(t.sizeFrom).toBe('mattress');
    expect(lineTarget('LVL 2 / DIVAN 8"', { mattressSizes: ['Q', 'K'] }).stay).toBe('NO_SIZE_MATTRESSES_DIFFER');
    expect(lineTarget('LVL 1 KING', { mattressSizes: ['Q'] }).target).toBe('BEDFRAME KIV LV1-(K)');
  });

  it('gives an unnamed level LV2 only when the default is switched on', () => {
    expect(lineTarget('DIVAN 8" / GAP 12" / T.Heights 20"', { mattressSizes: ['Q'] }).stay).toBe('NO_LEVEL');
    const t = lineTarget('DIVAN 8" / GAP 12" / T.Heights 20"', { mattressSizes: ['Q'], defaultLevel: '2' });
    expect(t.target).toBe('BEDFRAME KIV LV2-(Q)');
    expect(t.levelFrom).toBe('default');
    expect(lineTarget('tbc', { defaultLevel: '2' }).stay).toBe('NO_LEVEL_NO_SIZE');
  });

  it('reads Desc2 and the remark together, so a remark can contradict Desc2', () => {
    expect(lineText({ description2: 'LV1 KING', remark: null, variants: { remark: 'queen' } })).toBe('LV1 KING / queen');
    expect(lineTarget(lineText({ description2: 'LV1 KING', variants: { remark: 'queen' } })).stay).toBe('TWO_BEDS_OR_CHOICES');
  });
});

describe('planKivRehome', () => {
  const MODEL = 'm-lv2';
  const world = (over = {}) => ({
    products: [
      { code: OLD_CODE, model_id: MODEL, status: 'ACTIVE' },
      ...RENAMES.map((r) => ({ code: r.from, model_id: MODEL, status: 'ACTIVE' })),
      { code: 'BEDFRAME KIV LV1-(Q)', model_id: 'm-lv1', status: 'ACTIVE' },
    ],
    refsOnRename: [],
    lines: [
      { id: 'a', text: 'LVL 1 QUEEN', openAmendment: false },
      { id: 'b', text: 'Level 2 (Queen)', openAmendment: false },
      { id: 'c', text: 'tbc', openAmendment: false },
      { id: 'd', text: 'LVL3 KING', openAmendment: false },
      { id: 'e', text: 'LV1 Q', openAmendment: true },
    ],
    ...over,
  });

  it('renames the six level-less codes and moves only the lines it can read', () => {
    const plan = planKivRehome(world());
    expect(plan.refusals).toEqual([]);
    expect(plan.renames.map((r) => r.to)).toContain('BEDFRAME KIV LV2-(Q)');
    expect(plan.moves.map((m) => [m.id, m.target])).toEqual([
      ['a', 'BEDFRAME KIV LV1-(Q)'],
      ['b', 'BEDFRAME KIV LV2-(Q)'],
    ]);
    expect(plan.stays.map((s) => [s.id, s.reason])).toEqual([
      ['c', 'NO_LEVEL_NO_SIZE'],
      ['d', 'TARGET_MISSING'],
      ['e', 'OPEN_AMENDMENT'],
    ]);
    expect(confirmPhrase(plan)).toBe('REHOME KIV: RENAME 6, MOVE 2 LINES, LEAVE 3');
  });

  it('names the default-level moves in the CONFIRM phrase', () => {
    const plan = planKivRehome(world({
      defaultLevel: '2',
      lines: [
        { id: 'a', text: 'LVL 1 QUEEN', openAmendment: false },
        { id: 'f', text: 'queen', openAmendment: false },
      ],
    }));
    expect(plan.moves.map((m) => [m.id, m.target, m.levelFrom])).toEqual([
      ['a', 'BEDFRAME KIV LV1-(Q)', 'text'],
      ['f', 'BEDFRAME KIV LV2-(Q)', 'default'],
    ]);
    expect(confirmPhrase(plan)).toBe('REHOME KIV: RENAME 6, MOVE 2 LINES (1 AS LV2 BY DEFAULT), LEAVE 0');
  });

  it('refuses a rename onto a code that already exists', () => {
    const w = world();
    w.products.push({ code: 'BEDFRAME KIV LV2-(K)', model_id: MODEL, status: 'ACTIVE' });
    expect(planKivRehome(w).refusals.join(' ')).toMatch(/LV2-\(K\) already exists/);
  });

  it('refuses to rename a code something already uses', () => {
    const plan = planKivRehome(world({ refsOnRename: [{ code: 'BEDFRAME KIV-(Q)', table: 'mfg_sales_order_items', rows: 1 }] }));
    expect(plan.refusals.join(' ')).toMatch(/KIV-\(Q\) is already used/);
  });

  it('refuses a rename source that belongs to another model', () => {
    const w = world();
    w.products.find((p) => p.code === 'BEDFRAME KIV-(S)').model_id = 'm-other';
    expect(planKivRehome(w).refusals.join(' ')).toMatch(/KIV-\(S\) is not on the/);
  });

  it('is convergent: after the rename and the moves it plans nothing new', () => {
    const plan = planKivRehome(world({
      products: [
        { code: OLD_CODE, model_id: MODEL, status: 'ACTIVE' },
        ...RENAMES.map((r) => ({ code: r.to, model_id: MODEL, status: 'ACTIVE' })),
      ],
      lines: [{ id: 'c', text: 'tbc', openAmendment: false }],
    }));
    expect(plan.refusals).toEqual([]);
    expect(plan.renames).toEqual([]);
    expect(plan.moves).toEqual([]);
  });
});
