/* PV attachments — the contract (owner 2026-09-03: print pv include ocr 的
   文件一起, which first needs the file to LIVE with the voucher): upload puts
   the bytes in R2 and an index row beside the PV; list walks sort order;
   stream hands the bytes back with the stored mime; delete works until the
   voucher is CHECKED — evidence locks with the document. Fake R2 binding,
   bare-Hono harness (pvApControlGuard family). */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  uploadPvFileHandler, listPvFilesHandler, streamPvFileHandler, deletePvFileHandler, printPvBundleHandler,
} from '../src/scm/routes/pv-files';

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

function harness(tables: Record<string, Row[]>, r2 = fakeR2()) {
  const app = new Hono<{ Bindings: { SLIPS: ReturnType<typeof fakeR2> } }>();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t),
      schema(_s: string) { return this; },
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.post('/pv/:id/files', (c) => uploadPvFileHandler(c));
  app.get('/pv/:id/files', (c) => listPvFilesHandler(c));
  app.get('/pv/:id/files/:fileId', (c) => streamPvFileHandler(c));
  app.delete('/pv/:id/files/:fileId', (c) => deletePvFileHandler(c));
  app.post('/print-bundle', (c) => printPvBundleHandler(c));
  return { app: { request: (path: string, init?: RequestInit) => app.request(path, init, { SLIPS: r2 } as never) }, r2 };
}

const PV = (over: Row = {}): Row => ({
  id: 'pv-9', pv_number: 'HC-PV-2609-009', status: 'DRAFT', checked_at: null, company_id: CO, ...over,
});

const b64 = (s: string) => btoa(s);

const upload = (app: { request: (p: string, i?: RequestInit) => Promise<Response> }, name = 'bill-page-1.jpg', mime = 'image/jpeg') =>
  app.request('/pv/pv-9/files', {
    method: 'POST',
    body: JSON.stringify({ fileName: name, mime, dataBase64: b64('JPEGBYTES') }),
    headers: { 'content-type': 'application/json' },
  });

describe('PV attachments — the bill lives with its voucher', () => {
  test('upload stores bytes + an index row in attach order; list walks it; stream hands the mime back', async () => {
    const tables: Record<string, Row[]> = { payment_vouchers: [PV()], acc_pv_files: [] };
    const { app, r2 } = harness(tables);

    expect((await upload(app)).status).toBe(201);
    expect((await upload(app, 'bill-page-2.pdf', 'application/pdf')).status).toBe(201);
    expect(tables.acc_pv_files.map((f) => [f.sort_no, f.mime])).toEqual([[1, 'image/jpeg'], [2, 'application/pdf']]);
    expect([...r2.store.keys()].every((k) => k.startsWith(`pv-files/${CO}/pv-9/`))).toBe(true);

    const list = await app.request('/pv/pv-9/files');
    const body = await list.json() as { files: Row[] };
    expect(body.files.map((f) => f.file_name)).toEqual(['bill-page-1.jpg', 'bill-page-2.pdf']);

    const fileId = tables.acc_pv_files[0]!.id;
    const streamed = await app.request(`/pv/pv-9/files/${fileId}`);
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get('content-type')).toBe('image/jpeg');
    expect(await streamed.text()).toBe('JPEGBYTES');
  });

  test('a mime outside image/pdf refuses; a cancelled voucher takes no more evidence', async () => {
    const tables: Record<string, Row[]> = { payment_vouchers: [PV()], acc_pv_files: [] };
    const { app } = harness(tables);
    expect((await upload(app, 'x.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).status).toBe(400);

    tables.payment_vouchers[0]!.status = 'CANCELLED';
    const refused = await upload(app);
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: string }).error).toBe('voucher_cancelled');
  });

  test('print-bundle: voucher page first, then ITS stored files in sort order; a missing R2 object costs a notice page, an unknown pv fails the WHOLE bundle', async () => {
    const tables: Record<string, Row[]> = { payment_vouchers: [PV()], acc_pv_files: [] };
    const r2 = fakeR2();
    const { app } = harness(tables, r2);

    /* Two stored files: a real 2-page PDF and an index row whose object is
       GONE from the bucket. */
    const bill = await PDFDocument.create();
    bill.addPage([595.28, 841.89]); bill.addPage([595.28, 841.89]);
    const billBytes = await bill.save();
    tables.acc_pv_files.push(
      { id: 'f1', company_id: CO, pv_id: 'pv-9', file_key: 'pv-files/1/pv-9/a.pdf', file_name: 'bill.pdf', mime: 'application/pdf', sort_no: 1 },
      { id: 'f2', company_id: CO, pv_id: 'pv-9', file_key: 'pv-files/1/pv-9/gone.jpg', file_name: 'gone.jpg', mime: 'image/jpeg', sort_no: 2 },
    );
    r2.store.set('pv-files/1/pv-9/a.pdf', { bytes: billBytes.buffer.slice(billBytes.byteOffset, billBytes.byteOffset + billBytes.byteLength) as ArrayBuffer, contentType: 'application/pdf' });

    const voucherDoc = await PDFDocument.create();
    voucherDoc.addPage([500, 841.89]); // width marks the voucher page
    const voucherBytes = await voucherDoc.save();
    const voucherBase64 = btoa(String.fromCharCode(...voucherBytes));

    const res = await app.request('/print-bundle', {
      method: 'POST',
      body: JSON.stringify({ parts: [{ pvId: 'pv-9', voucherBase64 }] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const merged = await PDFDocument.load(await res.arrayBuffer());
    /* voucher (500-wide) + bill's 2 pages + the missing file's NOTICE page. */
    expect(merged.getPageCount()).toBe(4);
    expect(Math.round(merged.getPages()[0]!.getWidth())).toBe(500);

    const missing = await app.request('/print-bundle', {
      method: 'POST',
      body: JSON.stringify({ parts: [{ pvId: 'pv-9', voucherBase64 }, { pvId: 'nope', voucherBase64 }] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(missing.status).toBe(404);
    expect((await missing.json() as { message: string }).message).toContain('nothing was printed');
  });

  test('delete works while DRAFT-unchecked, removes the R2 object too, and locks once CHECKED', async () => {
    const tables: Record<string, Row[]> = { payment_vouchers: [PV()], acc_pv_files: [] };
    const { app, r2 } = harness(tables);
    await upload(app);
    const fileId = tables.acc_pv_files[0]!.id;

    expect((await app.request(`/pv/pv-9/files/${fileId}`, { method: 'DELETE' })).status).toBe(200);
    expect(tables.acc_pv_files).toHaveLength(0);
    expect(r2.store.size).toBe(0);

    await upload(app);
    tables.payment_vouchers[0]!.checked_at = '2026-09-03T12:00:00Z';
    const locked = await app.request(`/pv/pv-9/files/${tables.acc_pv_files[0]!.id}`, { method: 'DELETE' });
    expect(locked.status).toBe(409);
    expect((await locked.json() as { error: string }).error).toBe('evidence_locked');
  });
});
