/* AP invoice attachments — the supplier's bill LIVES with the AP invoice
   (owner 2026-09-06: 附件也一起做,bundle 也带上). Pinned:
     • upload puts the bytes in R2 under ap-invoice-files/<co>/<invoice>/ and
       an index row beside the bill, attach order; list walks it; stream
       hands the stored mime back;
     • a mime outside image/PDF refuses; a CANCELLED bill takes no more
       evidence; a POSTED one still takes its scan but keeps what it has
       (delete → evidence_locked) — the ledger is the AP invoice's lock;
     • the AP Payment's print bundle appends each PAID bill's files after the
       voucher's own, allocation order; a purchase-invoice allocation adds
       nothing; a missing R2 object still costs a notice page.
   Fake R2 binding + the same bare-Hono harness as tests/pvFiles.test.ts. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  uploadApInvoiceFileHandler, listApInvoiceFilesHandler, streamApInvoiceFileHandler, deleteApInvoiceFileHandler,
} from '../src/scm/routes/ap-invoice-files';
import { printPvBundleHandler } from '../src/scm/routes/pv-files';

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
  app.post('/api/:id/files', (c) => uploadApInvoiceFileHandler(c));
  app.get('/api/:id/files', (c) => listApInvoiceFilesHandler(c));
  app.get('/api/:id/files/:fileId', (c) => streamApInvoiceFileHandler(c));
  app.delete('/api/:id/files/:fileId', (c) => deleteApInvoiceFileHandler(c));
  app.post('/print-bundle', (c) => printPvBundleHandler(c));
  return { app: { request: (path: string, init?: RequestInit) => app.request(path, init, { SLIPS: r2 } as never) }, r2 };
}

const INVOICE = (over: Row = {}): Row => ({
  id: 'api-1', invoice_number: '2990-API-2609-001', status: 'DRAFT', company_id: CO, ...over,
});

const b64 = (s: string) => btoa(s);

const upload = (app: { request: (p: string, i?: RequestInit) => Promise<Response> }, name = 'rent-bill.jpg', mime = 'image/jpeg', id = 'api-1') =>
  app.request(`/api/${id}/files`, {
    method: 'POST',
    body: JSON.stringify({ fileName: name, mime, dataBase64: b64('JPEGBYTES') }),
    headers: { 'content-type': 'application/json' },
  });

describe('AP invoice attachments — the supplier bill lives with the AP invoice', () => {
  test('upload stores bytes under ap-invoice-files/<co>/<invoice>/ + an index row in attach order; list walks it; stream hands the mime back', async () => {
    const tables: Record<string, Row[]> = { ap_invoices: [INVOICE()], acc_ap_invoice_files: [] };
    const { app, r2 } = harness(tables);

    expect((await upload(app)).status).toBe(201);
    expect((await upload(app, 'rent-bill-p2.pdf', 'application/pdf')).status).toBe(201);
    expect(tables.acc_ap_invoice_files.map((f) => [f.ap_invoice_id, f.sort_no, f.mime])).toEqual([['api-1', 1, 'image/jpeg'], ['api-1', 2, 'application/pdf']]);
    expect([...r2.store.keys()].every((k) => k.startsWith(`ap-invoice-files/${CO}/api-1/`))).toBe(true);

    const list = await app.request('/api/api-1/files');
    const body = await list.json() as { files: Row[] };
    expect(body.files.map((f) => f.file_name)).toEqual(['rent-bill.jpg', 'rent-bill-p2.pdf']);

    const fileId = tables.acc_ap_invoice_files[0]!.id;
    const streamed = await app.request(`/api/api-1/files/${fileId}`);
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get('content-type')).toBe('image/jpeg');
    expect(await streamed.text()).toBe('JPEGBYTES');
  });

  test('a mime outside image/pdf refuses; a cancelled bill takes no more evidence; a bill outside the company is not found', async () => {
    const tables: Record<string, Row[]> = { ap_invoices: [INVOICE(), INVOICE({ id: 'api-other', company_id: 2 })], acc_ap_invoice_files: [] };
    const { app } = harness(tables);
    expect((await upload(app, 'x.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).status).toBe(400);
    expect((await upload(app, 'a.jpg', 'image/jpeg', 'api-other')).status).toBe(404);

    tables.ap_invoices[0]!.status = 'CANCELLED';
    const refused = await upload(app);
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: string }).error).toBe('invoice_cancelled');
  });

  test('delete works while DRAFT and removes the R2 object; a POSTED bill still takes a file but keeps what it has', async () => {
    const tables: Record<string, Row[]> = { ap_invoices: [INVOICE()], acc_ap_invoice_files: [] };
    const { app, r2 } = harness(tables);
    await upload(app);
    const fileId = tables.acc_ap_invoice_files[0]!.id;

    expect((await app.request(`/api/api-1/files/${fileId}`, { method: 'DELETE' })).status).toBe(200);
    expect(tables.acc_ap_invoice_files).toHaveLength(0);
    expect(r2.store.size).toBe(0);

    tables.ap_invoices[0]!.status = 'POSTED';
    expect((await upload(app)).status).toBe(201);
    const locked = await app.request(`/api/api-1/files/${tables.acc_ap_invoice_files[0]!.id}`, { method: 'DELETE' });
    expect(locked.status).toBe(409);
    expect((await locked.json() as { error: string }).error).toBe('evidence_locked');
    expect(tables.acc_ap_invoice_files).toHaveLength(1);
  });

  test('print-bundle: the voucher page, its own files, then each PAID bill\'s files in allocation order; a PI allocation adds nothing; a missing object costs a notice page', async () => {
    const r2 = fakeR2();
    const bill = await PDFDocument.create();
    bill.addPage([595.28, 841.89]); bill.addPage([595.28, 841.89]);
    const billBytes = await bill.save();
    r2.store.set('ap-invoice-files/1/api-1/a.pdf', { bytes: billBytes.buffer.slice(billBytes.byteOffset, billBytes.byteOffset + billBytes.byteLength) as ArrayBuffer, contentType: 'application/pdf' });

    const tables: Record<string, Row[]> = {
      payment_vouchers: [{ id: 'pv-9', pv_number: 'HC-PV-2609-009', status: 'POSTED', checked_at: '2026-09-06T00:00:00Z', company_id: CO }],
      acc_pv_files: [],
      pv_allocations: [
        { id: 'al-1', pv_id: 'pv-9', pi_id: 'pi-1', ap_invoice_id: null, amount_sen: 100, company_id: CO, created_at: '2026-09-06T01:00:00Z' },
        { id: 'al-2', pv_id: 'pv-9', pi_id: null, ap_invoice_id: 'api-1', amount_sen: 100, company_id: CO, created_at: '2026-09-06T02:00:00Z' },
        { id: 'al-3', pv_id: 'pv-9', pi_id: null, ap_invoice_id: 'api-2', amount_sen: 100, company_id: CO, created_at: '2026-09-06T03:00:00Z' },
      ],
      ap_invoices: [INVOICE({ status: 'PAID' }), INVOICE({ id: 'api-2', invoice_number: '2990-API-2609-002', status: 'PAID' })],
      acc_ap_invoice_files: [
        { id: 'f1', company_id: CO, ap_invoice_id: 'api-1', file_key: 'ap-invoice-files/1/api-1/a.pdf', file_name: 'rent.pdf', mime: 'application/pdf', sort_no: 1 },
        { id: 'f2', company_id: CO, ap_invoice_id: 'api-2', file_key: 'ap-invoice-files/1/api-2/gone.jpg', file_name: 'gone.jpg', mime: 'image/jpeg', sort_no: 1 },
      ],
    };
    const { app } = harness(tables, r2);

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
    const merged = await PDFDocument.load(await res.arrayBuffer());
    /* voucher (500-wide) + api-1's 2-page bill + api-2's missing-file NOTICE page. */
    expect(merged.getPageCount()).toBe(4);
    expect(merged.getPages().map((p) => Math.round(p.getWidth()))).toEqual([500, 595, 595, 595]);
  });
});
