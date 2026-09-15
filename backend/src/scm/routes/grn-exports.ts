// ----------------------------------------------------------------------------
// grn-exports — the Goods Received list's two exports, over EVERY page the
// list's filters match (owner 2026-09-15).
//
//   GET /grns/export/lines?status=&q=&sort=&supplierId=&from=&to=
//     -> { columns, rows, grnCount, lineCount, truncated }
//        One row per receipt LINE. `columns` is the contract in
//        lib/grn-line-export-columns.ts.
//
//   GET /grns/export/headers?status=&q=&sort=&supplierId=&from=&to=
//     -> { grns, total, truncated }
//        One row per receipt, in the list's own row shape, so the list's column
//        definitions export it unchanged. The MRP-derived columns are healed by
//        the client through /list-mrp-enrichment, exactly as on screen.
//
// Both build their read through the list's filter (lib/grn-list-read.ts), so an
// export can never match a different set of receipts than the tab it was
// pressed on. Neither takes `page`.
//
// Its own router because routes/grns.ts is over its file-size ceiling. Mounted
// at the same `/grns` prefix BEFORE the main router, so the static `/export/...`
// paths resolve ahead of `/:id`; the prefix's auth + area guard (scm/index.ts)
// cover it exactly as they cover the list. Same layout as
// routes/purchase-order-exports.ts.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { pageWithTruncation } from '../lib/outstanding-po-lines';
import { GRN_LIST_SELECT, filterGrnList, orderGrnList, readGrnListFilters } from '../lib/grn-list-read';
import { buildGrnLineExport } from '../lib/grn-line-export';
import { readGrnExportRows } from '../lib/grn-export-rows';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export async function grnLineExportHandler(c: Ctx) {
  const filters = readGrnListFilters((k) => c.req.query(k));
  const out = await buildGrnLineExport(c.get('supabase'), c, filters);
  if (out.error !== null) return c.json({ error: 'export_failed', reason: out.error }, 500);
  return c.json(out);
}

export async function grnHeaderExportHandler(c: Ctx) {
  const sb = c.get('supabase');
  const filters = readGrnListFilters((k) => c.req.query(k));
  const read = await pageWithTruncation<{ id: string } & Record<string, unknown>>((from, to) =>
    orderGrnList(filterGrnList(sb.from('grns').select(GRN_LIST_SELECT), filters, c), filters.sort).range(from, to));
  if (read.error) return c.json({ error: 'export_failed', reason: read.error.message }, 500);
  const grns = read.data ?? [];
  return c.json({ grns, total: grns.length, truncated: read.truncated });
}

/* GET /grns/export/rows — every receipt the list's filter matches, each
   carrying its lines (lib/grn-export-rows.ts), for the grid-driven export.
   `{ grns, total, lineCount, truncated }`. */
export async function grnExportRowsHandler(c: Ctx) {
  const filters = readGrnListFilters((k) => c.req.query(k));
  const out = await readGrnExportRows(c.get('supabase'), c, filters);
  if (out.error !== null) return c.json({ error: 'export_failed', reason: out.error }, 500);
  return c.json({ grns: out.rows, total: out.rows.length, lineCount: out.lineCount, truncated: out.truncated });
}

export const grnExports = new Hono<{ Bindings: Env; Variables: Variables }>();
grnExports.use('*', supabaseAuth);
grnExports.get('/export/lines', grnLineExportHandler);
grnExports.get('/export/headers', grnHeaderExportHandler);
grnExports.get('/export/rows', grnExportRowsHandler);
