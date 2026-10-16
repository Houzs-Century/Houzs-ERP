import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error - plain .mjs helper shared with the deploy-time migration runner
import { splitSqlStatements } from "../scripts/lib/split-sql.mjs";

/* pg-migrate runs every pending file on ONE connection, and a plain
   `SET search_path = scm, public` inside a file is session-level: it outlives
   that file's transaction and steers the next file's unqualified CREATE TABLE
   into scm. Which schema a table landed in then depended on how many files
   happened to be pending in that run. Production deployed 0235 and 0236 in
   separate runs (2026-08-01 11:22 and 12:14) and got public.table_layouts;
   staging caught up in bulk on 2026-08-12 and got scm.table_layouts, so
   20260925T0900_table_layouts_company_shared.sql failed there for ten days and
   33 later migrations never reached staging.

   Two things keep that closed: the runner resets search_path at the top of
   every file's transaction, and the relocation migration that moves the five
   stranded tables back sorts BEFORE the file that first needed them. */

const SCRIPTS = resolve(__dirname, "../scripts");
const MIGRATIONS = resolve(__dirname, "../src/db/migrations-pg");
const RELOCATE = "20260925T0859_relocate_tables_built_under_a_leaked_search_path.sql";
const FIRST_VICTIM = "20260925T0900_table_layouts_company_shared.sql";
const STRANDED = [
  "table_layouts",
  "assr_case_categories",
  "ac_snapshot_runs",
  "ac_snapshot_sales_orders",
  "ac_snapshot_purchase_orders",
];

describe("pg-migrate: a file's SET search_path cannot leak into the next file", () => {
  const src = readFileSync(resolve(SCRIPTS, "pg-migrate.mjs"), "utf8");

  it("resets search_path inside each file's transaction, before the file's own statements run", () => {
    const loop = src.slice(src.indexOf("for (const file of pending)"));
    const reset = loop.indexOf('tx.unsafe("RESET search_path")');
    const firstStatement = loop.indexOf("for (const s of stmts) await tx.unsafe(s)");
    expect(reset, "RESET search_path is missing from the per-file transaction").toBeGreaterThan(-1);
    expect(firstStatement).toBeGreaterThan(-1);
    expect(reset, "the reset must run BEFORE the file's statements").toBeLessThan(firstStatement);
    /* And inside pg.begin, so a file that fails rolls the reset back with it. */
    const begin = loop.indexOf("await pg.begin(async (tx) =>");
    expect(begin).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(begin);
  });
});

describe("the relocation migration for the tables staging built in scm", () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();

  it("exists and sorts before the first migration that needed those tables in public", () => {
    expect(files).toContain(RELOCATE);
    expect(files).toContain(FIRST_VICTIM);
    /* pg-migrate applies pending files in plain sort order (readdirSync().sort()),
       so this is exactly the order they run in on a database where both are
       still pending. */
    expect(files.indexOf(RELOCATE)).toBeLessThan(files.indexOf(FIRST_VICTIM));
  });

  it("names every stranded table, moves only scm -> public, and only when public lacks it", () => {
    const sql = readFileSync(resolve(MIGRATIONS, RELOCATE), "utf8");
    for (const t of STRANDED) expect(sql, t).toContain(`'${t}'`);
    expect(sql).toContain("to_regclass('public.' || t) IS NULL");
    expect(sql).toContain("to_regclass('scm.' || t) IS NOT NULL");
    expect(sql).toContain("ALTER TABLE scm.%I SET SCHEMA public");
    /* The splitter must hand the DO block to postgres whole; a shattered
       PL/pgSQL body is the other way a migration like this dies on deploy. */
    const stmts = splitSqlStatements(sql) as string[];
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain("DO $$");
    expect(stmts[0]).toContain("END $$");
  });
});
