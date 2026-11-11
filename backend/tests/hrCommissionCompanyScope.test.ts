/* GET /hr/commission serves a CLOSED period from its frozen hr_payout_rows.
   The period is found under the active company, but the rows were then read
   by period_id alone — a parent predicate, not company scope. The rows carry
   their own company_id (mig 0125) and are now read by it, so a row stamped
   to another company never reaches this company's commission report. */
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { hr } from '../src/scm/routes/hr';

const CO_A = 1;
const CO_B = 2;

function payoutRow(companyId: number, staffName: string, sortIndex: number): Row {
  return {
    period_id: 'period-a', company_id: companyId, staff_id: `s-${staffName}`, staff_name: staffName,
    showroom_id: 'sr-1', showroom_name: 'Showroom', showroom_goods_sen: 0, showroom_kpi_hit: false,
    tier: 'sales', personal_goods_sen: 0, personal_rate_bps: 0, personal_commission_sen: 0,
    override_rate_bps: 0, override_commission_sen: 0, override_detail: null, item_kpi_sen: 0,
    kpi_detail: [], total_sen: 100, sort_index: sortIndex,
  };
}

function harness() {
  const sb = fakeSb({
    hr_payout_periods: [{
      id: 'period-a', company_id: CO_A, period_from: '2026-10-01', period_to: '2026-10-31', revision: 1,
      status: 'CLOSED', engine_version: 1, config_snapshot: {}, override_mode: 'none',
      override_levels_snapshot: [], total_sen: 100, row_count: 1,
    }],
    hr_payout_rows: [payoutRow(CO_A, 'Own Rep', 1), payoutRow(CO_B, 'Other Company Rep', 2)],
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO_A as never);
    c.set('allowedCompanyIds' as never, [CO_A] as never);
    c.set('houzsUser' as never, { id: 7, permissions: ['*'], permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.route('/hr', hr as unknown as Hono);
  return app;
}

describe('closed commission period reads only this company\'s frozen rows', () => {
  test('a row stamped to company B under company A\'s period is not returned', async () => {
    const res = await harness().request('/hr/commission?from=2026-10-01&to=2026-10-31', {}, {});
    expect(res.status).toBe(200);
    const body = await res.json() as { showrooms: Array<{ rows: Array<{ staffName: string }> }> };
    const names = body.showrooms.flatMap((s) => s.rows.map((r) => r.staffName));
    expect(names).toEqual(['Own Rep']);
    expect(JSON.stringify(body)).not.toContain('Other Company Rep');
  });
});
