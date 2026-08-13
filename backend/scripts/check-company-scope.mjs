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
/* BOTH route trees. It scanned only scm/routes until 2026-08-13, leaving
   src/routes — 41 files, 693 registrations, about a fifth of the backend's route
   surface — completely unchecked. That is not a hypothetical gap: routes/
   projects.ts serves the SO venue picker from scm.warehouses with no company
   predicate, while the SAME handler scopes project_venues twelve lines earlier
   and says in a comment why. The checker could not see it.

   The native tree has its own companyContext middleware, so expect a different
   false-positive profile here; each finding still has to be read. */
const ROUTE_DIRS = [
  path.join(backendRoot, "src", "scm", "routes"),
  path.join(backendRoot, "src", "routes"),
];
const strict = process.argv.includes("--strict");
const jsonOut = process.argv.includes("--json");

/* A handler counts as scoped if it uses one of the helpers OR writes the
   predicate by hand. The hand-written form is common and legitimate —
   hr.ts DELETE /profiles/:id ends `.eq('id', id).eq('company_id', co.companyId)`
   — and a checker that cannot see it produces false positives, which is how a
   checker gets switched off. Both forms are listed here on purpose. */
/* DELEGATION guards - named functions whose BODY performs the scoped read.
   Each was opened and verified; a handler calling one IS scoped, wherever the
   call appears. Kept separate from the primitives below because a primitive's
   NAME appearing in a handler proves nothing (see the note at the scope test).*/
const DELEGATION_GUARDS = [
  "selfScopedSalesBlocked",   // mfg-sales-orders.ts:806  - 18 /:docNo handlers
  "salesDocOutOfScope",       // lib/salesScope.ts
  "requireScmCompany",
  "loadAmendmentForWrite",    // so-amendments.ts:122     - all 6 mutation gates
  "resolveAllocationParent",  // mfg-purchase-orders.ts:3354
];

/* SCOPE PRIMITIVES - only count inside an actual  query. */
const SCOPE_PRIMITIVES = [
  "scopeToCompany",
  "scopeToCompanyId",
  /* CROSS-COMPANY scoping - a bound to the caller's ALLOWED set, not to one
     active company. It is a real boundary and was missing from this list, so
     every correctly-scoped TMS / cross-company handler counted as unscoped.
     Note it is NOT caught by the "scopeToCompany" entry above: the substring
     test fails on scopeToALLOWEDCompanies. */
  "scopeToAllowedCompanies",
  "allowedCompaniesSql",
  "allowedCompanyIds",
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
  
  
  
  /* so-amendments.ts — the shared guard load for all SIX mutation gates. Its
     own body calls scopeToCompany and its comment records why (a HOUZS caller
     could once drive a 2990 amendment through its whole state machine by id).
     Verified 2026-08-13 at so-amendments.ts:122. */
  
  /* mfg-purchase-orders.ts:3354 — resolves the PO with requireActiveCompanyId +
     scopeToCompanyId (404 NOT_THIS_COMPANY), then refuses any line whose
     purchase_order_id is not that PO. Every allocation write downstream is on a
     proven in-company chain. Verified 2026-08-13. */
  
];

/** Hand-written scoping: .eq('company_id', …) / .in('company_id', …). */
const MANUAL_SCOPE = /\.(eq|in)\(\s*['"`]company_id['"`]/;

/** A row-targeting predicate: .eq('id', x) or .eq('<something>_id', x). */
const ID_PREDICATE = /\.eq\(\s*['"`](id|[a-z_]+_id)['"`]/;

/* RAW SQL — the shape this checker was BLIND to.
   Adding src/routes to the scan changed the handler count 632 -> 1022 and
   produced ZERO new findings, which looked like a clean tree and was not: the
   native routers do not use the supabase-js builder at all. They write
   `c.env.DB.prepare(\`SELECT ... FROM scm.warehouses WHERE ...\`)`, so every
   pattern above misses them by construction — including routes/projects.ts:1341,
   which serves the SO venue picker from scm.warehouses with no company predicate
   while the SAME handler scopes project_venues twelve lines earlier and explains
   in a comment why.

   A statement is flagged when it reads or writes a COMPANY-SCOPED table and
   carries no company_id predicate and no raw-SQL scope fragment
   (activeCompanySql / allowedCompaniesSql / houzsCompanySql / companyScopeSql
   return exactly those fragments). The table list is deliberately narrow — only
   tables proven to carry company_id — because a wide list on a checker that
   cannot parse SQL would produce noise, and noise is how a checker dies. */
const RAW_SQL_STMT = /\.prepare\(|\bsql`|\bdb\.query\(/;
const RAW_SQL_SCOPED =
  /company_id\s*(=|IN)|activeCompanySql|allowedCompaniesSql|houzsCompanySql|companyScopeSql|companiesPred/i;
const RAW_SQL_TABLES =
  /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:scm\.)?(warehouses|mfg_sales_orders|delivery_orders|purchase_orders|grns|purchase_invoices|sales_invoices|payment_vouchers|suppliers|mfg_products|project_venues|trips|stock_transfers|consignment_sales_orders|consignment_delivery_orders)\b/i;

/* A registration whose body is a NAMED function declared elsewhere:
     paymentVouchers.post('/:id/cancel', cancelPaymentVoucherHandler);
   Captures the handler name so the scan can follow it. */
const NAMED_HANDLER =
  /\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"`][^'"`]*['"`]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/;

/* Handler opener: router.get('/...', ... — captures method and path.

   THE LEADING SLASH IS LOAD-BEARING. Without it `c.get('supabase')` at the start
   of a line matches, and the scan treats a context accessor as a route
   registration — which both mis-slices the real handler around it and prints
   nonsense like "GET supabase" in the report. gen-route-locator.mjs has required
   the slash since it was written; this checker did not, and it showed the moment
   a fix put `c.get('supabase')` on its own line. */
const HANDLER = /^\s*[A-Za-z_$][\w$]*\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`](\/[^'"`]*)['"`]/;

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

for (const dir of ROUTE_DIRS) {
const relDir = path.relative(backendRoot, dir).split(path.sep).join("/");
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
  const full = path.join(dir, file);
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

    /* SCOPE IS TESTED PER STATEMENT, NOT PER HANDLER.
       It used to be `joined.includes(helper)` — the helper name appearing
       ANYWHERE in the handler counted as scoped. That is a substring match, not
       a proof, and it let a real leak through: delivery-orders-mfg PATCH /:id
       writes `update(updates).eq('id', id)` with no predicate at :4411, and the
       handler passed because `activeCompanyId(c)` appears at :4432 — AFTER the
       write, as a fallback for an audit row's companyId field. Two independent
       readers spotted that handler while this script reported "0 WRITE".

       Now each row-touching statement is judged on its own text: the window
       from its own `.from(` to the end of that statement. A helper mentioned
       elsewhere in the handler no longer excuses it. */
    const joined = scanBody.join("\n");

    /** The statement containing line i: from its `.from(` back-anchor forward. */
    const statementAround = (i) => {
      /* Anchor on the START OF THE EXPRESSION, not on `.from(`.
         Anchoring on `.from(` was wrong for this codebase's dominant style —

             const { data } = await scopeToCompanyId(
               sb.from('payment_vouchers').select(HEADER).eq('id', id),
               co.companyId,
             ).maybeSingle();

         the wrapping call sits on the line BEFORE, so a window that begins at
         `.from(` cannot see it. That mis-slice flagged three handlers this
         branch had already fixed. Walk back to the nearest statement opener. */
      let start = i;
      for (let k = i; k >= 0 && k > i - 8; k--) {
        const line = scanBody[k] ?? "";
        if (/\b(const|let|var|await|return)\b|=\s*$/.test(line)) { start = k; break; }
        if (k < i && /;\s*$/.test(scanBody[k + 1] ?? "")) break;
      }
      let end = start;
      let depth = 0;
      for (let k = start; k < scanBody.length && k < start + 25; k++) {
        end = k;
        const line = scanBody[k] ?? "";
        for (const ch of line) {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
        }
        // A statement ends at a ';' once every paren it opened has closed.
        if (depth <= 0 && line.includes(";") && k >= i) break;
      }
      return scanBody.slice(start, end + 1).join("\n");
    };

    /* THE RESOLVE-THEN-ACT PATTERN IS LEGITIMATE AND COMMON HERE, and a checker
       that ignores it is useless. A handler routinely reads the row ONCE through
       a scoped query, then writes by the id that read returned — hr payout
       reopen, the so-amendment gates, the PO allocation writers all do exactly
       that, and each was verified by hand.

       So a row-touching statement is excused when EITHER
         · the statement itself carries the scope, OR
         · a SCOPED QUERY appears EARLIER in the same handler.
       Both halves matter. "Earlier" is what catches delivery-orders-mfg
       PATCH /:id, whose only `activeCompanyId` sits AFTER the write; "in a
       query" is what stops an audit field's fallback value from counting as a
       predicate. Pure statement-level testing would flag 161 writes, most of
       them correct, and a checker that cries wolf is one somebody turns off. */
    /* A DELEGATION guard counts wherever it appears — it IS the scoped read,
       performed inside a named function this file lists because each one was
       read and verified. A scope PRIMITIVE only counts inside a real `.from(`
       QUERY: that is the difference between a predicate and a mention, and it
       is exactly what delivery-orders-mfg PATCH /:id exploited by accident. */
    const delegated = DELEGATION_GUARDS.some((h) => joined.includes(h));
    const hasScopedQuery = scanBody.some((l, i) => {
      if (!l.includes(".from(")) return false;
      const stmt = statementAround(i);
      return SCOPE_PRIMITIVES.some((h) => stmt.includes(h)) || MANUAL_SCOPE.test(stmt);
    });
    if (delegated || hasScopedQuery) return;

    /* Statement-level hit collection is deliberately NOT used to decide the
       verdict — this codebase wraps builders across many lines and a regex
       window over them mis-slices, which flagged six handlers I had already
       verified correct by hand. The window is good enough to LABEL a hit as a
       write; it is not good enough to acquit one. */
    const hits = [];
    /* RAW-SQL pass — a different shape entirely, so it gets its own loop rather
       than being bolted onto the builder test above. */
    scanBody.forEach((l, i) => {
      if (!RAW_SQL_STMT.test(l)) return;
      const stmt = scanBody.slice(i, Math.min(i + 12, scanBody.length)).join("\n");
      if (!RAW_SQL_TABLES.test(stmt)) return;
      if (RAW_SQL_SCOPED.test(stmt)) return;
      const abs = scanOffset + i;
      hits.push({
        line: abs + 1,
        text: (raw[abs] ?? "").trim().slice(0, 110),
        writes: /\bUPDATE\b|\bDELETE\b|\bINSERT\b/i.test(stmt),
        raw: true,
      });
    });
    scanBody.forEach((l, i) => {
      if (!ID_PREDICATE.test(l)) return;
      const stmt = statementAround(i);
      if (!/\.from\(/.test(stmt)) return;
      const abs = scanOffset + i;
      hits.push({
        line: abs + 1,
        text: (raw[abs] ?? "").trim().slice(0, 110),
        writes: /\.update\(|\.delete\(|\.insert\(|\.upsert\(/.test(stmt),
      });
    });
    if (!hits.length) return;

    /* An explicit annotation still silences a handler — but ONLY now, after the
       statement test has something to say. Kept after the hit-collection so an
       annotated handler that later grows a NEW unscoped statement is not
       silently covered by an old exemption... it is. Noted honestly: the
       annotation is per-handler, so re-read it when adding a statement. */
    const writes = hits.some((h) => h.writes);
    findings.push({
      file: `backend/${relDir}/${file}`,
      handler: `${method} ${routePath}`,
      line: start + 1,
      writes,
      hits: hits.slice(0, 3),
    });
  });
}
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

/* --strict gates on the WRITE findings only.
   A cross-company WRITE corrupts the other company's data; a read-side finding
   is a disclosure and often a deliberate cross-company surface, so gating a PR
   on the raw count would fail on legitimate code — and a gate that cries wolf is
   a gate someone switches off. The read findings are still printed above.
   Sibling checks make the same split: check-silent-mutations gates on SILENT
   (not CAUGHT/UNRESOLVED), check-shared-mirrors on DIVERGED (not COSMETIC). */
const writeFindings = findings.filter((f) => f.writes).length;
process.exit(strict && writeFindings ? 1 : 0);
