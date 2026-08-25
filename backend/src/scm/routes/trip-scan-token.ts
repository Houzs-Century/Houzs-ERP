// ----------------------------------------------------------------------------
// GET /api/scm/trips/:id/scan-token — mint (lazily) the token the printed
// PACKING LIST's QR encodes.
//
// The trip twin of delivery-order-scan-token.ts, and deliberately the same
// shape: a packing list IS a trip (scm/lib/packing-list-view.ts, "A PACKING
// LIST IS A TRIP, RENDERED"), so it gets the same column pair (mig 0329), the
// same atomic claim and the same lazy mint rather than a second mechanism.
//
// A SEPARATE FILE mounted on the same prefix, like its delivery-order sibling:
// trips.ts is a large router and this keeps it from growing, and this repo
// already mounts two routers on one prefix (/grns, /purchase-invoices,
// /mfg-sales-orders in scm/index.ts). Mounted BEFORE the main trips router; the
// two-segment '/:id/scan-token' cannot shadow its one-segment '/packing'.
//
// WHY A GET, WHEN IT CAN WRITE — the same answer as the delivery-order side:
// the write is an idempotent create-if-missing, nothing about the trip changes,
// and a POST would read as a write to the area guard, denying the QR to somebody
// who may PRINT a packing list but not edit the run.
//
// THE COMPANY COMES FROM THE SESSION HERE, because there is one. That is the
// only difference between this endpoint and the public one, and it is why
// minting lives on this side of the gate.
//
// ONE NOTE ON SCOPE, because trips is not like the other modules. Trips is a
// CROSS-COMPANY queue: its reads and writes WIDEN to the caller's granted
// companies (scopeToAllowedCompanies), not to one active company. This mint is
// deliberately the STRICTER of the two — requireActiveCompanyId + an equality
// predicate — because the thing being minted is a PUBLIC credential, and the
// public route it unlocks pins every write to the run's own company. Minting a
// public token for a run you can merely SEE, rather than one you are working
// in, is a wider door than this feature needs.
// ----------------------------------------------------------------------------
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { requireActiveCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { getOrCreateScanToken } from '../lib/do-scan-token';

export const tripScanToken = new Hono<{ Bindings: Env; Variables: Variables }>();
tripScanToken.use('*', supabaseAuth);

tripScanToken.get('/:id/scan-token', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const minted = await getOrCreateScanToken(sb, 'trips', id, co.companyId);
  /* A FAILED READ IS NOT A MISSING RUN. supabase-js does not throw, so the two
     arrive identically unless the error is bound, and answering 404 to a blip
     sends the dispatcher hunting for a packing list that is right there. */
  if (minted.status === 'read_failed') {
    return c.json({
      error: 'scan_token_unavailable',
      message: "We couldn't reach this run just now. Try printing again in a moment.",
    }, 503);
  }
  if (minted.status === 'not_found') return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ scanToken: minted.token });
});
