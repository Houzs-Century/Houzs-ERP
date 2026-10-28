import { Hono, type Context, type Next } from 'hono';
import { describe, expect, test } from 'vitest';

/* ────────────────────────────────────────────────────────────────────────────
   Public image proxy mount order — mirrors the wiring in src/index.ts.

   The cross-origin POS loads product/category images via plain <img src>, which
   carry no Bearer token and no Houzs session cookie. To serve them, index.ts
   mounts a small public router at /api/scm BEFORE the global `auth` middleware,
   so the two image GET routes bypass auth while every OTHER /api/scm path
   (declared only in the gated app, after auth) still 401s.

   This test pins that contract on the Hono routing semantics (first-registered
   matching handler runs first; returning a Response stops the chain before the
   later auth middleware). Stub handlers — the real handlers stream from R2.
   ──────────────────────────────────────────────────────────────────────────── */

function fakeAuth() {
  return async (c: Context, next: Next) => {
    const h = c.req.header('authorization') ?? '';
    if (!h.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
    await next();
  };
}

function buildApp() {
  const app = new Hono();

  // Public image router — the two GET proxies, mounted BEFORE the gate.
  const pub = new Hono();
  pub.get('/product-models/:id/photo/:key', (c) => c.text('IMG'));
  pub.get('/categories/:id/hero-blob', (c) => c.text('HERO'));
  app.route('/api/scm', pub);

  // Global gate (stand-in for `auth` + `requireScmAccess`).
  app.use('/api/*', fakeAuth());

  // The gated scm app — everything else. Note it ALSO declares the photo route
  // (as the real product-models router does); the public one shadows it.
  const scm = new Hono();
  scm.get('/product-models/:id/photo/:key', (c) => c.text('IMG-GATED'));
  scm.get('/mfg-products', (c) => c.text('CATALOG'));
  scm.get('/product-models/:id', (c) => c.text('MODEL'));
  scm.post('/product-models/:id/photo', (c) => c.text('UPLOAD'));
  app.route('/api/scm', scm);

  return app;
}

describe('public image proxy mount order (mirrors src/index.ts)', () => {
  const app = buildApp();

  test('GET a public photo route bypasses auth (no token -> 200)', async () => {
    const res = await app.request('/api/scm/product-models/abc/photo/k.jpg');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('IMG');
  });

  test('GET the public category hero route bypasses auth', async () => {
    const res = await app.request('/api/scm/categories/abc/hero-blob');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('HERO');
  });

  test('a non-image scm GET still requires auth (no token -> 401)', async () => {
    const res = await app.request('/api/scm/mfg-products');
    expect(res.status).toBe(401);
  });

  test('a non-photo product-models GET is still gated', async () => {
    const res = await app.request('/api/scm/product-models/abc');
    expect(res.status).toBe(401);
  });

  test('POST to the photo path is still gated (only the GET proxy is public)', async () => {
    const res = await app.request('/api/scm/product-models/abc/photo', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  test('the public route also works WITH a token (authed callers unaffected)', async () => {
    const res = await app.request('/api/scm/product-models/abc/photo/k.jpg', {
      headers: { authorization: 'Bearer x' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('IMG');
  });
});
