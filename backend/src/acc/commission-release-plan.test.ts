// The monthly commission release, the rules alone (owner 2026-11-25). Made-up
// figures throughout. What is pinned:
//   • a month's bill is split over the orders its Event Commission close paid
//     (adjustments included), scaled to the bill when the two differ;
//   • a month with no close (or before the books start) splits by the goods of
//     its own orders; the books' opening balance by the goods of the older
//     orders still unsold when the books started;
//   • an order releases its share as its NET sales arrive — sales invoices plus
//     deposit invoices less the credit notes that contra them — whole once sold,
//     and what is left the day it is cancelled or closed;
//   • never before the bill's own month, never before the books start; a bill
//     booked late releases into the months its orders were sold in;
//   • whole sen per order, so a layer whose orders are all sold releases
//     exactly its amount.

import { describe, expect, test } from 'vitest';
import {
  dayBefore, lastDayOf, monthsFromTo, nextYm, planCommissionRelease, splitByWeight,
  type PlanInput, type PlanOrder, type PlanSale,
} from './commission-release-plan';

const order = (docNo: string, soDate: string, totalSen: number, over: Partial<PlanOrder> = {}): PlanOrder => ({
  docNo, soDate, status: 'CONFIRMED', totalSen, endedOn: null, ...over,
});
const sale = (docNo: string, day: string, amountSen: number): PlanSale => ({ docNo, day, amountSen });

const base = (over: Partial<PlanInput>): PlanInput => ({
  booksStart: '2026-09', through: '2026-12', prepaid: [], closes: [], orders: [], sales: [],
  goodsAt: () => 0, ...over,
});

const releasedBy = (plan: ReturnType<typeof planCommissionRelease>, key: string): Record<string, number> =>
  Object.fromEntries((plan.layers.find((l) => l.key === key)?.byMonth ?? []).map((b) => [b.month, b.sen]));

describe('the month helpers', () => {
  test('months, month ends, the day before', () => {
    expect(nextYm('2026-12')).toBe('2027-01');
    expect(monthsFromTo('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(monthsFromTo('2026-12', '2026-11')).toEqual([]);
    expect(lastDayOf('2026-02')).toBe('2026-02-28');
    expect(lastDayOf('2028-02')).toBe('2028-02-29');
    expect(dayBefore('2026-09-01')).toBe('2026-08-31');
  });
});

describe('splitByWeight', () => {
  test('the parts add up exactly; a tie goes to the earlier key', () => {
    const s = splitByWeight(100, [['a', 1], ['b', 1], ['c', 1]])!;
    expect([...s.values()].reduce((x, y) => x + y, 0)).toBe(100);
    expect(s.get('a')).toBe(34);
    expect(s.get('b')).toBe(33);
  });
  test('a minus weight (a cancellation paid back) is scaled like the rest', () => {
    const s = splitByWeight(125_00, [['a', 1000_00], ['b', -200_00]])!;
    expect(s.get('a')).toBe(156_25);
    expect(s.get('b')).toBe(-31_25);
    expect(s.get('a')! + s.get('b')!).toBe(125_00);
  });
  test('weights that sum to nothing split nothing', () => {
    expect(splitByWeight(100, [])).toBeNull();
    expect(splitByWeight(100, [['a', 5], ['b', -5]])).toBeNull();
  });
});

describe('a month the Event Commission report closed', () => {
  const orders = [order('SO-1', '2026-10-03', 10_000_00), order('SO-2', '2026-10-09', 5_000_00), order('SO-3', '2026-10-20', 2_000_00)];
  const prepaid = [{ month: '2026-10', amountSen: 1_800_00, docNo: 'API-OCT' }];
  const closes = [{ month: '2026-10', perOrder: [['SO-1', 1_200_00], ['SO-2', 600_00]] as Array<[string, number]> }];

  test('each order carries what the close paid it; its share moves as it is invoiced', () => {
    const plan = planCommissionRelease(base({
      prepaid, closes, orders,
      sales: [sale('SO-1', '2026-10-15', 10_000_00), sale('SO-2', '2026-11-02', 2_000_00), sale('SO-2', '2026-12-10', 3_000_00)],
    }));
    const l = plan.layers.find((x) => x.key === 'bill:2026-10')!;
    expect(l.basis).toBe('close');
    expect(l.note).toBeNull();
    expect(plan.shares.get('bill:2026-10')!.get('SO-3')).toBeUndefined();
    /* SO-1 whole in October; SO-2 two fifths in November, the rest in December. */
    expect(releasedBy(plan, 'bill:2026-10')).toEqual({ '2026-10': 1_200_00, '2026-11': 240_00, '2026-12': 360_00 });
    expect(l.releasedSen).toBe(1_800_00);
    expect(l.leftSen).toBe(0);
    expect(plan.months.find((m) => m.month === '2026-09')!.totalSen).toBe(0);
  });

  test('a bill that differs from the close scales every share to the bill', () => {
    const plan = planCommissionRelease(base({
      prepaid: [{ month: '2026-10', amountSen: 2_000_00, docNo: 'API-OCT' }], closes, orders,
      sales: [sale('SO-1', '2026-10-15', 10_000_00), sale('SO-2', '2026-10-20', 5_000_00)],
    }));
    const shares = plan.shares.get('bill:2026-10')!;
    expect(shares.get('SO-1')).toBe(1_333_33);
    expect(shares.get('SO-2')).toBe(666_67);
    expect(plan.layers[0]!.note).toMatch(/differ/);
    expect(releasedBy(plan, 'bill:2026-10')).toEqual({ '2026-10': 2_000_00 });
  });

  test('an order sold before the bill\'s month releases in the bill\'s month, never earlier', () => {
    const plan = planCommissionRelease(base({
      prepaid, closes, orders, sales: [sale('SO-1', '2026-09-20', 10_000_00)],
    }));
    expect(releasedBy(plan, 'bill:2026-10')).toEqual({ '2026-10': 1_200_00 });
  });

  test('a bill booked after its month still releases into the months its orders were sold', () => {
    /* The September bill arrives in October; its ledger line names SEP — the layer is September's. */
    const plan = planCommissionRelease(base({
      prepaid: [{ month: '2026-09', amountSen: 900_00, docNo: 'API-SEP-LATE' }],
      closes: [{ month: '2026-09', perOrder: [['SO-9', 900_00]] }],
      orders: [order('SO-9', '2026-09-05', 6_000_00)],
      sales: [sale('SO-9', '2026-09-28', 6_000_00)],
    }));
    expect(releasedBy(plan, 'bill:2026-09')).toEqual({ '2026-09': 900_00 });
  });

  test('a cancelled order releases what is left the day it ends; the close that pays it back releases the minus', () => {
    const plan = planCommissionRelease(base({
      prepaid: [{ month: '2026-10', amountSen: 500_00, docNo: 'API-OCT' }, { month: '2026-11', amountSen: -500_00 + 300_00, docNo: 'API-NOV' }],
      closes: [
        { month: '2026-10', perOrder: [['SO-C', 500_00]] },
        { month: '2026-11', perOrder: [['SO-C', -500_00], ['SO-N', 300_00]] },
      ],
      orders: [
        order('SO-C', '2026-10-02', 4_000_00, { status: 'CANCELLED', endedOn: '2026-11-12' }),
        order('SO-N', '2026-11-03', 2_500_00),
      ],
      sales: [sale('SO-N', '2026-11-25', 2_500_00)],
    }));
    expect(releasedBy(plan, 'bill:2026-10')).toEqual({ '2026-11': 500_00 });
    expect(releasedBy(plan, 'bill:2026-11')).toEqual({ '2026-11': -200_00 });
    /* The cancelled order nets to nothing; November's cost is the new order's commission. */
    expect(plan.months.find((m) => m.month === '2026-11')!.totalSen).toBe(300_00);
  });
});

describe('net sales: a deposit counts once', () => {
  test('a deposit invoice releases its share; the final invoice and the credit note that contras the deposit release the rest', () => {
    const plan = planCommissionRelease(base({
      prepaid: [{ month: '2026-10', amountSen: 1_000_00, docNo: 'API-OCT' }],
      closes: [{ month: '2026-10', perOrder: [['SO-D', 1_000_00]] }],
      orders: [order('SO-D', '2026-10-01', 8_000_00)],
      sales: [
        sale('SO-D', '2026-10-01', 2_400_00),   // deposit invoice, 30%
        sale('SO-D', '2026-12-04', 8_000_00),   // the final sales invoice
        sale('SO-D', '2026-12-04', -2_400_00),  // the credit note closing the deposit invoice
      ],
    }));
    expect(releasedBy(plan, 'bill:2026-10')).toEqual({ '2026-10': 300_00, '2026-12': 700_00 });
  });

  test('a refunded deposit gives its share back', () => {
    const plan = planCommissionRelease(base({
      prepaid: [{ month: '2026-10', amountSen: 1_000_00, docNo: 'API-OCT' }],
      closes: [{ month: '2026-10', perOrder: [['SO-R', 1_000_00]] }],
      orders: [order('SO-R', '2026-10-01', 10_000_00)],
      sales: [sale('SO-R', '2026-10-01', 5_000_00), sale('SO-R', '2026-11-10', -5_000_00)],
    }));
    expect(releasedBy(plan, 'bill:2026-10')).toEqual({ '2026-10': 500_00, '2026-11': -500_00 });
  });
});

describe('months with no close', () => {
  test('before the books start: split by the goods of the month\'s orders, released from the books\' first month', () => {
    const goods: Record<string, number> = { 'SO-A1': 3_000_00, 'SO-A2': 1_000_00 };
    const plan = planCommissionRelease(base({
      prepaid: [{ month: '2026-08', amountSen: 400_00, docNo: 'API-AUG' }],
      orders: [order('SO-A1', '2026-08-04', 3_000_00), order('SO-A2', '2026-08-20', 1_000_00), order('SO-J', '2026-07-30', 9_000_00)],
      sales: [sale('SO-A1', '2026-08-28', 3_000_00), sale('SO-A2', '2026-10-05', 1_000_00)],
      goodsAt: (d) => goods[d] ?? 0,
    }));
    const l = plan.layers.find((x) => x.key === 'bill:2026-08')!;
    expect(l.basis).toBe('goods');
    expect(l.orders).toBe(2);
    expect(l.fromMonth).toBe('2026-09');
    /* SO-A1 was sold in August: its share is released in September, the books' first month. */
    expect(releasedBy(plan, 'bill:2026-08')).toEqual({ '2026-09': 300_00, '2026-10': 100_00 });
  });

  test('a month after the books start waits on the goods split until its close exists', () => {
    const input = base({
      prepaid: [{ month: '2026-11', amountSen: 600_00, docNo: 'API-NOV' }],
      orders: [order('SO-N1', '2026-11-02', 4_000_00), order('SO-N2', '2026-11-09', 2_000_00)],
      sales: [sale('SO-N1', '2026-11-20', 4_000_00)],
      goodsAt: (d) => (d === 'SO-N1' ? 4_000_00 : 2_000_00),
    });
    const open = planCommissionRelease(input);
    expect(open.layers[0]!.basis).toBe('goods');
    expect(open.layers[0]!.note).toMatch(/not closed yet/);
    expect(releasedBy(open, 'bill:2026-11')).toEqual({ '2026-11': 400_00 });

    const closed = planCommissionRelease({ ...input, closes: [{ month: '2026-11', perOrder: [['SO-N1', 500_00], ['SO-N2', 100_00]] }] });
    expect(closed.layers[0]!.basis).toBe('close');
    expect(releasedBy(closed, 'bill:2026-11')).toEqual({ '2026-11': 500_00 });
  });

  test('goods are read as at the month\'s end, not today', () => {
    const plan = planCommissionRelease(base({
      prepaid: [{ month: '2026-08', amountSen: 100_00, docNo: 'API-AUG' }],
      orders: [order('SO-X', '2026-08-01', 1_000_00), order('SO-Y', '2026-08-02', 1_000_00)],
      goodsAt: (d, day) => (d === 'SO-X' && day === '2026-08-31' ? 3_000_00 : 1_000_00),
    }));
    expect(plan.shares.get('bill:2026-08')!.get('SO-X')).toBe(75_00);
  });

  test('a bill no order can carry releases nothing and says so', () => {
    const plan = planCommissionRelease(base({ prepaid: [{ month: '2026-08', amountSen: 100_00, docNo: 'API-AUG' }] }));
    expect(plan.layers[0]!.basis).toBe('none');
    expect(plan.layers[0]!.leftSen).toBe(100_00);
    expect(plan.layers[0]!.note).toMatch(/nothing is released/);
  });
});

describe('the books\' opening balance', () => {
  const goods: Record<string, number> = { 'SO-O1': 2_000_00, 'SO-O2': 6_000_00, 'SO-O3': 1_000_00, 'SO-O4': 5_000_00, 'SO-O5': 3_000_00 };
  const input = base({
    prepaid: [
      { month: null, amountSen: 800_00, docNo: 'OPENING' },
      { month: '2026-08', amountSen: 50_00, docNo: 'API-AUG' },
    ],
    orders: [
      order('SO-O1', '2026-03-10', 2_000_00),
      order('SO-O2', '2025-11-02', 6_000_00),
      order('SO-O3', '2026-06-01', 1_000_00),                                                // sold before the books start
      order('SO-O4', '2026-05-01', 5_000_00, { status: 'CANCELLED', endedOn: '2026-07-01' }), // ended before the books start
      order('SO-O5', '2026-08-15', 3_000_00),                                                // August: the August bill's
    ],
    sales: [sale('SO-O1', '2026-09-12', 2_000_00), sale('SO-O2', '2026-11-30', 6_000_00), sale('SO-O3', '2026-08-01', 1_000_00)],
    goodsAt: (d) => goods[d] ?? 0,
  });

  test('carried by the older orders still unsold when the books started, by goods', () => {
    const plan = planCommissionRelease(input);
    const shares = plan.shares.get('opening')!;
    expect([...shares.keys()].sort()).toEqual(['SO-O1', 'SO-O2']);
    expect(shares.get('SO-O1')).toBe(200_00);
    expect(shares.get('SO-O2')).toBe(600_00);
    expect(releasedBy(plan, 'opening')).toEqual({ '2026-09': 200_00, '2026-11': 600_00 });
    expect(plan.layers.find((l) => l.key === 'opening')!.fromMonth).toBe('2026-09');
  });

});

describe('whole sen', () => {
  test('a layer whose orders are all sold releases exactly its amount, however it was split', () => {
    const docs = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const plan = planCommissionRelease(base({
      prepaid: [{ month: '2026-10', amountSen: 1_000_01, docNo: 'API' }],
      closes: [{ month: '2026-10', perOrder: docs.map((d, i) => [d, 100_00 + i * 7] as [string, number]) }],
      orders: docs.map((d) => order(d, '2026-10-01', 333_33)),
      sales: docs.flatMap((d, i) => [sale(d, '2026-10-05', 111_11), sale(d, `2026-1${1 + (i % 2)}-03`, 222_22)]),
    }));
    const l = plan.layers[0]!;
    expect(l.releasedSen).toBe(1_000_01);
    expect(l.byMonth.reduce((s, b) => s + b.sen, 0)).toBe(1_000_01);
    for (const b of l.byMonth) expect(Number.isInteger(b.sen)).toBe(true);
  });

  test('an order with no total is whole once anything is invoiced', () => {
    const plan = planCommissionRelease(base({
      prepaid: [{ month: '2026-10', amountSen: 10_00, docNo: 'API' }],
      closes: [{ month: '2026-10', perOrder: [['Z', 10_00]] }],
      orders: [order('Z', '2026-10-01', 0)],
      sales: [sale('Z', '2026-12-01', 1)],
    }));
    expect(releasedBy(plan, 'bill:2026-10')).toEqual({ '2026-12': 10_00 });
  });
});
