/* ── The 2026-08-10 photo outage: signing fails, photos must still resolve ──
   Verified live against production that day: the SO signed route answered
   500 {"error":"signing_failed","reason":"R2_ACCESS_KEY_ID not configured"}
   while the SAME photo returned 200 image/jpeg through the proxy route. The R2
   S3 credentials are wrangler SECRETS that were never provisioned; the R2
   BINDING has always worked. So the bytes were readable the whole time and only
   the URL-minting path was broken — which the frontend surfaced as the literal
   text "err" on every photo tile.

   These tests drive the REAL exported handlers through a bare Hono app with a
   fake PostgREST client and an env whose R2 S3 creds are absent — exactly the
   production condition. Same harness shape as companyScopeConsignmentPo.test.ts
   (mount the exported handlers, not the routers; the supabaseAuth bridge cannot
   run here).

   WITHOUT the fix every "falls back" test below fails with a 500, and the PO
   proxy tests fail with a 404 because the route does not exist at all. */
import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import { soItemPhotoSignedHandler } from '../src/scm/routes/mfg-sales-orders';
import { poItemPhotoSignedHandler, poItemPhotoProxyHandler } from '../src/scm/routes/mfg-purchase-orders';
import { consignmentItemPhotoSignedHandler } from '../src/scm/routes/consignment-orders';
import { resetSigningWarnLog } from '../src/scm/lib/photoProxyFallback';

const CO_A = 1;
const CO_B = 2;

type Row = Record<string, any>;

/* Minimal PostgREST fake — these handlers only ever do
   .from(t).select(...).eq('id', x)[.eq('company_id', n)].maybeSingle(). */
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  eq(col: string, val: unknown) {
    this.preds.push((r) => String(r[col]) === String(val));
    return this;
  }
  maybeSingle() {
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    return Promise.resolve({ data: hit[0] ?? null, error: null });
  }
}

/* The photo bytes, served by the R2 binding — the thing that never broke. */
function fakeBucket(objects: Record<string, string>) {
  return {
    get: async (key: string) =>
      objects[key] == null
        ? null
        : { body: objects[key], httpMetadata: { contentType: 'image/jpeg' } },
  };
}

/**
 * `signing: false` reproduces production — soItemPhotoBindings() throws
 * "R2_ACCESS_KEY_ID not configured". `signing: true` supplies the creds so the
 * happy path can be asserted too (a fallback that ALWAYS fires would "pass"
 * these tests while silently disabling signed URLs forever).
 */
function harness(
  tables: Record<string, Row[]>,
  opts: { companyId?: number; signing?: boolean; objects?: Record<string, string> } = {},
) {
  const app = new Hono();
  const env: Row = {
    SO_ITEM_PHOTOS_BUCKET_NAME: 'houzs-erp',
    SO_ITEM_PHOTOS: fakeBucket(opts.objects ?? {}),
  };
  if (opts.signing) {
    env.R2_ACCESS_KEY_ID = 'test-access-key';
    env.R2_SECRET_ACCESS_KEY = 'test-secret-key';
    env.R2_ENDPOINT = 'https://account.r2.cloudflarestorage.com';
  }
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= [])),
    } as never);
    c.set('companyId' as never, opts.companyId as never);
    c.set('user' as never, { id: 'u1' } as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).env = env;
    await next();
  });
  app.get('/mfg-sales-orders/:docNo/items/:itemId/photos/:photoKey/signed', soItemPhotoSignedHandler as never);
  app.get('/mfg-purchase-orders/:id/items/:itemId/photos/:photoKey/signed', poItemPhotoSignedHandler as never);
  app.get('/mfg-purchase-orders/:id/items/:itemId/photos/:photoKey', poItemPhotoProxyHandler as never);
  app.get('/consignment-orders/:docNo/items/:itemId/photos/:photoKey/signed', consignmentItemPhotoSignedHandler as never);
  return app;
}

const SO_KEY = 'so-items/HC-SO-002609/item-1/abc-123.jpg';
const PO_KEY = 'po-items/PO-2608-001/item-1/ac-5526-1.jpg';

beforeEach(() => resetSigningWarnLog());

// ── 1. SO: signing throws -> 200 + proxy path, NOT 500 ───────────────────────
describe('SO photo signed route when the R2 S3 creds are missing', () => {
  const soItems = (): Row[] => [
    { id: 'item-1', doc_no: 'HC-SO-002609', photo_urls: [SO_KEY] },
  ];

  test('falls back to a proxy path instead of 500 signing_failed', async () => {
    const app = harness({ mfg_sales_order_items: soItems() });
    const res = await app.request(
      `/mfg-sales-orders/HC-SO-002609/items/item-1/photos/${encodeURIComponent(SO_KEY)}/signed`,
    );
    // The bug: this was 500 {"error":"signing_failed"}.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('proxy');
    expect(body.error).toBeUndefined();
    expect(body.proxyPath).toBe(
      `/mfg-sales-orders/HC-SO-002609/items/item-1/photos/${encodeURIComponent(SO_KEY)}`,
    );
    // The reason is still reported — the outage must stay diagnosable.
    expect(body.reason).toBe('R2_ACCESS_KEY_ID not configured');
  });

  test('does NOT hand the proxy path back as signedUrl (an <img src> would 401)', async () => {
    const app = harness({ mfg_sales_order_items: soItems() });
    const res = await app.request(
      `/mfg-sales-orders/HC-SO-002609/items/item-1/photos/${encodeURIComponent(SO_KEY)}/signed`,
    );
    const body = await res.json();
    /* Load-bearing. The proxy sits behind the global auth gate, which reads the
       bearer token from the Authorization HEADER only, and a browser sends no
       such header on an <img src>. Populating signedUrl here would trade a
       visible 500 for an invisible 401 — broken, but looking fixed. */
    expect(body.signedUrl).toBeUndefined();
  });

  test('a thumb path is offered alongside the full-size one', async () => {
    const app = harness({ mfg_sales_order_items: soItems() });
    const res = await app.request(
      `/mfg-sales-orders/HC-SO-002609/items/item-1/photos/${encodeURIComponent(SO_KEY)}/signed`,
    );
    const body = await res.json();
    expect(body.thumbProxyPath).toBe(
      `/mfg-sales-orders/HC-SO-002609/items/item-1/photos/${encodeURIComponent(`${SO_KEY}.thumb`)}`,
    );
  });

  test('authz still refuses a key that is not in this line photo_urls', async () => {
    const app = harness({ mfg_sales_order_items: soItems() });
    const res = await app.request(
      `/mfg-sales-orders/HC-SO-002609/items/item-1/photos/${encodeURIComponent('so-items/other/guessed.jpg')}/signed`,
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('photo_not_in_item');
  });

  test('with creds present it still signs — the fallback has not replaced signing', async () => {
    const app = harness({ mfg_sales_order_items: soItems() }, { signing: true });
    const res = await app.request(
      `/mfg-sales-orders/HC-SO-002609/items/item-1/photos/${encodeURIComponent(SO_KEY)}/signed`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('signed');
    expect(body.signedUrl).toContain('X-Amz-Signature');
    expect(body.proxyPath).toBeUndefined();
  });
});

// ── 2. PO: same fallback, and the proxy route that did not exist ─────────────
describe('PO photo signed route when the R2 S3 creds are missing', () => {
  const poItems = (): Row[] => [
    { id: 'item-1', purchase_order_id: 'po-a', company_id: CO_A, photo_urls: [PO_KEY] },
  ];

  test('falls back to a proxy path instead of 500 signing_failed', async () => {
    const app = harness({ purchase_order_items: poItems() }, { companyId: CO_A });
    const res = await app.request(
      `/mfg-purchase-orders/po-a/items/item-1/photos/${encodeURIComponent(PO_KEY)}/signed`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('proxy');
    expect(body.proxyPath).toBe(
      `/mfg-purchase-orders/po-a/items/item-1/photos/${encodeURIComponent(PO_KEY)}`,
    );
    expect(body.signedUrl).toBeUndefined();
  });

  test('with creds present it still signs', async () => {
    const app = harness({ purchase_order_items: poItems() }, { companyId: CO_A, signing: true });
    const res = await app.request(
      `/mfg-purchase-orders/po-a/items/item-1/photos/${encodeURIComponent(PO_KEY)}/signed`,
    );
    const body = await res.json();
    expect(body.mode).toBe('signed');
    expect(body.signedUrl).toContain('X-Amz-Signature');
  });
});

/* The PO proxy is NEW — before this change the PO side had a /signed route and
   nothing else, so when signing broke there was no fallback to reach for. Its
   authz must match the /signed route it backs up, INCLUDING company scoping
   (which the SO proxy does not do, because the SO /signed twin does not
   either). A proxy more permissive than its signed counterpart is a leak. */
describe('PO photo proxy route (new) — serves bytes from the R2 binding', () => {
  const poItems = (): Row[] => [
    { id: 'item-1', purchase_order_id: 'po-a', company_id: CO_A, photo_urls: [PO_KEY] },
    { id: 'item-b', purchase_order_id: 'po-b', company_id: CO_B, photo_urls: [PO_KEY] },
  ];
  const objects = { [PO_KEY]: 'JPEGBYTES', [`${PO_KEY}.thumb`]: 'THUMBBYTES' };

  test('serves the photo with no S3 credentials at all', async () => {
    const app = harness({ purchase_order_items: poItems() }, { companyId: CO_A, objects });
    const res = await app.request(
      `/mfg-purchase-orders/po-a/items/item-1/photos/${encodeURIComponent(PO_KEY)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(await res.text()).toBe('JPEGBYTES');
  });

  test('authorises a .thumb sibling against its BASE key', async () => {
    const app = harness({ purchase_order_items: poItems() }, { companyId: CO_A, objects });
    const res = await app.request(
      `/mfg-purchase-orders/po-a/items/item-1/photos/${encodeURIComponent(`${PO_KEY}.thumb`)}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('THUMBBYTES');
  });

  test('REFUSES a key that is not in this line photo_urls (no key-shape rule)', async () => {
    const app = harness({ purchase_order_items: poItems() }, { companyId: CO_A, objects });
    const res = await app.request(
      `/mfg-purchase-orders/po-a/items/item-1/photos/${encodeURIComponent('po-items/PO-2608-001/item-1/guessed.jpg')}`,
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('photo_not_in_item');
  });

  test('REFUSES a line that belongs to a different PO', async () => {
    const app = harness({ purchase_order_items: poItems() }, { companyId: CO_A, objects });
    // item-1 is real and the key is in its photo_urls, but it is not on po-zzz.
    const res = await app.request(
      `/mfg-purchase-orders/po-zzz/items/item-1/photos/${encodeURIComponent(PO_KEY)}`,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('item_doc_mismatch');
  });

  test('REFUSES another company\'s line, and does not leak its bytes', async () => {
    const app = harness({ purchase_order_items: poItems() }, { companyId: CO_A, objects });
    const res = await app.request(
      `/mfg-purchase-orders/po-b/items/item-b/photos/${encodeURIComponent(PO_KEY)}`,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('JPEGBYTES');
  });

  test('company B CAN read its own line (a scope sweep must not blind the owner)', async () => {
    const app = harness({ purchase_order_items: poItems() }, { companyId: CO_B, objects });
    const res = await app.request(
      `/mfg-purchase-orders/po-b/items/item-b/photos/${encodeURIComponent(PO_KEY)}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('JPEGBYTES');
  });

  test('404s when the object is genuinely absent from R2', async () => {
    const app = harness({ purchase_order_items: poItems() }, { companyId: CO_A, objects: {} });
    const res = await app.request(
      `/mfg-purchase-orders/po-a/items/item-1/photos/${encodeURIComponent(PO_KEY)}`,
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('photo_not_found_in_r2');
  });
});

// ── 3. Consignment: same gap, same fallback ──────────────────────────────────
describe('Consignment photo signed route when the R2 S3 creds are missing', () => {
  const coItems = (): Row[] => [
    { id: 'item-1', doc_no: 'CO-2608-001', company_id: CO_A, photo_urls: [SO_KEY] },
  ];

  test('falls back to a proxy path instead of 500 signing_failed', async () => {
    const app = harness({ consignment_sales_order_items: coItems() }, { companyId: CO_A });
    const res = await app.request(
      `/consignment-orders/CO-2608-001/items/item-1/photos/${encodeURIComponent(SO_KEY)}/signed`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('proxy');
    expect(body.proxyPath).toBe(
      `/consignment-orders/CO-2608-001/items/item-1/photos/${encodeURIComponent(SO_KEY)}`,
    );
    expect(body.signedUrl).toBeUndefined();
  });
});
