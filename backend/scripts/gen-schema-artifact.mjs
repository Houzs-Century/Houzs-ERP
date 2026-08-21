#!/usr/bin/env node
// ----------------------------------------------------------------------------
// gen-schema-artifact.mjs — regenerate backend/src/db/schema.pg.ts FROM THE
// LIVE DATABASE with `drizzle-kit pull`. Never hand-write this file.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// The artifact was hand-ported from the SQLite schema at the Postgres cutover
// and never validated. Its own header says "DRAFT ... UNTESTED until validated
// with drizzle-kit against the live Supabase DB"; db/schema.ts carries the
// same unfinished follow-up. By 2026-08-21 it was missing
// project_brands.company_id (mig 0093) and .logo_r2_key (mig 0069), declaring a
// UNIQUE on project_brands.name that production does not have, and typing four
// relations that production either dropped or turned into VIEWs. A drizzle read
// cannot name a column the schema does not carry, which is how the brand
// letterhead leak stayed invisible to both company-scope checkers.
//
// ── WHAT IT GENERATES ───────────────────────────────────────────────────────
// Only the tables the application actually models through Drizzle — the set is
// DERIVED from the `import { ... } from ".../db/schema"` statements in
// backend/src, never hand-listed, plus `extraTables` from
// src/db/schema-tables.json for a table being introduced.
//
// The public schema holds 232 relations. The 31 tables the old artifact
// declared but nothing imports were the worst of the drift (creditors was short
// 46 columns; trips and lorries are VIEWs in production; overdue_history and
// trip_locations were dropped by migs 0017/0055) and they are not regenerated:
// an unused copy of a table that lives in `scm` is a liability, not a document.
//
// ── THE ONE REPAIR PASS, AND WHY IT IS NOT A HAND-EDIT ──────────────────────
// drizzle-kit 0.31.10 emits INVALID TypeScript for a column default that is a
// function call. 94 columns in this database hit it, e.g.
//
//   created_at: text().default(to_char(timezone(\'UTC\'::text, now()), ...)),
//
// — a bare SQL expression with backslash-escaped quotes, which does not parse.
// `pull` output therefore cannot be committed as it comes out. This script
// rewrites exactly that shape into `.default(sql`<expr>`)`, which is the form
// drizzle documents for a raw default. The transform is mechanical, hermetic
// and self-tested below; it changes no other token. If it ever fails its own
// fixture the script REFUSES to write, because a silently mangled schema is
// worse than a stale one.
//
// ── USAGE ───────────────────────────────────────────────────────────────────
//   DATABASE_URL=... node backend/scripts/gen-schema-artifact.mjs
//   ... --out <path>     write elsewhere (CI uploads it as an artifact)
//   ... --dry-run        print the table list and stop
//
// `pull` reads the catalog only. The repo rule stands: drizzle-kit is for type
// generation and schema diffing, NEVER as the migration runner.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { repairRawDefaults, selfTestRepair } from "./lib/schema-artifact.mjs";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(backendRoot, "src");
const TABLES_JSON = path.join(backendRoot, "src", "db", "schema-tables.json");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const outArg = argv.indexOf("--out");
const OUT = outArg === -1 ? path.join(SRC, "db", "schema.pg.ts") : path.resolve(argv[outArg + 1]);

const die = (msg) => {
  console.error(`gen-schema-artifact: ${msg}`);
  process.exit(2);
};

// ── 1. THE REPAIR PASS, self-tested before anything is read ─────────────
{
  const problems = selfTestRepair();
  if (problems.length) {
    die(
      "REPAIR self-test FAILED - refusing to write a schema this pass may have mangled.\n  " +
        problems.join("\n  "),
    );
  }
}

// ── 2. the table set, DERIVED from the imports ──────────────────────────────
const walk = (dir, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
};
const IMPORT_RE = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'][^"']*db\/schema(?:\.pg)?["']/gs;
const imported = new Set();
for (const file of walk(SRC)) {
  if (file.replace(/\\/g, "/").includes("/db/schema")) continue;
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(IMPORT_RE)) {
    for (const part of m[1].split(",")) {
      // `projects as projectsTable` -> the table is `projects`.
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[a-z_][a-z_0-9]*$/.test(name)) imported.add(name);
    }
  }
}
let extras = [];
try {
  const j = JSON.parse(fs.readFileSync(TABLES_JSON, "utf8"));
  extras = Array.isArray(j.extraTables) ? j.extraTables : [];
} catch {
  extras = [];
}
const tables = [...new Set([...imported, ...extras])].sort();

/* SELF-TEST the derivation. An import scan that returns [] would pull nothing
   and write an empty schema over a working one. These four are imported by
   name in routes/users.ts and routes/projects.ts and are the point of the
   exercise; if they stop appearing, the scan has died. */
{
  const must = ["project_brands", "users", "projects", "project_finance_lines"];
  const missing = must.filter((t) => !tables.includes(t));
  if (tables.length < 10 || missing.length) {
    die(
      "IMPORT-DERIVATION self-test FAILED - not generating.\n" +
        `  found ${tables.length} imported table(s) across ${walk(SRC).length} source files\n` +
        `  missing: ${missing.join(", ") || "(none)"}`,
    );
  }
}

console.log(`gen-schema-artifact: ${tables.length} table(s) modelled through Drizzle:`);
console.log("  " + tables.join(", "));
if (dryRun) process.exit(0);

// ── 3. pull, closing over foreign-key targets ───────────────────────────────
if (!process.env.DATABASE_URL) die("DATABASE_URL is required. `pull` reads the live catalog.");

function pullOnce(wanted) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "schema-pull-"));
  const cfg = path.join(backendRoot, ".schema-pull.config.ts");
  fs.writeFileSync(
    cfg,
    `import type { Config } from "drizzle-kit";
export default {
  schema: "./src/db/schema.pg.ts",
  out: ${JSON.stringify(tmp.replace(/\\/g, "/"))},
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
  schemaFilter: ["public"],
  tablesFilter: ${JSON.stringify(wanted)},
  introspect: { casing: "preserve" },
} satisfies Config;
`,
  );
  try {
    execFileSync("npx", ["drizzle-kit", "pull", `--config=${cfg}`], {
      cwd: backendRoot,
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
      shell: process.platform === "win32",
    });
  } finally {
    fs.rmSync(cfg, { force: true });
  }
  const pulled = path.join(tmp, "schema.ts");
  if (!fs.existsSync(pulled)) die(`drizzle-kit produced no ${pulled}`);
  const out = fs.readFileSync(pulled, "utf8");
  fs.rmSync(tmp, { recursive: true, force: true });
  return out;
}

/* FOREIGN-KEY CLOSURE. drizzle-kit emits `foreignColumns: [companies.id]` for
   an FK whose TARGET was filtered out, and the identifier then resolves to
   nothing — the file does not compile. Pull, look for references it could not
   satisfy, add those tables, pull again. Bounded, because an unbounded loop
   against a 232-table schema would quietly widen back to everything. */
let wanted = [...tables];
let raw = "";
let closure = [];
for (let round = 1; round <= 4; round++) {
  raw = pullOnce(wanted);
  const declaredHere = new Set([...raw.matchAll(/export const ([a-z_0-9]+) = pgTable\(/g)].map((m) => m[1]));
  const referenced = new Set([...raw.matchAll(/foreignColumns:\s*\[([a-z_0-9]+)\./g)].map((m) => m[1]));
  const missing = [...referenced].filter((t) => !declaredHere.has(t)).sort();
  if (!missing.length) break;
  if (round === 4) {
    die(
      `FK closure did not settle after 4 pulls; still unresolved: ${missing.join(", ")}.\n` +
        "  Refusing to write a schema that would not compile.",
    );
  }
  console.log(`FK closure round ${round}: adding ${missing.join(", ")}`);
  closure = [...new Set([...closure, ...missing])].sort();
  wanted = [...new Set([...wanted, ...missing])].sort();
}

const pulledTables = [...raw.matchAll(/export const ([a-z_0-9]+) = pgTable\(/g)].map((m) => m[1]);
const notPulled = tables.filter((t) => !pulledTables.includes(t));
if (pulledTables.length === 0) die("pull produced a schema with ZERO pgTable declarations.");
if (closure.length) {
  console.log(`\nPulled additionally as foreign-key targets: ${closure.join(", ")}`);
}

const { text, repaired } = repairRawDefaults(raw);
console.log(`\npull produced ${pulledTables.length} table(s); repaired ${repaired} raw SQL default(s).`);
if (notPulled.length) {
  /* A requested table the catalog does not have is a FINDING - it is either a
     VIEW, or it was dropped. Say so loudly; do not quietly write a file that
     silently lost a table the code imports. */
  console.log(
    `\nRequested but NOT present as a table in public: ${notPulled.join(", ")}\n` +
      "  Each is either a VIEW or dropped. Callers importing it must be fixed, not the schema.",
  );
}

const HEADER = `// ---------------------------------------------------------------------------
// GENERATED FILE - do not hand-edit.
//
//   DATABASE_URL=... node backend/scripts/gen-schema-artifact.mjs
//
// Produced by \`drizzle-kit pull\` against the LIVE database, restricted to the
// tables backend/src actually imports from "../db/schema" (the list is derived
// from those imports, never typed by hand). One mechanical repair pass runs
// over the output: drizzle-kit 0.31.10 emits invalid TypeScript for a
// function-call column default, and that shape is rewritten to .default(sql\`\`).
//
// WHY IT IS GENERATED. The hand-ported predecessor drifted from production and
// the drift was invisible: it lacked project_brands.company_id (mig 0093) and
// .logo_r2_key (mig 0069), so the SO letterhead's drizzle read could not name a
// company predicate and neither company-scope checker could see the leak that
// printed Houzs's mark on 69 of 2990's sales orders. It also declared a UNIQUE
// on project_brands.name that production does not have, and typed \`trips\` and
// \`lorries\` as tables when production has them as VIEWs.
//
// backend/scripts/check-schema-artifact-drift.mjs fails a PR when this file and
// the migration tree disagree, and answers the same question against the live
// catalog when dispatched. See docs/schema-artifact.md.
// ---------------------------------------------------------------------------
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, HEADER + text.replace(/^﻿/, ""));
console.log(`\nwrote ${OUT} (${(HEADER + text).split("\n").length} lines)`);
