/* The Last Mile order-drawer remarks thread route (/delivery-remarks, phase 3):
 * a thread per sales order, the /flags rollup for the board pill, and adding a
 * note with a snapshotted author. Keyed by so_doc_no (globally unique), so no
 * company column — same story as delivery_planning_row_marks. */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { fakeSb } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = fakeSb({
  delivery_remarks: [
    { id: 1, so_doc_no: 'HC-SO-A', body: 'call before arrival', author_id: '7', author_name: 'Aisha', created_at: '2026-11-01T01:00:00Z' },
    { id: 2, so_doc_no: 'HC-SO-A', body: 'gate code 1234', author_id: '7', author_name: 'Aisha', created_at: '2026-11-01T02:00:00Z' },
    { id: 3, so_doc_no: 'HC-SO-B', body: 'lift broken, use stairs', author_id: '9', author_name: 'Ben', created_at: '2026-11-01T03:00:00Z' },
  ],
});

vi.mock('../middleware/auth', () => ({ supabaseAuth: (_c: unknown, next: () => Promise<void>) => next() }));

const { deliveryRemarks } = await import('./delivery-remarks');

function app() {
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('houzsUser', { id: 42, name: 'Dispatcher', email: 'd@houzs.test' } as unknown as Variables['houzsUser']);
    await next();
  });
  a.route('/', deliveryRemarks);
  return a;
}

describe('/delivery-remarks', () => {
  it('GET /flags rolls up a count per order with a remark', async () => {
    const res = await app().request('/flags');
    expect(res.status).toBe(200);
    const body = await res.json() as { flags: Array<{ soDocNo: string; count: number }> };
    const byDoc = Object.fromEntries(body.flags.map((f) => [f.soDocNo, f.count]));
    expect(byDoc['HC-SO-A']).toBe(2);
    expect(byDoc['HC-SO-B']).toBe(1);
  });

  it('GET /?soDocNo returns just that order thread', async () => {
    const res = await app().request('/?soDocNo=HC-SO-A');
    expect(res.status).toBe(200);
    const body = await res.json() as { remarks: Array<{ soDocNo: string; body: string }> };
    expect(body.remarks).toHaveLength(2);
    expect(body.remarks.every((r) => r.soDocNo === 'HC-SO-A')).toBe(true);
  });

  it('GET / without soDocNo is a 400', async () => {
    const res = await app().request('/');
    expect(res.status).toBe(400);
  });

  it('POST / adds a note and snapshots the author', async () => {
    const res = await app().request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ soDocNo: 'HC-SO-C', body: 'leave at guardhouse' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { remark: { soDocNo: string; body: string; authorName: string | null } | null };
    expect(body.remark?.soDocNo).toBe('HC-SO-C');
    expect(body.remark?.body).toBe('leave at guardhouse');
    expect(body.remark?.authorName).toBe('Dispatcher');
  });

  it('POST / rejects an empty body', async () => {
    const res = await app().request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ soDocNo: 'HC-SO-C', body: '  ' }),
    });
    expect(res.status).toBe(400);
  });
});
