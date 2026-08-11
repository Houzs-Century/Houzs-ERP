// ----------------------------------------------------------------------------
// Public SCM image proxies — for the cross-origin POS.
//
// Houzs gates ALL of /api/scm/* behind the global `auth` + `requireScmAccess`
// (main index.ts). NOTE (corrected 2026-08-10): this comment used to claim the
// same-origin Houzs SPA passes that gate "with its session cookie", so its
// <img src="/api/scm/.../photo/..."> loads fine. That is FALSE and it cost a
// debugging session — there is no cookie session anywhere in this app. Auth is
// bearer-token-only: the token lives in session/localStorage and is stamped
// explicitly by authedFetch, `auth` reads ONLY the Authorization header, and
// backend/src has zero Set-Cookie. A plain <img src> therefore 401s from the
// SAME origin too, which is exactly why these two handlers are mounted OUTSIDE
// the gate. An authed image elsewhere in the SPA must be blob-fetched and
// handed to <img> as an object URL (see frontend slip.ts, lorries-queries.ts,
// and SoLineCard's PhotoThumb proxy fallback).
//
// The 2990 POS is additionally a DIFFERENT origin authenticating with a Bearer
// token — a plain <img src> from there carries no Authorization header either.
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
