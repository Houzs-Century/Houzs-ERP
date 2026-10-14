// HC-0006 T7: every document opens its original scan, and each open is recorded
// (who, when). scan_files.document_id is filled where the document is created:
// by storage key (SO, workshop) or by the bytes' sha256 (payment slip, PV file).
import { describe, expect, test } from 'vitest';
import { linkScanFiles, linkPaymentScan } from '../lib/scan-files';
import { listScanFilesHandler, scanFileContentHandler } from './scan-files';

type Row = Record<string, unknown>;

/* PostgREST stand-in: select/eq/is/in/order/limit/update/insert/maybeSingle. */
function fakeDb(tables: Record<string, Row[]>) {
  class Q {
    private preds: Array<(r: Row) => boolean> = [];
    private op: 'select' | 'update' | 'insert' = 'select';
    private patch: Row = {};
    constructor(private table: string) {}
    private get rows(): Row[] {
      return tables[this.table] ?? (tables[this.table] = []);
    }
    select() { return this; }
    order() { return this; }
    limit() { return this; }
    update(p: Row) { this.op = 'update'; this.patch = p; return this; }
    insert(p: Row) { this.op = 'insert'; this.patch = p; return this; }
    eq(col: string, v: unknown) { this.preds.push((r) => r[col] === v); return this; }
    is(col: string, v: null) { this.preds.push((r) => (r[col] ?? null) === v); return this; }
    in(col: string, vs: unknown[]) { this.preds.push((r) => vs.includes(r[col])); return this; }
    private run(): Row[] {
      if (this.op === 'insert') { this.rows.push({ ...this.patch }); return []; }
      const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
      if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
      return hit;
    }
    maybeSingle() { return Promise.resolve({ data: this.run()[0] ?? null, error: null }); }
    then<A>(res: (v: { data: Row[]; error: null }) => A, rej?: (e: unknown) => A) {
      return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
    }
  }
  return { from: (t: string) => new Q(t) };
}

const file = (over: Row): Row => ({
  id: 'F1', company_id: 1, kind: 'so', storage_key: 'scan-jobs/J1/0', sha256: 'aa', mime: 'image/jpeg',
  size_bytes: 3, uploaded_by: 'u1', document_id: null, created_at: '2026-10-14T01:00:00Z', ...over,
});

function ctx(db: ReturnType<typeof fakeDb>, params: Record<string, string>, companyId: number, objects: Record<string, string>) {
  return {
    env: { SO_ITEM_PHOTOS: { get: async (k: string) => (k in objects ? { body: objects[k] } : null) } },
    req: { param: (k: string) => params[k] },
    get: (k: string) => ({ supabase: db, companyId, user: { id: 'viewer-7' } } as Record<string, unknown>)[k],
    json: (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }),
  };
}

describe('linkScanFiles', () => {
  test('links by key only inside the company and kind, and never re-links', async () => {
    const tables = { scan_files: [
      file({ id: 'A' }),
      file({ id: 'B', company_id: 2 }),
      file({ id: 'C', kind: 'payment' }),
      file({ id: 'D', storage_key: 'scan-jobs/J1/1', document_id: 'SO-OLD' }),
      file({ id: 'E', storage_key: 'scan-jobs/J1/1', sha256: 'bb' }),
    ] };
    const db = fakeDb(tables);
    await linkScanFiles(db, { companyId: 1, kind: 'so', documentId: 'SO-1', keys: ['scan-jobs/J1/0', 'scan-jobs/J1/1'], sha256: null });
    const doc = Object.fromEntries(tables.scan_files.map((r) => [r.id, r.document_id]));
    expect(doc).toEqual({ A: 'SO-1', B: null, C: null, D: 'SO-OLD', E: 'SO-1' });
  });

  test('no company or nothing to match is a no-op', async () => {
    const tables = { scan_files: [file({})] };
    await linkScanFiles(fakeDb(tables), { companyId: null, kind: 'so', documentId: 'SO-1', keys: ['scan-jobs/J1/0'], sha256: null });
    await linkScanFiles(fakeDb(tables), { companyId: 1, kind: 'so', documentId: 'SO-1', keys: [], sha256: null });
    expect(tables.scan_files[0]!.document_id).toBeNull();
  });

  test('a payment links through its slip: same bytes, same sha256', async () => {
    const tables = {
      pending_slip_uploads: [{ r2_key: 'slips/2026/10/S1.jpg', company_id: 1, content_hash: 'cafe' }],
      scan_files: [file({ id: 'P', kind: 'payment', storage_key: 'scan-files/payment/P', sha256: 'cafe' })],
    };
    await linkPaymentScan(fakeDb(tables), { companyId: 1, slipKey: 'slips/2026/10/S1.jpg', paymentId: 'pay-9' });
    expect(tables.scan_files[0]!.document_id).toBe('pay-9');
  });
});

describe('scan file routes', () => {
  test('lists a document\'s scans for the active company only', async () => {
    const db = fakeDb({ scan_files: [
      file({ id: 'A', document_id: 'SO-1' }),
      file({ id: 'B', document_id: 'SO-1', company_id: 2 }),
      file({ id: 'C', document_id: 'SO-2' }),
    ] });
    const res = await listScanFilesHandler(ctx(db, { kind: 'so', documentId: 'SO-1' }, 1, {}) as never);
    const body = await res.json() as { files: Row[] };
    expect(body.files.map((f) => f.id)).toEqual(['A']);
  });

  test('opening a scan streams the bytes and records who opened it and when', async () => {
    const tables: Record<string, Row[]> = { scan_files: [file({ id: 'A', document_id: 'SO-1' })] };
    const db = fakeDb(tables);
    const res = await scanFileContentHandler(ctx(db, { kind: 'so', id: 'A' }, 1, { 'scan-jobs/J1/0': 'JPG' }) as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(await res.text()).toBe('JPG');
    expect(tables.scan_file_views).toEqual([
      expect.objectContaining({ company_id: 1, scan_file_id: 'A', viewed_by: 'viewer-7' }),
    ]);
  });

  test('another company\'s scan is not found, and no view is recorded', async () => {
    const tables: Record<string, Row[]> = { scan_files: [file({ id: 'A', company_id: 2 })] };
    const res = await scanFileContentHandler(ctx(fakeDb(tables), { kind: 'so', id: 'A' }, 1, { 'scan-jobs/J1/0': 'JPG' }) as never);
    expect(res.status).toBe(404);
    expect(tables.scan_file_views ?? []).toHaveLength(0);
  });

  test('an unknown kind is refused (each kind sits behind its own area guard)', async () => {
    const res = await listScanFilesHandler(ctx(fakeDb({}), { kind: 'hr', documentId: 'X' }, 1, {}) as never);
    expect(res.status).toBe(404);
  });
});
