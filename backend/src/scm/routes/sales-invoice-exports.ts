// ----------------------------------------------------------------------------
// sales-invoice-exports — the Sales Invoices list's ONE export, over EVERY page
// the list's filters match (owner 2026-09-15: one row per line, the grid's
// visible columns, AutoCount's Detail Listing values).
//
//   GET /sales-invoices/export/rows?status=&q=&sort=&from=&to=
//     -> { salesInvoices, total, lineCount, truncated }
//        Every invoice the list's filter AND the caller's sales scope match, in
//        the list's row shape — the same derived columns stamped and the same
//        finance keys stripped as GET / — each carrying `lines` from
//        attachSiLines, the same function the paged list uses.
//
// Its own router, mounted at the same prefix BEFORE the main router so the
// static path resolves ahead of `/:id`.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { readSiListFilters } from '../lib/si-list-read';
import { readSiExportRows } from '../lib/si-export-rows';
import { stampSoDates, stampDoNumber, stampOrderDeposit } from '../lib/si-list-stamps';
import { resolveSalesScopeIds } from '../lib/salesScope';
import { canViewAllSales, canViewScmFinance } from '../lib/houzs-perms';
import { activeCompanyId } from '../lib/companyScope';
import { gateSiFinance, stampSourcePos } from './sales-invoices';
import { withSoRefDocNos } from '../lib/so-ref-search';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/* The list's stamps each read with one `in` list sized for a 100-row page, so
   the whole filtered set is stamped a page-sized batch at a time. */
const STAMP_BATCH = 100;

/* The list's derived header columns, a page-sized batch at a time. A failed
   deposit read leaves the field null; the screen shows the larger outstanding
   and moves on, a file must not carry a figure nobody could compute. Returns
   the reason it refused, or null. */
async function stampSiHeaders(sb: unknown, rows: Array<Record<string, unknown>>, companyId: number | null): Promise<string | null> {
  for (let i = 0; i < rows.length; i += STAMP_BATCH) {
    const batch = rows.slice(i, i + STAMP_BATCH);
    await stampSoDates(sb, batch);
    await stampDoNumber(sb, batch);
    await stampSourcePos(sb, batch);
    await stampOrderDeposit(sb, batch, companyId);
    if (companyId !== null && batch.some((r) => r.so_deposit_applied_sen === null)) return 'order deposits: the deposit read failed';
  }
  return null;
}

/* GET /sales-invoices/export/rows — every invoice the list's filter and the
   caller's sales scope match, each carrying its lines (lib/si-export-rows.ts),
   with the list's header stamps and finance strip. `{ salesInvoices, total,
   lineCount, truncated }`. */
export async function siExportRowsHandler(c: Ctx) {
  const sb = c.get('supabase');
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));
  const filters = await withSoRefDocNos(sb, c, readSiListFilters((k) => c.req.query(k)));
  const out = await readSiExportRows(sb, c, filters, scopeIds);
  if (out.error !== null) return c.json({ error: 'export_failed', reason: out.error }, 500);
  const stamped = await stampSiHeaders(sb, out.rows, activeCompanyId(c) ?? null);
  if (stamped) return c.json({ error: 'export_failed', reason: stamped }, 500);
  gateSiFinance(out.rows, canViewScmFinance(c));
  return c.json({ salesInvoices: out.rows, total: out.rows.length, lineCount: out.lineCount, truncated: out.truncated });
}

export const salesInvoiceExports = new Hono<{ Bindings: Env; Variables: Variables }>();
salesInvoiceExports.use('*', supabaseAuth);
salesInvoiceExports.get('/export/rows', siExportRowsHandler);
