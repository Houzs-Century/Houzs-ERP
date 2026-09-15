// ----------------------------------------------------------------------------
// delivery-order-exports — the Delivery Order list's ONE export, over EVERY
// page the list's filters match (owner 2026-09-15).
//
//   GET /delivery-orders-mfg/export/rows?status=&q=&sort=&from=&to=&offset=&limit=
//     -> { deliveryOrders, total, lineCount, next }
//        One WINDOW (at most EXPORT_WINDOW, lib/document-line-export.ts) of the
//        matching delivery orders; `next` is the offset to ask for next, null
//        after the last. Every matching delivery order in the list's own row shape
//        (lib/do-list-rows.ts, the list handler's builder), each with `lines`
//        and the AutoCount header spellings (lib/do-list-lines.ts attachDoLines
//        — the same read the list page uses). The lines carry NO price or amount
//        (the file goes to drivers, 3PLs and customers). The browser applies the
//        grid's funnels and writes one row per line with the visible columns.
//
// It takes the list's query parameters and reads through the list's own filter
// (lib/do-list-read.ts) with the caller's sales scope, so it can never match a
// different set of delivery orders than the list. It takes no `page`.
//
// Its own router because the main one is over its file-size ceiling. Mounted at
// the same `/delivery-orders-mfg` prefix BEFORE the main router, so the static
// `/export/rows` path resolves ahead of `/:id`; the prefix's auth + area guard
// (scm/index.ts) cover it exactly as they cover the list.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { readDoListParams } from '../lib/do-list-read';
import { buildDoExportRows } from '../lib/do-list-lines';
import { readExportWindow } from '../lib/document-line-export';
import { resolveSalesScopeIds } from '../lib/salesScope';
import { canViewAllSales } from '../lib/houzs-perms';
import { DO_LIST_HEADER, DO_LIST_ROW_DEPS } from './delivery-orders-mfg';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export async function doExportRowsHandler(c: Ctx) {
  const sb = c.get('supabase');
  /* The same row-level visibility as the list (GET /delivery-orders-mfg), and
     the same refusal when there is no Houzs identity to scope by. */
  const canViewAll = canViewAllSales(c);
  const houzsUserId = c.get('houzsUser')?.id;
  if (!canViewAll && houzsUserId == null) {
    return c.json({ error: 'Your account is not linked to a Houzs user, so delivery orders cannot be shown — please contact IT.' }, 403);
  }
  const scopeIds = await resolveSalesScopeIds(sb, c.env, houzsUserId, canViewAll);
  const out = await buildDoExportRows(sb, c, readDoListParams((k) => c.req.query(k)), scopeIds, DO_LIST_HEADER, DO_LIST_ROW_DEPS, readExportWindow((k) => c.req.query(k)));
  if (out.error !== null) return c.json({ error: 'export_failed', reason: out.error }, 500);
  return c.json(out);
}

export const deliveryOrderExports = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryOrderExports.use('*', supabaseAuth);
deliveryOrderExports.get('/export/rows', doExportRowsHandler);
