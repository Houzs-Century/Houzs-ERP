import { describe, expect, it } from 'vitest';
import {
  NO_FAIR_FROM, buildEventCommission, changeView, deferredInFrom, goodsAt, monthAdjustmentsOf, mytDay, paidByOrder, reachedOn, withMarks, withMonthAdjustments,
  withUncountedChanges,
  type CommissionChange, type CommissionFair, type CommissionMark, type CommissionPayment, type CommissionSo,
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
  beforeTotalSen: 1_100_00, afterTotalSen: 1_300_00, source: 'edit', changedBy: 'Finance', uncounted: false, ...o,
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
    expect(r.totals).toEqual({ payableSen: 140_00, adjustmentsSen: 0, monthAdjustmentsSen: 0, deferredInSen: 0, totalSen: 140_00 });
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
    expect(r.totals).toEqual({ payableSen: 0, adjustmentsSen: 169_00, monthAdjustmentsSen: 0, deferredInSen: 0, totalSen: 169_00 });
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

  it('an order keyed after its payments earns on what it was keyed at by the end of that day, not its first figure (HC-SO-2611-050)', () => {
    /* Keyed on 3/11 at RM 4,000, put right to RM 800 the same day; its payments
       are dated 14–16/10, so it reached 30% in October — on RM 800. */
    const keyedLate = late({
      docNo: 'HC-SO-2611-050', createdAt: '2026-11-03T04:00:00Z', soDate: '2026-11-03', goodsSen: 800_00, totalSen: 800_00,
    });
    const r = buildEventCommission({
      ...OCT, fairs: [SEP], ratePctByBrand: RATES,
      sos: [keyedLate],
      payments: [
        { docNo: 'HC-SO-2611-050', paidAt: '2026-10-14', amountSen: 400_00 },
        { docNo: 'HC-SO-2611-050', paidAt: '2026-10-16', amountSen: 200_00 },
      ],
      changes: [
        change({ docNo: 'HC-SO-2611-050', changedAt: '2026-11-03T05:00:00Z', beforeGoodsSen: 4_000_00, afterGoodsSen: 0, beforeTotalSen: 4_000_00, afterTotalSen: 0 }),
        change({ docNo: 'HC-SO-2611-050', changedAt: '2026-11-03T05:01:00Z', beforeGoodsSen: 0, afterGoodsSen: 800_00, beforeTotalSen: 0, afterTotalSen: 800_00 }),
      ],
      cancels: [],
    });
    expect(r.adjustments.map((a) => [a.docNo, a.kind, a.goodsSen, a.commissionSen])).toEqual([['HC-SO-2611-050', 'reached', 800_00, 104_00]]);
    expect(r.earlierOrders[0]).toMatchObject({ originalSen: 800_00, latestSen: 800_00, commissionSen: 104_00 });
    /* By fair, a fair of the range shows such an order as at its last day the same way. */
    const own = buildEventCommission({
      ...OCT, fairs: [fair()], ratePctByBrand: RATES,
      sos: [so({ docNo: 'HC-SO-2611-004', createdAt: '2026-11-01T04:00:00Z', soDate: '2026-11-01', goodsSen: 682_50, totalSen: 682_50 })],
      payments: [{ docNo: 'HC-SO-2611-004', paidAt: '2026-10-04', amountSen: 300_00 }],
      changes: [change({ docNo: 'HC-SO-2611-004', changedAt: '2026-11-01T06:00:00Z', beforeGoodsSen: 788_80, afterGoodsSen: 682_50, beforeTotalSen: 788_80, afterTotalSen: 682_50 })],
      cancels: [],
    });
    expect(own.fairs[0]!.sos[0]).toMatchObject({ goodsSen: 682_50, commissionSen: 95_55 });
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
    expect(bySo.totals).toEqual({ payableSen: 130_00, adjustmentsSen: 0, monthAdjustmentsSen: 0, deferredInSen: 0, totalSen: 130_00 });
    expect(byFair.totals).toEqual({ payableSen: 0, adjustmentsSen: 130_00, monthAdjustmentsSen: 0, deferredInSen: 0, totalSen: 130_00 });
  });
});

/* Owner 2026-11-12: 「全部列出来，没有展会的标 No fair，要算佣金，然后我检查了不要算的
   我才自己按don't count」 — by SO date every order opened in the range is listed;
   one with no fair under "No fair" of its own brand, at that brand's rate. */
describe('by SO date, an order with no fair — 「没有展会的标 No fair，要算佣金」', () => {
  const noFair = (o: Partial<CommissionSo> = {}) => so({ docNo: 'HC-SO-2610-058', projectId: null, brand: 'ERGOTEX', venue: 'THE STARLING MALL', soDate: '2026-10-05', ...o });
  const pays = (doc: string, day: string, sen: number): CommissionPayment => ({ docNo: doc, paidAt: day, amountSen: sen });

  it('is listed under "No fair" of its own brand (as the rate card spells it, any case) with its venue, earning at the rate of that brand — a bed-frame bill at its VP brand', () => {
    const r = buildEventCommission({
      ...OCT, basis: 'so_date', fairs: [fair()], ratePctByBrand: new Map([...RATES, ['Carres Mattress', 14]]),
      sos: [
        so(),
        noFair({ docNo: 'HC-SO-2610-427', brand: 'AKEMI', venue: 'MID VALLEY' }),
        noFair({ docNo: 'HC-SO-2610-410', brand: 'zanotti', venue: 'SUNWAY CARNIVAL' }),
        noFair({ docNo: 'HC-SO-2610-500', brand: 'CARRES MATTRESS', venue: null }),
        /* Bed frames alone: BEDFRAME has no rate card, the VP brand the seller gave it does (owner 2026-11-13). */
        noFair({ docNo: 'HC-SO-2610-320', brand: 'BEDFRAME', vpBrand: 'AKEMI', venue: 'AEON RAWANG' }),
        noFair({ docNo: 'HC-SO-2610-341', brand: 'BEDFRAME', vpBrand: null, venue: 'KUALA LUMPUR CONVENTION CENTRE' }),
      ],
      payments: ['HC-SO-2610-001', 'HC-SO-2610-427', 'HC-SO-2610-410', 'HC-SO-2610-500', 'HC-SO-2610-320', 'HC-SO-2610-341'].map((d) => pays(d, '2026-10-06', 1_000_00)),
      changes: [], cancels: [],
    });
    const rows = r.fairs.map((f) => [f.id, f.name, f.brand, f.ratePct, f.sos.map((x) => [x.docNo, x.venue ?? '-', x.commissionSen])]);
    expect(rows).toEqual([
      [-1, 'No fair', 'AKEMI', 14, [['HC-SO-2610-320', 'AEON RAWANG', 140_00], ['HC-SO-2610-427', 'MID VALLEY', 140_00]]],
      [-2, 'No fair', 'BEDFRAME', null, [['HC-SO-2610-341', 'KUALA LUMPUR CONVENTION CENTRE', 0]]],
      [-3, 'No fair', 'Carres Mattress', 14, [['HC-SO-2610-500', '-', 140_00]]],
      [-4, 'No fair', 'ZANOTTI', 13, [['HC-SO-2610-410', 'SUNWAY CARNIVAL', 130_00]]],
      [1, 'KL [AKEMI] BIGHOME @ MID VALLEY', 'AKEMI', 14, [['HC-SO-2610-001', '-', 140_00]]],
    ]);
    expect(r.totals.payableSen).toBe(690_00);
  });

  it('under 30% it waits like any order, and reaching 30% the month after counts there; a cancellation takes it back', () => {
    const oct = buildEventCommission({
      ...OCT, basis: 'so_date', fairs: [], ratePctByBrand: RATES,
      sos: [noFair({ goodsSen: 28_000_00, totalSen: 28_000_00 })], payments: [pays('HC-SO-2610-058', '2026-10-05', 1_000_00)], changes: [], cancels: [],
    });
    expect(oct.fairs[0]!.sos[0]).toMatchObject({ docNo: 'HC-SO-2610-058', reachedOn: null, commissionSen: 0, venue: 'THE STARLING MALL' });
    const nov = buildEventCommission({
      from: '2026-11-01', to: '2026-11-30', basis: 'so_date', fairs: [], ratePctByBrand: new Map([...RATES, ['ERGOTEX', 14]]),
      sos: [noFair({ goodsSen: 28_000_00, totalSen: 28_000_00 }), noFair({ docNo: 'HC-SO-2610-196', brand: 'ZANOTTI', goodsSen: 1_000_00, totalSen: 1_000_00, status: 'CANCELLED' })],
      payments: [pays('HC-SO-2610-058', '2026-10-05', 1_000_00), pays('HC-SO-2610-058', '2026-11-10', 8_000_00), pays('HC-SO-2610-196', '2026-10-14', 1_000_00)],
      changes: [], cancels: [{ docNo: 'HC-SO-2610-196', at: '2026-11-20T02:00:00Z' }],
    });
    expect(nov.adjustments.map((a) => [a.docNo, a.kind, a.commissionSen])).toEqual([
      ['HC-SO-2610-058', 'reached', 3_920_00],
      ['HC-SO-2610-196', 'cancelled', -130_00],
    ]);
    expect(nov.earlierOrders.map((o) => [o.docNo, o.fairName, o.venue])).toEqual([
      ['HC-SO-2610-058', 'No fair', 'THE STARLING MALL'],
      ['HC-SO-2610-196', 'No fair', 'THE STARLING MALL'],
    ]);
  });

  it('not by fair, and not an order opened before October 2026 — the September ones were old orders keyed again (owner 2026-11-13)', () => {
    const input = {
      ...OCT, fairs: [], ratePctByBrand: RATES,
      sos: [noFair(), noFair({ docNo: 'HC-SO-2609-286', soDate: '2026-09-28' })],
      payments: [pays('HC-SO-2610-058', '2026-10-05', 28_000_00), pays('HC-SO-2609-286', '2026-10-09', 1_000_00)],
      changes: [], cancels: [],
    };
    expect(buildEventCommission(input).fairs).toEqual([]);
    expect(buildEventCommission(input).adjustments).toEqual([]);
    const bySo = buildEventCommission({ ...input, basis: 'so_date' });
    expect(bySo.fairs.flatMap((f) => f.sos.map((x) => x.docNo))).toEqual(['HC-SO-2610-058']);
    expect(bySo.adjustments).toEqual([]);
    expect(NO_FAIR_FROM).toBe('2026-10-01');
  });
});

/* Owner 2026-11-13: 「旧的单upsale？ 应该要算吧」 … 做 — an old order with no fair
   (opened before October 2026) never earns on its own amount, but its upsales and
   drop sales do, in the month they happen, at its brand's rate, paid or not. */
describe('by SO date, an old order with no fair — its upsales and drop sales count', () => {
  const old = (o: Partial<CommissionSo> = {}) => so({
    docNo: 'HC-SO-013238', projectId: null, brand: 'AKEMI', soDate: '2026-08-13', createdAt: '2026-08-28T03:00:00Z', goodsSen: 12_000_00, totalSen: 12_000_00, ...o,
  });
  const priced = (docNo: string, at: string, before: number, after: number) =>
    change({ docNo, changedAt: at, beforeGoodsSen: before, afterGoodsSen: after, beforeTotalSen: before, afterTotalSen: after });

  it('an upsale earns at its brand\'s rate and a drop takes off, whatever was paid — no 30% line, and not an order opened in the range', () => {
    const r = buildEventCommission({
      ...OCT, basis: 'so_date', fairs: [], ratePctByBrand: RATES,
      sos: [
        old(),
        /* Bed frames alone: the VP brand's rate, as for an order opened in the range. */
        old({ docNo: 'HC-SO-012776', brand: 'BEDFRAME', vpBrand: 'zanotti', soDate: '2026-07-14', goodsSen: 5_000_00, totalSen: 5_000_00 }),
      ],
      /* Paid in full in October: still no "reached 30%" line — its own amount never earns. */
      payments: [{ docNo: 'HC-SO-013238', paidAt: '2026-10-08', amountSen: 12_000_00 }],
      changes: [
        priced('HC-SO-013238', '2026-10-10T03:00:00Z', 10_000_00, 12_000_00),
        priced('HC-SO-012776', '2026-10-12T03:00:00Z', 6_000_00, 5_000_00),
      ],
      cancels: [],
    });
    expect(r.fairs).toEqual([]);
    expect(r.adjustments.map((a) => [a.docNo, a.fairName, a.kind, a.goodsSen, a.commissionSen, a.beforeReach])).toEqual([
      ['HC-SO-013238', 'No fair', 'upsale', 2_000_00, 280_00, false],
      ['HC-SO-012776', 'No fair', 'drop', -1_000_00, -130_00, false],
    ]);
    expect(r.changedOrders.map((x) => [x.docNo, x.part, x.brand, x.originalSen, x.latestSen, x.effectSen, x.oldOrder])).toEqual([
      ['HC-SO-013238', 'earlier', 'AKEMI', 10_000_00, 12_000_00, 280_00, true],
      ['HC-SO-012776', 'earlier', 'ZANOTTI', 6_000_00, 5_000_00, -130_00, true],
    ]);
    expect(r.totals.totalSen).toBe(150_00);
    /* By fair it has no fair: nothing. */
    expect(buildEventCommission({ ...OCT, fairs: [], ratePctByBrand: RATES, sos: [old()], payments: [], changes: [priced('HC-SO-013238', '2026-10-10T03:00:00Z', 10_000_00, 12_000_00)], cancels: [] }).adjustments).toEqual([]);
  });

  it('one opened in September 2026: nothing in September (no fair before October), its October changes count in October', () => {
    const input = {
      fairs: [], ratePctByBrand: RATES, basis: 'so_date' as const,
      sos: [old({ docNo: 'HC-SO-013473', brand: 'ZANOTTI', soDate: '2026-09-04', createdAt: '2026-09-07T03:00:00Z', goodsSen: 7_044_00, totalSen: 7_044_00 })],
      payments: [{ docNo: 'HC-SO-013473', paidAt: '2026-09-07', amountSen: 7_044_00 }],
      changes: [
        priced('HC-SO-013473', '2026-09-20T03:00:00Z', 5_000_00, 7_000_00),
        priced('HC-SO-013473', '2026-10-15T03:00:00Z', 7_000_00, 7_044_00),
      ],
      cancels: [],
    };
    const sep = buildEventCommission({ from: '2026-09-01', to: '2026-09-30', ...input });
    expect([sep.fairs, sep.adjustments, sep.changedOrders]).toEqual([[], [], []]);
    const oct = buildEventCommission({ ...OCT, ...input });
    expect(oct.adjustments.map((a) => [a.docNo, a.kind, a.commissionSen])).toEqual([['HC-SO-013473', 'upsale', 5_72]]);
  });

  it('cancelled in the range: the month\'s changes go with it, and nothing is taken back', () => {
    const r = buildEventCommission({
      ...OCT, basis: 'so_date', fairs: [], ratePctByBrand: RATES,
      sos: [old({ status: 'CANCELLED' })],
      payments: [{ docNo: 'HC-SO-013238', paidAt: '2026-08-28', amountSen: 12_000_00 }],
      changes: [priced('HC-SO-013238', '2026-10-03T03:00:00Z', 10_000_00, 12_000_00)],
      cancels: [{ docNo: 'HC-SO-013238', at: '2026-10-18T02:00:00Z' }],
    });
    expect([r.adjustments, r.earlierOrders, r.changedOrders]).toEqual([[], [], []]);
  });
});

/* Owner 2026-11-13 (his September sheet): a price the system wiped and put back,
   or the first price of an order keyed with none, set after the month — the order
   earns on it in its own month; it is not an upsale and not walked back. */
describe('a price put back, or first set, after the month — the order earns on it', () => {
  const SEP = fair({ id: 2, name: 'SELANGOR [ZANOTTI] BIGHOME @ SUNWAY PYRAMID', brand: 'ZANOTTI', startDate: '2026-09-04', endDate: '2026-09-06' });
  const SEPT = { from: '2026-09-01', to: '2026-09-30' };

  it('a price the system wiped in September and put back in October (HC-SO-013496)', () => {
    const r = buildEventCommission({
      ...SEPT, basis: 'so_date', fairs: [SEP], ratePctByBrand: RATES,
      sos: [so({ docNo: 'HC-SO-013496', projectId: 2, createdAt: '2026-09-05T03:00:00Z', soDate: '2026-09-05', goodsSen: 4_490_00, totalSen: 4_490_00 })],
      payments: [{ docNo: 'HC-SO-013496', paidAt: '2026-09-07', amountSen: 4_490_00 }],
      changes: [
        change({ docNo: 'HC-SO-013496', changedAt: '2026-09-10T03:00:00Z', beforeGoodsSen: 4_490_00, afterGoodsSen: 0, beforeTotalSen: 4_490_00, afterTotalSen: 0, source: 'history-ignored' }),
        change({ docNo: 'HC-SO-013496', changedAt: '2026-10-08T03:00:00Z', beforeGoodsSen: 0, afterGoodsSen: 4_490_00, beforeTotalSen: 0, afterTotalSen: 4_490_00, source: 'history-ignored' }),
      ],
      cancels: [],
    });
    expect(r.fairs[0]!.sos[0]).toMatchObject({ docNo: 'HC-SO-013496', goodsSen: 4_490_00, commissionSen: 583_70 });
    expect(r.changedOrders).toEqual([]);
  });

  it('an order keyed with no price and priced the month after (HC-SO-2609-254)', () => {
    const input = {
      fairs: [SEP], ratePctByBrand: RATES, basis: 'so_date' as const,
      sos: [so({ docNo: 'HC-SO-2609-254', projectId: 2, createdAt: '2026-09-20T03:00:00Z', soDate: '2026-09-20', goodsSen: 6_000_00, totalSen: 6_000_00 })],
      payments: [{ docNo: 'HC-SO-2609-254', paidAt: '2026-09-21', amountSen: 2_000_00 }],
      changes: [change({ docNo: 'HC-SO-2609-254', changedAt: '2026-10-01T03:00:00Z', beforeGoodsSen: 0, afterGoodsSen: 6_000_00, beforeTotalSen: 0, afterTotalSen: 6_000_00, source: 'history' })],
      cancels: [],
    };
    const sep = buildEventCommission({ ...SEPT, ...input });
    expect(sep.fairs[0]!.sos[0]).toMatchObject({ goodsSen: 6_000_00, reachedOn: '2026-09-21', commissionSen: 780_00 });
    /* October pays nothing more for it: the pricing is not an upsale. */
    const oct = buildEventCommission({ ...OCT, ...input });
    expect(oct.adjustments).toEqual([]);
    expect(oct.changedOrders).toEqual([]);
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
    sos: [sep(), sep({ docNo: 'HC-SO-2609-051', salesperson: 'Wei Pin', ref: 'ZNT0480' })], payments, changes: [], cancels: [],
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
      ref: 'ZNT0480', soDate: '2026-09-05', status: 'CONFIRMED',
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
    expect(withMonthAdjustments(october(), rows).totals).toEqual({ payableSen: 0, adjustmentsSen: 0, monthAdjustmentsSen: -130_00, deferredInSen: 0, totalSen: -130_00 });
    expect(october().monthAdjustments).toEqual([]);
  });
});

describe('round 3 (owner 2026-11-12)', () => {
  const pay = (docNo: string, paidAt: string, amountSen: number): CommissionPayment => ({ docNo, paidAt, amountSen });
  const mark = (o: Partial<CommissionMark> = {}): CommissionMark => ({
    id: 'm1', docNo: 'HC-SO-2610-001', kind: 'exclude', month: null, reason: 'checking', markedBy: 'Finance', markedAt: '2026-11-12T03:00:00Z', ...o,
  });
  const october = () => buildEventCommission({
    ...OCT, fairs: [fair()], ratePctByBrand: RATES,
    sos: [so(), so({ docNo: 'HC-SO-2610-002' })],
    payments: [pay('HC-SO-2610-001', '2026-10-02', 500_00), pay('HC-SO-2610-002', '2026-10-02', 500_00)], changes: [], cancels: [],
  });

  it("a fair's Total Sales is its orders' goods and its estimate those × the rate; the typed figure stays beside it", () => {
    const r = buildEventCommission({
      ...OCT, fairs: [fair()], ratePctByBrand: RATES,
      sos: [so(), so({ docNo: 'HC-SO-2610-002', goodsSen: 2_000_00, totalSen: 2_000_00 })],
      payments: [pay('HC-SO-2610-001', '2026-10-02', 500_00)], changes: [], cancels: [],
    });
    expect(r.fairs[0]).toMatchObject({ goodsSen: 3_000_00, estimateSen: 420_00, totalSalesRm: 484746, payableSen: 140_00 });
  });

  it('fairs that start the same day sit together: start, end, venue, organizer, brand', () => {
    const r = buildEventCommission({
      ...OCT, ratePctByBrand: RATES, sos: [], payments: [], changes: [], cancels: [],
      fairs: [
        fair({ id: 3, name: 'C', brand: 'ZANOTTI', venue: 'MID VALLEY', organizer: 'BIGHOME' }),
        fair({ id: 2, name: 'B', brand: 'AKEMI', venue: 'SETIA CITY', organizer: 'BIGHOME' }),
        fair({ id: 1, name: 'A', brand: 'AKEMI', venue: 'MID VALLEY', organizer: 'BIGHOME' }),
        fair({ id: 4, name: 'D', brand: 'AKEMI', venue: 'AEON', organizer: 'MLE', startDate: '2026-10-01' }),
      ],
    });
    expect(r.fairs.map((f) => f.id)).toEqual([4, 1, 3, 2]);
  });

  it('补开单: keyed in the range for a fair that had ended before it — not one keyed at the fair, not one of the range\'s fairs', () => {
    const r = buildEventCommission({
      ...OCT, fairs: [fair(), fair({ id: 9, name: 'Sep fair', startDate: '2026-09-04', endDate: '2026-09-06' })], ratePctByBrand: RATES,
      sos: [
        so({ docNo: 'HC-SO-2610-002', projectId: 9, createdAt: '2026-10-02T03:00:00Z', soDate: '2026-10-02' }),
        so({ docNo: 'HC-SO-2609-050', projectId: 9, createdAt: '2026-09-05T03:00:00Z', soDate: '2026-09-05' }),
        so(),
      ],
      payments: [], changes: [], cancels: [],
    });
    expect(r.lateBills).toEqual(['HC-SO-2610-002']);
  });

  it('「这张单不要算」: the order earns nothing, its row stays tagged, and it is listed with what it would have earned', () => {
    const r = withMarks(october(), [mark()]);
    expect(r.fairs[0]!.sos.find((s) => s.docNo === 'HC-SO-2610-001')).toMatchObject({ commissionSen: 0, mark: { kind: 'exclude', reason: 'checking' } });
    expect(r.fairs[0]!.payableSen).toBe(140_00);
    expect(r.marked).toMatchObject([{ docNo: 'HC-SO-2610-001', commissionSen: 140_00, mark: { kind: 'exclude' } }]);
    expect(r.totals.totalSen).toBe(140_00);
    expect(paidByOrder(r)).toEqual({ 'HC-SO-2610-002': 140_00 });
  });

  it('「这个算下个月」 acts only in the month it names, and only on a one-month report', () => {
    expect(withMarks(october(), [mark({ kind: 'defer', month: '2026-10' })]).totals.totalSen).toBe(140_00);
    expect(withMarks(october(), [mark({ kind: 'defer', month: '2026-09' })]).totals.totalSen).toBe(280_00);
    const quarter = buildEventCommission({
      from: '2026-10-01', to: '2026-12-31', fairs: [fair()], ratePctByBrand: RATES, sos: [so()],
      payments: [pay('HC-SO-2610-001', '2026-10-02', 500_00)], changes: [], cancels: [],
    });
    expect(withMarks(quarter, [mark({ kind: 'defer', month: '2026-10' })]).totals.totalSen).toBe(140_00);
    /* This month so far is the month too: a report to the 20th moves it. */
    const soFar = buildEventCommission({
      from: '2026-10-01', to: '2026-10-20', fairs: [fair()], ratePctByBrand: RATES, sos: [so()],
      payments: [pay('HC-SO-2610-001', '2026-10-02', 500_00)], changes: [], cancels: [],
    });
    expect(withMarks(soFar, [mark({ kind: 'defer', month: '2026-10' })]).totals.totalSen).toBe(0);
  });

  it('the month after receives what was moved and pays it; marked again, it moves on', () => {
    const moved = deferredInFrom(withMarks(october(), [mark({ kind: 'defer', month: '2026-10' })]), '2026-10');
    expect(moved).toMatchObject([{ docNo: 'HC-SO-2610-001', fromMonth: '2026-10', commissionSen: 140_00, fairName: fair().name }]);
    const november = buildEventCommission({
      from: '2026-11-01', to: '2026-11-30', fairs: [fair()], ratePctByBrand: RATES, sos: [so()],
      payments: [pay('HC-SO-2610-001', '2026-10-02', 500_00)], changes: [], cancels: [],
    });
    const nov = withMarks(november, [mark({ kind: 'defer', month: '2026-10' })], moved);
    expect(nov.totals).toMatchObject({ deferredInSen: 140_00, totalSen: 140_00 });
    expect(paidByOrder(nov)).toEqual({ 'HC-SO-2610-001': 140_00 });
    const again = withMarks(november, [mark({ kind: 'defer', month: '2026-10' }), mark({ id: 'm2', kind: 'defer', month: '2026-11' })], moved);
    expect(again.totals.totalSen).toBe(0);
    expect(deferredInFrom(again, '2026-11')).toMatchObject([{ docNo: 'HC-SO-2610-001', commissionSen: 140_00 }]);
  });

  it('marked "not counted" after its month closed: the recalculation drops it and the adjustment takes it back', () => {
    const closed = [{ month: '2026-10', paid: paidByOrder(october()), carried: [] }];
    const rows = monthAdjustmentsOf(closed, new Map([['2026-10', withMarks(october(), [mark()])]]));
    expect(rows).toMatchObject([{ month: '2026-10', docNo: 'HC-SO-2610-001', wasSen: 140_00, nowSen: 0, adjustmentSen: -140_00 }]);
  });
});

describe('a price change not counted — 「这次改价不算」 (owner 2026-11-12)', () => {
  const pay = (docNo: string, paidAt: string, amountSen: number): CommissionPayment => ({ docNo, paidAt, amountSen });
  const mark = (o: Partial<CommissionMark> = {}): CommissionMark => ({
    id: 'c1', docNo: 'HC-SO-2610-001', kind: 'exclude_change', month: '2026-10', reason: 'typing fix', markedBy: 'Finance', markedAt: '2026-11-12T03:00:00Z', ...o,
  });
  const SEP = { from: '2026-09-01', to: '2026-09-30' };
  const NOV = { from: '2026-11-01', to: '2026-11-30' };
  /* + RM 200.00 on 20 October, and the order as it stands after it. */
  const UP = change();
  const upsold = so({ goodsSen: 1_200_00, totalSen: 1_300_00 });
  const octoberFair = (changes: CommissionChange[]) => buildEventCommission({
    ...OCT, fairs: [fair()], ratePctByBrand: RATES, sos: [upsold], payments: [pay('HC-SO-2610-001', '2026-10-02', 500_00)], changes, cancels: [],
  });
  /* The same upsale on an order of a September fair. */
  const SEP_FAIR = fair({ id: 9, name: 'KL [AKEMI] REX @ MID VALLEY', startDate: '2026-09-04', endDate: '2026-09-06' });
  const SEP_UP = change({ docNo: 'HC-SO-2609-050' });
  const sepMark = mark({ docNo: 'HC-SO-2609-050' });
  const sepOrder = (o: Partial<CommissionSo> = {}) => so({
    docNo: 'HC-SO-2609-050', projectId: 9, createdAt: '2026-09-05T03:00:00Z', soDate: '2026-09-05', goodsSen: 1_200_00, totalSen: 1_300_00, ...o,
  });
  const sepFair = (range: { from: string; to: string }, o: { sos?: CommissionSo[]; payments: CommissionPayment[]; changes: CommissionChange[]; cancels?: Array<{ docNo: string; at: string }> }) =>
    buildEventCommission({ ...range, fairs: [SEP_FAIR], ratePctByBrand: RATES, sos: o.sos ?? [sepOrder()], payments: o.payments, changes: o.changes, cancels: o.cancels ?? [] });

  it('the mark names an order and a month: its changes made in that month (Malaysia time) are left out, no other', () => {
    const chs = [
      change({ changedAt: '2026-09-30T15:59:00Z' }), // 30 September, 23:59 in Malaysia
      change({ changedAt: '2026-09-30T16:00:00Z' }), // 1 October
      change({ changedAt: '2026-10-31T15:59:00Z' }), // 31 October
      change({ changedAt: '2026-10-31T16:00:00Z' }), // 1 November
      change({ docNo: 'HC-SO-2610-002' }),
    ];
    const marks = [mark(), mark({ id: 'x1', docNo: 'HC-SO-2610-002', kind: 'exclude', month: null }), mark({ id: 'd1', docNo: 'HC-SO-2610-002', kind: 'defer' })];
    expect(withUncountedChanges(chs, marks).map((c) => c.uncounted)).toEqual([false, true, true, false, false]);
    expect(withUncountedChanges(chs, []).some((c) => c.uncounted)).toBe(false);
  });

  it("this range's fair: the order earns on its goods less the change; its goods and the fair's Total Sales stay; the change is listed with no effect", () => {
    const counted = octoberFair([UP]);
    expect(counted.fairs[0]!.sos[0]).toMatchObject({ goodsSen: 1_200_00, commissionSen: 168_00 });
    expect(counted.changedOrders).toMatchObject([{ amendedSen: 200_00, effectSen: 28_00 }]);

    const r = octoberFair(withUncountedChanges([UP], [mark()]));
    expect(r.fairs[0]!.sos[0]).toMatchObject({ goodsSen: 1_200_00, commissionSen: 140_00, uncountedSen: 28_00 });
    expect(r.fairs[0]!.sos[0]!.changes).toMatchObject([{ deltaGoodsSen: 200_00, notCounted: null, uncounted: true }]);
    expect(r.fairs[0]).toMatchObject({ goodsSen: 1_200_00, estimateSen: 168_00, payableSen: 140_00 });
    expect(r.changedOrders).toMatchObject([{
      docNo: 'HC-SO-2610-001', part: 'range', originalSen: 1_000_00, latestSen: 1_200_00, amendedSen: 200_00, effectSen: 0, uncountedGoodsSen: 200_00,
    }]);
    expect(r.totals.totalSen).toBe(140_00);
  });

  it('a drop sale left out: the order still earns on what it was before the drop', () => {
    const DROP = change({ afterGoodsSen: 800_00, afterTotalSen: 900_00 });
    const dropped = (changes: CommissionChange[]) => buildEventCommission({
      ...OCT, fairs: [fair()], ratePctByBrand: RATES, sos: [so({ goodsSen: 800_00, totalSen: 900_00 })],
      payments: [pay('HC-SO-2610-001', '2026-10-02', 500_00)], changes, cancels: [],
    });
    expect(dropped([DROP]).fairs[0]!.sos[0]).toMatchObject({ commissionSen: 112_00 });
    expect(dropped([DROP]).changedOrders).toMatchObject([{ amendedSen: -200_00, effectSen: -28_00 }]);
    const r = dropped(withUncountedChanges([DROP], [mark()]));
    expect(r.fairs[0]!.sos[0]).toMatchObject({ goodsSen: 800_00, commissionSen: 140_00, uncountedSen: -28_00 });
    expect(r.changedOrders).toMatchObject([{ amendedSen: -200_00, effectSen: 0, uncountedGoodsSen: -200_00 }]);
  });

  it('an opening-day fix in the marked month is not an upsale: its goods still count', () => {
    const fix = change({ changedAt: '2026-10-02T08:00:00Z' });
    const r = octoberFair(withUncountedChanges([fix], [mark()]));
    expect(r.fairs[0]!.sos[0]).toMatchObject({ commissionSen: 168_00 });
    expect(r.fairs[0]!.sos[0]!.changes).toMatchObject([{ notCounted: 'opening_day', uncounted: false }]);
    expect(r.changedOrders).toEqual([]);
  });

  it('an earlier order upsold after it had reached 30%: the upsale line stays, earning nothing', () => {
    const paidInSep = [pay('HC-SO-2609-050', '2026-09-05', 500_00)];
    const counted = sepFair(OCT, { payments: paidInSep, changes: [SEP_UP] });
    expect(counted.adjustments).toMatchObject([{ kind: 'upsale', date: '2026-10-20', goodsSen: 200_00, commissionSen: 28_00 }]);

    const r = sepFair(OCT, { payments: paidInSep, changes: withUncountedChanges([SEP_UP], [sepMark]) });
    expect(r.adjustments).toMatchObject([{ kind: 'upsale', date: '2026-10-20', goodsSen: 200_00, commissionSen: 0, uncounted: true, uncountedSen: 28_00 }]);
    expect(r.earlierOrders).toMatchObject([{ docNo: 'HC-SO-2609-050', amendedSen: 200_00, commissionSen: 0, events: [{ kind: 'upsale', uncounted: true }] }]);
    expect(r.changedOrders).toMatchObject([{ part: 'earlier', amendedSen: 200_00, effectSen: 0, uncountedGoodsSen: 200_00 }]);
    expect(r.totals.totalSen).toBe(0);
  });

  it('an earlier order reaching 30% after the change: it earns that day on its goods less the change', () => {
    const paidLate = [pay('HC-SO-2609-050', '2026-10-25', 500_00)];
    const counted = sepFair(OCT, { payments: paidLate, changes: [SEP_UP] });
    expect(counted.adjustments.find((a) => a.kind === 'reached')).toMatchObject({ date: '2026-10-25', goodsSen: 1_200_00, commissionSen: 168_00 });

    const r = sepFair(OCT, { payments: paidLate, changes: withUncountedChanges([SEP_UP], [sepMark]) });
    expect(r.adjustments.find((a) => a.kind === 'reached')).toMatchObject({ date: '2026-10-25', goodsSen: 1_200_00, commissionSen: 140_00, uncountedSen: 28_00 });
    expect(r.adjustments.find((a) => a.kind === 'upsale')).toMatchObject({ commissionSen: 0, beforeReach: true, uncounted: true });
    expect(r.totals.totalSen).toBe(140_00);
  });

  it('it stays left out in the months after: 30% reached in November earns on the goods less the October change', () => {
    const paidInNov = [pay('HC-SO-2609-050', '2026-11-05', 500_00)];
    expect(sepFair(NOV, { payments: paidInNov, changes: [SEP_UP] }).totals.totalSen).toBe(168_00);
    const r = sepFair(NOV, { payments: paidInNov, changes: withUncountedChanges([SEP_UP], [sepMark]) });
    expect(r.adjustments).toMatchObject([{ kind: 'reached', date: '2026-11-05', goodsSen: 1_200_00, commissionSen: 140_00, uncountedSen: 28_00 }]);
  });

  it('a cancellation later takes back what the order earned — never the change that was not counted', () => {
    const o = {
      sos: [sepOrder({ status: 'CANCELLED' })], payments: [pay('HC-SO-2609-050', '2026-09-05', 500_00)],
      cancels: [{ docNo: 'HC-SO-2609-050', at: '2026-11-10T02:00:00Z' }],
    };
    const months = (changes: CommissionChange[]) => [SEP, OCT, NOV].map((range) => sepFair(range, { ...o, changes }).totals.totalSen);
    expect(months([SEP_UP])).toEqual([140_00, 28_00, -168_00]);
    expect(months(withUncountedChanges([SEP_UP], [sepMark]))).toEqual([140_00, 0, -140_00]);
  });

  it('the changed order carries the mark for its Undo, and the mark is listed with what it took out — the order itself is not marked', () => {
    const marks = [mark()];
    const r = withMarks(octoberFair(withUncountedChanges([UP], marks)), marks);
    expect(r.changedOrders[0]).toMatchObject({ effectSen: 0, changeMark: { id: 'c1', kind: 'exclude_change', month: '2026-10', reason: 'typing fix' } });
    expect(r.changedOrders[0]!.mark).toBeUndefined();
    expect(r.fairs[0]!.sos[0]).toMatchObject({ commissionSen: 140_00 });
    expect(r.fairs[0]!.sos[0]!.mark).toBeUndefined();
    expect(r.marked).toMatchObject([{ docNo: 'HC-SO-2610-001', commissionSen: 28_00, mark: { id: 'c1', kind: 'exclude_change' } }]);
    expect(r.totals.totalSen).toBe(140_00);
    expect(paidByOrder(r)).toEqual({ 'HC-SO-2610-001': 140_00 });
  });

  it('a mark for another month changes nothing here and is not listed', () => {
    const marks = [mark({ month: '2026-09' })];
    const r = withMarks(octoberFair(withUncountedChanges([UP], marks)), marks);
    expect(r.totals.totalSen).toBe(168_00);
    expect(r.changedOrders[0]).toMatchObject({ effectSen: 28_00 });
    expect(r.changedOrders[0]!.changeMark).toBeUndefined();
    expect(r.marked).toEqual([]);
  });

  it('with 「这张单不要算」 the whole order earns nothing; with 「这个算下个月」 the month after receives it less the change', () => {
    const excluded = [mark(), mark({ id: 'x1', kind: 'exclude', month: null })];
    const none = withMarks(octoberFair(withUncountedChanges([UP], excluded)), excluded);
    expect(none.totals.totalSen).toBe(0);
    expect(none.marked.map((m) => [m.mark.kind, m.commissionSen])).toEqual([['exclude', 140_00], ['exclude_change', 28_00]]);

    const moved = [mark(), mark({ id: 'd1', kind: 'defer' })];
    const oct = withMarks(octoberFair(withUncountedChanges([UP], moved)), moved);
    expect(oct.totals.totalSen).toBe(0);
    expect(deferredInFrom(oct, '2026-10')).toMatchObject([{ docNo: 'HC-SO-2610-001', commissionSen: 140_00 }]);
  });

  it('marked after its month closed: the recalculation leaves the change out and the adjustment takes it back', () => {
    const closed = [{ month: '2026-10', paid: paidByOrder(octoberFair([UP])), carried: [] }];
    const now = withMarks(octoberFair(withUncountedChanges([UP], [mark()])), [mark()]);
    expect(monthAdjustmentsOf(closed, new Map([['2026-10', now]]))).toMatchObject([
      { month: '2026-10', docNo: 'HC-SO-2610-001', wasSen: 168_00, nowSen: 140_00, adjustmentSen: -28_00 },
    ]);
  });
});
