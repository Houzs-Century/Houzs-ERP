import { describe, expect, test } from 'vitest';
import { groupProposalsByDay } from './propose-days';
import type { PackProposal } from './delivery-zones-queries';

/* The date page's proposal view (owner 2026-08-07/08: dates first, lorries
 * later). The packer still answers in lorry-days; this fold must present DAY ->
 * orders only. What is worth pinning: the lorry fields are dropped, sets and
 * revenue sum per day-group, and the ordering is deterministic. */

const p = (over: Partial<PackProposal>): PackProposal => ({
  ref: 'SO-1',
  zone: 'KL',
  group: 'KLANG_VALLEY',
  deliveryDate: '2026-08-10',
  lorryId: 'lorry-a',
  plate: 'VNB9058',
  sets: 1,
  revenueCenti: 100_00,
  debtorName: 'Alice',
  ...over,
});

describe('groupProposalsByDay — day cards with no lorry dimension', () => {
  test('groups by (date, zone group), summing sets and revenue', () => {
    const days = groupProposalsByDay([
      p({ ref: 'SO-1', sets: 2, revenueCenti: 500_00 }),
      p({ ref: 'SO-2', sets: 3, revenueCenti: 700_00, lorryId: 'lorry-b', plate: 'WXY1234' }),
      p({ ref: 'SO-3', deliveryDate: '2026-08-11', group: 'JOHOR', zone: 'JOHOR' }),
    ]);
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ date: '2026-08-10', group: 'KLANG_VALLEY', sets: 5, revenueCenti: 1200_00 });
    expect(days[0].orders.map((o) => o.ref)).toEqual(['SO-1', 'SO-2']);
    expect(days[1]).toMatchObject({ date: '2026-08-11', group: 'JOHOR' });
  });

  test('two different lorries on one day-group fold into ONE card — the lorry split is invisible', () => {
    const days = groupProposalsByDay([
      p({ ref: 'SO-1', lorryId: 'a', plate: 'AAA' }),
      p({ ref: 'SO-2', lorryId: 'b', plate: 'BBB' }),
    ]);
    expect(days).toHaveLength(1);
    /* No lorry field survives the fold, on the day or on its orders. */
    for (const day of days) {
      expect(day).not.toHaveProperty('lorryId');
      expect(day).not.toHaveProperty('plate');
      expect(day).not.toHaveProperty('lorries');
      for (const o of day.orders) {
        expect(o).not.toHaveProperty('lorryId');
        expect(o).not.toHaveProperty('plate');
      }
    }
  });

  test('days sort ascending; groups A->Z within a day; empty input -> no cards', () => {
    const days = groupProposalsByDay([
      p({ ref: 'SO-3', deliveryDate: '2026-08-12', group: 'PENANG', zone: 'PENANG' }),
      p({ ref: 'SO-1', deliveryDate: '2026-08-10' }),
      p({ ref: 'SO-2', deliveryDate: '2026-08-12', group: 'JOHOR', zone: 'JOHOR' }),
    ]);
    expect(days.map((d) => `${d.date} ${d.group}`)).toEqual([
      '2026-08-10 KLANG_VALLEY',
      '2026-08-12 JOHOR',
      '2026-08-12 PENANG',
    ]);
    expect(groupProposalsByDay([])).toEqual([]);
  });

  test('a null debtorName stays null (rendered as a dash, never invented)', () => {
    const days = groupProposalsByDay([p({ debtorName: null })]);
    expect(days[0].orders[0].debtorName).toBeNull();
  });
});
