// HC-0006 T6: every scan route keeps the original file + one scm.scan_files row
// BEFORE the model read, so a read that throws still leaves both. The model call
// is a global fetch that throws; the SO scanner's read runs later in the queue,
// so its enqueue is checked for the row with no model call at all.
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';

type Row = Record<string, any>;

/* Any chain works; insert() records, single()/maybeSingle() echo the insert. */
function fakeDb() {
  const rows: Record<string, Row[]> = {};
  const from = (table: string) => {
    let ins: Row | null = null;
    const q: any = new Proxy({}, {
      get(_t, k) {
        if (k === 'insert') return (p: Row | Row[]) => { ins = Array.isArray(p) ? p[0]! : p; (rows[table] ||= []).push(ins); return q; };
        if (k === 'single' || k === 'maybeSingle') return async () => ({ data: ins ? { id: 'job-1', ...ins } : null, error: null });
        if (k === 'then') return (res: any, rej: any) => Promise.resolve({ data: ins ? [ins] : [], error: null }).then(res, rej);
        return () => q;
      },
    });
    return q;
  };
  return { sb: { from, rpc: async () => ({ data: null, error: null }), schema() { return this; } }, rows };
}

let db = fakeDb();

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));
vi.mock('../src/db/supabase', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSupabaseService: () => db.sb,
}));

import { keepScanFile } from '../src/scm/lib/scan-files';
import { scanSo } from '../src/scm/routes/scan-so';
import { scanPayment } from '../src/scm/routes/scan-payment';
import { scanLorryInvoice } from '../src/scm/routes/scan-lorry-invoice';
import { extractBillsHandler } from '../src/scm/routes/pv-extract';

const CO = 1;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function fakeBucket() {
  const puts: string[] = [];
  return { puts, bucket: { put: async (k: string) => { puts.push(k); } } };
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

function form() {
  const fd = new FormData();
  fd.append('file', new File([JPEG], 'slip.jpg', { type: 'image/jpeg' }));
  return fd;
}

afterEach(() => { vi.unstubAllGlobals(); db = fakeDb(); });

describe('keepScanFile', () => {
  test('puts the bytes and writes one row carrying company_id, kind, sha and size', async () => {
    const { bucket, puts } = fakeBucket();
    const key = await keepScanFile({ SO_ITEM_PHOTOS: bucket }, db.sb, {
      kind: 'pv', companyId: CO, buf: JPEG.buffer, mime: 'image/jpeg', uploadedBy: 'staff-1', key: null,
    });
    expect(key).toMatch(/^scan-files\/pv\//);
    expect(puts).toEqual([key]);
    expect(db.rows.scan_files).toHaveLength(1);
    expect(db.rows.scan_files![0]).toMatchObject({
      company_id: CO, kind: 'pv', storage_key: key, mime: 'image/jpeg', size_bytes: JPEG.byteLength, uploaded_by: 'staff-1',
    });
    expect(db.rows.scan_files![0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  test('no file store: logs, returns null, writes no row, does not throw', async () => {
    const key = await keepScanFile({}, db.sb, { kind: 'pv', companyId: CO, buf: JPEG.buffer, mime: 'image/jpeg', uploadedBy: null, key: null });
    expect(key).toBeNull();
    expect(db.rows.scan_files).toBeUndefined();
  });
  test('a failed put writes no row pointing at nothing', async () => {
    const bucket = { put: async () => { throw new Error('r2 down'); } };
    expect(await keepScanFile({ SO_ITEM_PHOTOS: bucket }, db.sb, { kind: 'so', companyId: CO, buf: JPEG.buffer, mime: 'image/jpeg', uploadedBy: null, key: 'k' })).toBeNull();
    expect(db.rows.scan_files).toBeUndefined();
  });
});

describe('each scan route leaves the file + row when the model read throws', () => {
  const throwingModel = () => vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('model down'); }));

  test('payment receipt', async () => {
    throwingModel();
    const { bucket, puts } = fakeBucket();
    const res = await mount('/scan-payment', scanPayment).request('/scan-payment/extract',
      { method: 'POST', body: form() }, { ANTHROPIC_API_KEY: 'k', SO_ITEM_PHOTOS: bucket });
    expect(res.status).toBe(502);
    expect(puts).toHaveLength(1);
    expect(db.rows.scan_files).toEqual([expect.objectContaining({ kind: 'payment', company_id: CO, storage_key: puts[0] })]);
  });

  test('workshop invoice', async () => {
    throwingModel();
    const { bucket, puts } = fakeBucket();
    const res = await mount('/scan-lorry-invoice', scanLorryInvoice).request('/scan-lorry-invoice/extract',
      { method: 'POST', body: form() }, { ANTHROPIC_API_KEY: 'k', SO_ITEM_PHOTOS: bucket });
    expect(res.status).toBe(502);
    expect(db.rows.scan_files).toEqual([expect.objectContaining({ kind: 'workshop', company_id: CO, storage_key: puts[0] })]);
  });

  test('supplier bill (PV)', async () => {
    throwingModel();
    const { bucket, puts } = fakeBucket();
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('supabase' as never, db.sb as never);
      c.set('companyId' as never, CO as never);
      c.set('user' as never, { id: 'staff-1' } as never);
      c.set('houzsUser' as never, { id: 9, permissions_set: new Set(['*']) } as never);
      await next();
    });
    app.post('/extract', extractBillsHandler as never);
    const b64 = btoa(String.fromCharCode(...JPEG));
    await app.request('/extract', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bills: [{ files: [{ name: 'bill.jpg', mime: 'image/jpeg', dataBase64: b64 }] }] }),
    }, { ANTHROPIC_API_KEY: 'k', SO_ITEM_PHOTOS: bucket });
    expect(puts).toHaveLength(1);
    expect(db.rows.scan_files).toEqual([expect.objectContaining({ kind: 'pv', company_id: CO, size_bytes: JPEG.byteLength })]);
  });

  test('sales slip (SO enqueue): row for the scan-jobs copy, no extra copy', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('model down'); });
    vi.stubGlobal('fetch', fetchSpy);
    const { bucket, puts } = fakeBucket();
    const res = await mount('/scan-so', scanSo).request('/scan-so/enqueue',
      { method: 'POST', body: form() },
      { ANTHROPIC_API_KEY: 'k', SO_ITEM_PHOTOS: bucket, SCAN_QUEUE: { send: async () => {} } });
    expect(res.status).toBe(202);
    expect(puts).toEqual(['scan-jobs/job-1/0']);
    expect(db.rows.scan_files).toEqual([expect.objectContaining({ kind: 'so', company_id: CO, storage_key: 'scan-jobs/job-1/0' })]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
