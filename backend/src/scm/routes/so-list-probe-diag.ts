// ----------------------------------------------------------------------------
// GET /api/scm/_diag/so-list-probe  ——  TEMPORARY, READ-ONLY DIAGNOSTIC.  REMOVE
// once the empty-Sales-Orders-list incident is understood.  DO NOT build on this.
//
// WHY THIS EXISTS.  The SO list served an empty grid in prod (0 orders beside a
// full book).  We could not observe hosted Supabase PostgREST directly to see
// what it actually returns for the list query:
//   · CI has no Actions secret for the hosted PostgREST, and
//   · the local `wrangler` is authed to the wrong Cloudflare account.
// But the Worker ITSELF holds the key (env.SUPABASE_URL + SERVICE_ROLE_KEY, set
// via `wrangler secret put`; see db/supabase.ts getSupabaseService).  So this
// route surfaces the answer FROM INSIDE the Worker: it runs a fixed set of
// read-only probes with the app's EXACT client (same key, same `db.schema='scm'`)
// against the SAME view the list handler reads, and returns each probe's outcome
// as JSON.  The admin (Lim) hits it in the browser once it deploys, we read what
// PostgREST really returns, then fix the root cause in a SEPARATE PR and delete
// this route.
//
// READ-ONLY.  Every probe is a SELECT — no insert/update/delete, no RPC.
//
// ADMIN-GATED.  supabaseAuth attaches the client + the real Houzs caller; then
// canViewAllSales(c) gates entry — Owner / IT-Admin (`*`), Sales Director, and
// any position granted `scm.so.view_all`.  Everyone else gets 403.  It is NOT
// public and it returns NO row data — only each probe's count, row count, bound
// error (code/message/details/hint), and the KEYS of the first row (never the
// values), so nothing sensitive crosses the wire.
// ----------------------------------------------------------------------------
import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { supabaseAuth } from '../middleware/auth';
import { canViewAllSales } from '../lib/houzs-perms';
import { HEADER } from './mfg-sales-orders';

export const soListProbeDiag = new Hono<{ Bindings: Env; Variables: Variables }>();
soListProbeDiag.use('*', supabaseAuth);

/* The EXACT column list the SO list handler builds (mfg-sales-orders.ts):
   `${HEADER.replace(/,\s*customer_po_image_b64/, '')}, paid_total_sen, balance_sen_live`.
   Rebuilt from the exported HEADER so it cannot drift from the real query — probe
   #3 below must reproduce the list read byte-for-byte to be worth anything. */
const LIST_COLS = `${HEADER.replace(/,\s*customer_po_image_b64/, '')}, paid_total_sen, balance_sen_live`;

/** Bind a PostgREST error into a plain, fully-preserved shape (never swallowed —
 *  CLAUDE.md audit:swallowed-reads). `null` when the probe reported no error. */
function bindError(error: unknown): {
  code: string | null;
  message: string | null;
  details: string | null;
  hint: string | null;
} | null {
  if (!error) return null;
  const e = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  return {
    code: e.code != null ? String(e.code) : null,
    message: e.message != null ? String(e.message) : null,
    details: e.details != null ? String(e.details) : null,
    hint: e.hint != null ? String(e.hint) : null,
  };
}

type ProbeResult = {
  name: string;
  count: number | null;
  rowCount: number | null;
  error: ReturnType<typeof bindError>;
  firstRowKeys: string[] | null;
  /** set only when the probe itself THREW (network/etc.), before any PostgREST reply */
  threw?: string;
};

/** Run one probe, capturing its {data,count,error}. A THROW (not a PostgREST
 *  error) is bound into `threw` so one probe failing never hides the others. */
async function runProbe(
  name: string,
  exec: () => PromiseLike<{ data: unknown; count?: number | null; error: unknown }>,
): Promise<ProbeResult> {
  try {
    const { data, count, error } = await exec();
    const rows = Array.isArray(data) ? data : data == null ? [] : [data];
    const firstRowKeys =
      rows.length > 0 && rows[0] && typeof rows[0] === 'object'
        ? Object.keys(rows[0] as Record<string, unknown>)
        : null;
    return {
      name,
      count: count ?? null,
      rowCount: rows.length,
      error: bindError(error),
      firstRowKeys,
    };
  } catch (e) {
    return {
      name,
      count: null,
      rowCount: null,
      error: null,
      firstRowKeys: null,
      threw: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  }
}

soListProbeDiag.get('/so-list-probe', async (c) => {
  if (!canViewAllSales(c)) {
    return c.json(
      { error: 'Forbidden: the SO-list diagnostic probe needs scm.so.view_all (Owner / IT-Admin / Sales Director)' },
      403,
    );
  }

  // The app's EXACT service-role client: same URL + SERVICE_ROLE_KEY, same
  // db.schema='scm' — the very object the list handler queries through.
  const sb = getSupabaseService(c.env);
  const VIEW = 'mfg_sales_orders_with_payment_totals';

  const probes: ProbeResult[] = [];

  // 1) THE COUNT PATH — count-only, company-scoped. Reproduces the exact-count
  //    header PostgREST computes for the paginated list.
  probes.push(
    await runProbe('count_company1', () =>
      sb.from(VIEW).select('doc_no', { count: 'exact' }).eq('company_id', 1).range(0, 0),
    ),
  );

  // 2) PLAIN READ — does a bare select return a row at all? Splits "data exists
  //    but count fails" from "the view returns nothing".
  probes.push(
    await runProbe('plain_read_company1', () =>
      sb.from(VIEW).select('doc_no').eq('company_id', 1).limit(1),
    ),
  );

  // 3) THE EXACT APP QUERY — LIST_COLS + order(so_date desc) + count:exact +
  //    range. THIS is the read that reproduces the empty list.
  probes.push(
    await runProbe('exact_app_query_company1', () =>
      sb
        .from(VIEW)
        .select(LIST_COLS, { count: 'exact' })
        .eq('company_id', 1)
        .order('so_date', { ascending: false })
        .range(0, 0),
    ),
  );

  // 4) NO COMPANY FILTER — does the view return ANYTHING to the app's client,
  //    regardless of company?
  probes.push(
    await runProbe('plain_read_no_filter', () => sb.from(VIEW).select('doc_no').limit(1)),
  );

  // 5) CONTROL — a DIFFERENT recreated view the AR-Aging page reads
  //    (accounting.ts GET /ar-aging). If this returns a count while the ones
  //    above do not, the client/key/schema are fine and the fault is isolated to
  //    the SO-list view specifically.
  probes.push(
    await runProbe('control_v_ar_aging', () =>
      sb.from('v_ar_aging').select('company_id', { count: 'exact' }).range(0, 0),
    ),
  );

  return c.json({ view: VIEW, listColsLength: LIST_COLS.length, probes });
});
