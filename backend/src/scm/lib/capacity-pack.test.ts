import { describe, it, expect } from 'vitest';
import {
  packProposals,
  addDays,
  type PackOrder,
  type PackLorry,
  type PackConfig,
} from './capacity-pack';

const KV = ['KL', 'PJ', 'KLANG', 'KAJANG', 'RAWANG', 'PUCHONG'];

function cfg(over: Partial<PackConfig> = {}): PackConfig {
  return {
    startDate: '2026-08-01',
    klangValleyZones: KV,
    defaultMaxSets: 10,
    defaultMaxRevenueCenti: 3_000_000,
    ...over,
  };
}

function order(ref: string, zone: string, sets: number, revenueCenti = 0, hasFurniture = true): PackOrder {
  return { ref, zone, sets, revenueCenti, hasFurniture };
}

function lorry(id: string, layer: PackLorry['layer'], maxSets: number | null = null, maxRevenueCenti: number | null = null): PackLorry {
  return { id, plate: id.toUpperCase(), maxSets, maxRevenueCenti, layer };
}

describe('addDays', () => {
  it('advances calendar days UTC-stably', () => {
    expect(addDays('2026-08-01', 0)).toBe('2026-08-01');
    expect(addDays('2026-08-01', 1)).toBe('2026-08-02');
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
  });
});

describe('packProposals — SETS layer, first-ceiling-wins', () => {
  it('fills a lorry to its set ceiling, then spills to the next lorry, then the next day', () => {
    // Klang Valley: 2 lorries, ceiling 10 sets each. 25 sets of 5-set orders.
    const orders = [
      order('A', 'KL', 5), order('B', 'PJ', 5), // L1 day1 = 10
      order('C', 'KLANG', 5), order('D', 'KAJANG', 5), // L2 day1 = 10
      order('E', 'KL', 5), // L1 day2 = 5
    ];
    const lorries = [lorry('l1', 'SETS'), lorry('l2', 'SETS')];
    const r = packProposals({ orders, lorries, config: cfg() });

    expect(r.unassigned).toEqual([]);
    // Day 1 has both lorries full at 10.
    const day1 = r.days.filter((d) => d.date === '2026-08-01');
    expect(day1).toHaveLength(1);
    expect(day1[0].group).toBe('KLANG_VALLEY');
    expect(day1[0].lorries.map((l) => l.sets)).toEqual([10, 10]);
    // Day 2 carries the remainder.
    const day2 = r.days.find((d) => d.date === '2026-08-02');
    expect(day2?.lorries[0].sets).toBe(5);
    // Every order got a proposal on a real date.
    expect(r.proposals).toHaveLength(5);
    expect(r.proposals.find((p) => p.ref === 'E')?.deliveryDate).toBe('2026-08-02');
  });

  it('does not overfill: an order that would breach the ceiling starts a new lorry', () => {
    const orders = [order('A', 'KL', 8), order('B', 'PJ', 5)]; // 8 then 5 > 10
    const lorries = [lorry('l1', 'SETS'), lorry('l2', 'SETS')];
    const r = packProposals({ orders, lorries, config: cfg() });
    const day1 = r.days[0];
    expect(day1.lorries).toHaveLength(2);
    expect(day1.lorries[0].orders).toEqual(['A']);
    expect(day1.lorries[1].orders).toEqual(['B']);
  });
});

describe('packProposals — REVENUE layer', () => {
  it('fills by revenue ceiling, ignoring sets', () => {
    const orders = [
      order('A', 'KL', 1, 2_000_000),
      order('B', 'PJ', 1, 1_000_000), // L1 = 3,000,000 full
      order('C', 'KLANG', 1, 500_000), // L2
    ];
    const lorries = [lorry('l1', 'REVENUE'), lorry('l2', 'REVENUE')];
    const r = packProposals({ orders, lorries, config: cfg() });
    const day1 = r.days[0];
    expect(day1.lorries[0].orders).toEqual(['A', 'B']);
    expect(day1.lorries[0].revenueCenti).toBe(3_000_000);
    expect(day1.lorries[0].ceilingSets).toBeNull();
    expect(day1.lorries[1].orders).toEqual(['C']);
  });
});

describe('packProposals — BOTH layer, whichever ceiling binds first', () => {
  it('stops on sets even when revenue has room', () => {
    const orders = [order('A', 'KL', 10, 100_000), order('B', 'PJ', 1, 100_000)];
    const lorries = [lorry('l1', 'BOTH', 10, 3_000_000), lorry('l2', 'BOTH', 10, 3_000_000)];
    const r = packProposals({ orders, lorries, config: cfg() });
    expect(r.days[0].lorries[0].orders).toEqual(['A']); // sets ceiling hit
    expect(r.days[0].lorries[1].orders).toEqual(['B']);
  });
  it('stops on revenue even when sets have room', () => {
    const orders = [order('A', 'KL', 1, 3_000_000), order('B', 'PJ', 1, 100_000)];
    const lorries = [lorry('l1', 'BOTH', 10, 3_000_000), lorry('l2', 'BOTH', 10, 3_000_000)];
    const r = packProposals({ orders, lorries, config: cfg() });
    expect(r.days[0].lorries[0].orders).toEqual(['A']); // revenue ceiling hit
    expect(r.days[0].lorries[1].orders).toEqual(['B']);
  });
});

describe('packProposals — per-lorry ceiling override', () => {
  it('uses the lorry max_sets over the default', () => {
    const orders = [order('A', 'KL', 5), order('B', 'PJ', 5), order('C', 'KLANG', 5)];
    const lorries = [lorry('l1', 'SETS', 5)]; // ceiling 5, one order per day
    const r = packProposals({ orders, lorries, config: cfg() });
    expect(r.days.map((d) => d.date)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
    expect(r.days.every((d) => d.lorries[0].orders.length === 1)).toBe(true);
    expect(r.days[0].lorries[0].ceilingSets).toBe(5);
  });
});

describe('packProposals — far zones run dedicated trips and accumulate', () => {
  it('a far zone gets its own group, and a not-full lorry is flagged partial', () => {
    const orders = [
      order('A', 'JOHOR', 4),
      order('B', 'JOHOR', 3), // JOHOR lorry = 7 of 10 -> partial
      order('C', 'KL', 5),    // Klang Valley, separate group
    ];
    const lorries = [lorry('l1', 'SETS')];
    const r = packProposals({ orders, lorries, config: cfg() });

    const johorDay = r.days.find((d) => d.group === 'JOHOR');
    expect(johorDay).toBeDefined();
    expect(johorDay!.lorries[0].sets).toBe(7);
    expect(johorDay!.lorries[0].partial).toBe(true);

    const kvDay = r.days.find((d) => d.group === 'KLANG_VALLEY');
    expect(kvDay).toBeDefined();
    expect(kvDay!.lorries[0].partial).toBe(false); // KV is never flagged partial
  });

  it('a full far-zone lorry is not partial', () => {
    const orders = [order('A', 'PENANG', 6), order('B', 'PENANG', 4)]; // exactly 10
    const lorries = [lorry('l1', 'SETS')];
    const r = packProposals({ orders, lorries, config: cfg() });
    const penang = r.days.find((d) => d.group === 'PENANG')!;
    expect(penang.lorries[0].sets).toBe(10);
    expect(penang.lorries[0].partial).toBe(false);
  });

  it('does not mix two far zones on one lorry', () => {
    const orders = [order('A', 'JOHOR', 2), order('B', 'PENANG', 2)];
    const lorries = [lorry('l1', 'SETS')];
    const r = packProposals({ orders, lorries, config: cfg() });
    const groups = new Set(r.days.flatMap((d) => d.lorries.map(() => d.group)));
    expect(groups).toEqual(new Set(['JOHOR', 'PENANG']));
    // Each far zone is alone on its lorry.
    for (const d of r.days) {
      const zones = new Set(d.lorries.flatMap((l) => l.orders));
      expect(zones.size).toBeGreaterThan(0);
    }
  });
});

describe('packProposals — Klang Valley mixes freely', () => {
  it('different KV zones share one lorry', () => {
    const orders = [order('A', 'KL', 3), order('B', 'PUCHONG', 3), order('C', 'KAJANG', 3)];
    const lorries = [lorry('l1', 'SETS')];
    const r = packProposals({ orders, lorries, config: cfg() });
    const kvDay = r.days.find((d) => d.group === 'KLANG_VALLEY')!;
    expect(kvDay.lorries[0].orders).toEqual(['A', 'B', 'C']);
    expect(kvDay.lorries[0].sets).toBe(9);
  });
});

describe('packProposals — edge cases', () => {
  it('a single order bigger than the ceiling ships alone, flagged overCeiling', () => {
    const orders = [order('A', 'KL', 15)]; // > 10
    const lorries = [lorry('l1', 'SETS')];
    const r = packProposals({ orders, lorries, config: cfg() });
    expect(r.days[0].lorries[0].orders).toEqual(['A']);
    expect(r.days[0].lorries[0].overCeiling).toBe(true);
    expect(r.unassigned).toEqual([]);
  });

  it('no lorries => everything is unassigned with a reason', () => {
    const orders = [order('A', 'KL', 5), order('B', 'JOHOR', 5)];
    const r = packProposals({ orders, lorries: [], config: cfg() });
    expect(r.proposals).toEqual([]);
    expect(r.days).toEqual([]);
    expect(r.unassigned).toHaveLength(2);
    expect(r.unassigned[0].reason).toMatch(/no lorries/);
  });

  it('empty order list => empty result', () => {
    const r = packProposals({ orders: [], lorries: [lorry('l1', 'SETS')], config: cfg() });
    expect(r).toEqual({ proposals: [], days: [], unassigned: [] });
  });
});
