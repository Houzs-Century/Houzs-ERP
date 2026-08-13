#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-conversion-guards.mjs — a document conversion NEVER crosses a company.
//
// THE INVARIANT, stated once so it stops being re-derived per route:
//
//     A converter reads a SOURCE document by id and writes a NEW document from
//     it. If the source is another company's, the conversion silently
//     RE-PARENTS money: the source company's goods, revenue or liability land in
//     the other company's books, under the other company's document number, and
//     nothing on screen says so.
//
// THE MECHANISM CHANGED ON 2026-08-13, AND THAT IS WHAT THIS FILE NOW CHECKS.
//
// There were two ways to hold the invariant:
//
//   A — REFUSE.      Load the source UNSCOPED, compare its company_id to the
//                    active one, return 409 "that document belongs to 2990,
//                    switch company". This is what every converter did, via
//                    `crossCompanySourceRefusal` in scm/lib/companyScope.ts, and
//                    what the first version of this script asserted: 16
//                    conversions, 0 unguarded.
//
//   B — CANNOT SEE.  Load the source SCOPED, so a cross-company source is not
//                    there at all.
//
// The owner chose B. The difference is not stylistic. Under A the invariant is a
// comparison somebody has to remember to write, in a handler that reads
// correctly without it; under B it is a property of the read itself, and the
// failure mode of forgetting is an empty result rather than a re-companied
// document. A also has to be re-derived per route — the reason SEVEN of eleven
// conversions had no check at all when this was last audited, with nothing in
// the code saying which was which.
//
// WHAT B COSTS, recorded here because it is the honest half: the operator-facing
// message gets worse. A says "SO-2606-002 belongs to 2990, switch company and
// convert it there". B says "not found" / "has no items", which is true from
// this company's view and unhelpful from the operator's. Naming the other
// company would require an UNSCOPED read of a document the handler otherwise
// never touches — widening the read surface to improve an error message is the
// wrong trade on a conversion path. Every converted handler states this in its
// own comment; `mfg-purchase-orders.ts` `/:id/convert-from-so` is the original.
//
// WHAT THIS SCRIPT CHECKS. Every route whose PATH declares a conversion —
// `/from-x`, `/convert-from-x`, `/:id/items/from-x/:y` — must appear in the
// SOURCES registry below naming the source TABLE(s) it reads by id, and each of
// those tables must be read through `scopeToCompany(...)` / `scopeToCompanyId(...)`
// inside the handler, its named delegate, or a same-file function it calls.
//
// A conversion route with NO registry entry is a FINDING, not a pass. That is
// deliberate: the registry is where the next author has to answer the one
// question this audit found people skipping — WHICH document is the source. A
// checker that guessed would guess wrong; of the leads in the 2026-08-13 audit,
// more than half were.
//
// LEGACY-REFUSAL entries. A registry entry may declare `legacyRefusal: '<why>'`
// instead of relying on the scope. Those are checked the OLD way — the
// `crossCompanySourceRefusal` / `isCrossCompanySource` rule must be present —
// and are listed under their own heading so nobody reads them as converted. This
// is not an exemption list: something real is verified for every row, and an
// entry whose refusal disappears is a finding like any other.
//
// WHAT IT STILL DOES NOT CHECK: that the scoped table is genuinely THE source.
// The registry says which table that is, and the registry is written by a
// reader. A handler that scopes its header and reads its lines unscoped passes
// here if only the header is declared — so declare both; several conversions
// have both, and the LINE table is an entry point in its own right.
//
// Usage:
//   node backend/scripts/check-conversion-guards.mjs           # report
//   node backend/scripts/check-conversion-guards.mjs --strict  # exit 1 on any gap
//   node backend/scripts/check-conversion-guards.mjs --json
//
// NO DEPENDENCIES (node:fs / node:path only) so it runs in a fresh worktree.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const jsonOut = process.argv.includes("--json");

const ROUTE_DIRS = [
  path.join(backendRoot, "src", "scm", "routes"),
  path.join(backendRoot, "src", "routes"),
];

/* ── THE REGISTRY ───────────────────────────────────────────────────────────
   key   = "<file>::<METHOD> <path>" exactly as this script reports it.
   source = the tables this conversion reads BY ID from the caller's input.
            HEADER and LINE both, where both exist — each is an entry point.
   legacyRefusal = still on mechanism A; the reason it has not been converted.

   Keyed on file+route, not line, so the registry survives the file moving. */
const SOURCES = {
  "backend/src/scm/routes/delivery-orders-mfg.ts::POST /from-sos": {
    doc: "SO -> DO, the shared Delivery Planning queue",
    source: ["mfg_sales_order_items", "mfg_sales_orders"],
    inherit:
      "the ONE conversion that legitimately crosses the switcher. A 2990 SO " +
      "becomes a 2990 DO under 2990's prefix — the destination inherits the " +
      "source's company rather than claiming the document, so the books stay " +
      "straight without hiding it. companyScope.ts has said so since the rule " +
      "was written ('deliberately NOT block all cross-company conversion'); " +
      "the route was nonetheless broken twice in one day, once by adding a " +
      "refusal and once by scoping the source, before the owner confirmed the " +
      "design on 2026-08-13.",
  },
  "backend/src/scm/routes/delivery-returns.ts::POST /from-do": {
    doc: "DO -> DR",
    source: ["delivery_order_items", "delivery_orders"],
  },
  "backend/src/scm/routes/delivery-returns.ts::POST /from-dos": {
    doc: "DO -> DR (same handler as /from-do)",
    source: ["delivery_order_items", "delivery_orders"],
  },
  "backend/src/scm/routes/grns.ts::POST /from-pos": {
    doc: "PO -> GRN (whole POs)",
    source: ["purchase_orders", "purchase_order_items"],
  },
  "backend/src/scm/routes/grns.ts::POST /from-po-items": {
    doc: "PO -> GRN (picked lines; parent PO rides an !inner embed)",
    source: ["purchase_order_items"],
  },
  "backend/src/scm/routes/mfg-purchase-orders.ts::POST /from-sos": {
    doc: "SO -> PO, through the shared convertSosToPosCore",
    source: ["mfg_sales_order_items"],
  },
  "backend/src/scm/routes/mfg-purchase-orders.ts::POST /:id/convert-from-so": {
    doc: "SO -> existing PO. The model: destination PO through scopeToCompanyId, source SO items through scopeToCompany",
    source: ["mfg_sales_order_items"],
  },
  "backend/src/scm/routes/purchase-consignment-receives.ts::POST /from-pcos": {
    doc: "PC Order -> PC Receive",
    source: ["purchase_consignment_orders", "purchase_consignment_order_items"],
  },
  "backend/src/scm/routes/purchase-consignment-returns.ts::POST /from-pc-receives": {
    doc: "PC Receive -> PC Return (batch)",
    source: ["purchase_consignment_receives", "purchase_consignment_receive_items"],
  },
  "backend/src/scm/routes/purchase-consignment-returns.ts::POST /from-pc-receive": {
    doc: "PC Receive -> PC Return (single)",
    source: ["purchase_consignment_receives", "purchase_consignment_receive_items"],
  },
  "backend/src/scm/routes/purchase-invoices.ts::POST /from-grn-items": {
    doc: "GRN -> PI (picked lines; parent GRN rides an !inner embed)",
    source: ["grn_items"],
  },
  "backend/src/scm/routes/purchase-invoices.ts::POST /from-grn": {
    doc: "GRN -> PI (whole GRN)",
    source: ["grns", "grn_items"],
  },
  "backend/src/scm/routes/purchase-returns.ts::POST /from-grns": {
    doc: "GRN -> Purchase Return (batch)",
    source: ["grns", "grn_items"],
  },
  "backend/src/scm/routes/purchase-returns.ts::POST /from-grn": {
    doc: "GRN -> Purchase Return (single)",
    source: ["grns", "grn_items"],
  },
  "backend/src/scm/routes/sales-invoices.ts::POST /from-dos": {
    doc: "DO -> SI (picked lines)",
    source: ["delivery_order_items", "delivery_orders"],
  },
  "backend/src/scm/routes/sales-invoices.ts::POST /:id/items/from-do/:doId": {
    doc: "DO -> SI, PARTIAL form: a second delivery folded into an existing invoice",
    source: ["delivery_orders", "delivery_order_items"],
  },
};

/* A path that DECLARES a conversion. Anchored on the segment, so `/from-sos`,
   `/from-grn-items`, `/:id/convert-from-so` and `/:id/items/from-do/:doId` all
   match while `/informations` does not. */
const CONVERSION_PATH = /(^|\/)(from-[a-z0-9-]+|convert-from-[a-z0-9-]+)(\/|$)/;
const HANDLER =
  /^\s*[A-Za-z_$][\w$]*\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`](\/[^'"`]*)['"`]/;
/* The legacy (mechanism A) rule. `crossCompanySourceRefusal` is the shared
   primitive; `isCrossCompanySource` its lower-level half. Only LEGACY-REFUSAL
   registry entries are checked against this now. */
const GUARD = /crossCompanySourceRefusal|isCrossCompanySource/;
/* A converter may hand the work to a shared core (convertSosToPosCore,
   convertDoLinesToReturn) or be registered on a named handler
   (createPurchaseInvoiceFromGrnHandler). Resolved below. */
const NAMED_DELEGATE =
  /^\s*[A-Za-z_$][\w$]*\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"`][^'"`]*['"`]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/;

/* THE SCOPE EXTRACTOR — which TABLE does each scopeToCompany/scopeToCompanyId
   call scope? The house idiom wraps the builder directly:

       scopeToCompany(sb.from('grns').select(...).eq('id', id), c)
       scopeToCompanyId(sb\n  .from('purchase_orders')\n  .select(...), co.companyId)

   so the answer is the FIRST `.from('X')` after the call opens. The window stops
   at the first `;` on purpose: `q = scopeToCompany(q, c); ... sb.from('grns')`
   is the re-assignment idiom (grns.ts list handlers), where the table sits in an
   EARLIER statement and reading forward would credit the wrong query. That false
   pass is precisely the failure this repo has produced in three checkers. */
const SCOPE_CALL = /\bscopeToCompany(?:Id)?\s*\(/g;
function scopedTables(text) {
  const found = new Set();
  for (const m of text.matchAll(SCOPE_CALL)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const stop = after.indexOf(";");
    const window = stop === -1 ? after : after.slice(0, stop);
    const f = /\.from\(\s*['"`]([A-Za-z0-9_]+)['"`]/.exec(window);
    if (f) found.add(f[1]);
  }
  return found;
}

/* SELF-TEST. Three checkers in this repo have reported a clean run from a
   pattern that could not match. Assert before scanning; refuse to report from a
   dead one. */
{
  const t = (s) => { CONVERSION_PATH.lastIndex = 0; return CONVERSION_PATH.test(s); };
  const st = (s) => [...scopedTables(s)].join(",");
  const ok =
    t("/from-sos") && t("/from-grn-items") && t("/:id/convert-from-so") &&
    t("/:id/items/from-do/:doId") &&
    !t("/informations") && !t("/:id/items") && !t("/deliverable-so-lines") &&
    HANDLER.test("purchaseReturns.post('/from-grn', async (c) => {") &&
    NAMED_DELEGATE.exec("deliveryReturns.post('/from-do', convertDoLinesToReturn)")?.[1] === "convertDoLinesToReturn" &&
    GUARD.test("if (isCrossCompanySource(dh.company_id, c)) {") &&
    GUARD.test("await crossCompanySourceRefusal(sb, c, table, ids, col);") &&
    // the extractor finds the wrapped table, on one line and across lines
    st("await scopeToCompany(sb.from('grns').select('id'), c)") === "grns" &&
    st("await scopeToCompanyId(sb\n  .from('purchase_orders')\n  .select('id')\n  .eq('id', x), co.companyId)") === "purchase_orders" &&
    // ...and does NOT credit a query in a LATER statement
    st("q = scopeToCompany(q, c);\nconst r = sb.from('grns').select('id');") === "" &&
    // ...and an unscoped read contributes nothing
    st("const { data } = await sb.from('grns').select('id').eq('id', id);") === "";
  if (!ok) {
    console.error("check-conversion-guards: internal pattern self-test FAILED - not reporting.");
    process.exit(2);
  }
}

function stripComments(lines) {
  let inBlock = false;
  return lines.map((l) => {
    let out = l;
    if (inBlock) { const e = out.indexOf("*/"); if (e === -1) return ""; out = out.slice(e + 2); inBlock = false; }
    for (;;) {
      const s = out.indexOf("/*");
      if (s === -1) break;
      const e = out.indexOf("*/", s + 2);
      if (e === -1) { out = out.slice(0, s); inBlock = true; break; }
      out = out.slice(0, s) + out.slice(e + 2);
    }
    const line = out.indexOf("//");
    return line === -1 ? out : out.slice(0, line);
  });
}

const findings = [];
const converted = [];
const legacy = [];
const inherits = [];
const seenKeys = new Set();

for (const dir of ROUTE_DIRS) {
  if (!fs.existsSync(dir)) continue;
  const relDir = path.relative(backendRoot, dir).split(path.sep).join("/");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const raw = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
    const lines = stripComments(raw);

    /* Resolve a named function to its BODY TEXT, so the caller can ask what that
       body scopes. RECURSIVE, bounded at 2 hops and cycle-safe: a converter that
       delegates is scoped iff its delegate is, and the indirection is real —
       delivery-returns registers /from-do on `convertDoLinesToReturn`,
       mfg-purchase-orders routes /from-sos through `convertSosToPosCore`, and
       purchase-invoices registers /from-grn on
       `createPurchaseInvoiceFromGrnHandler`. A body-text scan alone calls all
       three unscoped, which is the confident-and-wrong number every checker here
       has produced at least once. */
    const bodyOf = (name) => {
      const decl = new RegExp(`(?:async\\s+function|function|const)\\s+${name}\\b`);
      const start = lines.findIndex((l) => decl.test(l));
      if (start === -1) return null;
      let braces = 0, opened = false;
      const body = [];
      for (let i = start; i < lines.length; i++) {
        const l = lines[i] ?? "";
        body.push(l);
        for (const ch of l) {
          if (ch === "{") { braces++; opened = true; }
          else if (ch === "}") braces--;
        }
        if (opened && braces <= 0) break;
      }
      return body.join("\n");
    };
    const reachableText = (seedText, depth = 0, seenFns = new Set()) => {
      let text = seedText;
      if (depth >= 2) return text;
      const called = [...new Set(
        [...seedText.matchAll(/\b([a-z][A-Za-z0-9_]{4,})\s*\(/g)].map((x) => x[1]),
      )];
      for (const fn of called) {
        if (seenFns.has(fn)) continue;
        seenFns.add(fn);
        const b = bodyOf(fn);
        if (b) text += "\n" + reachableText(b, depth + 1, seenFns);
      }
      return text;
    };

    for (let i = 0; i < lines.length; i++) {
      const m = HANDLER.exec(lines[i] ?? "");
      if (!m) continue;
      const [, method, routePath] = m;
      if (!CONVERSION_PATH.test(routePath)) continue;
      if (method.toLowerCase() === "get") continue; // a picker READ is not a conversion

      /* THE HANDLER'S OWN TEXT, and NOTHING ELSE.
         · registered on a NAMED handler -> exactly that function's body. Do NOT
           also take the source slice after the registration line: a converter
           extracted to a const is registered at the END of its own declaration,
           so the slice that follows is the NEXT handler's declaration. That read
           a sibling's scoped query as this route's and passed a deliberately
           un-scoped `/from-dos` — caught only because the scope was reverted on
           purpose to see the checker fail. A checker that cannot fail has not
           been tested.
         · registered INLINE -> from here to the next registration, or 400 lines. */
      const delegate = NAMED_DELEGATE.exec(lines[i] ?? "")?.[1];
      let text = delegate ? bodyOf(delegate) : null;
      if (text === null) {
        let end = lines.length;
        for (let j = i + 1; j < Math.min(i + 400, lines.length); j++) {
          if (HANDLER.test(lines[j] ?? "")) { end = j; break; }
        }
        text = lines.slice(i, end).join("\n");
      }
      text = reachableText(text);

      const rel = `backend/${relDir}/${file}`;
      const route = `${method.toUpperCase()} ${routePath}`;
      const key = `${rel}::${route}`;
      seenKeys.add(key);
      const entry = SOURCES[key];
      const row = { file: rel, line: i + 1, route, doc: entry?.doc ?? null };

      if (!entry) {
        findings.push({
          ...row,
          problem: "source_not_declared",
          detail:
            "new or renamed conversion: add it to the SOURCES registry in this " +
            "script naming the table(s) it reads by id, then scope those reads",
        });
        continue;
      }

      /* THE INHERIT KIND. One conversion legitimately runs across the switcher:
         SO -> DO, the shared Delivery Planning queue. It holds the invariant a
         THIRD way — it does not refuse the other company's document and it does
         not hide it; it INHERITS it, so a 2990 SO becomes a 2990 DO under 2990's
         prefix and the destination never claims the document as its own.

         `companyScope.ts` has said this since the rule was written ("deliberately
         NOT block all cross-company conversion"), and this route was broken twice
         in one day by people who did not read it: once by adding a refusal, once
         by scoping the source. The owner confirmed the design; this is the check
         that stops the third time.

         VERIFIED, NOT EXEMPTED. Two things must hold, and both are the OPPOSITE
         of what the other kinds check:
           1. the declared source tables must NOT be scoped to the ACTIVE company
              — that is what would hide the document the caller came to convert;
           2. the handler must resolve a SOURCE company and use it, which is what
              makes the destination a 2990 document rather than a Houzs one.
         An entry that stops doing either is a finding like any other. */
      if (entry.inherit) {
        const scopedNow = scopedTables(text);
        const wronglyScoped = entry.source.filter((t) => scopedNow.has(t));
        const resolvesSource = /sourceCompanyId/.test(text);
        if (wronglyScoped.length > 0) {
          findings.push({
            ...row,
            problem: "inherit_source_wrongly_scoped",
            detail:
              `declared INHERIT (${entry.inherit}) but scopes ${wronglyScoped.join(", ")} ` +
              "to the ACTIVE company — that hides the very document this route exists " +
              "to convert. Scope it to the SOURCE company instead, or change the kind",
          });
        } else if (!resolvesSource) {
          findings.push({
            ...row,
            problem: "inherit_without_source_company",
            detail:
              "declared INHERIT but never resolves a source company, so the " +
              "destination stamps the ACTIVE one — which is re-parenting, the " +
              "exact thing INHERIT is claimed to avoid",
          });
        } else {
          inherits.push({ ...row, reason: entry.inherit, source: entry.source });
        }
        continue;
      }

      if (entry.legacyRefusal) {
        if (GUARD.test(text)) {
          legacy.push({ ...row, reason: entry.legacyRefusal });
        } else {
          findings.push({
            ...row,
            problem: "legacy_refusal_missing",
            detail:
              "declared as still on the refusal mechanism, but neither " +
              "crossCompanySourceRefusal nor isCrossCompanySource is reachable " +
              "from this handler — it is now unguarded by EITHER mechanism",
          });
        }
        continue;
      }

      const scoped = scopedTables(text);
      const unscoped = entry.source.filter((t) => !scoped.has(t));
      if (unscoped.length === 0) {
        converted.push({ ...row, source: entry.source });
      } else {
        findings.push({
          ...row,
          problem: "source_not_scoped",
          detail: `declared source table(s) read with no company predicate: ${unscoped.join(", ")}`,
          unscoped,
        });
      }
    }
  }
}

/* A registry entry with no route is as much a defect as a route with no entry:
   it means a conversion was renamed or removed and the registry still claims to
   describe it, which is how a checker comes to report on code that is not
   there. */
for (const key of Object.keys(SOURCES)) {
  if (seenKeys.has(key)) continue;
  const [file, route] = key.split("::");
  findings.push({
    file, line: 0, route, doc: SOURCES[key].doc,
    problem: "stale_registry_entry",
    detail: "registry names a conversion this scan did not find — renamed, moved or deleted",
  });
}

const sortRows = (a, b) => a.file.localeCompare(b.file) || a.line - b.line;
findings.sort(sortRows);
converted.sort(sortRows);
legacy.sort(sortRows);

if (jsonOut) {
  console.log(JSON.stringify({ converted, legacy, findings }, null, 2));
} else {
  const total = converted.length + legacy.length + inherits.length + findings.length;
  console.log(
    `${total} document conversions.\n` +
      `${converted.length} load their SOURCE scoped (the standard).\n` +
      `${inherits.length} INHERIT the source's company on purpose (the shared queue).\n` +
      `${legacy.length} still hold the rule by REFUSAL instead.\n` +
      `${findings.length} problems.\n\n` +
      `A conversion never crosses a company. Since 2026-08-13 that is enforced by\n` +
      `scoping the SOURCE load (scopeToCompany / scopeToCompanyId,\n` +
      `scm/lib/companyScope.ts) rather than by comparing companies afterwards, so\n` +
      `a cross-company source is not visible to the converter at all. The cost is\n` +
      `a worse message on a hand-crafted request ("not found" rather than "belongs\n` +
      `to 2990") — each converted handler states that in its own comment.\n\n` +
      `A NEW CONVERSION MUST BE ADDED TO THE SOURCES REGISTRY in this script,\n` +
      `naming which document it reads by id. There is no default: guessing is what\n` +
      `this audit found people doing, and more than half the guesses were wrong.\n`,
  );
  if (findings.length) {
    console.log("=== PROBLEMS ===");
    let last = "";
    for (const f of findings) {
      if (f.file !== last) { console.log(`\n${f.file}`); last = f.file; }
      console.log(`  L${String(f.line).padEnd(5)} ${f.route}`);
      console.log(`         ${f.problem}: ${f.detail}`);
    }
    console.log("");
  }
  if (inherits.length) {
    console.log("=== INHERIT — crosses the switcher ON PURPOSE, destination takes the SOURCE's company ===");
    let last = "";
    for (const f of inherits) {
      if (f.file !== last) { console.log(`\n${f.file}`); last = f.file; }
      console.log(`  L${String(f.line).padEnd(5)} ${f.route}   ${f.doc ?? ""}`);
      console.log(`         source: ${f.source.join(", ")}  (deliberately NOT scoped to the active company)`);
      console.log(`         ${f.reason}`);
    }
    console.log("");
  }
  if (legacy.length) {
    console.log("=== STILL ON THE REFUSAL MECHANISM ===");
    let last = "";
    for (const f of legacy) {
      if (f.file !== last) { console.log(`\n${f.file}`); last = f.file; }
      console.log(`  L${String(f.line).padEnd(5)} ${f.route}   ${f.doc ?? ""}`);
      console.log(`         ${f.reason}`);
    }
    console.log("");
  }
  console.log("=== SOURCE LOADED SCOPED ===");
  let last = "";
  for (const f of converted) {
    if (f.file !== last) { console.log(`\n${f.file}`); last = f.file; }
    console.log(`  L${String(f.line).padEnd(5)} ${f.route}`);
    console.log(`         source: ${f.source.join(", ")}${f.doc ? `   (${f.doc})` : ""}`);
  }
  console.log(
    `\nNOT a proof of correctness: this checks that the DECLARED source tables are\n` +
      `read through a scope helper, not that the declaration names the right\n` +
      `document. The registry is written by a reader; a handler that declares only\n` +
      `its header and reads its lines unscoped passes here. Declare both — several\n` +
      `of these conversions have a header AND a line entry point, and only reading\n` +
      `them said so.`,
  );
}

process.exit(strict && findings.length ? 1 : 0);
