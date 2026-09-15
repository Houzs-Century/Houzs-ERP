// ----------------------------------------------------------------------------
// sales-order-exports — the Sales Order list's LINE export, over EVERY page the
// list's filters match (owner 2026-09-15).
//
//   GET /mfg-sales-orders/export/lines?status=&q=&sort=&from=&to=&f=...
//     -> { columns, rows, soCount, lineCount, truncated }
//        One row per SO LINE. `columns` is the contract in
//        lib/so-line-export-columns.ts.
//
// It takes the list's query parameters, `f` rows included, and builds its read
// through the list's own predicate set (lib/so-list-read.ts) with the caller's
// own sales scope, so it can never match a different set of orders than the
// list the button was pressed on. It takes no `page`.
//
// No screen calls it yet (2026-09-15): the owner wants ONE Export per list whose
// columns are the grid's visible columns, one row per line, and that grid-level
// mechanism is being built separately. This is the server half it will read.
//
// Its own router because the main one is over its file-size ceiling. Mounted at
// the same `/mfg-sales-orders` prefix BEFORE the main router, so the static
// `/export/lines` path resolves ahead of `/:docNo`; the prefix's auth + area
// guard (scm/index.ts) cover it exactly as they cover the list.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { prepareSoListRead, readSoListParams } from '../lib/so-list-read';
import { buildSoLineExport } from '../lib/so-line-export';
import { resolveSalesScopeIds } from '../lib/salesScope';
import { canViewAllSales } from '../lib/houzs-perms';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export async function soLineExportHandler(c: Ctx) {
  const sb = c.get('supabase');
  /* The same row-level visibility as the list: view-all callers see every
     order, everyone else their own + downline (lib/salesScope.ts). */
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));
  const params = readSoListParams((k) => c.req.query(k), (k) => c.req.queries(k));
  const read = await prepareSoListRead(sb, c, params, scopeIds, c.get('houzsUser')?.id ?? null, new Date());
  if (!read.ok) return c.json(read.body, read.status);
  const out = await buildSoLineExport(sb, c, read, params.sort);
  if (out.error !== null) return c.json({ error: 'export_failed', reason: out.error }, 500);
  return c.json(out);
}

export const salesOrderExports = new Hono<{ Bindings: Env; Variables: Variables }>();
salesOrderExports.use('*', supabaseAuth);
salesOrderExports.get('/export/lines', soLineExportHandler);
