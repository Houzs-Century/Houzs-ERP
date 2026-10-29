/* The Logistics P&L's arithmetic (owner 2026-10-29, 做 — his "Logistic Cost
   Report", nothing typed by hand). Pinned with the chart's real names and
   September 2026's real figures where they decide something:
     • months: a recharge billed in October for "SEP'26" is September's;
     • accounts by name: outsource by region, transport income by region, the
       own-lorry list split into petrol / upkeep, our lorries' HP creditors only;
     • setup / dismantle: one trip per venue per day, outsourced or unticked
       trips not ours, each area at its rate (none for East Malaysia);
     • spreads: each bill over its own months, 12 for insurance & road tax;
     • the P&L: income, outsource by region, in-house in the KL column, the net. */

import { describe, expect, test } from 'vitest';
import {
  addMonths, areaOf, buildLogisticsPnl, coveredKinds, incomeLines, incomeRowOf, isManpowerLine, monthNamed,
  outsourceRegionOf, pnlAccountsOf, setupTrips, spreadBills, transportIncomeRegionOf,
  type BillLine, type Fair, type Leg,
} from './logistics-pnl';

const acc = (account_code: string, account_name: string, account_type = 'EXPENSE') => ({ account_code, account_name, account_type, is_active: true });

describe('months', () => {
  test("the month a line names wins over the bill's date; a word that is not a month names none", () => {
    expect(monthNamed("LOGISTICS CHARGES - SEP'26")).toBe('2026-09');
    expect(monthNamed("UMOBILE SEPT'26")).toBe('2026-09');
    expect(monthNamed('RENTAL FOR KELANA JAYA AUG 2026')).toBe('2026-08');
    expect(monthNamed('MARKETING 2026')).toBeNull();
    expect(monthNamed(null)).toBeNull();
    expect(addMonths('2026-11', 3)).toBe('2027-02');
  });
});

describe('accounts by what their names say', () => {
  test("outsource by region — the fair-transport accounts are the fairs'", () => {
    expect(outsourceRegionOf('TRANSPORT (PNG, PERLIS, KEDAH, KELATAN, TERENGGANU, PAHANG)')).toBe('PG');
    expect(outsourceRegionOf('TRANSPORT (KL, SLG, MLK, JHR, OTHERS)')).toBe('KL');
    expect(outsourceRegionOf('TRANSPORT (SABAH & SARAWAK)')).toBe('EM');
    expect(outsourceRegionOf('TRANSPORT (SBH & SWK) - SEAFREIGHT')).toBe('EM');
    expect(outsourceRegionOf('TRANSPORT (SBH & SWK NEW)')).toBe('EM');
    expect(outsourceRegionOf('TRANSPORT (SGD)')).toBe('SG');
    expect(outsourceRegionOf('TRANSPORT SGD - SST 9%')).toBe('SG');
    for (const n of ['TRANSPORT FAIR (KL, SLG, MLK, JHR, OTHERS)', 'BOOTH TRANSPORT (SABAH & SARAWAK)', 'TRANSPORTATION FEE', 'TRANSPORTATION FEES - OTHERS']) {
      expect(outsourceRegionOf(n)).toBeNull();
    }
  });

  test('transport income by region; the plain TRANSPORT INCOME is KL', () => {
    expect(transportIncomeRegionOf('TRANSPORT INCOME')).toBe('KL');
    expect(transportIncomeRegionOf('TRANSPORT INCOME (PNG, PERLIS, KEDAH, KELANTAN, TERENGGANU, PAHANG)')).toBe('PG');
    expect(transportIncomeRegionOf('TRANSPORT INCOME (KL, SLG, MLK, JHR, OTHERS)')).toBe('KL');
    expect(transportIncomeRegionOf('TRANSPORT INCOME (SABAH & SARAWAK)')).toBe('EM');
    expect(transportIncomeRegionOf('TRANSPORT INCOME (SGD)')).toBe('SG');
    expect(transportIncomeRegionOf('ADDITIONAL INCOME')).toBeNull();
  });

  test('the own-lorry list splits into petrol and upkeep; only our lorries\' HP creditors; manpower never re-reads the list', () => {
    const chart = [
      acc('900-P006', 'PETROL, TOL AND PARKING - LORI VNB 9058'), acc('900-U008', 'UPKEEP OF LORI - VNB 9058'),
      acc('900-I002', 'INSURANCE & ROAD TAX'), acc('900-S100', 'STAFF SALARIES & OVERTIME'), acc('900-S200', "E'YER EPF"),
      acc('450-H001', 'HP CREDITOR- JPL 9058', 'LIABILITY'), acc('450-H002', 'HP CREDITOR- VNB 9058', 'LIABILITY'),
      acc('450-H004', 'HP CREDITOR - FORKLIFT', 'LIABILITY'), acc('900-T005', 'TRANSPORT (PNG, PERLIS, KEDAH, KELATAN, TERENGGANU, PAHANG)'),
    ];
    const lorries = [{ id: '1', plate: 'VNB9058', isInternal: true }, { id: '2', plate: 'JPL9058', isInternal: false }];
    const a = pnlAccountsOf(chart, lorries, ['900-P006', '900-U008', '900-S200']);
    expect([...a.petrol]).toEqual(['900-P006']);
    expect([...a.upkeep]).toEqual(['900-U008']);
    expect([...a.otherLorry]).toEqual(['900-S200']);
    expect([...a.roadTax]).toEqual(['900-I002']);
    expect([...a.instalment]).toEqual(['450-H002']);
    expect([...a.salary]).toEqual(['900-S100']);
    expect(a.outsource.get('900-T005')).toBe('PG');
    expect(isManpowerLine("OPERATION HELPER SALARY - SEPT'26")).toBe(true);
    expect(isManpowerLine("OPERATION DELIVERY EPF - SEPT'26")).toBe(true);
    expect(isManpowerLine("OPERATION STOREKEEPER SALARY - SEPT'26")).toBe(false);
  });
});

describe('setup and dismantle trips', () => {
  const fair = (id: number, venue: string, state: string, start: string, end: string): Fair =>
    ({ id, code: `F${id}`, name: `FAIR ${id}`, state, venue, startDate: start, endDate: end });

  test('one trip per venue per day; an outsourced or unticked trip is not ours; each area at its rate', () => {
    const trips = setupTrips({
      fairs: [
        fair(1, 'Mid Valley', 'KUALA LUMPUR', '2026-09-11', '2026-09-14'),
        fair(2, 'MID VALLEY', 'Kuala Lumpur', '2026-09-11', '2026-09-14'),   // the second booth rides the same trips
        fair(3, 'MVEC Southkey', 'JOHOR', '2026-09-18', '2026-10-02'),        // dismantled next month
        fair(4, 'PWCC', 'PULAU PINANG', '2026-09-25', '2026-09-28'),
        fair(5, 'MCCC', 'SARAWAK', '2026-09-24', '2026-09-27'),
      ],
      outsourced: new Map([[4, new Set(['dismantle' as const])]]),
      marks: new Map([['setup|MVECSOUTHKEY|2026-09-18', false]]),
      rates: new Map([['johor', 120_000]]),
      from: '2026-09-01', to: '2026-09-30',
    });
    const brief = trips.map((t) => [t.kind, t.day, t.areaLabel, t.fairs.length, t.inHouse, t.amountSen]);
    expect(brief).toEqual([
      ['setup', '2026-09-11', 'Kuala Lumpur', 2, true, 40_000],
      ['dismantle', '2026-09-14', 'Kuala Lumpur', 2, true, 40_000],
      ['setup', '2026-09-18', 'Johor', 1, false, 0],
      ['setup', '2026-09-24', 'Sarawak', 1, true, 0],
      ['setup', '2026-09-25', 'Penang', 1, true, 60_000],
      ['dismantle', '2026-09-27', 'Sarawak', 1, true, 0],
      ['dismantle', '2026-09-28', 'Penang', 1, false, 0],
    ]);
    expect(trips.find((t) => t.areaLabel === 'Johor')!.rateSen).toBe(120_000);
    expect(trips.find((t) => t.areaLabel === 'Sarawak')!.rateSen).toBeNull();
    expect(areaOf('W.P. Kuala Lumpur')!.key).toBe('kualalumpur');
    expect(areaOf('Atlantis')).toBeNull();
  });

  test("an outsourced line covers its kind, else the way its words say, else both", () => {
    expect(coveredKinds('setup', 'whatever')).toEqual(['setup']);
    expect(coveredKinds(null, 'TRANSPORT FEE FOR EVENT SETUP - DISMANTLE EVENT SPCC 06/07/26')).toEqual(['dismantle']);
    expect(coveredKinds('delivery', 'TRANSPORT DELIVERY FEE (SETUP FAIR) 23.09.26 2 TRIP')).toEqual(['setup']);
    expect(coveredKinds(null, 'TRANSPORT DELIVERY FEE (RETURN FAIR) 28.09.26')).toEqual(['dismantle']);
    expect(coveredKinds(null, 'SETUP & DISMANTLE KLCC')).toEqual(['setup', 'dismantle']);
    expect(coveredKinds(null, '1 TRIP AKEMI')).toEqual(['setup', 'dismantle']);
  });
});

describe('bills spread over months', () => {
  test('each bill over its own months; upkeep its own month until then; insurance 12', () => {
    const legs = [
      { lineId: 'u1', kind: 'upkeep' as const, accountCode: '900-U011', accountName: 'UPKEEP OF LORI - VQE 9058', day: '2026-09-01', docNo: 'JE-1', notes: 'REPAIR', amountSen: 300_000 },
      { lineId: 'u2', kind: 'upkeep' as const, accountCode: '900-U008', accountName: 'UPKEEP OF LORI - VNB 9058', day: '2026-09-09', docNo: 'JE-2', notes: 'SERVICE', amountSen: 73_880 },
      { lineId: 'i1', kind: 'roadtax' as const, accountCode: '900-I002', accountName: 'INSURANCE & ROAD TAX', day: '2026-09-30', docNo: 'JE-3', notes: 'INSURANCE VNB', amountSen: 444_275 },
    ];
    const oct = spreadBills(legs, new Map([['u1', 3]]), ['2026-10']);
    expect(oct.sen).toEqual({ upkeep: 100_000, roadtax: 37_023 });
    expect(oct.rows.map((r) => [r.lineId, r.months, r.isDefault, r.inRangeSen, r.lastMonth])).toEqual([
      ['u1', 3, false, 100_000, '2026-11'],
      ['i1', 12, true, 37_023, '2027-08'],
    ]);
    const sep = spreadBills(legs, new Map(), ['2026-09']);
    expect(sep.sen.upkeep).toBe(373_880);
  });
});

describe('what Finance billed extra', () => {
  const line = (o: Partial<BillLine>): BillLine => ({
    lineId: 'l', billNo: 'HC-ODB-2610-001', billDate: '2026-10-23', debtorName: '2990 Home Sdn Bhd', description: null,
    accountCode: '599-0000', accountName: 'ADDITIONAL INCOME', amountSen: 0, ...o,
  });
  test('a transport income account by its region; a recharge worded so under KL; the month the line names', () => {
    const got = incomeLines([
      line({ lineId: 'a', description: "LOGISTICS CHARGES - SEP'26", amountSen: 444_210 }),
      line({ lineId: 'b', description: "OPERATION CHARGES - SEP'26", amountSen: 740_350 }),
      line({ lineId: 'c', debtorName: 'SG PARTNER PTE LTD', description: 'DELIVERY TO PUNGGOL', accountCode: '590-0004', accountName: 'TRANSPORT INCOME (SGD)', billDate: '2026-09-29', amountSen: 91_180 }),
      line({ lineId: 'd', debtorName: 'THE CONTS SDN BHD (OTHER DEBTOR)', description: "UMOBILE SEPT'26", accountName: 'UTILITY EXPENSE', amountSen: 170_721 }),
      line({ lineId: 'e', description: "LOGISTICS CHARGES - AUG'26", amountSen: 472_770 }),
    ], ['2026-09']);
    expect(got.map((l) => [l.lineId, l.month, l.row, l.region, l.by])).toEqual([
      ['a', '2026-09', '2990', 'KL', 'wording'],
      ['c', '2026-09', 'houzs', 'SG', 'account'],
    ]);
    expect(incomeRowOf('THE CONTS SDN BHD (OTHER DEBTOR)')).toBe('conts');
    expect(incomeRowOf('HOOKKA INDUSTRIES')).toBe('hookka');
  });
});

describe('the P&L', () => {
  const leg = (o: Partial<Leg>): Leg => ({ lineId: 'x', accountCode: '', accountName: null, day: '2026-09-15', debitSen: 0, creditSen: 0, notes: null, docNo: null, ...o });
  const accounts = {
    outsource: new Map([['900-T005', 'PG' as const], ['900-T006', 'KL' as const], ['900-T027', 'SG' as const]]),
    petrol: new Set(['900-P015']), upkeep: new Set(['900-U010']), otherLorry: new Set<string>(),
    roadTax: new Set(['900-I002']), instalment: new Set(['450-H002']), salary: new Set(['900-S100']),
  };

  test("September's shape: income, outsource by region, in-house in KL, the net and per DO", () => {
    const p = buildLogisticsPnl({
      from: '2026-09-01', to: '2026-09-30',
      dos: [{ region: 'PG', valueSen: 10_000_000 }, { region: 'KL', valueSen: 20_000_000 }, { region: 'KL', valueSen: 10_000_000 }, { region: 'SG', valueSen: 5_000_000 }],
      doIncomeBp: 300,
      income: [{ lineId: 'a', billNo: 'B', billDate: '2026-10-23', debtorName: '2990 Home Sdn Bhd', description: null, accountCode: '599-0000', accountName: null, amountSen: 444_210, month: '2026-09', row: '2990', region: 'KL', by: 'wording' }],
      trips: [{ key: 'k', kind: 'setup', day: '2026-09-11', venue: 'MID VALLEY', area: 'kualalumpur', areaLabel: 'Kuala Lumpur', region: 'KL', fairs: [], rateSen: 40_000, outsourced: false, mark: null, inHouse: true, amountSen: 40_000 }],
      legs: [
        leg({ accountCode: '900-T005', debitSen: 1_597_000 }),
        leg({ accountCode: '900-T006', debitSen: 138_000 }),
        leg({ accountCode: '900-T027', debitSen: 507_233 }),
        leg({ accountCode: '900-T027', debitSen: 999, day: '2026-08-31' }),             // not this month
        leg({ accountCode: '900-P015', debitSen: 814_726 }),
        leg({ lineId: 'u', accountCode: '900-U010', debitSen: 116_200, day: '2026-09-10' }),
        leg({ accountCode: '450-H002', debitSen: 252_100 }),
        leg({ accountCode: '450-H002', creditSen: 9_000_000 }),                           // a new agreement is no instalment
        leg({ accountCode: '900-S100', debitSen: 1_978_363, notes: "OPERATION HELPER SALARY - SEPT'26" }),
        leg({ accountCode: '900-S100', debitSen: 5_000_000, notes: "FINANCE - SALARY - SEP'26" }),
      ],
      accounts, spreadMonths: new Map(), ownTrips: 4,
    });
    const row = (k: string) => p.rows.find((r) => r.key === k)!;
    expect(p.dos).toEqual({ PG: 1, KL: 2, EM: 0, SG: 1, total: 4 });
    expect(row('do_value').totalSen).toBe(45_000_000);
    expect(row('do_income').label).toBe('Transport Income (3% of DO)');
    expect(row('do_income').sen).toEqual({ PG: 300_000, KL: 900_000, EM: 0, SG: 150_000 });
    expect(row('ti_2990').sen.KL).toBe(444_210);
    expect(row('sd_income').sen.KL).toBe(40_000);
    expect(row('total_income').totalSen).toBe(1_350_000 + 444_210 + 40_000);
    expect(row('outsource').sen).toEqual({ PG: 1_597_000, KL: 138_000, EM: 0, SG: 507_233 });
    expect(row('petrol').sen).toEqual({ PG: 0, KL: 814_726, EM: 0, SG: 0 });
    expect(row('upkeep').totalSen).toBe(116_200);
    expect(row('instalment').totalSen).toBe(252_100);
    expect(row('manpower').totalSen).toBe(1_978_363);
    expect(p.rows.some((r) => r.key === 'other_lorry')).toBe(false);
    const inHouse = 814_726 + 116_200 + 252_100 + 1_978_363;
    expect(row('inhouse_total').sen.KL).toBe(inHouse);
    expect(row('total_expense').totalSen).toBe(1_597_000 + 138_000 + 507_233 + inHouse);
    expect(row('net').sen.PG).toBe(300_000 - 1_597_000);
    expect(row('cost_per_do').sen.KL).toBe(Math.round((138_000 + inHouse) / 2));
    expect(row('cost_per_do').sen.EM).toBeNull();
    expect(row('net_cost_per_do').sen.KL).toBe(Math.round((138_000 + inHouse - 444_210 - 40_000) / 2));
    expect(p.inHousePerTripSen).toBe(Math.round(inHouse / 4));
    expect(p.spreads.map((s) => s.lineId)).toEqual(['u']);
  });
});
