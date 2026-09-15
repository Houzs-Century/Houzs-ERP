// ----------------------------------------------------------------------------
// delivery-order-exports — the Delivery Order list's LINE export, over EVERY
// page the list's filters match (owner 2026-09-15).
//
//   GET /delivery-orders-mfg/export/lines?status=&q=&sort=&from=&to=
//     -> { columns, rows, doCount, lineCount, truncated }
//        One row per DO LINE, NO prices or amounts (the file goes to drivers,
//        3PLs and customers). `columns` is the contract in
//        lib/do-line-export-columns.ts.
//
// It takes the list's query parameters and builds its read through the list's
// own filter (lib/do-list-read.ts) with the caller's own sales scope, so it can
// never match a different set of delivery orders than the list the button was
// pressed on. It takes no `page`.
//
// Its own router because the main one is over its file-size ceiling. Mounted at
// the same `/delivery-orders-mfg` prefix BEFORE the main router, so the static
// `/export/lines` path resolves ahead of `/:id`; the prefix's auth + area guard
// (scm/index.ts) cover it exactly as they cover the list.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { readDoListParams } from '../lib/do-list-read';
import { buildDoLineExport } from '../lib/do-line-export';
import { resolveSalesScopeIds } from '../lib/salesScope';
import { canViewAllSales } from '../lib/houzs-perms';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export async function doLineExportHandler(c: Ctx) {
  const sb = c.get('supabase');
  /* The same row-level visibility as the list (GET /delivery-orders-mfg), and
     the same refusal when there is no Houzs identity to scope by. */
  const canViewAll = canViewAllSales(c);
  const houzsUserId = c.get('houzsUser')?.id;
  if (!canViewAll && houzsUserId == null) {
    return c.json({ error: 'Your account is not linked to a Houzs user, so delivery orders cannot be shown — please contact IT.' }, 403);
  }
  const scopeIds = await resolveSalesScopeIds(sb, c.env, houzsUserId, canViewAll);
  const out = await buildDoLineExport(sb, c, readDoListParams((k) => c.req.query(k)), scopeIds);
  if (out.error !== null) return c.json({ error: 'export_failed', reason: out.error }, 500);
  return c.json(out);
}

export const deliveryOrderExports = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryOrderExports.use('*', supabaseAuth);
deliveryOrderExports.get('/export/lines', doLineExportHandler);
