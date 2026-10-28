// Load the authoritative D1 export into Supabase Postgres — line-based + robust.
//
// RUN IT WITH:  node --experimental-transform-types scripts/load-d1-dump-to-pg.mjs
// (Node 22.7+ / 24, from backend/.) The flag is needed because step 3 imports the
// app's real SQLite->Postgres date rules out of src/db/d1-compat.ts rather than
// keeping a second copy — see scripts/lib/sqlite-default-to-pg.mjs. Without it
// the script aborts at startup with an explanatory error, before touching the DB.
//
// This is a ONE-SHOT environment builder (docs/DB-REPOINT-RUNBOOK.md step 1).
// It is NOT run by deploy.yml or by any CI workflow and must never become part
// of one: it DROPs every table in `public`.
//
// The dump has multi-line CREATE TABLEs and single-line INSERTs, in an order
// that isn't create-before-insert. So:
//   1. Line-extract CREATE TABLE (multi-line) / CREATE INDEX / INSERT (1 line).
//   2. Load ONLY the schema into better-sqlite3 (small) to read clean column
//      metadata via PRAGMA table_info — no FK/CHECK/dialect headaches.
//   3. Build clean Postgres tables from that metadata.
//   4. Stream the INSERT lines straight to Postgres (named columns -> safe).
// Idempotent: wipes public first.
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import postgres from "postgres";
import { sqliteDefaultToPg } from "./lib/sqlite-default-to-pg.mjs";

// Target MUST be explicit. The old `.dev.vars` fallback silently resolved to the
// live prod DSN (that file holds the prod connection string by convention) and
// is the mechanism behind the 2026-06-17 prod wipe — removed. See prod-wipe COE.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("REFUSING: set DATABASE_URL explicitly. The silent .dev.vars fallback (which resolved to the prod DSN) was removed after the 2026-06-17 prod wipe.");
  process.exit(1);
}
// PROD GUARD — FAIL CLOSED. This script DROPs + reloads EVERY table. A hardcoded
// prod-ref substring check fails OPEN the moment prod moves projects (it has,
// twice). So treat ANY non-loopback target as production and require an explicit
// acknowledgement, regardless of which project it points at.
const isLoopbackTarget = (() => {
  try {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      new URL(url).hostname.toLowerCase(),
    );
  } catch {
    return false;
  }
})();
if (!isLoopbackTarget && process.env.ACK_PROD_WIPE !== "yes") {
  console.error("REFUSING: target is a non-local database and this script DROPs+reloads EVERY table. If you truly mean to re-cutover it, set ACK_PROD_WIPE=yes.");
  process.exit(1);
}
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

// ---- 1) line-based extraction --------------------------------------------
const lines = readFileSync("houzs-d1-full.sql", "utf8").split("\n");
const creates = [];
const inserts = [];
const indexes = [];
const parenDelta = (s) => {
  let d = 0;
  for (const c of s) {
    if (c === "(") d++;
    else if (c === ")") d--;
  }
  return d;
};
// An INSERT is complete when its single quotes are balanced (not mid-string)
// AND it ends with ")" — handles values containing embedded newlines.
const insertComplete = (s) => {
  let inStr = false;
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "'") {
      if (inStr && s[k + 1] === "'") {
        k++;
        continue;
      }
      inStr = !inStr;
    }
  }
  return !inStr && /\)\s*;?\s*$/.test(s);
};
// wrangler encodes newline values as replace('..\n..','\n',char(10)). Postgres
// has no char() function (char is a type) — it uses chr(). Rewrite char( -> chr(
// only OUTSIDE string literals so real data is untouched. replace() exists in PG.
const fixSqliteFns = (s) => {
  let out = "";
  let inStr = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "'") {
      if (inStr && s[k + 1] === "'") {
        out += "''";
        k++;
        continue;
      }
      inStr = !inStr;
      out += c;
      continue;
    }
    if (!inStr && s.slice(k, k + 5).toLowerCase() === "char(") {
      out += "chr(";
      k += 4;
      continue;
    }
    out += c;
  }
  return out;
};
for (let i = 0; i < lines.length; i++) {
  const ln = lines[i];
  const t = ln.trimStart();
  if (t.startsWith("CREATE TABLE")) {
    // a CREATE TABLE spans lines until its parentheses balance back to 0
    let block = ln;
    let depth = parenDelta(ln);
    while (depth > 0 && i + 1 < lines.length) {
      const nx = lines[++i];
      block += "\n" + nx;
      depth += parenDelta(nx);
    }
    creates.push(block.replace(/;\s*$/, ""));
  } else if (t.startsWith("CREATE INDEX") || t.startsWith("CREATE UNIQUE INDEX")) {
    indexes.push(ln.replace(/;\s*$/, ""));
  } else if (t.startsWith("INSERT INTO")) {
    let stmt = ln;
    while (!insertComplete(stmt) && i + 1 < lines.length) stmt += "\n" + lines[++i];
    inserts.push(fixSqliteFns(stmt.replace(/;\s*$/, "")));
  }
}
console.log(`extracted: ${creates.length} tables, ${inserts.length} inserts, ${indexes.length} indexes`);

// ---- 2) schema-only into better-sqlite3, read metadata --------------------
const lite = new Database(":memory:");
lite.pragma("foreign_keys = OFF");
let parsed = 0;
for (const c of creates) {
  try {
    lite.exec(c + ";");
    parsed++;
  } catch (e) {
    console.log(`  sqlite parse fail: ${e.message.slice(0, 70)}`);
  }
}
const tableNames = lite
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);
console.log(`schema parsed: ${parsed}/${creates.length} -> ${tableNames.length} tables`);

const mapType = (ty) => {
  ty = (ty || "").toUpperCase();
  if (ty.includes("INT")) return "bigint";
  if (ty.includes("REAL") || ty.includes("FLOA") || ty.includes("DOUB")) return "double precision";
  if (ty.includes("BLOB")) return "bytea";
  return "text";
};

// ---- 3) wipe + create clean PG tables -------------------------------------
const exist = await pg`select tablename from pg_tables where schemaname='public'`;
if (exist.length) {
  await pg.unsafe("DROP TABLE IF EXISTS " + exist.map((r) => `"${r.tablename}"`).join(",") + " CASCADE");
  console.log(`dropped ${exist.length} existing tables`);
}
const identityTables = [];
let okT = 0;
// DEFAULT tally. Until 2026-07-21 this loop read `dflt_value` (it is named in the
// pragma comment below) and emitted nothing for it, so every rebuilt schema kept
// NOT NULL and lost DEFAULT — the exact combination that makes inserts fail and
// never succeed. Four repair episodes over a month came out of that one omission
// (docs/pg-migration-dropped-defaults-coe.md). Defaults are now carried, and the
// ones that could NOT be translated with certainty are printed and counted rather
// than guessed at, because a wrong default writes wrong data silently.
let defCarried = 0;
const defSkips = [];
for (const name of tableNames) {
  const cols = lite.prepare(`PRAGMA table_info("${name}")`).all(); // {cid,name,type,notnull,dflt_value,pk}
  const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  const singleIntPk = pk.length === 1 && /INT/i.test(cols.find((c) => c.name === pk[0]).type || "");
  let tableCarried = 0;
  const tableSkips = [];
  const defs = cols.map((c) => {
    const pgType = mapType(c.type);
    if (singleIntPk && c.name === pk[0]) {
      // Postgres rejects a column that has both a DEFAULT and an identity
      // clause ("column ... is an identity column" / multiple default values),
      // so the identity branch stays exactly as it was. A SQLite default here
      // is vanishingly rare (an INTEGER PRIMARY KEY is the rowid alias), but if
      // one exists it is reported instead of silently dropped.
      if (c.dflt_value !== null && c.dflt_value !== undefined) {
        tableSkips.push({
          column: c.name,
          value: String(c.dflt_value),
          reason: "column is rebuilt as `generated by default as identity`, which cannot also carry a DEFAULT",
        });
      }
      return `"${c.name}" bigint generated by default as identity primary key`;
    }
    let def = `"${c.name}" ${pgType}${c.notnull && c.pk === 0 ? " not null" : ""}`;
    if (c.dflt_value !== null && c.dflt_value !== undefined) {
      const { clause, reason } = sqliteDefaultToPg(c.dflt_value, pgType);
      if (clause) {
        def += ` ${clause}`;
        tableCarried++;
      } else {
        tableSkips.push({ column: c.name, value: String(c.dflt_value), reason });
      }
    }
    return def;
  });
  for (const s of tableSkips) {
    console.log(`  WARNING: DEFAULT NOT CARRIED  ${name}.${s.column}  sqlite default: ${s.value}`);
    console.log(`           reason: ${s.reason}`);
  }
  let ddl = `CREATE TABLE "${name}" (${defs.join(", ")}`;
  if (pk.length && !singleIntPk) ddl += `, primary key(${pk.map((c) => `"${c}"`).join(",")})`;
  ddl += ")";
  try {
    await pg.unsafe(ddl);
    okT++;
    defCarried += tableCarried;
    for (const s of tableSkips) defSkips.push({ table: name, ...s });
    if (singleIntPk) identityTables.push(name);
  } catch (e) {
    console.log(`  PG CREATE FAIL ${name}: ${e.message.slice(0, 90)}`);
  }
}
console.log(`PG tables created: ${okT}/${tableNames.length}`);
console.log(`DEFAULTs: ${defCarried} carried, ${defSkips.length} skipped with a warning`);
if (defSkips.length) {
  // Repeat the skips together at the end of the create phase: a warning buried
  // in 110 tables of scroll-back is a warning nobody reads, and every entry here
  // is a column that will now behave differently from the D1 original.
  console.log("  columns whose SQLite DEFAULT was NOT translated:");
  for (const s of defSkips) console.log(`    ${s.table}.${s.column}  (${s.value})  ${s.reason}`);
}

// ---- 4) stream INSERTs to PG (batched, per-row fallback) ------------------
let rows = 0,
  bad = 0;
const BATCH = 500;
for (let i = 0; i < inserts.length; i += BATCH) {
  const chunk = inserts.slice(i, i + BATCH);
  try {
    await pg.unsafe(chunk.join(";\n"));
    rows += chunk.length;
  } catch {
    for (const one of chunk) {
      try {
        await pg.unsafe(one);
        rows++;
      } catch (e) {
        bad++;
        if (bad <= 3) console.log(`  ROW FAIL: ${e.message.slice(0, 60)}\n    SQL: ${one.slice(0, 380)}`);
      }
    }
  }
  if (i % 10000 === 0) console.log(`  ...${rows}/${inserts.length}`);
}
console.log(`rows loaded: ${rows}/${inserts.length} (${bad} failed)`);

// ---- 5) reset identity sequences -----------------------------------------
for (const t of identityTables) {
  try {
    await pg.unsafe(`select setval(pg_get_serial_sequence('"${t}"','id'), coalesce((select max(id) from "${t}"),1))`);
  } catch {
    /* ignore */
  }
}

const tot = await pg`select count(*)::int n from information_schema.tables where table_schema='public'`;
console.log(`\nDONE. public tables: ${tot[0].n}, rows loaded: ${rows}`);
console.log(
  `DEFAULTs carried: ${defCarried}, skipped with a warning: ${defSkips.length}` +
    (defSkips.length ? " — a clean run has ZERO skips; review the WARNING lines above before using this database" : ""),
);
await pg.end();
