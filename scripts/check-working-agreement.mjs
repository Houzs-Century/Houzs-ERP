#!/usr/bin/env node
/**
 * Gate: the four MANDATORY owner rules in CLAUDE.md, enforced on a pull request.
 *
 *   1. A PR that reads as a FIX and changes code must add a BUG-HISTORY.md entry.
 *   2. A PR that changes a module SURFACE must update that module's guide.
 *   3. A PR that touches backend/src/db/migrations-pg must state, in its body,
 *      how the migration is REVERSED and what it was VERIFIED AGAINST.
 *   4. A PR that says running something will FIX/RECOVER something must show
 *      what happened when it was run, or mark the claim UNTESTED.
 *
 * Escapes are labels, and a label does not make the gate quiet: it prints the
 * violation it is waiving, at ESCAPE level, so the exception lands in the log
 * instead of in nobody's memory.
 *
 * Usage:
 *   node scripts/check-working-agreement.mjs                 # CI: reads GITHUB_EVENT_PATH + git
 *   node scripts/check-working-agreement.mjs --pr 2118       # local: reads the PR through gh
 *   node scripts/check-working-agreement.mjs --patch f.diff --title "..." --body-file b.md --labels a,b
 *
 * Exit: 0 clean (warnings included), 1 violation, 2 the check itself is broken.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUG_HISTORY_PATH,
  MODULE_GUIDE_DIR,
  buildModuleIndex,
  evaluate,
  parseUnifiedDiff,
} from "./lib/working-agreement.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_PATH = ".github/pull_request_template.md";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};

const die = (message) => {
  console.error(`\nSELF-CHECK FAILED: ${message}`);
  console.error("This gate cannot answer, so it must not report a pass.\n");
  process.exit(2);
};

const sh = (cmd, args) =>
  execFileSync(cmd, args, { cwd: REPO, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

// --------------------------------------------------------------------------
// Gather the repository side, and refuse to run if the scan finds nothing.
// A scanner pointed at a moved directory otherwise passes in silence.
// --------------------------------------------------------------------------
const guideDir = path.join(REPO, MODULE_GUIDE_DIR);
if (!fs.existsSync(guideDir)) die(`${MODULE_GUIDE_DIR} does not exist at ${REPO}.`);
const guides = fs
  .readdirSync(guideDir)
  .filter((f) => f.endsWith(".md"))
  .map((name) => ({ name, text: fs.readFileSync(path.join(guideDir, name), "utf8") }));
if (guides.length === 0) die(`${MODULE_GUIDE_DIR} contains no *.md guides.`);

const probe = buildModuleIndex(guides);
if (probe.mentions === 0) {
  die(
    `${guides.length} module guides were read and NOT ONE quotes a backend/ or frontend/ source path. ` +
      `The path->module index would be empty and every surface change would pass unnoticed.`,
  );
}

if (!fs.existsSync(path.join(REPO, BUG_HISTORY_PATH))) die(`${BUG_HISTORY_PATH} is missing at the repo root.`);
if (!fs.existsSync(path.join(REPO, TEMPLATE_PATH)))
  die(`${TEMPLATE_PATH} is missing — body scanning would fire on every PR that uses the template.`);
const templateBody = fs.readFileSync(path.join(REPO, TEMPLATE_PATH), "utf8");

// --------------------------------------------------------------------------
// Gather the pull-request side.
// --------------------------------------------------------------------------
let title = flag("title");
let body = flag("body-file") ? fs.readFileSync(flag("body-file"), "utf8") : flag("body");
let branch = flag("branch") || "";
let labels = flag("labels") ? flag("labels").split(",").map((s) => s.trim()).filter(Boolean) : null;
let patch = flag("patch") ? fs.readFileSync(flag("patch"), "utf8") : null;
let source = "flags";

const pr = flag("pr");
if (pr) {
  source = `gh pr ${pr}`;
  const meta = JSON.parse(
    sh("gh", ["pr", "view", pr, "--json", "title,body,headRefName,labels,number"]),
  );
  title = title ?? meta.title;
  body = body ?? meta.body ?? "";
  branch = branch || meta.headRefName || "";
  labels = labels ?? meta.labels.map((l) => l.name);
  patch = patch ?? sh("gh", ["pr", "diff", pr]);
} else if (!patch && process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const p = event.pull_request;
  if (!p) die("GITHUB_EVENT_PATH carries no pull_request. This gate only runs on pull_request events.");
  source = `event payload, PR #${p.number}`;
  title = title ?? p.title;
  body = body ?? p.body ?? "";
  branch = branch || p.head?.ref || "";
  labels = labels ?? (p.labels || []).map((l) => l.name);
  const base = p.base?.ref || "main";
  // Explicit refspec, not `git fetch origin main`: actions/checkout configures a
  // NARROW remote.origin.fetch (just the PR ref), so the bare form leaves
  // refs/remotes/origin/<base> unwritten and the diff below resolves nothing.
  // An empty diff is the silent pass this gate exists to prevent, so any
  // failure here is fatal rather than caught.
  try {
    sh("git", ["fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    // Three-dot: merge-base(origin/<base>, HEAD) to HEAD — exactly what this PR
    // changed, whether HEAD is the branch tip or the pull_request merge ref.
    patch = sh("git", ["diff", "--no-color", `origin/${base}...HEAD`]);
  } catch (err) {
    die(`could not resolve this PR's diff against origin/${base}: ${err.message}`);
  }
}

if (patch === null) die("No diff to read. Pass --pr, --patch, or run inside a pull_request workflow.");
if (title === null || title === undefined) die("No PR title to read.");
labels = labels ?? [];
body = body ?? "";

const files = parseUnifiedDiff(patch);
if (files.length === 0) {
  die(
    `The diff parsed to ZERO changed files (source: ${source}, ${patch.length} bytes). ` +
      `A pull request always changes something; an empty scan means the diff was not found, not that the PR is clean.`,
  );
}

// --------------------------------------------------------------------------
// Report.
// --------------------------------------------------------------------------
const result = evaluate({ title, branch, body, labels, templateBody, files, guides });

const ICON = { pass: "PASS  ", fail: "FAIL  ", warn: "WARN  ", escape: "ESCAPE", info: "info  " };
const out = [];
const say = (line) => {
  out.push(line);
  console.log(line);
};

say("");
say("Working agreement gate — CLAUDE.md's four MANDATORY owner rules");
say(`  source           ${source}`);
say(`  title            ${title}`);
say(`  branch           ${branch || "(unknown)"}`);
say(`  labels           ${labels.length ? labels.join(", ") : "(none)"}`);
say(`  files changed    ${result.summary.files} (${result.summary.codeFiles} under backend/frontend code)`);
say(`  module index     ${result.summary.guideCount} guides, ${result.summary.guideMentions} quoted paths, ${result.summary.mappedPaths} distinct files mapped`);
say(`  surface changes  ${result.summary.surfaces.length} file(s)`);
say(`  migrations-pg    ${result.summary.migrations} file(s)`);
say("");

/* The order is fixed for readable output, but the list is NOT the source of
   truth for what gets printed — anything the evaluator emitted under a rule
   this file has not heard of is appended rather than dropped.

   That is not defensive styling. Adding rule 4 to the evaluator while this
   array still read ["bug-history", "module-guide", "migration-notes"] produced
   a gate that counted "1 violation(s)", exited 1, and printed NOT ONE WORD
   about what the violation was. CLAUDE.md calls this shape "the check that is
   not running": a finding nobody renders is a finding nobody has. */
const RULE_ORDER = ["bug-history", "module-guide", "migration-notes", "remedy-claim"];
const seen = new Set(RULE_ORDER);
const rules = [...RULE_ORDER, ...result.findings.map((f) => f.rule).filter((r) => !seen.has(r) && !seen.add(r))];
for (const rule of rules) {
  for (const f of result.findings.filter((x) => x.rule === rule)) {
    say(`${ICON[f.level]} [${f.rule}] ${f.message}`);
    if (f.detail) say(`    ${f.detail}`);
  }
}
say("");

const fails = result.findings.filter((f) => f.level === "fail").length;
const warns = result.findings.filter((f) => f.level === "warn").length;
const escapes = result.findings.filter((f) => f.level === "escape").length;
say(
  result.ok
    ? `Working agreement: OK (${warns} warning(s), ${escapes} escape(s) used)`
    : `Working agreement: ${fails} violation(s), ${warns} warning(s), ${escapes} escape(s) used`,
);
say("");

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Working agreement\n\n\`\`\`\n${out.join("\n")}\n\`\`\`\n`,
  );
}

process.exit(result.ok ? 0 : 1);
