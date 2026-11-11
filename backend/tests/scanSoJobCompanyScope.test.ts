/* GET /scan-so/jobs/:id polled one scan job by id alone, while the /jobs list
   beside it was company-scoped. A job id from the other company answered with
   that company's salesperson, SO number and photo keys. It now answers 404. */
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const holder = vi.hoisted(() => ({ sb: null as unknown }));

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));
vi.mock('../src/db/supabase', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSupabaseService: () => holder.sb,
}));

import { fakeSb } from '../src/scm/lib/fake-postgrest';
import { scanSo } from '../src/scm/routes/scan-so';

const CO_A = 1;
const CO_B = 2;

function harness() {
  holder.sb = fakeSb({
    scan_jobs: [
      { id: 'job-a', company_id: CO_A, status: 'done', salesperson: 'Rep A', so_doc_no: 'HC-SO-1', document_type: 'SO', image_keys: [], retry_count: 0, updated_at: new Date().toISOString(), created_at: new Date().toISOString() },
      { id: 'job-b', company_id: CO_B, status: 'done', salesperson: 'Rep B', so_doc_no: '2990-SO-9', document_type: 'SO', image_keys: ['secret/key.jpg'], retry_count: 0, updated_at: new Date().toISOString(), created_at: new Date().toISOString() },
    ],
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('companyId' as never, CO_A as never);
    c.set('allowedCompanyIds' as never, [CO_A] as never);
    c.set('houzsUser' as never, { id: 7, permissions: ['*'], permissions_set: new Set(['*']) } as never);
    c.set('user' as never, { id: 'u-1', user_metadata: { name: 'Rep A' } } as never);
    await next();
  });
  app.route('/scan-so', scanSo as unknown as Hono);
  return app;
}

describe('scan job poll is company-scoped', () => {
  test('company A asking for company B\'s job id gets 404 and no data', async () => {
    const res = await harness().request('/scan-so/jobs/job-b', {}, {});
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain('2990-SO-9');
    expect(text).not.toContain('Rep B');
  });

  test('its own job still answers', async () => {
    const res = await harness().request('/scan-so/jobs/job-a', {}, {});
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('HC-SO-1');
  });
});
