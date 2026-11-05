import { describe, expect, test } from 'vitest';
import { ordersToClaim, type ClaimOrder } from './fair-claim';
import { matchBill, indexOrdersByToken, sameFair } from '../../routes/lib/sales-report-bills';

const booths = new Map([
  [7, { venue: 'SETIA CITY', start: '2026-09-18', end: '2026-09-20' }],
  [9, { venue: 'MID VALLEY', start: '2026-10-23', end: '2026-10-25' }],
  [8, { venue: 'setia city ', start: '2026-09-19', end: '2026-09-20' }],
]);

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
    expect(ordersToClaim(report([[9, 'HC11643', 520000]]), [order({})], booths)).toEqual([{ docNo: 'HC-SO-1', fromProjectId: 7, toProjectId: 9, token: 'HC11643' }]);
  });
  test('so is an order under no event', () => {
    expect(ordersToClaim(report([[9, 'HC11643', 520000]]), [order({ project_id: null })], booths)[0].fromProjectId).toBeNull();
  });
  test('an order already under its event stays', () => {
    expect(ordersToClaim(report([[7, 'HC11643', 520000]]), [order({})], booths)).toEqual([]);
  });
  test('two events reporting one bill name nobody', () => {
    expect(ordersToClaim(report([[9, 'HC11643', 520000], [8, 'HC11643', 520000]]), [order({ project_id: 3 })], booths)).toEqual([]);
  });
  test('one booklet number on two orders names nobody', () => {
    expect(ordersToClaim(report([[9, 'HC11643', 520000]]), [order({}), order({ doc_no: 'HC-SO-2' })], booths)).toEqual([]);
  });
  test('money that disagrees by more than RM 1 stays for a person', () => {
    expect(ordersToClaim(report([[9, 'HC11643', 500000]]), [order({})], booths)).toEqual([]);
    expect(ordersToClaim(report([[9, 'HC11643', 519950]]), [order({})], booths)).toHaveLength(1);
  });
  test('an order a person marked as no fair stays', () => {
    expect(ordersToClaim(report([[9, 'HC11643', 520000]]), [order({ project_id: null, fair_match: 'NO_FAIR' })], booths)).toEqual([]);
  });
  test('a binding of two booklets is one sale of two brands and stays', () => {
    expect(ordersToClaim(report([[9, 'HC11643', 520000]]), [order({ customer_so_no: 'ZNT1234+HC11643' })], booths)).toEqual([]);
  });
  test("an order under another brand's booth of the same fair stays", () => {
    expect(ordersToClaim(report([[8, 'HC11643', 520000]]), [order({})], booths)).toEqual([]);
  });
});

describe('sameFair', () => {
  test('one venue with dates that overlap', () => {
    expect(sameFair(booths.get(7), booths.get(8))).toBe(true);
    expect(sameFair(booths.get(7), booths.get(9))).toBe(false);
  });
});

describe('a booklet number typed wrong', () => {
  test('ZNF6767 on the report is ZNT6767 on the only order with those digits', () => {
    const index = indexOrdersByToken([order({ doc_no: 'HC-SO-2609-072', customer_so_no: 'ZNT6767' })]);
    expect(matchBill('ZNF6767', 7, index).so_doc_no).toBe('HC-SO-2609-072');
  });
  test('another prefix letter, or two such orders, stays not opened', () => {
    expect(matchBill('HC6767', 7, indexOrdersByToken([order({ customer_so_no: 'ZNT6767' })])).status).toBe('not_opened');
    const two = indexOrdersByToken([order({ doc_no: 'A', customer_so_no: 'ZNT6767' }), order({ doc_no: 'B', customer_so_no: 'ZNA6767' })]);
    expect(matchBill('ZNF6767', 7, two).status).toBe('not_opened');
  });
});
