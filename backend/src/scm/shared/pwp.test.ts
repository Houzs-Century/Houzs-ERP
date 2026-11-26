import { describe, it, expect } from 'vitest';
import { resolvePwp, type PwpRule, type PwpLineInput } from './pwp';

const RULE: PwpRule = {
  triggerCategory: 'MATTRESS',
  triggerEligibleModelIds: ['m-ok'],
  rewardCategory: 'BEDFRAME',
  eligibleRewardModelIds: ['b-ok'],
  qtyPerTrigger: 1,
};

type LineOpts = {
  qty?: number; name?: string; code?: string; pwp?: boolean; isReward?: boolean;
  sizeCode?: string | null; builtCompartments?: string[];
};
const line = (idx: number, category: string, modelId: string | null, o: LineOpts = {}): PwpLineInput => ({
  idx,
  category,
  modelId,
  qty: o.qty ?? 1,
  productName: o.name,
  itemCode: o.code,
  pwpRequested: o.pwp ?? false,
  ...(o.isReward !== undefined ? { isReward: o.isReward } : {}),
  ...(o.sizeCode !== undefined ? { sizeCode: o.sizeCode } : {}),
  ...(o.builtCompartments !== undefined ? { builtCompartments: o.builtCompartments } : {}),
});

const grantedIdx = (rules: PwpRule[], lines: PwpLineInput[]): number[] =>
  resolvePwp(rules, lines).map((g) => g.idx).sort((a, b) => a - b);

describe('resolvePwp', () => {
  it('grants each requested reward up to allowance (3 mattress → 3 bedframes)', () => {
    const lines = [
      line(0, 'MATTRESS', 'm-ok'),
      line(1, 'MATTRESS', 'm-ok'),
      line(2, 'MATTRESS', 'm-ok'),
      line(3, 'BEDFRAME', 'b-ok', { pwp: true }),
      line(4, 'BEDFRAME', 'b-ok', { pwp: true }),
      line(5, 'BEDFRAME', 'b-ok', { pwp: true }),
    ];
    expect(grantedIdx([RULE], lines)).toEqual([3, 4, 5]);
  });

  it('the 4th bedframe is NOT granted when only 3 mattresses bought (over allowance)', () => {
    const lines = [
      line(0, 'MATTRESS', 'm-ok'),
      line(1, 'MATTRESS', 'm-ok'),
      line(2, 'MATTRESS', 'm-ok'),
      line(3, 'BEDFRAME', 'b-ok', { pwp: true }),
      line(4, 'BEDFRAME', 'b-ok', { pwp: true }),
      line(5, 'BEDFRAME', 'b-ok', { pwp: true }),
      line(6, 'BEDFRAME', 'b-ok', { pwp: true }),
    ];
    expect(grantedIdx([RULE], lines)).toEqual([3, 4, 5]);
  });

  it('no qualifying trigger → no grants', () => {
    const lines = [line(0, 'BEDFRAME', 'b-ok', { pwp: true })];
    expect(grantedIdx([RULE], lines)).toEqual([]);
  });

  it('trigger model NOT in the eligible list does not unlock', () => {
    const lines = [
      line(0, 'MATTRESS', 'm-other'),
      line(1, 'BEDFRAME', 'b-ok', { pwp: true }),
    ];
    expect(grantedIdx([RULE], lines)).toEqual([]);
  });

  it('reward model NOT in the eligible list is not granted', () => {
    const lines = [
      line(0, 'MATTRESS', 'm-ok'),
      line(1, 'BEDFRAME', 'b-other', { pwp: true }),
    ];
    expect(grantedIdx([RULE], lines)).toEqual([]);
  });

  it('does not grant a reward line that was not toggled (pwpRequested=false)', () => {
    const lines = [
      line(0, 'MATTRESS', 'm-ok'),
      line(1, 'BEDFRAME', 'b-ok', { pwp: false }),
    ];
    expect(grantedIdx([RULE], lines)).toEqual([]);
  });

  it('qtyPerTrigger scales the allowance (1 mattress → 2 bedframes)', () => {
    const rule: PwpRule = { ...RULE, qtyPerTrigger: 2 };
    const lines = [
      line(0, 'MATTRESS', 'm-ok'),
      line(1, 'BEDFRAME', 'b-ok', { pwp: true }),
      line(2, 'BEDFRAME', 'b-ok', { pwp: true }),
      line(3, 'BEDFRAME', 'b-ok', { pwp: true }),
    ];
    expect(grantedIdx([rule], lines)).toEqual([1, 2]);
  });

  it('empty eligible lists mean the whole category qualifies', () => {
    const rule: PwpRule = { ...RULE, triggerEligibleModelIds: [], eligibleRewardModelIds: [] };
    const lines = [
      line(0, 'MATTRESS', 'anything'),
      line(1, 'BEDFRAME', 'whatever', { pwp: true }),
    ];
    expect(grantedIdx([rule], lines)).toEqual([1]);
  });

  it('binds each granted reward to a specific trigger unit (greedy by order)', () => {
    const lines = [
      line(0, 'MATTRESS', 'm-ok', { name: 'Sealy Posture', code: 'SLY-Q' }),
      line(1, 'MATTRESS', 'm-ok', { name: 'King Koil', code: 'KK-Q' }),
      line(2, 'BEDFRAME', 'b-ok', { pwp: true }),
      line(3, 'BEDFRAME', 'b-ok', { pwp: true }),
    ];
    const grants = resolvePwp([RULE], lines);
    expect(grants.find((g) => g.idx === 2)?.triggerRef).toEqual({ name: 'Sealy Posture', code: 'SLY-Q' });
    expect(grants.find((g) => g.idx === 3)?.triggerRef).toEqual({ name: 'King Koil', code: 'KK-Q' });
  });

  it('a multi-qty reward line is all-or-nothing against the allowance', () => {
    const lines = [
      line(0, 'MATTRESS', 'm-ok', { qty: 3 }),
      line(1, 'BEDFRAME', 'b-ok', { pwp: true, qty: 2 }),
      line(2, 'BEDFRAME', 'b-ok', { pwp: true, qty: 2 }),
    ];
    expect(grantedIdx([RULE], lines)).toEqual([1]);
  });

  it('a legacy line with null modelId never matches a non-empty model list', () => {
    const lines = [
      line(0, 'MATTRESS', null),
      line(1, 'BEDFRAME', 'b-ok', { pwp: true }),
    ];
    expect(grantedIdx([RULE], lines)).toEqual([]);
  });
});

describe('resolvePwp — multiple differentiated rules', () => {
  const RULE_A: PwpRule = { triggerCategory: 'MATTRESS', triggerEligibleModelIds: ['akka'], rewardCategory: 'BEDFRAME', eligibleRewardModelIds: ['aria'], qtyPerTrigger: 1 };
  const RULE_B: PwpRule = { triggerCategory: 'MATTRESS', triggerEligibleModelIds: ['ketta'], rewardCategory: 'BEDFRAME', eligibleRewardModelIds: ['orient'], qtyPerTrigger: 1 };

  it('each reward is granted by its own rule', () => {
    const lines = [
      line(0, 'MATTRESS', 'akka'),
      line(1, 'MATTRESS', 'ketta'),
      line(2, 'BEDFRAME', 'aria', { pwp: true }),
      line(3, 'BEDFRAME', 'orient', { pwp: true }),
    ];
    expect(grantedIdx([RULE_A, RULE_B], lines)).toEqual([2, 3]);
  });

  it('a reward is NOT granted when only the OTHER rule’s trigger was bought', () => {
    const lines = [
      line(0, 'MATTRESS', 'akka'),
      line(1, 'BEDFRAME', 'orient', { pwp: true }),
    ];
    expect(grantedIdx([RULE_A, RULE_B], lines)).toEqual([]);
  });

  it('the matching reward IS granted; the mismatched one is not', () => {
    const lines = [
      line(0, 'MATTRESS', 'akka'),
      line(1, 'BEDFRAME', 'aria', { pwp: true }),
      line(2, 'BEDFRAME', 'orient', { pwp: true }),
    ];
    expect(grantedIdx([RULE_A, RULE_B], lines)).toEqual([1]);
  });

  it('binds the reward to its rule’s trigger (triggerRef)', () => {
    const lines = [
      line(0, 'MATTRESS', 'akka', { name: '2990 AKKA-FIRM' }),
      line(1, 'MATTRESS', 'ketta', { name: '2990 KETTA-SOFT' }),
      line(2, 'BEDFRAME', 'orient', { pwp: true }),
    ];
    const grants = resolvePwp([RULE_A, RULE_B], lines);
    expect(grants.find((g) => g.idx === 2)?.triggerRef?.name).toBe('2990 KETTA-SOFT');
  });
});


describe('resolvePwp - promo one-way', () => {
  const PROMO: PwpRule = {
    triggerCategory: 'MATTRESS',
    triggerEligibleModelIds: ['arrus'],
    rewardCategory: 'MATTRESS',
    eligibleRewardModelIds: ['arrus'],
    qtyPerTrigger: 1,
    type: 'promo',
  };
  const PWP_BED: PwpRule = {
    triggerCategory: 'MATTRESS',
    triggerEligibleModelIds: ['arrus'],
    rewardCategory: 'BEDFRAME',
    eligibleRewardModelIds: ['b-ok'],
    qtyPerTrigger: 1,
    type: 'pwp',
  };

  it('a full-price ARRUS funds ONE free ARRUS (the normal sale)', () => {
    const lines = [
      line(0, 'MATTRESS', 'arrus'),
      line(1, 'MATTRESS', 'arrus', { pwp: true }),
    ];
    expect(grantedIdx([PROMO], lines)).toEqual([1]);
  });

  it('a reward ARRUS line creates NO promo slots - free cannot fund free', () => {
    const lines = [
      line(0, 'MATTRESS', 'arrus', { isReward: true }),
      line(1, 'MATTRESS', 'arrus', { pwp: true }),
    ];
    expect(grantedIdx([PROMO], lines)).toEqual([]);
  });

  it('an ARRUS cannot be its own trigger (pwpRequested excluded from promo slots)', () => {
    const lines = [line(0, 'MATTRESS', 'arrus', { pwp: true })];
    expect(grantedIdx([PROMO], lines)).toEqual([]);
  });

  it('the reward ARRUS still triggers a pwp rule (chains stay allowed)', () => {
    const lines = [
      line(0, 'MATTRESS', 'arrus', { isReward: true }),
      line(1, 'BEDFRAME', 'b-ok', { pwp: true }),
    ];
    expect(grantedIdx([PWP_BED], lines)).toEqual([1]);
  });

  it('a rule without type behaves as pwp (reward lines still open slots)', () => {
    const NO_TYPE: PwpRule = { ...PWP_BED, type: undefined };
    const lines = [
      line(0, 'MATTRESS', 'arrus', { isReward: true }),
      line(1, 'BEDFRAME', 'b-ok', { pwp: true }),
    ];
    expect(grantedIdx([NO_TYPE], lines)).toEqual([1]);
  });
});

describe('resolvePwp — 0182 refinement', () => {
  const KING_ONLY: PwpRule = { ...RULE, triggerSizeCodes: ['KING'] };

  it('a size-refined trigger only counts the listed size', () => {
    const queen = [
      line(0, 'MATTRESS', 'm-ok', { sizeCode: 'QUEEN' }),
      line(1, 'BEDFRAME', 'b-ok', { pwp: true }),
    ];
    expect(grantedIdx([KING_ONLY], queen)).toEqual([]);

    const king = [
      line(0, 'MATTRESS', 'm-ok', { sizeCode: 'king' }),
      line(1, 'BEDFRAME', 'b-ok', { pwp: true }),
    ];
    expect(grantedIdx([KING_ONLY], king)).toEqual([1]);
  });

  it('a size-refined reward only grants the listed size', () => {
    const SUPERKING_REWARD: PwpRule = { ...RULE, rewardSizeCodes: ['SUPERKING'] };
    const lines = [
      line(0, 'MATTRESS', 'm-ok'),
      line(1, 'BEDFRAME', 'b-ok', { pwp: true, sizeCode: 'QUEEN' }),
      line(2, 'BEDFRAME', 'b-ok', { pwp: true, sizeCode: 'SUPERKING' }),
    ];
    expect(grantedIdx([SUPERKING_REWARD], lines)).toEqual([2]);
  });

  it('a compartment-refined sofa trigger needs the module in the build', () => {
    const SOFA_WITH_CHAISE: PwpRule = {
      triggerCategory: 'SOFA',
      triggerEligibleModelIds: ['s-ok'],
      triggerCompartments: ['L'],
      rewardCategory: 'BEDFRAME',
      eligibleRewardModelIds: ['b-ok'],
      qtyPerTrigger: 1,
    };
    const withoutChaise = [
      line(0, 'SOFA', 's-ok', { builtCompartments: ['2A', '1B'] }),
      line(1, 'BEDFRAME', 'b-ok', { pwp: true }),
    ];
    expect(grantedIdx([SOFA_WITH_CHAISE], withoutChaise)).toEqual([]);

    const withChaise = [
      line(0, 'SOFA', 's-ok', { builtCompartments: ['2A', 'L'] }),
      line(1, 'BEDFRAME', 'b-ok', { pwp: true }),
    ];
    expect(grantedIdx([SOFA_WITH_CHAISE], withChaise)).toEqual([1]);
  });

  it('an unrefined rule is unaffected by a line that carries size / modules', () => {
    const lines = [
      line(0, 'MATTRESS', 'm-ok', { sizeCode: 'QUEEN' }),
      line(1, 'BEDFRAME', 'b-ok', { pwp: true, sizeCode: 'KING' }),
    ];
    expect(grantedIdx([RULE], lines)).toEqual([1]);
  });
});
