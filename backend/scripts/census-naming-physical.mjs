// READ-ONLY census for the batch-3 PHYSICAL naming unification (warehouse +
// customer-ref). It proves the SHAPE of the data before either migration is
// written, so the backfill and the DROP are census-informed, not guessed.
//
// It answers, against LIVE production, two independent questions:
//
//   A. WAREHOUSE (additive migration). The SO header stores a free-text
//      `sales_location` snapshot; the canonical binding is a per-line
//      `warehouse_id` uuid -> scm.warehouses. This reports how many
//      non-cancelled SOs carry a non-empty `sales_location`, how many resolve
//      to EXACTLY ONE scm.warehouses row within the same company (CODE first,
//      then NAME), how many resolve by code vs by name, and how many DO NOT
//      resolve (0 rows) or resolve AMBIGUOUSLY (>1 row) — with a few example
//      values for the non-resolving buckets. The additive migration will
//      backfill only the unambiguous single-match rows and leave the rest on
//      `sales_location`.
//
//   B. CUSTOMER-REF (drop migration). `po_doc_no` / `customer_po` /
//      `customer_po_id` / `customer_po_date` on scm.mfg_sales_orders are
//      reported as dead (0% filled). This reports the ACTUAL non-empty fill
//      count of each, and EVERY database object that references any of them —
//      views/matviews (via pg_depend, exact), indexes (via pg_index, exact),
//      functions (prosrc text, heuristic), policies and CHECK constraints —
//      plus, for every dependent view AND the never-dropped grant-donor sibling
//      scm.suppliers_with_derived_category, the view OWNER and its full grant
//      set. That is the 0189 view-grant hazard made visible: a DROP VIEW ->
//      CREATE VIEW recreate must restore exactly these grants (0190/0191
//      precedent). It also confirms whether a header `warehouse_id` column
//      already exists (it must not, yet).
//
// SELECTs only — no writes, no DDL, no transaction. Exit 0 for every legitimate
// answer; the output IS the answer (mirrors check-so-do-drill.mjs's contract).
// Reserve a non-zero exit for an unreachable DB.
//   DATABASE_URL required (env, or .dev.vars for local use).
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const num = (x) => Number(x ?? 0);
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const DEAD_COLS = ["po_doc_no", "customer_po", "customer_po_id", "customer_po_date"];

try {
  notice("=== BATCH-3 PHYSICAL NAMING CENSUS (read-only) ===");
  notice("");

  // ─────────────────────────────────────────────────────────────────────────
  // A. WAREHOUSE — resolve free-text sales_location against scm.warehouses
  // ─────────────────────────────────────────────────────────────────────────
  notice("################ A. WAREHOUSE (sales_location -> warehouse_id) ################");

  // Does the header warehouse_id column already exist? It must NOT yet.
  const hdrWh = await pg`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = 'mfg_sales_orders'
       AND column_name = 'warehouse_id'`;
  notice(`  header scm.mfg_sales_orders.warehouse_id present? ${hdrWh.length ? `YES (${hdrWh[0].data_type}) — UNEXPECTED` : "no (as expected)"}`);

  // warehouses shape used for resolution.
  const whCols = await pg`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = 'warehouses'
     ORDER BY ordinal_position`;
  const whColSet = new Set(whCols.map((r) => r.column_name));
  notice(`  scm.warehouses columns: ${whCols.map((r) => r.column_name).join(", ")}`);
  notice(`  (resolution keys used: code, name; scope: company_id ${whColSet.has("company_id") ? "present" : "ABSENT"})`);

  const whCount = await pg`SELECT count(*)::int AS n FROM scm.warehouses`;
  notice(`  scm.warehouses total rows: ${whCount[0].n}`);

  // Totals.
  const soTotals = await pg`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE UPPER(COALESCE(status::text,'')) <> 'CANCELLED')::int AS non_cancelled,
      count(*) FILTER (WHERE UPPER(COALESCE(status::text,'')) <> 'CANCELLED'
                         AND NULLIF(btrim(COALESCE(sales_location,'')),'') IS NOT NULL)::int AS nc_with_loc
      FROM scm.mfg_sales_orders`;
  const T = soTotals[0];
  notice(`  SOs total: ${T.total}  |  non-cancelled: ${T.non_cancelled}  |  non-cancelled WITH non-empty sales_location: ${T.nc_with_loc}`);

  // Resolution: per non-cancelled SO with a non-empty sales_location, count the
  // scm.warehouses rows matching by code, and (separately) by name, within the
  // same company. "Resolves" = exactly one match on the FIRST key that matches
  // any (code preferred, else name).
  const resolveRows = await pg`
    WITH so AS (
      SELECT doc_no, company_id, btrim(sales_location) AS loc
        FROM scm.mfg_sales_orders
       WHERE UPPER(COALESCE(status::text,'')) <> 'CANCELLED'
         AND NULLIF(btrim(COALESCE(sales_location,'')),'') IS NOT NULL
    ),
    m AS (
      SELECT so.doc_no, so.loc,
        (SELECT count(*) FROM scm.warehouses w
          WHERE w.company_id = so.company_id AND w.code = so.loc)::int AS code_hits,
        (SELECT count(*) FROM scm.warehouses w
          WHERE w.company_id = so.company_id AND w.name = so.loc)::int AS name_hits
      FROM so
    )
    SELECT
      count(*)::int AS considered,
      count(*) FILTER (WHERE code_hits = 1)::int AS code_unique,
      count(*) FILTER (WHERE code_hits = 0 AND name_hits = 1)::int AS name_unique,
      count(*) FILTER (WHERE code_hits > 1 OR (code_hits = 0 AND name_hits > 1))::int AS ambiguous,
      count(*) FILTER (WHERE code_hits = 0 AND name_hits = 0)::int AS unresolved
      FROM m`;
  const R = resolveRows[0];
  const resolvable = R.code_unique + R.name_unique;
  notice(`  --- resolution (non-cancelled, non-empty sales_location; considered=${R.considered}) ---`);
  notice(`    resolves to EXACTLY ONE warehouse: ${resolvable}  (by code=${R.code_unique}, by name-fallback=${R.name_unique})`);
  notice(`    AMBIGUOUS (>1 match): ${R.ambiguous}`);
  notice(`    UNRESOLVED (0 match): ${R.unresolved}`);
  notice(`    => additive backfill would set warehouse_id on ${resolvable} rows; ${R.ambiguous + R.unresolved} stay on sales_location.`);

  // A few example values for the non-resolving buckets, so the shape is legible.
  const unresolvedEx = await pg`
    WITH so AS (
      SELECT company_id, btrim(sales_location) AS loc
        FROM scm.mfg_sales_orders
       WHERE UPPER(COALESCE(status::text,'')) <> 'CANCELLED'
         AND NULLIF(btrim(COALESCE(sales_location,'')),'') IS NOT NULL
    )
    SELECT so.company_id, so.loc, count(*)::int AS n
      FROM so
     WHERE NOT EXISTS (SELECT 1 FROM scm.warehouses w WHERE w.company_id = so.company_id AND w.code = so.loc)
       AND NOT EXISTS (SELECT 1 FROM scm.warehouses w WHERE w.company_id = so.company_id AND w.name = so.loc)
     GROUP BY so.company_id, so.loc
     ORDER BY n DESC
     LIMIT 15`;
  notice(`  --- UNRESOLVED distinct sales_location values (top ${unresolvedEx.length}) ---`);
  for (const e of unresolvedEx) notice(`    company=${e.company_id}  "${e.loc}"  (${e.n} SO)`);

  const ambiguousEx = await pg`
    WITH so AS (
      SELECT company_id, btrim(sales_location) AS loc
        FROM scm.mfg_sales_orders
       WHERE UPPER(COALESCE(status::text,'')) <> 'CANCELLED'
         AND NULLIF(btrim(COALESCE(sales_location,'')),'') IS NOT NULL
    )
    SELECT so.company_id, so.loc, count(*)::int AS n,
      (SELECT count(*) FROM scm.warehouses w WHERE w.company_id = so.company_id AND w.code = so.loc)::int AS code_hits,
      (SELECT count(*) FROM scm.warehouses w WHERE w.company_id = so.company_id AND w.name = so.loc)::int AS name_hits
      FROM so
     GROUP BY so.company_id, so.loc
    HAVING (SELECT count(*) FROM scm.warehouses w WHERE w.company_id = so.company_id AND w.code = so.loc) > 1
        OR ((SELECT count(*) FROM scm.warehouses w WHERE w.company_id = so.company_id AND w.code = so.loc) = 0
            AND (SELECT count(*) FROM scm.warehouses w WHERE w.company_id = so.company_id AND w.name = so.loc) > 1)
     ORDER BY n DESC
     LIMIT 15`;
  notice(`  --- AMBIGUOUS distinct sales_location values (top ${ambiguousEx.length}) ---`);
  for (const e of ambiguousEx) notice(`    company=${e.company_id}  "${e.loc}"  (${e.n} SO)  code_hits=${e.code_hits} name_hits=${e.name_hits}`);

  notice("");

  // ─────────────────────────────────────────────────────────────────────────
  // B. CUSTOMER-REF — fill counts + every dependency + view grants
  // ─────────────────────────────────────────────────────────────────────────
  notice("################ B. CUSTOMER-REF (dead-column drop) ################");

  // B.1 fill counts. Text columns: non-empty after trim. Others: non-null.
  notice(`  --- fill counts on scm.mfg_sales_orders (total rows: ${T.total}) ---`);
  for (const col of DEAD_COLS) {
    const meta = await pg`
      SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'scm' AND table_name = 'mfg_sales_orders' AND column_name = ${col}`;
    if (meta.length === 0) { notice(`    ${col}: COLUMN ABSENT`); continue; }
    const isText = /char|text/.test(meta[0].data_type);
    const q = isText
      ? await pg`SELECT count(*)::int AS n FROM scm.mfg_sales_orders WHERE NULLIF(btrim(${pg(col)}::text),'') IS NOT NULL`
      : await pg`SELECT count(*)::int AS n FROM scm.mfg_sales_orders WHERE ${pg(col)} IS NOT NULL`;
    notice(`    ${col} (${meta[0].data_type}): filled = ${q[0].n}${q[0].n === 0 ? "  (DEAD — safe to drop)" : "  ** NON-EMPTY — NOT safe to drop blindly **"}`);
  }
  // Also report customer_po_image_b64 for completeness — it is a 5th related
  // column the view projects but is NOT in the drop scope, so its state matters
  // to whoever reviews the recreate.
  const imgMeta = await pg`
    SELECT data_type FROM information_schema.columns
     WHERE table_schema='scm' AND table_name='mfg_sales_orders' AND column_name='customer_po_image_b64'`;
  if (imgMeta.length) {
    const q = await pg`SELECT count(*)::int AS n FROM scm.mfg_sales_orders WHERE NULLIF(btrim(customer_po_image_b64::text),'') IS NOT NULL`;
    notice(`    (not in drop scope) customer_po_image_b64 (${imgMeta[0].data_type}): filled = ${q[0].n}`);
  }

  // B.2 exact view/matview dependencies via pg_depend on the specific columns.
  notice(`  --- VIEW / MATVIEW dependencies on the 4 dead columns (pg_depend, exact) ---`);
  const viewDeps = await pg`
    SELECT DISTINCT dv.relname AS view_name, dv.relkind, a.attname AS column_name, nv.nspname AS view_schema
      FROM pg_depend d
      JOIN pg_rewrite r   ON r.oid = d.objid
      JOIN pg_class dv    ON dv.oid = r.ev_class
      JOIN pg_namespace nv ON nv.oid = dv.relnamespace
      JOIN pg_class st    ON st.oid = d.refobjid
      JOIN pg_namespace ns ON ns.oid = st.relnamespace
      JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
     WHERE ns.nspname = 'scm' AND st.relname = 'mfg_sales_orders'
       AND a.attname = ANY(${DEAD_COLS})
       AND dv.relname <> 'mfg_sales_orders'
     ORDER BY dv.relname, a.attname`;
  if (viewDeps.length === 0) notice("    (none)");
  const dependentViews = new Set();
  for (const v of viewDeps) {
    const kind = v.relkind === "m" ? "matview" : "view";
    notice(`    ${kind} ${v.view_schema}.${v.view_name}  projects  ${v.column_name}`);
    dependentViews.add(`${v.view_schema}.${v.view_name}`);
  }

  // B.3 exact index dependencies.
  notice(`  --- INDEX dependencies on the 4 dead columns (pg_index, exact) ---`);
  const idxDeps = await pg`
    SELECT i.relname AS index_name, a.attname AS column_name
      FROM pg_index x
      JOIN pg_class i  ON i.oid = x.indexrelid
      JOIN pg_class t  ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(x.indkey)
     WHERE n.nspname = 'scm' AND t.relname = 'mfg_sales_orders'
       AND a.attname = ANY(${DEAD_COLS})
     ORDER BY i.relname, a.attname`;
  if (idxDeps.length === 0) notice("    (none)");
  for (const ix of idxDeps) notice(`    index ${ix.index_name}  on  ${ix.column_name}`);

  // B.4 CHECK constraints + defaults referencing the columns.
  notice(`  --- CHECK constraints / defaults referencing the 4 dead columns ---`);
  const conDeps = await pg`
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname='scm' AND t.relname='mfg_sales_orders' AND c.contype='c'`;
  const conHits = conDeps.filter((r) => DEAD_COLS.some((col) => String(r.def).toLowerCase().includes(col)));
  if (conHits.length === 0) notice("    (none)");
  for (const c of conHits) notice(`    constraint ${c.conname}: ${c.def}`);

  const defDeps = await pg`
    SELECT a.attname AS column_name, pg_get_expr(ad.adbin, ad.adrelid) AS default_expr
      FROM pg_attrdef ad
      JOIN pg_class t ON t.oid = ad.adrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
     WHERE n.nspname='scm' AND t.relname='mfg_sales_orders'
       AND a.attname = ANY(${DEAD_COLS})`;
  for (const d of defDeps) notice(`    default on ${d.column_name}: ${d.default_expr}`);

  // B.5 functions referencing the column names (heuristic: prosrc text match).
  notice(`  --- FUNCTIONS whose body mentions a dead column name (heuristic, prosrc) ---`);
  const fnAll = await pg`
    SELECT n.nspname AS schema, p.proname AS name, p.prosrc AS src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('scm','public')`;
  const fnHits = fnAll.filter((f) => DEAD_COLS.some((col) => new RegExp(`\\b${col}\\b`).test(String(f.src))));
  if (fnHits.length === 0) notice("    (none)");
  for (const f of fnHits) {
    const which = DEAD_COLS.filter((col) => new RegExp(`\\b${col}\\b`).test(String(f.src)));
    notice(`    function ${f.schema}.${f.name}  mentions  ${which.join(", ")}`);
  }

  // B.6 RLS policies referencing the columns (heuristic on qual text).
  notice(`  --- RLS policies on scm.mfg_sales_orders (mentioning a dead column) ---`);
  const pols = await pg`
    SELECT polname, pg_get_expr(polqual, polrelid) AS qual, pg_get_expr(polwithcheck, polrelid) AS withcheck
      FROM pg_policy pol
      JOIN pg_class t ON t.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname='scm' AND t.relname='mfg_sales_orders'`;
  const polHits = pols.filter((p) => DEAD_COLS.some((col) => `${p.qual ?? ""} ${p.withcheck ?? ""}`.toLowerCase().includes(col)));
  notice(`    (total policies on table: ${pols.length}; mentioning a dead column: ${polHits.length})`);
  for (const p of polHits) notice(`    policy ${p.polname}: qual=${p.qual ?? "-"} withcheck=${p.withcheck ?? "-"}`);

  // B.7 GRANTS + owner for every dependent view AND the grant-donor sibling.
  // This is the 0189 hazard payload: a recreate must restore exactly these.
  const grantTargets = new Set([
    ...dependentViews,
    "scm.mfg_sales_orders_with_payment_totals", // named explicitly in case pg_depend missed a form
    "scm.suppliers_with_derived_category",       // the never-dropped 0191 grant donor
  ]);
  notice(`  --- VIEW GRANTS + OWNER (restore payload for any recreate) ---`);
  for (const full of [...grantTargets].sort()) {
    const [schema, name] = full.split(".");
    const exists = await pg`
      SELECT viewowner FROM pg_views WHERE schemaname = ${schema} AND viewname = ${name}
      UNION ALL
      SELECT matviewowner FROM pg_matviews WHERE schemaname = ${schema} AND matviewname = ${name}`;
    if (exists.length === 0) { notice(`    ${full}: (not a view/matview here)`); continue; }
    const owner = exists[0].viewowner;
    const grants = await pg`
      SELECT grantee, privilege_type, is_grantable
        FROM information_schema.role_table_grants
       WHERE table_schema = ${schema} AND table_name = ${name}
       ORDER BY grantee, privilege_type`;
    notice(`    ${full}`);
    notice(`      owner: ${owner}`);
    if (grants.length === 0) notice(`      grants: NONE (empty ACL)`);
    for (const g of grants) notice(`      grant: ${g.privilege_type} TO ${g.grantee}${g.is_grantable === "YES" ? " WITH GRANT OPTION" : ""}`);
  }

  notice("");
  notice("DONE (read-only). Nothing was written. The warehouse migration is additive");
  notice("(ADD warehouse_id + backfill the resolvable rows, keep sales_location); the");
  notice("customer-ref migration DROPs the 4 columns ONLY if their fill count is 0 and");
  notice("recreates every dependent view WITH the owner + grants dumped above.");
} finally {
  await pg.end({ timeout: 5 });
}
