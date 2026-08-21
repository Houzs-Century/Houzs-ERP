#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-orm-read-scope.mjs — DRIZZLE statements in route handlers that read or
// write a company-scoped table with no company predicate.
//
// ── WHY A THIRD SCRIPT ──────────────────────────────────────────────────────
//
// The two that exist cannot see a Drizzle statement at all, and that is not an
// oversight in either of them:
//
//   check-company-scope.mjs      reads supabase-js builder chains (`.eq('id',…)`)
//   check-master-read-scope.mjs  reads RAW SQL — its own RAW_SQL_STMT is
//                                `/\.prepare\(|\bsql`|\bdb\.query\(/`, and its
//                                self-test asserts that a builder call does NOT
//                                match
//
// A Drizzle read — `getDb(c.env).select({…}).from(project_brands)` — is neither
// shape. Nine files in backend/src import tables from "../db/schema", and every
// statement in them was outside both checkers' remit.
//
// ── WHY IT COULD NOT HAVE EXISTED BEFORE 2026-08-21 ─────────────────────────
//
// This script decides "is this table company-scoped?" from src/db/schema.pg.ts:
// a table is scoped when the ARTIFACT declares a company_id column. That is the
// only definition that matches what the code can actually write — a Drizzle
// predicate can only name a column the schema carries.
//
// Until the artifact was regenerated from the live database it did NOT carry
// project_brands.company_id (production has had it since mig 0093) or
// .logo_r2_key (mig 0069). So the answer to "which Drizzle tables are
// company-scoped?" was: none of the interesting ones. That is the mechanism
// that hid the brand-letterhead leak — 69 of 2990's sales orders printed
// Houzs's Zanotti mark — from every automated check the repo had. Fixing the
// artifact is what makes this script possible; check-schema-artifact-drift.mjs
// is what stops the artifact rotting back.
//
// ── WHAT IT FLAGS ───────────────────────────────────────────────────────────
// A Drizzle statement inside backend/src/{scm/,}routes/*.ts that names a
// company-scoped table via .from() / .update() / .insert() / .delete() and
// carries no company predicate in its own window.
//
// STATEMENT-LEVEL, never handler-level — the same choice its raw-SQL sibling
// made and for the same reason: a handler that scopes its main query correctly
// may still hold an unscoped master read, and that is exactly the defect shape.
//
// ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
// A LEAD GENERATOR, like both siblings. It cannot tell a deliberately global
// read (a users lookup) from a leak, and it cannot see a predicate composed
// three frames away. A finding is a thing to READ. Cleared ones get a
// `// company-scope: <reason>` beside the statement so nobody re-chases them.
//
// ── USAGE ───────────────────────────────────────────────────────────────────
//   node backend/scripts/check-orm-read-scope.mjs            # report, exit 0
//   node backend/scripts/check-orm-read-scope.mjs --check    # RATCHET: exit 1
//                                                            # on a NEW finding
//   node backend/scripts/check-orm-read-scope.mjs --update   # rewrite baseline,
//                                                            # SHRINK-only
//   ... --check --ratchet-against origin/main                # baseline may not GROW
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseSchemaArtifact, selfTestParser } from "./lib/schema-artifact.mjs";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(backendRoot, "..");
const ROUTE_DIRS = [
  path.join(backendRoot, "src", "scm", "routes"),
  path.join(backendRoot, "src", "routes"),
];
const ARTIFACT = path.join(backendRoot, "src", "db", "schema.pg.ts");
const BASELINE_REL = "backend/scripts/orm-read-scope-baseline.json";
const BASELINE_PATH = path.join(backendRoot, "scripts", "orm-read-scope-baseline.json");

const checkMode = process.argv.includes("--check");
const updateMode = process.argv.includes("--update");
const ratchetAgainst = (() => {
  const i = process.argv.indexOf("--ratchet-against");
  if (i === -1) return null;
  const ref = process.argv[i + 1];
  if (!ref || ref.startsWith("--")) {
    // Silently comparing against nothing is the one outcome that must not
    // happen: the step would go green while checking against no baseline.
    console.error("FATAL: --ratchet-against needs a git ref (e.g. origin/main).");
    process.exit(2);
  }
  return ref;
})();

// ── the company-scoped table set, DERIVED from the artifact ─────────────────
{
  const problems = selfTestParser();
  if (problems.length) {
    console.error("check-orm-read-scope: PARSER self-test FAILED - not reporting.\n  " + problems.join("\n  "));
    process.exit(2);
  }
}
const { tables: declared, unknownBuilders } = parseSchemaArtifact(fs.readFileSync(ARTIFACT, "utf8"));
if (unknownBuilders.length) {
  console.error(
    "check-orm-read-scope: ARTIFACT self-test FAILED - unknown column builder(s):\n  " +
      unknownBuilders.join("\n  "),
  );
  process.exit(2);
}
const COMPANY_TABLES = new Set(
  [...declared].filter(([, t]) => t.columns.has("company_id")).map(([name]) => name),
);
/* SELF-TEST the derivation. project_brands carries company_id in production
   (mig 0093, NOT NULL, FK, indexed) and it is the table this whole class of
   check exists for. If the artifact stops declaring it, this script would
   report a clean run over an empty table set - the exact failure mode that hid
   the letterhead leak. Refuse instead. */
if (COMPANY_TABLES.size === 0 || !COMPANY_TABLES.has("project_brands")) {
  console.error(
    "check-orm-read-scope: TABLE-DERIVATION self-test FAILED - not reporting.\n" +
      `  ${declared.size} tables in src/db/schema.pg.ts, ${COMPANY_TABLES.size} of them carry company_id\n` +
      "  project_brands is " +
      (declared.has("project_brands") ? "declared WITHOUT company_id" : "not declared at all") +
      "\n  Production has had project_brands.company_id since mig 0093. The artifact is stale:\n" +
      "  regenerate it (DATABASE_URL=... node backend/scripts/gen-schema-artifact.mjs).",
  );
  process.exit(2);
}

// ── patterns ────────────────────────────────────────────────────────────────
/* Which local identifier refers to which table, per file. `projects as
   projectsTable` is real (routes/projects.ts), so the alias has to be resolved
   or every statement in that file is invisible. */
const IMPORT_RE = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'][^"']*db\/schema(?:\.pg)?["']/gs;
/* The four Drizzle verbs that name a table positionally. */
const ORM_STMT = /\.(from|update|insert|delete)\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
/* A company predicate on a Drizzle statement is `<alias>.company_id` inside an
   eq/inArray, or one of the id helpers feeding it. A bare `company_id` counts
   for an insert's value object - naming the column IS the scoping act there. */
const SCOPED_INLINE =
  /\bcompany_id\b|activeCompanyId|requireActiveCompanyId|allowedCompanyIds|scopeToCompany|scopeToCompanyId|scopeToAllowedCompanies|companyIdScope|companyScope/;
const WRITE_VERBS = new Set(["update", "insert", "delete"]);
const HANDLER = /^\s*[A-Za-z_$][\w$]*\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`](\/[^'"`]*)['"`]/;
const ANNOTATION = /\/\/\s*company-scope:/;

/* ── SELF-TESTS. A verdict computed over nothing must never read as a pass. ──
   The siblings have died silently five times: a lost \s, a dead alternation, a
   scrape that returned []. Refuse to RUN rather than report from a dead matcher. */
{
  const importOk = (() => {
    IMPORT_RE.lastIndex = 0;
    const m = [
      ...`import {\n  project_brands,\n  projects as projectsTable,\n} from "../db/schema";`.matchAll(IMPORT_RE),
    ];
    return m.length === 1 && m[0][1].includes("project_brands") && m[0][1].includes("projectsTable");
  })();
  const stmtOk = (() => {
    ORM_STMT.lastIndex = 0;
    const hits = [...".select({ name: project_brands.name })\n.from(project_brands);".matchAll(ORM_STMT)];
    ORM_STMT.lastIndex = 0;
    const write = [...'db.update(projects).set({ x: 1 })'.matchAll(ORM_STMT)];
    ORM_STMT.lastIndex = 0;
    const notATable = [...'.from("project_brands")'.matchAll(ORM_STMT)];
    return (
      hits.length === 1 &&
      hits[0][1] === "from" &&
      hits[0][2] === "project_brands" &&
      write.length === 1 &&
      write[0][1] === "update" &&
      notATable.length === 0
    );
  })();
  const scopedOk =
    SCOPED_INLINE.test("      .where(eq(project_brands.company_id, coId));") &&
    SCOPED_INLINE.test("  const coId = activeCompanyId(c);") &&
    !SCOPED_INLINE.test("      .where(inArray(project_brands.name, requested));");
  /* THE REGRESSION FIXTURE. This exact pair is the defect, before and after. If
     the "before" ever stops being flagged, this script has gone blind to the
     thing it was written for. */
  const before = `.select({ name: project_brands.name })\n.from(project_brands);`;
  const after = `.select({ name: project_brands.name })\n.from(project_brands)\n.where(eq(project_brands.company_id, coId));`;
  const regressionOk = !SCOPED_INLINE.test(before) && SCOPED_INLINE.test(after);
  const handlerOk = (() => {
    const m = "app.post('/import/csv', requirePermission('projects.manage'), async (c) => {".match(HANDLER);
    return !!m && m[1] === "post" && m[2] === "/import/csv" && !HANDLER.test("  const db = getDb(c.env);");
  })();
  if (!importOk || !stmtOk || !scopedOk || !regressionOk || !handlerOk) {
    console.error(
      "check-orm-read-scope: PATTERN self-test FAILED - not reporting.\n" +
        `  import=${importOk} stmt=${stmtOk} scoped=${scopedOk} regression=${regressionOk} handler=${handlerOk}`,
    );
    process.exit(2);
  }
}

/** STABLE KEY: file + route identity + table. Never a line number. */
const keyOf = (f) => `${f.file} :: ${f.handler} :: ${f.table}`;
{
  const k = keyOf({ file: "a.ts", handler: "GET /x", table: "project_brands" });
  if (k !== "a.ts :: GET /x :: project_brands") {
    console.error("check-orm-read-scope: KEY self-test FAILED - not reporting.");
    process.exit(2);
  }
}

const findings = [];
let filesScanned = 0;
let statementsScanned = 0;

for (const dir of ROUTE_DIRS) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    continue;
  }
  for (const file of entries) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const full = path.join(dir, file);
    const rel = path.relative(repoRoot, full).replace(/\\/g, "/");
    const raw = fs.readFileSync(full, "utf8");
    const lines = raw.split("\n");
    filesScanned++;

    /* alias -> table name, from this file's own schema imports. */
    const alias = new Map();
    IMPORT_RE.lastIndex = 0;
    for (const m of raw.matchAll(IMPORT_RE)) {
      for (const part of m[1].split(",")) {
        const bits = part.trim().split(/\s+as\s+/);
        const table = bits[0].trim();
        const local = (bits[1] ?? bits[0]).trim();
        if (/^[a-z_][a-z_0-9]*$/.test(table) && /^[A-Za-z_$][\w$]*$/.test(local)) alias.set(local, table);
      }
    }
    if (alias.size === 0) continue;

    // Which handler each line belongs to (the nearest registration above it).
    let currentHandler = "(module scope)";
    const handlerOf = lines.map((l) => {
      const m = l.match(HANDLER);
      if (m) currentHandler = `${m[1].toUpperCase()} ${m[2]}`;
      return currentHandler;
    });

    for (let i = 0; i < lines.length; i++) {
      ORM_STMT.lastIndex = 0;
      const hits = [...lines[i].matchAll(ORM_STMT)];
      if (!hits.length) continue;
      for (const hit of hits) {
        const table = alias.get(hit[2]);
        if (!table || !COMPANY_TABLES.has(table)) continue;
        statementsScanned++;
        /* LOOK BACK as well as forward. A Drizzle chain is written over many
           lines and `const coId = activeCompanyId(c)` is routinely above the
           `.from(...)`, while the `.where(...)` is below it. */
        const from = Math.max(0, i - 8);
        const to = Math.min(i + 14, lines.length);
        const stmt = lines.slice(from, to).join("\n");
        if (SCOPED_INLINE.test(stmt)) continue;
        if (ANNOTATION.test(stmt)) continue;
        findings.push({
          file: rel,
          handler: handlerOf[i],
          table,
          verb: hit[1],
          line: i + 1,
          text: lines[i].trim().slice(0, 110),
          writes: WRITE_VERBS.has(hit[1]),
        });
      }
    }
  }
}

const byKey = new Map();
for (const f of findings) {
  if (!byKey.has(keyOf(f))) byKey.set(keyOf(f), []);
  byKey.get(keyOf(f)).push(f);
}
const keys = [...byKey.keys()].sort();

const readBaseline = () => {
  try {
    const j = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    return Array.isArray(j.unscoped) ? j.unscoped : null;
  } catch {
    return null;
  }
};

const NOTE = [
  "GRANDFATHER BASELINE for backend/scripts/check-orm-read-scope.mjs --check.",
  "Each key is one <route file> :: <METHOD path> :: <table> whose DRIZZLE statement",
  "names a company-scoped table with no company predicate. This is DEBT, not the",
  "standard: a NEW one is BLOCKED because it is not in this list. The list may only",
  "SHRINK - --update refuses to add a key, exactly as lint-ratchet refuses to raise",
  "a ceiling. To clear one: add the predicate, or annotate the statement",
  "// company-scope: <why> if it is deliberately global.",
];

if (updateMode) {
  const prev = readBaseline();
  if (prev === null) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify({ "//": NOTE, unscoped: keys }, null, 2) + "\n");
    console.log(`orm-read-scope: baseline CREATED with ${keys.length} keys.`);
    process.exit(0);
  }
  const grew = keys.filter((k) => !prev.includes(k));
  if (grew.length) {
    console.error(
      "check-orm-read-scope: --update REFUSES to grow the baseline.\n" +
        "  A ratchet that can be raised is not a ratchet. Scope the statement,\n" +
        "  or annotate it `// company-scope: <reason>`.\n" +
        grew.map((k) => `    NEW  ${k}`).join("\n"),
    );
    process.exit(1);
  }
  const kept = prev.filter((k) => keys.includes(k));
  fs.writeFileSync(BASELINE_PATH, JSON.stringify({ "//": NOTE, unscoped: kept }, null, 2) + "\n");
  console.log(`orm-read-scope: baseline ${prev.length} -> ${kept.length} keys.`);
  process.exit(0);
}

console.log(
  `check-orm-read-scope: ${filesScanned} route files, ${statementsScanned} Drizzle statement(s) on company-scoped tables.`,
);
console.log(
  `${findings.length} statement(s) with no company predicate ` +
    `(${findings.filter((f) => f.writes).length} of them WRITE), across ${keys.length} handler/table pairs.`,
);
console.log(
  `Company-scoped tables DERIVED from src/db/schema.pg.ts: ${COMPANY_TABLES.size} of ${declared.size} declare company_id.`,
);
console.log('Silence a verified-safe statement with "// company-scope: <reason>" beside it.');

let lastFile = "";
for (const k of keys) {
  const group = byKey.get(k);
  const f = group[0];
  if (f.file !== lastFile) {
    console.log(`\n${f.file}`);
    lastFile = f.file;
  }
  console.log(`  ${f.writes ? "WRITE" : "read "}  ${f.handler}  ->  ${f.table}`);
  for (const g of group.slice(0, 3)) console.log(`           L${g.line}  ${g.text}`);
}

if (checkMode) {
  const prev = readBaseline();
  if (prev === null) {
    console.error(
      "\ncheck-orm-read-scope: --check has NO baseline to compare against.\n" +
        "  Refusing to report a pass over nothing. Run --update once to create it.",
    );
    process.exit(2);
  }
  if (ratchetAgainst) {
    let base = [];
    try {
      const txt = execFileSync("git", ["show", `${ratchetAgainst}:${BASELINE_REL}`], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      base = JSON.parse(txt).unscoped ?? [];
    } catch {
      /* The file does not exist on the base ref - this PR introduces it. That is
         the ONLY legitimate absence, and it is a one-time state. */
      console.log(
        `\n(no ${BASELINE_REL} on ${ratchetAgainst} - this PR introduces the baseline; growth guard skipped once)`,
      );
      base = null;
    }
    if (base !== null) {
      const grew = prev.filter((k) => !base.includes(k));
      if (grew.length) {
        console.error(
          `\ncheck-orm-read-scope: the BASELINE FILE grew vs ${ratchetAgainst}:\n` +
            grew.map((k) => `    ADDED  ${k}`).join("\n") +
            "\n\n  A ratchet may only shrink. Scope the statement or annotate it.",
        );
        process.exit(1);
      }
    }
  }
  const added = keys.filter((k) => !prev.includes(k));
  if (added.length) {
    console.error(
      `\ncheck-orm-read-scope: ${added.length} NEW unscoped Drizzle statement(s):\n` +
        added.map((k) => `    ${k}`).join("\n") +
        "\n\n  Add the company predicate, or annotate the statement\n" +
        "  `// company-scope: <reason>` if it is deliberately global.",
    );
    process.exit(1);
  }
  console.log(`\nOK - every finding is grandfathered (${prev.length} keys); no NEW unscoped Drizzle statement.`);
}
