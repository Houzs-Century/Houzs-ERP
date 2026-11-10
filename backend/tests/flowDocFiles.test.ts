/* Files on the receiving and return documents (backlog A3, sister
   Conts-ERP#278): the Goods Received, Purchase Invoice, Delivery Return and
   Purchase Return each keep their paper and photos through the shared factory
   (lib/doc-files.ts). Pinned per document:
     - upload puts the bytes under <prefix>/<company>/<doc>/ with an index row
       on that document's own FK, attach order; list and stream read it back;
     - a document in another company is not found, for upload and list alike;
     - CANCELLED takes no more files;
     - a file can be removed until the document is FINISHED (closed / paid /
       refunded / completed) — not at posting, because a GRN and a purchase
       return are born posted.
   Same fake PostgREST + R2 as tests/apInvoiceFiles.test.ts. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { makeDocFileHandlers, type DocFilesSpec } from '../src/scm/lib/doc-files';
import {
  GRN_FILES, PURCHASE_INVOICE_FILES, DELIVERY_RETURN_FILES, PURCHASE_RETURN_FILES,
} from '../src/scm/routes/flow-doc-files';

type Row = Record<string, any>;
const CO = 1;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'insert' | 'delete' = 'select';
  private inserted: Row[] = [];
  constructor(private rows: Row[], private table: string) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  not(col: string, _op: 'is', _val: null) { this.preds.push((r) => r[col] !== null && r[col] !== undefined); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  private run(): Row[] {
    if (this.op === 'insert') {
      const withIds = this.inserted.map((r, i) => ({ id: r.id ?? `${this.table}-${this.rows.length + i + 1}`, ...r }));
      this.rows.push(...withIds);
      return withIds;
    }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

const fakeR2 = () => {
  const store = new Map<string, { bytes: ArrayBuffer; contentType: string }>();
  return {
    store,
    put: async (k: string, v: ArrayBuffer, o?: { httpMetadata?: { contentType?: string } }) => {
      store.set(k, { bytes: v, contentType: o?.httpMetadata?.contentType ?? '' });
    },
    get: async (k: string) => {
      const hit = store.get(k);
      if (!hit) return null;
      return { body: new Blob([hit.bytes]).stream(), httpMetadata: { contentType: hit.contentType } };
    },
    delete: async (k: string) => { store.delete(k); },
  };
};

function harness(spec: DocFilesSpec, tables: Record<string, Row[]>, r2 = fakeR2()) {
  const h = makeDocFileHandlers(spec);
  const app = new Hono<{ Bindings: { SLIPS: ReturnType<typeof fakeR2> } }>();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t),
      schema(_s: string) { return this; },
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions: ['*'], permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.post('/api/:id/files', (c) => h.upload(c));
  app.get('/api/:id/files', (c) => h.list(c));
  app.get('/api/:id/files/:fileId', (c) => h.stream(c));
  app.delete('/api/:id/files/:fileId', (c) => h.remove(c));
  return { app: { request: (path: string, init?: RequestInit) => app.request(path, init, { SLIPS: r2 } as never) }, r2 };
}

type App = { request: (p: string, i?: RequestInit) => Promise<Response> };
const upload = (app: App, id: string, name = 'damage.jpg', mime = 'image/jpeg') =>
  app.request(`/api/${id}/files`, {
    method: 'POST',
    body: JSON.stringify({ fileName: name, mime, dataBase64: btoa('JPEGBYTES') }),
    headers: { 'content-type': 'application/json' },
  });

const CASES: Array<{ name: string; spec: DocFilesSpec; docTable: string; prefix: string; open: string; finished: string }> = [
  { name: 'goods received', spec: GRN_FILES, docTable: 'grns', prefix: 'grn-files', open: 'POSTED', finished: 'CLOSED' },
  { name: 'purchase invoice', spec: PURCHASE_INVOICE_FILES, docTable: 'purchase_invoices', prefix: 'purchase-invoice-files', open: 'POSTED', finished: 'PAID' },
  { name: 'delivery return', spec: DELIVERY_RETURN_FILES, docTable: 'delivery_returns', prefix: 'delivery-return-files', open: 'RECEIVED', finished: 'REFUNDED' },
  { name: 'purchase return', spec: PURCHASE_RETURN_FILES, docTable: 'purchase_returns', prefix: 'purchase-return-files', open: 'POSTED', finished: 'COMPLETED' },
];

describe.each(CASES)('files on a $name', ({ spec, docTable, prefix, open, finished }) => {
  const seed = (status = open): Record<string, Row[]> => ({
    [docTable]: [{ id: 'doc-1', status, company_id: CO, salesperson_id: null }, { id: 'doc-other', status, company_id: 2, salesperson_id: null }],
    [spec.table]: [],
  });

  test('upload stores the bytes under its own prefix and an index row on its own FK; list and stream read it back', async () => {
    const tables = seed();
    const { app, r2 } = harness(spec, tables);
    expect((await upload(app, 'doc-1')).status).toBe(201);
    expect((await upload(app, 'doc-1', 'supplier-do.pdf', 'application/pdf')).status).toBe(201);
    expect(tables[spec.table]!.map((f) => [f[spec.fkColumn], f.sort_no, f.company_id])).toEqual([['doc-1', 1, CO], ['doc-1', 2, CO]]);
    expect([...r2.store.keys()].every((k) => k.startsWith(`${prefix}/${CO}/doc-1/`))).toBe(true);

    const list = await (await app.request('/api/doc-1/files')).json() as { files: Row[]; locked: boolean };
    expect(list.files.map((f) => f.file_name)).toEqual(['damage.jpg', 'supplier-do.pdf']);
    expect(list.locked).toBe(false);

    const streamed = await app.request(`/api/doc-1/files/${tables[spec.table]![0]!.id}`);
    expect(streamed.headers.get('content-type')).toBe('image/jpeg');
    expect(await streamed.text()).toBe('JPEGBYTES');
  });

  test('a document in another company is not found', async () => {
    const tables = seed();
    const { app } = harness(spec, tables);
    expect((await upload(app, 'doc-other')).status).toBe(404);
    expect((await app.request('/api/doc-other/files')).status).toBe(404);
    expect(tables[spec.table]).toEqual([]);
  });

  test('a cancelled document takes no more files', async () => {
    const { app } = harness(spec, seed('CANCELLED'));
    expect((await upload(app, 'doc-1')).status).toBe(409);
  });

  test('a file can be removed while the document is open, not once it is finished', async () => {
    const tables = seed();
    const { app, r2 } = harness(spec, tables);
    await upload(app, 'doc-1'); await upload(app, 'doc-1', 'second.jpg');
    const first = tables[spec.table]![0]!;
    expect((await app.request(`/api/doc-1/files/${first.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(r2.store.has(first.file_key)).toBe(false);

    tables[docTable]![0]!.status = finished;
    const second = tables[spec.table]![0]!;
    const refused = await app.request(`/api/doc-1/files/${second.id}`, { method: 'DELETE' });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: string }).error).toBe('evidence_locked');
    expect(((await (await app.request('/api/doc-1/files')).json()) as { locked: boolean }).locked).toBe(true);
    expect((await upload(app, 'doc-1', 'late.jpg')).status).toBe(201);
  });
});
