// A company with no active showroom must still be able to upload a POD photo or
// a payment slip (/slips/init used to answer 400 no_active_showroom), and the
// receipt scan must say why it did not keep the slip instead of a bare null.
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';

type Row = Record<string, any>;

function fakeDb(opts: { showroom: Row | null; insertError?: string }) {
  const rows: Record<string, Row[]> = {};
  const from = (table: string) => {
    let ins: Row | null = null;
    const q: any = new Proxy({}, {
      get(_t, k) {
        if (k === 'insert') return (p: Row | Row[]) => {
          ins = Array.isArray(p) ? p[0]! : p;
          (rows[table] ||= []).push(ins);
          if (table === 'pending_slip_uploads' && opts.insertError) {
            return Promise.resolve({ data: null, error: { message: opts.insertError } });
          }
          return q;
        };
        if (k === 'single' || k === 'maybeSingle') return async () => ({
          data: table === 'showrooms' ? opts.showroom : (ins ? { id: 'row-1', ...ins } : null),
          error: null,
        });
        if (k === 'then') return (res: any, rej: any) => Promise.resolve({ data: ins ? [ins] : [], error: null }).then(res, rej);
        return () => q;
      },
    });
    return q;
  };
  return { sb: { from, rpc: async () => ({ data: null, error: null }), schema() { return this; } }, rows };
}

let db = fakeDb({ showroom: null });

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));
vi.mock('../src/db/supabase', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSupabaseService: () => db.sb,
}));

import { slips } from '../src/scm/routes/slips';
import { scanPayment } from '../src/scm/routes/scan-payment';

const CO = 3;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function bucket() {
  const puts: string[] = [];
  return { puts, SLIPS: { put: async (k: string) => { puts.push(k); }, delete: async () => {}, head: async () => null } };
}

function mount(route: string, router: any) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, db.sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'staff-1', user_metadata: {} } as never);
    c.set('houzsUser' as never, { id: 9, permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.route(route, router);
  return app;
}

const initBody = JSON.stringify({ fileSize: 8, contentType: 'image/jpeg', contentHash: 'ab'.repeat(32), purpose: 'field_photo' });

afterEach(() => { vi.unstubAllGlobals(); db = fakeDb({ showroom: null }); });

describe('/slips/init without an active showroom', () => {
  test('opens the upload session with no showroom instead of refusing', async () => {
    const { SLIPS } = bucket();
    const res = await mount('/slips', slips).request('/slips/init',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: initBody }, { SLIPS });
    expect(res.status).toBe(200);
    const json = await res.json() as { uploadSessionId?: string; error?: string };
    expect(json.error).toBeUndefined();
    expect(json.uploadSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.rows.pending_slip_uploads).toEqual([
      expect.objectContaining({ company_id: CO, showroom_id: null, status: 'pending' }),
    ]);
  });

  test('still stamps the showroom when the company has one', async () => {
    db = fakeDb({ showroom: { id: 'room-1' } });
    const { SLIPS } = bucket();
    const res = await mount('/slips', slips).request('/slips/init',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: initBody }, { SLIPS });
    expect(res.status).toBe(200);
    expect(db.rows.pending_slip_uploads![0]).toMatchObject({ company_id: CO, showroom_id: 'room-1' });
  });
});

describe('/scan-payment/extract keeps or explains the receipt slip', () => {
  const model = () => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify({ amountRm: 10, approvalCode: null, paidAt: null }) }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })));

  const scan = (env: Record<string, unknown>) => {
    const fd = new FormData();
    fd.append('file', new File([JPEG], 'slip.jpg', { type: 'image/jpeg' }));
    return mount('/scan-payment', scanPayment).request('/scan-payment/extract',
      { method: 'POST', body: fd }, { ANTHROPIC_API_KEY: 'k', SO_ITEM_PHOTOS: bucket().SLIPS, ...env });
  };

  test('no showroom: the slip is kept, with no showroom', async () => {
    model();
    const { SLIPS, puts } = bucket();
    const res = await scan({ SLIPS });
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { uploadSessionId: string | null; slipKey: string | null; slipError: string | null } };
    expect(json.data.slipError).toBeNull();
    expect(json.data.uploadSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(puts).toContain(json.data.slipKey);
    expect(db.rows.pending_slip_uploads).toEqual([
      expect.objectContaining({ company_id: CO, showroom_id: null, status: 'uploaded' }),
    ]);
  });

  test('a failed slip insert is named in slipError, not a bare null', async () => {
    model();
    db = fakeDb({ showroom: null, insertError: 'null value in column "showroom_id"' });
    const { SLIPS } = bucket();
    const res = await scan({ SLIPS });
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { uploadSessionId: string | null; slipError: string | null } };
    expect(json.data.uploadSessionId).toBeNull();
    expect(json.data.slipError).toBe('db_insert_failed');
  });

  test('no slip store bound: slipError says so', async () => {
    model();
    const res = await scan({});
    const json = await res.json() as { data: { slipError: string | null } };
    expect(json.data.slipError).toBe('r2_not_configured');
  });
});
