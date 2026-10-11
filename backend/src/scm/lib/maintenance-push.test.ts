// Unit tests for the Houzs → 2990 Product Maintenance push core.
//
// The fixture below is not invented: it is the SHAPE of 2990's live master
// config (scope=master, effective_from=2026-06-28, id mch-7026b711f4c3) as
// measured against PROD on 2026-07-17 — divanHeights carrying 4 entries with a
// real sellingPriceSen (10" = 12500 sen selling over a 5500 sen cost), and
// totalHeights 10" carrying priceSen=40000 with NO selling price. Those two are
// the exact values a naive whole-blob push destroys, so they are the two the
// tests are built around.
import { describe, expect, test } from 'vitest';
import {
  mergeMaintenanceConfig,
  assertNoPriceLoss,
  collectPriceAnchors,
  summariseDiff,
  PUSHABLE_POOLS,
} from './maintenance-push';

/** 2990's blob, shaped like the live master row. */
const remote = () => ({
  gaps: ['4"', '5"', '6"'],
  sofaSizes: ['24', '26'],
  sofaCompartments: ['1A(LHF)', '1A(RHF)', 'Console', 'STOOL'],
  divanHeights: [
    { value: '10"', priceSen: 5500, sellingPriceSen: 12500 },
    { value: '12"', priceSen: 6000, sellingPriceSen: 13000 },
    { value: '4"', priceSen: 0 },
  ],
  totalHeights: [{ value: '10"', priceSen: 40000 }],
  sofaCompartmentMeta: {
    '1A(LHF)': { description: 'Armless left', defaultPriceCenti: 0 },
    Console: { description: 'Wood console', defaultPriceCenti: 15000 },
  },
});

describe('collectPriceAnchors', () => {
  test('anchors money by the entry value, not the array index', () => {
    const a = collectPriceAnchors(remote());
    expect(a.get('divanHeights[#10"].sellingPriceSen')).toBe('12500');
    expect(a.get('totalHeights[#10"].priceSen')).toBe('40000');
    expect(a.get('sofaCompartmentMeta.Console.defaultPriceCenti')).toBe('15000');
  });

  test('reordering a pool does not move an anchor (no false positives)', () => {
    const before = remote();
    const after = remote();
    after.divanHeights.reverse();
    expect(assertNoPriceLoss(before, after)).toEqual([]);
  });
});

describe('assertNoPriceLoss', () => {
  test('catches the exact naive-push failure: selling prices zeroed', () => {
    const before = remote();
    // What a whole-blob push of Houzs's config would send: Houzs writes ONE
    // price and omits sellingPriceSen entirely.
    const after = { ...remote(), divanHeights: [{ value: '10"', priceSen: 5500 }] };
    const losses = assertNoPriceLoss(before, after);
    const anchors = losses.map((l) => l.anchor);
    expect(anchors).toContain('divanHeights[#10"].sellingPriceSen');
    expect(losses.find((l) => l.anchor === 'divanHeights[#10"].sellingPriceSen')?.reason).toBe('removed');
  });

  test('catches a changed price as well as a removed one', () => {
    const after = remote();
    after.divanHeights[0].sellingPriceSen = 9900;
    const losses = assertNoPriceLoss(remote(), after);
    expect(losses).toEqual([
      { anchor: 'divanHeights[#10"].sellingPriceSen', before: '12500', after: '9900', reason: 'changed' },
    ]);
  });

  test('is one-directional — 2990 gaining a price is not a loss', () => {
    const after = remote();
    after.divanHeights[2].sellingPriceSen = 100;
    expect(assertNoPriceLoss(remote(), after)).toEqual([]);
  });
});

describe('mergeMaintenanceConfig — the price invariant', () => {
  test('a full default-scope push preserves every 2990 price byte-for-byte', () => {
    const local = {
      gaps: ['4"', '5"', '6"', '7"', '8"'],
      sofaSizes: ['24', '26', '28'],
      // Houzs's priced pools carry NO sellingPriceSen — the naive-push hazard.
      divanHeights: [{ value: '10"', priceSen: 5500 }],
      totalHeights: [{ value: '10"', priceSen: 40000 }],
    };
    const r = mergeMaintenanceConfig(remote(), local);
    expect(r.refusals).toEqual([]);
    expect(assertNoPriceLoss(remote(), r.merged)).toEqual([]);
    // The priced pools are untouched — not merged, not reordered, not rewritten.
    expect(r.merged.divanHeights).toEqual(remote().divanHeights);
    expect(r.merged.totalHeights).toEqual(remote().totalHeights);
    // The option lists gained Houzs's new values.
    expect(r.merged.gaps).toEqual(['4"', '5"', '6"', '7"', '8"']);
    expect(r.merged.sofaSizes).toEqual(['24', '26', '28']);
  });

  test('refuses a priced pool by name even when a caller asks for it', () => {
    const r = mergeMaintenanceConfig(remote(), { divanHeights: [{ value: '10"', priceSen: 1 }] }, {
      pools: ['divanHeights'],
    });
    expect(r.refusals.map((x) => x.code)).toContain('pool_not_pushable');
    expect(r.merged.divanHeights).toEqual(remote().divanHeights);
  });

  test('every priced pool on the live master is outside the push scope', () => {
    for (const p of ['divanHeights', 'totalHeights', 'legHeights', 'specials', 'sofaLegHeights', 'sofaSpecials', 'sofaCompartmentMeta']) {
      expect(PUSHABLE_POOLS).not.toContain(p);
    }
  });
});

describe('pool shape', () => {
  test('sizeLabels is NOT pushable — it is a label map, not a choice list', () => {
    expect(PUSHABLE_POOLS).not.toContain('sizeLabels');
    const r = mergeMaintenanceConfig(remote(), { sizeLabels: { K: { label: 'King' } } }, {
      pools: ['sizeLabels'],
    });
    expect(r.refusals.map((x) => x.code)).toContain('pool_not_pushable');
  });

  test('a local pool that is not a list is REFUSED, never silently skipped', () => {
    const r = mergeMaintenanceConfig(remote(), { gaps: { '4"': true } as unknown as string[] });
    expect(r.refusals.map((x) => x.code)).toContain('local_pool_not_a_list');
  });

  test('a remote pool that is not a list is REFUSED', () => {
    const r = mergeMaintenanceConfig({ ...remote(), gaps: { a: 1 } as unknown as string[] }, { gaps: ['4"'] });
    expect(r.refusals.map((x) => x.code)).toContain('remote_pool_not_a_list');
  });
});

describe('mergeMaintenanceConfig — 2990 keeps what Houzs never had', () => {
  test('a 2990-only value is PRESERVED, not dropped, by default', () => {
    const local = { gaps: ['4"'] }; // Houzs has only one gap
    const r = mergeMaintenanceConfig(remote(), local);
    expect(r.refusals).toEqual([]);
    expect(r.merged.gaps).toEqual(['4"', '5"', '6"']); // 5" and 6" survive
    expect(r.diffs.find((d) => d.pool === 'gaps')?.remoteOnly).toEqual(['5"', '6"']);
  });

  test('an unreadable remote entry is kept, never dropped', () => {
    const rem = { ...remote(), gaps: ['4"', { weird: true }, '6"'] };
    const r = mergeMaintenanceConfig(rem, { gaps: ['4"', '6"', '9"'] });
    expect(r.refusals).toEqual([]);
    expect(r.merged.gaps).toEqual(['4"', { weird: true }, '6"', '9"']);
  });

  test('a matched value is not rewritten — 2990s object entry survives intact', () => {
    const rem = { ...remote(), gaps: [{ value: '4"', sellingPriceSen: 500 }] };
    const r = mergeMaintenanceConfig(rem, { gaps: ['4"', '5"'] });
    expect(r.refusals).toEqual([]);
    expect(r.merged.gaps).toEqual([{ value: '4"', sellingPriceSen: 500 }, '5"']);
    expect(assertNoPriceLoss(rem, r.merged)).toEqual([]);
  });
});

describe('mergeMaintenanceConfig — removals', () => {
  test('removals are OFF by default', () => {
    const r = mergeMaintenanceConfig(remote(), { gaps: ['4"'] });
    expect(r.diffs.find((d) => d.pool === 'gaps')?.removals).toEqual([]);
  });

  test('an unpriced 2990-only value may be removed when explicitly allowed', () => {
    const r = mergeMaintenanceConfig(remote(), { gaps: ['4"', '5"'] }, { allowRemovals: true });
    expect(r.refusals).toEqual([]);
    expect(r.merged.gaps).toEqual(['4"', '5"']);
  });

  test('refuses to remove a value 2990 has priced — including priced at zero', () => {
    const rem = { ...remote(), gaps: [{ value: '4"', sellingPriceSen: 0 }, '5"'] };
    const r = mergeMaintenanceConfig(rem, { gaps: ['5"'] }, { allowRemovals: true });
    expect(r.refusals.map((x) => x.code)).toContain('removal_would_drop_price');
  });
});

describe('mergeMaintenanceConfig — sofaCompartments rename', () => {
  test('refuses the CSL/Console shape: an add and a remove in one push', () => {
    // The real divergence. Houzs carries HOOKKA's `CSL`; 2990 canonicalised on
    // `Console` (migration 0123_wc45_to_console_merge). Pushing Houzs's list
    // with removals on is a rename in disguise.
    const local = { sofaCompartments: ['1A(LHF)', '1A(RHF)', 'CSL', 'STOOL'] };
    const r = mergeMaintenanceConfig(remote(), local, { allowRemovals: true });
    expect(r.refusals.map((x) => x.code)).toContain('sofa_compartment_rename_refused');
  });

  test('flags the same shape as a rename SUSPECT in dry-run, without refusing', () => {
    const local = { sofaCompartments: ['1A(LHF)', '1A(RHF)', 'CSL', 'STOOL'] };
    const r = mergeMaintenanceConfig(remote(), local); // default: no removals
    const d = r.diffs.find((x) => x.pool === 'sofaCompartments');
    expect(d?.renameSuspect).toBe(true);
    expect(d?.additions).toEqual(['CSL']);
    expect(d?.remoteOnly).toEqual(['Console']);
    // Console is preserved — the merge alone never orphans a document.
    expect(r.merged.sofaCompartments).toContain('Console');
  });

  test('additions alone are allowed', () => {
    const local = { sofaCompartments: ['1A(LHF)', '1A(RHF)', 'Console', 'STOOL', '3S'] };
    const r = mergeMaintenanceConfig(remote(), local, { allowRemovals: true });
    expect(r.refusals).toEqual([]);
    expect(r.merged.sofaCompartments).toEqual(['1A(LHF)', '1A(RHF)', 'Console', 'STOOL', '3S']);
  });
});

describe('mergeMaintenanceConfig — active semantics', () => {
  test('a Houzs-only INACTIVE option is never introduced to 2990', () => {
    const local = { gaps: ['4"', { value: '9"', active: false }] };
    const r = mergeMaintenanceConfig(remote(), local);
    expect(r.merged.gaps).toEqual(['4"', '5"', '6"']);
    expect(r.diffs.find((d) => d.pool === 'gaps')?.houzsOnlyInactive).toEqual(['9"']);
  });

  test('a matched option Houzs switched off is REPORTED, not silently applied', () => {
    const local = { gaps: [{ value: '5"', active: false }] };
    const r = mergeMaintenanceConfig(remote(), local);
    expect(r.diffs.find((d) => d.pool === 'gaps')?.activeDivergence).toEqual(['5"']);
    expect(r.merged.gaps).toEqual(['4"', '5"', '6"']); // 2990's choice stands
  });
});

describe('mergeMaintenanceConfig — no-op detection', () => {
  test('identical lists produce a no-op', () => {
    const r = mergeMaintenanceConfig(remote(), {
      gaps: ['4"', '5"', '6"'],
      sofaSizes: ['24', '26'],
      sofaCompartments: ['1A(LHF)', '1A(RHF)', 'Console', 'STOOL'],
    });
    expect(r.noop).toBe(true);
    expect(r.refusals).toEqual([]);
  });

  test('a pool Houzs does not have is skipped, not blanked', () => {
    const r = mergeMaintenanceConfig(remote(), {});
    expect(r.noop).toBe(true);
    expect(r.merged).toEqual(remote());
  });
});

describe('summariseDiff', () => {
  test('reports the match-vs-new counts and the rename suspects', () => {
    const local = {
      gaps: ['4"', '5"', '99"'],
      sofaCompartments: ['1A(LHF)', 'CSL'],
    };
    const s = summariseDiff(mergeMaintenanceConfig(remote(), local).diffs);
    expect(s.matched).toBe(3); // 4", 5", 1A(LHF)
    expect(s.additions).toBe(2); // 99", CSL
    expect(s.renameSuspects).toEqual(['sofaCompartments']);
  });
});
