// ----------------------------------------------------------------------------
// grn-exports — the Goods Received list's ONE export, over EVERY page the
// list's filters match (owner 2026-09-15: one row per line, the grid's visible
// columns, AutoCount's Detail Listing values).
//
//   GET /grns/export/rows?status=&q=&sort=&supplierId=&from=&to=
//     -> { grns, total, lineCount, truncated }
//        Every receipt the list's filter matches, in the list's row shape, each
//        carrying `lines` from attachGrnLines — the same function the paged list
//        uses — so the grid's line columns and the file agree cell for cell.
//        DataTable `exportLines` applies the grid's funnels and sort and writes
//        one spreadsheet row per line.
//
// Its own router because routes/grns.ts is over its file-size ceiling. Mounted
// at the same `/grns` prefix BEFORE the main router, so the static path resolves
// ahead of `/:id`; the prefix's auth + area guard (scm/index.ts) cover it.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { readGrnListFilters } from '../lib/grn-list-read';
import { readGrnExportRows } from '../lib/grn-export-rows';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export async function grnExportRowsHandler(c: Ctx) {
  const filters = readGrnListFilters((k) => c.req.query(k));
  const out = await readGrnExportRows(c.get('supabase'), c, filters);
  if (out.error !== null) return c.json({ error: 'export_failed', reason: out.error }, 500);
  return c.json({ grns: out.rows, total: out.rows.length, lineCount: out.lineCount, truncated: out.truncated });
}

export const grnExports = new Hono<{ Bindings: Env; Variables: Variables }>();
grnExports.use('*', supabaseAuth);
grnExports.get('/export/rows', grnExportRowsHandler);
