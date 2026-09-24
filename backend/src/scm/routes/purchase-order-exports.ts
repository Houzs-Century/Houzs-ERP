// ----------------------------------------------------------------------------
// purchase-order-exports — the Purchase Order list's ONE export, over EVERY
// page the list's filters match (owner 2026-09-15).
//
//   GET /mfg-purchase-orders/export/rows?status=&q=&sort=&supplierId=&from=&to=
//     -> { purchaseOrders, total, lineCount, truncated }
//        Every matching PO in the list's own row shape (GRN stamp included),
//        each with `lines` (lib/po-line-export.ts attachPoLines — the same read
//        the list page uses). The browser applies the grid's column funnels to
//        this set and writes one row per line with the grid's visible columns
//        (DataTable `exportLines`). The MRP-derived columns are healed by the
//        client through /list-mrp-enrichment, exactly as on screen.
//
// Takes the list's query parameters and reads through the list's filter
// (lib/po-list-read.ts), so the export can never match a different set of
// orders than the tab it was pressed on. It takes no `page`.
//
// Its own router because the main one is over its file-size ceiling. Mounted at
// the same `/mfg-purchase-orders` prefix BEFORE the main router, so the static
// `/export/...` path resolves ahead of `/:id`; the prefix's auth + area guard
// (scm/index.ts) cover it exactly as they cover the list.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { readPoListFilters } from '../lib/po-list-read';
import { buildPoExportRows } from '../lib/po-line-export';
import { buildPoFacets } from '../lib/po-list-facets';
import { VALID_STATUSES } from './mfg-purchase-orders';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export async function poExportRowsHandler(c: Ctx) {
  const filters = readPoListFilters((k) => c.req.query(k));
  const out = await buildPoExportRows(c.get('supabase'), c, filters, VALID_STATUSES);
  if (out.error !== null) return c.json({ error: 'export_failed', reason: out.error }, 500);
  return c.json(out);
}

/* GET /mfg-purchase-orders/facets?<list params> -> { facets, truncated }
   The funnel option counts over every matching order (lib/po-list-facets.ts). */
export async function poFacetsHandler(c: Ctx) {
  const filters = readPoListFilters((k) => c.req.query(k));
  const out = await buildPoFacets(c.get('supabase'), c, filters, VALID_STATUSES);
  if (out.error !== null) return c.json({ error: 'facets_failed', reason: out.error }, 500);
  return c.json(out);
}

export const purchaseOrderExports = new Hono<{ Bindings: Env; Variables: Variables }>();
purchaseOrderExports.use('*', supabaseAuth);
purchaseOrderExports.get('/export/rows', poExportRowsHandler);
purchaseOrderExports.get('/facets', poFacetsHandler);
