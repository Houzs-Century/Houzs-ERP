// ----------------------------------------------------------------------------
// mfg-purchase-orders-list-enrichment — the DEFERRED half of the PO list.
//
// Opening the Purchase Orders list used to run a full company-wide `computeMrp`
// on the critical path: the list resolved its "Assigned SO" / "Delivered"
// columns through resolvePoSoCoverageForPos, which runs the global MRP engine
// once per load (~4s, the list's dominant cost — the same disease #2433 cured on
// the SO list and the PI list got cured of before this). The list now returns
// immediately WITHOUT those four columns, and the client calls THIS endpoint
// once, for the page it just rendered, to heal them a beat later:
//
//   GET /mfg-purchase-orders/list-mrp-enrichment?poIds=UUID,UUID,UUID
//     -> { enrichment: { [poId]: { assigned_sos, assigned_so_linked,
//                                   assigned_so_provenance, delivered_dos } } }
//
// It re-reads the requested PO ids under the SAME company scope the list applies
// (the tenant boundary — a spoofed id from another company yields nothing), then
// runs the SAME resolvers the list used to run inline, so the healed values are
// byte-identical to the old path, only deferred.
//
// Its own thin router, mounted at the same `/mfg-purchase-orders` prefix (Hono
// resolves this static path ahead of the main router's `/:id`). Auth + the
// scm.procurement.po area guard cover it via the shared `/mfg-purchase-orders/*`
// middleware in scm/index.ts, exactly as they cover the list.
//
// Fail-soft, like the list: the resolvers already swallow their own errors to
// empty summaries, so a failed MRP drops to empty Assigned-SO / Delivered cells
// and never 500s the page.
// ----------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- the untyped supabase-js client and Hono context this SCM tree passes around (see companyScope.ts header). */
import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { scopeToCompany } from '../lib/companyScope';
import { resolvePoSoCoverageForPos, resolveDeliveredDosForPos } from './po-so-coverage';
export { LIST_MRP_ENRICHMENT_KEYS } from '../lib/list-mrp-enrichment-keys';

export const mfgPurchaseOrdersListEnrichment = new Hono<{ Bindings: Env; Variables: Variables }>();
mfgPurchaseOrdersListEnrichment.use('*', supabaseAuth);

/* One list page is capped at 100 rows, so a well-behaved client asks for at most
   that many. Bound it defensively — the endpoint is read-only, but computeMrp
   downstream is company-wide work. */
const MAX_IDS = 200;

mfgPurchaseOrdersListEnrichment.get('/list-mrp-enrichment', async (c) => {
  const sb = c.get('supabase') as any;

  const raw = (c.req.query('poIds') ?? '').trim();
  const poIds = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_IDS);
  if (poIds.length === 0) return c.json({ enrichment: {} });

  /* Re-read the ids under the company predicate — the tenant boundary. The ids
     come from a page the client already received, so this is also defence in
     depth: an id from another company simply does not come back. */
  const { data, error } = await scopeToCompany(
    sb.from('purchase_orders').select('id'), c,
  ).in('id', poIds);
  if (error) return c.json({ error: 'enrichment_failed', reason: error.message }, 500);

  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (ids.length === 0) return c.json({ enrichment: {} });

  /* The SAME two resolvers the list used to run inline (assigned + delivered).
     Neither consumes the other's result, so both go out as one wave. */
  const [assignedByPo, deliveredByPo] = await Promise.all([
    resolvePoSoCoverageForPos(sb, c, ids),
    resolveDeliveredDosForPos(sb, c, ids),
  ]);

  const enrichment: Record<string, Record<string, unknown>> = {};
  for (const id of ids) {
    enrichment[id] = {
      assigned_sos: assignedByPo.get(id)?.assignedSos ?? [],
      assigned_so_linked: assignedByPo.get(id)?.sourceLinked ?? false,
      assigned_so_provenance: assignedByPo.get(id)?.provenanceSos ?? [],
      delivered_dos: deliveredByPo.get(id)?.deliveredDos ?? [],
    };
  }
  return c.json({ enrichment });
});
