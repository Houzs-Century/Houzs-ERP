// ----------------------------------------------------------------------------
// purchase-return-exports — the Purchase Returns list's ONE export, over EVERY
// return the list's filters match (owner 2026-09-15).
//
//   GET /purchase-returns/export/rows?status=&supplierId=
//     -> { purchaseReturns, total, lineCount, truncated }
//        Every matching return in the list's own row shape, each with `lines`
//        (lib/purchase-return-list-read.ts attachPurchaseReturnLines — the read
//        the list itself uses). The browser applies the list's tab, search and
//        column funnels to this set and writes one row per line with the grid's
//        visible columns (DataTable `exportLines`).
//
// No 300-row cap: the list's screen read stops at 300, this pages to exhaustion
// and says when it stopped (`truncated`). Its own router, mounted at the same
// prefix BEFORE the main router so the static `/export/...` path resolves ahead
// of `/:id`; the prefix's auth + area guard (scm/index.ts) cover it exactly as
// they cover the list.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { buildPurchaseReturnExportRows, readPurchaseReturnListFilters } from '../lib/purchase-return-list-read';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export async function purchaseReturnExportRowsHandler(c: Ctx) {
  const filters = readPurchaseReturnListFilters((k) => c.req.query(k));
  const out = await buildPurchaseReturnExportRows(c.get('supabase'), c, filters);
  if (out.error !== null) return c.json({ error: 'export_failed', reason: out.error }, 500);
  return c.json(out);
}

export const purchaseReturnExports = new Hono<{ Bindings: Env; Variables: Variables }>();
purchaseReturnExports.use('*', supabaseAuth);
purchaseReturnExports.get('/export/rows', purchaseReturnExportRowsHandler);
