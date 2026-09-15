// ----------------------------------------------------------------------------
// sales-invoice-exports — the Sales Invoices list's two exports, over EVERY page
// the list's filters match (owner 2026-09-15).
//
//   GET /sales-invoices/export/lines?status=&q=&sort=&from=&to=
//     -> { columns, rows, siCount, lineCount, truncated }
//        One row per invoice LINE. `columns` is the contract in
//        lib/si-line-export-columns.ts.
//
//   GET /sales-invoices/export/headers?status=&q=&sort=&from=&to=
//     -> { salesInvoices, total, truncated }
//        One row per invoice, in the list's own row shape — the same derived
//        columns stamped and the same finance keys stripped as GET / — so the
//        list's column definitions export it unchanged.
//
// Both resolve the caller's SALES SCOPE exactly as the list does and build
// their read through the list's filter (lib/si-list-read.ts), so a seller's
// file holds exactly the invoices their list shows. Its own router, mounted at
// the same prefix BEFORE the main router so the static `/export/...` paths
// resolve ahead of `/:id` — the layout of routes/purchase-order-exports.ts.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { pageWithTruncation } from '../lib/outstanding-po-lines';
import { SI_HEADER_COLS, filterSiList, orderSiList, readSiListFilters } from '../lib/si-list-read';
import { buildSiLineExport } from '../lib/si-line-export';
import { stampSoDates, stampDoNumber, stampOrderDeposit } from '../lib/si-list-stamps';
import { resolveSalesScopeIds } from '../lib/salesScope';
import { canViewAllSales, canViewScmFinance } from '../lib/houzs-perms';
import { activeCompanyId } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import { gateSiFinance, stampSourcePos } from './sales-invoices';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/* The list's stamps each read with one `in` list sized for a 100-row page, so
   the whole filtered set is stamped a page-sized batch at a time. */
const STAMP_BATCH = 100;

export async function siLineExportHandler(c: Ctx) {
  const sb = c.get('supabase');
  // Pass the REAL Houzs user id, as the list does (lib/salesScope.ts).
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));
  const filters = readSiListFilters((k) => c.req.query(k));
  const out = await buildSiLineExport(sb, c, filters, scopeIds, todayMyt());
  if (out.error !== null) return c.json({ error: 'export_failed', reason: out.error }, 500);
  return c.json(out);
}

export async function siHeaderExportHandler(c: Ctx) {
  const sb = c.get('supabase');
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));
  const filters = readSiListFilters((k) => c.req.query(k));
  const read = await pageWithTruncation<{ id: string } & Record<string, unknown>>((from, to) =>
    orderSiList(filterSiList(sb.from('sales_invoices').select(SI_HEADER_COLS), filters, c, scopeIds), filters.sort).range(from, to));
  if (read.error) return c.json({ error: 'export_failed', reason: read.error.message }, 500);
  const salesInvoices = read.data ?? [];
  const companyId = activeCompanyId(c) ?? null;
  for (let i = 0; i < salesInvoices.length; i += STAMP_BATCH) {
    const batch = salesInvoices.slice(i, i + STAMP_BATCH);
    await stampSoDates(sb, batch);
    await stampDoNumber(sb, batch);
    await stampSourcePos(sb, batch);
    await stampOrderDeposit(sb, batch, companyId);
    /* A failed deposit read leaves the field null. The screen shows the larger
       outstanding and moves on; a file handed to someone to chase payment must
       not carry a figure nobody could compute. */
    if (companyId !== null && batch.some((r) => r.so_deposit_applied_sen === null)) {
      return c.json({ error: 'export_failed', reason: 'order deposits: the deposit read failed' }, 500);
    }
  }
  gateSiFinance(salesInvoices, canViewScmFinance(c));
  return c.json({ salesInvoices, total: salesInvoices.length, truncated: read.truncated });
}

export const salesInvoiceExports = new Hono<{ Bindings: Env; Variables: Variables }>();
salesInvoiceExports.use('*', supabaseAuth);
salesInvoiceExports.get('/export/lines', siLineExportHandler);
salesInvoiceExports.get('/export/headers', siHeaderExportHandler);
