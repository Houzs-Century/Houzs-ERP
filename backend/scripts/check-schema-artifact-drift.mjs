#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-schema-artifact-drift.mjs — does backend/src/db/schema.pg.ts still
// describe the database it is typed against?
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// schema.pg.ts is the ORM's picture of the world. Every drizzle read is typed
// from it, so a column the file does not know about does not exist as far as
// the compiler, the author, or any source-scanning checker is concerned.
//
// On 2026-08-21 that cost a real defect. `project_brands` has carried
// `company_id` in production since mig 0093 and `logo_r2_key` since mig 0069;
// the artifact declared neither. The SO letterhead read the brand list through
// drizzle with no company predicate — 69 of 2990's sales orders printed Houzs's
// mark — and neither check-company-scope.mjs nor check-master-read-scope.mjs
// could see it, because the column a predicate would name was not in the schema
// they are derived from. The same file also declares a UNIQUE on
// `project_brands.name` that production does not have, and a brief written from
// 0000_baseline.sql nearly shipped a migration adding a column that exists.
//
// The artifact's own header still says "DRAFT ... UNTESTED until validated with
// drizzle-kit against the live Supabase DB", and db/schema.ts carries the
// follow-up nobody did. This script is what stops it rotting again.
//
// ── TWO SOURCES OF TRUTH, ON PURPOSE ────────────────────────────────────────
//   --source=migrations  (default; NO database needed, runs in CI)
//       Reconstructs each declared table's column set from src/db/migrations-pg
//       — the tree deploy.yml actually applies — and fails when the artifact is
//       missing a column a migration added. This is the layer that would have
//       caught company_id and logo_r2_key on the day they landed.
//   --source=live        (needs DATABASE_URL; dispatched, never scheduled)
//       Reads the real catalog. This is the ONLY layer that sees out-of-band
//       DDL, and out-of-band DDL is documented to exist here (see
//       .github/workflows/dump-scm-schema.yml: `DRAFT` is a live value of
//       mfg_so_status present in neither SQL tree). It reads pg_class, not
//       information_schema, so MATERIALIZED VIEWS are covered — mv_ar_aging is
//       absent from information_schema.views and broke a deploy once.
//
// Read-only: SELECTs only, no DDL, no writes, no transaction.
//
// ── EXIT CODES ──────────────────────────────────────────────────────────────
//   0  report printed (or --check found no NEW drift)
//   1  --check found NEW drift
//   2  the checker itself is broken (self-test failed, parse died, DB
//      unreachable). A verdict computed over nothing must never read as a pass.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSchemaArtifact, selfTestParser } from "./lib/schema-artifact.mjs";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = path.join(backendRoot, "src", "db", "schema.pg.ts");
const MIGRATIONS = path.join(backendRoot, "src", "db", "migrations-pg");
const BASELINE_PATH = path.join(backendRoot, "scripts", "schema-artifact-drift-baseline.json");

const argv = process.argv.slice(2);
const checkMode = argv.includes("--check");
const updateMode = argv.includes("--update");
const source = (argv.find((a) => a.startsWith("--source=")) ?? "--source=migrations").slice(9);
if (source !== "migrations" && source !== "live") {
  console.error(`FATAL: --source must be 'migrations' or 'live', got '${source}'.`);
  process.exit(2);
}

const fatal = (msg) => {
  console.error(`check-schema-artifact-drift: ${msg}`);
  process.exit(2);
};

// ── 1. self-test the parser BEFORE reading anything real ────────────────────
{
  const problems = selfTestParser();
  if (problems.length) {
    fatal("PARSER self-test FAILED - not reporting.\n  " + problems.join("\n  "));
  }
}

// ── 2. the artifact ─────────────────────────────────────────────────────────
const artifactSrc = fs.readFileSync(ARTIFACT, "utf8");
const { tables: declared, unknownBuilders } = parseSchemaArtifact(artifactSrc);
if (declared.size < 30) {
  fatal(
    `ARTIFACT self-test FAILED - parsed only ${declared.size} pgTable(...) blocks from ` +
      `src/db/schema.pg.ts, which contains ${(artifactSrc.match(/pgTable\(/g) ?? []).length} ` +
      "occurrences of pgTable(. Refusing to report drift from a parse that plainly died.",
  );
}
if (unknownBuilders.length) {
  fatal(
    "ARTIFACT self-test FAILED - column builder(s) this checker does not know:\n  " +
      unknownBuilders.join("\n  ") +
      "\n  Add them to BUILDERS in scripts/lib/schema-artifact.mjs. An unknown builder\n" +
      "  makes its column invisible, which is the exact failure this check exists to stop.",
  );
}

// ── 3. the reference column sets ────────────────────────────────────────────
/** Reconstruct columns per table from the LIVE migration tree. No DB needed. */
function fromMigrations() {
  let files = [];
  try {
    files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  } catch (e) {
    fatal(`cannot read ${MIGRATIONS}: ${e.message}`);
  }
  if (files.length < 100) {
    fatal(`MIGRATION self-test FAILED - only ${files.length} .sql files in migrations-pg.`);
  }
  const cols = new Map(); // "<schema>.<table>" -> Set(column)
  /* SCHEMA ATTRIBUTION IS NOT OPTIONAL. 182 statements in this tree set a
     search_path, 70 of them to `scm, public`, so an unqualified CREATE/ALTER
     in an scm migration is an scm object. Folding them onto the bare table name
     merges scm.lorries into public.lorries and produces confident nonsense in
     both directions. Segments are cut at each SET search_path and carry the
     first schema in it. */
  const key = (schema, t) => `${schema}.${t}`.toLowerCase();
  const add = (schema, t, c) => {
    const k = key(schema, t);
    if (!cols.has(k)) cols.set(k, new Set());
    cols.get(k).add(c.toLowerCase());
  };
  const qual = (m, seg) => (m[1] ? m[1].toLowerCase() : seg);
  const CREATE =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(public|scm)\.)?"?([a-z_0-9]+)"?\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
  const ALTER_ADD =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:(public|scm)\.)?"?([a-z_0-9]+)"?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_0-9]+)"?/gi;
  const ALTER_DROP =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:(public|scm)\.)?"?([a-z_0-9]+)"?\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([a-z_0-9]+)"?/gi;
  const ALTER_RENAME =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:(public|scm)\.)?"?([a-z_0-9]+)"?\s+RENAME\s+COLUMN\s+"?([a-z_0-9]+)"?\s+TO\s+"?([a-z_0-9]+)"?/gi;
  const DROP_TABLE = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:(public|scm)\.)?"?([a-z_0-9]+)"?/gi;
  const SEARCH_PATH = /SET\s+search_path\s*(?:=|TO)\s*'?([a-z_]+)'?/gi;
  const NON_COLUMN = /^\s*(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|LIKE|EXCLUDE)\b/i;
  /* Cut a file into [schema, text] segments at every SET search_path. */
  const segmentsOf = (sql) => {
    SEARCH_PATH.lastIndex = 0;
    const marks = [...sql.matchAll(SEARCH_PATH)];
    if (!marks.length) return [["public", sql]];
    const out = [["public", sql.slice(0, marks[0].index)]];
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length ? marks[i + 1].index : sql.length;
      out.push([marks[i][1].toLowerCase(), sql.slice(marks[i].index, end)]);
    }
    return out;
  };
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), "utf8");
    for (const [seg, text] of segmentsOf(sql)) {
      for (const m of text.matchAll(CREATE)) {
        for (const line of m[3].split("\n")) {
          if (NON_COLUMN.test(line)) continue;
          const cm = line.match(/^\s*"?([a-z_0-9]+)"?\s+[A-Za-z]/);
          if (cm) add(qual(m, seg), m[2], cm[1]);
        }
      }
      for (const m of text.matchAll(ALTER_ADD)) add(qual(m, seg), m[2], m[3]);
      for (const m of text.matchAll(ALTER_RENAME)) {
        cols.get(key(qual(m, seg), m[2]))?.delete(m[3].toLowerCase());
        add(qual(m, seg), m[2], m[4]);
      }
      for (const m of text.matchAll(ALTER_DROP)) cols.get(key(qual(m, seg), m[2]))?.delete(m[3].toLowerCase());
      for (const m of text.matchAll(DROP_TABLE)) cols.delete(key(qual(m, seg), m[2]));
    }
  }
  /* The artifact is public-only, so the comparison is public-only. */
  const pub = new Map();
  for (const [k, v] of cols) if (k.startsWith("public.")) pub.set(k.slice(7), v);
  /* SELF-TEST the reconstruction against facts true of the LIVE tree and
     INDEPENDENT of this artifact's state. If they stop holding, the regexes
     have died and the drift report is a report over nothing. */
  const must = [
    ["project_brands", "company_id"], // mig 0093
    ["project_brands", "logo_r2_key"], // mig 0069
    ["project_brands", "name"], // 0000_baseline CREATE body parsed at all
    ["project_cost_rates", "commission_boost_pct"],
    ["users", "email"],
  ];
  const missed = must.filter(([t, c]) => !pub.get(t)?.has(c));
  /* The DROP side has to be proven too, or a dead table reads as live. 0017's
     `DROP TABLE IF EXISTS overdue_history CASCADE` is unconditional, so it is
     the honest fixture. public.lorries is NOT: 0055 drops it and 0083 then
     re-adds a column to it inside a `DO $$ IF EXISTS ...` guard, which this
     text scan cannot evaluate. That is precisely why absence is only ever
     reported from --source=live. */
  const dropOk = !pub.has("overdue_history");
  /* And the schema split has to be proven: scm.lorries is CREATEd in 0053 and
     must NOT have been folded into public. */
  const splitOk = cols.has("scm.lorries");
  if (pub.size < 50 || missed.length || !dropOk || !splitOk) {
    fatal(
      "MIGRATION-DERIVATION self-test FAILED - not reporting.\n" +
        `  reconstructed ${pub.size} public tables (${cols.size} total) from ${files.length} migrations\n` +
        `  missing known-true columns: ${missed.map((m) => m.join(".")).join(", ") || "(none)"}\n` +
        `  DROP TABLE honoured: ${dropOk}   scm/public kept apart: ${splitOk}`,
    );
  }
  return {
    cols: pub,
    kinds: new Map(),
    uniqueSets: null,
    typeOf: () => null,
    matviews: [],
    label: `${files.length} files in src/db/migrations-pg`,
  };
}

/** Read the LIVE catalog. pg_class, not information_schema: matviews only exist there. */
async function fromLive() {
  const { default: postgres } = await import("postgres");
  const url =
    process.env.DATABASE_URL ??
    (() => {
      try {
        return fs
          .readFileSync(path.join(backendRoot, ".dev.vars"), "utf8")
          .match(/DATABASE_URL="([^"]+)"/)?.[1];
      } catch {
        return undefined;
      }
    })();
  if (!url) fatal("DATABASE_URL not set (env var or backend/.dev.vars). Aborting.");
  const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
  try {
    /* relkind: r=table p=partitioned v=view m=MATERIALIZED VIEW f=foreign.
       'm' is the one information_schema.columns cannot see. */
    const rows = await pg`
      SELECT c.relname AS table_name,
             c.relkind::text AS kind,
             a.attname AS column_name,
             format_type(a.atttypid, a.atttypmod) AS data_type,
             a.attnotnull AS not_null
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attribute a
               ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
       ORDER BY c.relname, a.attnum`;
    if (!rows.length) fatal("LIVE read returned ZERO rows from pg_class - refusing to report.");
    const cols = new Map();
    const kinds = new Map();
    const types = new Map();
    for (const r of rows) {
      kinds.set(r.table_name, r.kind);
      if (!cols.has(r.table_name)) cols.set(r.table_name, new Set());
      if (r.column_name) {
        cols.get(r.table_name).add(r.column_name);
        types.set(`${r.table_name}.${r.column_name}`, { type: r.data_type, notNull: r.not_null });
      }
    }
    const uniq = await pg`
      SELECT c.relname AS table_name,
             i.relname AS index_name,
             ix.indisprimary AS is_pk,
             (SELECT array_agg(att.attname ORDER BY k.ord)
                FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum = k.attnum) AS cols
        FROM pg_index ix
        JOIN pg_class c ON c.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND ix.indisunique
       ORDER BY 1, 2`;
    const uniqueSets = new Map();
    for (const u of uniq) {
      if (!uniqueSets.has(u.table_name)) uniqueSets.set(u.table_name, []);
      uniqueSets.get(u.table_name).push({ index: u.index_name, pk: u.is_pk, cols: u.cols ?? [] });
    }
    const matviews = [...kinds].filter(([, k]) => k === "m").map(([t]) => t);
    return {
      cols,
      kinds,
      uniqueSets,
      typeOf: (t, c) => types.get(`${t}.${c}`) ?? null,
      matviews,
      label: `live pg_class: ${kinds.size} public relations, ${matviews.length} materialized view(s)`,
    };
  } finally {
    await pg.end({ timeout: 5 });
  }
}

const ref = source === "live" ? await fromLive() : fromMigrations();

// ── 4. the drift ────────────────────────────────────────────────────────────
/* ABSENCE IS ONLY EVER REPORTED FROM THE LIVE CATALOG. The migration text scan
   proves PRESENCE well (a migration added column X, so X exists) and proves
   absence badly: DDL wrapped in `DO $$ IF EXISTS ... END $$` cannot be
   evaluated by a scanner, tables were loaded straight from the D1 dump without
   a CREATE in this tree, and out-of-band DDL is documented to exist. Reporting
   "not in the DB" from that would fail PRs over the checker's own blind spots. */
const canProveAbsence = source === "live";
const findings = [];
for (const table of [...declared.keys()].sort()) {
  const decl = declared.get(table);
  const live = ref.cols.get(table);
  if (!live) {
    if (canProveAbsence) {
      findings.push({ kind: "table-absent", table, detail: "declared in the artifact, absent from the live catalog" });
    }
    continue;
  }
  const kind = ref.kinds.get(table);
  if (kind && kind !== "r" && kind !== "p") {
    findings.push({
      kind: "not-a-table",
      table,
      detail: `pgTable(...) but relkind='${kind}'` + (kind === "m" ? " (MATERIALIZED VIEW)" : kind === "v" ? " (VIEW)" : ""),
    });
  }
  for (const c of [...live].sort()) {
    if (!decl.columns.has(c)) {
      const t = ref.typeOf(table, c);
      findings.push({
        kind: "column-missing-from-artifact",
        table,
        column: c,
        detail: t ? `${t.type}${t.notNull ? " NOT NULL" : ""}` : "added by a migration",
      });
    }
  }
  if (canProveAbsence) {
    for (const c of decl.columns.keys()) {
      if (!live.has(c)) {
        findings.push({
          kind: "column-not-in-db",
          table,
          column: c,
          detail: "the artifact declares it; the live catalog does not",
        });
      }
    }
  }
  if (ref.uniqueSets) {
    const sets = ref.uniqueSets.get(table) ?? [];
    for (const [c, meta] of decl.columns) {
      if (!meta.unique) continue;
      if (sets.some((s) => s.cols.length === 1 && s.cols[0] === c)) continue;
      findings.push({
        kind: "unique-not-in-db",
        table,
        column: c,
        detail:
          ".unique() in the artifact, no single-column unique index in production" +
          (sets.length ? ` (has: ${sets.map((s) => `${s.index}(${s.cols.join(",")})`).join(", ")})` : " (none at all)"),
      });
    }
  }
}

// ── 5. report ───────────────────────────────────────────────────────────────
const keyOf = (f) => `${f.table}${f.column ? "." + f.column : ""} :: ${f.kind}`;
const keys = [...new Set(findings.map(keyOf))].sort();

console.log(`check-schema-artifact-drift: source=${source} (${ref.label})`);
console.log(`artifact: src/db/schema.pg.ts declares ${declared.size} tables.`);
if (source === "live") {
  const undeclared = [...ref.kinds].filter(([t, k]) => (k === "r" || k === "p") && !declared.has(t)).map(([t]) => t);
  console.log(`public tables NOT declared in the artifact: ${undeclared.length}`);
  if (ref.matviews.length) console.log(`materialized views in public: ${ref.matviews.join(", ")}`);
}
console.log(`${findings.length} drift finding(s) across ${keys.length} key(s).`);

let lastTable = "";
for (const f of findings) {
  if (f.table !== lastTable) {
    console.log(`\n${f.table}`);
    lastTable = f.table;
  }
  console.log(`  ${f.kind.padEnd(28)} ${(f.column ?? "").padEnd(22)} ${f.detail}`);
}

const readBaseline = () => {
  try {
    const j = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    return Array.isArray(j.drift) ? j.drift : null;
  } catch {
    return null;
  }
};

const NOTE = [
  "GRANDFATHER BASELINE for backend/scripts/check-schema-artifact-drift.mjs --check.",
  "Each key is one <table>[.<column>] :: <drift kind> where src/db/schema.pg.ts and the",
  "LIVE migration tree disagree. This is DEBT, not the standard: a NEW disagreement is",
  "BLOCKED because it is not in this list. The list may only SHRINK - --update refuses",
  "to add a key, exactly as lint-ratchet refuses to raise a ceiling.",
  "To clear one: regenerate the artifact (docs/schema-artifact.md), never hand-edit it.",
];

if (updateMode) {
  const prev = readBaseline();
  if (prev === null) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify({ "//": NOTE, drift: keys }, null, 2) + "\n");
    console.log(`\nschema-artifact-drift: baseline CREATED with ${keys.length} keys.`);
    process.exit(0);
  }
  const grew = keys.filter((k) => !prev.includes(k));
  if (grew.length) {
    console.error(
      "\ncheck-schema-artifact-drift: --update REFUSES to grow the baseline.\n" +
        "  A ratchet that can be raised is not a ratchet. Regenerate the artifact.\n" +
        grew.map((k) => `    NEW  ${k}`).join("\n"),
    );
    process.exit(1);
  }
  const kept = prev.filter((k) => keys.includes(k));
  fs.writeFileSync(BASELINE_PATH, JSON.stringify({ "//": NOTE, drift: kept }, null, 2) + "\n");
  console.log(`\nschema-artifact-drift: baseline ${prev.length} -> ${kept.length} keys.`);
  process.exit(0);
}

if (checkMode) {
  const prev = readBaseline();
  if (prev === null) {
    console.error(
      "\ncheck-schema-artifact-drift: --check has NO baseline to compare against.\n" +
        "  Refusing to report a pass over nothing. Run --update once to create it.",
    );
    process.exit(2);
  }
  const added = keys.filter((k) => !prev.includes(k));
  if (added.length) {
    console.error(
      `\ncheck-schema-artifact-drift: ${added.length} NEW schema-artifact disagreement(s):\n` +
        added.map((k) => `    ${k}`).join("\n") +
        "\n\n  src/db/schema.pg.ts no longer describes the database it types.\n" +
        "  Regenerate it from the live DB (docs/schema-artifact.md) - never hand-edit.",
    );
    process.exit(1);
  }
  console.log(`\nOK - every disagreement is grandfathered (${prev.length} keys); no NEW drift.`);
}
