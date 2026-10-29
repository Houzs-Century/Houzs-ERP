/* The Logistics cost report's arithmetic (owner 2026-10-29: 物流报告 按地区、
   每趟、setup & dismantle —「都需要」; our own lorries OVERALL —「trip 除成本」).
   Pinned:
     • who took a DO: the lorry picked, else the plate typed — spaces and case
       ignored, "A / B" read as two lorries, ours first; a plate on no list is
       said so;
     • a trip of ours is one lorry on one day; the month's cost of the ticked
       accounts divided by the month's trips is one trip's cost, shared equally
       by its DOs; a month with cost and no trip is named, not spread;
     • a DO's 3PL cost is its bill charge; a 3PL run is one bill line, on its own
       date, else its DOs' first day;
     • four regions, the books' own (2026-10-29 「可以」): Penang, KL, SBH & SWK,
       SGD — Singapore by its state box or its address, a state nobody names
       KL's others; by region: DOs, what they carry, our share, 3PL, total —
       the range's DOs only, a month's trips counted whole;
     • the default cost accounts: expense accounts naming a lorry or one of our
       plates — not the director's petrol, not the lorry asset. */

import { describe, expect, test } from 'vitest';
import {
  buildLogisticsReport, defaultOwnCostAccounts, delivererOf, normalisePlate, platesOf, regionOfDo, share,
  type LogisticsDo, type LogisticsInput, type LogisticsLorry,
} from './logistics-cost';

const LORRIES: LogisticsLorry[] = [
  { id: 'L1', plate: 'VRH9058', isInternal: true },
  { id: 'L2', plate: 'VPC9058', isInternal: true },
  { id: 'L3', plate: 'W1591T', isInternal: false },
];
const DO = (id: string, day: string, state: string | null, valueSen: number, crew: { lorryId?: string; plate?: string } = {}): LogisticsDo => ({
  id, doNumber: `HC-DO-${id}`, soDocNo: null, day, state, valueSen, crewLorryId: crew.lorryId ?? null, crewPlate: crew.plate ?? null,
});

describe('plates and who took a DO', () => {
  test('a plate is its letters and digits; a typed cell may name two', () => {
    expect(normalisePlate('vrh 9058')).toBe('VRH9058');
    expect(platesOf('W 1591 T / MCF 3084')).toEqual(['W1591T', 'MCF3084']);
    expect(platesOf('')).toEqual([]);
  });

  test('picked, typed, ours first, outside, unlisted, none', () => {
    expect(delivererOf({ crewLorryId: 'L1', crewPlate: null }, LORRIES)).toEqual({ kind: 'own', plate: 'VRH9058' });
    expect(delivererOf({ crewLorryId: null, crewPlate: 'VRH 9058' }, LORRIES)).toEqual({ kind: 'own', plate: 'VRH9058' });
    expect(delivererOf({ crewLorryId: null, crewPlate: 'W 1591 T / VPC 9058' }, LORRIES)).toEqual({ kind: 'own', plate: 'VPC9058' });
    expect(delivererOf({ crewLorryId: 'L3', crewPlate: null }, LORRIES)).toEqual({ kind: 'outside', plate: 'W1591T' });
    expect(delivererOf({ crewLorryId: null, crewPlate: 'ABC 123' }, LORRIES)).toEqual({ kind: 'unlisted', text: 'ABC 123' });
    expect(delivererOf({ crewLorryId: null, crewPlate: null }, LORRIES)).toEqual({ kind: 'none' });
  });

  test("the four regions: the books' own split, Singapore by its state box or its address", () => {
    const at = (state: string | null, city: string | null = null, postcode: string | null = null) => regionOfDo({ state, city, postcode });
    expect(at('PULAU PINANG')).toEqual({ code: 'PG', noState: false });
    for (const s of ['Perlis', 'Kedah', 'Kelantan', 'Terengganu', 'Pahang']) expect(at(s).code).toBe('PG');
    for (const s of ['Selangor', 'W.P. Kuala Lumpur', 'Putrajaya', 'Melaka', 'Johor', 'Negeri Sembilan', 'Perak']) expect(at(s).code).toBe('KL');
    for (const s of ['Sabah', 'Sarawak', 'W.P. Labuan']) expect(at(s).code).toBe('EM');
    for (const s of ['Singapore', 'West', 'North-East', 'Central']) expect(at(s).code).toBe('SG');
    expect(at(null, '099206 SINGAPORE')).toEqual({ code: 'SG', noState: false });
    expect(at('', null, '640419')).toEqual({ code: 'SG', noState: false });
    expect(at(null, 'Ayer Keroh', '75450')).toEqual({ code: 'KL', noState: true });
  });

  test('a share is whole sen and adds back up', () => {
    expect(share(100_000, 3)).toEqual([33_334, 33_333, 33_333]);
    expect(share(-100, 3)).toEqual([-34, -33, -33]);
    expect(share(500, 0)).toEqual([]);
  });
});

describe('the report', () => {
  const input = (over: Partial<LogisticsInput> = {}): LogisticsInput => ({
    from: '2026-10-01', to: '2026-10-31',
    dos: [
      DO('d1', '2026-10-05', 'Selangor', 100_000, { lorryId: 'L1' }),
      DO('d2', '2026-10-05', 'Kuala Lumpur', 50_000, { plate: 'VRH 9058' }), // the same trip as d1
      DO('d3', '2026-10-06', 'Penang', 80_000, { plate: 'vpc9058' }),
      DO('d4', '2026-10-07', 'Penang', 20_000, { plate: 'W 1591 T' }),      // outside — the 3PL bills it
      DO('d5', '2026-10-08', 'Selangor', 10_000),                            // nobody named, but billed
      DO('d6', '2026-10-09', null, 5_000),                                   // nobody, nothing
      DO('d7', '2026-10-10', 'Selangor', 7_000, { plate: 'ABC 123' }),       // a plate on no list
      DO('d8', '2026-09-30', 'Selangor', 60_000, { lorryId: 'L1' }),         // September
    ],
    lorries: LORRIES,
    charges: [{ doId: 'd4', billedSen: 30_000 }, { doId: 'd5', billedSen: 15_000 }, { doId: 'd8', billedSen: 999 }],
    runs: [{ lineId: 'b1', apInvoiceNo: 'HC-API-2610-009', carrier: 'MSJ TRANSPORT', lineDate: null, invoiceDate: '2026-10-20', amountSen: 30_000, doIds: ['d4'], text: 'TRANSPORT TO PENANG' }],
    ownCost: [
      { month: '2026-10', accountCode: '900-P015', accountName: 'PETROL, TOL AND PARKING - LORI VRH 9058', amountSen: 60_000 },
      { month: '2026-10', accountCode: '900-U010', accountName: 'UPKEEP OF LORI - VPC 9058', amountSen: 30_000 },
    ],
    events: [{ id: 7, code: 'P7', name: 'IOI CITY MALL FAIR', startDate: '2026-10-16', endDate: '2026-10-20', setupSen: 870_000, transportSen: 103_000 }],
    openLines: { count: 2, sen: 3_480_00 }, eventLinesNoFair: { count: 1, sen: 500_00 },
    ...over,
  });

  test("the month's cost over the month's trips, shared by each trip's DOs", () => {
    const r = buildLogisticsReport(input());
    expect(r.months).toEqual([{
      month: '2026-10', ownCostSen: 90_000, trips: 2, perTripSen: 45_000,
      accounts: [
        { code: '900-P015', name: 'PETROL, TOL AND PARKING - LORI VRH 9058', sen: 60_000 },
        { code: '900-U010', name: 'UPKEEP OF LORI - VPC 9058', sen: 30_000 },
      ],
    }]);
    const own = r.trips.filter((t) => t.kind === 'own');
    expect(own.map((t) => [t.day, t.who, t.dos, t.amountSen, t.regions])).toEqual([
      ['2026-10-05', 'VRH9058', 2, 45_000, ['KL']],
      ['2026-10-06', 'VPC9058', 1, 45_000, ['Penang']],
    ]);
  });

  test('by region: the range\'s DOs, what they carry, our share and the 3PL bill', () => {
    const r = buildLogisticsReport(input());
    expect(r.regions.map(({ covers: _c, ...x }) => x)).toEqual([
      { code: 'PG', name: 'Penang', dos: 2, valueSen: 100_000, ownSen: 45_000, threeplSen: 30_000, totalSen: 75_000 },
      { code: 'KL', name: 'KL', dos: 5, valueSen: 172_000, ownSen: 45_000, threeplSen: 15_000, totalSen: 60_000 },
      { code: 'EM', name: 'SBH & SWK', dos: 0, valueSen: 0, ownSen: 0, threeplSen: 0, totalSen: 0 },
      { code: 'SG', name: 'SGD', dos: 0, valueSen: 0, ownSen: 0, threeplSen: 0, totalSen: 0 },
    ]);
    /* The DO with no state is KL's "others" — and is counted as such. */
    expect(r.gaps.dosNoState).toBe(1);
    /* September's DO and its charge are not October's. */
    expect(r.totals).toMatchObject({ dos: 7, ownSen: 90_000, threeplSen: 45_000, totalSen: 135_000, setupSen: 870_000, transportSen: 103_000 });
  });

  test('a 3PL run is one bill line, on its DOs\' day when the line has none', () => {
    const r = buildLogisticsReport(input());
    expect(r.trips.filter((t) => t.kind === '3pl')).toEqual([{
      kind: '3pl', day: '2026-10-07', who: 'MSJ TRANSPORT', ref: 'HC-API-2610-009', dos: 1, doNumbers: ['HC-DO-d4'], regions: ['Penang'], amountSen: 30_000,
    }]);
  });

  test('what is missing is named: nobody on a DO, a plate on no list, open bill lines, cost with no trip', () => {
    const r = buildLogisticsReport(input());
    expect(r.gaps).toMatchObject({
      dosNoDeliverer: 2, dosOutsideNoBill: 0, unlistedPlates: ['ABC 123'],
      openLines: { count: 2, sen: 3_480_00 }, eventLinesNoFair: { count: 1, sen: 500_00 }, monthsWithoutTrips: [],
    });
    const quiet = buildLogisticsReport(input({ from: '2026-11-01', to: '2026-11-30', dos: [], ownCost: [{ month: '2026-11', accountCode: '900-P015', accountName: null, amountSen: 12_345 }] }));
    expect(quiet.months).toEqual([{ month: '2026-11', ownCostSen: 12_345, trips: 0, perTripSen: null, accounts: [{ code: '900-P015', name: null, sen: 12_345 }] }]);
    expect(quiet.gaps.monthsWithoutTrips).toEqual(['2026-11']);
    expect(quiet.totals.ownSen).toBe(0);
  });

  test("part of a month: that month's trips are counted whole, the range shows its own", () => {
    const r = buildLogisticsReport(input({ from: '2026-10-06', to: '2026-10-31' }));
    expect(r.months[0]).toMatchObject({ trips: 2, perTripSen: 45_000 });
    expect(r.trips.filter((t) => t.kind === 'own').map((t) => t.day)).toEqual(['2026-10-06']);
    expect(r.totals.ownSen).toBe(45_000);
  });
});

describe('the default own-lorry cost accounts', () => {
  test('expense accounts naming a lorry or one of our plates; not the director, not the asset, not an inactive one', () => {
    const chart = [
      { account_code: '900-P015', account_name: 'PETROL, TOL AND PARKING - LORI VRH 9058', account_type: 'EXPENSE' },
      { account_code: '900-P010', account_name: 'PETROL, TOL AND PARKING - VPC 9058', account_type: 'EXPENSE' },
      { account_code: '900-P008', account_name: 'PETROL, TOL AND PARKING - DIRECTOR & OTHERS', account_type: 'EXPENSE' },
      { account_code: '900-U006', account_name: 'UPKEEP OF LORI', account_type: 'EXPENSE' },
      { account_code: '900-U007', account_name: 'UPKEEP OF LORI - JPL 9058', account_type: 'EXPENSE', is_active: false },
      { account_code: '207-1000', account_name: 'MOTOR VEHICLE', account_type: 'ASSET' },
    ];
    expect(defaultOwnCostAccounts(chart, LORRIES)).toEqual(['900-P010', '900-P015', '900-U006']);
  });
});
