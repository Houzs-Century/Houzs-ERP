#!/usr/bin/env node
// Verify that every repo path a document cites actually exists.
//
// WHY. The owner, 2026-08-12: "你做的指南我都不相信了." Correct instinct, and
// "trust nothing" is as useless as "trust everything" because it tells you
// nothing about where to look. Documentation claims split in two:
//
//   - mechanically checkable — "it lives in backend/src/scm/lib/x.ts", "pinned
//     by y.test.ts", "migration 0277". These are most of a module guide by
//     volume, and a script can settle every one of them.
//   - not checkable — cause, dates, why a thing was designed that way. Those
//     need a cited command instead (see CLAUDE.md, "Do not guess").
//
// This handles the first kind, so the distrust can be aimed at the second.
//
// It reports MISSING references only. It cannot tell you a guide is WRONG about
// behaviour — a real path can sit beside a false claim. Do not read a clean run
// as "the docs are correct"; read it as "the docs are not pointing at files that
// no longer exist", which is a different and smaller statement.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const failOnFindings = process.argv.includes("--strict");
const jsonOut = process.argv.includes("--json");

// Docs that describe a PAST state on purpose. A dead path in these is the point,
// not a defect. Keep this list short and justified — it is an excuse list.
// Dated records. An entry describes the tree AS IT WAS; a later rename does not
// make the entry wrong. Counted and shown, but never a failure.
const DATED = new Set(["BUG-HISTORY.md"]);

const HISTORICAL = new Set([
  "MIGRATION-D1-TO-SUPABASE.md",
  "HANDOFF-supabase-cutover.md",
  "docs/autocount-cutover-ledger.md",
  "docs/autocount-migration-record.md",
  "docs/MIGRATION-RETIREMENTS.md",
  "docs/autocount-line-retirement-plan.md",
  "docs/FRAGMENTATION-MAP.md",
]);

const TOP_DIRS = ["backend", "frontend", "docs", "e2e", "mail-sync", ".github", "tasks", "reference", "native", "scripts"];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

const docFiles = [
  ...walk(path.join(repoRoot, "docs")),
  ...walk(path.join(repoRoot, "tasks")),
  ...fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => path.join(repoRoot, e.name)),
];

// A citation is inside backticks and looks like a repo path: it contains a
// slash and either starts at a known top-level directory or carries a source
// extension. Prose like `some/thing` without an extension is ignored — the goal
// is a low false-positive rate, because a checker that cries wolf gets muted and
// then rots, which is the failure this repo just spent a day on.
const CITATION = /`([^`\n]+)`/g;
const SOURCE_EXT = /\.(ts|tsx|mjs|js|sql|json|toml|yml|yaml|css|html)$/;

// Docs cite paths relative to whichever root the reader is standing in —
// `middleware/auth.ts` means backend/src/middleware/auth.ts, `api/client.ts`
// means frontend/src/api/client.ts. A checker that demands repo-root paths
// reports 1,511 "missing" files that all exist, gets muted, and rots. Resolve
// against the roots the codebase actually uses.
const ROOTS = [
  "",
  "backend/src/",
  "frontend/src/",
  "backend/",
  "frontend/",
  "backend/src/scm/",
  "frontend/src/vendor/",
  "e2e/",
];

function resolveRef(cleaned) {
  for (const r of ROOTS) {
    if (fs.existsSync(path.join(repoRoot, r + cleaned))) return r + cleaned;
  }
  return null;
}

function looksLikePath(raw) {
  const s = raw.trim().replace(/^\.\//, "");
  if (!s.includes("/")) return null;
  if (/\s/.test(s)) return null;
  if (/^https?:/.test(s)) return null;
  if (s.startsWith("/")) return null; // a URL path (/sw.js, /privacy/index.html), not a repo file
  if (s.startsWith("apps/")) return null; // the 2990 / POS repo, not this tree
  const cleaned = s.replace(/[:#].*$/, "").replace(/[.,;)]+$/, "");
  if (!cleaned) return null;
  if (cleaned.includes("*")) return null; // glob, not a claim about one file
  // A branch name (`docs/staging-truth-and-map-refresh`, `fix/po-key-snapshot`)
  // is shaped exactly like a path. Only claim it IS one when it carries a source
  // extension, or when it resolves to a real directory.
  if (!SOURCE_EXT.test(cleaned)) {
    for (const r of ROOTS) {
      const full = path.join(repoRoot, r + cleaned);
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return cleaned;
    }
    return null;
  }
  return cleaned;
}

const findings = [];
let checked = 0;
const perDoc = new Map();

for (const file of docFiles) {
  const rel = path.relative(repoRoot, file).replaceAll("\\", "/");
  if (HISTORICAL.has(rel)) continue;
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(CITATION)) {
      const p = looksLikePath(m[1]);
      if (!p) continue;
      checked++;
      perDoc.set(rel, (perDoc.get(rel) ?? 0) + 1);
      if (!resolveRef(p)) {
        findings.push({ doc: rel, line: i + 1, ref: p, dated: DATED.has(rel) });
      }
    }
  });
}

if (jsonOut) {
  console.log(JSON.stringify({ checked, missing: findings.length, findings, perDoc: Object.fromEntries(perDoc) }, null, 2));
} else {
  const byDoc = new Map();
  for (const f of findings) {
    if (!byDoc.has(f.doc)) byDoc.set(f.doc, []);
    byDoc.get(f.doc).push(f);
  }
  const live = findings.filter((f) => !f.dated);
  const dated = findings.filter((f) => f.dated);
  console.log(
    `Checked ${checked} cited repo paths across ${docFiles.length} documents.
` +
      `${live.length} in CURRENT docs point at files that do not exist  <- these are defects
` +
      `${dated.length} in dated ledgers (${[...DATED].join(", ")}) — recorded, not defects`,
  );
  for (const [doc, list] of [...byDoc]
    .filter(([d]) => !DATED.has(d))
    .sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${doc}  (${list.length})`);
    for (const f of list) console.log(`  L${f.line}  ${f.ref}`);
  }
}

process.exit(failOnFindings && findings.some((f) => !f.dated) ? 1 : 0);
