import { describe, expect, it } from 'vitest';
import {
  buildEventCommission, changeView, goodsAt, monthAdjustmentsOf, mytDay, paidByOrder, reachedOn, withMonthAdjustments,
  type CommissionChange, type CommissionFair, type CommissionPayment, type CommissionSo,
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
  goodsSen: 1_000_00, totalSen: 1_100_00, createdAt: '2026-10-02T03:00:00Z', soDate: '2026-10-02', ...o,
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
    expect(r.totals).toEqual({ payableSen: 140_00, adjustmentsSen: 0, monthAdjustmentsSen: 0, totalSen: 140_00 });
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
  const late = (o: Partial<CommissionSo> = {}) => so({ docNo: 'HC-SO-2609-050', projectId: 2, createdAt: '2026-09-05T03:00:00Z', soDate: '2026-09-05', ...o });

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
    expect(r.totals).toEqual({ payableSen: 0, adjustmentsSen: 169_00, monthAdjustmentsSen: 0, totalSen: 169_00 });
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

describe('by SO date — the same two parts keyed on the order\'s own SO date', () => {
  const SEP = fair({ id: 2, name: 'SELANGOR [ZANOTTI] BIGHOME @ SUNWAY PYRAMID', brand: 'ZANOTTI', startDate: '2026-09-28', endDate: '2026-10-02' });

  it('Part 1 is the orders OPENED in the range, under their fair — even a fair that started before it; an order opened before stays out', () => {
    const r = buildEventCommission({
      ...OCT, basis: 'so_date', fairs: [SEP, fair()], ratePctByBrand: RATES,
      sos: [
        so({ docNo: 'HC-SO-2610-010', projectId: 2, soDate: '2026-10-01' }),
        so({ docNo: 'HC-SO-2609-099', projectId: 2, soDate: '2026-09-29' }),
        so(),
      ],
      payments: [
        { docNo: 'HC-SO-2610-010', paidAt: '2026-10-01', amountSen: 400_00 },
        { docNo: 'HC-SO-2609-099', paidAt: '2026-09-29', amountSen: 400_00 },
        { docNo: 'HC-SO-2610-001', paidAt: '2026-10-02', amountSen: 400_00 },
      ],
      changes: [], cancels: [],
    });
    expect(r.basis).toBe('so_date');
    expect(r.fairs.map((f) => [f.id, f.sos.map((s) => s.docNo), f.payableSen])).toEqual([
      [2, ['HC-SO-2610-010'], 130_00],
      [1, ['HC-SO-2610-001'], 140_00],
    ]);
    expect(r.fairs[0]!.sos[0]!.soDate).toBe('2026-10-01');
  });

  it('Part 2 is what happened in the range to orders opened before it — by the order\'s date, not its fair\'s', () => {
    const r = buildEventCommission({
      ...OCT, basis: 'so_date', fairs: [SEP], ratePctByBrand: RATES,
      sos: [so({ docNo: 'HC-SO-2609-099', projectId: 2, soDate: '2026-09-29' })],
      payments: [{ docNo: 'HC-SO-2609-099', paidAt: '2026-10-06', amountSen: 400_00 }],
      changes: [], cancels: [],
    });
    expect(r.fairs).toEqual([]);
    expect(r.adjustments.map((a) => [a.docNo, a.kind, a.date, a.commissionSen])).toEqual([['HC-SO-2609-099', 'reached', '2026-10-06', 130_00]]);
    /* The same order by fair: its fair started 09-28, before October — so the same line. */
    const byFair = buildEventCommission({ ...OCT, fairs: [SEP], ratePctByBrand: RATES, sos: [so({ docNo: 'HC-SO-2609-099', projectId: 2, soDate: '2026-09-29' })],
      payments: [{ docNo: 'HC-SO-2609-099', paidAt: '2026-10-06', amountSen: 400_00 }], changes: [], cancels: [] });
    expect(byFair.basis).toBe('fair');
    expect(byFair.adjustments).toHaveLength(1);
  });

  it('an October order of a fair that started in September is Part 1 by SO date but Part 2 by fair', () => {
    const input = {
      ...OCT, fairs: [SEP], ratePctByBrand: RATES,
      sos: [so({ docNo: 'HC-SO-2610-010', projectId: 2, soDate: '2026-10-01' })],
      payments: [{ docNo: 'HC-SO-2610-010', paidAt: '2026-10-01', amountSen: 400_00 }],
      changes: [], cancels: [],
    };
    const bySo = buildEventCommission({ ...input, basis: 'so_date' });
    const byFair = buildEventCommission(input);
    expect(bySo.totals).toEqual({ payableSen: 130_00, adjustmentsSen: 0, monthAdjustmentsSen: 0, totalSen: 130_00 });
    expect(byFair.totals).toEqual({ payableSen: 0, adjustmentsSen: 130_00, monthAdjustmentsSen: 0, totalSen: 130_00 });
  });
});

/* Owner 2026-10-26: 「一张单改了两次我不理，我看final结果」 — the earlier orders and
   the upsales / drop sales once per order: Original, Latest, Amended, at the
   fair's brand rate; an opening-day change is not listed; the October back-fill
   from the modification history ('history') counts, the system's own price
   wipes found there ('history-ignored') never do. */
describe('one row per order, its final result', () => {
  const ZAN = fair({ id: 3, name: 'SELANGOR [ZANOTTI] BIGHOME @ SUNWAY PYRAMID', brand: 'ZANOTTI', startDate: '2026-09-10', endDate: '2026-09-13', organizer: 'BIGHOME', venue: 'SUNWAY PYRAMID', state: 'Selangor' });

  it('an earlier order changed twice in the range reads once: Original, Latest, Amended and its commission lines summed', () => {
    const r = buildEventCommission({
      ...OCT, fairs: [ZAN], ratePctByBrand: RATES,
      sos: [so({ docNo: 'HC-SO-2609-050', projectId: 3, goodsSen: 1_150_00, totalSen: 1_250_00, createdAt: '2026-09-11T03:00:00Z', soDate: '2026-09-11' })],
      payments: [{ docNo: 'HC-SO-2609-050', paidAt: '2026-09-11', amountSen: 500_00 }],
      changes: [
        change({ docNo: 'HC-SO-2609-050', changedAt: '2026-10-05T03:00:00Z', beforeGoodsSen: 1_000_00, afterGoodsSen: 1_200_00, source: 'history' }),
        change({ docNo: 'HC-SO-2609-050', changedAt: '2026-10-22T03:00:00Z', beforeGoodsSen: 1_200_00, afterGoodsSen: 1_150_00 }),
      ],
      cancels: [],
    });
    expect(r.earlierOrders).toEqual([expect.objectContaining({
      docNo: 'HC-SO-2609-050', brand: 'ZANOTTI', organizer: 'BIGHOME', venue: 'SUNWAY PYRAMID', state: 'Selangor', ratePct: 13,
      originalSen: 1_000_00, latestSen: 1_150_00, amendedSen: 150_00,
      commissionSen: 19_50, lastDate: '2026-10-22', fromHistory: true,
    })]);
    expect(r.earlierOrders[0]!.events.map((e) => e.kind)).toEqual(['upsale', 'drop']);
    expect(r.changedOrders).toEqual([expect.objectContaining({
      docNo: 'HC-SO-2609-050', part: 'earlier', originalSen: 1_000_00, latestSen: 1_150_00, amendedSen: 150_00, effectSen: 19_50, lastChange: '2026-10-22',
    })]);
    /* Totals are the lines', untouched by the one-row view. */
    expect(r.totals.adjustmentsSen).toBe(19_50);
  });

  it('this range\'s fairs list their changed orders too — the effect already inside the fair, nothing added', () => {
    const r = buildEventCommission({
      ...OCT, fairs: [fair({ organizer: 'BIGHOME', venue: 'MID VALLEY', state: 'Kuala Lumpur' })], ratePctByBrand: RATES,
      sos: [
        so({ goodsSen: 900_00 }),
        so({ docNo: 'HC-SO-2610-002', goodsSen: 500_00, totalSen: 500_00 }),
      ],
      payments: [{ docNo: 'HC-SO-2610-001', paidAt: '2026-10-02', amountSen: 400_00 }],
      changes: [
        change({ changedAt: '2026-10-21T03:00:00Z', beforeGoodsSen: 1_000_00, afterGoodsSen: 900_00 }),
        /* An opening-day fix on the second order: not an upsale, not listed. */
        change({ docNo: 'HC-SO-2610-002', changedAt: '2026-10-02T09:00:00Z', beforeGoodsSen: 800_00, afterGoodsSen: 500_00 }),
      ],
      cancels: [],
    });
    expect(r.fairs[0]).toMatchObject({ organizer: 'BIGHOME', venue: 'MID VALLEY', state: 'Kuala Lumpur', payableSen: 126_00 });
    expect(r.changedOrders).toEqual([expect.objectContaining({
      docNo: 'HC-SO-2610-001', part: 'range', originalSen: 1_000_00, latestSen: 900_00, amendedSen: -100_00, reachedOn: '2026-10-02', effectSen: -14_00,
    })]);
    expect(r.totals.totalSen).toBe(126_00);
  });

  it('a change that has not reached 30% moves no commission yet; a system price wipe from the history is never an upsale or drop', () => {
    const r = buildEventCommission({
      ...OCT, fairs: [fair()], ratePctByBrand: RATES,
      sos: [so({ goodsSen: 1_200_00, totalSen: 1_300_00 })],
      payments: [{ docNo: 'HC-SO-2610-001', paidAt: '2026-10-02', amountSen: 100_00 }],
      changes: [
        change({ changedAt: '2026-10-06T03:00:00Z', beforeGoodsSen: 1_000_00, afterGoodsSen: 0, source: 'history-ignored' }),
        change({ changedAt: '2026-10-08T03:00:00Z', beforeGoodsSen: 0, afterGoodsSen: 1_000_00, beforeTotalSen: 1_100_00, source: 'history-ignored' }),
        change({ changedAt: '2026-10-21T03:00:00Z', beforeGoodsSen: 1_000_00, afterGoodsSen: 1_200_00 }),
      ],
      cancels: [],
    });
    expect(changeView(change({ source: 'history-ignored' }), so())).toMatchObject({ notCounted: 'system_fix', fromHistory: true });
    expect(r.changedOrders).toEqual([expect.objectContaining({ originalSen: 1_000_00, latestSen: 1_200_00, amendedSen: 200_00, reachedOn: null, effectSen: 0 })]);
  });
});

describe('closing a month — 关月 (owner 2026-10-26)', () => {
  /* A closed month never changes; what later moves its orders' commission is
     that month recalculated today minus what it paid, paid in the first open
     month — and once a later month has paid it, it is not paid again. */
  const SEPF = fair({ id: 2, name: 'SELANGOR [ZANOTTI] BIGHOME @ SUNWAY PYRAMID', brand: 'ZANOTTI', startDate: '2026-09-04', endDate: '2026-09-07' });
  const sep = (o: Partial<CommissionSo> = {}) => so({ docNo: 'HC-SO-2609-050', projectId: 2, createdAt: '2026-09-05T03:00:00Z', soDate: '2026-09-05', ...o });
  const september = (payments: CommissionPayment[]) => buildEventCommission({
    from: '2026-09-01', to: '2026-09-30', fairs: [SEPF], ratePctByBrand: RATES,
    sos: [sep(), sep({ docNo: 'HC-SO-2609-051', salesperson: 'Wei Pin' })], payments, changes: [], cancels: [],
  });
  const october = () => buildEventCommission({ ...OCT, fairs: [], ratePctByBrand: RATES, sos: [], payments: [], changes: [], cancels: [] });
  const PAID_050 = { docNo: 'HC-SO-2609-050', paidAt: '2026-09-05', amountSen: 400_00 };
  const closedSep = () => ({ month: '2026-09', paid: paidByOrder(september([PAID_050])), carried: [] });

  it('a month pays each order its fair commission and its earlier lines, nothing for an order under 30%', () => {
    expect(paidByOrder(september([PAID_050]))).toEqual({ 'HC-SO-2609-050': 130_00 });
  });

  it('a payment keyed later but dated back into the closed month pays the order in the first open month', () => {
    const now = september([PAID_050, { docNo: 'HC-SO-2609-051', paidAt: '2026-09-28', amountSen: 400_00 }]);
    const rows = monthAdjustmentsOf([closedSep()], new Map([['2026-09', now]]));
    expect(rows).toEqual([{
      month: '2026-09', docNo: 'HC-SO-2609-051', fairId: 2, fairName: SEPF.name, brand: 'ZANOTTI', salesperson: 'Wei Pin', customer: 'Tan',
      wasSen: 0, nowSen: 130_00, adjustmentSen: 130_00,
    }]);
  });

  it('a payment deleted takes the commission back; nothing moved, nothing listed', () => {
    expect(monthAdjustmentsOf([closedSep()], new Map([['2026-09', september([])]])).map((a) => [a.docNo, a.wasSen, a.nowSen, a.adjustmentSen]))
      .toEqual([['HC-SO-2609-050', 130_00, 0, -130_00]]);
    expect(monthAdjustmentsOf([closedSep()], new Map([['2026-09', september([PAID_050])]]))).toEqual([]);
  });

  it('once October has closed carrying a September adjustment, November does not pay it again', () => {
    const now = september([PAID_050, { docNo: 'HC-SO-2609-051', paidAt: '2026-09-28', amountSen: 400_00 }]);
    const octClosed = { month: '2026-10', paid: {}, carried: [{ month: '2026-09', docNo: 'HC-SO-2609-051', sen: 130_00 }] };
    expect(monthAdjustmentsOf([closedSep(), octClosed], new Map([['2026-09', now], ['2026-10', october()]]))).toEqual([]);
  });

  it('the adjustments add to the month they are paid in', () => {
    const rows = monthAdjustmentsOf([closedSep()], new Map([['2026-09', september([])]]));
    expect(withMonthAdjustments(october(), rows).totals).toEqual({ payableSen: 0, adjustmentsSen: 0, monthAdjustmentsSen: -130_00, totalSen: -130_00 });
    expect(october().monthAdjustments).toEqual([]);
  });
});

/* Owner 2026-10-26: 「一张单改了两次我不理，我看final结果」 — the earlier orders and
   the upsales / drop sales once per order: Original, Latest, Amended, at the
   fair's brand rate; an opening-day change is not listed; the October back-fill
   from the modification history ('history') counts, the system's own price
   wipes found there ('history-ignored') never do. */
describe('one row per order, its final result', () => {
  const ZAN = fair({ id: 3, name: 'SELANGOR [ZANOTTI] BIGHOME @ SUNWAY PYRAMID', brand: 'ZANOTTI', startDate: '2026-09-10', endDate: '2026-09-13', organizer: 'BIGHOME', venue: 'SUNWAY PYRAMID', state: 'Selangor' });

  it('an earlier order changed twice in the range reads once: Original, Latest, Amended and its commission lines summed', () => {
    const r = buildEventCommission({
      ...OCT, fairs: [ZAN], ratePctByBrand: RATES,
      sos: [so({ docNo: 'HC-SO-2609-050', projectId: 3, goodsSen: 1_150_00, totalSen: 1_250_00, createdAt: '2026-09-11T03:00:00Z', soDate: '2026-09-11' })],
      payments: [{ docNo: 'HC-SO-2609-050', paidAt: '2026-09-11', amountSen: 500_00 }],
      changes: [
        change({ docNo: 'HC-SO-2609-050', changedAt: '2026-10-05T03:00:00Z', beforeGoodsSen: 1_000_00, afterGoodsSen: 1_200_00, source: 'history' }),
        change({ docNo: 'HC-SO-2609-050', changedAt: '2026-10-22T03:00:00Z', beforeGoodsSen: 1_200_00, afterGoodsSen: 1_150_00 }),
      ],
      cancels: [],
    });
    expect(r.earlierOrders).toEqual([expect.objectContaining({
      docNo: 'HC-SO-2609-050', brand: 'ZANOTTI', organizer: 'BIGHOME', venue: 'SUNWAY PYRAMID', state: 'Selangor', ratePct: 13,
      originalSen: 1_000_00, latestSen: 1_150_00, amendedSen: 150_00,
      commissionSen: 19_50, lastDate: '2026-10-22', fromHistory: true,
    })]);
    expect(r.earlierOrders[0]!.events.map((e) => e.kind)).toEqual(['upsale', 'drop']);
    expect(r.changedOrders).toEqual([expect.objectContaining({
      docNo: 'HC-SO-2609-050', part: 'earlier', originalSen: 1_000_00, latestSen: 1_150_00, amendedSen: 150_00, effectSen: 19_50, lastChange: '2026-10-22',
    })]);
    /* Totals are the lines', untouched by the one-row view. */
    expect(r.totals.adjustmentsSen).toBe(19_50);
  });

  it('this range\'s fairs list their changed orders too — the effect already inside the fair, nothing added', () => {
    const r = buildEventCommission({
      ...OCT, fairs: [fair({ organizer: 'BIGHOME', venue: 'MID VALLEY', state: 'Kuala Lumpur' })], ratePctByBrand: RATES,
      sos: [
        so({ goodsSen: 900_00 }),
        so({ docNo: 'HC-SO-2610-002', goodsSen: 500_00, totalSen: 500_00 }),
      ],
      payments: [{ docNo: 'HC-SO-2610-001', paidAt: '2026-10-02', amountSen: 400_00 }],
      changes: [
        change({ changedAt: '2026-10-21T03:00:00Z', beforeGoodsSen: 1_000_00, afterGoodsSen: 900_00 }),
        /* An opening-day fix on the second order: not an upsale, not listed. */
        change({ docNo: 'HC-SO-2610-002', changedAt: '2026-10-02T09:00:00Z', beforeGoodsSen: 800_00, afterGoodsSen: 500_00 }),
      ],
      cancels: [],
    });
    expect(r.fairs[0]).toMatchObject({ organizer: 'BIGHOME', venue: 'MID VALLEY', state: 'Kuala Lumpur', payableSen: 126_00 });
    expect(r.changedOrders).toEqual([expect.objectContaining({
      docNo: 'HC-SO-2610-001', part: 'range', originalSen: 1_000_00, latestSen: 900_00, amendedSen: -100_00, reachedOn: '2026-10-02', effectSen: -14_00,
    })]);
    expect(r.totals.totalSen).toBe(126_00);
  });

  it('a change that has not reached 30% moves no commission yet; a system price wipe from the history is never an upsale or drop', () => {
    const r = buildEventCommission({
      ...OCT, fairs: [fair()], ratePctByBrand: RATES,
      sos: [so({ goodsSen: 1_200_00, totalSen: 1_300_00 })],
      payments: [{ docNo: 'HC-SO-2610-001', paidAt: '2026-10-02', amountSen: 100_00 }],
      changes: [
        change({ changedAt: '2026-10-06T03:00:00Z', beforeGoodsSen: 1_000_00, afterGoodsSen: 0, source: 'history-ignored' }),
        change({ changedAt: '2026-10-08T03:00:00Z', beforeGoodsSen: 0, afterGoodsSen: 1_000_00, beforeTotalSen: 1_100_00, source: 'history-ignored' }),
        change({ changedAt: '2026-10-21T03:00:00Z', beforeGoodsSen: 1_000_00, afterGoodsSen: 1_200_00 }),
      ],
      cancels: [],
    });
    expect(changeView(change({ source: 'history-ignored' }), so())).toMatchObject({ notCounted: 'system_fix', fromHistory: true });
    expect(r.changedOrders).toEqual([expect.objectContaining({ originalSen: 1_000_00, latestSen: 1_200_00, amendedSen: 200_00, reachedOn: null, effectSen: 0 })]);
  });
});
