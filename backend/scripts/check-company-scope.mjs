#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-company-scope.mjs — find SCM route handlers that read or write a row by
// id WITHOUT company scoping.
//
// WHY. This is the repo's most repeated defect class, not an isolated bug. The
// 2026-07-22 owner audit scoped "every" sibling flow and missed the
// stock-transfer cancel; a 2026-08-12 doc sweep found seven read-side
// /:id/linked leaks; a 2026-08-13 full-module audit counted 56 misses, 27 of
// them high. Each pass found a subset, because each looked by hand. The guards
// all exist (scopeToCompany / scopeToCompanyId / requireActiveCompanyId) — what
// keeps failing is remembering to CALL them, which is exactly the kind of thing
// a machine should check.
//
// WHAT IT FLAGS. A handler in backend/src/scm/routes/*.ts that touches a table
// by `.eq('id', ...)` (or an id-shaped column) and contains none of the scope
// helpers anywhere in its body.
//
// WHAT IT CANNOT SEE, stated so a clean run is not over-read:
//   - a handler scoped indirectly, e.g. by first resolving a parent that was
//     itself scoped. Those show up as false positives; annotate with
//     `// company-scope: <reason>` on the handler line to silence one.
//   - whether the scope helper is passed the RIGHT company.
//   - anything outside backend/src/scm/routes (native routes have their own
//     companyContext middleware).
//
// Usage:
//   node backend/scripts/check-company-scope.mjs           # report
//   node backend/scripts/check-company-scope.mjs --strict  # exit 1 on findings
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTES = path.join(backendRoot, "src", "scm", "routes");
const strict = process.argv.includes("--strict");
const jsonOut = process.argv.includes("--json");

/* A handler counts as scoped if it uses one of the helpers OR writes the
   predicate by hand. The hand-written form is common and legitimate —
   hr.ts DELETE /profiles/:id ends `.eq('id', id).eq('company_id', co.companyId)`
   — and a checker that cannot see it produces false positives, which is how a
   checker gets switched off. Both forms are listed here on purpose. */
const SCOPE_HELPERS = [
  "scopeToCompany",
  "scopeToCompanyId",
  "requireActiveCompanyId",
  "activeCompanyId",
  "companyScopeSql",
  "resolveSalesScopeIds",
  "companiesPred",
  "houzsCompanySql",
  "activeCompanySql",
];

/** Hand-written scoping: .eq('company_id', …) / .in('company_id', …). */
const MANUAL_SCOPE = /\.(eq|in)\(\s*['"`]company_id['"`]/;

/** A row-targeting predicate: .eq('id', x) or .eq('<something>_id', x). */
const ID_PREDICATE = /\.eq\(\s*['"`](id|[a-z_]+_id)['"`]/;

/** Handler opener: router.get('/...', ... — captures method and path. */
const HANDLER = /^\s*[A-Za-z_$][\w$]*\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]*)['"`]/;

function stripComments(lines) {
  let inBlock = false;
  return lines.map((raw) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) return "";
      line = line.slice(end + 2);
      inBlock = false;
    }
    line = line.replace(/\/\*.*?\*\//g, "");
    // Line comment FIRST — a comment mentioning /api/* must not open a block.
    const lc = line.indexOf("//");
    if (lc !== -1) line = line.slice(0, lc);
    const ob = line.indexOf("/*");
    if (ob !== -1) {
      inBlock = true;
      line = line.slice(0, ob);
    }
    return line;
  });
}

const findings = [];
let handlersChecked = 0;

for (const file of fs.readdirSync(ROUTES).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
  const full = path.join(ROUTES, file);
  const raw = fs.readFileSync(full, "utf8").split(/\r?\n/);
  const code = stripComments(raw);

  // Slice the file into handlers: from one HANDLER line to the next.
  const starts = [];
  code.forEach((l, i) => {
    if (HANDLER.test(l)) starts.push(i);
  });

  starts.forEach((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : code.length;
    const body = code.slice(start, end);
    const rawBody = raw.slice(start, end);
    const m = HANDLER.exec(code[start]);
    const method = m[1].toUpperCase();
    const routePath = m[2];

    handlersChecked++;

    // Opt-out: an explicit annotation on any line of the handler.
    if (rawBody.some((l) => l.includes("company-scope:"))) return;

    const joined = body.join("\n");
    const scoped = SCOPE_HELPERS.some((h) => joined.includes(h)) || MANUAL_SCOPE.test(joined);
    if (scoped) return;

    const hits = [];
    body.forEach((l, i) => {
      if (ID_PREDICATE.test(l) && /\.from\(|\.update\(|\.delete\(|\.select\(/.test(joined)) {
        hits.push({ line: start + i + 1, text: raw[start + i].trim().slice(0, 110) });
      }
    });
    if (!hits.length) return;

    const writes = /\.update\(|\.delete\(|\.insert\(|\.upsert\(/.test(joined);
    findings.push({
      file: `backend/src/scm/routes/${file}`,
      handler: `${method} ${routePath}`,
      line: start + 1,
      writes,
      hits: hits.slice(0, 3),
    });
  });
}

findings.sort((a, b) => Number(b.writes) - Number(a.writes) || a.file.localeCompare(b.file) || a.line - b.line);

if (jsonOut) {
  console.log(JSON.stringify({ handlersChecked, findings }, null, 2));
} else {
  const w = findings.filter((f) => f.writes).length;
  console.log(
    `Checked ${handlersChecked} SCM route handlers.\n` +
      `${findings.length} touch a row by id with no company-scope helper in the handler ` +
      `(${w} of them WRITE).\n` +
      `Annotate a verified-safe handler with "// company-scope: <reason>" to silence it.\n`,
  );
  let lastFile = "";
  for (const f of findings) {
    if (f.file !== lastFile) {
      console.log(`\n${f.file}`);
      lastFile = f.file;
    }
    console.log(`  ${f.writes ? "WRITE" : "read "}  L${f.line}  ${f.handler}`);
    for (const h of f.hits) console.log(`           L${h.line}  ${h.text}`);
  }
}

process.exit(strict && findings.length ? 1 : 0);
