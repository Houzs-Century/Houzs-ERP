// ----------------------------------------------------------------------------
// purchase-invoice-exports — the Purchase Invoices list's ONE export, over EVERY
// page the list's filters match (owner 2026-09-15: one row per line, the grid's
// visible columns, AutoCount's Detail Listing values).
//
//   GET /purchase-invoices/export/rows?status=&q=&sort=&from=&to=
//     -> { purchaseInvoices, total, lineCount, truncated }
//        Every invoice the list's filter matches, in the list's row shape, each
//        carrying `lines` from attachPiLines — the same function the paged list
//        uses. The MRP-derived columns and the "vs PO price" marker are healed
//        by the client, only when the file or a funnel needs them.
//
// Its own router, mounted at the same prefix BEFORE the main router so the
// static path resolves ahead of `/:id`.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { readPiListFilters } from '../lib/pi-list-read';
import { readPiExportRows } from '../lib/pi-export-rows';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export async function piExportRowsHandler(c: Ctx) {
  const filters = readPiListFilters((k) => c.req.query(k));
  const out = await readPiExportRows(c.get('supabase'), c, filters);
  if (out.error !== null) return c.json({ error: 'export_failed', reason: out.error }, 500);
  return c.json({ purchaseInvoices: out.rows, total: out.rows.length, lineCount: out.lineCount, truncated: out.truncated });
}

export const purchaseInvoiceExports = new Hono<{ Bindings: Env; Variables: Variables }>();
purchaseInvoiceExports.use('*', supabaseAuth);
purchaseInvoiceExports.get('/export/rows', piExportRowsHandler);
