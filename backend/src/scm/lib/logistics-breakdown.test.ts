/* The Logistics cost report's By region & trip and Setup & Dismantle, one month
   (owner 2026-11-05): the delivery cost is the P&L's TOTAL EXPENSE by
   construction — our lorries the full in-house cost ÷ trips, split by DO count;
   3PL the ledger's outsource by bill, to its DOs' regions, the rest on no DO. */

import { describe, expect, test } from 'vitest';
import { buildMonthCost, fairBlock, monthCostTotal, scaleTo, type ThreeplBill } from './logistics-breakdown';
import type { LogisticsDo } from './logistics-cost';

const doOf = (id: string, day: string, plate: string | null, valueSen = 100_000): LogisticsDo => ({
  id, doNumber: `DO-${id}`, soDocNo: null, day, state: null, valueSen, crewLorryId: null, crewPlate: plate,
});
const lorries = [{ id: 'L1', plate: 'VRH9058', isInternal: true }, { id: 'L2', plate: 'VPC9058', isInternal: true }];

describe('by region & trip', () => {
  test('our lorries: the full in-house cost ÷ trips; a trip into two regions splits by DOs', () => {
    const dos = [doOf('a', '2026-10-02', 'VRH 9058'), doOf('b', '2026-10-02', 'VRH9058'), doOf('c', '2026-10-02', 'VRH9058'),
      doOf('d', '2026-10-03', 'VPC9058'), doOf('e', '2026-10-03', null)];
    const regionOf = new Map([['a', 'KL'], ['b', 'KL'], ['c', 'PG'], ['d', 'SG'], ['e', 'EM']] as const);
    const m = buildMonthCost({ month: '2026-10', dos, regionOf, lorries, charged: new Set(), inHouseSen: 1_000_001, legs: [], bills: new Map() });
    expect(m.ownTrips).toBe(2);
    expect(m.lorries.map((l) => [l.plate, l.trips, l.dos, l.sen])).toEqual([
      ['VPC9058', 1, 1, { PG: 0, KL: 0, EM: 0, SG: 500_001 }],
      ['VRH9058', 1, 3, { PG: 166_666, KL: 333_334, EM: 0, SG: 0 }],
    ]);
    expect(m.lorries[1]!.tripList).toEqual([{ day: '2026-10-02', dos: 3, doNumbers: ['DO-a', 'DO-b', 'DO-c'], sen: { PG: 166_666, KL: 333_334, EM: 0, SG: 0 } }]);
    expect(m.noDeliverer).toEqual({ PG: 0, KL: 0, EM: 1, SG: 0 });
    expect(m.inHouseNoTripSen).toBe(0);
    expect(monthCostTotal(m)).toBe(1_000_001);
  });

  test('a month with in-house cost and no trip keeps it on its own line', () => {
    const m = buildMonthCost({ month: '2026-10', dos: [], regionOf: new Map(), lorries, charged: new Set(), inHouseSen: 50_000, legs: [], bills: new Map() });
    expect(m.lorries).toEqual([]);
    expect(m.inHouseNoTripSen).toBe(50_000);
    expect(monthCostTotal(m)).toBe(50_000);
  });

  test("3PL: each bill's ledger amount to its DOs' regions, the rest on no DO; a posting with no 3PL bill in its account's region", () => {
    const regionOf = new Map([['p1', 'PG'], ['p2', 'PG'], ['k1', 'KL']] as const);
    const bills = new Map<string, ThreeplBill>([
      ['API-1', { billNo: 'API-1', day: '2026-10-05', carrier: 'MSJ TRANSPORT', supplier: 'MSJ SDN BHD', lines: [
        { amountSen: 24_000, assign: 'do', doIds: ['p1', 'p2'] },
        { amountSen: 10_000, assign: 'do', doIds: ['k1'] },
        { amountSen: 5_000, assign: null, doIds: [] },
        { amountSen: 9_999, assign: 'event', doIds: [] },
      ] }],
      ['API-2', { billNo: 'API-2', day: '2026-10-06', carrier: 'EU', supplier: null, lines: [{ amountSen: 30_000, assign: 'do', doIds: ['p1'] }] }],
    ]);
    const m = buildMonthCost({
      month: '2026-10', dos: [], regionOf, lorries, charged: new Set(), inHouseSen: 0, bills,
      legs: [
        { accountRegion: 'KL', netSen: 39_000, billNo: 'API-1', partyName: null },
        { accountRegion: 'PG', netSen: 20_000, billNo: 'API-2', partyName: null },  // the bill's lines say more: scaled down
        { accountRegion: 'SG', netSen: 7_000, billNo: null, partyName: 'SG MOVERS' },
      ],
    });
    expect(m.carriers.map((c) => [c.name, c.sen, c.dos])).toEqual([
      ['MSJ TRANSPORT', { PG: 24_000, KL: 10_000, EM: 0, SG: 0 }, 3],
      ['EU', { PG: 20_000, KL: 0, EM: 0, SG: 0 }, 1],
      ['SG MOVERS', { PG: 0, KL: 0, EM: 0, SG: 7_000 }, 0],
    ]);
    expect(m.threeplNoDo).toEqual({ lines: 1, sen: 5_000 });
    expect(m.outsourceSen).toBe(66_000);
    expect(monthCostTotal(m)).toBe(66_000);
  });

  test('scaling keeps whole sen and the total', () => {
    expect(scaleTo({ PG: 1, KL: 1, EM: 1, SG: 0 }, 100)).toEqual({ PG: 34, KL: 33, EM: 33, SG: 0 });
  });
});

describe('setup & dismantle', () => {
  test("a fair's income and cost from its own lines: the Logistics charge, setup, dismantle, transport", () => {
    const b = fairBlock({
      fair: { id: 1, code: 'X', name: 'MIECF', venue: 'MITEC', startDate: '2026-10-09', endDate: '2026-10-12', region: 'KL' },
      salesRm: 386_400, fairIncomeBp: 100, chargeDocNo: 'Logistics charge',
      lines: [
        { kind: 'cost', category: 'transport_setup_dismantle', amount: 400, source: 'books', doc_no: 'Logistics charge' },
        { kind: 'cost', category: 'transport_setup_dismantle', amount: 400, source: 'books', doc_no: 'Logistics charge' },
        { kind: 'cost', category: 'transport_setup_dismantle', amount: 300, source: 'books', doc_no: 'HC-API-1', description: 'DISMANTLE EVENT MITEC' },
        { kind: 'cost', category: 'transport_setup_dismantle', amount: 120.5, description: 'lorry hire' },
        { kind: 'cost', category: 'setup', amount: 650 },
        { kind: 'cost', category: 'setup', amount: 99, auto_source: 'rate' },
        { kind: 'income', category: 'sales', amount: 1 },
      ],
      books: { setupRm: 650, transportSetupDismantleRm: 1_220.5 },
    });
    expect(b).toMatchObject({ salesSen: 38_640_000, incomeSen: 386_400, chargeTrips: 2, chargeSen: 80_000, setupSen: 65_000, dismantleSen: 30_000, transportSen: 12_050, booksSen: 187_050, who: '3pl' });
    expect(b.chargeSen + b.setupSen + b.dismantleSen + b.transportSen).toBe(b.booksSen);
  });
});
