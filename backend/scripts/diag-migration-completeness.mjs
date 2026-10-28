#!/usr/bin/env node
// Read-only GO-LIVE completeness + integrity evidence for the 2990 -> Houzs
// migration (company_id=2990). Owner ask (2026-07-24): "before we go live, is
// EVERYTHING from the 2990 database migrated into Houzs as company_2 — SO, PO,
// GRN, PI, DO, SI, returns, suppliers, products, customers, payments, GL? give
// an evidence-based per-doc-type source-vs-dest count comparison." Two integrity
// problems were then added to the same report:
//   (1) DO STATUS gap — the DO list shows all company_2 DOs as dispatched while
//       the Sales Report shows only a handful delivered. Is that a filter, or did
//       DELIVERED DOs in 2990 land as NON-delivered in Houzs (a migration status
//       drop)?
//   (2) COSTING=0 — some orders show zero/blank cost. Did the migration DROP the
//       cost, or was the cost never computed in 2990 to begin with?
//
// WHY A SCRIPT (CLAUDE.md "never ask the owner to run a query"): the answer lives
// only in production + the 2990 upstream. Actions already holds the secrets, so
// nobody handles a credential. Pair with a manual workflow_dispatch, exactly like
// diag-supplier-reachability.mjs / check-2990-completeness.mjs.
//
// STRICTLY READ-ONLY. SELECT / count only — no DDL, no writes, no transaction. All
// dynamic SQL interpolates ONLY identifiers taken from our own information_schema
// catalog (or this file's hardcoded doc list), each re-validated against
// ^[a-z_][a-z0-9_]*$, and a numeric company_id we resolved ourselves — no user
// input reaches any statement. Exits 0 for every legitimate answer (the ANSWER is
// the output, not the exit code); non-zero only when a database is unreachable.
//
//   SOURCE = 2990 upstream Supabase (public schema) via SOURCE_SUPABASE_URL +
//            SOURCE_SERVICE_ROLE_KEY, @supabase/supabase-js — same as the importer.
//   DEST   = Houzs Postgres via DATABASE_URL, postgres.js. Dest tables live in a
//            MIX of schemas (baseline built `public`, later migrations built `scm`),
//            so every dest table is DISCOVERED across both schemas at runtime and
//            the schema it was counted in is printed — no schema is assumed.
//
// Source table names are the importer's ORDER list (migrate-2990-into-houzs.mjs):
// it reads source public.<T> and writes dest scm.<T> (same name), stamping
// company_id. So per doc type: source = count(public.<T> on 2990) and
// dest = count(<T> WHERE company_id=<2990 id> on Houzs); gap = source - dest.
// A non-zero gap is not automatically "broken": the importer uses ON CONFLICT DO
// NOTHING (UUID/natural-key collisions silently skip) and a couple of DANGLING
// guards, and some masters are excluded by owner ruling (lorries; drivers). The
// per-row classification of a gap lives in diag-2990-gaps.mjs — this script is the
// top-line count that says WHERE to point it.
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const DST = process.env.DATABASE_URL;
if (!DST) {
  console.error("DATABASE_URL not set. Aborting.");
  process.exit(1);
}
const SUPA_URL = process.env.SOURCE_SUPABASE_URL;
const SUPA_KEY = process.env.SOURCE_SERVICE_ROLE_KEY;
const src =
  SUPA_URL && SUPA_KEY
    ? createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } })
    : null;

const notice = (m) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

// Belt-and-braces guard for every identifier before it is interpolated into
// dynamic SQL. Names come from our own information_schema catalog or this file's
// hardcoded list; this keeps every built statement injection-free.
const SAFE = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => {
  if (!SAFE.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return s;
};

const pg = postgres(DST, { ssl: "require", prepare: false, max: 1 });

// ── Doc set the owner named, mapped to the importer's SOURCE table names.
// `alt` lists alternative dest names to also probe (e.g. the app may read
// mfg_delivery_orders while the importer wrote delivery_orders). Indented labels
// are the child/line + payment tables that make a header count meaningful.
const DOCS = [
  { label: "Sales Orders (SO)",         src: "mfg_sales_orders" },
  { label: "  SO items",                src: "mfg_sales_order_items" },
  { label: "  SO payments",             src: "mfg_sales_order_payments" },
  { label: "Delivery Orders (DO)",      src: "delivery_orders", alt: ["mfg_delivery_orders"] },
  { label: "  DO items",                src: "delivery_order_items", alt: ["mfg_delivery_order_items"] },
  { label: "  DO payments",             src: "delivery_order_payments" },
  { label: "Sales Invoices (SI)",       src: "sales_invoices", alt: ["mfg_sales_invoices"] },
  { label: "  SI items",                src: "sales_invoice_items", alt: ["mfg_sales_invoice_items"] },
  { label: "  SI payments",             src: "sales_invoice_payments" },
  { label: "Purchase Orders (PO)",      src: "purchase_orders" },
  { label: "  PO items",                src: "purchase_order_items" },
  { label: "GRN",                       src: "grns" },
  { label: "  GRN items",               src: "grn_items" },
  { label: "Purchase Invoices (PI)",    src: "purchase_invoices" },
  { label: "  PI items",                src: "purchase_invoice_items" },
  { label: "Purchase Returns",          src: "purchase_returns" },
  { label: "  Purchase Return items",   src: "purchase_return_items" },
  { label: "Delivery Returns",          src: "delivery_returns" },
  { label: "  Delivery Return items",   src: "delivery_return_items" },
  { label: "Suppliers",                 src: "suppliers" },
  { label: "Customers",                 src: "customers" },
  { label: "Products (mfg_products)",   src: "mfg_products" },
  { label: "Products (products)",       src: "products" },
  { label: "Product models",            src: "product_models" },
  { label: "GL accounts (chart)",       src: "accounts" },
];

// GL/journal transaction tables the importer's ORDER does NOT carry. Probed
// source-side so a populated 2990 ledger that never reached Houzs is visible as a
// gap rather than an unspoken assumption. Absent on source => nothing to migrate.
const GL_TXN_PROBE = ["journal_entries", "journal_entry_lines", "gl_entries", "ledger_entries", "general_ledger", "payment_vouchers", "payments"];

// ── DEST helpers (discover, never assume) ───────────────────────────────────
async function destLocations(table) {
  ident(table);
  const r = await pg`
    SELECT table_schema FROM information_schema.tables
     WHERE table_name = ${table}
       AND table_schema IN ('scm','public')
       AND table_type = 'BASE TABLE'
     ORDER BY CASE table_schema WHEN 'scm' THEN 0 ELSE 1 END`;
  return r.map((x) => x.table_schema);
}
async function destHasCol(schema, table, col) {
  const r = await pg`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = ${schema} AND table_name = ${table} AND column_name = ${col}
     LIMIT 1`;
  return r.length > 0;
}
async function destColsLike(schema, table, like) {
  const r = await pg`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = ${schema} AND table_name = ${table} AND column_name ILIKE ${like}
     ORDER BY column_name`;
  return r.map((x) => x.column_name);
}
async function destCount(schema, table, cid) {
  ident(schema); ident(table);
  const scoped = await destHasCol(schema, table, "company_id");
  const q = scoped
    ? `SELECT count(*)::int AS n FROM "${schema}"."${table}" WHERE company_id = ${cid}`
    : `SELECT count(*)::int AS n FROM "${schema}"."${table}"`;
  const r = await pg.unsafe(q);
  return { n: r[0].n, scoped };
}
// Resolve where a doc type actually landed: probe the importer-target name and
// every alt across both schemas; return all candidates that carry company_2 rows
// (or exist), and pick the one with the most company_2 rows as primary.
async function resolveDest(srcTable, alts, cid) {
  const names = [srcTable, ...(alts ?? [])];
  const found = [];
  for (const name of names) {
    for (const schema of await destLocations(name)) {
      const { n, scoped } = await destCount(schema, name, cid);
      found.push({ schema, table: name, n, scoped });
    }
  }
  if (!found.length) return { primary: null, found };
  const primary = found.reduce((a, b) => (b.n > a.n ? b : a), found[0]);
  return { primary, found };
}

// Source rows join to dest by the verbatim-copied UUID when the source carries
// `id`. The 2990 upstream keys some HEADERS by doc-number instead (e.g.
// mfg_sales_orders has no `id`), so fall back to the doc column — dest stores it
// with a "2990-" prefix (importer DOCNO_COL), so normalise both sides.
const DOCNO = { mfg_sales_orders: "doc_no", delivery_orders: "do_number", mfg_delivery_orders: "do_number" };
const normDoc = (v) => (v == null ? null : String(v).replace(/^2990-/, ""));
async function resolveJoinKey(srcTable, srcCols, schema, table) {
  if (srcCols.includes("id") && (await destHasCol(schema, table, "id"))) return { src: "id", dest: "id", doc: false };
  const dc = DOCNO[srcTable];
  if (dc && srcCols.includes(dc) && (await destHasCol(schema, table, dc))) return { src: dc, dest: dc, doc: true };
  return null;
}

// ── SOURCE helpers (Supabase REST) ──────────────────────────────────────────
async function srcCount(table) {
  if (!src) return undefined;
  try {
    const { count, error } = await src.schema("public").from(table).select("*", { count: "exact", head: true });
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}
async function srcColumns(table) {
  if (!src) return null;
  try {
    const { data, error } = await src.schema("public").from(table).select("*").limit(1);
    if (error || !data || !data.length) return null;
    return Object.keys(data[0]);
  } catch {
    return null;
  }
}
async function srcFetch(table, cols) {
  const out = [];
  const P = 1000;
  for (let f = 0; ; f += P) {
    const { data, error } = await src.schema("public").from(table).select(cols.join(",")).range(f, f + P - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < P) break;
  }
  return out;
}

const pad = (s, n) => String(s).padEnd(n);
const isZeroish = (v) => v == null || Number(v) === 0;

async function main() {
  const cidRow = await pg`SELECT id FROM companies WHERE code = '2990'`;
  if (!cidRow.length) {
    notice("FATAL — no company with code='2990'. Cannot scope dest counts.");
    await pg.end({ timeout: 5 });
    return;
  }
  const cid = Number(cidRow[0].id);
  notice(`2990 company_id = ${cid}   mode = READ-ONLY   source probe = ${src ? "ON" : "OFF (set SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY)"}`);
  notice("");

  // ===================================================================
  // SECTION 1 — per-doc-type SOURCE vs DEST(company_2) counts
  // ===================================================================
  notice("================ SECTION 1: per-doc-type counts (2990 SOURCE vs Houzs company_2) ================");
  notice(`${pad("doc type", 30)} ${pad("source", 8)} ${pad("dest(co2)", 10)} ${pad("gap", 8)} where`);
  let anyGap = false;
  for (const doc of DOCS) {
    const s = await srcCount(doc.src);
    let resolved;
    try {
      resolved = await resolveDest(doc.src, doc.alt, cid);
    } catch (e) {
      notice(`${pad(doc.label, 30)} ${pad(s ?? "-", 8)} ${pad("ERR", 10)} ${pad("", 8)} (${e.message})`);
      continue;
    }
    const { primary, found } = resolved;
    const destN = primary ? primary.n : null;
    const where = primary
      ? `${primary.schema}.${primary.table}${primary.scoped ? "" : " [GLOBAL/no company_id]"}`
      : "(no dest table)";
    // gap only meaningful when both sides known and source probe is on
    let gapStr = "";
    if (s === undefined) gapStr = "(no src probe)";
    else if (s === null) gapStr = "(src missing)";
    else if (destN === null) gapStr = `${s} MISSING`;
    else {
      const gap = s - destN;
      gapStr = gap === 0 ? "0" : gap > 0 ? `${gap} SHORT` : `${-gap} extra`;
      if (gap > 0) anyGap = true;
    }
    notice(`${pad(doc.label, 30)} ${pad(s === undefined ? "-" : s === null ? "(none)" : s, 8)} ${pad(destN ?? "(absent)", 10)} ${pad(gapStr, 8)} ${where}`);
    // If more than one dest candidate exists, surface all so a split landing is visible.
    if (found.length > 1) {
      for (const f of found) {
        notice(`      also present: ${f.schema}.${f.table} = ${f.n} co2 rows${f.scoped ? "" : " [global]"}`);
      }
    }
  }
  notice(anyGap
    ? "  NOTE: a SHORT gap can be an ON CONFLICT skip / dangling-guard drop / excluded master — run diag-2990-gaps.mjs to classify each row."
    : "  All doc types with a source probe are aligned (gap 0) or explained above.");
  notice("");

  // GL / journal transaction probe (source-only existence vs dest presence)
  notice("---- GL / journal transaction tables (importer ORDER carries only the `accounts` chart, NOT ledger txns) ----");
  for (const t of GL_TXN_PROBE) {
    const s = await srcCount(t);
    if (s === undefined) { notice(`  ${pad(t, 22)} : source probe OFF`); continue; }
    if (s === null) { notice(`  ${pad(t, 22)} : absent on 2990 source (nothing to migrate)`); continue; }
    const loc = await destLocations(t);
    let destStr = "(no dest table)";
    if (loc.length) {
      const { n } = await destCount(loc[0], t, cid);
      destStr = `${loc[0]}.${t} = ${n} co2`;
    }
    const flag = s > 0 && !loc.length ? "  <-- 2990 HAS these but NO dest table (NOT migrated)" : "";
    notice(`  ${pad(t, 22)} : source=${s}  dest=${destStr}${flag}`);
  }
  notice("");

  // ===================================================================
  // SECTION 2 — DO + SO status comparison (integrity problem #1)
  // ===================================================================
  notice("================ SECTION 2: status comparison (delivered gap) ================");
  await statusCompare("delivery_orders", ["mfg_delivery_orders"], "Delivery Orders", cid);
  await statusCompare("mfg_sales_orders", [], "Sales Orders", cid);
  notice("");

  // ===================================================================
  // SECTION 3 — costing = 0 / NULL (integrity problem #2)
  // ===================================================================
  notice("================ SECTION 3: costing zero/NULL (migration drop vs never-costed) ================");
  await costCompare("mfg_sales_orders", [], "Sales Orders", cid);
  await costCompare("delivery_orders", ["mfg_delivery_orders"], "Delivery Orders", cid);
  await costCompare("mfg_sales_order_items", [], "SO items", cid);
  notice("");
  notice("=== END — read-only, no rows changed. ===");
}

// Report dest company_2 rows by status vs source rows by status, and (for the
// id-intersection) the source-status -> dest-status transition matrix so a
// "delivered in 2990, non-delivered in Houzs" drop is counted exactly.
async function statusCompare(srcTable, alts, label, cid) {
  notice(`---- ${label}: status breakdown ----`);
  let resolved;
  try {
    resolved = await resolveDest(srcTable, alts, cid);
  } catch (e) {
    notice(`  dest resolve ERR: ${e.message}`);
    return;
  }
  const { primary, found } = resolved;
  if (!primary) { notice("  no dest table found."); return; }
  for (const f of found) if (found.length > 1) notice(`  (candidate ${f.schema}.${f.table} = ${f.n} co2 rows)`);
  const { schema, table } = primary;
  if (!(await destHasCol(schema, table, "status"))) {
    notice(`  ${schema}.${table} has no 'status' column — skipped.`);
    return;
  }
  // dest by status
  const destRows = await pg.unsafe(
    `SELECT COALESCE(status::text,'(null)') AS status, count(*)::int AS n
       FROM "${ident(schema)}"."${ident(table)}" WHERE company_id = ${cid}
      GROUP BY 1 ORDER BY 2 DESC`,
  );
  notice(`  DEST ${schema}.${table} co2 by status:`);
  for (const r of destRows) notice(`     ${pad(r.status, 18)} ${r.n}`);

  // source by status (+ join key for the transition matrix)
  const scols = await srcColumns(srcTable);
  if (!scols) { notice("  SOURCE not probed / empty — status gap cannot be computed."); return; }
  if (!scols.includes("status")) { notice(`  SOURCE ${srcTable} has no 'status' column — skipped.`); return; }
  const jk = await resolveJoinKey(srcTable, scols, schema, table);
  const fetchCols = jk ? [...new Set([jk.src, "status"])] : ["status"];
  let srcData;
  try {
    srcData = await srcFetch(srcTable, fetchCols);
  } catch (e) {
    notice(`  SOURCE fetch ERR: ${e.message}`);
    return;
  }
  const srcByStatus = new Map();
  for (const r of srcData) srcByStatus.set(r.status ?? "(null)", (srcByStatus.get(r.status ?? "(null)") ?? 0) + 1);
  notice(`  SOURCE 2990 ${srcTable} by status (all rows):`);
  for (const [st, n] of [...srcByStatus.entries()].sort((a, b) => b[1] - a[1])) notice(`     ${pad(st, 18)} ${n}`);

  // transition matrix on the id/doc-number intersection (dest carries source
  // UUIDs verbatim; doc-numbers with a "2990-" prefix normalised on both sides)
  if (!jk) { notice("  (no shared id/doc-number join key — transition matrix skipped)"); return; }
  const destKeyRows = await pg.unsafe(
    `SELECT "${ident(jk.dest)}"::text AS k, COALESCE(status::text,'(null)') AS status
       FROM "${ident(schema)}"."${ident(table)}" WHERE company_id = ${cid}`,
  );
  const keyOf = (v) => (jk.doc ? normDoc(v) : String(v));
  const destByKey = new Map(destKeyRows.map((r) => [keyOf(r.k), r.status]));
  const deliveredLike = (s) => /deliver|sign|complet|invoic/i.test(String(s));
  let matched = 0, srcDeliveredDestNot = 0;
  const trans = new Map();
  for (const r of srcData) {
    const d = destByKey.get(keyOf(r[jk.src]));
    if (d === undefined) continue;
    matched++;
    const key = `${r.status ?? "(null)"}  ->  ${d}`;
    trans.set(key, (trans.get(key) ?? 0) + 1);
    if (deliveredLike(r.status) && !deliveredLike(d)) srcDeliveredDestNot++;
  }
  notice(`  TRANSITION (source-status -> dest-status) over ${matched} ${jk.doc ? jk.src : "id"}-matched rows:`);
  for (const [k, n] of [...trans.entries()].sort((a, b) => b[1] - a[1])) {
    const flag = /deliver|sign|complet|invoic/i.test(k.split("->")[0]) && !/deliver|sign|complet|invoic/i.test(k.split("->")[1]) ? "  <-- DELIVERED-in-2990 now NON-delivered" : "";
    notice(`     ${pad(k, 40)} ${n}${flag}`);
  }
  notice(`  >>> ${label}: ${srcDeliveredDestNot} document(s) were DELIVERED-like in 2990 but landed NON-delivered in Houzs company_2.`);
}

// Report cost columns and how many company_2 rows are zero/NULL, then join by id
// to source to split "migration dropped the cost" from "never costed in 2990".
async function costCompare(srcTable, alts, label, cid) {
  notice(`---- ${label}: cost zero/NULL ----`);
  let resolved;
  try {
    resolved = await resolveDest(srcTable, alts, cid);
  } catch (e) {
    notice(`  dest resolve ERR: ${e.message}`);
    return;
  }
  const { primary } = resolved;
  if (!primary) { notice("  no dest table found."); return; }
  const { schema, table } = primary;
  const costCols = await destColsLike(schema, table, "%cost%");
  if (!costCols.length) { notice(`  ${schema}.${table}: no cost-like column.`); return; }
  const total = (await destCount(schema, table, cid)).n;
  notice(`  DEST ${schema}.${table} co2 total=${total}; cost columns: ${costCols.join(", ")}`);
  for (const col of costCols) {
    ident(col);
    const [r] = await pg.unsafe(
      `SELECT count(*) FILTER (WHERE "${col}" IS NULL OR "${col}" = 0)::int AS zero_null,
              count(*) FILTER (WHERE "${col}" > 0)::int AS positive
         FROM "${ident(schema)}"."${ident(table)}" WHERE company_id = ${cid}`,
    );
    notice(`     ${pad(col, 20)} zero/null=${r.zero_null}  positive=${r.positive}`);
  }

  // per-document join: pick a cost column present on BOTH source and dest.
  const scols = await srcColumns(srcTable);
  if (!scols) { notice("  SOURCE not probed / empty — cannot classify drop vs never-costed."); return; }
  const srcCostCols = scols.filter((c) => /cost/i.test(c));
  if (!srcCostCols.length) {
    notice(`  SOURCE ${srcTable} has NO cost column (${scols.length} cols). => a zero cost in Houzs is a Houzs-side costing/trigger concern, NOT a dropped migration value.`);
    return;
  }
  // Prefer the headline TOTAL cost column for the join; else first shared one.
  const joinCol =
    costCols.find((c) => /total.*cost/i.test(c) && srcCostCols.includes(c)) ||
    costCols.find((c) => srcCostCols.includes(c));
  const jk = joinCol ? await resolveJoinKey(srcTable, scols, schema, table) : null;
  if (!joinCol || !jk) {
    notice(`  SOURCE cost cols: ${srcCostCols.join(", ")} — no shared cost column + id/doc join key with dest (${costCols.join(", ")}); reporting side-by-side only.`);
    return;
  }
  ident(joinCol);
  let srcData;
  try {
    srcData = await srcFetch(srcTable, [...new Set([jk.src, joinCol])]);
  } catch (e) {
    notice(`  SOURCE fetch ERR: ${e.message}`);
    return;
  }
  const destRows = await pg.unsafe(
    `SELECT "${ident(jk.dest)}"::text AS k, "${joinCol}" AS c FROM "${ident(schema)}"."${ident(table)}" WHERE company_id = ${cid}`,
  );
  const keyOf = (v) => (jk.doc ? normDoc(v) : String(v));
  const destByKey = new Map(destRows.map((r) => [keyOf(r.k), r.c]));
  let matched = 0, dropped = 0, neverBoth = 0, destGained = 0, bothOk = 0;
  for (const r of srcData) {
    const d = destByKey.get(keyOf(r[jk.src]));
    if (d === undefined) continue;
    matched++;
    const sZero = isZeroish(r[joinCol]);
    const dZero = isZeroish(d);
    if (!sZero && dZero) dropped++;
    else if (sZero && dZero) neverBoth++;
    else if (sZero && !dZero) destGained++;
    else bothOk++;
  }
  notice(`  JOIN on '${joinCol}' over ${matched} ${jk.doc ? jk.src : "id"}-matched ${label}:`);
  notice(`     src>0 & dest zero/null : ${dropped}   <-- MIGRATION DROPPED THE COST`);
  notice(`     src zero/null & dest 0 : ${neverBoth}  (never costed in 2990 either)`);
  notice(`     src zero/null & dest>0 : ${destGained} (Houzs recomputed / trigger)`);
  notice(`     both > 0               : ${bothOk}`);
}

main()
  .then(() => pg.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("DIAG_FAIL", e.message);
    try { await pg.end({ timeout: 5 }); } catch {}
    process.exit(1);
  });
