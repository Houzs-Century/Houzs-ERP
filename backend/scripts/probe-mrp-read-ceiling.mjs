#!/usr/bin/env node
/* How many rows does MRP's demand read ACTUALLY get, and what would paging cost?
   READ-ONLY: every REST call is a GET, every SQL statement is a SELECT.

   Two questions the source cannot answer:

   1. THE PAGE CEILING, measured at the edge rather than quoted from a comment.
      routes/mrp.ts asks for `.limit(5000)` and then throws if it got 5000 back.
      lib/paginate-all.ts's header says PostgREST caps a response at 1000 whatever
      `.limit()` says. If that is right the guard is unreachable and the plan runs
      on a slice; if it is wrong the guard fires and the page 500s. pg_stat_statements
      cannot settle it (#2276: the generated LIMIT is normalised to a placeholder and
      json_agg makes every read return exactly 1 row), so ASK THE REST EDGE: issue the
      real read and count the array it hands back. Content-Range carries the true total
      alongside, so the drop is visible in one line.

      The exact ceiling also decides whether paginateAll is itself correct: it pages in
      PAGE=1000 windows and stops on the first short page, so a ceiling BELOW 1000 would
      make page 1 look short and truncate silently in a second way.

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

/* ── part 1: the REST edge ─────────────────────────────────────────────────── */

const REST = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/** GET one PostgREST read against the `scm` schema. Returns rows + content-range. */
async function rest(path, { count = false } = {}) {
  const headers = {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    'Accept-Profile': 'scm', // the SCM tables live in scm.*, same as db.schema in getSupabaseService
  };
  if (count) headers.Prefer = 'count=exact';
  const res = await fetch(`${REST}/rest/v1/${path}`, { method: 'GET', headers });
  const range = res.headers.get('content-range');
  if (!res.ok) return { rows: null, range, status: res.status, body: (await res.text()).slice(0, 300) };
  const rows = await res.json();
  return { rows, range, status: res.status, body: null };
}

/* The demand read of routes/mrp.ts:466-475, spelled out as the URL supabase-js
   builds for it. Kept in ONE place so the with-limit and no-limit variants below
   differ ONLY in the limit — otherwise the comparison proves nothing. */
const DEMAND_SELECT =
  'id,doc_no,item_code,description,item_group,variants,qty,warehouse_id,line_delivery_date,line_no,created_at,cancelled,' +
  'so:mfg_sales_orders!inner(debtor_name,status,so_date,customer_delivery_date,processing_date,customer_state,sales_location)';
const demandUrl = (extra) =>
  `mfg_sales_order_items?select=${encodeURIComponent(DEMAND_SELECT)}` +
  `&cancelled=eq.false&so.status=not.in.${encodeURIComponent(`(${SO_DONE.map((s) => `"${s}"`).join(',')})`)}` +
  `&company_id=eq.${CO}&order=id${extra}`;

async function restPart() {
  note('\n=== 1. the page ceiling, measured at the REST edge (GETs only) ===');
  if (!REST || !KEY) {
    note('  SKIPPED — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
    return;
  }

  /* Cheapest possible shape first: one column, no embed, no filters. If a bare
     read is capped, the cap is the transport's and not something about MRP. */
  const bare = await rest('mfg_sales_order_items?select=id&limit=5000', { count: true });
  note(`  bare  select=id&limit=5000        -> ${bare.rows ? `${bare.rows.length} rows` : `HTTP ${bare.status} ${bare.body}`}   content-range: ${bare.range}`);

  const noLimit = await rest('mfg_sales_order_items?select=id', { count: true });
  note(`  bare  select=id  (no .limit)      -> ${noLimit.rows ? `${noLimit.rows.length} rows` : `HTTP ${noLimit.status}`}   content-range: ${noLimit.range}`);

  /* A window ABOVE the ceiling: if range=0-4999 also returns the ceiling, then
     paginateAll's PAGE=1000 is at-or-under it and its short-page stop is sound. */
  const wide = await rest('mfg_sales_order_items?select=id&limit=5000', { count: true });
  const page0 = await rest('mfg_sales_order_items?select=id&order=id&offset=0&limit=1000');
  const page1 = await rest('mfg_sales_order_items?select=id&order=id&offset=1000&limit=1000');
  note(`  paginateAll page 1 (offset 0)     -> ${page0.rows ? page0.rows.length : `HTTP ${page0.status}`} rows`);
  note(`  paginateAll page 2 (offset 1000)  -> ${page1.rows ? page1.rows.length : `HTTP ${page1.status}`} rows`);

  const dem = await rest(`${demandUrl('&limit=5000')}`, { count: true });
  note(`\n  THE REAL MRP DEMAND READ (company ${CO}), .limit(5000) exactly as shipped:`);
  note(`    rows handed to computeMrp: ${dem.rows ? dem.rows.length : `HTTP ${dem.status} ${dem.body}`}`);
  note(`    content-range (returned/total): ${dem.range}`);
  if (dem.rows) {
    const cap = 5000;
    note(`    guard is \`length >= ${cap}\`  ->  ${dem.rows.length} >= ${cap} is ${dem.rows.length >= cap} ${dem.rows.length >= cap ? '(fires)' : '(CANNOT FIRE — silent slice)'}`);
    const ceiling = bare.rows ? bare.rows.length : null;
    if (ceiling != null) {
      note(`    measured ceiling ${ceiling}; paginateAll PAGE=1000 is ${1000 <= ceiling ? 'at or under it (short-page stop is sound)' : 'ABOVE it (paginateAll would truncate too!)'}`);
    }
  }
  if (wide.range) note(`    (limit=5000 content-range: ${wide.range})`);
}

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
  note('\n=== 1b. the configured db-max-rows, from the DB side ===');
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
  note('\n=== 2. row counts of every read in computeMrp, and the requests paging costs ===');
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

await restPart();
await sqlPart();
