// ----------------------------------------------------------------------------
// sales-order-exports — the Sales Order list's ONE export, over EVERY page the
// list's filters match (owner 2026-09-15).
//
//   GET /mfg-sales-orders/export/rows?status=&q=&sort=&from=&to=&f=...&offset=&limit=
//     -> { salesOrders, total, lineCount, next }
//        One WINDOW (at most EXPORT_WINDOW, lib/document-line-export.ts) of the
//        matching orders; `next` is the offset to ask for next, null after the
//        last. Windows keep one request under the Worker subrequest cap. Every
//        matching order in the list's own row shape (lib/so-list-rows.ts,
//        the list handler's builder), each with `lines` and the AutoCount header
//        spellings (lib/so-list-lines.ts attachSoLines — the same read the list
//        page uses). The browser applies the grid's funnels and writes one row
//        per line with the grid's visible columns (DataTable `exportLines`).
//
// It takes the list's query parameters, `f` rows included, and reads through the
// list's own predicate set (lib/so-list-read.ts) with the caller's own sales
// scope, so it can never match a different set of orders than the list. It takes
// no `page`.
//
// Its own router because the main one is over its file-size ceiling. Mounted at
// the same `/mfg-sales-orders` prefix BEFORE the main router, so the static
// `/export/rows` path resolves ahead of `/:docNo`; the prefix's auth + area guard
// (scm/index.ts) cover it exactly as they cover the list.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { prepareSoListRead, readSoListParams } from '../lib/so-list-read';
import { buildSoExportRows } from '../lib/so-list-lines';
import { readExportWindow } from '../lib/document-line-export';
import { resolveSalesScopeIds } from '../lib/salesScope';
import { canViewAllSales } from '../lib/houzs-perms';
import { SO_LIST_COLS } from './mfg-sales-orders';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export async function soExportRowsHandler(c: Ctx) {
  const sb = c.get('supabase');
  /* The same row-level visibility as the list: view-all callers see every
     order, everyone else their own + downline (lib/salesScope.ts). */
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));
  const params = readSoListParams((k) => c.req.query(k), (k) => c.req.queries(k));
  const read = await prepareSoListRead(sb, c, params, scopeIds, c.get('houzsUser')?.id ?? null, new Date());
  if (!read.ok) return c.json(read.body, read.status);
  const out = await buildSoExportRows(sb, c, read, params.sort, SO_LIST_COLS, readExportWindow((k) => c.req.query(k)));
  if (out.error !== null) return c.json({ error: 'export_failed', reason: out.error }, 500);
  return c.json(out);
}

export const salesOrderExports = new Hono<{ Bindings: Env; Variables: Variables }>();
salesOrderExports.use('*', supabaseAuth);
salesOrderExports.get('/export/rows', soExportRowsHandler);
