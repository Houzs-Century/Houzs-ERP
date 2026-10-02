// One GRN line split over several racks (owner 2026-10-02). The draft holds the
// plan; the post refuses an incomplete one and places each share on its rack.
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { fakeSb, type Row } from './fake-postgrest';
import {
  getGrnItemRacksHandler,
  grnRackSplitPostRefusal,
  planGrnPlacements,
  putGrnItemRacksHandler,
  splitPostProblem,
} from './grn-line-racks';
import { setGrnLineRackHandler } from './grn-line-rack';
import { placeGrnLinesOnRacks } from './grn-rack-sync';

const line = (over: Partial<Row> = {}): Row => ({
  id: 'I1', grn_id: 'G1', company_id: 1, item_code: 'BED-Q', material_name: 'Queen bedframe',
  qty_accepted: 10, rack_id: null, ...over,
});

function world(grnStatus = 'DRAFT', extra: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    grns: [
      { id: 'G1', company_id: 1, grn_number: 'GR-1', status: grnStatus, warehouse_id: 'W1' },
      { id: 'G2', company_id: 2, grn_number: 'GR-2', status: 'DRAFT', warehouse_id: 'W9' },
    ],
    grn_items: [line()],
    grn_item_racks: [],
    warehouse_racks: [
      { id: 'R1', company_id: 1, rack: 'L3.1', warehouse_id: 'W1', reserved: false },
      { id: 'R2', company_id: 1, rack: 'L3.2', warehouse_id: 'W1', reserved: false },
      { id: 'RX', company_id: 1, rack: 'K1.1', warehouse_id: 'W2', reserved: false },
    ],
    warehouse_rack_items: [],
    warehouse_rack_movements: [],
    entity_audit_log: [],
    ...extra,
  };
  const sb = fakeSb(tables);
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('companyId', 1);
    c.set('supabase', sb as never);
    c.set('houzsUser', { id: 5 } as never);
    c.set('user', { id: 'staff-1' } as never);
    await next();
  });
  app.get('/:id/racks', getGrnItemRacksHandler);
  app.put('/:id/items/:itemId/racks', putGrnItemRacksHandler);
  app.patch('/:id/items/:itemId/rack', setGrnLineRackHandler);
  const put = (racks: unknown, grn = 'G1', item = 'I1') => app.request(`/${grn}/items/${item}/racks`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ racks }),
  });
  const patch = (rackId: string | null) => app.request('/G1/items/I1/rack', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rackId }),
  });
  return { tables, sb, app, put, patch };
}

describe('planGrnPlacements', () => {
  it('places each share of a split line, and a one-rack line whole', () => {
    const lines = [line(), line({ id: 'I2', item_code: 'MAT', rack_id: 'R9', qty_accepted: 3 }), line({ id: 'I3', qty_accepted: 0, rack_id: 'R9' })];
    const rows = [{ grn_item_id: 'I1', rack_id: 'R1', qty: 6 }, { grn_item_id: 'I1', rack_id: 'R2', qty: 4 }];
    expect(planGrnPlacements(lines as never, rows)).toEqual([
      { rack_id: 'R1', item_code: 'BED-Q', material_name: 'Queen bedframe', qty: 6 },
      { rack_id: 'R2', item_code: 'BED-Q', material_name: 'Queen bedframe', qty: 4 },
      { rack_id: 'R9', item_code: 'MAT', material_name: 'Queen bedframe', qty: 3 },
    ]);
  });

  it('names the line whose split does not account for every accepted unit', () => {
    expect(splitPostProblem([line()] as never, [{ grn_item_id: 'I1', rack_id: 'R1', qty: 6 }]))
      .toBe('BED-Q: The racks hold 6 of the 10 accepted. Fix its racks before posting.');
    expect(splitPostProblem([line()] as never, [])).toBeNull();
  });
});

describe('PUT /grns/:id/items/:itemId/racks', () => {
  it('saves a split on a draft and clears the single rack it no longer has', async () => {
    const w = world();
    w.tables.grn_items[0].rack_id = 'R1';
    const res = await w.put([{ rackId: 'R1', qty: 6 }, { rackId: 'R2', qty: 4 }]);
    expect(res.status).toBe(200);
    expect(w.tables.grn_item_racks.map((r) => [r.rack_id, r.qty, r.company_id])).toEqual([['R1', 6, 1], ['R2', 4, 1]]);
    expect(w.tables.grn_items[0].rack_id).toBeNull();
    const read = await w.app.request('/G1/racks');
    expect(((await read.json()) as { racks: unknown[] }).racks).toEqual([
      { grnItemId: 'I1', rackId: 'R1', qty: 6 }, { grnItemId: 'I1', rackId: 'R2', qty: 4 },
    ]);
  });

  it('keeps rack_id as the one rack when the split uses one, and lets a partial split be saved', async () => {
    const w = world();
    expect((await w.put([{ rackId: 'R2', qty: 4 }])).status).toBe(200);
    expect(w.tables.grn_items[0].rack_id).toBe('R2');
  });

  it('replaces, never appends', async () => {
    const w = world();
    await w.put([{ rackId: 'R1', qty: 6 }, { rackId: 'R2', qty: 4 }]);
    await w.put([{ rackId: 'R2', qty: 10 }]);
    expect(w.tables.grn_item_racks.map((r) => [r.rack_id, r.qty])).toEqual([['R2', 10]]);
  });

  it('refuses more than was accepted, a rack of another warehouse, and a posted GRN', async () => {
    const over = world();
    const r1 = await over.put([{ rackId: 'R1', qty: 8 }, { rackId: 'R2', qty: 4 }]);
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as { message: string }).message).toBe('The racks hold 12 but only 10 were accepted.');

    const wrong = world();
    const r2 = await wrong.put([{ rackId: 'RX', qty: 1 }]);
    expect(r2.status).toBe(400);
    expect(wrong.tables.grn_item_racks).toEqual([]);

    const posted = world('POSTED');
    const r3 = await posted.put([{ rackId: 'R1', qty: 10 }]);
    expect(r3.status).toBe(409);
    expect(((await r3.json()) as { error: string }).error).toBe('grn_not_draft');
  });

  it("answers 404 for another company's GRN", async () => {
    const w = world();
    expect((await w.put([], 'G2')).status).toBe(404);
  });
});

describe('posting a GRN with a split line', () => {
  it('refuses while the split is short, and places each share once it adds up', async () => {
    const w = world();
    await w.put([{ rackId: 'R1', qty: 6 }]);
    const short = await grnRackSplitPostRefusal(w.sb, 'G1', 1);
    expect(short?.status).toBe(409);
    expect(short?.body.error).toBe('rack_split_incomplete');

    await w.put([{ rackId: 'R1', qty: 6 }, { rackId: 'R2', qty: 4 }]);
    expect(await grnRackSplitPostRefusal(w.sb, 'G1', 1)).toBeNull();

    await placeGrnLinesOnRacks(w.sb, 'G1', 'GR-1', 'staff-1');
    expect(w.tables.warehouse_rack_items.map((r) => [r.rack_id, r.qty, r.source_grn_id])).toEqual([['R1', 6, 'G1'], ['R2', 4, 'G1']]);
    expect(w.tables.warehouse_rack_movements.map((m) => [m.movement_type, m.rack_label, m.quantity])).toEqual([
      ['STOCK_IN', 'L3.1', 6], ['STOCK_IN', 'L3.2', 4],
    ]);
  });
});

describe('the one-rack picker beside a split', () => {
  it('on a draft, one rack picked replaces the split', async () => {
    const w = world();
    await w.put([{ rackId: 'R1', qty: 6 }, { rackId: 'R2', qty: 4 }]);
    expect((await w.patch('R2')).status).toBe(200);
    expect(w.tables.grn_item_racks).toEqual([]);
    expect(w.tables.grn_items[0].rack_id).toBe('R2');
  });

  it('on a draft, clearing the rack clears the split too', async () => {
    const w = world();
    await w.put([{ rackId: 'R1', qty: 6 }, { rackId: 'R2', qty: 4 }]);
    expect((await w.patch(null)).status).toBe(200);
    expect(w.tables.grn_item_racks).toEqual([]);
  });

  it('once posted, a split line is moved on the rack board, not here', async () => {
    const w = world('POSTED', {
      grn_item_racks: [
        { id: 'S1', company_id: 1, grn_item_id: 'I1', rack_id: 'R1', qty: 6 },
        { id: 'S2', company_id: 1, grn_item_id: 'I1', rack_id: 'R2', qty: 4 },
      ],
    });
    const res = await w.patch('R2');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('rack_split_posted');
  });
});
