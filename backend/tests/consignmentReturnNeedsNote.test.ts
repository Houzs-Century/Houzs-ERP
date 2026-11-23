/* Symptom: a consignment return could be keyed free-hand with no Consignment Note line (HC-CRN-2610-001). Its
     stock-back IN could not name the ship-out it undoes, so a ship-out that took nothing from the lots came back
     as a full lot, and nothing bounded the qty returned.
   Cause: the create and add-line routes accepted a line without a note-line id ("no note, no return" dropped).
   Fix: both refuse such a line with 409 note_link_required, like the Delivery Return's do_link_required.
   Drives the real handlers through a bare Hono app on the fake PostgREST. */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { fakeSb } from '../src/scm/lib/fake-postgrest';
import { addConsignmentReturnItemHandler, createConsignmentReturnHandler } from '../src/scm/routes/consignment-returns';

function appWith(sb: ReturnType<typeof fakeSb>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, 1 as never);
    c.set('user' as never, { id: 'u-1' } as never);
    await next();
  });
  app.post('/', createConsignmentReturnHandler);
  app.post('/:id/items', addConsignmentReturnItemHandler);
  return app;
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('a consignment return line must come from a Consignment Note line', () => {
  it('create: a free-entry line is refused and nothing is written', async () => {
    const sb = fakeSb({ consignment_delivery_returns: [], consignment_delivery_return_items: [], inventory_movements: [] });
    const res = await post(appWith(sb), '/', {
      debtorName: 'Showroom A',
      items: [{ itemCode: 'DIVAN ONLY-(K)', qtyReturned: 1 }],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'note_link_required', lines: [{ itemCode: 'DIVAN ONLY-(K)' }] });
    expect(sb.tables.consignment_delivery_returns).toEqual([]);
    expect(sb.tables.consignment_delivery_return_items).toEqual([]);
    expect(sb.tables.inventory_movements).toEqual([]);
  });

  it('create: one linked line does not let a free line through', async () => {
    const sb = fakeSb({ consignment_delivery_returns: [], consignment_delivery_return_items: [] });
    const res = await post(appWith(sb), '/', {
      debtorName: 'Showroom A',
      items: [{ itemCode: 'A', qtyReturned: 1, consignmentDoItemId: 'ni-1' }, { itemCode: 'B', qtyReturned: 1 }],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'note_link_required', lines: [{ itemCode: 'B' }] });
    expect(sb.tables.consignment_delivery_returns).toEqual([]);
  });

  it('add line: a free-entry line is refused and nothing is written', async () => {
    const sb = fakeSb({
      consignment_delivery_returns: [{ id: 'cr-1', company_id: 1, status: 'RECEIVED', return_number: 'CRN-1' }],
      consignment_delivery_return_items: [],
    });
    const res = await post(appWith(sb), '/cr-1/items', { itemCode: 'DIVAN ONLY-(K)', qtyReturned: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'note_link_required' });
    expect(sb.tables.consignment_delivery_return_items).toEqual([]);
  });
});
