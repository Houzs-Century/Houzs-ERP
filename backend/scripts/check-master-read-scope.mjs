#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-master-read-scope.mjs — RAW-SQL statements in route handlers that read
// or write a COMPANY-SCOPED table with no company predicate.
//
// ── WHY THIS IS A SECOND SCRIPT AND NOT A PATCH TO check-company-scope.mjs ───
//
// That script missed the 2026-08-21 brand-letterhead defect — the SO PDF read
// `SELECT name, logo_r2_key FROM project_brands WHERE active = 1` with no
// company predicate and stamped Houzs's Zanotti mark on 2990's Sales Orders —
// and it missed it for TWO independent reasons. Both were verified by patching
// a copy of it on 2026-08-21, not inferred:
//
//   1. its `RAW_SQL_TABLES` is a HAND-WRITTEN list of fifteen table names.
//      `project_brands` was never on it. Adding it changed nothing, because:
//   2. one scope helper ANYWHERE in a handler acquits the WHOLE handler before
//      any statement is read (`if (delegated || hasScopedQuery ||
//      wrapsABuilder) return;`). `GET /:docNo` calls salesDocOutOfScope and
//      scopeToCompany, so all ~300 lines of it were excused, the unscoped
//      project_brands read included. Only lifting that return surfaced L2759.
//
// Fixing both INSIDE that script was measured and rejected. Its `--strict` mode
// enforces "handler WRITE findings stay at ZERO", and the numbers were:
//
//     as it stands today                    12 findings,  0 writes
//     + table list derived from migrations  72 findings, 20 writes
//     + the whole-handler acquittal lifted  76 findings, 22 writes
//
// Twenty write findings is not a bug count — it is a triage backlog, most of it
// false positives from a handler-wide predicate this heuristic cannot see. The
// only ways to land it there were to loosen `--strict` or to grandfather WRITES
// into a baseline whose whole purpose is that writes stay at zero. Both are
// forbidden here, and rightly: a checker whose guard is relaxed to make it green
// protects nothing. So the new class gets its OWN script and its OWN ratchet,
// starting at today's state and able only to shrink, and `check-company-scope`
// keeps its invariant intact.
//
// ── WHAT IT FLAGS ───────────────────────────────────────────────────────────
// A raw-SQL statement (`c.env.DB.prepare(...)`, sql``, db.query(...)) inside
// backend/src/{scm/,}routes/*.ts that names a company-scoped table in a FROM /
// JOIN / UPDATE / INTO and carries no company predicate in its own window.
//
// STATEMENT-LEVEL, never handler-level. That is the whole point: a handler that
// scopes its main query correctly may still hold an unscoped master read, and
// the defect above is exactly that shape.
//
// ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
// A LEAD GENERATOR, like its sibling. It cannot tell a genuinely global read
// (a users lookup, a postcode master) from a leak, and it cannot see a
// predicate composed three frames away. A finding is a thing to READ, and the
// cleared ones get a `// company-scope: <reason>` so nobody re-chases them.
//
// ── USAGE ───────────────────────────────────────────────────────────────────
//   node backend/scripts/check-master-read-scope.mjs            # report, exit 0
//   node backend/scripts/check-master-read-scope.mjs --check    # RATCHET: exit 1
//                                                               # on a NEW finding
//   node backend/scripts/check-master-read-scope.mjs --update   # rewrite baseline,
//                                                               # SHRINK-only
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE_DIRS = [
  path.join(backendRoot, "src", "scm", "routes"),
  path.join(backendRoot, "src", "routes"),
];
const BASELINE_PATH = path.join(backendRoot, "scripts", "master-read-scope-baseline.json");
const checkMode = process.argv.includes("--check");
const updateMode = process.argv.includes("--update");
/* Closes the obvious bypass of --update's no-growth rule: hand-editing the JSON
   to add your new key in the same PR. Compares the baseline at HEAD against the
   one at the given ref and fails if it GREW. Same guard the sibling carries. */
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

/* ── The company-scoped table list, DERIVED from the migrations ──────────────
   Never hand-written. A hand-written list is precisely what let project_brands
   through its sibling for as long as nobody remembered to add it.

   Two shapes give a table its company_id and BOTH are read — reading only the
   ALTER form silently drops `payment_vouchers`, which is created with the
   column in 0081:
     ALTER TABLE <t> ADD COLUMN [IF NOT EXISTS] company_id ...
     CREATE TABLE <t> ( ... company_id ... )                                   */
const COMPANY_TABLES = (() => {
  const dir = path.join(backendRoot, "src", "db", "migrations-pg");
  const set = new Set();
  const alter =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:(?:scm|public)\.)?"?([a-z_0-9]+)"?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?company_id\b/gi;
  const create =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:scm|public)\.)?"?([a-z_0-9]+)"?\s*\(([\s\S]*?)\n\s*\);/gi;
  let files = [];
  try { files = fs.readdirSync(dir); } catch { files = []; }
  for (const f of files) {
    if (!f.endsWith(".sql")) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of sql.matchAll(alter)) set.add(m[1].toLowerCase());
    for (const m of sql.matchAll(create)) {
      if (/^\s*"?company_id"?\b/m.test(m[2]) || /[,(]\s*"?company_id"?\s/i.test(m[2])) {
        set.add(m[1].toLowerCase());
      }
    }
  }
  return [...set].sort();
})();

/* String.raw, not "\\b". A RegExp assembled from a plain double-quoted string
   needs every backslash doubled, and "\b" is the BACKSPACE character — the
   regex compiles and matches NOTHING. That happened while writing this file;
   the self-test below is the only reason it did not ship as a clean run. */
const TABLE_IN_STMT = new RegExp(
  String.raw`\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:scm\.|public\.)?(` +
    COMPANY_TABLES.join("|") +
    String.raw`)\b`,
  "i",
);

const RAW_SQL_STMT = /\.prepare\(|\bsql`|\bdb\.query\(/;
/* A bare `company_id` counts: an INSERT naming it in the column list IS the
   scoping act for a create. The named helpers all return an
   ` AND company_id = N` fragment. */
const SCOPED_INLINE =
  /\bcompany_id\b|activeCompanySql|allowedCompaniesSql|houzsCompanySql|companyScopeSql|assrCompanySql|companiesPred/i;
const WRITES = /\bUPDATE\b|\bDELETE\b|\bINSERT\b/i;
/* `const coSql = activeCompanySql(c);` … later `${coSql}`. The fragment is
   routinely built once at the top of a handler and interpolated many lines
   below, so a fixed look-back window cannot see it. Resolve the NAMES bound to
   a scope helper per FILE, then treat `${thatName}` in a statement as scoped.
   This is not a loosening: the variable provably holds a company predicate. */
const SCOPE_VAR_DECL =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:activeCompanySql|allowedCompaniesSql|houzsCompanySql|companyScopeSql|assrCompanySql)\s*\(/g;
const HANDLER = /^\s*[A-Za-z_$][\w$]*\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`](\/[^'"`]*)['"`]/;
const ANNOTATION = /\/\/\s*company-scope:/;

/* ── SELF-TESTS. A verdict computed over nothing must never read as a pass ───
   This file's siblings have died silently three times: a lost \s, a dead
   alternation, a scrape that returned []. Each of these refuses to RUN rather
   than report from a broken matcher. */
{
  const PREVIOUSLY_HAND_LISTED = [
    "warehouses", "mfg_sales_orders", "delivery_orders", "purchase_orders", "grns",
    "purchase_invoices", "sales_invoices", "payment_vouchers", "suppliers",
    "mfg_products", "project_venues", "trips", "stock_transfers",
    "consignment_sales_orders", "consignment_delivery_orders",
  ];
  const missing = PREVIOUSLY_HAND_LISTED.filter((t) => !COMPANY_TABLES.includes(t));
  /* The three this script exists to cover. project_brands is the defect;
     assr_cases and projects are the other public-schema masters the routes
     read raw. If the derivation ever stops producing them, the script is
     answering a different question than the one it claims to. */
  const mustCover = ["project_brands", "assr_cases", "projects"].filter(
    (t) => !COMPANY_TABLES.includes(t),
  );
  if (COMPANY_TABLES.length < 100 || missing.length || mustCover.length) {
    console.error(
      "check-master-read-scope: TABLE DERIVATION self-test FAILED - not reporting.\n" +
        `  derived ${COMPANY_TABLES.length} tables from src/db/migrations-pg\n` +
        `  missing (sibling's hand-list): ${missing.join(", ") || "(none)"}\n` +
        `  missing (this script's remit): ${mustCover.join(", ") || "(none)"}`,
    );
    process.exit(2);
  }
}
{
  const stmtOk =
    RAW_SQL_STMT.test("const r = await c.env.DB.prepare(") &&
    !RAW_SQL_STMT.test("const r = await sb.from('mfg_sales_orders')");
  const tableOk =
    TABLE_IN_STMT.test("SELECT name, logo_r2_key FROM project_brands WHERE active = 1") &&
    TABLE_IN_STMT.test("SELECT * FROM scm.warehouses w") &&
    TABLE_IN_STMT.test("JOIN public.projects p ON p.id = t.project_id") &&
    TABLE_IN_STMT.test("UPDATE assr_cases SET do_date = ? WHERE id = ?") &&
    !TABLE_IN_STMT.test("SELECT id FROM permissions WHERE key = ?") &&
    !TABLE_IN_STMT.test("SELECT name, phone FROM users WHERE id = ?");
  const scopedOk =
    SCOPED_INLINE.test("WHERE active = 1 AND company_id = 2") &&
    SCOPED_INLINE.test("WHERE active = 1${activeCompanySql(c)}") &&
    !SCOPED_INLINE.test("WHERE active = 1");
  /* THE REGRESSION TEST. This exact statement is the defect, before and after.
     If the "before" line ever stops being flagged, this script has gone blind
     to the thing it was written for. */
  const before = "SELECT name, logo_r2_key FROM project_brands WHERE active = 1";
  const after = "SELECT name, logo_r2_key FROM project_brands WHERE active = 1${activeCompanySql(c)}";
  const regressionOk =
    TABLE_IN_STMT.test(before) && !SCOPED_INLINE.test(before) &&
    TABLE_IN_STMT.test(after) && SCOPED_INLINE.test(after);
  const varOk = (() => {
    SCOPE_VAR_DECL.lastIndex = 0;
    const found = [...`const coSql = activeCompanySql(c);\nconst x = 1;`.matchAll(SCOPE_VAR_DECL)];
    return found.length === 1 && found[0][1] === "coSql";
  })();
  const handlerOk = (() => {
    const m = "deliveryPlanning.patch('/:type/:id/schedule', async (c) => {".match(HANDLER);
    return !!m && m[1] === "patch" && m[2] === "/:type/:id/schedule" &&
      !HANDLER.test("  const sb = c.get('supabase');");
  })();
  if (!stmtOk || !tableOk || !scopedOk || !regressionOk || !varOk || !handlerOk) {
    console.error(
      "check-master-read-scope: PATTERN self-test FAILED - not reporting.\n" +
        `  stmt=${stmtOk} table=${tableOk} scoped=${scopedOk} ` +
        `regression=${regressionOk} scopeVar=${varOk} handler=${handlerOk}`,
    );
    process.exit(2);
  }
}

/** STABLE KEY: file + route identity + table. Never a line number — a merge
 *  that shifts a 12,000-line router must not invent findings. */
const keyOf = (f) => `${f.file} :: ${f.handler} :: ${f.table}`;
{
  const k = keyOf({ file: "a.ts", handler: "GET /:docNo", table: "project_brands" });
  if (k !== "a.ts :: GET /:docNo :: project_brands") {
    console.error("check-master-read-scope: KEY self-test FAILED - not reporting.");
    process.exit(2);
  }
}

const BASELINE_NOTE = [
  "GRANDFATHER BASELINE for backend/scripts/check-master-read-scope.mjs --check.",
  "Each key is one <route file> :: <METHOD path> :: <table> whose RAW SQL names a",
  "company-scoped table with no company predicate. This is DEBT, not the standard:",
  "a NEW one is BLOCKED because it is not in this list. The list may only SHRINK -",
  "--update refuses to add a key, exactly as lint-ratchet refuses to raise a ceiling.",
  "To clear one: add the predicate, or annotate the statement // company-scope: <why>.",
];

const findings = [];
let filesScanned = 0;
let statementsScanned = 0;

for (const dir of ROUTE_DIRS) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { continue; }
  for (const file of entries) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const rel = path.relative(path.resolve(backendRoot, ".."), path.join(dir, file)).replace(/\\/g, "/");
    const raw = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
    filesScanned++;

    /* Names bound to a scope-fragment helper anywhere in this FILE. Per file
       rather than per handler on purpose: several routers build the fragment in
       a helper the handlers call, and a name that holds a company predicate
       holds one wherever it is interpolated. */
    const scopeVars = new Set();
    {
      const whole = raw.join("\n");
      SCOPE_VAR_DECL.lastIndex = 0;
      for (const m of whole.matchAll(SCOPE_VAR_DECL)) scopeVars.add(m[1]);
    }
    const scopeVarUse = scopeVars.size
      ? new RegExp("\\$\\{\\s*(?:" + [...scopeVars].join("|") + ")\\b")
      : null;

    // Which handler each line belongs to (the nearest registration above it).
    let currentHandler = "(module scope)";
    const handlerOf = raw.map((l) => {
      const m = l.match(HANDLER);
      if (m) currentHandler = `${m[1].toUpperCase()} ${m[2]}`;
      return currentHandler;
    });

    for (let i = 0; i < raw.length; i++) {
      if (!RAW_SQL_STMT.test(raw[i])) continue;
      statementsScanned++;
      /* LOOK BACK as well as forward. The predicate is routinely assembled on
         the line ABOVE the statement, and a window that starts at `.prepare(`
         sees `${coSql}` without knowing what it holds. Same shape the sibling
         had to learn four separate times. */
      const from = Math.max(0, i - 6);
      const to = Math.min(i + 14, raw.length);
      const stmt = raw.slice(from, to).join("\n");
      if (!TABLE_IN_STMT.test(stmt)) continue;
      if (SCOPED_INLINE.test(stmt)) continue;
      if (scopeVarUse && scopeVarUse.test(stmt)) continue;
      if (ANNOTATION.test(stmt)) continue;
      const table = (stmt.match(TABLE_IN_STMT) ?? [])[1]?.toLowerCase() ?? "?";
      findings.push({
        file: rel,
        handler: handlerOf[i],
        table,
        line: i + 1,
        text: raw[i].trim().slice(0, 110),
        writes: WRITES.test(stmt),
      });
    }
  }
}

/* One key can be hit by several statements; the ratchet works on keys. */
const byKey = new Map();
for (const f of findings) {
  if (!byKey.has(keyOf(f))) byKey.set(keyOf(f), []);
  byKey.get(keyOf(f)).push(f);
}
const keys = [...byKey.keys()].sort();

const readBaseline = () => {
  try {
    const j = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    return Array.isArray(j.unscoped) ? j.unscoped : [];
  } catch { return null; }
};

if (updateMode) {
  const prev = readBaseline();
  if (prev === null) {
    // First write. Everything present today is grandfathered; from here it may
    // only shrink.
    fs.writeFileSync(
      BASELINE_PATH,
      JSON.stringify({ "//": BASELINE_NOTE, unscoped: keys }, null, 2) + "\n",
    );
    console.log(`master-read-scope: baseline CREATED with ${keys.length} keys.`);
    process.exit(0);
  }
  const grew = keys.filter((k) => !prev.includes(k));
  if (grew.length) {
    console.error(
      "check-master-read-scope: --update REFUSES to grow the baseline.\n" +
        "  A ratchet that can be raised is not a ratchet. Scope the statement,\n" +
        "  or annotate it `// company-scope: <reason>`.\n" +
        grew.map((k) => `    NEW  ${k}`).join("\n"),
    );
    process.exit(1);
  }
  const kept = prev.filter((k) => keys.includes(k));
  fs.writeFileSync(
    BASELINE_PATH,
    JSON.stringify({ "//": BASELINE_NOTE, unscoped: kept }, null, 2) + "\n",
  );
  console.log(`master-read-scope: baseline ${prev.length} -> ${kept.length} keys.`);
  process.exit(0);
}

console.log(
  `check-master-read-scope: ${filesScanned} route files, ${statementsScanned} raw-SQL statements.`,
);
console.log(
  `${findings.length} statement(s) name a company-scoped table with no company predicate ` +
    `(${findings.filter((f) => f.writes).length} of them WRITE), across ${keys.length} handler/table pairs.`,
);
console.log(`Table list DERIVED from src/db/migrations-pg: ${COMPANY_TABLES.length} tables carry company_id.`);
console.log('Silence a verified-safe statement with "// company-scope: <reason>" beside it.');
console.log("");

let lastFile = "";
for (const k of keys) {
  const group = byKey.get(k);
  const f = group[0];
  if (f.file !== lastFile) { console.log(`\n${f.file}`); lastFile = f.file; }
  console.log(`  ${f.writes ? "WRITE" : "read "}  ${f.handler}  ->  ${f.table}`);
  for (const h of group.slice(0, 3)) console.log(`           L${h.line}  ${h.text}`);
}

if (checkMode) {
  const prev = readBaseline();
  if (prev === null) {
    console.error(
      "\ncheck-master-read-scope: --check has NO baseline to compare against.\n" +
        "  Refusing to report a pass over nothing. Run --update once to create it.",
    );
    process.exit(2);
  }
  if (ratchetAgainst) {
    const repoRoot = path.resolve(backendRoot, "..");
    const REL = "backend/scripts/master-read-scope-baseline.json";
    let base = [];
    try {
      const txt = execFileSync("git", ["show", `${ratchetAgainst}:${REL}`], {
        cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
      base = JSON.parse(txt).unscoped ?? [];
    } catch {
      /* The file does not exist on the base ref — this PR introduces it. That is
         the ONLY legitimate absence, and it is a one-time state. Say so rather
         than passing silently over nothing. */
      console.log(`\n(no ${REL} on ${ratchetAgainst} — this PR introduces the baseline; growth guard skipped once)`);
      base = null;
    }
    if (base !== null) {
      const grew = prev.filter((k) => !base.includes(k));
      if (grew.length) {
        console.error(
          `\ncheck-master-read-scope: the BASELINE FILE grew vs ${ratchetAgainst}:\n` +
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
      `\ncheck-master-read-scope: ${added.length} NEW unscoped master read(s):\n` +
        added.map((k) => `    ${k}`).join("\n") +
        "\n\n  Add the company predicate, or annotate the statement\n" +
        "  `// company-scope: <reason>` if it is deliberately global.",
    );
    process.exit(1);
  }
  console.log(`\nOK — every finding is grandfathered (${prev.length} keys); no NEW unscoped master read.`);
}
