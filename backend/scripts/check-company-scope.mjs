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
  /* Router-local guards that resolve the row inside an already-scoped query.
     Listed by name because a handler delegating to one IS scoped, and a checker
     that cannot see the delegation reports the whole family as unguarded. */
  "selfScopedSalesBlocked",
  "salesDocOutOfScope",
  "requireScmCompany",
];

/** Hand-written scoping: .eq('company_id', …) / .in('company_id', …). */
const MANUAL_SCOPE = /\.(eq|in)\(\s*['"`]company_id['"`]/;

/** A row-targeting predicate: .eq('id', x) or .eq('<something>_id', x). */
const ID_PREDICATE = /\.eq\(\s*['"`](id|[a-z_]+_id)['"`]/;

/* A registration whose body is a NAMED function declared elsewhere:
     paymentVouchers.post('/:id/cancel', cancelPaymentVoucherHandler);
   Captures the handler name so the scan can follow it. */
const NAMED_HANDLER =
  /\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"`][^'"`]*['"`]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/;

/** Handler opener: router.get('/...', ... — captures method and path. */
const HANDLER = /^\s*[A-Za-z_$][\w$]*\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]*)['"`]/;

/** `export const fooHandler = async (c) => {` / `async function fooHandler(` */
const declRegex = (fn) =>
  new RegExp("(?:async function|function|const)\\s+" + fn + "\\b");

/** The next top-level declaration — where a named handler's body ends. */
const NEXT_DECL = /^(?:export\s+)?(?:async\s+function|function|const|class)\s/;

/* SELF-TEST. The two patterns above were broken for weeks by a lost backslash
   and the failure was invisible: a regex that matches nothing produces a
   plausible report. Assert them against a known string before scanning, and
   refuse to report at all rather than report from a dead pattern. */
{
  const ok =
    declRegex("cancelPaymentVoucherHandler").test(
      "export const cancelPaymentVoucherHandler = async (c) => {",
    ) &&
    !declRegex("cancelFoo").test("export const cancelFooBar = async (c) => {") &&
    NEXT_DECL.test("async function reversePvAccounting(") &&
    NEXT_DECL.test("export const other = 1") &&
    !NEXT_DECL.test("  const inner = 1");
  if (!ok) {
    console.error("check-company-scope: internal pattern self-test FAILED - not reporting.");
    process.exit(2);
  }
}

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

    /* If the registration names a handler declared elsewhere, scan THAT body.
       Slicing "this registration to the next" would otherwise read the wrong
       code: payment-vouchers POST /:id/cancel is registered by name, and the
       naive slice reported it unscoped while the real body - which calls
       scopeToCompanyId and says so in its own comment - sat further down the
       file. A checker that mis-slices its unit produces noise, and noise is how
       a checker gets ignored. */
    /* THIS BLOCK SILENTLY DID NOTHING until 2026-08-13. Both patterns lost a
       backslash on the way in: `"...\s+"` inside a double-quoted JS string is
       not the whitespace class, it is the letter `s`, and `"\b"` is not a word
       boundary, it is the BACKSPACE character 0x08 — so declRe could never
       match any real declaration. declAt stayed -1, the code fell back to the
       naive registration-to-next-registration slice, and the scan read the
       WRONG BODY for every named handler: payment-vouchers POST /:id/cancel was
       reported against reversePvAccounting's lines, three functions further
       down. A regex that cannot match fails silently and looks like a clean
       result, which is the worst way for a checker to be wrong.

       Built with RegExp escapes doubled, and asserted at startup below so a
       future edit cannot re-break it quietly. */
    let scanBody = body;
    let scanOffset = start;
    const named = NAMED_HANDLER.exec(code[start]);
    if (named) {
      const fnName = named[1];
      const declRe = declRegex(fnName);
      const declAt = code.findIndex((l) => declRe.test(l));
      if (declAt >= 0) {
        let stop = code.length;
        for (let k = declAt + 1; k < code.length && k < declAt + 400; k++) {
          if (NEXT_DECL.test(code[k])) { stop = k; break; }
        }
        scanBody = code.slice(declAt, stop);
        scanOffset = declAt;
      }
    }

    const joined = scanBody.join("\n");
    const scoped = SCOPE_HELPERS.some((h) => joined.includes(h)) || MANUAL_SCOPE.test(joined);
    if (scoped) return;

    const hits = [];
    scanBody.forEach((l, i) => {
      if (ID_PREDICATE.test(l) && /\.from\(|\.update\(|\.delete\(|\.select\(/.test(joined)) {
        const abs = scanOffset + i;
        hits.push({ line: abs + 1, text: (raw[abs] ?? "").trim().slice(0, 110) });
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
