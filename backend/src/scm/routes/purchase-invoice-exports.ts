// ----------------------------------------------------------------------------
// purchase-invoice-exports — the Purchase Invoices list's two exports, over
// EVERY page the list's filters match (owner 2026-09-15).
//
//   GET /purchase-invoices/export/lines?status=&q=&sort=&from=&to=
//     -> { columns, rows, piCount, lineCount, truncated }
//        One row per invoice LINE. `columns` is the contract in
//        lib/pi-line-export-columns.ts.
//
//   GET /purchase-invoices/export/headers?status=&q=&sort=&from=&to=
//     -> { purchaseInvoices, total, truncated }
//        One row per invoice, in the list's own row shape, so the list's column
//        definitions export it unchanged. The MRP-derived columns and the
//        "vs PO price" marker are healed by the client through
//        /list-mrp-enrichment and /list-po-price, exactly as on screen.
//
// Both build their read through the list's filter (lib/pi-list-read.ts). Its
// own router, mounted at the same prefix BEFORE the main router so the static
// `/export/...` paths resolve ahead of `/:id` — the layout of
// routes/purchase-order-exports.ts.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { pageWithTruncation } from '../lib/outstanding-po-lines';
import { PI_LIST_SELECT, filterPiList, orderPiList, readPiListFilters } from '../lib/pi-list-read';
import { buildPiLineExport } from '../lib/pi-line-export';
import { readPiExportRows } from '../lib/pi-export-rows';
import { todayMyt } from '../lib/my-time';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export async function piLineExportHandler(c: Ctx) {
  const filters = readPiListFilters((k) => c.req.query(k));
  const out = await buildPiLineExport(c.get('supabase'), c, filters, todayMyt());
  if (out.error !== null) return c.json({ error: 'export_failed', reason: out.error }, 500);
  return c.json(out);
}

export async function piHeaderExportHandler(c: Ctx) {
  const sb = c.get('supabase');
  const filters = readPiListFilters((k) => c.req.query(k));
  const read = await pageWithTruncation<{ id: string } & Record<string, unknown>>((from, to) =>
    orderPiList(filterPiList(sb.from('purchase_invoices').select(PI_LIST_SELECT), filters, c), filters.sort).range(from, to));
  if (read.error) return c.json({ error: 'export_failed', reason: read.error.message }, 500);
  const purchaseInvoices = read.data ?? [];
  return c.json({ purchaseInvoices, total: purchaseInvoices.length, truncated: read.truncated });
}

/* GET /purchase-invoices/export/rows — every invoice the list's filter matches,
   each carrying its lines (lib/pi-export-rows.ts), for the grid-driven export.
   `{ purchaseInvoices, total, lineCount, truncated }`. */
export async function piExportRowsHandler(c: Ctx) {
  const filters = readPiListFilters((k) => c.req.query(k));
  const out = await readPiExportRows(c.get('supabase'), c, filters);
  if (out.error !== null) return c.json({ error: 'export_failed', reason: out.error }, 500);
  return c.json({ purchaseInvoices: out.rows, total: out.rows.length, lineCount: out.lineCount, truncated: out.truncated });
}

export const purchaseInvoiceExports = new Hono<{ Bindings: Env; Variables: Variables }>();
purchaseInvoiceExports.use('*', supabaseAuth);
purchaseInvoiceExports.get('/export/lines', piLineExportHandler);
purchaseInvoiceExports.get('/export/headers', piHeaderExportHandler);
purchaseInvoiceExports.get('/export/rows', piExportRowsHandler);
