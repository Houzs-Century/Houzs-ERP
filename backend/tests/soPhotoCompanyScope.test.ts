/* ── SO line-photo reads must be company-scoped ───────────────────────────────
   The two SO photo read routes — `/photos/:photoKey/signed` and the `/photos/
   :photoKey` proxy — authorised ONLY membership: the item must exist, its
   doc_no must match the URL, and the key must be listed in photo_urls. None of
   those three facts says anything about WHICH COMPANY the caller is in.

   That mattered because both routes run on a SERVICE-ROLE supabase client
   (middleware/auth.ts -> getSupabaseService), so RLS is bypassed and the
   handler's own query is the entire authorisation boundary. A doc_no is
   printed on documents, an item id travels in any shared URL, and a photo key
   is derived from both — so a 2990 user who saw any Houzs SO could read its
   photos. Live at the time of the fix: 24 of 117 SCM users belong to 2990 and
   all 570 SO photo keys belong to Houzs.

   The sibling PO route (mfg-purchase-orders.ts) and consignment route
   (consignment-orders.ts) already applied scopeToCompany; the PO route's own
   comment even named the gap out loud ("and, unlike the SO route, to the
   active company"). This suite closes it and pins it shut.

   BOTH DIRECTIONS ARE ASSERTED, deliberately. A scope sweep has two failure
   modes, and only testing the leak catches one of them:
     • the leak — company B reads company A's photo;
     • the over-correction — company A can no longer read its OWN photo,
       which is how a security fix turns into "all the photos went blank".
   Every test below therefore has an own-company twin.

   Harness shape matches companyScopeConsignmentPo.test.ts and the sibling
   photo suite: the exported handlers are mounted on a bare Hono app, because
   the supabaseAuth bridge that builds the real client cannot run here. */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import {
  soItemPhotoSignedHandler,
  soItemPhotoProxyHandler,
} from '../src/scm/routes/mfg-sales-orders';

const CO_A = 1; // HOUZS — owns the photo in every fixture below
const CO_B = 2; // 2990  — the other company, must never reach it

type Row = Record<string, any>;

const DOC = 'HC-SO-002609';
const ITEM = 'item-1';
const KEY = `so-items/${DOC}/${ITEM}/abc-123.jpg`;
const BYTES = 'JPEG-BYTES';

/* Minimal PostgREST fake. These handlers only ever do
   .from(t).select(...).eq('id', x)[.eq('company_id', n)].maybeSingle(), so
   `eq` is the only predicate that has to be real — and it is exactly the one
   under test. `in` is implemented because scopeToCompany's fail-closed branch
   emits `.in('company_id', [])` when the company context is resolved but no
   single active company could be picked. */
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  eq(col: string, val: unknown) {
    this.preds.push((r) => String(r[col]) === String(val));
    return this;
  }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  maybeSingle() {
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    return Promise.resolve({ data: hit[0] ?? null, error: null });
  }
}

/* The R2 binding — the path that serves actual bytes on the proxy route. */
function fakeBucket(objects: Record<string, string>) {
  return {
    get: async (key: string) =>
      objects[key] == null
        ? null
        : { body: objects[key], httpMetadata: { contentType: 'image/jpeg' } },
  };
}

/**
 * One Houzs (company 1) SO line carrying one photo. `companyId` is the ACTIVE
 * company of the caller — the whole variable under test.
 *
 * The R2 creds are supplied so `/signed` takes its SUCCESS path. That is
 * load-bearing for this suite: if signing threw, /signed would fail for
 * everyone and a "company B is refused" assertion would pass for entirely the
 * wrong reason.
 */
function harness(opts: { companyId?: number; allowedCompanyIds?: number[] } = {}) {
  const app = new Hono();
  const rows: Row[] = [
    { id: ITEM, doc_no: DOC, company_id: CO_A, photo_urls: [KEY] },
  ];
  const env: Row = {
    SO_ITEM_PHOTOS_BUCKET_NAME: 'houzs-erp',
    SO_ITEM_PHOTOS: fakeBucket({ [KEY]: BYTES }),
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key',
    R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
  };
  app.use('*', async (c, next) => {
    c.set('supabase' as never, { from: () => new FakeQuery(rows) } as never);
    c.set('companyId' as never, opts.companyId as never);
    if (opts.allowedCompanyIds !== undefined) {
      c.set('allowedCompanyIds' as never, opts.allowedCompanyIds as never);
    }
    c.set('user' as never, { id: 'u1' } as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).env = env;
    await next();
  });
  app.get('/mfg-sales-orders/:docNo/items/:itemId/photos/:photoKey/signed', soItemPhotoSignedHandler as never);
  app.get('/mfg-sales-orders/:docNo/items/:itemId/photos/:photoKey', soItemPhotoProxyHandler as never);
  return app;
}

const signedUrlPath = `/mfg-sales-orders/${DOC}/items/${ITEM}/photos/${encodeURIComponent(KEY)}/signed`;
const proxyPath = `/mfg-sales-orders/${DOC}/items/${ITEM}/photos/${encodeURIComponent(KEY)}`;

describe('GET /photos/:photoKey/signed is company-scoped', () => {
  test('the OWNING company still gets a signed URL (no over-correction)', async () => {
    const res = await harness({ companyId: CO_A }).request(signedUrlPath);
    expect(res.status).toBe(200);
    const body = await res.json();
    // A real presigned URL, not a proxy path — the happy path is intact.
    expect(body.signedUrl).toMatch(/^https:\/\//);
    expect(body.expiresAt).toBeTruthy();
  });

  test('the OTHER company is refused', async () => {
    const res = await harness({ companyId: CO_B }).request(signedUrlPath);
    // 404 not 403: confirming that someone else's document EXISTS is itself a
    // leak, so the refusal is indistinguishable from "no such item".
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('item_not_found');
    // The URL must not leak through the error body either.
    expect(body.signedUrl).toBeUndefined();
  });
});

describe('GET /photos/:photoKey (proxy) is company-scoped', () => {
  test('the OWNING company still receives the bytes', async () => {
    const res = await harness({ companyId: CO_A }).request(proxyPath);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(await res.text()).toBe(BYTES);
  });

  test('the OTHER company gets no bytes', async () => {
    const res = await harness({ companyId: CO_B }).request(proxyPath);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'item_not_found' });
  });

  test('a .thumb sibling is refused for the other company too', async () => {
    /* The proxy authorises a thumb against its BASE key, which is a second
       code path through the same lookup. Scoping the base-key branch and not
       this one would leave the leak open behind a `.thumb` suffix. */
    const thumbKey = `${KEY}.thumb`;
    const path = `/mfg-sales-orders/${DOC}/items/${ITEM}/photos/${encodeURIComponent(thumbKey)}`;
    const res = await harness({ companyId: CO_B }).request(path);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'item_not_found' });
  });
});

describe('unresolved company context', () => {
  test('FAILS CLOSED when the context resolved but no active company was picked', async () => {
    /* allowedCompanyIds set + companyId unset is the "restricted to nothing" /
       missing-switcher-header state. scopeToCompany emits `.in('company_id',
       [])` there, which must match nothing — serving every company's photo
       would be the exact cross-company read this fix exists to prevent. */
    const res = await harness({ allowedCompanyIds: [] }).request(signedUrlPath);
    expect(res.status).toBe(404);
  });

  test('FAILS OPEN for the legacy single-company install (no company context at all)', async () => {
    /* allowedCompanyIds === undefined is pre-migration / a brand-new isolate
       that has never read the companies master. scopeToCompany deliberately
       degrades to no predicate there so a single-company install is never
       blanked. Pinned because "fix the leak" pressure makes this the tempting
       thing to tighten — and tightening it is an app-wide photo outage. */
    const res = await harness({}).request(signedUrlPath);
    expect(res.status).toBe(200);
  });
});
