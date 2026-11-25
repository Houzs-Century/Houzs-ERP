/* What each lorry costs (owner 2026-11-25): every in-house line the Logistics P&L
   counts, on the lorry its account or its description names, else Not tied; upkeep
   and road tax in the P&L's months, so the lorries add up to its Total In-house
   Expenses; a line naming another lorry is flagged, never moved. */

import { describe, expect, test } from 'vitest';
import { lorrySpend, plateOfAccountName, platesNamed } from './lorry-spend';
import { buildLogisticsPnl, type Leg, type PnlAccounts } from './logistics-pnl';

describe('plates', () => {
  test('the plate an account name ends on', () => {
    expect(plateOfAccountName('UPKEEP OF LORI - VNB 9058')).toBe('VNB9058');
    expect(plateOfAccountName('PETROL, TOL AND PARKING - LORI VQE 9058')).toBe('VQE9058');
    expect(plateOfAccountName('HP CREDITOR- VPC 9058')).toBe('VPC9058');
    expect(plateOfAccountName('UPKEEP OF LORI - 3RD')).toBeNull();
    expect(plateOfAccountName('INSURANCE & ROAD TAX')).toBeNull();
    expect(plateOfAccountName('STAFF SALARIES & OVERTIME')).toBeNull();
    expect(plateOfAccountName(null)).toBeNull();
  });

  test('a description names a known plate only when it spells it whole', () => {
    const known = ['VNB9058', 'VPC9058', 'VRM9058'];
    expect(platesNamed('VNB 9058 - REPAIR LORRY - WC00001', known)).toEqual(['VNB9058']);
    expect(platesNamed('vnb9058 service', known)).toEqual(['VNB9058']);
    expect(platesNamed('CHECK - CHANGE TYRE VNB 14.09.2026', known)).toEqual([]);
    expect(platesNamed('WH BLK - FUEL VRM 23.10.2026', known)).toEqual([]);
    expect(platesNamed(null, known)).toEqual([]);
  });
});

describe('spend by lorry', () => {
  const accounts: PnlAccounts = {
    outsource: new Map(), income: new Map(),
    petrol: new Set(['900-P006', '900-P010']), upkeep: new Set(['900-U008']), otherLorry: new Set<string>(),
    roadTax: new Set(['900-I002']), instalment: new Set(['450-H002']), salary: new Set(['900-S100']),
  };
  const NAME: Record<string, string> = {
    '900-P006': 'PETROL, TOL AND PARKING - LORI VNB 9058', '900-P010': 'PETROL, TOL AND PARKING - VPC 9058',
    '900-U008': 'UPKEEP OF LORI - VNB 9058', '900-I002': 'INSURANCE & ROAD TAX', '450-H002': 'HP CREDITOR- VNB 9058',
    '900-S100': 'STAFF SALARIES & OVERTIME',
  };
  const leg = (lineId: string, accountCode: string, day: string, debitSen: number, notes: string, o: Partial<Leg> = {}): Leg => ({
    lineId, accountCode, accountName: NAME[accountCode] ?? null, day, debitSen, creditSen: 0, notes, docNo: `JE-${lineId}`, ...o,
  });
  const legs: Leg[] = [
    leg('p1', '900-P006', '2026-09-05', 50_000, 'VNB 9058 - DIESEL', { sourceDocNo: 'HC-HPV-2609-001' }),
    leg('p2', '900-P010', '2026-10-07', 20_000, 'VNB 9058 - TOLL'),
    leg('u1', '900-U008', '2026-09-20', 30_000, 'VNB 9058 - SERVICE'),
    leg('i1', '900-I002', '2026-09-30', 120_000, 'INSURANCE FOR VNB 9058 (01 OCT 2026 - 30 SEP 2027)'),
    leg('h1', '450-H002', '2026-10-09', 25_000, 'VNB 9058 - INSTALLMENT 24/60'),
    leg('h2', '450-H002', '2026-10-09', 0, 'NEW AGREEMENT', { creditSen: 9_000_000 }),
    leg('s1', '900-S100', '2026-09-30', 400_000, "OPERATION DELIVERY SALARY - SEPT'26"),
    leg('s2', '900-S100', '2026-09-30', 100_000, "FINANCE - SALARY - SEP'26"),
  ];
  const ourPlates = new Set(['VNB9058', 'VPC9058', 'VRH9058']);
  const pnl = (from: string, to: string) => buildLogisticsPnl({
    from, to, dos: [], doIncomeBp: 300, fairs: [], fairIncomeBp: 100, income: [], trips: [],
    legs, accounts, spreadMonths: new Map([['u1', 3]]), ownTrips: 0,
  });
  const p = pnl('2026-09-01', '2026-10-31');
  const accountNames = new Map(Object.entries(NAME));
  const lorries = lorrySpend({ lines: p.inHouseLines, spreads: p.spreads, range: p.months, accountNames, ourPlates });

  test('one entry per lorry by its account, else its description; driver pay is Not tied; our lorries show at zero', () => {
    expect(lorries.map((l) => [l.plate, l.ours, l.totalSen, l.lines.map((x) => `${x.lineId}:${x.kind}`)])).toEqual([
      ['VNB9058', true, 115_000, ['p1:petrol', 'u1:upkeep', 'i1:roadtax', 'h1:instalment']],
      ['VPC9058', true, 20_000, ['p2:petrol']],
      ['VRH9058', true, 0, []],
      [null, false, 400_000, ['s1:manpower']],
    ]);
  });

  test('upkeep and road tax in the months the P&L spreads them over, the rest in its own month', () => {
    const vnb = lorries[0]!;
    expect(vnb.byMonth).toEqual({ '2026-09': 70_000, '2026-10': 45_000 });
    expect(vnb.lines.map((x) => [x.lineId, x.months, x.byMonth])).toEqual([
      ['p1', 1, { '2026-09': 50_000 }],
      ['u1', 3, { '2026-09': 10_000, '2026-10': 10_000 }],
      ['i1', 12, { '2026-09': 10_000, '2026-10': 10_000 }],
      ['h1', 1, { '2026-10': 25_000 }],
    ]);
  });

  test('the lorries and Not tied add up to the P&L Total In-house Expenses, month by month', () => {
    for (const [from, to] of [['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-31']] as const) {
      const books = pnl(from, to).rows.find((r) => r.key === 'inhouse_total')!.totalSen;
      expect(lorries.reduce((t, l) => t + (l.byMonth[from.slice(0, 7)] ?? 0), 0)).toBe(books);
    }
  });

  test('a line on one lorry\'s account naming only another is flagged and stays; the PV number wins over the journal\'s', () => {
    expect(lorries[1]!.lines.map((x) => [x.lineId, x.otherPlate])).toEqual([['p2', 'VNB9058']]);
    expect(lorries[0]!.lines.map((x) => x.otherPlate)).toEqual([null, null, null, null]);
    expect(lorries[0]!.lines.map((x) => x.docNo)).toEqual(['HC-HPV-2609-001', 'JE-u1', 'JE-i1', 'JE-h1']);
  });

  test('the chart names the account when the ledger row does not', () => {
    const bare = buildLogisticsPnl({
      from: '2026-09-01', to: '2026-09-30', dos: [], doIncomeBp: 300, fairs: [], fairIncomeBp: 100, income: [], trips: [],
      legs: [leg('p9', '900-P010', '2026-09-08', 7_000, 'TOLL', { accountName: null })], accounts, spreadMonths: new Map(), ownTrips: 0,
    });
    expect(lorrySpend({ lines: bare.inHouseLines, spreads: bare.spreads, range: bare.months, accountNames, ourPlates })
      .map((l) => [l.plate, l.totalSen])).toEqual([['VNB9058', 0], ['VPC9058', 7_000], ['VRH9058', 0]]);
  });

  test('a company with no lorry and no line shows nothing', () => {
    expect(lorrySpend({ lines: [], spreads: [], range: ['2026-09'], accountNames, ourPlates: new Set() })).toEqual([]);
  });
});
