/* Supplier bills printed together (Money out › Supplier bills, batch 4 step 8):
   POST /ap-invoices/print-bundle. Pinned:
     • the documents come back in the order sent, each page followed by ITS
       stored files — an AP bill's from acc_ap_invoice_files, a supplier
       credit note's from acc_credit_note_files; a purchase invoice keeps no
       files here, so its page stands alone; a missing R2 object costs a
       notice page, never a silent gap;
     • a document that is not in the company you are working in — or a
       customer's credit note — fails the whole print by its id;
     • a part without a known kind, too many parts, or a page that did not
       arrive intact refuse before anything prints.
   Fake R2 binding + the bare-Hono harness of tests/apInvoiceFiles.test.ts. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { printApBillsBundleHandler } from '../src/scm/routes/ap-bill-print';

type Row = Record<string, any>;
const CO = 1;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  order() { return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  private run(): Row[] { return this.rows.filter((r) => this.preds.every((p) => p(r))); }
  maybeSingle() { return Promise.resolve({ data: this.run()[0] ?? null, error: null }); }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

const fakeR2 = () => {
  const store = new Map<string, { bytes: ArrayBuffer; contentType: string }>();
  return {
    store,
    get: async (k: string) => {
      const hit = store.get(k);
      if (!hit) return null;
      return { body: new Blob([hit.bytes]).stream(), httpMetadata: { contentType: hit.contentType } };
    },
  };
};

function harness(tables: Record<string, Row[]>, r2 = fakeR2()) {
  const app = new Hono<{ Bindings: { SLIPS: ReturnType<typeof fakeR2> } }>();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, { from: (t: string) => new FakeQuery((tables[t] ||= [])) } as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.post('/print-bundle', (c) => printApBillsBundleHandler(c as never));
  return (parts: unknown[]) => app.request('/print-bundle', {
    method: 'POST',
    body: JSON.stringify({ parts }),
    headers: { 'content-type': 'application/json' },
  }, { SLIPS: r2 } as never);
}

/** A one-page PDF whose WIDTH marks which document it is. */
async function page(width: number): Promise<string> {
  const doc = await PDFDocument.create();
  doc.addPage([width, 841.89]);
  const bytes = await doc.save();
  return btoa(String.fromCharCode(...bytes));
}

const TABLES = (): Record<string, Row[]> => ({
  ap_invoices: [{ id: 'api-1', invoice_number: '2990-API-2609-001', company_id: CO }],
  purchase_invoices: [{ id: 'pi-1', invoice_number: '2990-PI-2607-005', company_id: CO }],
  acc_credit_notes: [
    { id: 'scn-1', note_number: '2990-SCN-2610-001', kind: 'SCN', company_id: CO },
    { id: 'cn-1', note_number: '2990-CN-2610-001', kind: 'CN', company_id: CO },
  ],
  acc_ap_invoice_files: [
    { id: 'f1', company_id: CO, ap_invoice_id: 'api-1', file_key: 'ap-invoice-files/1/api-1/a.pdf', file_name: 'rent.pdf', mime: 'application/pdf', sort_no: 1 },
  ],
  acc_credit_note_files: [
    { id: 'f2', company_id: CO, note_id: 'scn-1', file_key: 'credit-note-files/1/scn-1/gone.jpg', file_name: 'gone.jpg', mime: 'image/jpeg', sort_no: 1 },
  ],
});

describe('POST /ap-invoices/print-bundle', () => {
  test('list order, each page followed by its own files; a purchase invoice stands alone; a missing file is a notice page', async () => {
    const r2 = fakeR2();
    const bill = await PDFDocument.create();
    bill.addPage([595.28, 841.89]); bill.addPage([595.28, 841.89]);
    const billBytes = await bill.save();
    r2.store.set('ap-invoice-files/1/api-1/a.pdf', { bytes: billBytes.buffer.slice(billBytes.byteOffset, billBytes.byteOffset + billBytes.byteLength) as ArrayBuffer, contentType: 'application/pdf' });
    const send = harness(TABLES(), r2);

    const res = await send([
      { kind: 'API', id: 'api-1', pageBase64: await page(500) },
      { kind: 'PI', id: 'pi-1', pageBase64: await page(510) },
      { kind: 'SCN', id: 'scn-1', pageBase64: await page(520) },
    ]);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('supplier-bills.pdf');
    const merged = await PDFDocument.load(await res.arrayBuffer());
    /* the bill (500) + its 2-page file, the PI (510) alone, the note (520) + its missing file's NOTICE page. */
    expect(merged.getPages().map((p) => Math.round(p.getWidth()))).toEqual([500, 595, 595, 510, 520, 595]);
  });

  test('one document is named by its number', async () => {
    const send = harness(TABLES());
    const res = await send([{ kind: 'PI', id: 'pi-1', pageBase64: await page(510) }]);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('2990-PI-2607-005.pdf');
  });

  test('a document outside the company, or a customer credit note, fails the whole print by its id', async () => {
    const tables = TABLES();
    tables.ap_invoices!.push({ id: 'api-9', invoice_number: '2990-API-2609-009', company_id: 2 });
    const send = harness(tables);
    const away = await send([{ kind: 'API', id: 'api-1', pageBase64: await page(500) }, { kind: 'API', id: 'api-9', pageBase64: await page(500) }]);
    expect(away.status).toBe(404);
    expect(((await away.json()) as { message: string }).message).toBe('Document api-9 could not be loaded — nothing was printed.');
    const customer = await send([{ kind: 'SCN', id: 'cn-1', pageBase64: await page(520) }]);
    expect(customer.status).toBe(404);
  });

  test('an unknown kind, too many parts, or a broken page refuse before anything prints', async () => {
    const send = harness(TABLES());
    const kind = await send([{ kind: 'PV', id: 'api-1', pageBase64: await page(500) }]);
    expect(kind.status).toBe(400);
    expect(((await kind.json()) as { error: string }).error).toBe('bad_part');
    const many = await send(Array.from({ length: 31 }, () => ({ kind: 'PI', id: 'pi-1', pageBase64: 'x' })));
    expect(many.status).toBe(400);
    expect(((await many.json()) as { error: string }).error).toBe('too_many_parts');
    const broken = await send([{ kind: 'API', id: 'api-1', pageBase64: '***' }]);
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as { message: string }).message).toBe("2990-API-2609-001's rendered page did not arrive intact.");
    const none = await send([]);
    expect(none.status).toBe(400);
  });
});
