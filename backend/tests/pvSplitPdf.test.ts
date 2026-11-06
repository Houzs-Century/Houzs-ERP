/* POST /payment-vouchers/split-pdf (HC-0204) — one PDF of several invoices
 * cut into one PDF per page for the bill pile. Pinned: the pages come back as
 * base64 one-page PDFs in order; a non-PDF is a 422 with a sentence; the
 * route is the scan's own permission. The cutting itself is pinned in
 * src/scm/lib/pdf-split.test.ts.
 */
import { Hono } from 'hono';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, test } from 'vitest';
import { splitPdfHandler } from '../src/scm/routes/payment-vouchers';

const appFor = (perms: string[]) => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(perms) } as never);
    await next();
  });
  app.post('/payment-vouchers/split-pdf', splitPdfHandler as never);
  return app;
};

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const post = (app: Hono, dataBase64: string) => app.request('/payment-vouchers/split-pdf', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataBase64 }),
});

describe('POST /payment-vouchers/split-pdf', () => {
  test('three invoices in one PDF come back as three one-page PDFs', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]); doc.addPage([200, 200]); doc.addPage([300, 300]);
    const res = await post(appFor(['*']), b64(await doc.save()));
    expect(res.status).toBe(200);
    const { pages } = await res.json() as { pages: string[] };
    expect(pages).toHaveLength(3);
    const widths = await Promise.all(pages.map(async (p) => {
      const d = await PDFDocument.load(Uint8Array.from(atob(p), (ch) => ch.charCodeAt(0)));
      expect(d.getPageCount()).toBe(1);
      return d.getPage(0).getWidth();
    }));
    expect(widths).toEqual([100, 200, 300]);
  });

  test('a file that is not a PDF is refused with a sentence', async () => {
    const res = await post(appFor(['*']), btoa('not a pdf'));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'unreadable_pdf' });
  });

  test('without the scan permission it is refused', async () => {
    const res = await post(appFor([]), btoa('x'));
    expect(res.status).toBe(403);
  });
});
