/* The Cash Flow's Capex & financing table (step 3 of the Hookka forecast port;
   Hookka tests/cashflow-forecast.test.mjs, the keyed-inputs cases, ported).
   Pinned: the accounts offered are the funding block's active leaves, trade
   finance and accumulated depreciation aside, each once, grouped by the
   categories that place it; a save names its first bad cell, drops a zero
   and refuses an account no longer offered; an amount is forecast money on
   its own account, + in and − out; the accounts left to clear. Made-up names. */
import { describe, expect, it } from 'vitest';
import { keyableAccounts, keyedInputLegs, keyedNotOffered, validateKeyedInputs, KEYED_PARTY } from './forecast-inputs';
import type { LayoutItem } from './report-layout';

const acc = (code: string, flow: 'in' | 'out' | 'net'): LayoutItem => ({ kind: 'account', code, flow });
const TREE: LayoutItem[] = [
  { kind: 'category', id: 'cf:in', label: 'CASH IN', flow: 'in', children: [acc('300-0000', 'in')] },
  { kind: 'category', id: 'cf:funding', label: 'FUNDING IN / (OUT)', flow: 'in', children: [
    acc('450-H006', 'out'),
    { kind: 'category', id: 'cf:funding:capex', label: 'CAPITAL EXPENDITURE (CAPEX)', children: [acc('202-1000', 'net'), acc('202-1005', 'net'), acc('202-0000', 'net'), acc('210-0000', 'net')] },
    { kind: 'category', id: 'cf:funding:loan', label: 'LOAN & HP DRAWDOWN', children: [acc('460-0008', 'in'), acc('460-0001', 'in')] },
    { kind: 'category', id: 'cf:funding:loan-out', label: 'LOAN & HP REPAYMENT', children: [acc('460-0001', 'out'), acc('460-0008', 'out'), acc('360-0020', 'net')] },
    { kind: 'category', id: 'cf:funding:tf', label: 'TRADE FINANCE', children: [
      { kind: 'category', id: 'cf:funding:tf:in', label: 'DRAWDOWN', children: [acc('460-0009', 'in')] },
    ] },
  ] },
  { kind: 'subtotal', id: 'cf:sub:x', label: 'X' },
];
const CHART = new Map([
  ['300-0000', 'ACCOUNT RECEIVABLE'], ['450-H006', 'HP CREDITOR - SAMPLE MACHINE'],
  ['202-1000', 'EQUIPMENT (OFFICE)'], ['202-1005', 'ACCUM. DEPRN. - EQUIPMENT (OFFICE)'], ['210-0000', 'GOODWILL'],
  ['460-0001', 'LOAN - SAMPLE BANK'], ['460-0008', 'LOAN - EXAMPLE BANK'], ['360-0020', 'ADVANCE - LOAN PAYMENT'], ['460-0009', 'TRADE FINANCE - SAMPLE BANK'],
]);

describe('the accounts the table offers', () => {
  it("the funding block's active leaves, once each, grouped by the categories that place them; trade finance, depreciation, headers and other blocks aside", () => {
    expect(keyableAccounts(TREE, CHART).map((a) => [a.code, a.group.label])).toEqual([
      ['450-H006', 'FUNDING IN / (OUT)'],
      ['202-1000', 'CAPITAL EXPENDITURE (CAPEX)'],
      ['210-0000', 'CAPITAL EXPENDITURE (CAPEX)'],
      ['460-0001', 'LOAN & HP DRAWDOWN / LOAN & HP REPAYMENT'],
      ['460-0008', 'LOAN & HP DRAWDOWN / LOAN & HP REPAYMENT'],
      ['360-0020', 'LOAN & HP REPAYMENT'],
    ]);
    /* No funding block on the layout (the chart's own tree): nothing offered. */
    expect(keyableAccounts([TREE[0]!], CHART)).toEqual([]);
  });
});

describe('a save', () => {
  const OFFERED = new Set(['202-1000', '460-0001']);
  it('keeps the map as sent, months in order, a zero dropped and a month left empty gone', () => {
    expect(validateKeyedInputs({ '2026-12': { '460-0001': -150_000, '202-1000': 0 }, '2026-11': { '202-1000': -2_000_000, '460-0001': 50_000_000 }, '2027-01': { '202-1000': 0 } }, OFFERED))
      .toEqual({ ok: true, months: { '2026-11': { '202-1000': -2_000_000, '460-0001': 50_000_000 }, '2026-12': { '460-0001': -150_000 } } });
    /* A cleared cell of an account no longer offered is no refusal. */
    expect(validateKeyedInputs({ '2026-12': { '999-0000': 0 } }, OFFERED)).toEqual({ ok: true, months: {} });
  });

  it('names the first bad cell: not a map, a bad month, a fraction, a number in words, an account the layout does not offer', () => {
    expect(validateKeyedInputs([], OFFERED)).toMatchObject({ ok: false, cell: 'months' });
    expect(validateKeyedInputs({ '2026-13': {} }, OFFERED)).toEqual({ ok: false, cell: '2026-13', reason: 'not a month (YYYY-MM)' });
    expect(validateKeyedInputs({ '2026-12': [] }, OFFERED)).toMatchObject({ ok: false, cell: '2026-12' });
    expect(validateKeyedInputs({ '2026-12': { '202-1000': 10.5 } }, OFFERED)).toEqual({ ok: false, cell: '2026-12 202-1000', reason: 'an amount is a whole number of sen' });
    expect(validateKeyedInputs({ '2026-12': { '202-1000': '100' } }, OFFERED)).toMatchObject({ ok: false, cell: '2026-12 202-1000' });
    expect(validateKeyedInputs({ '2026-12': { '460-0009': -100 } }, OFFERED)).toMatchObject({ ok: false, cell: '2026-12 460-0009', reason: expect.stringContaining('not a capex or financing account') });
  });
});

describe('a keyed amount in the forecast', () => {
  it('lands on its own account in its own month: + money in, − money out', () => {
    const legs = keyedInputLegs({ '2026-12': { '460-0001': 50_000_000, '202-1000': -2_000_000 }, '2027-01': { '460-0001': -1_500_000 } }, (code) => CHART.get(code) ?? code);
    expect(legs.map((l) => [l.ym, l.code, l.flow, l.sen, l.source, l.party])).toEqual([
      ['2026-12', '460-0001', 'in', 50_000_000, 'input', KEYED_PARTY],
      ['2026-12', '202-1000', 'out', 2_000_000, 'input', KEYED_PARTY],
      ['2027-01', '460-0001', 'out', 1_500_000, 'input', KEYED_PARTY],
    ]);
    expect(legs[0]).toMatchObject({ key: '460-0001', name: 'LOAN - SAMPLE BANK', fromYm: '2026-12' });
  });

  it('an account keyed but no longer offered is named, to be cleared', () => {
    expect(keyedNotOffered({ '2026-12': { '460-0001': 1, '999-0000': 5 }, '2027-02': { '888-0000': -1 } }, new Set(['460-0001']))).toEqual(['888-0000', '999-0000']);
  });
});
