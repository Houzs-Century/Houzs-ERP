import { describe, it, expect } from 'vitest';
import {
  matchComboSubset,
  pickComboMatch,
  pickComboPrice,
  spreadComboTotal,
  normalizeComboModules,
  canonicalizeComboModulesForStorage,
  canonicalizeLayoutModulesForStorage,
  comboSlotsKey,
  buildComboLabel,
  comboChargedPrices,
  findDuplicateCombo,
  type SofaComboRow,
} from './sofa-combo-pricing';

/**
 * Commander 2026-05-28 (HOOKKA `findComboSubset` + `comboMatches` 1:1) —
 * SUBSET / group-coverage match against OR-set slots (string[][]).
 *
 * Match rule: every combo SLOT must be covered by a DISTINCT built module
 * whose code is in that slot's OR-set. The built module count may EXCEED the
 * slot count — extra modules beyond the matched subset are allowed and stay
 * at full master price; the combo never folds them in. Pricing applies the
 * combo to the matched subset ONLY when it is strictly cheaper than that
 * subset's à-la-carte sum (cheaper-only guard, owned caller-side).
 */

describe('normalizeComboModules', () => {
  it('passes through string[][] sorting codes within each slot, dropping empties', () => {
    expect(normalizeComboModules([['2A(RHF)', '2A(LHF)'], ['L(RHF)', ''], []]))
      .toEqual([['2A(LHF)', '2A(RHF)'], ['L(RHF)']]);
  });

  it('wraps a legacy flat string[] as singleton slots', () => {
    expect(normalizeComboModules(['2A(LHF)', 'CNR', '2A(RHF)']))
      .toEqual([['2A(LHF)'], ['CNR'], ['2A(RHF)']]);
  });
});

describe('canonicalizeComboModulesForStorage (HOOKKA canonicalSizes 1:1)', () => {
  it('sorts codes within each slot AND sorts slots by first code', () => {
    // L-slot supplied before the 2A-slot, codes reversed inside each → both
    // levels get sorted so equivalent combos store byte-identical JSON.
    expect(
      canonicalizeComboModulesForStorage([
        ['L(RHF)', 'L(LHF)'],
        ['2A(RHF)', '2A(LHF)'],
      ]),
    ).toEqual([
      ['2A(LHF)', '2A(RHF)'],
      ['L(LHF)', 'L(RHF)'],
    ]);
  });

  it('wraps a legacy flat string[] into singleton slots (then sorts)', () => {
    expect(canonicalizeComboModulesForStorage(['CNR', '2A(LHF)', '2A(RHF)']))
      .toEqual([['2A(LHF)'], ['2A(RHF)'], ['CNR']]);
  });

  it('trims, de-dupes, and drops empty slots', () => {
    expect(
      canonicalizeComboModulesForStorage([[' 2A(LHF) ', '2A(LHF)'], ['', '  '], ['CNR']]),
    ).toEqual([['2A(LHF)'], ['CNR']]);
  });

  it('returns null on empty / unusable input', () => {
    expect(canonicalizeComboModulesForStorage([])).toBeNull();
    expect(canonicalizeComboModulesForStorage([[], ['']])).toBeNull();
    expect(canonicalizeComboModulesForStorage('nope')).toBeNull();
    expect(canonicalizeComboModulesForStorage([[1, 2]])).toBeNull();
  });

  it('two equivalent combos canonicalize to the same JSON (stable hashing)', () => {
    const a = canonicalizeComboModulesForStorage([['2A(RHF)', '2A(LHF)'], ['L(RHF)', 'L(LHF)']]);
    const b = canonicalizeComboModulesForStorage([['L(LHF)', 'L(RHF)'], ['2A(LHF)', '2A(RHF)']]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('canonicalizeLayoutModulesForStorage (Quick Pick — preserves order)', () => {
  it('keeps a middle Console in the middle (combo form sorts it to the end)', () => {
    const built = [['1A(LHF)'], ['Console'], ['1A(RHF)']];
    // The combo canonicalizer alphabetically sorts the slots → Console last.
    expect(canonicalizeComboModulesForStorage(built)).toEqual([
      ['1A(LHF)'], ['1A(RHF)'], ['Console'],
    ]);
    // The layout canonicalizer PRESERVES the built left-to-right order.
    expect(canonicalizeLayoutModulesForStorage(built)).toEqual([
      ['1A(LHF)'], ['Console'], ['1A(RHF)'],
    ]);
  });

  it('wraps a legacy flat list, trims, and drops empties — order intact', () => {
    expect(canonicalizeLayoutModulesForStorage([' 1A(RHF) ', '1NA', '1A(LHF)']))
      .toEqual([['1A(RHF)'], ['1NA'], ['1A(LHF)']]);
  });

  it('rejects malformed payloads like the combo form', () => {
    expect(canonicalizeLayoutModulesForStorage('nope')).toBeNull();
    expect(canonicalizeLayoutModulesForStorage([])).toBeNull();
    expect(canonicalizeLayoutModulesForStorage([[], ['']])).toBeNull();
    expect(canonicalizeLayoutModulesForStorage([[1, 2]])).toBeNull();
  });
});

describe('comboSlotsKey', () => {
  it('is order-independent across slots and within slots', () => {
    const a = [['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']];
    const b = [['L(RHF)', 'L(LHF)'], ['2A(RHF)', '2A(LHF)']];
    expect(comboSlotsKey(a)).toBe(comboSlotsKey(b));
  });

  it('distinguishes different slot-sets', () => {
    expect(comboSlotsKey([['2A(LHF)'], ['CNR']]))
      .not.toBe(comboSlotsKey([['2A(LHF)'], ['2A(RHF)']]));
  });
});

describe('matchComboSubset (HOOKKA findComboSubset 1:1)', () => {
  it('exact cover — each built module fills its singleton slot', () => {
    expect(matchComboSubset(['2A(LHF)', 'CNR', '2A(RHF)'],
      [['2A(LHF)'], ['CNR'], ['2A(RHF)']])).toEqual([0, 1, 2]);
  });

  it('too few built modules to cover every slot → null', () => {
    expect(matchComboSubset(['2A(LHF)', 'CNR'],
      [['2A(LHF)'], ['CNR'], ['2A(RHF)']])).toBeNull();
  });

  it('EXTRA built module beyond the slots is allowed — subset = matched only', () => {
    // Combo "2+L" = [{2A(LHF),2A(RHF)},{L(LHF),L(RHF)}]; built adds a stray 1NA.
    const slots = [['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']];
    // 2A(LHF)→slot0, L(RHF)→slot1; the 1NA at index 2 is an extra (not returned).
    expect(matchComboSubset(['2A(LHF)', 'L(RHF)', '1NA'], slots)).toEqual([0, 1]);
    // Even two extras ride free.
    expect(matchComboSubset(['2A(LHF)', 'L(RHF)', '1NA', 'Console'], slots)).toEqual([0, 1]);
  });

  it('extra module that ALSO fits a slot still only consumes one per slot', () => {
    // Three 2A built, combo needs one 2A-slot + one L-slot. One 2A covers the
    // 2A-slot, the L covers the L-slot, the other two 2A are extras.
    const slots = [['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']];
    const subset = matchComboSubset(['2A(LHF)', '2A(RHF)', 'L(LHF)'], slots);
    expect(subset).not.toBeNull();
    expect(subset!.length).toBe(2); // one per slot, third 2A is an extra
  });

  it('OR-alternative cover — built code is one of a slot OR-set, order-free', () => {
    const slots = [['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']];
    expect(matchComboSubset(['2A(RHF)', 'L(LHF)'], slots)).toEqual([0, 1]);
    // L-shape laid out chaise-first — order independent.
    expect(matchComboSubset(['L(RHF)', '2A(LHF)'], slots)).toEqual([0, 1]);
  });

  it('a slot no built module can fill → null', () => {
    expect(matchComboSubset(['2A(LHF)', 'CNR'],
      [['2A(LHF)'], ['L(LHF)', 'L(RHF)']])).toBeNull();
  });

  it('overlapping OR-sets resolved by matching (needs backtracking)', () => {
    // slots [{X,Y},{X}], built [X, Y]: grabbing X for slot0 strands slot1;
    // correct cover X→slot1, Y→slot0. Both consumed → subset [0,1].
    expect(matchComboSubset(['X', 'Y'], [['X', 'Y'], ['X']])).toEqual([0, 1]);
    // built [Y, Y] vs [{X,Y},{X}] — only one slot accepts Y → can't cover both.
    expect(matchComboSubset(['Y', 'Y'], [['X', 'Y'], ['X']])).toBeNull();
  });

  it('duplicate modules need distinct slots', () => {
    expect(matchComboSubset(['1NA', '1NA'], [['1NA'], ['1NA']])).toEqual([0, 1]);
    expect(matchComboSubset(['1NA', '1NA'], [['1NA'], ['CNR']])).toBeNull();
  });

  it('empty slots never match', () => {
    expect(matchComboSubset(['2A(LHF)'], [])).toBeNull();
    expect(matchComboSubset([], [])).toBeNull();
  });
});

describe('pickComboMatch / pickComboPrice', () => {
  const row = (over: Partial<SofaComboRow> = {}): SofaComboRow => ({
    id: 'r1',
    baseModel: '5530',
    modules: [['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']],
    tier: 'PRICE_2',
    customerId: null,
    pricesByHeight: { '24': 264000, '28': 275000 },
    label: null,
    effectiveFrom: '2026-01-01',
    deletedAt: null,
    ...over,
  });

  const asOf = '2026-05-28';

  it('matches OR slots and returns the height price + matched subset', () => {
    const m = pickComboMatch(
      { baseModel: '5530', modules: ['2A(RHF)', 'L(LHF)'], customerId: null, tier: 'PRICE_2', height: '28', asOf },
      [row()],
    );
    expect(m).not.toBeNull();
    expect(m!.comboPriceCenti).toBe(275000);
    expect(m!.matchedIndices).toEqual([0, 1]);
  });

  it('SUBSET match: extra module allowed, matchedIndices excludes the extra', () => {
    // built = combo subset + a stray 1NA extra.
    const m = pickComboMatch(
      { baseModel: '5530', modules: ['2A(RHF)', 'L(LHF)', '1NA'], customerId: null, tier: 'PRICE_2', height: '28', asOf },
      [row()],
    );
    expect(m).not.toBeNull();
    expect(m!.comboPriceCenti).toBe(275000);
    expect(m!.matchedIndices).toEqual([0, 1]); // the 1NA at index 2 is an extra
  });

  it('all combo slots must be covered — too few built modules → null', () => {
    expect(pickComboMatch(
      { baseModel: '5530', modules: ['2A(RHF)'], customerId: null, tier: 'PRICE_2', height: '28', asOf },
      [row()],
    )).toBeNull();
  });

  it('a slot with no candidate built module → null (combo not applicable)', () => {
    expect(pickComboMatch(
      { baseModel: '5530', modules: ['2A(RHF)', 'CNR'], customerId: null, tier: 'PRICE_2', height: '28', asOf },
      [row()],
    )).toBeNull();
  });

  it('pickComboPrice wrapper returns just the combo height price', () => {
    expect(pickComboPrice(
      { baseModel: '5530', modules: ['2A(RHF)', 'L(LHF)', '1NA'], customerId: null, tier: 'PRICE_2', height: '24', asOf },
      [row()],
    )).toBe(264000);
  });

  it('tier-specific row only matches its tier; null tier matches any', () => {
    expect(pickComboPrice(
      { baseModel: '5530', modules: ['2A(RHF)', 'L(LHF)'], customerId: null, tier: 'PRICE_1', height: '28', asOf },
      [row({ tier: 'PRICE_2' })],
    )).toBeNull();
    expect(pickComboPrice(
      { baseModel: '5530', modules: ['2A(RHF)', 'L(LHF)'], customerId: null, tier: 'PRICE_1', height: '28', asOf },
      [row({ tier: null })],
    )).toBe(275000);
  });

  it('scope priority: customer+tier > customer+ANY > company+tier > company+ANY', () => {
    const companyAny = row({ id: 'c-any', tier: null, customerId: null, pricesByHeight: { '28': 100 } });
    const companyTier = row({ id: 'c-tier', tier: 'PRICE_2', customerId: null, pricesByHeight: { '28': 200 } });
    const custAny = row({ id: 'u-any', tier: null, customerId: 'CUST', pricesByHeight: { '28': 300 } });
    const custTier = row({ id: 'u-tier', tier: 'PRICE_2', customerId: 'CUST', pricesByHeight: { '28': 400 } });
    // With a customer + tier, the customer+tier row wins.
    expect(pickComboMatch(
      { baseModel: '5530', modules: ['2A(LHF)', 'L(RHF)'], customerId: 'CUST', tier: 'PRICE_2', height: '28', asOf },
      [companyAny, companyTier, custAny, custTier],
    )!.row.id).toBe('u-tier');
    // Without a customer, the company+tier row wins over company+ANY.
    expect(pickComboMatch(
      { baseModel: '5530', modules: ['2A(LHF)', 'L(RHF)'], customerId: null, tier: 'PRICE_2', height: '28', asOf },
      [companyAny, companyTier],
    )!.row.id).toBe('c-tier');
  });

  it('latest effective_from on/before asOf wins within a scope tier', () => {
    const older = row({ id: 'old', effectiveFrom: '2026-01-01', pricesByHeight: { '28': 275000 } });
    const newer = row({ id: 'new', effectiveFrom: '2026-05-01', pricesByHeight: { '28': 269000 } });
    const future = row({ id: 'fut', effectiveFrom: '2026-12-01', pricesByHeight: { '28': 100000 } });
    expect(pickComboPrice(
      { baseModel: '5530', modules: ['2A(LHF)', 'L(RHF)'], customerId: null, tier: 'PRICE_2', height: '28', asOf },
      [older, newer, future],
    )).toBe(269000);
  });

  it('equal effective_from: newest created_at wins, regardless of row order', () => {
    // The 2026-07-12 Trrbu drift: duplicate live rows sharing effective_from
    // made the winner depend on fetch order (POS cache vs server query).
    const dup1 = row({ id: 'dup1', effectiveFrom: '2026-05-01', createdAt: '2026-05-01T19:25:58Z', pricesByHeight: { '28': 249000 } });
    const dup2 = row({ id: 'dup2', effectiveFrom: '2026-05-01', createdAt: '2026-05-18T03:28:39Z', pricesByHeight: { '28': 199000 } });
    for (const rows of [[dup1, dup2], [dup2, dup1]]) {
      expect(pickComboPrice(
        { baseModel: '5530', modules: ['2A(LHF)', 'L(RHF)'], customerId: null, tier: 'PRICE_2', height: '28', asOf },
        rows,
      )).toBe(199000);
    }
  });

  it('equal effective_from + created_at: id breaks the tie deterministically', () => {
    const twinA = row({ id: 'aaa', effectiveFrom: '2026-05-01', createdAt: '2026-05-01T19:25:58Z', pricesByHeight: { '28': 111000 } });
    const twinB = row({ id: 'bbb', effectiveFrom: '2026-05-01', createdAt: '2026-05-01T19:25:58Z', pricesByHeight: { '28': 222000 } });
    for (const rows of [[twinA, twinB], [twinB, twinA]]) {
      expect(pickComboMatch(
        { baseModel: '5530', modules: ['2A(LHF)', 'L(RHF)'], customerId: null, tier: 'PRICE_2', height: '28', asOf },
        rows,
      )!.row.id).toBe('bbb'); // descending id — same winner both orders
    }
  });

  it('a row missing created_at loses the tie to one that carries it', () => {
    const legacy = row({ id: 'legacy', effectiveFrom: '2026-05-01', pricesByHeight: { '28': 111000 } });
    const stamped = row({ id: 'stamped', effectiveFrom: '2026-05-01', createdAt: '2026-01-01T00:00:00Z', pricesByHeight: { '28': 222000 } });
    for (const rows of [[legacy, stamped], [stamped, legacy]]) {
      expect(pickComboMatch(
        { baseModel: '5530', modules: ['2A(LHF)', 'L(RHF)'], customerId: null, tier: 'PRICE_2', height: '28', asOf },
        rows,
      )!.row.id).toBe('stamped');
    }
  });

  it('soft-deleted rows never match', () => {
    expect(pickComboPrice(
      { baseModel: '5530', modules: ['2A(LHF)', 'L(RHF)'], customerId: null, tier: 'PRICE_2', height: '28', asOf },
      [row({ deletedAt: '2026-05-20T00:00:00Z' })],
    )).toBeNull();
  });

  it('a row without a price for the height does not win', () => {
    expect(pickComboMatch(
      { baseModel: '5530', modules: ['2A(LHF)', 'L(RHF)'], customerId: null, tier: 'PRICE_2', height: '99', asOf },
      [row()],
    )).toBeNull();
  });

  it('empty baseModel arg is a wildcard (POS path)', () => {
    expect(pickComboPrice(
      { baseModel: '', modules: ['2A(LHF)', 'L(RHF)'], customerId: null, tier: 'PRICE_2', height: '24', asOf },
      [row()],
    )).toBe(264000);
  });

  it('legacy flat string[] row still requires its exact codes', () => {
    const legacy = row({ modules: (['2A(LHF)', 'L(RHF)'] as unknown) as string[][] });
    // normalizeComboModules wraps the flat codes into singleton slots → exact
    // codes required, no OR widening. An extra still rides free.
    expect(pickComboPrice(
      { baseModel: '5530', modules: ['2A(LHF)', 'L(RHF)', '1NA'], customerId: null, tier: 'PRICE_2', height: '24', asOf },
      [legacy],
    )).toBe(264000);
    expect(pickComboPrice(
      { baseModel: '5530', modules: ['2A(RHF)', 'L(RHF)'], customerId: null, tier: 'PRICE_2', height: '24', asOf },
      [legacy],
    )).toBeNull();
  });
});

describe('spreadComboTotal (PO cost side — HOOKKA redistribution 1:1)', () => {
  it('spreads proportional to base cost; sum equals combo total exactly', () => {
    // bases 600 + 400 = 1000; combo 900 → ratio 0.9 → 540 + 360 = 900.
    expect(spreadComboTotal([60000, 40000], 90000)).toEqual([54000, 36000]);
  });

  it('rebalances the rounding residual into the highest-cost line', () => {
    // bases 100 + 100 + 100 = 300; combo 100 → floor(33.33)=33 each = 99,
    // residual 1 → highest line (ties → first) gets it: 34 + 33 + 33 = 100.
    const out = spreadComboTotal([10000, 10000, 10000], 10000);
    expect(out.reduce((s, c) => s + c, 0)).toBe(10000);
    expect(out).toEqual([3334, 3333, 3333]);
  });

  it('residual lands on the dearest line, not just the first', () => {
    const out = spreadComboTotal([10000, 50000], 30001);
    expect(out.reduce((s, c) => s + c, 0)).toBe(30001);
    // base 10k/60k → 5000.16→5000; 50k/60k → 25000.83→25000; residual 1 → line[1]
    expect(out).toEqual([5000, 25001]);
  });

  it('all-zero base costs → split as evenly as possible (sum exact)', () => {
    const out = spreadComboTotal([0, 0, 0], 10000);
    expect(out.reduce((s, c) => s + c, 0)).toBe(10000);
  });

  it('single line → gets the whole combo total', () => {
    expect(spreadComboTotal([12345], 99999)).toEqual([99999]);
  });

  it('empty input → empty output', () => {
    expect(spreadComboTotal([], 5000)).toEqual([]);
  });
});

describe('buildComboLabel (HOOKKA renderComponentSizes 1:1)', () => {
  it('joins OR-alternatives with " / " and slots with " + ", no parens', () => {
    expect(buildComboLabel([['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']]))
      .toBe('2A(LHF) / 2A(RHF) + L(LHF) / L(RHF)');
  });

  it('renders singleton slots as the bare code', () => {
    expect(buildComboLabel([['2A(LHF)'], ['2NA'], ['L(RHF)']]))
      .toBe('2A(LHF) + 2NA + L(RHF)');
  });

  it('accepts a legacy flat string[]', () => {
    expect(buildComboLabel(['1A(LHF)', 'CNR', '2A(RHF)']))
      .toBe('1A(LHF) + CNR + 2A(RHF)');
  });
});

/* Combo cost/sell split (Phase 5, Part 1) — the engine charges the SELLING
 * price merged over COST per height. POS + server both call this so the
 * engine input is identical (mirrors the module sell_price_sen ?? base_price_sen
 * repoint). */
describe('comboChargedPrices', () => {
  it('uses selling per height when set', () => {
    expect(comboChargedPrices({ '24': 380000 }, { '24': 300000 })).toEqual({ '24': 380000 });
  });
  it('falls back to cost for a height selling has not priced', () => {
    expect(comboChargedPrices({ '24': 380000 }, { '24': 300000, '28': 320000 }))
      .toEqual({ '24': 380000, '28': 320000 });
  });
  it('treats a null selling entry as "not set" → cost shows through', () => {
    expect(comboChargedPrices({ '24': null }, { '24': 300000 })).toEqual({ '24': 300000 });
  });
  it('null / undefined selling → cost unchanged', () => {
    expect(comboChargedPrices(null, { '24': 300000 })).toEqual({ '24': 300000 });
    expect(comboChargedPrices(undefined, { '24': 300000 })).toEqual({ '24': 300000 });
  });
  it('null / undefined cost → just the set selling entries', () => {
    expect(comboChargedPrices({ '24': 380000 }, null)).toEqual({ '24': 380000 });
  });
});

describe('findDuplicateCombo (combo dup guard)', () => {
  const mk = (over: Partial<SofaComboRow>): SofaComboRow => ({
    id: 'x', baseModel: 'Annsa', modules: [['1A(LHF)', '1A(RHF)'], ['1A(LHF)', '1A(RHF)']],
    tier: 'PRICE_1', customerId: null, pricesByHeight: {}, label: null,
    effectiveFrom: '2026-01-01', deletedAt: null, ...over,
  });

  it('matches an identical slot-set ignoring slot + intra-slot order', () => {
    const existing = [mk({ id: 'a', modules: [['1A(RHF)', '1A(LHF)'], ['1A(LHF)', '1A(RHF)']] })];
    const hit = findDuplicateCombo('Annsa', [['1A(LHF)', '1A(RHF)'], ['1A(LHF)', '1A(RHF)']], existing);
    expect(hit?.id).toBe('a');
  });

  it('singleton build re-add is caught (the in-configurator path)', () => {
    const existing = [mk({ id: 'b', modules: [['1A(LHF)'], ['1A(RHF)']] })];
    expect(findDuplicateCombo('Annsa', [['1A(RHF)'], ['1A(LHF)']], existing)?.id).toBe('b');
  });

  it('different base model → no match', () => {
    const existing = [mk({ id: 'c', baseModel: 'Lotti' })];
    expect(findDuplicateCombo('Annsa', [['1A(LHF)', '1A(RHF)'], ['1A(LHF)', '1A(RHF)']], existing)).toBeNull();
  });

  it('different module-set → no match', () => {
    const existing = [mk({ id: 'd', modules: [['2S']] })];
    expect(findDuplicateCombo('Annsa', [['1S']], existing)).toBeNull();
  });

  it('soft-deleted rows are ignored', () => {
    const existing = [mk({ id: 'e', deletedAt: '2026-02-01' })];
    expect(findDuplicateCombo('Annsa', [['1A(LHF)', '1A(RHF)'], ['1A(LHF)', '1A(RHF)']], existing)).toBeNull();
  });

  it('empty list → null', () => {
    expect(findDuplicateCombo('Annsa', [['1S']], [])).toBeNull();
  });
});
