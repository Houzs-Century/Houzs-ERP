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
// ⚠️ WHAT THIS SCRIPT IS, AND IS NOT — read before quoting its number.
//
// It is a LEAD GENERATOR. It found every cross-company leak fixed on
// fix/company-scope-sweep, and that is its value.
//
// It is NOT a proof of absence. Deciding "is this statement scoped" needs to
// know which builder a value holds and where a predicate was composed, and this
// is regexes over lines. In ONE DAY (2026-08-13) it was wrong in four distinct
// ways, each found only because a human re-read the code:
//
//   1. a lost `\s` / `\b` made the named-handler resolver match nothing, so it
//      silently scanned the WRONG function bodies — and hid a cross-company GL
//      posting. Repairing it took the count UP, 34 -> 37.
//   2. it counted a helper NAME appearing anywhere in a handler as scoping, so
//      delivery-orders-mfg PATCH /:id passed on an `activeCompanyId(c)` that
//      sits AFTER the write, inside an audit row's companyId field.
//   3. the statement window anchored on `.from(`, missing the wrapping
//      `scopeToCompanyId(` on the line ABOVE — it flagged six handlers that
//      were already correct.
//   4. the window then ran too far FORWARD and swept the next statement in,
//      re-excusing that same DO handler a third time.
//
// So: a NON-ZERO result is worth reading. A ZERO result means "this heuristic
// found nothing", not "there is nothing". The gates on
// fix/company-scope-sweep were each verified by opening the handler, its guard
// function and the table's DDL — that reading, not this number, is the evidence.
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
//   node backend/scripts/check-company-scope.mjs --strict  # exit 1 on WRITE findings
//   node backend/scripts/check-company-scope.mjs --check   # RATCHET: exit 1 on a
//                                                          # NEW unscoped handler
//                                                          # (one not in the baseline)
//   node backend/scripts/check-company-scope.mjs --update  # rewrite the baseline,
//                                                          # SHRINK-only (refuses to grow)
//   ... --check --ratchet-against origin/main              # also fail if the
//                                                          # baseline file itself GREW
//
// ⚠️ THE RATCHET (--check / --update) — read before touching the baseline.
//
// The goal is to LOCK the company-scope check: a NEW handler that touches a row
// by id with no company predicate is BLOCKED, while today's findings are
// grandfathered and may only DECREASE. Same shape as lint-ratchet.mjs and
// check-release-discipline.mjs.
//
//   * The grandfather baseline is backend/scripts/company-scope-baseline.json —
//     a flat, sorted list of STABLE KEYS, one per unscoped handler/statement.
//   * The stable key is FILE PATH + ROUTE IDENTITY, never a line number (which
//     drifts on every merge). A route handler is `<file> :: <METHOD> <path>`;
//     a library write is `<file> :: lib(<key>)`.
//   * `--check` recomputes the findings and fails if the current set is NOT a
//     subset of the baseline — i.e. a key appears that nobody grandfathered.
//   * `--update` rewrites the baseline from the current findings but REFUSES to
//     add a key the committed baseline does not already have (mirroring
//     lint-ratchet's refusal to raise a ceiling). It is how you lock in a fix:
//     after a handler is scoped, `--update` drops it from the list.
//   * `--ratchet-against <ref>` closes the obvious bypass — editing the JSON to
//     add your new key. It compares the baseline file at HEAD to the one at the
//     merge base and fails if it grew. This is exactly check-release-discipline's
//     `--ratchet-against` guard.
//
// This does NOT replace `--strict`. --strict enforces the stronger invariant
// that handler WRITE findings stay at ZERO (writes are the worst class and there
// are none today); the ratchet grandfathers the read-side backlog and locks the
// whole set against growth. Both run in CI.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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

const repoRoot = path.resolve(backendRoot, "..");
const BASELINE_REL = "backend/scripts/company-scope-baseline.json";
const BASELINE_PATH = path.join(backendRoot, "scripts", "company-scope-baseline.json");

/* THE STABLE KEY. File path + route identity, never a line number — a merge
   that shifts a 12,000-line router must not turn every handler below it into a
   "new" violation. A handler is `<file> :: <METHOD> <path>`; a library write is
   `<file> :: lib(<key>)`. These are the two shapes the two finding sets carry. */
const handlerKeyOf = (f) => `${f.file} :: ${f.handler}`;
const libKeyOf = (f) => `${f.file} :: lib(${f.key})`;
const newAgainst = (keys, baseSet) => keys.filter((k) => !baseSet.has(k));

/* SELF-TEST the ratchet primitives, same rule as the pattern self-tests below:
   a key builder or a subset test that silently does the wrong thing produces a
   plausible verdict over nothing. If these break, refuse to run rather than
   grandfather the world or gate on garbage. */
{
  const hk = handlerKeyOf({ file: "backend/src/scm/routes/x.ts", handler: "PATCH /:id" });
  const lk = libKeyOf({ file: "backend/src/scm/lib/y.ts", key: "code" });
  const base = new Set([hk, lk, "kept-a"]);
  const ok =
    hk === "backend/src/scm/routes/x.ts :: PATCH /:id" &&
    lk === "backend/src/scm/lib/y.ts :: lib(code)" &&
    newAgainst([hk, "kept-a"], base).length === 0 &&              // subset -> no new
    newAgainst([hk, "brand-new"], base).join() === "brand-new";   // one NEW -> named
  if (!ok) {
    console.error("check-company-scope: RATCHET self-test FAILED - not reporting.");
    process.exit(2);
  }
}

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
  /* REMOVED 2026-08-18: "salesDocOutOfScope". It was listed as a delegation
     guard — a named function whose body performs the SCOPED READ — and it does
     nothing of the kind. lib/salesScope.ts:86-95 resolves the caller's
     SALESPERSON subtree (resolveSalesScopeIds) and answers "is this document's
     salesperson_id outside it". There is no company id in that function, in the
     function it calls, or in the table it reads. Two callers in the same book
     both pass it; a view-all tier makes it return false unconditionally.
     Every entry on this list is supposed to have been opened and verified, and
     this one was verified against the wrong question — "does it scope?" rather
     than "does it scope by COMPANY?". Deleting it takes the honest finding count
     from 19 to 21. */
  "requireScmCompany",
  "loadAmendmentForWrite",    // so-amendments.ts:122     - all 6 mutation gates
  "resolveAllocationParent",  // mfg-purchase-orders.ts:3354
  /* routes/projects.ts — the child-row / parent-project ownership gates added
     2026-08-18. Each runs `SELECT 1 ... WHERE id = ?` with activeCompanySql (or
     an EXISTS on the parent project for the child tables that carry no
     company_id) and returns a 404 the handler returns as-is, BEFORE any other
     probe. Verified by reading both, which is the bar for this list — see the
     salesDocOutOfScope note above for what happens when it is not met. */
  "refuseForeignChild",
  "refuseForeignProject",
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

/* A STAMP IS NOT A PREDICATE — the FIFTH blind spot, 2026-08-13.
   `.from('x').insert({ company_id: activeCompanyId(c), ... })` contains both a
   real `.from(` query and the string `activeCompanyId`, so every test above
   counted it as scoped. It is the opposite: stamping the ACTIVE company onto a
   row you are writing says nothing about WHOSE row you loaded, and when the two
   disagree the stamp is what makes the damage silent — the payment lands on
   company B's invoice tagged as company A's.

   Seven confirmed cross-company MONEY writes hid behind exactly this, in
   sales-invoices.ts and delivery-orders-mfg.ts, while this script printed 0
   WRITE findings. One of them had a comment above it reading "multi-company:
   match the SI's company" over a line that never compared anything.

   So the payload of an insert/upsert is removed before the statement is tested.
   `.eq('company_id', ...)` chained onto the SAME statement still counts, because
   that IS a predicate. */
function stripInsertPayload(stmt) {
  return stmt.replace(/\.(insert|upsert)\s*\(([\s\S]*?)\)(?=\s*[.;\n]|$)/g, ".$1(<payload>)");
}

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

/* FRAGMENT DEFINITION-USE LINKING — added 2026-08-18, and it is what keeps the
   widened table list above from drowning the report.

   The dominant raw-SQL idiom here computes the predicate ONCE at the top of the
   handler and interpolates it into several statements:

       const coSql = assrCompanySql(c);
       ...
       `UPDATE assr_cases SET archived_at = ... WHERE id = ?${coSql}`

   The statement window looks back six lines, so it sees `${coSql}` and not what
   coSql holds. Widening the window is the wrong fix — this file's history is
   four separate mis-slices from windows that were too wide or too narrow. Link
   the two instead: collect the NAMES assigned from a known fragment builder
   anywhere in the handler, then treat a statement that interpolates one of THOSE
   names as scoped. That is a definition-use link, not a "the helper is mentioned
   somewhere" match — which is the acquittal this checker has already been burned
   by twice. A name that is never assigned from a builder still proves nothing. */
const FRAGMENT_BUILDERS =
  "activeCompanySql|allowedCompaniesSql|houzsCompanySql|companyScopeSql|companiesPred|assrCompanySql";
const FRAGMENT_ASSIGN_G = new RegExp(
  `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:${FRAGMENT_BUILDERS})\\s*\\(`,
  "g",
);
/* `company_id` bare (no `=`) counts too: an INSERT names it in the column list,
   e.g. `INSERT INTO project_venues (name, ..., company_id) VALUES (...)`. That
   is the row being stamped with its company, which is the scoping act for a
   create. Requiring `=` or `IN` reported every such INSERT as unscoped. */
const RAW_SQL_SCOPED =
  /\bcompany_id\b|\bcompany_code\b|activeCompanySql|allowedCompaniesSql|houzsCompanySql|companyScopeSql|companiesPred|activeCompanyCodePred|refuseForeignChild|refuseForeignProject/i;
/* WIDENED 2026-08-18. The list was "deliberately narrow — only tables proven to
   carry company_id", and it stayed narrow enough to miss the two worst raw-SQL
   leaks in the tree:
     · email_outbox — GET /mail-center/outbox and /outbox/:id returned every
       company's outbound mail INCLUDING body_html, which carries the
       /invite/<token> and /reset/<token> links. Its company column is
       company_code (mig 0094), not company_id, which is why RAW_SQL_SCOPED had
       to learn that name too.
     · assr_cases — the PRE-AUTH GET /assr-form-intake/status-export dumped
       customer_name / phone / addr1-4 / complaint_issue for both companies.
   Both tables were proven to carry a company column before being added, which
   remains the bar: a wide list on a checker that cannot parse SQL is noise, and
   noise is how a checker dies. */
const RAW_SQL_TABLES =
  /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:scm\.)?(warehouses|mfg_sales_orders|delivery_orders|purchase_orders|grns|purchase_invoices|sales_invoices|payment_vouchers|suppliers|mfg_products|project_venues|trips|stock_transfers|consignment_sales_orders|consignment_delivery_orders|email_outbox|assr_cases|project_finance_lines|project_checklist|project_checklist_sections|project_checklist_attachments|projects)\b/i;

/* ══════════════════════════════════════════════════════════════════════════
   THE THREE SHAPES THIS CHECKER COULD NOT SEE AT ALL — added 2026-08-18.

   Everything above is anchored on "a row addressed BY ID". That is one shape of
   cross-company access and it is not the common one. On 2026-08-18 this script
   printed `0 of them WRITE` over a tree that contained, among others, a
   cross-tenant account-takeover surface and a platform-wide staff directory —
   because none of them addressed a row by id. A gate that reports zero while the
   leaks exist is worse than no gate: it ENDS the search.

   1. SET-READ — a LIST with no predicate at all. `.from('staff').select(...)
      .eq('active', true)` has no id, so ID_PREDICATE never fires and the
      statement is invisible. hr.ts GET /pickers is exactly this, sitting in the
      SAME Promise.all as four siblings that each carry
      `.eq('company_id', co.companyId)`. This pass is judged PER STATEMENT and
      is deliberately NOT acquitted by a scoped sibling — a scoped sibling is
      precisely what made that handler look fine.

   2. GLOBAL NATURAL KEY — a write addressed by a human-meaningful key, or an
      upsert whose onConflict target omits company_id. The LIBRARY pass already
      does this for src/scm/lib (it is what found the pwp_codes burn); route
      handlers had no equivalent, so the same shape in a route was unseen. An
      upsert onto a key two companies can each hold their own of is how
      scm.pos_carts let one company's cart overwrite the other's (CLAUDE.md).

   3. RPC DELEGATION — `.rpc('fn_x', {...})`. The predicate moves inside a
      Postgres function this scanner cannot read, so the handler looks clean
      whatever the function does. This pass cannot judge the function; it
      reports the call when NO company argument is passed, which is the only
      thing it can honestly say, and leaves the verdict to a reader.
   ══════════════════════════════════════════════════════════════════════════ */

/* Tables where a FULL LIST is a disclosure and which are PROVEN to carry a
   company column. Same bar as RAW_SQL_TABLES: proven, not guessed, because a
   speculative entry produces noise and noise is how a checker gets switched
   off. Provenance for each is migration 0083 / 0086 / 0090 / 0093 / 0170 unless
   noted. */
const SET_READ_TABLES = new Set([
  "warehouses", "mfg_products", "suppliers", "customers", "fabric_library",
  "special_addons", "showrooms", "mfg_sales_orders", "purchase_orders", "grns",
  "purchase_invoices", "sales_invoices", "purchase_returns", "delivery_orders",
  "payment_vouchers", "stock_transfers", "stock_takes", "inventory_balances",
  "inventory_lots", "project_venues", "trips", "dp_orders", "trip_stops",
  "purchase_order_items", "grn_items",
]);

/** `.from('x')` / `.from("x")` — the table this statement reads or writes. */
const FROM_TABLE = /\.from\(\s*['"`]([a-z][a-z0-9_]*)['"`]\s*\)/;

/** Any row-narrowing predicate at all: an id, or an `.in('id', ...)`. */
const ANY_ID_NARROWING = /\.(eq|in)\(\s*['"`](id|[a-z_]+_id)['"`]/;

/* BUILDER-IN-A-VARIABLE, linked by NAME. The by-id passes have `wrapsABuilder`
   for this shape, and it is deliberately loose there ("any bare identifier")
   because it only ever ACQUITS a handler that already had a scoped statement.
   The SET-READ pass cannot borrow that: it is judged per statement precisely so
   a scoped sibling cannot excuse an unscoped list, and `wrapsABuilder` would
   hand it exactly that sibling-acquittal back.

   So link the two by the VARIABLE:

       let soQ = sb.from('mfg_sales_orders').select(...).limit(2000);
       ...
       soQ = scopeToAllowedCompanies(soQ, c);          // ar-reconciliation.ts:93

       const soQuery = sb.from('mfg_sales_orders').select(...);
       ...
       scopeToCompany(soQuery, c)                       // routes/search.ts

   A list is acquitted only when the scope is applied to THAT NAME. Without this
   the pass reported 137 set-reads, the great majority of them this shape and
   correct; with it the number is the honest one. */
const QUERY_ASSIGN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[A-Za-z_$][\w$]*\s*$|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[A-Za-z_$][\w$]*\s*\.\s*from\(/;
const scopeAppliedToName = (joined, name) =>
  new RegExp(
    `(?:scopeToCompany|scopeToCompanyId|scopeToAllowedCompanies)\\s*\\(\\s*${name}\\b` +
      `|\\b${name}\\s*=\\s*${name}\\s*\\.\\s*(?:eq|in)\\(\\s*['"\`]company_id` +
      `|\\b${name}\\s*\\.\\s*(?:eq|in)\\(\\s*['"\`]company_id`,
  ).test(joined);

/** `.upsert(..., { onConflict: 'a,b' })` — captures the conflict target. */
const UPSERT_ON_CONFLICT = /onConflict\s*:\s*['"`]([^'"`]*)['"`]/;

/** `.rpc('name'` — captures the function name. */
const RPC_CALL = /\.rpc\(\s*['"`]([a-z_][a-z0-9_]*)['"`]/;

/** A company argument handed to an RPC: p_company_id / companyId / company_id. */
const RPC_COMPANY_ARG = /\b(p_)?company(_id|Id)\b/;

/* SELF-TEST for the three new passes, same rule as every other pattern here:
   a pattern that cannot match produces a plausible report, so assert each one
   against a string that is REAL code from this tree before scanning. */
{
  const ok =
    FROM_TABLE.test("sb.from('staff').select('id, name')") &&
    FROM_TABLE.exec("sb.from('staff').select('id')")[1] === "staff" &&
    !ANY_ID_NARROWING.test("sb.from('staff').select('id, name').eq('active', true)") &&
    ANY_ID_NARROWING.test(".eq('company_id', x)") &&
    ANY_ID_NARROWING.test(".in('id', ids)") &&
    UPSERT_ON_CONFLICT.exec("{ onConflict: 'model_id' }")[1] === "model_id" &&
    UPSERT_ON_CONFLICT.exec("{ onConflict: 'staff_id,company_id' }")[1] === "staff_id,company_id" &&
    RPC_CALL.exec("await sb.rpc('fn_stock_transfer_apply', {")[1] === "fn_stock_transfer_apply" &&
    RPC_COMPANY_ARG.test("p_company_id: co.companyId") &&
    RPC_COMPANY_ARG.test("companyId: co.companyId") &&
    !RPC_COMPANY_ARG.test("p_transfer_id: id, p_user_id: user.id") &&
    [...("  const coSql = assrCompanySql(c);".matchAll(FRAGMENT_ASSIGN_G))].map((m) => m[1])[0] === "coSql" &&
    [...("  const brandCoSql = activeCompanySql(c, \"b.company_id\");".matchAll(FRAGMENT_ASSIGN_G))].map((m) => m[1])[0] === "brandCoSql" &&
    [...("  const notAFragment = someOtherThing(c);".matchAll(FRAGMENT_ASSIGN_G))].length === 0 &&
    (() => { const m = QUERY_ASSIGN.exec("  let soQ = sb\n    .from('mfg_sales_orders')"); return (m?.[1] ?? m?.[2]) === "soQ"; })() &&
    (() => { const m = QUERY_ASSIGN.exec("  const prodQuery = sb.from('mfg_products').select('id')"); return (m?.[1] ?? m?.[2]) === "prodQuery"; })() &&
    scopeAppliedToName("  soQ = scopeToAllowedCompanies(soQ, c);", "soQ") &&
    scopeAppliedToName("  const { data } = await scopeToCompany(soQuery, c);", "soQuery") &&
    !scopeAppliedToName("  soQ = soQ.in('salesperson_id', scopeIds);", "soQ");
  if (!ok) {
    console.error("check-company-scope: NEW-SHAPES self-test FAILED - not reporting.");
    process.exit(2);
  }
}

/* EXTENDED 2026-08-18 when the route pass started using it. Exclusion (2) in
   the paragraph above is "CONCURRENCY GUARDS — a compare-and-swap predicate,
   not identity", and the list only ever named the two examples that had bitten:
   `.eq('paid_sen', prev)` and `.eq('updated_at', prev)`. The route handlers
   run the same class under different names — `version`, `edit_lease_token`,
   `apply_lease_token` — and they produced 20 of the route pass's first 40
   findings, all of them compare-and-swap on a row the caller had already
   chosen. `stop_type` is exclusion (3), a STATE filter, and slipped through only
   because the list spelt it `type` exactly rather than `*_type`. Each addition
   below is one of those two documented exclusions, not a new one. */
const NOT_IDENTITY =
  /^(id|.*_id|status|state|.*_at|.*_sen|qty|.*_qty|type|.*_type|kind|active|deleted|version|.*_version|.*_token|reason)$/;
const NATURAL_KEY_EQ_G = /\.eq\(\s*['"`]([a-z][a-z0-9_]*)['"`]/g;

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
/* THE SUPPRESSION LEDGER. `// company-scope:` used to make a handler vanish
   from this report with no trace that it had ever been considered — 67 of them
   across the two route trees, and one sat on scm/routes/staff.ts PATCH
   /by-user/:userId/showroom, whose write keyed on user_id alone. It was not even
   written as an opt-out: it was the first two words of a paragraph explaining
   the WAREHOUSE half, and this test is a substring match, so prose silenced the
   handler. A suppression the reader cannot see is a suppression nobody
   re-checks, which is the same rule the LIBRARY pass already follows for its
   file-level exemptions. They are all printed now, with their reason. */
const suppressions = [];
function recordSuppression(file, line, text, handler) {
  const reason = (String(text).split("company-scope:")[1] ?? "").trim().replace(/\*\/\s*$/, "").trim();
  suppressions.push({ file, line, handler, reason: reason.slice(0, 90) });
}
/* The three shapes ID_PREDICATE cannot see. Kept in their own bucket so the
   historical count above stays comparable across runs. */
const shapeFindings = [];
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

    /* Opt-out: an explicit annotation on any line of the handler.
       NOTE the deliberate ordering — this first test uses the NAIVE slice
       (registration to registration) so an annotation written next to the
       REGISTRATION works. A second, identical test runs after the named-handler
       resolution below, so an annotation written inside the resolved FUNCTION
       BODY works too. Both are natural places to put it, and checking only one
       meant a correctly annotated handler kept being reported — which is how an
       opt-out mechanism gets ignored. */
    {
      const at = rawBody.findIndex((l) => l.includes("company-scope:"));
      if (at >= 0) {
        recordSuppression(`backend/${relDir}/${file}`, start + at + 1, rawBody[at], `${method} ${routePath}`);
        return;
      }
    }

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
    /* Second opt-out pass — see the note on the first. For a NAMED handler the
       body scanned above is somewhere else in the file, so an annotation
       written as the function's first line is invisible to the naive slice. */
    {
      const window = raw.slice(scanOffset, scanOffset + scanBody.length);
      const at = window.findIndex((l) => l.includes("company-scope:"));
      if (at >= 0) {
        recordSuppression(`backend/${relDir}/${file}`, scanOffset + at + 1, window[at], `${method} ${routePath}`);
        return;
      }
    }

    const joined = scanBody.join("\n");

    /* Names this handler assigned from a raw-SQL fragment builder. Recomputed
       per handler so a name defined in a DIFFERENT handler can never acquit
       this one. */
    const fragmentNames = new Set(
      [...joined.matchAll(FRAGMENT_ASSIGN_G)].map((m) => m[1]),
    );

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
        const line = scanBody[k] ?? "";
        /* A BLANK LINE ENDS THE WINDOW. Paren-depth alone was not enough: a
           multi-line chained builder left depth non-zero past its own `;`, the
           window ran the full 25 lines, and it swept in the NEXT statement.

           That is not theoretical — it re-excused the DO PATCH. Its
           `update(updates).eq('id', id)` window reached down to a
           recordEntityAudit call whose `companyId:` field falls back to
           `activeCompanyId(c)`, and the audit field counted as the predicate.
           The same handler, fooled the same way, for the third time today.

           This codebase separates statements with blank lines consistently, so
           a blank line is a firmer boundary than counting brackets. */
        if (k > start && line.trim() === "") break;
        end = k;
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
    /* ── THE THREE NEW SHAPES, judged PER STATEMENT ─────────────────────────
       Run BEFORE the by-id acquittals below, and never acquitted by them: a
       scoped SIBLING statement is exactly what hid hr.ts GET /pickers, so
       "something else in this handler was scoped" must not excuse a list that
       is not. Reported in their own bucket. */
    scanBody.forEach((l, i) => {
      if (!l.includes(".from(") && !l.includes(".rpc(")) return;
      const stmtRaw = statementAround(i);
      const stmt = stripInsertPayload(stmtRaw);
      const abs = scanOffset + i;
      const scoped = SCOPE_PRIMITIVES.some((h) => stmt.includes(h)) || MANUAL_SCOPE.test(stmt);

      // 3. RPC DELEGATION — the predicate moved somewhere this cannot read.
      const rpc = RPC_CALL.exec(l);
      if (rpc) {
        if (!RPC_COMPANY_ARG.test(stmtRaw)) {
          shapeFindings.push({
            file: `backend/${relDir}/${file}`, handler: `${method} ${routePath}`,
            kind: "rpc", writes: true, line: abs + 1,
            text: `${rpc[1]}() — no company argument passed`,
          });
        }
        return;
      }

      const tbl = FROM_TABLE.exec(l) ?? FROM_TABLE.exec(stmt);
      if (!tbl) return;
      const table = tbl[1];

      // 2. GLOBAL NATURAL KEY — a write addressed by a human-meaningful key, or
      //    an upsert whose conflict target omits company_id.
      const isWrite = /\.update\(|\.delete\(|\.upsert\(|\.insert\(/.test(stmtRaw);
      if (isWrite && !scoped) {
        const conflict = UPSERT_ON_CONFLICT.exec(stmtRaw);
        if (conflict && !/\bcompany_id\b/.test(conflict[1])) {
          shapeFindings.push({
            file: `backend/${relDir}/${file}`, handler: `${method} ${routePath}`,
            kind: "upsert-key", writes: true, line: abs + 1,
            text: `${table} upsert onConflict '${conflict[1]}' — no company_id in the conflict target`,
          });
          return;
        }
        const keys = [...stmt.matchAll(NATURAL_KEY_EQ_G)].map((m) => m[1])
          .filter((k) => !NOT_IDENTITY.test(k));
        if (keys.length && /\.update\(|\.delete\(/.test(stmtRaw)) {
          shapeFindings.push({
            file: `backend/${relDir}/${file}`, handler: `${method} ${routePath}`,
            kind: "natural-key", writes: true, line: abs + 1,
            text: `${table} written by '${[...new Set(keys)].join(", ")}' — a key each company can hold its own of`,
          });
          return;
        }
      }

      // 1. SET-READ — a list with no row narrowing and no company predicate.
      if (!SET_READ_TABLES.has(table)) return;
      if (!/\.select\(/.test(stmt)) return;
      if (isWrite) return;                       // handled above
      if (ANY_ID_NARROWING.test(stmt)) return;   // narrowed to known rows
      if (scoped) return;
      // Scope applied later, to THIS query's variable. See QUERY_ASSIGN.
      const qa = QUERY_ASSIGN.exec(stmtRaw);
      const qName = qa ? (qa[1] ?? qa[2]) : null;
      if (qName && scopeAppliedToName(joined, qName)) return;
      shapeFindings.push({
        file: `backend/${relDir}/${file}`, handler: `${method} ${routePath}`,
        kind: "set-read", writes: false, line: abs + 1,
        text: `${table} listed with no row narrowing and no company predicate`,
      });
    });

    const delegated = DELEGATION_GUARDS.some((h) => joined.includes(h));
    const hasScopedQuery = scanBody.some((l, i) => {
      if (!l.includes(".from(")) return false;
      const stmt = stripInsertPayload(statementAround(i));
      return SCOPE_PRIMITIVES.some((h) => stmt.includes(h)) || MANUAL_SCOPE.test(stmt);
    });
    /* THE BUILDER-IN-A-VARIABLE SHAPE, which is legitimate and common:

           const query = supabase.from('x').update(...).eq('id', id);
           const { error } = await scopeToCompany(query, c);

       The scope is applied on a LATER line than the `.from(`, so the
       statement window cannot see it — personal-quick-picks DELETE /:id is
       exactly this and is correctly scoped. A primitive called with a BARE
       IDENTIFIER (not `sb.from(...)`) is wrapping a builder held in a variable,
       which only happens when someone is scoping it.

       RESTRICTED TO THE THREE QUERY-WRAPPING HELPERS. The first cut ran this
       over every primitive and matched `activeCompanyId(c)` — `c` is a bare
       identifier too — which silently re-opened the exact hole this whole
       exercise started from: the DO PATCH passed again. I only found that
       because I removed the DO fix and re-ran, and the checker said 0.

       The comment I wrote at the time claimed the regex could not match a
       context argument. It could. Asserted below now instead of asserted in
       prose. */
    const BUILDER_WRAPPERS = ["scopeToCompany", "scopeToCompanyId", "scopeToAllowedCompanies"];
    const wrapsABuilder = BUILDER_WRAPPERS.some((h) =>
      new RegExp(`\\b${h}\\s*\\(\\s*[A-Za-z_$][\\w$]*\\s*[,)]`).test(joined),
    );
    if (delegated || hasScopedQuery || wrapsABuilder) return;

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
      /* LOOK BACK, not only forward. The predicate is routinely assembled on the
         line ABOVE the statement —

             const companyPred = activeCompanySql(c);
             const existing = await c.env.DB.prepare(
               `SELECT ... WHERE LOWER(name) = LOWER(?)${companyPred} LIMIT 1`)

         — so a window that begins at `.prepare(` sees the interpolation
         `${companyPred}` and not what it holds, and reports a correctly scoped
         statement as unscoped. That mis-anchor produced five phantom findings in
         venues.ts alone, every one of which is scoped. Fourth time in this
         file's history that a window started too late; the fix is the same each
         time and it is now the same shape as statementAround's. */
      const back = Math.max(0, i - 6);
      const stmt = scanBody.slice(back, Math.min(i + 12, scanBody.length)).join("\n");
      if (!RAW_SQL_TABLES.test(stmt)) return;
      if (RAW_SQL_SCOPED.test(stmt)) return;
      // A fragment variable this handler assigned from a real builder, and that
      // THIS statement interpolates. See FRAGMENT_ASSIGN_G.
      if (fragmentNames.size > 0 &&
          [...fragmentNames].some((n) => stmt.includes("${" + n + "}"))) return;
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

/* ── PASS 3: the LIBRARY tree ───────────────────────────────────────────────
   THE FOURTH BLIND SPOT, found 2026-08-13 by a finding this script had already
   reported ZERO on.

   Everything above is anchored on a ROUTE HANDLER — `app.post('/x', ...)`. Files
   under src/scm/lib export plain functions with no handler to anchor to, so the
   whole scan skipped them, and this script printed a confident 0 WRITE while
   lib/pwp-claim-single.ts ran

       .from('pwp_codes').update({ status: 'USED', ... }).eq('code', args.code)

   with no company predicate — the statement that BURNS a customer's voucher.
   Safe once, because `code` was the PRIMARY KEY; migration 0188 re-keyed the
   table (company_id, code) so each company owns its own code space, and the
   guarantee this code silently depended on was gone. A schema change 99
   migrations away turned a correct line into a cross-company write, and no
   scanner was looking at the file.

   THE RULE HERE IS DELIBERATELY NARROWER than the handler passes: report only
   WRITES (update/delete/upsert) whose statement carries a non-id equality
   predicate and no company predicate. Lib functions legitimately read anything
   their caller already scoped, so flagging reads would bury the signal. A
   write, though, is the caller's scope leaving the building — if the function
   does not carry the company itself, nothing downstream can add it.

   NOT a proof of absence, same as every pass above: a lib function that takes an
   already-scoped query builder is invisible to it. */
const LIB_DIRS = [
  path.join(backendRoot, "src", "scm", "lib"),
  path.join(backendRoot, "src", "scm", "shared"),
];
const LIB_WRITE = /\.(update|delete|upsert)\s*\(/;
/* A natural-key predicate: `.eq('code', ...)`, `.eq('doc_no', ...)`. Three
   exclusions, each one learned from a false positive this pass produced on its
   first run rather than reasoned out in advance:

   1. `id` / `*_id` — a uuid primary key is globally unique, so addressing by one
      cannot cross a company boundary.
   2. CONCURRENCY GUARDS — `.eq('paid_sen', prev)`, `.eq('updated_at', prev)`.
      These are compare-and-swap predicates, not identity: they narrow a row the
      caller already chose. Flagging them buried the real signal under money
      columns.
   3. STATE FILTERS — `.eq('status', 'USED')`, `.eq('deleted_at', null)`. Same
      reasoning; a status is never what identifies a row.

   What is left is what bit us: a HUMAN-MEANINGFUL key that two companies can
   each hold their own of. */
/* Both moved ABOVE the handler passes on 2026-08-18 — the route-handler
   natural-key pass needs them too, and a second copy is how a rule drifts. */
/* SELF-TEST for this pass, same rule as the one at the top of the file: a
   pattern that cannot match produces a plausible report. Both assertions below
   encode a false positive this pass actually produced, so a future edit that
   reintroduces either one fails here instead of in a review. */
{
  const keysOf = (s) => [...s.matchAll(NATURAL_KEY_EQ_G)].map((m) => m[1]).filter((k) => !NOT_IDENTITY.test(k));
  const ok =
    keysOf(".eq('code', args.code)").length === 1 &&
    keysOf(".eq('id', x)").length === 0 &&
    keysOf(".eq('so_item_id', x)").length === 0 &&
    keysOf(".eq('paid_sen', prev)").length === 0 &&   // concurrency guard, not identity
    keysOf(".eq('status', 'USED')").length === 0 &&     // state filter, not identity
    keysOf(".eq('version', prev)").length === 0 &&      // concurrency guard, not identity
    keysOf(".eq('edit_lease_token', tok)").length === 0 &&
    keysOf(".eq('stop_type', 'DELIVERY')").length === 0 &&
    keysOf(".eq('code', args.code)").length === 1 &&    // STILL the real signal
    MANUAL_SCOPE.test(".eq('company_id', args.companyId)") &&
    /* A stamp is not a predicate. Asserted so the fifth blind spot cannot
       return: seven cross-company MONEY writes hid behind this exact shape. */
    !MANUAL_SCOPE.test(stripInsertPayload(".from('x').insert({ company_id: activeCompanyId(c) })")) &&
    !stripInsertPayload(".from('x').insert({ company_id: activeCompanyId(c) })").includes("activeCompanyId") &&
    MANUAL_SCOPE.test(stripInsertPayload(".from('x').insert({ a: 1 }).eq('company_id', co)")) &&
    LIB_WRITE.test(".update({ status: 'USED' })") &&
    !LIB_WRITE.test(".select('code')");
  if (!ok) {
    console.error("check-company-scope: LIBRARY pass self-test FAILED - not reporting.");
    process.exit(2);
  }
}
let libStatementsChecked = 0;
const libFindings = [];
const libExempted = [];
for (const dir of LIB_DIRS) {
  if (!fs.existsSync(dir)) continue;
  const relDir = path.relative(backendRoot, dir).split(path.sep).join("/");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const raw = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
    const lines = stripComments(raw);
    /* FILE-level exemption, spelled differently from the per-statement one on
       purpose. Some files write every row by the same key for the same reason —
       so-revision.ts addresses five statements by `doc_no`, which is
       mfg_sales_orders' PRIMARY KEY — and five copies of one paragraph is how a
       reason stops being read.
       The danger of a blanket exemption is that a NEW, differently-keyed
       statement later hides under it. That is why the report still prints how
       many statements each exempted file carries: the exemption suppresses the
       findings, never the fact that the file was skipped or how big it is. */
    const fileExempt = raw.slice(0, 60).some((l) => /company-scope-file:/.test(l));
    for (let i = 0; i < lines.length; i++) {
      if (!/\.from\s*\(/.test(lines[i] ?? "")) continue;
      /* The statement: from `.from(` until the line that ends it.
         BLANK LINES DO NOT END IT. That looks like a detail and is not: this
         pass's first run reported lib/pwp-claim-single.ts as unscoped when the
         `.eq('company_id', ...)` was right there — because a COMMENT sits in
         the middle of the chain explaining why, stripComments blanks it, and
         the window stopped at the blank. A checker that reports a fixed line as
         broken burns the reader's trust exactly as fast as one that reports a
         broken line as fixed.
         So: skip blanks, and stop only at a non-blank line that does not
         continue the chain (no leading `.`, `)`, `,` and not still inside an
         object literal). */
      const parts = [];
      for (let j = i; j < Math.min(i + 24, lines.length); j++) {
        const l = lines[j] ?? "";
        const t = l.trim();
        parts.push(l);
        if (/;\s*$/.test(t)) break;
        if (t === "") continue;                       // stripped comment - keep going
        if (j === i) continue;
        if (/^[.)\],}]/.test(t)) continue;            // chain / literal continuation
        if (/[({[,]$/.test(t)) continue;              // opens something on the next line
        if (/^['"`\w]+\s*:/.test(t)) continue;        // object-literal key
        break;
      }
      const stmt = parts.join(" ");
      if (!LIB_WRITE.test(stmt)) continue;
      libStatementsChecked++;
      if (fileExempt) { libExempted.push(`backend/${relDir}/${file}`); continue; }
      if (MANUAL_SCOPE.test(stmt)) continue;
      /* Same opt-out the handler passes carry, read from the RAW lines (the
         annotation is a comment, and `lines` has had comments stripped). Scoped
         to the ten lines above the statement so it sits with what it explains
         and cannot silence a different statement added later. */
      const annotated = raw
        .slice(Math.max(0, i - 10), i + parts.length)
        .some((l) => /company-scope:/.test(l));
      if (annotated) continue;
      const keys = [...stmt.matchAll(NATURAL_KEY_EQ_G)]
        .map((m) => m[1])
        .filter((k) => !NOT_IDENTITY.test(k));
      if (!keys.length) continue;
      libFindings.push({
        file: `backend/${relDir}/${file}`,
        line: i + 1,
        key: [...new Set(keys)].join(", "),
        text: (raw[i] ?? "").trim().slice(0, 100),
      });
      i += parts.length - 1;
    }
  }
}

findings.sort((a, b) => Number(b.writes) - Number(a.writes) || a.file.localeCompare(b.file) || a.line - b.line);
shapeFindings.sort((a, b) => a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file) || a.line - b.line);
suppressions.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

const KIND_LABEL = {
  "set-read": "SET-READ      a list with no row narrowing and no company predicate",
  "natural-key": "NATURAL-KEY   a write addressed by a key each company can hold its own of",
  "upsert-key": "UPSERT-KEY    an upsert whose onConflict target omits company_id",
  rpc: "RPC           the predicate moved into a Postgres function this cannot read",
};

/* ── THE RATCHET (--check / --update) ───────────────────────────────────────
   The current set of unscoped things, keyed stably. Both finding sets go in:
   route handlers (read + write) and library writes. Nothing here re-decides
   what is scoped — that is the whole matcher above; this only compares the keys
   it produced against the grandfather baseline. */
const currentKeys = [...findings.map(handlerKeyOf), ...libFindings.map(libKeyOf)].sort();
const detailFor = new Map([
  ...findings.map((f) => [handlerKeyOf(f), `${f.writes ? "WRITE" : "read "} L${f.line}  ${f.hits.map((h) => `L${h.line}`).join(" ")}`]),
  ...libFindings.map((f) => [libKeyOf(f), `WRITE L${f.line} by '${f.key}'`]),
]);

function loadBaseline(fatalIfMissing) {
  if (!fs.existsSync(BASELINE_PATH)) {
    if (fatalIfMissing) {
      console.error(
        `FATAL: baseline ${BASELINE_REL} is missing. Without it every finding reads ` +
          `as new. Create it with \`node scripts/check-company-scope.mjs --update\`.`,
      );
      process.exit(2);
    }
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  if (!Array.isArray(parsed.unscoped)) {
    console.error(`FATAL: ${BASELINE_REL} has no "unscoped" array.`);
    process.exit(2);
  }
  return parsed;
}

function writeBaseline(keys) {
  const body = {
    "//": [
      "GRANDFATHER BASELINE for backend/scripts/check-company-scope.mjs --check.",
      "Each entry is one handler/statement that touches a row by id with NO company",
      "predicate, keyed by FILE PATH + ROUTE IDENTITY (never a line number).",
      "This is DEBT, not the standard, and it may only SHRINK. A NEW unscoped handler",
      "is BLOCKED: it is not in this list, so --check fails and names it.",
      "To lock in a fix: scope the handler (add a company_id predicate) or annotate a",
      "verified-safe one with `// company-scope: <reason>`, then run",
      "`npm --prefix backend run audit:company-scope:update` and commit the smaller list.",
      "Generated ONLY by --update, which refuses to add an entry the committed list does",
      "not already have — the same no-growth rule lint-ratchet.mjs enforces on ceilings.",
    ],
    unscoped: keys,
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(body, null, 2)}\n`);
}

if (updateMode) {
  const existing = loadBaseline(false);
  const committed = new Set(existing?.unscoped ?? []);
  const grew = currentKeys.filter((k) => !committed.has(k));
  // On the introducing run there is no baseline yet, so writing the whole set is
  // how it is born. After that, a key not already grandfathered is a NEW
  // violation and --update REFUSES it — the list may only shrink.
  if (existing && grew.length) {
    console.error(
      `\ncheck-company-scope: REFUSING to write — ${grew.length} unscoped handler(s) ` +
        `are NOT in the committed baseline and --update may only SHRINK it:\n`,
    );
    for (const k of grew) console.error(`  + ${k}   (${detailFor.get(k) ?? ""})`);
    console.error(
      `\n  A baseline that grows is not a ratchet. Fix the finding — put a company_id\n` +
        `  predicate on the statement — or annotate a verified-safe handler with\n` +
        `  \`// company-scope: <reason>\`, then run this again. ${BASELINE_REL} was NOT written.\n`,
    );
    process.exit(1);
  }
  const removed = [...committed].filter((k) => !currentKeys.includes(k));
  writeBaseline(currentKeys);
  console.log(
    `check-company-scope: wrote ${currentKeys.length} grandfathered entr${currentKeys.length === 1 ? "y" : "ies"} ` +
      `to ${BASELINE_REL} (was ${committed.size}).`,
  );
  if (removed.length) {
    console.log(`  ${removed.length} now-scoped and dropped from the baseline:`);
    for (const k of removed.slice(0, 40)) console.log(`    - ${k}`);
    if (removed.length > 40) console.log(`    … and ${removed.length - 40} more`);
  }
  process.exit(0);
}

if (checkMode) {
  const existing = loadBaseline(true);
  const baseline = new Set(existing.unscoped);
  const problems = [];

  // The primary gate: every current finding must be grandfathered.
  const newViolations = newAgainst(currentKeys, baseline);
  const fixed = [...baseline].filter((k) => !currentKeys.includes(k));

  // The no-growth guard: the obvious bypass is to add your key to the JSON in the
  // same PR. Compare the baseline file at HEAD to the one at the merge base and
  // fail if it grew — exactly check-release-discipline's --ratchet-against.
  if (ratchetAgainst) {
    let baseSha;
    try {
      baseSha = execFileSync("git", ["merge-base", "HEAD", ratchetAgainst], { cwd: repoRoot, encoding: "utf8" }).trim();
    } catch {
      console.error(
        `FATAL: --ratchet-against ${ratchetAgainst} could not be resolved to a merge base. ` +
          `Fetch it first; a ratchet that cannot see its baseline must not pass in silence.`,
      );
      process.exit(2);
    }
    let baseText = null;
    try {
      baseText = execFileSync("git", ["show", `${baseSha}:${BASELINE_REL}`], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // The introducing commit: no baseline existed at the merge base.
      console.log(`ratchet: ${BASELINE_REL} did not exist at ${baseSha.slice(0, 8)} — this is the commit that introduces it, nothing to compare.`);
    }
    if (baseText !== null) {
      const was = new Set(JSON.parse(baseText).unscoped ?? []);
      const grew = [...baseline].filter((k) => !was.has(k));
      if (grew.length) {
        for (const k of grew) problems.push(`the baseline GREW against ${ratchetAgainst}: + ${k}`);
      } else {
        console.log(`ratchet: baseline compared against ${baseSha.slice(0, 8)} (${ratchetAgainst}) — no growth.`);
      }
    }
  }

  for (const k of newViolations) {
    problems.push(`NEW unscoped handler (not grandfathered): ${k}   ${detailFor.get(k) ?? ""}`);
  }

  // Printed on every run — the current count and the grandfathered count.
  console.log(
    `\ncheck-company-scope ratchet: ${currentKeys.length} unscoped now, ${baseline.size} grandfathered ` +
      `(${handlersChecked} handlers + ${libStatementsChecked} library writes scanned).`,
  );
  if (fixed.length) {
    console.log(
      `  ${fixed.length} baseline entr${fixed.length === 1 ? "y is" : "ies are"} no longer unscoped — ` +
        `run \`npm --prefix backend run audit:company-scope:update\` to lock the improvement in:`,
    );
    for (const k of fixed.slice(0, 20)) console.log(`    - ${k}`);
    if (fixed.length > 20) console.log(`    … and ${fixed.length - 20} more`);
  }

  if (problems.length) {
    console.error(
      `\ncheck-company-scope: RATCHET BROKEN — ${problems.length} problem(s).\n\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\n\n  A handler that touches a row by id with no company predicate is the repo's\n` +
        `  most repeated defect class. Put a company_id predicate on the statement (see\n` +
        `  scm/lib/companyScope.ts), or if it is a deliberate cross-company surface,\n` +
        `  annotate it with \`// company-scope: <reason>\`. Do NOT add the key to\n` +
        `  ${BASELINE_REL} — the baseline may only shrink.\n`,
    );
    process.exit(1);
  }
  console.log(`  OK — every unscoped handler is grandfathered; no NEW violation.`);
  process.exit(0);
}

if (jsonOut) {
  console.log(JSON.stringify(
    { handlersChecked, findings, shapeFindings, suppressions, libStatementsChecked, libFindings },
    null, 2,
  ));
} else {
  const w = findings.filter((f) => f.writes).length;
  const baselineNow = loadBaseline(false);
  console.log(
    `Checked ${handlersChecked} SCM route handlers.\n` +
      `${findings.length} touch a row by id with no company-scope helper in the handler ` +
      `(${w} of them WRITE).\n` +
      (baselineNow
        ? `Ratchet: ${currentKeys.length} unscoped now, ${baselineNow.unscoped.length} grandfathered ` +
          `in ${BASELINE_REL} (run with --check to gate, --update to shrink).\n`
        : `Ratchet: no baseline yet — run with --update to create ${BASELINE_REL}.\n`) +
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

  /* ── The three shapes ID_PREDICATE cannot see ────────────────────────────
     Printed as their OWN section, not folded into the count above, so the
     historical number stays comparable run to run and a reader can tell which
     pass produced which finding. */
  const shapeWrites = shapeFindings.filter((f) => f.writes).length;
  console.log(
    `\n\nShapes the by-id passes are BLIND to (set-reads, global natural keys, RPC delegation):\n` +
      `${shapeFindings.length} statement(s), ${shapeWrites} of them WRITE or delegate a write.\n` +
      `Judged PER STATEMENT and deliberately NOT excused by a scoped sibling — a scoped\n` +
      `sibling in the same handler is exactly what hid the staff-picker leak.\n`,
  );
  let lastKind = "";
  let lastShapeFile = "";
  for (const f of shapeFindings) {
    if (f.kind !== lastKind) {
      console.log(`\n  ${KIND_LABEL[f.kind] ?? f.kind}`);
      lastKind = f.kind;
      lastShapeFile = "";
    }
    if (f.file !== lastShapeFile) { console.log(`\n  ${f.file}`); lastShapeFile = f.file; }
    console.log(`    ${f.writes ? "WRITE" : "read "}  L${f.line}  ${f.handler}`);
    console.log(`             ${f.text}`);
  }

  /* ── The suppression ledger ──────────────────────────────────────────────
     Every `// company-scope:` that silenced a handler, with the reason it gave.
     Silent before 2026-08-18, which is how one came to sit on an unscoped write
     without being an opt-out at all — it was the opening words of a paragraph
     about a DIFFERENT table in the same handler, and this test is a substring
     match. Read this list when it changes; that is the whole point of it. */
  console.log(
    `\n\nSuppressions — "// company-scope:" annotations that silenced a handler: ${suppressions.length}.\n` +
      `A suppression the reader cannot see is a suppression nobody re-checks.\n`,
  );
  let lastSupFile = "";
  for (const sup of suppressions) {
    if (sup.file !== lastSupFile) { console.log(`\n  ${sup.file}`); lastSupFile = sup.file; }
    console.log(`    L${sup.line}  ${sup.handler}`);
    console.log(`             ${sup.reason || "(no reason given)"}`);
  }

  console.log(
    `\n\nLibrary tree (src/scm/lib + src/scm/shared): ${libStatementsChecked} write statements.\n` +
      `${libFindings.length} address a row by a NON-id key with no company predicate.\n` +
      `These have no route handler to anchor to, which is why the passes above could not see them.\n`,
  );
  let lastLib = "";
  for (const f of libFindings) {
    if (f.file !== lastLib) { console.log(`\n${f.file}`); lastLib = f.file; }
    console.log(`  WRITE  L${f.line}  by '${f.key}'  ${f.text}`);
  }
  /* Exempted files are PRINTED, with their statement counts. A suppression you
     cannot see is a suppression nobody re-checks — and the whole reason this
     pass exists is that a file nobody was looking at grew a cross-company
     write. */
  if (libExempted.length) {
    const byFile = new Map();
    for (const f of libExempted) byFile.set(f, (byFile.get(f) ?? 0) + 1);
    console.log(`\nFile-level exemptions ("company-scope-file:") — read these when they change:`);
    for (const [f, n] of [...byFile].sort()) console.log(`  ${n} statement(s)  ${f}`);
  }
}

/* --strict gates on the WRITE findings only.
   A cross-company WRITE corrupts the other company's data; a read-side finding
   is a disclosure and often a deliberate cross-company surface, so gating a PR
   on the raw count would fail on legitimate code — and a gate that cries wolf is
   a gate someone switches off. The read findings are still printed above.
   Sibling checks make the same split: check-silent-mutations gates on SILENT
   (not CAUGHT/UNRESOLVED), check-shared-mirrors on DIVERGED (not COSMETIC). */
const writeFindings =
  findings.filter((f) => f.writes).length + shapeFindings.filter((f) => f.writes).length;
/* `process.exitCode`, NOT `process.exit()`. Found 2026-08-18 by a test that
   ran this script and read its stdout: when stdout is a PIPE (a shell
   redirect, `| grep`, execFileSync, a CI log collector) Node's writes are
   ASYNCHRONOUS, and `process.exit()` tears the process down before the buffer
   drains — so the REPORT IS TRUNCATED, silently, and only when piped. Measured:
   8,647 characters through a pipe against 40,000+ on a terminal, with the whole
   new-shapes section and the suppression ledger simply missing. A gate that
   prints less than it found, only when a machine is reading it, is the same
   class of fault as the one this script exists to catch. Setting exitCode lets
   node exit naturally once stdout has flushed; the exit STATUS is unchanged. */
process.exitCode = strict && writeFindings ? 1 : 0;
