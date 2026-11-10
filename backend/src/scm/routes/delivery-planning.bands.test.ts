// GET /delivery-planning in date bands (owner 2026-11-10), counts_only, and a
// driver's board built from their own jobs only. Accuracy is the owner's top
// concern, so every assertion compares against the board AS IT WAS:
//
// __fixtures__/dp-board-before.json is the response of the pre-change handler
// (origin/main 417001a0a, with its own delivery-planning-board-reads.ts) on the
// fixture in delivery-planning.bands.fixture.ts, clock fixed at 2026-11-10. It was
// produced by importing that handler from a temporary copy and calling runBoard()
// for each key; it is data, not a guess. Regenerate it the same way whenever the
// fixture changes. Regenerated 2026-11-10 with the current handler for the
// Overdue-from-the-delivery-day rule: SO-OPEN-2 (due in 2 days) is now
// PENDING_DELIVERY, nothing else moved.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import before from './__fixtures__/dp-board-before.json';
import { deliveryPlanningBoardHandler } from './delivery-planning';
import { FIXED_NOW, runBoard, type Caller } from './delivery-planning.bands.fixture';
import { bandHeaderOr, bandOf, parseBand } from '../lib/delivery-board-window';

type Order = { so_doc_no: string; row_type: string; delivery_state: string } & Record<string, unknown>;
type Body = { orders: Order[]; counts: Record<string, number>; band?: { page_count: number }; counts_by_region?: Record<string, Record<string, number>> } & Record<string, unknown>;
const old = before as unknown as Record<string, Body>;

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(FIXED_NOW); });
afterAll(() => { vi.useRealTimers(); });

const board = async (qs: string, caller: Caller = 'office') => {
  const r = await runBoard(deliveryPlanningBoardHandler, caller, qs);
  expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
  return r.body as Body;
};

/** Bands 1-5, every page, in load order. */
async function allBands(qs: string, caller: Caller = 'office'): Promise<Order[][]> {
  const out: Order[][] = [];
  for (let band = 1; band <= 5; band += 1) {
    const rows: Order[] = [];
    for (let page = 0, pages = 1; page < pages; page += 1) {
      const r = await board(`?band=${band}&page=${page}${qs}`, caller);
      rows.push(...r.orders);
      pages = r.band?.page_count ?? 0;
    }
    out.push(rows);
  }
  return out;
}
const byKey = (rows: Order[]) => Object.fromEntries(rows.map((o) => [`${o.row_type}:${o.so_doc_no}`, o]));

describe('no band = the whole board, as before', () => {
  it('dispatcher ALL, OPEN and a region are byte-identical', async () => {
    expect(await board('')).toEqual(old.office_all);
    expect(await board('?state=OPEN')).toEqual(old.office_open);
    expect(await board('?region=KL')).toEqual(old.office_kl);
  });
  it('driver board (own jobs picked before the per-order reads) is byte-identical', async () => {
    expect(await board('?region=ALL&state=ALL', 'driver')).toEqual(old.driver_all);
    expect(await board('?state=OPEN', 'driver')).toEqual(old.driver_open);
  });
});

describe('date bands', () => {
  it('each row lands in its band by effective date, both sides of today', async () => {
    const bands = await allBands('');
    expect(bands.map((rows) => rows.map((o) => o.so_doc_no).sort())).toEqual([
      ['ASSR-001#delivery', 'DP:5', 'PRJ:10#SETUP', 'SO-AMEND-NEAR', 'SO-DEL-RECENT', 'SO-EDGE-15', 'SO-OPEN-1', 'SO-OPEN-2'],
      ['SO-DEL-15', 'SO-DEL-16', 'SO-EDGE-16F'],
      ['SO-DEL-45', 'SO-DEL-AMENDED'],
      ['SO-DEL-75'],
      ['PRJ:10#DISMANTLE', 'SO-DEL-LATE', 'SO-DEL-NODO', 'SO-DEL-OLD', 'SO-FAR', 'SO-NODATE', 'SO-OPEN-OLD'],
    ]);
  });

  it('bands 1-5 together are exactly the old full board (state=ALL)', async () => {
    const union = (await allBands('')).flat();
    expect(union).toHaveLength(old.office_all!.orders.length);
    expect(byKey(union)).toEqual(byKey(old.office_all!.orders));
  });

  it('bands 1-5 with state=OPEN are exactly the old OPEN board', async () => {
    const union = (await allBands('&state=OPEN')).flat();
    expect(byKey(union)).toEqual(byKey(old.office_open!.orders));
  });

  it('a driver\'s bands together are exactly their old board', async () => {
    const union = (await allBands('', 'driver')).flat();
    expect(byKey(union)).toEqual(byKey(old.driver_all!.orders));
  });

  it('band 1 filters in the header query: no full SO scan', () => {
    expect(bandHeaderOr(1, '2026-11-10')).toBe(
      'and(amended_delivery_date.gte.2026-10-26,amended_delivery_date.lte.2026-11-25),and(amended_delivery_date.is.null,customer_delivery_date.gte.2026-10-26,customer_delivery_date.lte.2026-11-25)',
    );
  });

  it('a page past the end has no rows, and sub-board rows ride page 0 only', async () => {
    const r = await board('?band=1&page=1');
    expect(r.orders).toEqual([]);
  });

  it('band edges', () => {
    expect(bandOf('2026-10-26', '2026-11-10')).toBe(1);
    expect(bandOf('2026-11-25', '2026-11-10')).toBe(1);
    expect(bandOf('2026-11-26', '2026-11-10')).toBe(2);
    expect(bandOf('2026-10-25', '2026-11-10')).toBe(2);
    expect(bandOf('2026-08-12', '2026-11-10')).toBe(4); // 90 days
    expect(bandOf('2026-08-11', '2026-11-10')).toBe(5); // 91 days
    expect(bandOf(null, '2026-11-10')).toBe(5);
  });
});

describe('counts_only', () => {
  it('gives the old tab counts for every region, before any rows load', async () => {
    const r = await board('?counts_only=1');
    expect(r.orders).toBeUndefined();
    expect(r.counts_by_region?.ALL).toEqual(old.office_all!.counts);
    expect(r.counts_by_region?.KL).toEqual(old.office_kl!.counts);
  });
});

describe('parameters', () => {
  it('band needs 1-5 and a page', async () => {
    for (const qs of ['?band=1', '?page=0', '?band=6&page=0', '?band=x&page=0']) {
      expect((await runBoard(deliveryPlanningBoardHandler, 'office', qs)).status, qs).toBe(400);
    }
    expect(parseBand(undefined, undefined)).toBeNull();
  });
});
