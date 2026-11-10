#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-public-log-money.mjs — no money in a public Actions log. Exit 1 on a
// violation.
//
// WHY THIS EXISTS. This repository is public, so every Actions run log and
// every uploaded artifact is readable outside the company. On 2026-11-10 the
// "Backfill FIFO ledger divergence (repair)" workflow printed unit costs in RM
// and in sen on two dry-runs (42654976164, 42655293840), and a sweep found
// the same in roughly 150 other scripts a workflow can run. The rule was
// already written down — report-model-merge.mjs's header says "counts and
// product codes only, because this repository's Actions logs are public: no
// document numbers, no money" — and was followed by that one file.
//
// POPULATION. Every top-level backend/scripts/*.mjs that a workflow can run:
// named in a .github/workflows file, or eligible for run-script.yml (which
// runs any script NOT on release-discipline-grandfathered.json). Each one is
// scanned together with the backend/scripts modules it imports, transitively.
//
// RULES (scanner: lib/public-log-money-scan.mjs, rules: lib/public-log-redact.mjs)
//   1. A script whose closure formats money must import
//      ./lib/public-log-guard.mjs as its FIRST import, so the guard is
//      installed before any other module body runs.
//   2. A raw money value printed with no RM / sen / money-named key beside it
//      fails even with the guard, because the guard cannot tell it from a
//      quantity. Label it, or print a count instead.
//
// What it cannot see, said plainly: a template that spans several lines, and
// money in an object printed with console.log whose key is not money-named.
//
// READ-ONLY. Reads files; touches no database and no network.
//
//   node backend/scripts/check-public-log-money.mjs
//   npm --prefix backend run audit:public-log-money
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanSource, importsGuard, localImports } from "./lib/public-log-money-scan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, "..");
const REPO = resolve(BACKEND, "..");
const WORKFLOWS = join(REPO, ".github", "workflows");

// Path (relative to the repo) -> why this file may print a money value.
// "It is only a diagnostic" is not a reason: diagnostics are what leaked.
const ALLOWLIST = new Map([
  ["backend/scripts/lib/public-log-redact.mjs", "holds the redaction self-test probes (sample strings such as RM12.34); prints nothing"],
  ["backend/scripts/lib/public-log-money-scan.mjs", "the scanner's own patterns; prints nothing"],
  ["backend/scripts/check-public-log-money.mjs", "this checker; prints file paths and line numbers only"],
]);

const SELF_TEST = [
  ["const rm = (s) => `RM${(s / 100).toFixed(2)}`;\nconsole.log(rm(x));", ["needs-guard"]],
  ['console.log("total " + "RM " + t);', ["needs-guard"]],
  ["notice(`movement ${s.id}: unit_cost_sen=${s.unit_cost_sen}`);\nconst notice = (m) => console.log(m);", ["needs-guard"]],
  ["const notice = (m) => console.log(m);\nnotice(`stamps to ${st.newTotalCostSen} (was x)`);", ["unlabelled"]],
  ["console.log(`lots=${n} qty=${q}`);", []],
  ["const r = await pg`SELECT ${row.unit_cost_sen}`;", []],
];

function selfTest() {
  for (const [src, want] of SELF_TEST) {
    const got = [...new Set(scanSource(src).map((f) => f.kind))].sort();
    if (JSON.stringify(got) !== JSON.stringify([...want].sort())) {
      console.error(`check-public-log-money: self-test failed on ${JSON.stringify(src)}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}. Refusing to report from a scanner that cannot match.`);
      process.exit(2);
    }
  }
  if (!importsGuard('import "./lib/public-log-guard.mjs";\n')) {
    console.error("check-public-log-money: self-test failed: guard import not recognised.");
    process.exit(2);
  }
}

function dispatchedScripts() {
  const top = readdirSync(HERE).filter((f) => f.endsWith(".mjs"));
  const named = new Set();
  for (const wf of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const text = readFileSync(join(WORKFLOWS, wf), "utf8");
    for (const m of text.matchAll(/(?:^|[\s"'/])scripts\/([\w.-]+\.mjs)/g)) named.add(m[1]);
  }
  const grandfathered = JSON.parse(readFileSync(join(HERE, "release-discipline-grandfathered.json"), "utf8")).scripts ?? {};
  const runScript = existsSync(join(WORKFLOWS, "run-script.yml"));
  if (!runScript) throw new Error("run-script.yml is gone; the population rule above must be re-derived");
  const out = top.filter((f) => named.has(f) || !Object.prototype.hasOwnProperty.call(grandfathered, f));
  return { out, total: top.length };
}

const sourceCache = new Map();
function read(path) {
  if (!sourceCache.has(path)) sourceCache.set(path, readFileSync(path, "utf8"));
  return sourceCache.get(path);
}

function closure(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of localImports(read(file))) {
      const target = resolve(dirname(file), spec);
      if (target.startsWith(HERE) && /\.m?js$/.test(target) && existsSync(target)) stack.push(target);
    }
  }
  return [...seen];
}

function guardIsFirstImport(src) {
  const first = src.match(/^\s*import\s[^\n]*$/m);
  return Boolean(first && importsGuard(first[0]));
}

selfTest();
const { out: population, total } = dispatchedScripts();
if (population.length === 0) {
  console.error("check-public-log-money: population is EMPTY — the workflow/grandfather parse is broken. Refusing to pass.");
  process.exit(2);
}

const violations = [];
const waived = [];
let guarded = 0;
for (const name of population) {
  const entry = join(HERE, name);
  const files = closure(entry);
  const findings = [];
  for (const file of files) {
    const rel = relative(REPO, file).split("\\").join("/");
    if (ALLOWLIST.has(rel)) continue;
    for (const f of scanSource(read(file))) findings.push({ ...f, rel });
  }
  const src = read(entry);
  const hasGuard = importsGuard(src);
  if (hasGuard) guarded++;
  if (findings.some((f) => f.kind === "needs-guard") && !hasGuard) {
    const f = findings.find((x) => x.kind === "needs-guard");
    violations.push(`backend/scripts/${name}: prints money (${f.rel}:${f.line}, ${f.why}) and does not import ./lib/public-log-guard.mjs`);
  } else if (hasGuard && !guardIsFirstImport(src)) {
    violations.push(`backend/scripts/${name}: imports ./lib/public-log-guard.mjs, but not as its FIRST import — a module loaded before it can print unguarded`);
  }
  for (const f of findings.filter((x) => x.kind === "unlabelled")) {
    violations.push(`${f.rel}:${f.line}: ${f.why} (reached from backend/scripts/${name})`);
  }
}

const unique = [...new Set(violations)];
console.log(`check-public-log-money: ${population.length} dispatchable scripts of ${total} in backend/scripts; ${guarded} import the guard; ${ALLOWLIST.size} allowlisted file(s).`);
for (const w of waived) console.log(`  waived: ${w}`);
if (unique.length) {
  console.error(`\n${unique.length} violation(s). This repository's Actions logs and artifacts are public: no money in them.`);
  for (const v of unique) console.error(`  ${v}`);
  console.error("\nFix: put `import \"./lib/public-log-guard.mjs\";` first in the script; label a raw money value (`cost_sen=${x}`, `${x} sen`) or print a count.");
  process.exit(1);
}
console.log("check-public-log-money: OK");
