import { describe, expect, test } from 'vitest';
import { ordersToClaim, type ClaimOrder } from './fair-claim';

const order = (over: Partial<ClaimOrder>): ClaimOrder => ({
  doc_no: 'HC-SO-1', project_id: 7, status: 'CONFIRMED', customer_so_no: 'HC11643', ref: null, salesperson_id: null,
  local_total_sen: 520000, total_revenue_sen: 520000, fair_match: 'PICKED', ...over,
});
const report = (bills: Array<[number, string, number]>) => {
  const m = new Map<number, Array<{ token: string; amountSen: number }>>();
  for (const [p, token, amountSen] of bills) m.set(p, [...(m.get(p) ?? []), { token, amountSen }]);
  return m;
};

describe('ordersToClaim', () => {
  test('a bill plainly on an order under another event is claimed', () => {
    expect(ordersToClaim(report([[9, 'HC11643', 520000]]), [order({})])).toEqual([{ docNo: 'HC-SO-1', fromProjectId: 7, toProjectId: 9, token: 'HC11643' }]);
  });
  test('so is an order under no event', () => {
    expect(ordersToClaim(report([[9, 'HC11643', 520000]]), [order({ project_id: null })])[0].fromProjectId).toBeNull();
  });
  test('an order already under its event stays', () => {
    expect(ordersToClaim(report([[7, 'HC11643', 520000]]), [order({})])).toEqual([]);
  });
  test('two events reporting one bill name nobody', () => {
    expect(ordersToClaim(report([[9, 'HC11643', 520000], [8, 'HC11643', 520000]]), [order({ project_id: 3 })])).toEqual([]);
  });
  test('one booklet number on two orders names nobody', () => {
    expect(ordersToClaim(report([[9, 'HC11643', 520000]]), [order({}), order({ doc_no: 'HC-SO-2' })])).toEqual([]);
  });
  test('money that disagrees by more than RM 1 stays for a person', () => {
    expect(ordersToClaim(report([[9, 'HC11643', 500000]]), [order({})])).toEqual([]);
    expect(ordersToClaim(report([[9, 'HC11643', 519950]]), [order({})])).toHaveLength(1);
  });
  test('an order a person marked as no fair stays', () => {
    expect(ordersToClaim(report([[9, 'HC11643', 520000]]), [order({ project_id: null, fair_match: 'NO_FAIR' })])).toEqual([]);
  });
});
