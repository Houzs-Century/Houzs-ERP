import { describe, expect, it } from 'vitest';
import { coerceTransportBill, type TransportBillLine } from './threepl-bill-read';
import {
  billBreakdown, chargeNote, chargesPerDo, effectiveKind, foldTrips, isOpenLine, lineTotals, matchLines, orderKeys, pickDo, preselect,
  type DoCandidate, type OrderKeys,
} from './threepl-bill-match';

/* The three bills the owner pointed at (2026-10-23): MSJ's handwritten sheet
   ("6/10-SO-013216 RM120", SO read as "80-" by the scan), NEST LIVING's list
   of a trip's DOs under one price, EU LOGISTICS naming the customer's slip. */

const order = (o: Partial<{ doNo: string; soNo: string; ref: string }>) => ({ doNo: o.doNo ?? null, soNo: o.soNo ?? null, ref: o.ref ?? null });
const line = (l: Partial<TransportBillLine>): TransportBillLine => ({ text: '', date: null, place: null, kind: 'delivery', amountSen: null, orders: [], ...l });
const DO = (id: string, doDate: string | null = '2026-10-06', companyId = 1): DoCandidate => ({ id, doNumber: `HC-DO-${id}`, doDate, soDocNo: null, companyId, customer: null });

describe('the numbers a printed order stands for', () => {
  it('MSJ: the day in front is the trip, the SO is the order — read as "80-" or "S0-" too', () => {
    expect(orderKeys(order({ soNo: '6/10-SO-013216' })).soNos).toEqual(['HC-SO-013216']);
    expect(orderKeys(order({ soNo: '3/10-80-010540' })).soNos).toEqual(['HC-SO-010540']);
    expect(orderKeys(order({ soNo: '7|0-S0-003361' })).soNos).toEqual(['HC-SO-003361']);
    expect(orderKeys(order({ soNo: '2919-SO-011465' })).soNos).toEqual(['HC-SO-011465']);
  });

  it('a new-style number is the Houzs or the 2990 order; a company prefix decides', () => {
    expect(orderKeys(order({ soNo: 'SO-2609-003' })).soNos).toEqual(['HC-SO-2609-003', '2990-SO-2609-003']);
    expect(orderKeys(order({ soNo: '2990-SO-2606-037' })).soNos).toEqual(['2990-SO-2606-037']);
    expect(orderKeys(order({ soNo: 'SO-2609-401' })).soNos).not.toContain('HC-SO-002609');
  });

  it('NEST: an AutoCount DO number; EU: the customer\'s slip; ASSR is a service case, not a slip', () => {
    expect(orderKeys(order({ doNo: 'DO-010676' })).doNos).toEqual(['HC-DO-010676']);
    expect(orderKeys(order({ ref: 'ZNT6656' }))).toEqual({ soNos: [], doNos: [], slips: ['ZNT6656'], assr: [] });
    expect(orderKeys(order({ ref: 'znt6762+HC13245' })).slips).toEqual(['ZNT6762', 'HC13245']);
    expect(orderKeys(order({ ref: 'ASSR/2607-047' }))).toEqual({ soNos: [], doNos: [], slips: [], assr: ['2607-047'] });
    expect(orderKeys(order({ soNo: 'SO012467' })).slips).toEqual([]);
  });
});

describe('what is priced per DO', () => {
  it('its own words outrank the reader: storage and handling are not deliveries (「仓储，搬运不算」)', () => {
    expect(effectiveKind({ kind: 'delivery', text: "HANDLING OUT SEP'26" })).toBe('handling');
    expect(effectiveKind({ kind: 'other', text: 'AKEMI WAREHOUSE STORAGE SEP\'26' })).toBe('storage');
    expect(effectiveKind({ kind: 'delivery', text: 'DISMANTLE SETIA SPICE (2 TRIPS)' })).toBe('dismantle');
    expect(effectiveKind({ kind: 'delivery', text: 'DISPOSE MATT' })).toBe('dispose');
    expect(effectiveKind({ kind: 'delivery', text: 'TRANSPORT TO PENANG' })).toBe('delivery');
  });

  it('each line says what became of it', () => {
    const resolve = (k: OrderKeys) => (k.soNos.includes('HC-SO-013216') ? [DO('a')] : []);
    const got = matchLines([
      line({ text: '6/10-SO-013216', amountSen: 12_000, orders: [order({ soNo: '6/10-SO-013216' })] }),
      line({ text: 'DO-010676', amountSen: 60_000, orders: [order({ doNo: 'DO-010676' })] }),
      line({ text: 'TRANSPORT TO PENANG (8 TRIPS)', amountSen: 88_000 }),
      line({ text: 'ASSR/2607-047', amountSen: 14_500, orders: [order({ ref: 'ASSR/2607-047' })] }),
      line({ text: 'HANDLING OUT', kind: 'handling', amountSen: 14_840 }),
      line({ text: '6/10-SO-010503', kind: 'other', amountSen: 10_000, orders: [order({ soNo: '6/10-SO-013216' })] }),
    ], resolve);
    expect(got.map((l) => l.status)).toEqual(['matched', 'not_found', 'no_number', 'service_case', 'not_delivery', 'matched']);
    expect(lineTotals(got)).toEqual({ all: 199_340, matched: 22_000, not_found: 60_000, no_number: 88_000, service_case: 14_500, not_delivery: 14_840 });
  });
});

describe('a trip\'s one price, and an order delivered twice', () => {
  it('rows naming only the trip\'s other DOs join the priced row before them, on the same day', () => {
    const resolve = (k: OrderKeys) => k.doNos.map((n) => DO(n.slice(-6)));
    const lines = foldTrips(matchLines([
      line({ date: '2026-09-02', amountSen: 60_000, orders: [order({ doNo: 'DO-010676' })] }),
      line({ date: '2026-09-02', amountSen: 0, orders: [order({ doNo: 'DO-010677' })] }),
      line({ date: '2026-09-03', amountSen: null, orders: [order({ doNo: 'DO-010698' })] }),
    ], resolve));
    expect(lines.map((l) => l.dos.map((d) => d.id))).toEqual([['010676', '010677'], ['010698']]);
  });

  it('shared in proportion to the rate card, evenly without one; the shares add up to the price', () => {
    const trip = foldTrips(matchLines([line({ text: 'trip', amountSen: 60_000, orders: [order({ doNo: 'DO-010676' }), order({ doNo: 'DO-010677' })] })],
      (k) => k.doNos.map((n) => DO(n.slice(-6)))));
    const byCard = chargesPerDo(trip, (id) => (id === '010676' ? 30_000 : 10_000));
    expect(byCard.map((c) => [c.doId, c.billedSen, c.split])).toEqual([['010676', 45_000, true], ['010677', 15_000, true]]);
    const even = chargesPerDo(trip, (id) => (id === '010676' ? 30_000 : null));
    expect(even.map((c) => c.billedSen)).toEqual([30_000, 30_000]);
    const three = foldTrips(matchLines([line({ amountSen: 10_000, orders: ['1', '2', '3'].map((n) => order({ doNo: `DO-01000${n}` })) })],
      (k) => k.doNos.map((n) => DO(n.slice(-6)))));
    expect(chargesPerDo(three, () => null).map((c) => c.billedSen)).toEqual([3_333, 3_333, 3_334]);
  });

  it('a DO on two lines carries both; the note names the bill and its lines', () => {
    const resolve = () => [DO('a')];
    const lines = matchLines([
      line({ text: '6/10-SO-013216', amountSen: 12_000, orders: [order({ soNo: '6/10-SO-013216' })] }),
      line({ text: '6/10-SO-013216', amountSen: 10_000, orders: [order({ soNo: '6/10-SO-013216' })] }),
    ], resolve);
    const [c] = chargesPerDo(lines, () => null);
    expect(c!.billedSen).toBe(22_000);
    expect(chargeNote(c!, 'HC-API-2610-009')).toBe('HC-API-2610-009: 6/10-SO-013216 — RM 120.00 / 6/10-SO-013216 — RM 100.00');
  });

  it('an order delivered in several DOs: the DO dated nearest the line', () => {
    const dos = [DO('x', '2026-09-20'), DO('y', '2026-10-05'), DO('z', '2026-10-12')];
    expect(pickDo(dos, '2026-10-06')!.id).toBe('y');
    expect(pickDo(dos, null)!.id).toBe('z');
    expect(pickDo([], '2026-10-06')).toBeNull();
  });
});

describe('the reader\'s answer, coerced', () => {
  it('amounts in sen, "transport" a delivery, orders with no number dropped, junk safe', () => {
    const got = coerceTransportBill({
      lines: [
        { text: 'TRANSPORT TO KL', kind: 'transport', amountRm: 145, date: '2026-10-06', orders: [{ doNo: 'DO-010676' }, { doNo: null }] },
        { text: 'x', kind: 'weird', amountRm: 'abc', orders: 'no' },
        null,
      ],
    });
    expect(got).toEqual([
      { text: 'TRANSPORT TO KL', date: '2026-10-06', place: null, kind: 'delivery', amountSen: 14_500, orders: [{ doNo: 'DO-010676', soNo: null, ref: null }] },
      { text: 'x', date: null, place: null, kind: 'other', amountSen: null, orders: [] },
    ]);
    expect(coerceTransportBill('nonsense')).toEqual([]);
  });
});

/* Owner 2026-10-24: 「当这些对不上的我认为我想要assign 看这个是去哪里，可能是service,
   可能是setup dismantle，可能不算」 — the reader puts what it can, the rest waits. */
describe('where a line goes, as the reader sees it', () => {
  type Read = Parameters<typeof preselect>[0];
  const m = (l: Partial<Read>): Read => ({ status: 'not_found', kind: 'delivery', amountSen: 10_000, printed: [], dos: [], ...l });

  it('a matched line to its DOs; a service case to Service with its ASSR number', () => {
    expect(preselect(m({ status: 'matched', dos: [DO('a'), DO('b')] }), [])).toEqual({ assign: 'do', doIds: ['a', 'b'], serviceRef: null, projectId: null });
    expect(preselect(m({ status: 'service_case', printed: ['HC-SO-1', 'ASSR-2610-004'] }), [])).toEqual({ assign: 'service', doIds: [], serviceRef: 'ASSR-2610-004', projectId: null });
  });

  it('a setup / dismantle takes the fair of the one AP invoice line of its amount, else waits for one', () => {
    const ap = [{ amountSen: 110_000, projectId: 345 }, { amountSen: 5_300, projectId: null }];
    expect(preselect(m({ status: 'not_delivery', kind: 'dismantle', amountSen: 110_000 }), ap)).toMatchObject({ assign: 'event', projectId: 345 });
    expect(preselect(m({ status: 'not_delivery', kind: 'setup', amountSen: 90_000 }), ap)).toMatchObject({ assign: 'event', projectId: null });
    /* Two fairs carry that amount: not guessed. */
    expect(preselect(m({ status: 'not_delivery', kind: 'setup', amountSen: 110_000 }), [...ap, { amountSen: 110_000, projectId: 346 }])).toMatchObject({ projectId: null });
  });

  it('storage, handling and dispose are not counted; a number not found or no number waits', () => {
    for (const kind of ['storage', 'handling', 'dispose'] as const) expect(preselect(m({ status: 'not_delivery', kind }), []).assign).toBe('none');
    expect(preselect(m({ status: 'not_found' }), []).assign).toBeNull();
    expect(preselect(m({ status: 'no_number' }), []).assign).toBeNull();
  });

  it('open: nothing assigned, a DO line with no DO, a setup / dismantle with no fair', () => {
    expect(isOpenLine({ assign: null, doIds: [], projectId: null })).toBe(true);
    expect(isOpenLine({ assign: 'do', doIds: [], projectId: null })).toBe(true);
    expect(isOpenLine({ assign: 'event', doIds: [], projectId: null })).toBe(true);
    expect(isOpenLine({ assign: 'event', doIds: [], projectId: 7 })).toBe(false);
    expect(isOpenLine({ assign: 'service', doIds: [], projectId: null })).toBe(false);
    expect(isOpenLine({ assign: 'none', doIds: [], projectId: null })).toBe(false);
  });

  it('a bill summed by where its lines went adds up to the bill as read', () => {
    const t = billBreakdown([
      { assign: 'do', doIds: ['a'], projectId: null, amountSen: 22_000 },
      { assign: 'service', doIds: [], projectId: null, amountSen: 8_000 },
      { assign: 'event', doIds: [], projectId: 345, amountSen: 110_000 },
      { assign: 'event', doIds: [], projectId: null, amountSen: 90_000 },
      { assign: 'none', doIds: [], projectId: null, amountSen: 5_300 },
      { assign: null, doIds: [], projectId: null, amountSen: 60_000 },
      { assign: null, doIds: [], projectId: null, amountSen: null },
    ]);
    expect(t).toEqual({ do: 22_000, service: 8_000, event: 110_000, none: 5_300, open: 150_000, openLines: 3 });
  });
});
