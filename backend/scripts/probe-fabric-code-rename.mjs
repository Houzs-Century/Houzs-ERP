// Read-only probe for the KN01..KN13 -> EM.. fabric code rename. One-off: it is
// dropped from the PR before merge. Strictly SELECTs and catalog reads; exits 0
// for every real answer.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const out = (m) => console.log(m);
const cut = (s, n = 220) => { const v = String(s ?? ""); return v.length > n ? `${v.slice(0, n)}…` : v; };

// Bounded so KN01 cannot match inside PKN011. Case-insensitive at the call
// site, because a stock variant_key lowercases the code.
const OLD_RE = "(^|[^A-Za-z0-9])KN(0[1-9]|1[0-3])([^A-Za-z0-9]|$)";
const NEW_RE = "(^|[^A-Za-z0-9])EM[- ]?(0[1-9]|1[0-3])([^A-Za-z0-9]|$)";
const SKIP_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast", "auth", "storage", "realtime",
  "vault", "extensions", "graphql", "graphql_public", "pgbouncer", "supabase_migrations", "net",
  "cron", "pgsodium", "pgsodium_masks", "supabase_functions", "_realtime", "_analytics"];

async function main() {
  await sql`SET statement_timeout = '180s'`;

  out("=== A. companies ===");
  for (const r of await sql`SELECT id, code, name FROM public.companies ORDER BY id`) out(`  ${r.id}  ${r.code}  ${r.name}`);

  out("\n=== B. scm.fabric_trackings rows (code/id KN*|EM*, or series EMBRACE) ===");
  const ft = await sql`
    SELECT * FROM scm.fabric_trackings
     WHERE fabric_code ~* '^(KN|EM)[-_ ]?[0-9]' OR id ~* '^(KN|EM)[-_ ]?[0-9]' OR series ILIKE '%EMBRACE%'
     ORDER BY company_id, fabric_code`;
  out(`  ${ft.length} row(s)`);
  for (const r of ft) out(`  ${JSON.stringify(r)}`);

  out("\n=== C1. scm.fabric_library rows (id KN*|EM*, label EMBRACE) ===");
  const lib = await sql`
    SELECT * FROM scm.fabric_library
     WHERE id ~* '^(KN|EM)([-_ ]?[0-9]|$)' OR label ILIKE '%EMBRACE%' OR id ILIKE '%EMBRACE%'
     ORDER BY company_id, id`;
  out(`  ${lib.length} row(s)`);
  for (const r of lib) out(`  ${JSON.stringify(r)}`);

  out("\n=== C2. scm.fabric_colours rows (fabric_id/colour_id KN*|EM*) ===");
  const col = await sql`
    SELECT * FROM scm.fabric_colours
     WHERE fabric_id ~* '^(KN|EM)([-_ ]?[0-9]|$)' OR colour_id ~* '^(KN|EM)[-_ ]?[0-9]' OR fabric_id ILIKE '%EMBRACE%'
     ORDER BY company_id, fabric_id, colour_id`;
  out(`  ${col.length} row(s)`);
  for (const r of col) out(`  ${JSON.stringify(r)}`);

  out("\n=== D1. constraints ON the three fabric tables ===");
  for (const r of await sql`
    SELECT conrelid::regclass::text AS t, conname, contype, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid IN ('scm.fabric_trackings'::regclass, 'scm.fabric_library'::regclass, 'scm.fabric_colours'::regclass)
     ORDER BY 1, 2`) out(`  ${r.t}  ${r.conname} [${r.contype}]  ${r.def}`);

  out("\n=== D2. foreign keys that REFERENCE the three fabric tables ===");
  for (const r of await sql`
    SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE contype = 'f'
       AND confrelid IN ('scm.fabric_trackings'::regclass, 'scm.fabric_library'::regclass, 'scm.fabric_colours'::regclass)
     ORDER BY 1, 2`) out(`  ${r.t}  ${r.conname}  ${r.def}`);

  out("\n=== D3. triggers on the three fabric tables ===");
  for (const r of await sql`
    SELECT tgrelid::regclass::text AS t, tgname, pg_get_triggerdef(oid) AS def
      FROM pg_trigger
     WHERE NOT tgisinternal
       AND tgrelid IN ('scm.fabric_trackings'::regclass, 'scm.fabric_library'::regclass, 'scm.fabric_colours'::regclass)
     ORDER BY 1, 2`) out(`  ${r.t}  ${r.tgname}  ${cut(r.def, 400)}`);

  out("\n=== D4. indexes on the three fabric tables ===");
  for (const r of await sql`
    SELECT schemaname || '.' || tablename AS t, indexname, indexdef FROM pg_indexes
     WHERE schemaname = 'scm' AND tablename IN ('fabric_trackings', 'fabric_library', 'fabric_colours')
     ORDER BY 1, 2`) out(`  ${r.t}  ${cut(r.indexdef, 300)}`);

  /* E. Every text / jsonb column of every user table, one scan per table. The
     carrier list in lib/colour-carriers.mjs is what the repair knows; this asks
     the database what exists, so a carrier nobody listed still shows up. */
  out("\n=== E. every text/jsonb column that names an old (KN01..KN13) or new (EM01..EM13) code ===");
  const cols = await sql`
    SELECT n.nspname AS s, c.relname AS t, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS ty,
           c.reltuples::bigint AS est
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relkind IN ('r', 'p') AND n.nspname::text <> ALL(${SKIP_SCHEMAS}::text[])
       AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast%'
       AND (format_type(a.atttypid, a.atttypmod) IN ('text', 'jsonb', 'json', 'text[]', 'character varying[]')
            OR format_type(a.atttypid, a.atttypmod) LIKE 'character varying%'
            OR format_type(a.atttypid, a.atttypmod) LIKE 'character(%')
     ORDER BY 1, 2, a.attnum`;
  const byTable = new Map();
  for (const r of cols) {
    const k = `${r.s}.${r.t}`;
    if (!byTable.has(k)) byTable.set(k, { s: r.s, t: r.t, est: r.est, cols: [] });
    byTable.get(k).cols.push({ col: r.col, ty: r.ty });
  }
  out(`  scanning ${byTable.size} table(s), ${cols.length} column(s)`);
  const hits = [];
  const failed = [];
  for (const [k, tb] of byTable) {
    const qt = `"${tb.s}"."${tb.t}"`;
    const parts = tb.cols.flatMap((c, i) => [
      `COUNT(*) FILTER (WHERE "${c.col}"::text ~* $1)::int AS o${i}`,
      `COUNT(*) FILTER (WHERE "${c.col}"::text ~* $2)::int AS n${i}`,
    ]);
    try {
      const [row] = await sql.unsafe(`SELECT ${parts.join(", ")} FROM ${qt}`, [OLD_RE, NEW_RE]);
      tb.cols.forEach((c, i) => {
        if (row[`o${i}`] || row[`n${i}`]) hits.push({ k, qt, col: c.col, ty: c.ty, old: row[`o${i}`], neu: row[`n${i}`] });
      });
    } catch (e) {
      failed.push(`${k}: ${e.message}`);
    }
  }
  out(`  ${hits.length} column(s) with a hit; ${failed.length} table(s) could not be scanned`);
  for (const f of failed) out(`    NOT SCANNED ${cut(f, 200)}`);
  out(`  ${"table.column".padEnd(64)} ${"type".padEnd(10)} ${"KN".padStart(7)} ${"EM".padStart(7)}`);
  for (const h of hits) out(`  ${`${h.k}.${h.col}`.padEnd(64)} ${h.ty.slice(0, 10).padEnd(10)} ${String(h.old).padStart(7)} ${String(h.neu).padStart(7)}`);

  out("\n=== F. detail per hit column ===");
  for (const h of hits) {
    const hasCo = (await sql.unsafe(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = 'company_id'`,
      k2(h.k))).length > 0;
    out(`\n--- ${h.k}.${h.col} (${h.ty})  KN=${h.old} EM=${h.neu}${hasCo ? "" : "  [no company_id]"} ---`);
    try {
      for (const [label, re, n] of [["KN", OLD_RE, h.old], ["EM", NEW_RE, h.neu]]) {
        if (!n) continue;
        if (hasCo) {
          const by = await sql.unsafe(
            `SELECT company_id, COUNT(*)::int AS n FROM ${h.qt} WHERE "${h.col}"::text ~* $1 GROUP BY 1 ORDER BY 1`, [re]);
          out(`  ${label} by company: ${by.map((r) => `${r.company_id}=${r.n}`).join("  ")}`);
        }
        if (h.ty === "jsonb" || h.ty === "json") {
          const keys = await sql.unsafe(
            `SELECT e.key, COUNT(*)::int AS n, MIN(e.value) AS eg
               FROM ${h.qt} x, LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(x."${h.col}"::jsonb) = 'object' THEN x."${h.col}"::jsonb ELSE '{}'::jsonb END) e
              WHERE x."${h.col}"::text ~* $1 AND e.value ~* $1
              GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, [re]);
          if (keys.length) out(`  ${label} top-level keys holding it: ${keys.map((r) => `${r.key}=${r.n} (eg ${cut(r.eg, 60)})`).join(" | ")}`);
          const shapes = await sql.unsafe(
            `SELECT jsonb_typeof("${h.col}"::jsonb) AS ty, COUNT(*)::int AS n FROM ${h.qt} WHERE "${h.col}"::text ~* $1 GROUP BY 1`, [re]);
          out(`  ${label} json shape: ${shapes.map((r) => `${r.ty}=${r.n}`).join(" ")}`);
          const eg = await sql.unsafe(`SELECT "${h.col}"::text AS v FROM ${h.qt} WHERE "${h.col}"::text ~* $1 LIMIT 2`, [re]);
          for (const r of eg) out(`  ${label} sample: ${cut(r.v, 700)}`);
        } else {
          const eg = await sql.unsafe(
            `SELECT "${h.col}"::text AS v, COUNT(*)::int AS n FROM ${h.qt} WHERE "${h.col}"::text ~* $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 16`, [re]);
          for (const r of eg) out(`  ${label} ${String(r.n).padStart(6)} x ${cut(r.v, 200)}`);
        }
      }
    } catch (e) {
      out(`  detail failed: ${cut(e.message, 200)}`);
    }
  }

  /* G. How the old codes sit inside an order line: which fabricId goes with
     which fabricCode, per document arm. */
  out("\n=== G. SO lines: (fabricId, fabricCode, other colour keys) for the old codes ===");
  for (const r of await sql`
    SELECT h.company_id, i.variants->>'fabricId' AS fid, i.variants->>'fabricCode' AS fcode,
           i.variants->>'colourId' AS colour_id, i.variants->>'colorCode' AS color_code,
           i.variants->>'fabricColor' AS fabric_color, COUNT(*)::int AS n,
           MIN(i.doc_no) AS first_doc, MAX(i.doc_no) AS last_doc
      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE i.variants::text ~* ${OLD_RE}
     GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1, 2, 3`) out(`  ${JSON.stringify(r)}`);

  out("\n=== H. SO header status of the lines that name an old code ===");
  for (const r of await sql`
    SELECT h.company_id, h.status, COUNT(DISTINCT h.doc_no)::int AS orders, COUNT(*)::int AS lines
      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE i.variants::text ~* ${OLD_RE}
     GROUP BY 1, 2 ORDER BY 1, 2`) out(`  ${JSON.stringify(r)}`);
}

function k2(k) { const i = k.indexOf("."); return [k.slice(0, i), k.slice(i + 1)]; }

try {
  await main();
} catch (e) {
  console.error(`probe failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
