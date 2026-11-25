/* What the departments charge each other (owner 2026-11-25) and the units they feed.
   Figures are made up.
     • the rates, each of the selling department's sales excluding service, every month;
     • a company pays only the departments it has: Logistics only through Operation;
     • merchandise in Performance only;
     • the stored accounts, checked; the service group's sales accounts, the shared
       returns account left in;
     • Setup & dismantle: its 1% less the fair transport as booked and the in-house trips;
       Logistics counts those trips only where Setup & dismantle pays for them. */

import { describe, expect, test } from 'vitest';
import { chargesOf, paidOut, parseChargeAccounts, serviceAccountsOf } from './department-charges';
import { buildLogisticsUnit, buildSetupDismantleUnit } from './department-units';

const rates = { gaBp: 500, operationBp: 700, logisticsBp: 300, setupDismantleBp: 100, merchandiseBp: 200 };
const all = { ga: true, operation: true, logistics: true, setupDismantle: true };
const base = new Map([['2026-09', 1_000_000], ['2026-10', 333]]);

describe('the charges, month by month', () => {
  test('each rate of the month\'s sales excluding service, rounded to the sen', () => {
    const [sep, oct] = chargesOf({ months: ['2026-09', '2026-10'], base, rates, payees: all, basis: 'performance' });
    expect(sep).toEqual({ month: '2026-09', baseSen: 1_000_000, ga: 50_000, operation: 70_000, logistics: 30_000, setupDismantle: 10_000, merchandise: 20_000 });
    expect(oct).toEqual({ month: '2026-10', baseSen: 333, ga: 17, operation: 23, logistics: 10, setupDismantle: 3, merchandise: 7 });
    expect(paidOut(sep!)).toBe(130_000);
  });

  test('Actual has no merchandise; a month with no sales charges nothing', () => {
    const [sep, nov] = chargesOf({ months: ['2026-09', '2026-11'], base, rates, payees: all, basis: 'actual' });
    expect(sep!.merchandise).toBe(0);
    expect(nov).toEqual({ month: '2026-11', baseSen: 0, ga: 0, operation: 0, logistics: 0, setupDismantle: 0, merchandise: 0 });
  });

  test('a company pays only the departments it has; Logistics only through Operation', () => {
    const [ga] = chargesOf({ months: ['2026-09'], base, rates, payees: { ga: true, operation: false, logistics: false, setupDismantle: false }, basis: 'actual' });
    expect(ga).toMatchObject({ ga: 50_000, operation: 0, logistics: 0, setupDismantle: 0 });
    const [noOp] = chargesOf({ months: ['2026-09'], base, rates, payees: { ga: true, operation: false, logistics: true, setupDismantle: true }, basis: 'actual' });
    expect(noOp).toMatchObject({ operation: 0, logistics: 0, setupDismantle: 10_000 });
  });
});

describe('what the company keeps', () => {
  test('the stored accounts, checked: codes trimmed, upper-cased, once each; a bad rate is none', () => {
    expect(parseChargeAccounts({ merchandiseBp: 200, merchandise: [' 900-t009 ', '900-T009'], setupDismantle: ['900-T030', null, ''] }))
      .toEqual({ merchandiseBp: 200, merchandise: ['900-T009'], setupDismantle: ['900-T030'] });
    expect(parseChargeAccounts({ merchandiseBp: 2.5 })).toEqual({ merchandiseBp: 0, merchandise: [], setupDismantle: [] });
    expect(parseChargeAccounts(null)).toEqual({ merchandiseBp: 0, merchandise: [], setupDismantle: [] });
  });

  test("the service group's sales accounts; the returns account every group shares stays in", () => {
    expect([...serviceAccountsOf([
      { group_code: 'BEDFRAME', sales_account: '500-0001', sales_return_account: '510-0000' },
      { group_code: 'SERVICE', sales_account: '503-0000', sales_return_account: '510-0000' },
      { group_code: 'SOFA', sales_account: '500-0003', sales_return_account: '510-0000' },
    ])]).toEqual(['503-0000']);
  });
});

describe('the units the charges feed', () => {
  const charges = chargesOf({ months: ['2026-09'], base, rates, payees: all, basis: 'actual' });

  test('Setup & dismantle: its 1% less the fair transport as booked and the in-house trips it pays Logistics', () => {
    const u = buildSetupDismantleUnit({
      months: ['2026-09'], charges, setupDismantleBp: 100,
      fairTransport: [{ code: '900-T031', name: 'TRANSPORT FAIR (KL)', cells: { '2026-09': 4_000 } }],
      inHouse: new Map([['2026-09', 2_500]]),
    });
    expect(u.rows.map((r) => [r.key, r.group, r.cells['2026-09']])).toEqual([
      ['from_selling', 'income', 10_000], ['900-T031', 'expense', 4_000], ['in_house', 'expense', 2_500],
    ]);
    expect(u.perMonth).toEqual([{ month: '2026-09', incomeSen: 10_000, expenseSen: 6_500, netSen: 3_500 }]);
  });

  test("Logistics: the 3% from Operation, Finance's recharges, the trips only where Setup & dismantle pays; never the report's own 3% of DO", () => {
    const rows = new Map([['2026-09', new Map([['do_income', 88_888], ['fair_income', 7_777], ['ti_2990', 1_000], ['sd_income', 2_500], ['outsource', 20_000]])]]);
    const withTrips = buildLogisticsUnit({ months: ['2026-09'], charges, logisticsBp: 300, rows, trips: true });
    expect(withTrips.rows.map((r) => [r.key, r.cells['2026-09']])).toEqual([['from_operation', 30_000], ['ti_2990', 1_000], ['sd_income', 2_500], ['outsource', 20_000]]);
    expect(withTrips.perMonth[0]!.netSen).toBe(13_500);
    const noTrips = buildLogisticsUnit({ months: ['2026-09'], charges, logisticsBp: 300, rows, trips: false });
    expect(noTrips.rows.map((r) => r.key)).toEqual(['from_operation', 'ti_2990', 'outsource']);
  });
});
