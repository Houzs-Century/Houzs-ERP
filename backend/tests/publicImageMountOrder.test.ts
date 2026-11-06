import { Hono, type Context, type Next } from 'hono';
import { describe, expect, test } from 'vitest';
import { publicScmImages } from '../src/scm/routes/public-images';
import { isCurrentCompartmentPhoto } from '../src/scm/routes/sofa-compartment-photos';

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
  pub.get('/maintenance-config/sofa-compartments/:code/photo/:key', (c) => c.text('COMP'));
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
  scm.get('/maintenance-config/resolved', (c) => c.text('CONFIG'));
  scm.post('/maintenance-config/sofa-compartments/:code/photo', (c) => c.text('COMP-UPLOAD'));
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

describe('sofa-compartment photo proxy is public, the rest of /maintenance-config is not', () => {
  const app = buildApp();
  const url = '/api/scm/maintenance-config/sofa-compartments/3S/photo/sofa-compartments%2F3S%2Fu.png';

  test('GET a compartment photo with no token -> 200', async () => {
    const res = await app.request(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('COMP');
  });

  test('other /maintenance-config reads stay gated', async () => {
    expect((await app.request('/api/scm/maintenance-config/resolved')).status).toBe(401);
  });

  test('uploading a compartment photo stays gated', async () => {
    const res = await app.request('/api/scm/maintenance-config/sofa-compartments/3S/photo', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  // The stubs above prove the routing; this proves the REAL public router
  // declares exactly the GET image paths, so the mirror can't drift from it.
  test('the real public router exposes only GET image routes', () => {
    const routes = publicScmImages.routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(routes).toEqual([
      'GET /categories/:id/hero-blob',
      'GET /maintenance-config/sofa-compartments/:code/photo/:key',
      'GET /product-models/:id/photo/:key',
    ]);
  });
});

describe('isCurrentCompartmentPhoto (company picked by the key, not the request)', () => {
  const k2 = 'sofa-compartments/3S/new.png';
  const rows = [
    { company_id: 2, meta: { '3S': { imageKey: k2 } } },
    { company_id: 1, meta: { '3S': { imageKey: 'sofa-compartments/3S/houzs.png' } } },
    { company_id: 2, meta: { '3S': { imageKey: 'sofa-compartments/3S/old.png' } } },
  ];

  test("serves company 2's current photo with no company on the request", () => {
    expect(isCurrentCompartmentPhoto(rows, '3S', k2)).toBe(true);
  });

  test("serves another company's current photo too", () => {
    expect(isCurrentCompartmentPhoto(rows, '3S', 'sofa-compartments/3S/houzs.png')).toBe(true);
  });

  test('refuses a key from a superseded row', () => {
    expect(isCurrentCompartmentPhoto(rows, '3S', 'sofa-compartments/3S/old.png')).toBe(false);
  });

  test('refuses a key stored under a different compartment', () => {
    expect(isCurrentCompartmentPhoto(rows, 'CNR', k2)).toBe(false);
  });

  test('refuses when nothing is stored', () => {
    expect(isCurrentCompartmentPhoto([{ company_id: 2, meta: null }], '3S', k2)).toBe(false);
    expect(isCurrentCompartmentPhoto([], '3S', k2)).toBe(false);
  });
});
