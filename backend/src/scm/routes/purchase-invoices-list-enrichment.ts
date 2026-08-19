// ----------------------------------------------------------------------------
// purchase-invoices-list-enrichment — the DEFERRED half of the PI list.
//
// Opening the Purchase Invoices list used to run a full company-wide `computeMrp`
// on the critical path: the list called attachPiAssignedSos, which resolves the
// "Assigned SO" / "Delivered" columns through resolvePoSoCoveragePerSkuForPos,
// and THAT runs the global MRP engine once per load (~4s, the list's dominant
// cost — same disease the SO list had before #2433). The list now returns
// immediately WITHOUT those four columns, and the client calls this endpoint
// once, for the page it just rendered, to heal them a beat later:
//
//   GET /purchase-invoices/list-mrp-enrichment?piIds=UUID,UUID,UUID
//     -> { enrichment: { [piId]: { assigned_sos, assigned_so_linked,
//                                   assigned_so_provenance, delivered_dos } } }
//
// It re-reads each requested PI's (id, grn_id) under the SAME company scope the
// list applies (the tenant boundary — a spoofed id from another company yields
// nothing), then runs the SAME attachPiAssignedSos the list used to run inline,
// so the healed values are byte-identical to the old path, only deferred.
//
// Its own thin router, mounted at the same `/purchase-invoices` prefix (Hono
// resolves this static path ahead of the main router's `/:id`). Auth + the
// scm.procurement.pi area guard cover it via the shared `/purchase-invoices/*`
// middleware in scm/index.ts, exactly as they cover the list.
//
// Fail-soft, exactly like the list: attachPiAssignedSos already swallows its own
// errors to empty columns, so a failed MRP drops to empty Assigned-SO / Delivered
// cells and never 500s the page.
// ----------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- the untyped supabase-js client and Hono context this SCM tree passes around (see companyScope.ts header). */
import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { scopeToCompany } from '../lib/companyScope';
import { attachPiAssignedSos, pickPiListMrpEnrichment } from '../lib/pi-assigned-sos';

export const purchaseInvoicesListEnrichment = new Hono<{ Bindings: Env; Variables: Variables }>();
purchaseInvoicesListEnrichment.use('*', supabaseAuth);

/* One list page is capped at 100 rows (the list handler's pageSize cap), so a
   well-behaved client asks for at most that many. Bound it defensively — the
   endpoint is read-only, but computeMrp downstream is company-wide work and
   there is no reason to fan a giant unbounded list into it. */
const MAX_IDS = 200;

purchaseInvoicesListEnrichment.get('/list-mrp-enrichment', async (c) => {
  const sb = c.get('supabase') as any;

  const raw = (c.req.query('piIds') ?? '').trim();
  const piIds = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_IDS);
  if (piIds.length === 0) return c.json({ enrichment: {} });

  /* Re-read (id, grn_id) under the company predicate — the tenant boundary. The
     ids come from a page the client already received, so this is also defence
     in depth: an id from another company simply does not come back. */
  const { data, error } = await scopeToCompany(
    sb.from('purchase_invoices').select('id, grn_id'), c,
  ).in('id', piIds);
  if (error) return c.json({ error: 'enrichment_failed', reason: error.message }, 500);

  const rows = (data ?? []) as Array<{ id: string; grn_id: string | null }>;
  if (rows.length === 0) return c.json({ enrichment: {} });

  const enriched = await attachPiAssignedSos(sb, c, rows);

  const enrichment: Record<string, Record<string, unknown>> = {};
  for (const r of enriched) {
    const id = r.id as string;
    if (id) enrichment[id] = pickPiListMrpEnrichment(r);
  }
  return c.json({ enrichment });
});
