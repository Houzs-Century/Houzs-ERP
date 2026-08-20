#!/usr/bin/env node
/* How many rows does MRP's demand read ACTUALLY get, and what would paging cost?
   READ-ONLY: every SQL statement is a SELECT.

   THE PAGE CEILING IS NOT MEASURED HERE ANY MORE — and it never was. This
   script used to open with a REST half that issued the real read and counted
   the array PostgREST handed back. It needed SUPABASE_URL +
   SUPABASE_SERVICE_ROLE_KEY, which are WORKER secrets, not GitHub ones, and
   deliberately so: this repository is public and the service-role key bypasses
   RLS on a database two tenants share. So the half never ran once — runs
   31941352447 and 31942066593 both printed "SKIPPED" while the workflow
   reported success, which is worse than no coverage because it reads as some.

   Rewriting it over DATABASE_URL would NOT have fixed it: production genuinely
   speaks PostgREST (src/db/supabase.ts:66 builds a real createClient and every
   sb.from(...) in the SCM module is a REST call), so a pg-shim version would
   have measured Postgres and not the edge in question.

   The ceiling is measured from the WORKER instead, which already holds those
   credentials and already issues the exact request:

       GET /api/admin/health/rest-page-ceiling     (gated on `*`, counts only)
       -> src/routes/systemHealth.ts

   It reports rows-returned vs the Content-Range total at several requested
   limits, and settles whether paginateAll's PAGE-sized windows sit at or under
   the real ceiling. What REMAINS here is the part DATABASE_URL can honestly
   answer:

   2. WHAT PAGING COSTS. Paging turns one request into ceil(rows/1000). The reads are
      sequential and computeMrp runs inline on the SO detail page, so the row counts
      below are the request counts that page pays. The `.in()` list sizes matter just as
      much: un-truncating demand grows the doc_no / item_code lists fed to the reads
      downstream of it, and an over-long IN list is a 414 at the edge, not a slow query.

   COMPANY=1 node scripts/probe-mrp-read-ceiling.mjs */
import postgres from 'postgres';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);
const CO = Number(process.env.COMPANY || 1);

const SO_DONE = ['CANCELLED', 'CLOSED', 'SHIPPED', 'DELIVERED', 'INVOICED', 'DRAFT'];
const PO_DEAD = ['CANCELLED', 'DRAFT'];

/* ── part 2: what the untruncated reads cost ───────────────────────────────── */

const DSN = process.env.DATABASE_URL;
const sql = DSN ? postgres(DSN, { ssl: 'require', prepare: false, max: 1 }) : null;
const PAGE = 1000;
const reqs = (n) => Math.max(1, Math.ceil(Number(n) / PAGE));

/* The ceiling's CONFIGURED value, from the DB side, as a cross-check on the
   measurement above — and the only reading available when the REST secrets are
   not in scope. PostgREST takes db-max-rows from a role GUC, so it is sitting in
   pg_roles.rolconfig / pg_settings as plain text. It matters beyond MRP:
   paginateAll pages in PAGE=1000 windows and stops on the first short page, so a
   ceiling BELOW 1000 would make page 1 look short and truncate every paged read
   in the codebase a second way. */
async function ceilingSetting() {
  note('\n=== 1b. the configured db-max-rows, from the DB side (a CROSS-CHECK, not the measurement) ===');
  const roles = await sql`
    SELECT r.rolname, unnest(coalesce(r.rolconfig, '{}'))::text AS cfg
      FROM pg_roles r WHERE r.rolconfig IS NOT NULL`;
  const hits = roles.filter((r) => /max.?rows/i.test(r.cfg));
  if (hits.length === 0) note('  no *max-rows* GUC set on any role (PostgREST default is 1000)');
  for (const r of hits) note(`  role ${r.rolname}: ${r.cfg}`);
  const gucs = await sql`
    SELECT name, setting FROM pg_settings WHERE name ILIKE '%max_rows%' OR name ILIKE 'pgrst%'`;
  for (const g of gucs) note(`  pg_settings ${g.name} = ${g.setting}`);
}

async function sqlPart() {
  note('\n=== 1. row counts of every read in computeMrp, and the requests paging costs ===');
  if (!sql) { note('  SKIPPED — DATABASE_URL not set'); return; }
  try { await ceilingSetting(); } catch (e) { note(`  (role config unreadable: ${e.message})`); }

  const one = async (label, q) => {
    const [r] = await q;
    const n = Number(r.n);
    note(`  ${label.padEnd(52)} ${String(n).padStart(6)} rows -> ${String(reqs(n)).padStart(3)} request(s)`);
    return n;
  };

  const demand = await one('1  demand: mfg_sales_order_items (+so !inner)', sql`
    SELECT count(*)::bigint n FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = i.company_id
     WHERE i.company_id = ${CO}::bigint AND i.cancelled = false
       AND s.status NOT IN ${sql(SO_DONE)}`);
  await one('2  mfg_products BY demand codes (already chunked)', sql`
    SELECT count(*)::bigint n FROM scm.mfg_products
     WHERE company_id = ${CO}::bigint AND code IN (
       SELECT DISTINCT i.item_code FROM scm.mfg_sales_order_items i
         JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = i.company_id
        WHERE i.company_id = ${CO}::bigint AND i.cancelled = false AND s.status NOT IN ${sql(SO_DONE)})`);
  await one('2b category dropdown: mfg_products (all rows)', sql`
    SELECT count(*)::bigint n FROM scm.mfg_products WHERE company_id = ${CO}::bigint`);
  await one('2c warehouses (is_active)', sql`
    SELECT count(*)::bigint n FROM scm.warehouses WHERE company_id = ${CO}::bigint AND is_active = true`);
  await one('2d state_warehouse_mappings', sql`
    SELECT count(*)::bigint n FROM scm.state_warehouse_mappings WHERE company_id = ${CO}::bigint`);
  await one('0  mrp_category_lead_times', sql`
    SELECT count(*)::bigint n FROM scm.mrp_category_lead_times WHERE company_id = ${CO}::bigint`);
  await one('3  inventory_balances', sql`
    SELECT count(*)::bigint n FROM scm.inventory_balances WHERE company_id = ${CO}::bigint`);
  await one('4  PO supply: purchase_order_items (+po !inner)', sql`
    SELECT count(*)::bigint n FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE i.company_id = ${CO}::bigint AND p.status NOT IN ${sql(PO_DEAD)}`);
  await one('5  supplier_material_bindings (mfg_product, demand codes)', sql`
    SELECT count(*)::bigint n FROM scm.supplier_material_bindings
     WHERE company_id = ${CO}::bigint AND material_kind = 'mfg_product'
       AND item_code IN (
       SELECT DISTINCT i.item_code FROM scm.mfg_sales_order_items i
         JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = i.company_id
        WHERE i.company_id = ${CO}::bigint AND i.cancelled = false AND s.status NOT IN ${sql(SO_DONE)})`);
  await one('5b suppliers (all — the .in(id) list is bounded by this)', sql`
    SELECT count(*)::bigint n FROM scm.suppliers WHERE company_id = ${CO}::bigint`);

  /* The IN-list sizes. These are what a bigger demand set makes bigger, and an
     over-long IN list fails as a 414 URI-too-long at the edge — a different
     failure from the row cap and one paging does NOT fix. */
  note('\n  --- .in() list sizes the demand set feeds downstream ---');
  const [lists] = await sql`
    WITH d AS (
      SELECT i.doc_no, i.item_code, i.variants
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = i.company_id
       WHERE i.company_id = ${CO}::bigint AND i.cancelled = false AND s.status NOT IN ${sql(SO_DONE)})
    SELECT count(DISTINCT doc_no)::bigint docs,
           count(DISTINCT item_code)::bigint codes,
           count(DISTINCT (variants->>'fabricCode'))::bigint fabrics,
           coalesce(sum(length(doc_no) + 3), 0)::bigint doc_url_bytes
      FROM d`;
  note(`    distinct doc_no  -> soDeliverableRemaining(.in doc_no)   ${String(lists.docs).padStart(6)}  (~${Math.round(Number(lists.doc_url_bytes) / 1024)} KB of URL, UNCHUNKED today)`);
  note(`    distinct item_code -> bindings .in(item_code)         ${String(lists.codes).padStart(6)}`);
  note(`    distinct fabricCode -> fabric_trackings .in(fabric_code)  ${String(lists.fabrics).padStart(6)}`);

  /* soDeliverableRemaining's own reads, sized for the untruncated doc_no set. It
     already pages, so these are request counts, not truncation risks. */
  note('\n  --- soDeliverableRemaining(demandDocNos), sized for the FULL demand set ---');
  await one('   SO lines of those docs (paged)', sql`
    SELECT count(*)::bigint n FROM scm.mfg_sales_order_items i
     WHERE i.cancelled = false AND i.doc_no IN (
       SELECT DISTINCT i2.doc_no FROM scm.mfg_sales_order_items i2
         JOIN scm.mfg_sales_orders s ON s.doc_no = i2.doc_no AND s.company_id = i2.company_id
        WHERE i2.company_id = ${CO}::bigint AND i2.cancelled = false AND s.status NOT IN ${sql(SO_DONE)})`);

  /* Which rows the uuid-ordered slice keeps. `.order('id')` on a uuid PK is not
     chronological — the surviving 1000 is an arbitrary set, so "the newest order
     is missing" is a probability, not a rule. Quantify it. */
  note('\n  --- what the first 1000 rows BY UUID actually are (company ' + CO + ') ---');
  const [slice] = await sql`
    WITH d AS (
      SELECT i.id, i.doc_no, s.so_date
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = i.company_id
       WHERE i.company_id = ${CO}::bigint AND i.cancelled = false AND s.status NOT IN ${sql(SO_DONE)}
       ORDER BY i.id LIMIT 1000)
    SELECT count(*)::bigint kept,
           min(so_date)::text oldest_kept, max(so_date)::text newest_kept,
           count(DISTINCT doc_no)::bigint docs_kept FROM d`;
  const [tot] = await sql`
    SELECT count(*)::bigint total, min(s.so_date)::text oldest, max(s.so_date)::text newest
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = i.company_id
     WHERE i.company_id = ${CO}::bigint AND i.cancelled = false AND s.status NOT IN ${sql(SO_DONE)}`;
  note(`    kept ${slice.kept} of ${tot.total} lines (${((Number(slice.kept) / Number(tot.total)) * 100).toFixed(1)}%), ${slice.docs_kept} distinct SOs`);
  note(`    kept slice so_date range ${slice.oldest_kept} .. ${slice.newest_kept}`);
  note(`    full  set so_date range ${tot.oldest} .. ${tot.newest}`);
  note(`    -> a uuid PK does not sort by time: the surviving slice spans the WHOLE date range,`);
  note(`       so any given new SO line has a ~${((Number(slice.kept) / Number(tot.total)) * 100).toFixed(0)}% chance of being planned and ~${(100 - (Number(slice.kept) / Number(tot.total)) * 100).toFixed(0)}% of vanishing.`);

  plain(`\n  demand rows today: ${demand}  ->  paging costs ${reqs(demand)} requests for that read alone`);
  await sql.end({ timeout: 5 });
}

await sqlPart();
