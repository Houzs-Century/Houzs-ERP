/* PV attachments — the contract (owner 2026-09-03: print pv include ocr 的
   文件一起, which first needs the file to LIVE with the voucher): upload puts
   the bytes in R2 and an index row beside the PV; list walks sort order;
   stream hands the bytes back with the stored mime; delete works until the
   voucher is APPROVED (owner 2026-11-09: 可以 — a wrong file put on a checked
   voucher may still go), and every removal is on the voucher's history. Fake
   R2 binding, bare-Hono harness (pvApControlGuard family). */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { sha256Hex } from '../src/scm/lib/scan-ocr';
import {
  uploadPvFileHandler, listPvFilesHandler, streamPvFileHandler, deletePvFileHandler, printPvBundleHandler,
  BUNDLE_FILE_CONCURRENCY,
} from '../src/scm/routes/pv-files';

type Row = Record<string, any>;
const CO = 1;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'insert' | 'delete' | 'update' = 'select';
  private inserted: Row[] = [];
  private patch: Row = {};
  constructor(private rows: Row[], private table: string) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  delete() { this.op = 'delete'; return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  is(col: string, val: null) { this.preds.push((r) => (r[col] ?? null) === val); return this; }
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
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
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

function harness(tables: Record<string, Row[]>, r2 = fakeR2(), opts: { auditWritable?: boolean } = {}) {
  const app = new Hono<{ Bindings: { SLIPS: ReturnType<typeof fakeR2> } }>();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t),
      schema(_s: string) { return this; },
      /* The trail's pre-flight probe (entity-audit.ts assertAuditWritable). */
      rpc: async (fn: string) => (fn === 'entity_audit_writable'
        ? { data: opts.auditWritable ?? true, error: null }
        : { data: null, error: { message: `unexpected rpc ${fn}` } }),
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
  id: 'pv-9', pv_number: 'HC-PV-2609-009', status: 'DRAFT', checked_at: null, approved_at: null, company_id: CO, ...over,
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

  test('HC-0006 T7: attaching the scanned bill links its original scan to this voucher', async () => {
    const sha = await sha256Hex(new TextEncoder().encode('JPEGBYTES').buffer as ArrayBuffer);
    const tables: Record<string, Row[]> = {
      payment_vouchers: [PV()], acc_pv_files: [],
      scan_files: [
        { id: 'S1', company_id: CO, kind: 'pv', sha256: sha, document_id: null },
        { id: 'S2', company_id: 2, kind: 'pv', sha256: sha, document_id: null },
      ],
    };
    const { app } = harness(tables);
    expect((await upload(app)).status).toBe(201);
    expect(tables.scan_files.map((f) => f.document_id)).toEqual(['pv-9', null]);
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

  test('print-bundle loads in parallel but prints in the sequential order: voucher, its files, the files of the AP invoices it pays, next voucher; every file fetched once, in-flight capped', async () => {
    /* Each stored file is a one-page PDF whose WIDTH names it, so the merged
       page widths spell the print order. The fake R2 answers out of order
       (later keys faster) to prove order does not come from completion. */
    const onePage = async (w: number) => {
      const d = await PDFDocument.create(); d.addPage([w, 800]);
      const b = await d.save();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    };
    const tables: Record<string, Row[]> = {
      payment_vouchers: [PV({ id: 'pv-a', pv_number: 'PV-A' }), PV({ id: 'pv-b', pv_number: 'PV-B' })],
      acc_pv_files: [], acc_ap_invoice_files: [], ap_invoices: [], pv_allocations: [],
    };
    const r2 = fakeR2();
    const fetchedKeys: string[] = [];
    let inFlight = 0; let maxInFlight = 0;
    const baseGet = r2.get;
    let calls = 0;
    r2.get = async (k: string) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      const delay = 20 - (calls++ % 5) * 4;
      await new Promise((r) => setTimeout(r, delay));
      fetchedKeys.push(k);
      inFlight--;
      return baseGet(k);
    };
    const put = async (key: string, w: number) => r2.store.set(key, { bytes: await onePage(w), contentType: 'application/pdf' });
    const pvFile = async (pv: string, n: number, w: number) => {
      const key = `pv-files/1/${pv}/${n}.pdf`;
      tables.acc_pv_files.push({ id: `${pv}-${n}`, company_id: CO, pv_id: pv, file_key: key, file_name: `${n}.pdf`, mime: 'application/pdf', sort_no: n });
      await put(key, w);
    };
    const apFile = async (ap: string, n: number, w: number) => {
      const key = `ap-invoice-files/1/${ap}/${n}.pdf`;
      tables.acc_ap_invoice_files.push({ id: `${ap}-${n}`, company_id: CO, ap_invoice_id: ap, file_key: key, file_name: `${n}.pdf`, mime: 'application/pdf', sort_no: n });
      await put(key, w);
    };
    /* The fake's order() is a no-op: rows go in sort order. */
    await pvFile('pv-a', 1, 301); await pvFile('pv-a', 2, 302);
    await apFile('ap-1', 1, 311); await apFile('ap-1', 2, 312);
    await apFile('ap-2', 1, 321);
    await pvFile('pv-b', 1, 401);
    await apFile('ap-3', 1, 411);
    tables.ap_invoices.push(
      { id: 'ap-1', company_id: CO, invoice_number: 'AP-1' }, { id: 'ap-2', company_id: CO, invoice_number: 'AP-2' },
      { id: 'ap-3', company_id: CO, invoice_number: 'AP-3' },
    );
    tables.pv_allocations.push(
      { company_id: CO, pv_id: 'pv-a', ap_invoice_id: 'ap-1', created_at: '1' },
      { company_id: CO, pv_id: 'pv-a', ap_invoice_id: 'ap-2', created_at: '2' },
      { company_id: CO, pv_id: 'pv-b', ap_invoice_id: 'ap-3', created_at: '1' },
    );
    const { app } = harness(tables, r2);
    const voucherB64 = async (w: number) => {
      const d = await PDFDocument.create(); d.addPage([w, 800]);
      return btoa(String.fromCharCode(...(await d.save())));
    };

    const res = await app.request('/print-bundle', {
      method: 'POST',
      body: JSON.stringify({ parts: [{ pvId: 'pv-a', voucherBase64: await voucherB64(100) }, { pvId: 'pv-b', voucherBase64: await voucherB64(200) }] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('payment-vouchers.pdf');
    const merged = await PDFDocument.load(await res.arrayBuffer());
    expect(merged.getPages().map((p) => Math.round(p.getWidth()))).toEqual([100, 301, 302, 311, 312, 321, 200, 401, 411]);

    expect([...fetchedKeys].sort()).toEqual([...r2.store.keys()].sort());
    expect(fetchedKeys).toHaveLength(7);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(BUNDLE_FILE_CONCURRENCY);
  });

  test('delete works while DRAFT-unchecked and removes the R2 object too', async () => {
    const tables: Record<string, Row[]> = { payment_vouchers: [PV()], acc_pv_files: [] };
    const { app, r2 } = harness(tables);
    await upload(app);
    const fileId = tables.acc_pv_files[0]!.id;

    expect((await app.request(`/pv/pv-9/files/${fileId}`, { method: 'DELETE' })).status).toBe(200);
    expect(tables.acc_pv_files).toHaveLength(0);
    expect(r2.store.size).toBe(0);
  });

  /* Owner 2026-11-09: 「payment 的attachment 不能delete? 如果我不小心放错」 → 可以. */
  test('a CHECKED voucher still lets a wrong file go, until it is approved', async () => {
    const tables: Record<string, Row[]> = { payment_vouchers: [PV({ checked_at: '2026-11-06T03:22:41Z' })], acc_pv_files: [] };
    const { app, r2 } = harness(tables);
    await upload(app, 'wrong-bill.jpg');
    expect((await app.request(`/pv/pv-9/files/${tables.acc_pv_files[0]!.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(tables.acc_pv_files).toHaveLength(0);
    expect(r2.store.size).toBe(0);
    /* The voucher itself does not move: still checked. */
    expect(tables.payment_vouchers[0]!.checked_at).toBe('2026-11-06T03:22:41Z');
  });

  test.each([
    ['approved, its post unfinished', { checked_at: '2026-11-06T03:22:41Z', approved_at: '2026-11-06T04:00:00Z' }],
    ['posted', { status: 'POSTED', checked_at: '2026-11-06T03:22:41Z', approved_at: '2026-11-06T04:00:00Z' }],
  ])('%s: its files stay', async (_name, over) => {
    const tables: Record<string, Row[]> = { payment_vouchers: [PV()], acc_pv_files: [] };
    const { app, r2 } = harness(tables);
    await upload(app);
    Object.assign(tables.payment_vouchers[0]!, over);
    const locked = await app.request(`/pv/pv-9/files/${tables.acc_pv_files[0]!.id}`, { method: 'DELETE' });
    expect(locked.status).toBe(409);
    expect((await locked.json() as { error: string }).error).toBe('evidence_locked');
    expect(tables.acc_pv_files).toHaveLength(1);
    expect(r2.store.size).toBe(1);
    expect(tables.entity_audit_log ?? []).toHaveLength(0);
  });

  test('every removal is on the voucher\'s history: who removed which file', async () => {
    const tables: Record<string, Row[]> = { payment_vouchers: [PV({ checked_at: '2026-11-06T03:22:41Z' })], acc_pv_files: [] };
    const { app } = harness(tables);
    await upload(app, 'wrong-bill.jpg');
    await app.request(`/pv/pv-9/files/${tables.acc_pv_files[0]!.id}`, { method: 'DELETE' });
    const trail = tables.entity_audit_log ?? [];
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ entity_type: 'PAYMENT_VOUCHER', entity_id: 'pv-9', entity_doc_no: 'HC-PV-2609-009', action: 'UPDATE' });
    expect(trail[0]!.actor_name_snapshot).toBe('Tester');
    expect(trail[0]!.field_changes).toEqual([{ field: 'fileRemoved', from: 'wrong-bill.jpg', to: null }]);
  });

  test('when the history cannot be written, nothing is removed', async () => {
    const tables: Record<string, Row[]> = { payment_vouchers: [PV({ checked_at: '2026-11-06T03:22:41Z' })], acc_pv_files: [] };
    const { app, r2 } = harness(tables, fakeR2(), { auditWritable: false });
    await upload(app);
    const r = await app.request(`/pv/pv-9/files/${tables.acc_pv_files[0]!.id}`, { method: 'DELETE' });
    expect(r.status).toBe(409);
    expect(tables.acc_pv_files).toHaveLength(1);
    expect(r2.store.size).toBe(1);
  });
});
