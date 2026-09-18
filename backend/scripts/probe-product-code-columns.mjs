/* READ-ONLY. Every column on production that is named like it stores a product
   (SKU) code, for the rename cascade's coverage test.

   WHY. Changing a SKU's code (PATCH /mfg-products/:id) re-points every table that
   snapshots the code as text — there is no foreign key to follow. The list lives
   in backend/src/scm/lib/product-code-rename.ts, and
   backend/tests/productCodeRenameCoverage.test.ts fails when a code-bearing
   column is neither cascaded nor recorded as keeping its old value. That test
   reads the snapshot this script writes; migrations newer than the snapshot are
   scanned by the test itself.

   WRITES: only the local file OUT (default product-code-columns.snapshot.json).
   Nothing in the database: one READ ONLY transaction of SELECTs.

   Printed, not stored (numbers expire): each column's row count and how many rows
   hold a value equal to a live mfg_products code of the same company.

   RE-RUN: stateless. Copy the written file over
   backend/tests/fixtures/product-code-columns.snapshot.json when it differs. */
import postgres from "postgres";
import fs from "node:fs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(2); }
const OUT = process.env.OUT || "product-code-columns.snapshot.json";
const GH = !!process.env.GITHUB_ACTIONS;
const say = (m = "") => console.log(GH && m.startsWith("=") ? `::notice::${m}` : m);

/* Keep in step with CODE_COLUMN in backend/tests/productCodeRenameCoverage.test.ts. */
const CODE_COLUMN = /(^|_)(item_code|product_code|material_code|sku|model_code)$/;
/* The one cascaded code column not named like one (hr_item_kpi.ref, per-SKU KPI). */
const EXTRA = new Set(["scm.hr_item_kpi.ref"]);

const sql = postgres(DSN, { ssl: "require", max: 1, prepare: false });
try {
  await sql.begin(async (tx) => {
    await tx`SET TRANSACTION READ ONLY`;
    await tx`SET LOCAL statement_timeout = '120s'`;

    const cols = await tx`
      SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS col, c.data_type AS dt,
             EXISTS (SELECT 1 FROM information_schema.columns x WHERE x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.column_name = 'company_id') AS has_company,
             EXISTS (SELECT 1 FROM information_schema.columns x WHERE x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.column_name = 'material_kind') AS has_kind
        FROM information_schema.columns c
        JOIN pg_namespace n ON n.nspname = c.table_schema
        JOIN pg_class k ON k.relname = c.table_name AND k.relnamespace = n.oid AND k.relkind IN ('r', 'p')
       WHERE c.table_schema IN ('scm', 'public')
       ORDER BY 1, 2, 3`;
    const picked = cols.filter((c) => !(c.s === "scm" && c.t === "mfg_products")
      && (CODE_COLUMN.test(c.col) || EXTRA.has(`${c.s}.${c.t}.${c.col}`)));

    say(`=== ${picked.length} code-bearing base-table columns (scm + public) ===`);
    const scalar = [];
    for (const c of picked) {
      const rel = `"${c.s}"."${c.t}"`;
      const col = `"${c.col}"`;
      let note = "";
      if (["text", "character varying", "character"].includes(c.dt)) {
        try {
          await tx`SAVEPOINT p`;
          const [r] = await tx.unsafe(c.has_company
            ? `SELECT (SELECT count(*) FROM ${rel})::int AS total, count(*)::int AS hits FROM ${rel} t JOIN scm.mfg_products p ON p.code = t.${col} AND p.company_id = t.company_id`
            : `SELECT (SELECT count(*) FROM ${rel})::int AS total, count(*)::int AS hits FROM ${rel} t WHERE t.${col} IN (SELECT code FROM scm.mfg_products)`);
          await tx`RELEASE SAVEPOINT p`;
          note = `rows=${r.total} product_code_rows=${r.hits}`;
        } catch (e) { await tx`ROLLBACK TO SAVEPOINT p`; note = `count failed: ${e.message}`; }
      } else note = `type ${c.dt}`;
      say(`  ${c.s}.${c.t}.${c.col} company_id=${c.has_company} material_kind=${c.has_kind} ${note}`);
      scalar.push({ schema: c.s, table: c.t, column: c.col, companyId: c.has_company, materialKind: c.has_kind });
    }

    say("=== array / json columns named like a code list (printed only; the cascade rewrites scalar text) ===");
    const lists = cols.filter((c) => ["ARRAY", "jsonb", "json"].includes(c.dt) && /(code|sku|item)/i.test(c.col));
    if (!lists.length) say("  (none)");
    for (const c of lists) say(`  ${c.s}.${c.t}.${c.col} (${c.dt})`);

    let newest = null;
    try {
      await tx`SAVEPOINT m`;
      [{ newest }] = await tx`SELECT max(filename) AS newest FROM _pg_migrations`;
      await tx`RELEASE SAVEPOINT m`;
    } catch (e) { await tx`ROLLBACK TO SAVEPOINT m`; say(`newest migration unreadable: ${e.message}`); }

    const snapshot = {
      source: "production information_schema, backend/scripts/probe-product-code-columns.mjs",
      capturedAt: new Date().toISOString().slice(0, 10),
      newestMigrationAtCapture: newest,
      columns: scalar,
    };
    fs.writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
    say(`=== wrote ${OUT}: ${scalar.length} columns, newest applied migration ${newest} ===`);
  });
} finally {
  await sql.end();
}
console.log("READ-ONLY — nothing was written to the database.");
