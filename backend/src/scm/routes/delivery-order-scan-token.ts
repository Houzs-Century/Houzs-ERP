// ----------------------------------------------------------------------------
// GET /api/scm/delivery-orders-mfg/:id/scan-token — mint (lazily) the token the
// printed QR encodes.
//
// A SEPARATE FILE, mounted at the same prefix, and that is not a style choice:
// delivery-orders-mfg.ts is already past its file-size ceiling
// (scripts/file-size-ceilings.json), a ceiling may only FALL, and this repo
// already mounts two routers on one prefix where a router had to grow
// (scm/index.ts does it for /grns, /purchase-invoices and /mfg-sales-orders).
//
// WHY A GET, WHEN IT CAN WRITE. The write is a lazy create-if-missing: the
// first call mints, every later call returns the same value, and nothing about
// the delivery order changes. The alternative — POST — reads as a write to the
// area guard, which would mean a person who may PRINT a delivery order but not
// EDIT one could not obtain the QR for the paper they are holding. Hookka's
// equivalent is a GET for the same reason.
//
// The public route may only ever RESOLVE a token. Minting lives here, behind the
// session, and doScanTokenRoutes is asserted never to be reachable without one.
// ----------------------------------------------------------------------------
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { requireActiveCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { getOrCreateDoScanToken } from '../lib/do-scan-token';

export const deliveryOrderScanToken = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryOrderScanToken.use('*', supabaseAuth);

deliveryOrderScanToken.get('/:id/scan-token', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  /* The company comes from the SESSION here, because there is one. That is the
     only difference between this endpoint and the public one, and it is why
     minting lives on this side of the gate: a caller cannot ask for a token
     belonging to books they are not in. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const minted = await getOrCreateDoScanToken(sb, id, co.companyId);
  /* A FAILED READ IS NOT A MISSING DOCUMENT. supabase-js does not throw, so the
     two arrive identically unless the error is bound — and answering 404 to a
     database blip sends the operator hunting for a delivery order that is right
     in front of them. 503 says what actually happened: try again. */
  if (minted.status === 'read_failed') {
    return c.json({
      error: 'scan_token_unavailable',
      message: "We couldn't reach the delivery order just now. Try printing again in a moment.",
    }, 503);
  }
  if (minted.status === 'not_found') return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ scanToken: minted.token });
});
