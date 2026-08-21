#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-shared-mirrors.mjs — find business rules that the FRONTEND and the
// BACKEND disagree about.
//
// WHY. The owner asked, after a run of "why is this field suddenly required"
// bugs: "which rules are not the same on the frontend and the backend?" The
// honest answer is structural, not incidental.
//
// The frontend does NOT import the backend's rule modules — it VENDORS COPIES
// of them (frontend/src/vendor/shared/* and frontend/src/vendor/scm/lib/*
// against backend/src/scm/shared/* and backend/src/scm/lib/*). Some
// of those pairs carry a byte-identical canonical test (phone.ts has
// phone.canonical.test.ts, and it is the reason phone normalisation has never
// drifted). Most do not. A copy with no drift test is a rule with two homes and
// no referee, which is the single mechanism behind this whole class:
//
//   · a variant became mandatory on the frontend that the backend never asked
//     for (SoLineCard's `variantsRequired = true` default vs
//     consignment-orders.ts's `procDate ? ... : []`)
//   · the address rule exists on mobile and in the backend and is absent from
//     the desktop SO form
//
// WHAT IT REPORTS, per pair:
//   IDENTICAL   the two files match byte for byte after normalising line
//               endings. Safe.
//   TESTED      they differ, but a *.canonical.test.ts / drift test names this
//               pair, so CI is already the referee. Read the test, not this.
//   DRIFTED     they differ and NOTHING checks it. These are the answer to the
//               owner's question.
//   BACKEND-ONLY  a rule module with no frontend copy (fine — just inventory).
//
// WHAT IT CANNOT SEE, stated so a clean run is not over-read:
//   - a rule re-implemented on the frontend under a DIFFERENT filename. This
//     compares same-named pairs only; the SoLineCard default and the missing
//     desktop address rule are both of that shape and are invisible here.
//   - whether a difference matters. A vendored copy legitimately drops
//     server-only imports. Read the diff.
//
// Usage:
//   node backend/scripts/check-shared-mirrors.mjs
//   node backend/scripts/check-shared-mirrors.mjs --strict   # exit 1 on DRIFTED
//   node backend/scripts/check-shared-mirrors.mjs --json
//
// NO DEPENDENCIES, so it runs in a worktree with no node_modules.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(backendRoot, "..");
/* BOTH rule directories, not just scm/shared. The frontend vendors from
   `vendor/shared` AND `vendor/scm/lib`, and this side only ever looked at
   scm/shared — so every scm/lib pair (rate-rule-taxonomy, costing-enabled,
   slip) was invisible to the one check whose whole job is finding a rule with
   two homes. Widening it is one line and it immediately picked up three pairs
   that had never been compared. */
const BE_DIRS = [
  path.join(backendRoot, "src", "scm", "shared"),
  path.join(backendRoot, "src", "scm", "lib"),
];
const FE_DIRS = [
  path.join(repoRoot, "frontend", "src", "vendor", "shared"),
  path.join(repoRoot, "frontend", "src", "vendor", "scm", "lib"),
];
const strict = process.argv.includes("--strict");
const jsonOut = process.argv.includes("--json");

const isRule = (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts";
const norm = (s) => s.replace(/\r\n/g, "\n").trimEnd();

/** Every test file anywhere that could be refereeing a pair. */
function allTests() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(full); }
      else if (/\.test\.tsx?$/.test(e.name)) out.push({ name: e.name, text: fs.readFileSync(full, "utf8") });
    }
  };
  walk(path.join(repoRoot, "frontend", "src"));
  walk(path.join(backendRoot, "src"));
  walk(path.join(backendRoot, "tests"));
  return out;
}
const TESTS = allTests();

/* A pair is refereed when some test mentions BOTH the shared module's name and
   a cross-tree path — that is what phone.canonical.test.ts does when it reads
   `../backend/src/scm/shared/phone.ts` and asserts byte-identity. */
function refereed(base) {
  return TESTS.some(
    (t) =>
      t.text.includes(`shared/${base}.ts`) &&
      /vendor\/shared|vendor\/scm\/lib|backend\/src\/scm\/shared/.test(t.text) &&
      /readFileSync|toBe\(|toEqual\(/.test(t.text),
  );
}

/* Extract each exported function's BODY, keyed by name.
   Whole-file diffing is the wrong measure and says so in three ways here:
   the frontend copy of so-variant-rule is a SUPERSET (it adds hasSofaMixConflict),
   free-item-campaign is a documented SLICE (one predicate of six exports), and
   most copies differ only in a vendoring header. None of those is a rule
   disagreement. What matters is: of the functions BOTH files define, does any
   one of them BEHAVE differently? */
const clean = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();

/** Balanced slice starting at `openIdx`, for the bracket pair at that index. */
function balanced(text, openIdx) {
  const open = text[openIdx];
  const close = open === "{" ? "}" : open === "[" ? "]" : ")";
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) { depth--; if (depth === 0) return text.slice(openIdx, i + 1); }
  }
  return null;
}

/* Index of the `{` that opens a function BODY, skipping a RETURN-TYPE
   ANNOTATION that itself contains braces.

   `text.indexOf("{", afterName)` was the whole of this, and it is wrong for
   every function whose return type carries a brace. `rulesByCategory(): Array<{
   category: RateRuleCategory; types: RateRuleType[] }>` sliced the TYPE and
   never reached the body — so the pair reported DIVERGED because one side's
   type alias is spelled `RateRuleTypeT`, while two genuinely different bodies
   under one identical annotation would have read COSMETIC. Both directions are
   wrong and the second is the dangerous one: a verdict computed over the wrong
   text must never read as a pass.

   A `{` that OPENS A TYPE is always preceded by `:`, `<`, `(`, `,`, `|`, `&` or
   `=>`; a `{` that opens a BODY is preceded by `)`, `>`, `]`, `}` or an
   identifier. Skip the former (balanced), return the latter. */
function bodyStart(text, from) {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let j = i - 1;
    while (j >= 0 && /\s/.test(text[j])) j--;
    const prev = text[j];
    const isArrow = prev === ">" && text[j - 1] === "=";
    if (isArrow || prev === ":" || prev === "<" || prev === "(" || prev === "," || prev === "|" || prev === "&") {
      const grp = balanced(text, i);
      if (!grp) return -1;
      i += grp.length - 1;
      continue;
    }
    return i;
  }
  return -1;
}

function exportedBodies(text) {
  const out = new Map();

  // 1. export function foo(...) { ... }  /  export async function foo(...)
  for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const paren = m.index + m[0].length - 1;
    const params = balanced(text, paren);
    const open = params === null ? -1 : bodyStart(text, paren + params.length);
    const body = open === -1 ? null : balanced(text, open);
    if (body) out.set(m[1], clean(body));
  }

  /* 2. export const foo = (...) => { ... }  |  => expr  |  = <literal>
        THIS BRANCH WAS MISSING and the omission made the check WORSE THAN
        USELESS: nine of thirteen pairs reported "shared:0", i.e. the comparison
        found no common function at all, and the script printed COSMETIC —
        "every shared function is identical" — about an empty set. so-field-policy
        (392 vs 216 lines) and payment-methods (80 vs 33) both passed that way.
        A verdict computed over nothing must never read as a pass. */
  /* `\s*` BEFORE the `=` — its absence is why this branch matched only
     TYPE-ANNOTATED consts. `export const X: T = …` matched (the annotation ate
     the space); `export const fmtMoney = (n) => …` did NOT, because the pattern
     demanded `fmtMoney=` with no gap. So `format` and `maintenance-pools`
     reported NO-OVERLAP while sharing 8 and 9 exported symbols.

     THIRD dead pattern in this repo's checkers in one day. The other two had a
     startup self-test; THIS FILE HAD NONE — which is why it shipped. One is
     added below, and it deliberately exercises the form the pattern is most
     likely to MISS (the un-annotated arrow), not the form it was written
     against. A self-test that only asserts the case you had in mind is a self-
     test that passes for the same reason the bug exists. */
  for (const m of text.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*/g)) {
    const at = m.index + m[0].length;
    const arrow = text.slice(at).match(/^(?:async\s*)?\([^)]*\)\s*(?::[^=]*?)?=>\s*/);
    let body = null;
    if (arrow) {
      const after = at + arrow[0].length;
      body = text[after] === "{" ? balanced(text, after) : text.slice(after, text.indexOf("\n;", after) + 1 || undefined).split(/;\s*\n/)[0];
    } else if (text[at] === "{" || text[at] === "[") {
      body = balanced(text, at);
    } else {
      body = text.slice(at).split(/;\s*(?:\n|$)/)[0];
    }
    if (body) out.set(m[1], clean(body));
  }
  return out;
}

/* SELF-TEST. This file previously had none, and that is exactly how it shipped
   a pattern that extracted only TYPE-ANNOTATED consts — so nine of thirteen
   pairs compared ZERO functions and the script printed "every shared function
   is identical" about an empty set. Refuse to report from a pattern that cannot
   see the forms this codebase actually writes. */
{
  const seen = exportedBodies(
    "export const fmtMoney = (n: number): string => `RM${n}`;\n" +
      "export const writeFailed = (e: unknown): void => { void e; };\n" +
      "export const CORE: readonly string[] = ['a'];\n" +
      "export function plain(a) { return a; }\n" +
      "export async function later(a) { return a; }\n",
  );
  const missing = ["fmtMoney", "writeFailed", "CORE", "plain", "later"].filter((k) => !seen.has(k));
  if (missing.length) {
    console.error(
      `check-shared-mirrors: self-test FAILED - these exports were not extracted: ${missing.join(", ")}. Not reporting.`,
    );
    process.exit(2);
  }
  /* THE RETURN TYPE THAT CARRIES A BRACE. This is the form the extractor was
     silently getting wrong, so it is asserted directly: what comes back must be
     the BODY, and two functions whose bodies agree must compare equal even when
     their return-type aliases are spelled differently. Without this probe the
     comparison happily reports on a type annotation and calls it behaviour. */
  const braced = (t) =>
    exportedBodies(`export function rulesByCategory(): Array<{ category: C; types: ${t}[] }> {\n  return LIST.filter((x) => x.ok);\n}\n`).get("rulesByCategory");
  if (!braced("A") || !/return LIST\.filter/.test(braced("A"))) {
    console.error("check-shared-mirrors: self-test FAILED - a braced RETURN TYPE was sliced instead of the function body. Not reporting.");
    process.exit(2);
  }
  if (braced("A") !== braced("B")) {
    console.error("check-shared-mirrors: self-test FAILED - two identical bodies compared unequal because their return-type aliases differ. Not reporting.");
    process.exit(2);
  }
}

const rows = [];
for (const { dir: BE, name: f } of BE_DIRS.flatMap((d) => fs.readdirSync(d).filter(isRule).map((name) => ({ dir: d, name })))) {
  const base = f.replace(/\.ts$/, "");
  const beText = norm(fs.readFileSync(path.join(BE, f), "utf8"));
  const feHit = FE_DIRS.map((d) => path.join(d, f)).find((p) => fs.existsSync(p));
  if (!feHit) { rows.push({ base, status: "BACKEND-ONLY" }); continue; }
  const feText = norm(fs.readFileSync(feHit, "utf8"));
  const fe = path.relative(repoRoot, feHit).split(path.sep).join("/");
  if (beText === feText) { rows.push({ base, fe, status: "IDENTICAL" }); continue; }

  const beFn = exportedBodies(beText);
  const feFn = exportedBodies(feText);
  const shared = [...beFn.keys()].filter((k) => feFn.has(k));
  /* An EXPLAINED divergence is silenced with `mirror-ok: <fn> - <reason>` in the
     FRONTEND copy. Deliberately per-function and deliberately not a loosening of
     the comparison: cellEdges differs only by an `| undefined` annotation that
     the vendored file already explains (2990's tsconfig sets
     noUncheckedIndexedAccess and Houzs's does not), and stripping type
     annotations to hide it would also hide a real signature change. Naming the
     function is the cost of the exemption. */
  const differing = shared
    .filter((k) => beFn.get(k) !== feFn.get(k))
    .filter((k) => !new RegExp(`mirror-ok:\\s*${k}\\b`).test(feText));

  rows.push({
    base,
    fe,
    beLines: beText.split("\n").length,
    feLines: feText.split("\n").length,
    shared: shared.length,
    differing,
    /* DIVERGED is the only bucket that answers "the two sides disagree about a
       rule". COSMETIC means every function they share behaves identically and
       the files differ only in headers / extra or omitted exports. */
    /* NO-OVERLAP is its own verdict, never folded into COSMETIC. Two files that
       share zero exported symbols have not been compared at all, and saying
       "every shared function is identical" about an empty set is the exact way
       a checker lies while looking clean. */
    status: differing.length
      ? (refereed(base) ? "TESTED" : "DIVERGED")
      : shared.length === 0 ? "NO-OVERLAP" : "COSMETIC",
  });
}

const order = { DIVERGED: 0, TESTED: 1, "NO-OVERLAP": 2, COSMETIC: 3, IDENTICAL: 4, "BACKEND-ONLY": 5 };
rows.sort((a, b) => order[a.status] - order[b.status] || a.base.localeCompare(b.base));
const diverged = rows.filter((r) => r.status === "DIVERGED");

if (jsonOut) {
  console.log(JSON.stringify({ rows, diverged }, null, 2));
} else {
  const count = (s) => rows.filter((r) => r.status === s).length;
  console.log(
    `${rows.length} rule modules in backend/src/scm/shared + backend/src/scm/lib.\n` +
      `  ${count("DIVERGED")} DIVERGED     a function BOTH sides define behaves differently. THE ANSWER.\n` +
      `  ${count("TESTED")} TESTED       diverges, but a drift test referees the pair\n` +
      `  ${count("NO-OVERLAP")} NO-OVERLAP   share ZERO exported symbols - NOT compared, read by hand\n` +
      `  ${count("COSMETIC")} COSMETIC     files differ (header / extra / omitted exports) but every\n` +
      `               shared function is byte-identical after stripping comments\n` +
      `  ${count("IDENTICAL")} IDENTICAL    whole file matches\n` +
      `  ${count("BACKEND-ONLY")} BACKEND-ONLY no frontend copy\n` +
      `\nSAME-NAMED pairs only. A rule re-implemented on the frontend under\n` +
      `another name is invisible here - read the header.\n`,
  );
  for (const r of rows) {
    if (r.status === "BACKEND-ONLY" || r.status === "IDENTICAL") continue;
    const fns = r.differing?.length ? `  [${r.differing.join(", ")}]` : "";
    console.log(`  ${r.status.padEnd(9)} ${r.base.padEnd(24)} shared:${String(r.shared).padEnd(3)} be:${r.beLines} fe:${r.feLines}${fns}`);
  }
}

process.exit(strict && diverged.length ? 1 : 0);
