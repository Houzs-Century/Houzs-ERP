#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-conversion-guards.mjs — a document conversion NEVER crosses a company.
//
// THE INVARIANT, stated once so it stops being re-derived per route:
//
//     A converter reads a SOURCE document by id and writes a NEW document from
//     it. If it does not compare the source's company_id to the active company,
//     it silently RE-PARENTS money: the source company's goods, revenue or
//     liability land in the other company's books, under the other company's
//     document number, and nothing on screen says so.
//
// That is not a per-route judgement call. It is the same rule every ERP applies
// to every conversion, and this repo already believed it — `companyScope.ts`
// carries `isCrossCompanySource` + `crossCompanyConversionBlocked` and FOUR
// conversions used them (SO->DO, SO->SI, DO->SI, PO->GRN).
//
// WHY THIS SCRIPT EXISTS. On 2026-08-13 a module sweep found SEVEN MORE
// conversions that used neither:
//
//     DO->SI (the PARTIAL form)    a 2990 delivery folded into a Houzs invoice;
//                                  postSiRevenue then posted 2990's revenue to
//                                  Houzs' books
//     DO->DR                       a 2990 delivery returned as a HOUZS return,
//                                  Houzs doc number, stock written back to the
//                                  wrong ledger
//     SO->PO                       a HOUZS purchase order + supplier commitment
//                                  minted from a 2990 SO line
//     GRN->PI, GRN->PR             a receipt re-companied into this company's
//                                  AP; stock drawn OUT of the other company's
//                                  warehouse under this company's refund
//     PCO->PC-receive              receiving the other company's consignment
//     PC-receive->PC-return        returning the other company's consigned goods
//
// Four guarded, seven unguarded, and NOTHING IN THE CODE SAID WHICH WAS WHICH.
// The company-scope checker could not see them either: a converter usually
// scopes its own destination document perfectly well, so it looks scoped. What
// it fails to scope is the SOURCE.
//
// So the fix is not seven patches. It is this: the invariant is now mechanical,
// and a new converter cannot ship without it.
//
// WHAT IT CHECKS. Every route whose PATH declares a conversion — `/from-x`,
// `/convert-from-x`, `/:id/items/from-x/:y` — must reference
// `isCrossCompanySource` inside its handler, or delegate to a function that
// does. Paths are the signal because this codebase names conversions
// consistently and has done since the SCM import; a converter that hides behind
// a non-conversion path name is out of reach here and belongs to a reader.
//
// WHAT IT DOES NOT CHECK: whether the guard is applied to the RIGHT document.
// A handler that guards the header and forgets the per-line source passes here.
// Two of the seven above needed both, and only reading them told us so.
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

/* A path that DECLARES a conversion. Anchored on the segment, so `/from-sos`,
   `/from-grn-items`, `/:id/convert-from-so` and `/:id/items/from-do/:doId` all
   match while `/informations` does not. */
const CONVERSION_PATH = /(^|\/)(from-[a-z0-9-]+|convert-from-[a-z0-9-]+)(\/|$)/;
const HANDLER =
  /^\s*[A-Za-z_$][\w$]*\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`](\/[^'"`]*)['"`]/;
/* `crossCompanySourceRefusal` is THE primitive — one shared implementation of
   the invariant, in scm/lib/companyScope.ts. `isCrossCompanySource` is its
   lower-level half, still used directly by a few handlers that already hold the
   source row and need no second load; both count.

   This pattern itself had to be corrected the moment the three duplicate
   implementations were collapsed into the primitive: it named only the OLD
   helper, so unifying the rule made this script report the unified handlers as
   UNGUARDED. A checker keyed to a name breaks when the name is improved — which
   is an argument for having exactly one name, not for leaving three. */
const GUARD = /crossCompanySourceRefusal|isCrossCompanySource/;
/* A converter may hand the work to a shared core (convertSosToPosCore,
   convertDoLinesToReturn). Naming the delegate in the registration line is
   enough IF that delegate itself guards — checked below by resolving it. */
const NAMED_DELEGATE =
  /^\s*[A-Za-z_$][\w$]*\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"`][^'"`]*['"`]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/;
const OPT_OUT = /conversion-guard-ok:/;

/* SELF-TEST. Three checkers in this repo have reported a clean run from a
   pattern that could not match. Assert before scanning; refuse to report from a
   dead one. */
{
  const t = (s) => { CONVERSION_PATH.lastIndex = 0; return CONVERSION_PATH.test(s); };
  const ok =
    t("/from-sos") && t("/from-grn-items") && t("/:id/convert-from-so") &&
    t("/:id/items/from-do/:doId") &&
    !t("/informations") && !t("/:id/items") && !t("/deliverable-so-lines") &&
    HANDLER.test("purchaseReturns.post('/from-grn', async (c) => {") &&
    NAMED_DELEGATE.exec("deliveryReturns.post('/from-do', convertDoLinesToReturn)")?.[1] === "convertDoLinesToReturn" &&
    GUARD.test("if (isCrossCompanySource(dh.company_id, c)) {") &&
    GUARD.test("await crossCompanySourceRefusal(sb, c, table, ids, col);");
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
const guarded = [];

for (const dir of ROUTE_DIRS) {
  if (!fs.existsSync(dir)) continue;
  const relDir = path.relative(backendRoot, dir).split(path.sep).join("/");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const raw = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
    const lines = stripComments(raw);

    /* Resolve a named callee by scanning the WHOLE file for its body — a
       converter that delegates is guarded iff its delegate is.

       ONE LEVEL, and the indirection is not hypothetical: grns.ts wraps the
       whole rule in a file-local `firstCrossCompanyPo` that batch-loads the POs
       and returns the refusal, and mfg-purchase-orders routes two different URLs
       through `convertSosToPosCore`. Both ARE guarded; a body-text scan calls
       them naked. That false positive is the reason the first run of this script
       reported seven gaps that included four correct handlers — the same
       "reports a plausible wrong number" failure every other checker here has
       produced at least once. */
    /* RECURSIVE, bounded at 3 hops and cycle-safe. One level was not enough:
       delivery-returns registers `/from-do` on `convertDoLinesToReturn`, which
       calls `crossCompanyDoSourceBlocked`, which calls the shared primitive —
       three hops. A one-level resolver called that handler unguarded, which is
       the same false-negative-inverted failure every checker here has produced:
       a confident number that is simply wrong. */
    const delegateGuards = (name, depth = 0, seenFns = new Set()) => {
      if (depth > 3 || seenFns.has(name)) return false;
      seenFns.add(name);
      const decl = new RegExp(`(?:async\\s+function|function|const)\\s+${name}\\b`);
      const start = lines.findIndex((l) => decl.test(l));
      if (start === -1) return false;
      let braces = 0, opened = false;
      const bodyLines = [];
      for (let i = start; i < lines.length; i++) {
        const l = lines[i] ?? "";
        bodyLines.push(l);
        if (GUARD.test(l)) return true;
        for (const ch of l) {
          if (ch === "{") { braces++; opened = true; }
          else if (ch === "}") braces--;
        }
        if (opened && braces <= 0) break;
      }
      const inner = [...new Set(
        [...bodyLines.join("\n").matchAll(/\b([a-z][A-Za-z0-9_]{4,})\s*\(/g)].map((x) => x[1]),
      )];
      return inner.some((fn) => delegateGuards(fn, depth + 1, seenFns));
    };

    for (let i = 0; i < lines.length; i++) {
      const m = HANDLER.exec(lines[i] ?? "");
      if (!m) continue;
      const [, method, routePath] = m;
      if (!CONVERSION_PATH.test(routePath)) continue;
      if (method.toLowerCase() === "get") continue; // a picker READ is not a conversion

      // Body: from here to the next handler registration, or 400 lines.
      let end = lines.length;
      for (let j = i + 1; j < Math.min(i + 400, lines.length); j++) {
        if (HANDLER.test(lines[j] ?? "")) { end = j; break; }
      }
      const body = lines.slice(i, end).join("\n");
      const rawBody = raw.slice(i, end).join("\n");

      /* Guarded if the rule is in the body, in a named delegate on the
         registration line, or in ANY same-file function the body calls. The
         last is what catches firstCrossCompanyPo / convertSosToPosCore. */
      const delegate = NAMED_DELEGATE.exec(lines[i] ?? "")?.[1];
      const calledInBody = [...new Set(
        [...body.matchAll(/\b([a-z][A-Za-z0-9_]{4,})\s*\(/g)].map((x) => x[1]),
      )];
      const isGuarded =
        GUARD.test(body) ||
        (delegate ? delegateGuards(delegate) : false) ||
        calledInBody.some((fn) => delegateGuards(fn));
      const via = GUARD.test(body)
        ? null
        : (delegate && delegateGuards(delegate) ? delegate
          : calledInBody.find((fn) => delegateGuards(fn)) ?? null);
      const row = {
        file: `backend/${relDir}/${file}`,
        line: i + 1,
        route: `${method.toUpperCase()} ${routePath}`,
        via,
      };
      if (isGuarded) guarded.push(row);
      else if (OPT_OUT.test(rawBody)) guarded.push({ ...row, via: "opt-out" });
      else findings.push(row);
    }
  }
}

const sortRows = (a, b) => a.file.localeCompare(b.file) || a.line - b.line;
findings.sort(sortRows);
guarded.sort(sortRows);

if (jsonOut) {
  console.log(JSON.stringify({ guarded, findings }, null, 2));
} else {
  console.log(
    `${guarded.length + findings.length} document conversions.\n` +
      `${findings.length} do NOT compare the SOURCE document's company.\n\n` +
      `A conversion that skips this re-parents money silently: the source\n` +
      `company's goods, revenue or liability land in the other company's books\n` +
      `under the other company's document number. Guard with\n` +
      `isCrossCompanySource + crossCompanyConversionBlocked (scm/lib/companyScope.ts),\n` +
      `or annotate a verified-safe one with "// conversion-guard-ok: <reason>".\n`,
  );
  if (findings.length) {
    console.log("=== UNGUARDED ===");
    let last = "";
    for (const f of findings) {
      if (f.file !== last) { console.log(`\n${f.file}`); last = f.file; }
      console.log(`  L${String(f.line).padEnd(5)} ${f.route}`);
    }
  }
  console.log("\n=== GUARDED ===");
  let last = "";
  for (const f of guarded) {
    if (f.file !== last) { console.log(`\n${f.file}`); last = f.file; }
    console.log(`  L${String(f.line).padEnd(5)} ${f.route}${f.via ? `   via ${f.via}` : ""}`);
  }
  console.log(
    `\nNOT a proof of correctness: this checks that the guard is PRESENT, not\n` +
      `that it is applied to the right document. Two of the seven gaps found on\n` +
      `2026-08-13 needed the header AND the per-line source, and only reading\n` +
      `them said so.`,
  );
}

process.exit(strict && findings.length ? 1 : 0);
