// ----------------------------------------------------------------------------
// purchase-order-exports — the Purchase Order list's two exports, over EVERY
// page the list's filters match.
//
//   GET /mfg-purchase-orders/export/lines?status=&q=&sort=&supplierId=&from=&to=
//     -> { columns, rows, poCount, lineCount, truncated }
//        One row per PO LINE (owner 2026-09-15, the AutoCount "PO chasing list"
//        shape). `columns` is the contract in lib/po-line-export-columns.ts.
//
//   GET /mfg-purchase-orders/export/headers?status=&q=&sort=&supplierId=&from=&to=
//     -> { purchaseOrders, total, truncated }
//        One row per PO, in the list's own row shape, so the list's column
//        definitions export it unchanged. The MRP-derived columns are healed by
//        the client through /list-mrp-enrichment, exactly as on screen.
//
// Both take the list's query parameters and build their read through the
// list's filter (lib/po-list-read.ts), so an export can never match a different
// set of orders than the tab it was pressed on. Neither takes `page`.
//
// Its own router because the main one is over its file-size ceiling. Mounted at
// the same `/mfg-purchase-orders` prefix BEFORE the main router, so the static
// `/export/...` paths resolve ahead of `/:id`; the prefix's auth + area guard
// (scm/index.ts) cover it exactly as they cover the list.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { pageWithTruncation } from '../lib/outstanding-po-lines';
import { PO_LIST_SELECT, filterPoList, orderPoList, readPoListFilters, stampPoListGrns } from '../lib/po-list-read';
import { buildPoLineExport } from '../lib/po-line-export';
import { VALID_STATUSES } from './mfg-purchase-orders';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export async function poLineExportHandler(c: Ctx) {
  const filters = readPoListFilters((k) => c.req.query(k));
  const out = await buildPoLineExport(c.get('supabase'), c, filters, VALID_STATUSES);
  if (out.error !== null) return c.json({ error: 'export_failed', reason: out.error }, 500);
  return c.json(out);
}

export async function poHeaderExportHandler(c: Ctx) {
  const sb = c.get('supabase');
  const filters = readPoListFilters((k) => c.req.query(k));
  const read = await pageWithTruncation<{ id: string } & Record<string, unknown>>((from, to) =>
    orderPoList(filterPoList(sb.from('purchase_orders').select(PO_LIST_SELECT), filters, c, VALID_STATUSES), filters.sort)
      .range(from, to));
  if (read.error) return c.json({ error: 'export_failed', reason: read.error.message }, 500);
  const stamped = await stampPoListGrns(sb, read.data ?? []);
  if (stamped.error) return c.json({ error: 'export_failed', reason: `GRNs: ${stamped.error}` }, 500);
  const purchaseOrders = stamped.rows;
  return c.json({ purchaseOrders, total: purchaseOrders.length, truncated: read.truncated });
}

export const purchaseOrderExports = new Hono<{ Bindings: Env; Variables: Variables }>();
purchaseOrderExports.use('*', supabaseAuth);
purchaseOrderExports.get('/export/lines', poLineExportHandler);
purchaseOrderExports.get('/export/headers', poHeaderExportHandler);
