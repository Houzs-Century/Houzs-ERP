// ----------------------------------------------------------------------------
// Public SCM image proxies — for the cross-origin POS.
//
// Houzs gates ALL of /api/scm/* behind the global `auth` + `requireScmAccess`
// (main index.ts).
//
// CORRECTED 2026-08-10 — this comment used to claim "the same-origin Houzs SPA
// passes that with its session cookie, so its <img src=...> loads fine". That
// was FALSE and actively misleading. There is no cookie session anywhere in
// this app: `Set-Cookie` appears nowhere in backend/src, and middleware/auth.ts
// reads the token ONLY from the Authorization header
// (`c.req.header("Authorization")`). A browser attaches no such header to an
// <img src>, so a plain <img> pointed at a gated /api/scm/* path 401s from the
// SAME origin too — not just cross-origin. index.ts states this correctly
// ("no Bearer, no same-origin cookie"), as does tests/publicImageMountOrder.ts.
//
// That is precisely why these two routes are mounted OUTSIDE the gate: they are
// the only image URLs in the app usable as a bare <img src>. Every other photo
// surface (SO / PO / consignment line photos) must be fetched with the bearer
// token and turned into a blob object URL — see scm/lib/photoProxyFallback.ts.
//
// 2990 solved the exact same cross-origin problem by serving Model photos from
// an auth-free proxy (apps/api/src/routes/product-models.ts:35 — registered
// before that sub-app's own supabaseAuth, and 2990 has no global gate). We
// replicate it FAITHFULLY: mount the SAME two handlers OUTSIDE /api/scm (in
// index.ts, before the global gates) so no auth runs ahead of them.
//
// Safe because each handler validates the requested key against the row's
// stored path / hero key and streams from R2 by id — a guessed key can't leak
// another object. ONLY these two GET routes are exposed here; every other
// /api/scm/* path still hits the gates (they are not re-declared in this router).
// Single source of truth: the handlers live in product-models.ts / categories.ts
// and are imported, not copied.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { modelPhotoProxyHandler } from './product-models';
import { categoryHeroBlobHandler } from './categories';
import type { Env, Variables } from '../env';

export const publicScmImages = new Hono<{ Bindings: Env; Variables: Variables }>();

// Full paths (mounted at /api/scm in index.ts):
//   GET /api/scm/product-models/:id/photo/:key
//   GET /api/scm/categories/:id/hero-blob
publicScmImages.get('/product-models/:id/photo/:key', modelPhotoProxyHandler);
publicScmImages.get('/categories/:id/hero-blob', categoryHeroBlobHandler);
