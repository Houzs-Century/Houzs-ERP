/* Staff report 2026-11-10 (Delivery Planning): "filled in the lorry and driver,
 * then it is missing in DP; fill in again, still missing" and "the DO is LOADED
 * but the Driver IC / contact do not fill, so we cannot blast the driver info".
 *
 * Symptom: on the shared board, rows of 2990 orders (2990-PO-...) showed the
 * picked lorry / driver for a moment, then "— none —" with no IC / contact;
 * the HC rows beside them kept theirs.
 * Cause: the crew cells save through PUT /delivery-orders-mfg/:id/crew, which
 * gated the DO on the ACTIVE company. A Houzs-active planner picking crew on a
 * 2990 DO got 404, the board showed no error, and the next poll put back the
 * empty crew. With no crew row the board has no IC / phone, so Driver Info
 * could not send. (Same class as HC-0180 on /fields.)
 * Fix: the gate is the caller's GRANTED companies (never wider), the fleet
 * masters stay shared, and these tests drive the real save then the real board
 * read: a company-2 order + a company-1 driver and lorry. */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

vi.mock('../middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));

const { deliveryOrdersMfg } = await import('./delivery-orders-mfg');
const { deliveryPlanningBoardHandler } = await import('./delivery-planning');

const HOUZS = 1;
const S2990 = 2;
const CALLER = { id: 'planner-uuid', email: 'p@houzs.test', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' } as unknown as User;

const so = (docNo: string, companyId: number): Row => ({
  doc_no: docNo, company_id: companyId, debtor_code: 'C1', debtor_name: 'A Customer',
  status: 'CONFIRMED', delivery_state: null, customer_state: 'Selangor', customer_country: 'Malaysia',
  customer_delivery_date: '2026-11-12', processing_date: '2026-11-10', local_total_sen: 100_000, balance_sen: 0,
});
const soLine = (docNo: string, id: string): Row => ({
  id, doc_no: docNo, item_code: 'SOFA-1', item_group: 'SOFA', qty: 1, cancelled: false,
  stock_status: 'READY', line_no: 1, created_at: '2026-11-01T00:00:00.000Z',
});
const dOrder = (id: string, soDocNo: string, companyId: number, createdAt: string, extra: Row = {}): Row => ({
  id, do_number: `DO-${id}`, so_doc_no: soDocNo, company_id: companyId, status: 'LOADED',
  driver_id: null, driver_name: null, vehicle: null, created_at: createdAt, ...extra,
});

function world(deliveryOrders: Row[], crew: Row[] = []) {
  return fakeSb({
    warehouses: [],
    mfg_sales_orders: [so('HC-SO-2611-001', HOUZS), so('2990-SO-2610-009', S2990)],
    mfg_sales_order_items: [soLine('HC-SO-2611-001', 'li-1'), soLine('2990-SO-2610-009', 'li-2')],
    delivery_order_items: [],
    delivery_orders: deliveryOrders,
    delivery_order_crew: crew,
    // The shared fleet: created under Houzs, used for both companies' orders.
    drivers: [{ id: 'drv-1', name: 'SHAMSUL', ic_number: '930428-10-5331', phone: '011-3192 8090', vehicle: null, company_id: HOUZS }],
    helpers: [],
    lorries: [{ id: 'lor-1', plate: 'VQE9058', company_id: HOUZS }],
    trip_stops: [],
    trips: [],
    entity_audit_log: [],
  });
}

function app(sb: ReturnType<typeof fakeSb>, allowed: number[]) {
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', HOUZS as Variables['companyId']); // switched to Houzs
    c.set('allowedCompanyIds', allowed as Variables['allowedCompanyIds']);
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('houzsUser', { id: 9, name: 'Planner', permissions_set: new Set(['*']), permissions: ['*'] } as unknown as Variables['houzsUser']);
    await next();
  });
  a.route('/delivery-orders-mfg', deliveryOrdersMfg);
  a.get('/delivery-planning', deliveryPlanningBoardHandler);
  return a;
}

const putCrew = (a: ReturnType<typeof app>, doId: string, body: Record<string, unknown>) =>
  a.request(`/delivery-orders-mfg/${doId}/crew`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, {} as Env);

type Crew = { driver_1_name: string | null; driver_1_ic: string | null; driver_1_contact: string | null; lorry_plate: string | null; driver_1_typed?: boolean } | null;
const boardCrew = async (a: ReturnType<typeof app>, docNo: string): Promise<Crew> => {
  const res = await a.request('/delivery-planning', {}, {} as Env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { orders: Array<{ so_doc_no: string; crew: Crew }> };
  const row = body.orders.find((o) => o.so_doc_no === docNo);
  expect(row).toBeDefined();
  return row!.crew;
};

describe('Delivery Planning crew on a 2990 order, caller switched to Houzs', () => {
  it('saves the shared-fleet driver and lorry, and the board read keeps them with IC and contact', async () => {
    const sb = world([dOrder('do-2990', '2990-SO-2610-009', S2990, '2026-11-09T02:00:00Z')]);
    const a = app(sb, [HOUZS, S2990]);

    expect((await putCrew(a, 'do-2990', { driver1Id: 'drv-1' })).status).toBe(200);
    expect((await putCrew(a, 'do-2990', { lorryId: 'lor-1' })).status).toBe(200); // one seat at a time, as the board does

    const crew = await boardCrew(a, '2990-SO-2610-009');
    expect(crew).toMatchObject({
      driver_1_name: 'SHAMSUL',
      driver_1_ic: '930428-10-5331', // what the Driver Info blast prints
      driver_1_contact: '+601131928090',
      lorry_plate: 'VQE9058',
    });
    expect(crew?.driver_1_typed).toBeUndefined();
    // The crew row and the DO header carry the ORDER's company, not the planner's.
    expect(sb.tables.delivery_order_crew![0]!.company_id).toBe(S2990);
    expect(sb.tables.delivery_orders![0]!.driver_name).toBe('SHAMSUL');
  });

  it('still refuses a DO of a company the caller is not granted, and writes nothing', async () => {
    const sb = world([dOrder('do-2990', '2990-SO-2610-009', S2990, '2026-11-09T02:00:00Z')]);
    const res = await putCrew(app(sb, [HOUZS]), 'do-2990', { driver1Id: 'drv-1' });
    expect(res.status).toBe(404);
    expect(sb.tables.delivery_order_crew).toEqual([]);
    expect(sb.tables.delivery_orders![0]!.driver_name).toBeNull();
  });
});

describe('Delivery Planning crew follows the NEWEST delivery order', () => {
  it('shows the crew of the latest DO even when an older DO has the later-sorting id', async () => {
    const sb = world(
      [
        dOrder('do-zz-older', 'HC-SO-2611-001', HOUZS, '2026-11-01T02:00:00Z'),
        dOrder('do-aa-newer', 'HC-SO-2611-001', HOUZS, '2026-11-09T02:00:00Z'),
      ],
    );
    const a = app(sb, [HOUZS, S2990]);
    // The board's own crew cell writes the last DO it lists; the read must show that same DO.
    const res = await a.request('/delivery-planning', {}, {} as Env);
    const body = (await res.json()) as { orders: Array<{ so_doc_no: string; delivery_orders: Array<{ id: string }> }> };
    const dos = body.orders.find((o) => o.so_doc_no === 'HC-SO-2611-001')!.delivery_orders;
    expect(dos.map((d) => d.id)).toEqual(['do-zz-older', 'do-aa-newer']);

    expect((await putCrew(a, 'do-aa-newer', { driver1Id: 'drv-1' })).status).toBe(200);
    expect((await boardCrew(a, 'HC-SO-2611-001'))?.driver_1_ic).toBe('930428-10-5331');
  });
});

describe('A driver only typed on the DO form', () => {
  it('shows on the board flagged as not linked, with no IC to send', async () => {
    const sb = world([dOrder('do-typed', 'HC-SO-2611-001', HOUZS, '2026-11-09T02:00:00Z', { driver_name: 'ALI TYPED', vehicle: 'WXX 1' })]);
    const crew = await boardCrew(app(sb, [HOUZS, S2990]), 'HC-SO-2611-001');
    expect(crew).toMatchObject({ driver_1_name: 'ALI TYPED', driver_1_ic: null, driver_1_contact: null, lorry_plate: 'WXX 1', driver_1_typed: true });
  });
});
