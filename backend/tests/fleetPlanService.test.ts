/* A preventive-maintenance plan is the RULE; a done service is the RECORD
   (owner, 2026-10-15). Recording a service closes a work order with its cost and
   moves the plan's last-done forward — never backward. */
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { makeFakePostgrest, type Row } from './fakePostgrest';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));
vi.mock('../src/scm/lib/houzs-perms', () => ({
  requireHouzsPerm: () => async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

const { fleetPlanService } = await import('../src/scm/routes/fleet-plan-service');
const { COMPLIANCE_DOC_TYPES } = await import('../src/services/fleet-status');

function app(plan: Row) {
  const fake = makeFakePostgrest({ lorry_maintenance_plans: [plan], lorry_work_orders: [{ id: 'w0', wo_no: 'WO-0007', company_id: 1 }] }, []);
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, fake as never);
    c.set('companyId' as never, 1 as never);
    c.set('houzsUser' as never, { id: 5 } as never);
    await next();
  });
  a.route('/', fleetPlanService);
  return { a, tables: fake.tables };
}
const post = (a: Hono, body: unknown) => a.request('/plans/p1/service', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const PLAN = { id: 'p1', lorry_id: 'l1', component: 'ENGINE_OIL', last_done_date: '2026-04-01', last_done_km: 100000 };

describe('record a service against a plan', () => {
  test('closes a work order with the cost and moves last-done', async () => {
    const { a, tables } = app({ ...PLAN });
    const res = await post(a, { doneDate: '2026-10-10', odometerKm: 110250, costSen: 35000, workshop: 'Ah Seng' });
    expect(res.status).toBe(201);
    const wo = tables.lorry_work_orders!.find((w) => w.id !== 'w0')!;
    expect(wo).toMatchObject({ lorry_id: 'l1', status: 'COMPLETED', outside_service_sen: 35000, workshop: 'Ah Seng', wo_no: 'WO-0008', document_date: '2026-10-10' });
    expect(String(wo.problem)).toContain('Engine oil');
    expect(tables.lorry_maintenance_plans![0]).toMatchObject({ last_done_date: '2026-10-10', last_done_km: 110250 });
  });

  test('an older service is recorded but does not pull the plan backwards', async () => {
    const { a, tables } = app({ ...PLAN });
    expect((await post(a, { doneDate: '2026-01-05', odometerKm: 90000, costSen: 0 })).status).toBe(201);
    expect(tables.lorry_maintenance_plans![0]).toMatchObject({ last_done_date: '2026-04-01', last_done_km: 100000 });
  });

  test('the service date is required', async () => {
    const { a } = app({ ...PLAN });
    expect((await post(a, { odometerKm: 1 })).status).toBe(400);
  });
});

describe('compliance kinds', () => {
  test('an in-house lorry tracks road tax, insurance, PUSPAKOM and Geran — not APAD or cross-border', () => {
    expect([...COMPLIANCE_DOC_TYPES].sort()).toEqual(['GERAN', 'INSURANCE', 'PUSPAKOM', 'ROAD_TAX']);
  });
});
