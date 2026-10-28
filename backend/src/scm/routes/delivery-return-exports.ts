// ----------------------------------------------------------------------------
// delivery-return-exports — the Delivery Returns list's ONE export, over EVERY
// return the list's filters match for this caller (owner 2026-09-15).
//
//   GET /delivery-returns/export/rows?status=
//     -> { deliveryReturns, total, lineCount, truncated }
//        Every matching return in the list's own row shape (SO number stamped,
//        finance keys stripped for a non-finance caller), each with `lines`
//        (lib/delivery-return-list-read.ts attachDeliveryReturnLines — the read
//        the list itself uses). The browser applies the list's tab, search and
//        column funnels to this set and writes one row per line with the grid's
//        visible columns (DataTable `exportLines`).
//
// Resolves the caller's SALES SCOPE exactly as the list does, so a seller's
// file holds exactly the returns their list shows. No 500-row cap: this pages
// to exhaustion and says when it stopped (`truncated`). Its own router, mounted
// at the same prefix BEFORE the main router so the static `/export/...` path
// resolves ahead of `/:id`.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { resolveSalesScopeIds } from '../lib/salesScope';
import { canViewAllSales, canViewScmFinance } from '../lib/houzs-perms';
import { buildDeliveryReturnExportRows, readDeliveryReturnListFilters } from '../lib/delivery-return-list-read';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export async function deliveryReturnExportRowsHandler(c: Ctx) {
  const sb = c.get('supabase');
  // The REAL Houzs user id, as the list passes it (lib/salesScope.ts).
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));
  const filters = readDeliveryReturnListFilters((k) => c.req.query(k));
  const out = await buildDeliveryReturnExportRows(sb, c, filters, scopeIds, canViewScmFinance(c));
  if (out.error !== null) return c.json({ error: 'export_failed', reason: out.error }, 500);
  return c.json(out);
}

export const deliveryReturnExports = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryReturnExports.use('*', supabaseAuth);
deliveryReturnExports.get('/export/rows', deliveryReturnExportRowsHandler);
