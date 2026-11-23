/* Rebuilding past product changes from an order's history (owner 2026-11-23:
   「补，从 9 月开始」; scripts/lib/so-product-change-history.mjs, run by
   scripts/backfill-so-product-changes.mjs). Pinned on made-up orders:
     • a direct SKU swap is one DIRECT row of its day, with the selling and cost
       it moved, shaped as the live record writes it;
     • a quantity change that moved no selling is a typo fix: no row;
     • an amendment's LINES and PRICE halves are one AMENDMENT row under the
       first half's id, the selling of both halves together;
     • a price taken to RM 0 and put back later moves no selling;
     • a write the log cannot place leaves the steps before it out;
     • a line with no cost stamped takes its product's cost that day, marked
       estimated;
     • a window the live record already holds is left to it. */
import { describe, expect, test } from 'vitest';
import { orderEvents, rebuildRecordRows, recordRow, walkOrder } from '../scripts/lib/so-product-change-history.mjs';

type Row = Record<string, unknown>;
const CATEGORY: Record<string, string> = { 'CODY-(K)': 'BEDFRAME', 'CODY-(Q)': 'BEDFRAME', 'SIDE-TABLE': 'OTHERS', PILLOW: 'OTHERS' };
const category = (_c: number, code: string) => CATEGORY[code] ?? null;
const OWN: Record<string, number> = { 'SIDE-TABLE': 8_000, PILLOW: 40_000 };
const ownCost = (_c: number, code: string) => OWN[code] ?? 0;
const order = (d: string, extra: Row = {}) => ({ d, c: 1, st: 'CONFIRMED', sd: '2026-09-01', od: '2026-09-01', ...extra });
const line = (id: string, d: string, ic: string, q: number, u: number, lc: number, extra: Row = {}): Row => ({
  id, d, c: 1, ln: 1, ic, g: 'bedframe', q, u, ds: 0, t: q * u, uc: Math.floor(lc / Math.max(1, q)), lc, x: false, h: null, bk: null, fc: null, ...extra,
});
let seq = 0;
const log = (d: string, a: string, at: string, f: Row[], extra: Row = {}): Row => ({ id: `log-${String(++seq).padStart(3, '0')}`, d, c: 1, a, s: 'web', at, by: 'Ali', f, ...extra });
const created = (d: string) => log(d, 'CREATE', '2026-09-01T02:00:00.000000+00:00', []);

function eventsOf(o: Row, linesNow: Row[], audit: Row[], opts: { revsByAmd?: Map<string, Row>; amds?: Map<string, Row>; fold?: boolean } = {}) {
  const { steps, problems } = walkOrder({
    order: o, linesNow, audit, revsByAmd: opts.revsByAmd ?? new Map(), category,
    estCost: (code: string, qty: number) => ownCost(1, code) * Math.max(0, qty),
  });
  const events = orderEvents({ order: o, steps, amds: opts.amds ?? new Map(), category, ownCost, foldHalves: opts.fold ?? true });
  return { events, problems };
}
const rowOf = (ev: unknown) => recordRow(ev, { category, staffName: (id: string | null) => (id === 'u-1' ? 'Aina' : null) });

describe('rebuilding a past product change', () => {
  test('a direct SKU swap is one DIRECT row of its day, with the selling and cost it moved', () => {
    const { events } = eventsOf(order('SO-T1'), [line('L1', 'SO-T1', 'CODY-(Q)', 1, 260_000, 104_000)], [
      created('SO-T1'),
      log('SO-T1', 'UPDATE_LINE', '2026-09-05T03:00:00.000000+00:00', [
        { field: 'itemCode', from: 'CODY-(K)', to: 'CODY-(Q)' }, { field: 'unitPriceSen', from: 300_000, to: 260_000 }, { field: 'unitCostSen', from: 120_000, to: 104_000 },
      ]),
    ]);
    expect(events).toHaveLength(1);
    expect(rowOf(events[0])).toMatchObject({
      so_doc_no: 'SO-T1', route: 'DIRECT', window_key: '2026-09-05', change_day: '2026-09-05', changed_by: ['Ali'], approved_by: [], amendment_nos: [],
      change_types: ['sku'], bucket: 'SELLING', selling_before_sen: 300_000, selling_after_sen: 260_000, cost_before_sen: 120_000, cost_after_sen: 104_000,
      cost_estimated: false,
      lines: [{ id: 'L1', types: ['sku'], before: { code: 'CODY-(K)', qty: 1, sellingSen: 300_000, costSen: 120_000 }, after: { code: 'CODY-(Q)', qty: 1, sellingSen: 260_000, costSen: 104_000 } }],
      before_lines: [{ id: 'L1', code: 'CODY-(K)', group: 'bedframe', qty: 1, sellingSen: 300_000, costSen: 120_000, spec: {} }],
    });
  });

  test('a quantity change that moved no selling is a typo fix: no row', () => {
    const { events } = eventsOf(order('SO-T2'), [line('L1', 'SO-T2', 'PILLOW', 2, 100_000, 80_000, { g: 'others', ds: 100_000, t: 100_000 })], [
      created('SO-T2'),
      log('SO-T2', 'UPDATE_LINE', '2026-09-06T03:00:00.000000+00:00', [
        { field: 'itemCode', to: 'PILLOW' }, { field: 'qty', from: 1, to: 2 }, { field: 'discountSen', from: 0, to: 100_000 },
      ]),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ds: 0, dc: 40_000, qtyLines: 1, qtyNosell: 1 });
    expect(rowOf(events[0])).toBeNull();
  });

  test("an amendment's LINES and PRICE halves are one AMENDMENT row under the first half's id", () => {
    const before = (ic: string, u: number, lc: number) => [{ ...line('L1', 'SO-T3', ic, 1, u, lc) }];
    const revsByAmd = new Map<string, Row>([
      ['A1', { d: 'SO-T3', c: 1, amd: 'A1', at: '2026-10-03T03:00:00.000000+00:00', L: before('QUEEN-PLUSH-(Q)', 459_900, 182_000) }],
      ['A2', { d: 'SO-T3', c: 1, amd: 'A2', at: '2026-10-03T03:00:02.000000+00:00', L: before('KING-PLUSH-(K)', 459_900, 214_000) }],
    ]);
    const amds = new Map<string, Row>([
      ['A1', { id: 'A1', d: 'SO-T3', c: 1, no: 'SO-T3/A1', cr: '2026-10-02T09:00:00.000000+00:00', rb: 'u-1', reason: 'upgrade',
        L: [{ ct: 'SPEC', sid: 'L1', oic: 'QUEEN-PLUSH-(Q)', nic: 'KING-PLUSH-(K)', oq: 1, nq: 1 }] }],
      ['A2', { id: 'A2', d: 'SO-T3', c: 1, no: 'SO-T3/A2', cr: '2026-10-02T09:00:02.000000+00:00', rb: 'u-1', reason: 'upgrade',
        L: [{ ct: 'PRICE', sid: 'L1', oic: 'KING-PLUSH-(K)', nic: 'KING-PLUSH-(K)', oq: 1, nq: 1 }] }],
    ]);
    const audit = [
      created('SO-T3'),
      log('SO-T3', 'AMENDMENT_SO_APPROVED', '2026-10-03T03:00:01.000000+00:00', [{ field: 'amendment_id', to: 'A1' }], { by: 'Kris' }),
      log('SO-T3', 'AMENDMENT_SO_APPROVED', '2026-10-03T03:00:03.000000+00:00', [{ field: 'amendment_id', to: 'A2' }], { by: 'Kris' }),
    ];
    const now = [line('L1', 'SO-T3', 'KING-PLUSH-(K)', 1, 529_900, 214_000)];
    const folded = eventsOf(order('SO-T3'), now, audit, { revsByAmd, amds, fold: true }).events;
    expect(folded).toHaveLength(1);
    expect(rowOf(folded[0])).toMatchObject({
      route: 'AMENDMENT', window_key: 'A1', change_day: '2026-10-03', amendment_nos: ['SO-T3/A1', 'SO-T3/A2'], changed_by: ['Aina'], approved_by: ['Kris'],
      change_types: ['sku'], bucket: 'SELLING', selling_before_sen: 459_900, selling_after_sen: 529_900, cost_before_sen: 182_000, cost_after_sen: 214_000,
    });
    /* Read half by half, the price half is no product change and its selling
       would be lost: the SKU half alone looks like a cost rise nobody priced. */
    const halves = eventsOf(order('SO-T3'), now, audit, { revsByAmd, amds, fold: false }).events;
    expect(halves.map((e) => rowOf(e)?.bucket ?? null)).toEqual(['COST_ONLY']);
  });

  test('a price taken to RM 0 and put back later moves no selling', () => {
    const now = [line('L1', 'SO-T4', 'CODY-(K)', 1, 300_000, 120_000, { h: '28' })];
    const zeroed = log('SO-T4', 'UPDATE_LINE', '2026-09-10T03:00:00.000000+00:00', [
      { field: 'itemCode', to: 'CODY-(K)' }, { field: 'spec', from: 'BEDFRAME SEAT 24', to: 'BEDFRAME SEAT 28' }, { field: 'unitPriceSen', from: 300_000, to: 0 },
    ]);
    const repaired = log('SO-T4', 'UPDATE_LINE', '2026-09-12T03:00:00.000000+00:00', [{ field: 'line_CODY-(K)_unit_price_sen', from: 0, to: 300_000 }], { s: 'script' });
    const withRepair = eventsOf(order('SO-T4'), now, [created('SO-T4'), zeroed, repaired]).events;
    expect(withRepair).toHaveLength(1);
    expect(withRepair[0]).toMatchObject({ day: '2026-09-10', ds: 0, dc: 0 });
    expect(rowOf(withRepair[0])).toBeNull();
    /* With no put-back the same day reads as the selling drop it was. */
    const stillZero = [line('L1', 'SO-T4', 'CODY-(K)', 1, 0, 120_000, { h: '28' })];
    const unrepaired = eventsOf(order('SO-T4'), stillZero, [created('SO-T4'), zeroed]).events;
    expect(rowOf(unrepaired[0])).toMatchObject({ bucket: 'SELLING', selling_before_sen: 300_000, selling_after_sen: 0, change_types: ['height'] });
  });

  test('a write the log cannot place leaves the steps before it out', () => {
    const { events, problems } = eventsOf(order('SO-T5'), [line('L1', 'SO-T5', 'CODY-(Q)', 1, 260_000, 104_000)], [
      created('SO-T5'),
      log('SO-T5', 'UPDATE_LINE', '2026-09-05T03:00:00.000000+00:00', [{ field: 'itemCode', from: 'CODY-(K)', to: 'CODY-(Q)' }, { field: 'unitPriceSen', from: 300_000, to: 260_000 }]),
      log('SO-T5', 'UPDATE_LINE', '2026-09-08T03:00:00.000000+00:00', [{ field: 'itemCode', to: 'NOT-ON-THE-ORDER' }, { field: 'qty', from: 1, to: 2 }]),
    ]);
    expect(problems).toHaveLength(1);
    expect(events.map((e) => [e.day, e.judge])).toEqual([['2026-09-05', false]]);
    expect(rowOf(events[0])).toBeNull();
  });

  test("a line with no cost stamped takes its product's cost that day, marked estimated", () => {
    const { events } = eventsOf(order('SO-T6'), [line('L1', 'SO-T6', 'SIDE-TABLE', 1, 50_000, 0, { g: 'others' })], [
      created('SO-T6'),
      log('SO-T6', 'ADD_LINE', '2026-09-20T03:00:00.000000+00:00', [{ field: 'itemCode', to: 'SIDE-TABLE' }, { field: 'totalSen', to: 50_000 }]),
    ]);
    expect(events[0]).toMatchObject({ flags: ['zero_cost_after_estimated'] });
    expect(rowOf(events[0])).toMatchObject({ change_types: ['new_line'], bucket: 'SELLING', selling_after_sen: 50_000, cost_after_sen: 8_000, cost_estimated: true });
  });
});

describe('the rows the backfill writes', () => {
  const history = (live: Row[]) => ({
    orders: [order('HC-SO-000777', { ac: 'SO-000777' }), order('SO-T1', { ac: 'SO-T1' })],
    lines: [line('L7', 'HC-SO-000777', 'CODY-(Q)', 1, 260_000, 104_000), line('L1', 'SO-T1', 'CODY-(Q)', 1, 260_000, 104_000)],
    audit: ['HC-SO-000777', 'SO-T1'].flatMap((d) => [
      created(d),
      log(d, 'UPDATE_LINE', '2026-09-05T03:00:00.000000+00:00', [{ field: 'itemCode', from: 'CODY-(K)', to: 'CODY-(Q)' }, { field: 'unitPriceSen', from: 300_000, to: 260_000 }]),
    ]),
    revisions: [], amendments: [],
    products: [{ company_id: 1, code: 'CODY-(Q)', category: 'BEDFRAME', base_price_sen: 104_000, cost_price_sen: 0, seat_height_prices: [] }],
    history: [], staff: [], live,
  });

  test('every change from the first day asked, imported orders marked, the company on each row', () => {
    const { rows, left } = rebuildRecordRows(history([]), '2026-09-01');
    expect(rows.map((r: Row) => [r.so_doc_no, r.company_id, r.imported, r.route, r.window_key])).toEqual([
      ['HC-SO-000777', 1, true, 'DIRECT', '2026-09-05'],
      ['SO-T1', 1, false, 'DIRECT', '2026-09-05'],
    ]);
    expect(left).toMatchObject({ notJudged: 0, live: 0 });
    expect(rebuildRecordRows(history([]), '2026-09-06').rows).toEqual([]);
  });

  test('a window the live record already holds is left to it', () => {
    const { rows, left } = rebuildRecordRows(history([{ company_id: 1, so_doc_no: 'SO-T1', route: 'DIRECT', window_key: '2026-09-05' }]), '2026-09-01');
    expect(rows.map((r: Row) => r.so_doc_no)).toEqual(['HC-SO-000777']);
    expect(left.live).toBe(1);
  });
});
