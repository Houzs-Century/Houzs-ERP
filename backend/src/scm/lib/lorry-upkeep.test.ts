/* Each lorry's repair & maintenance cost (owner 2026-11-25): one lorry per upkeep
   account, each bill in the months the P&L spreads it over, so the lorries add up
   to the P&L's Upkeep Cost; a bill naming another lorry is flagged, never moved. */

import { describe, expect, test } from 'vitest';
import { lorryUpkeep, plateOfAccountName, platesNamed } from './lorry-upkeep';
import { spreadBills, type SpreadLeg } from './logistics-pnl';

const accounts = [
  { code: '900-U007', name: 'UPKEEP OF LORI - JPL 9058' },
  { code: '900-U008', name: 'UPKEEP OF LORI - VNB 9058' },
  { code: '900-U009', name: 'UPKEEP OF LORI - 3RD' },
  { code: '900-U010', name: 'UPKEEP OF LORI - VPC 9058' },
  { code: '900-U011', name: 'UPKEEP OF LORI - VQE 9058' },
  { code: '900-U014', name: 'UPKEEP OF LORI - VRH 9058' },
];
const ourPlates = new Set(['VNB9058', 'VPC9058', 'VQE9058', 'VRH9058', 'VRM9058']);
const leg = (lineId: string, accountCode: string, day: string, amountSen: number, notes: string, kind: SpreadLeg['kind'] = 'upkeep'): SpreadLeg => ({
  lineId, kind, accountCode, accountName: accounts.find((a) => a.code === accountCode)?.name ?? null, day, docNo: `PV-${lineId}`, notes, amountSen,
});

describe('plates', () => {
  test('the plate an account name ends on', () => {
    expect(plateOfAccountName('UPKEEP OF LORI - VNB 9058')).toBe('VNB9058');
    expect(plateOfAccountName('UPKEEP OF LORI - JPL 9058')).toBe('JPL9058');
    expect(plateOfAccountName('UPKEEP OF LORI - 3RD')).toBeNull();
    expect(plateOfAccountName('UPKEEP OF LORI')).toBeNull();
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

describe('repairs by lorry', () => {
  const range = ['2026-09', '2026-10', '2026-11'];
  const legs = [
    leg('a', '900-U008', '2026-09-09', 10_000, 'VNB 9058 - SERVICE LORRY'),
    { ...leg('b', '900-U010', '2026-09-28', 5_000, 'VNB 9058 - REPAIR LORRY - WC00001'), docNo: 'JE-2609-0001', sourceDocNo: 'HC-HPV-2609-001' },
    leg('c', '900-U011', '2026-10-14', 10_001, 'VQE 9058 - NEW TYRES'),
    leg('d', '900-U010', '2026-10-20', 2_000, 'VPC 9058 AND VNB 9058 - SHARED PART'),
    leg('e', '900-I002', '2026-09-30', 12_000, 'INSURANCE FOR VNB 9058', 'roadtax'),
  ];
  const spread = spreadBills(legs, new Map([['c', 3]]), range);
  const lorries = lorryUpkeep({ rows: spread.rows, range, accounts, ourPlates });

  test('one line per lorry: ours by plate, a lorry with no bill at zero, an old account only with money', () => {
    expect(lorries.map((l) => [l.plate, l.accountCode, l.ours, l.totalSen, l.bills.map((b) => b.lineId)])).toEqual([
      ['VNB9058', '900-U008', true, 10_000, ['a']],
      ['VPC9058', '900-U010', true, 7_000, ['b', 'd']],
      ['VQE9058', '900-U011', true, 6_668, ['c']],
      ['VRH9058', '900-U014', true, 0, []],
    ]);
  });

  test('a bill counts in the months the P&L spreads it over, only those shown', () => {
    const vqe = lorries.find((l) => l.plate === 'VQE9058')!;
    expect(vqe.bills[0]!.months).toBe(3);
    expect(vqe.bills[0]!.byMonth).toEqual({ '2026-10': 3_334, '2026-11': 3_334 });
    expect(vqe.byMonth).toEqual({ '2026-10': 3_334, '2026-11': 3_334 });
  });

  test('the lorries add up to the P&L Upkeep Cost, month by month', () => {
    for (const m of range) {
      const pnl = spreadBills(legs, new Map([['c', 3]]), [m]).sen.upkeep;
      expect(lorries.reduce((t, l) => t + (l.byMonth[m] ?? 0), 0)).toBe(pnl);
    }
  });

  test('a bill naming only another lorry is flagged, and stays where the books put it', () => {
    const vpc = lorries.find((l) => l.plate === 'VPC9058')!;
    expect(vpc.bills.map((b) => [b.lineId, b.otherPlate])).toEqual([['b', 'VNB9058'], ['d', null]]);
    /* The PV that posted it, not the journal entry; the journal entry when no document is named. */
    expect(vpc.bills.map((b) => b.docNo)).toEqual(['HC-HPV-2609-001', 'PV-d']);
    expect(lorries.find((l) => l.plate === 'VNB9058')!.bills.map((b) => b.otherPlate)).toEqual([null]);
  });

  test('an account the chart no longer names still shows its bills; another company with none shows nothing', () => {
    const rows = spreadBills([{ ...leg('f', '900-U013', '2026-10-29', 3_000, 'VRM 9058 - SERVICE'), accountName: 'UPKEEP OF LORI - VRM 9058' }], new Map(), range).rows;
    expect(lorryUpkeep({ rows, range, accounts: [], ourPlates }).map((l) => [l.plate, l.totalSen])).toEqual([['VRM9058', 3_000]]);
    expect(lorryUpkeep({ rows: [], range, accounts, ourPlates: new Set() })).toEqual([]);
  });
});
