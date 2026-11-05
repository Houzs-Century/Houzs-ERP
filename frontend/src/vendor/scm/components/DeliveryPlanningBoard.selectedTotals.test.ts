/* HC-0164 issue 3 (Syu): "I want to see the total amount of bill I selected" -
   the bulk bar adds up the ticked sales orders, as a sheet's status bar does. */
import { describe, expect, test } from 'vitest';
import { selectedBillTotals, rowIdOf } from './DeliveryPlanningBoard';
import type { PlanningOrder } from '../lib/delivery-planning-queries';

const so = (doc: string, total: number, balance: number, live: number | null = balance): PlanningOrder =>
  ({ row_type: 'so', so_doc_no: doc, local_total_sen: total, balance_sen: balance, balance_sen_live: live }) as unknown as PlanningOrder;

describe('selectedBillTotals', () => {
  const orders = [
    so('HC-SO-006432', 300000, 300000, 210000),
    so('HC-SO-010484', 750000, 525000, 0),
    so('HC-SO-005161', 862300, 602300),
  ];

  test('adds up only the ticked orders, Balance from the live figure like the column', () => {
    const keys = new Set([rowIdOf(orders[0]!), rowIdOf(orders[1]!)]);
    expect(selectedBillTotals(orders, keys)).toEqual({ count: 2, totalSen: 1050000, balanceSen: 210000 });
  });

  test('nothing ticked is nothing to add', () => {
    expect(selectedBillTotals(orders, new Set())).toEqual({ count: 0, totalSen: 0, balanceSen: 0 });
  });

  test('a ticked job row is left out', () => {
    const job = { row_type: 'dp', so_doc_no: '', dp_id: 'x', local_total_sen: 0, balance_sen: 0 } as unknown as PlanningOrder;
    const keys = new Set([rowIdOf(job), rowIdOf(orders[2]!)]);
    expect(selectedBillTotals([...orders, job], keys)).toEqual({ count: 1, totalSen: 862300, balanceSen: 602300 });
  });
});
