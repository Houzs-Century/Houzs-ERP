import { describe, expect, it } from 'vitest';
import {
  buildEventCommission, changeView, goodsAt, mytDay, reachedOn,
  type CommissionChange, type CommissionFair, type CommissionSo,
} from './event-commission';

/* Event Commission (owner 2026-10-20): goods × the fair's brand rate, earned on
   the day the order's payments reach 30% of its total; upsales / drop sales
   from the recorded changes; Part 1 = fairs starting in the range as at `to`,
   Part 2 = what happened in the range to orders of earlier fairs. */

const fair = (o: Partial<CommissionFair> = {}): CommissionFair => ({
  id: 1, name: 'KL [AKEMI] BIGHOME @ MID VALLEY', brand: 'AKEMI', startDate: '2026-10-02', endDate: '2026-10-05',
  totalSalesRm: 484746, estimateRm: 67864, ...o,
});
const so = (o: Partial<CommissionSo> = {}): CommissionSo => ({
  docNo: 'HC-SO-2610-001', projectId: 1, salesperson: 'Ethan', customer: 'Tan', status: 'CONFIRMED', onHold: false,
  goodsSen: 1_000_00, totalSen: 1_100_00, createdAt: '2026-10-02T03:00:00Z', ...o,
});
const change = (o: Partial<CommissionChange> = {}): CommissionChange => ({
  docNo: 'HC-SO-2610-001', changedAt: '2026-10-20T04:00:00Z', beforeGoodsSen: 1_000_00, afterGoodsSen: 1_200_00,
  beforeTotalSen: 1_100_00, afterTotalSen: 1_300_00, source: 'edit', changedBy: 'Finance', ...o,
});
const RATES = new Map<string, number | null>([['AKEMI', 14], ['ZANOTTI', 13]]);
const OCT = { from: '2026-10-01', to: '2026-10-31' };

describe('the pieces', () => {
  it('a stamp is read as its Malaysian day; a bare date passes through', () => {
    expect(mytDay('2026-10-19T17:30:00Z')).toBe('2026-10-20');
    expect(mytDay('2026-10-19T15:59:00Z')).toBe('2026-10-19');
    expect(mytDay('2026-10-19')).toBe('2026-10-19');
  });

  it('30% is reached on the day the payments add up to it — not before, and only up to the day asked', () => {
    const pays = [{ docNo: 'x', paidAt: '2026-10-01', amountSen: 200_00 }, { docNo: 'x', paidAt: '2026-10-05', amountSen: 150_00 }];
    expect(reachedOn(1_000_00, pays)).toBe('2026-10-05');
    expect(reachedOn(1_000_00, pays, '2026-10-03')).toBeNull();
    expect(reachedOn(0, pays)).toBeNull();
  });

  it('the goods on a day are today\'s goods less every change after it', () => {
    const chs = [change({ changedAt: '2026-10-10T02:00:00Z' })];
    expect(goodsAt(1_200_00, chs, '2026-10-05')).toBe(1_000_00);
    expect(goodsAt(1_200_00, chs, '2026-10-10')).toBe(1_200_00);
  });

  it('an opening-day fix and pricing an order that had none are not upsales; a fee-only change is not listed', () => {
    const s = so();
    expect(changeView(change({ changedAt: '2026-10-02T09:00:00Z' }), s)?.notCounted).toBe('opening_day');
    expect(changeView(change({ beforeTotalSen: 0 }), s)?.notCounted).toBe('first_price');
    expect(changeView(change(), s)).toMatchObject({ kind: 'upsale', deltaGoodsSen: 200_00, notCounted: null });
    expect(changeView(change({ afterGoodsSen: 1_000_00 }), s)).toBeNull();
  });
});

describe('Part 1 — fairs that start in the range, as at its last day', () => {
  it('an order earns goods × the brand rate once 30% is paid; under 30% earns nothing; drafts and cancelled orders are left out', () => {
    const r = buildEventCommission({
      ...OCT, fairs: [fair()], ratePctByBrand: RATES,
      sos: [
        so(),
        so({ docNo: 'HC-SO-2610-002', goodsSen: 500_00, totalSen: 500_00 }),
        so({ docNo: 'HC-SO-2610-003', status: 'DRAFT' }),
        so({ docNo: 'HC-SO-2610-004', status: 'CANCELLED' }),
      ],
      payments: [
        { docNo: 'HC-SO-2610-001', paidAt: '2026-10-02', amountSen: 400_00 },
        { docNo: 'HC-SO-2610-002', paidAt: '2026-10-02', amountSen: 100_00 },
      ],
      changes: [],
      cancels: [{ docNo: 'HC-SO-2610-004', at: '2026-10-08T02:00:00Z' }],
    });
    const f = r.fairs[0];
    expect(f.sos.map((s) => s.docNo)).toEqual(['HC-SO-2610-001', 'HC-SO-2610-002']);
    expect(f.sos[0]).toMatchObject({ reachedOn: '2026-10-02', commissionSen: 140_00, paidPct: 36.4 });
    expect(f.sos[1]).toMatchObject({ reachedOn: null, commissionSen: 0, paidPct: 20 });
    expect(f).toMatchObject({ ratePct: 14, payableSen: 140_00, estimateRm: 67864 });
    expect(r.totals).toEqual({ payableSen: 140_00, adjustmentsSen: 0, totalSen: 140_00 });
  });

  it('as at the range\'s last day: a later payment, a later upsale and a later cancellation are not in it', () => {
    const r = buildEventCommission({
      ...OCT, fairs: [fair()], ratePctByBrand: RATES,
      sos: [so({ goodsSen: 1_200_00, status: 'CANCELLED' }), so({ docNo: 'HC-SO-2610-009' })],
      payments: [
        { docNo: 'HC-SO-2610-001', paidAt: '2026-10-02', amountSen: 400_00 },
        { docNo: 'HC-SO-2610-009', paidAt: '2026-11-03', amountSen: 400_00 },
      ],
      changes: [change({ changedAt: '2026-11-02T02:00:00Z' })],
      cancels: [{ docNo: 'HC-SO-2610-001', at: '2026-11-20T02:00:00Z' }],
    });
    const [a, b] = r.fairs[0].sos;
    expect(a).toMatchObject({ goodsSen: 1_000_00, commissionSen: 140_00, changes: [] });
    expect(b).toMatchObject({ reachedOn: null, commissionSen: 0 });
  });

  it('the order\'s upsales and drops in the range are listed under it, the opening-day fix marked as not counted', () => {
    const r = buildEventCommission({
      ...OCT, fairs: [fair()], ratePctByBrand: RATES, sos: [so({ goodsSen: 1_150_00 })],
      payments: [{ docNo: 'HC-SO-2610-001', paidAt: '2026-10-02', amountSen: 400_00 }],
      changes: [
        change({ changedAt: '2026-10-02T08:00:00Z', beforeGoodsSen: 1_050_00, afterGoodsSen: 1_000_00 }),
        change({ changedAt: '2026-10-15T08:00:00Z', beforeGoodsSen: 1_000_00, afterGoodsSen: 1_150_00 }),
      ],
      cancels: [],
    });
    const s = r.fairs[0].sos[0];
    expect(s.changes.map((c) => [c.kind, c.deltaGoodsSen, c.notCounted])).toEqual([['drop', -50_00, 'opening_day'], ['upsale', 150_00, null]]);
    expect(s.commissionSen).toBe(161_00);
  });

  it('a fair with no rate card earns nothing rather than a guessed rate', () => {
    const r = buildEventCommission({
      ...OCT, fairs: [fair({ brand: 'NOCARD' })], ratePctByBrand: RATES, sos: [so()],
      payments: [{ docNo: 'HC-SO-2610-001', paidAt: '2026-10-02', amountSen: 400_00 }], changes: [], cancels: [],
    });
    expect(r.fairs[0]).toMatchObject({ ratePct: null, payableSen: 0 });
  });
});

describe('Part 2 — what happened in the range to orders of earlier fairs', () => {
  const SEP = fair({ id: 2, name: 'SELANGOR [ZANOTTI] BIGHOME @ SUNWAY PYRAMID', brand: 'ZANOTTI', startDate: '2026-09-04', endDate: '2026-09-07' });
  const late = (o: Partial<CommissionSo> = {}) => so({ docNo: 'HC-SO-2609-050', projectId: 2, createdAt: '2026-09-05T03:00:00Z', ...o });

  it('reaching 30% in the range earns the goods of that day; an upsale after it earns its change; a change before it waits', () => {
    const r = buildEventCommission({
      ...OCT, fairs: [SEP], ratePctByBrand: RATES,
      sos: [late({ goodsSen: 1_300_00 })],
      payments: [{ docNo: 'HC-SO-2609-050', paidAt: '2026-09-05', amountSen: 100_00 }, { docNo: 'HC-SO-2609-050', paidAt: '2026-10-10', amountSen: 300_00 }],
      changes: [
        change({ docNo: 'HC-SO-2609-050', changedAt: '2026-10-03T02:00:00Z', beforeGoodsSen: 1_000_00, afterGoodsSen: 1_100_00 }),
        change({ docNo: 'HC-SO-2609-050', changedAt: '2026-10-20T02:00:00Z', beforeGoodsSen: 1_100_00, afterGoodsSen: 1_300_00 }),
      ],
      cancels: [],
    });
    expect(r.fairs).toEqual([]);
    expect(r.adjustments.map((a) => [a.date, a.kind, a.goodsSen, a.commissionSen, a.beforeReach])).toEqual([
      ['2026-10-03', 'upsale', 100_00, 0, true],
      ['2026-10-10', 'reached', 1_100_00, 143_00, false],
      ['2026-10-20', 'upsale', 200_00, 26_00, false],
    ]);
    expect(r.totals).toEqual({ payableSen: 0, adjustmentsSen: 169_00, totalSen: 169_00 });
  });

  it('a cancellation takes back what the order had earned; one re-opened since is live again', () => {
    const r = buildEventCommission({
      ...OCT, fairs: [SEP], ratePctByBrand: RATES,
      sos: [late({ status: 'CANCELLED' }), late({ docNo: 'HC-SO-2609-051' })],
      payments: [
        { docNo: 'HC-SO-2609-050', paidAt: '2026-09-05', amountSen: 400_00 },
        { docNo: 'HC-SO-2609-051', paidAt: '2026-09-05', amountSen: 400_00 },
      ],
      changes: [],
      cancels: [{ docNo: 'HC-SO-2609-050', at: '2026-10-12T02:00:00Z' }, { docNo: 'HC-SO-2609-051', at: '2026-10-12T02:00:00Z' }],
    });
    expect(r.adjustments.map((a) => [a.docNo, a.kind, a.commissionSen])).toEqual([['HC-SO-2609-050', 'cancelled', -130_00]]);
  });

  it('orders of fairs starting in the range are not in Part 2, and a change on the day 30% is reached is folded into it', () => {
    const r = buildEventCommission({
      ...OCT, fairs: [SEP, fair()], ratePctByBrand: RATES,
      sos: [so(), late({ goodsSen: 1_100_00 })],
      payments: [
        { docNo: 'HC-SO-2610-001', paidAt: '2026-10-02', amountSen: 400_00 },
        { docNo: 'HC-SO-2609-050', paidAt: '2026-10-10', amountSen: 400_00 },
      ],
      changes: [
        change({ changedAt: '2026-10-20T02:00:00Z' }),
        change({ docNo: 'HC-SO-2609-050', changedAt: '2026-10-10T09:00:00Z', beforeGoodsSen: 1_000_00, afterGoodsSen: 1_100_00 }),
      ],
      cancels: [],
    });
    expect(r.adjustments.map((a) => [a.docNo, a.kind, a.goodsSen])).toEqual([['HC-SO-2609-050', 'reached', 1_100_00]]);
  });
});
