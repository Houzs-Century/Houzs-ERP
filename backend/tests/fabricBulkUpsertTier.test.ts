// POST /fabric-tracking/bulk-upsert refuses a bad tier PER ROW (BUG-88).
//
// sofa_price_tier / bedframe_price_tier are a Postgres enum. The handler wrote
// whatever string arrived, so one "Price 2" (the table export's spelling) made
// the single batch upsert fail and the whole import came back 500. The good rows
// must land and the bad one must come back in `errors`, like every other
// per-row rejection here. Harness as fabricCodePerCompany.test.ts.
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { fabricTracking } from '../src/scm/routes/fabric-tracking';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';

type Row = Record<string, any>;

function harness() {
  const tables: Record<string, Row[]> = {};
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => ({
        upsert: (rows: Row[]) => {
          (tables[t] ||= []).push(...rows);
          return Promise.resolve({ error: null });
        },
      }),
    } as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('companyId' as never, 2 as never);
    c.set('allowedCompanyIds' as never, [2] as never);
    c.set('companyCode' as never, '2990' as never);
    await next();
  });
  app.route('/fabric-tracking', fabricTracking);
  return { app, tables };
}

test('a bad tier refuses its row only; the rest of the import lands', async () => {
  const h = harness();
  const res = await h.app.request(
    '/fabric-tracking/bulk-upsert',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rows: [
          { fabricCode: 'KN06', sofaPriceTier: 'PRICE_2', bedframePriceTier: 'PRICE_2' },
          { fabricCode: 'KN07', sofaPriceTier: 'Price 2' },
          { fabricCode: 'KN09', bedframePriceTier: 'PRICE_9' },
          { fabricCode: 'KN08', sofaPriceTier: null },
        ],
      }),
    },
    {} as never,
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    upserted: 2,
    errors: [
      { index: 1, reason: 'invalid_sofa_price_tier' },
      { index: 2, reason: 'invalid_bedframe_price_tier' },
    ],
  });
  expect(h.tables.fabric_trackings.map((r) => r.fabric_code)).toEqual(['KN06', 'KN08']);
});
