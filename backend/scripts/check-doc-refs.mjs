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
//
// A PREDICATE, not a name list, since 2026-08-20: the bug ledger became a
// directory of one file per entry (docs/bugs/, see its README). Every one of those
// files is the same dated record BUG-HISTORY.md was, and listing every one of them
// by name would be a list nobody maintains. Measured on the split: the ledger
// contributes 10 dead-path citations, every one an entry RECORDING a deletion, and
// without this they turn from `dated` into `defect` and take `audit:doc-refs
// --strict` red on a corpus nobody changed.
//
// TWO EXACT CARVE-OUTS, because a prefix alone is wrong in both directions:
//   · docs/bugs/README.md is a CURRENT document that happens to live in the
//     directory. A dead path in it is a defect, so it is NOT exempt.
//   · docs/generated/bug-history.md is the combined view RENDERED from those same
//     entries. It is gitignored, so CI never sees it, but a developer who has run
//     the generator has a copy — and it would otherwise report the ledger's ten
//     dated citations a second time, as defects.
const DATED = new Set(["BUG-HISTORY.md", "docs/generated/bug-history.md"]);
const DATED_DIR = "docs/bugs/";
const isDated = (rel) =>
  DATED.has(rel) || (rel.startsWith(DATED_DIR) && rel !== `${DATED_DIR}README.md`);

// Plans and design proposals. They describe what was INTENDED; where the build
// went another way the cited file never existed, and that is the document doing
// its job. Guidance documents are not allowed in this set.
const PLANS = new Set([
  "docs/archive/mail-center-port-plan.md",
  "docs/archive/mail-center-admin-plan.md",
  "docs/add-company-design.md",
  "docs/2990-mirror-full-design.md",
  "docs/archive/scm-clone/PLAN.md",
  "docs/scm-scaling-audit.md",
  "docs/UPGRADE-PLAN.md",
  "docs/archive/USER-MANAGEMENT-PLAN.md",
  "docs/agents/agent-platform-buildout.md",
  "docs/archive/pms-fair-pnl-seed-plan.md",
  "docs/delivery-planning-jobtypes-spec.md",
  "docs/ocr-prompt-audit.md",
  "docs/server-snapshot-playbook.md",
  "docs/agent-console-api.md",
  "docs/AI-DEV-VELOCITY.md",
]);

const HISTORICAL = new Set([
  "docs/archive/MIGRATION-D1-TO-SUPABASE.md",
  "docs/archive/HANDOFF-supabase-cutover.md",
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

// A doc may cite a path precisely to record that it is GONE — "DocumentTraceability.tsx
// — DELETED", "was DELETED after this audit". That is correct documentation, not a
// stale reference, and flagging it would push authors to delete the very sentence
// that explains an absence. All three findings left in docs/modules/ were this.
// Word boundaries were dropped deliberately: two rounds of shell escaping turned
// the  escape into a literal backspace byte, which made this regex match
// NOTHING and silently disabled the whole exemption. Without them the pattern is
// slightly looser and cannot be corrupted the same way.
const ABSENCE = /(deleted|removed|retired|renames|renamed|no longer exist|never existed|does not exist|do not exist)/i;
const SOURCE_EXT = /\.(ts|tsx|mjs|js|sql|json|toml|yml|yaml|css|html)$/;
// Docs cite paths relative to whichever root the reader is standing in —
// `middleware/auth.ts` means backend/src/middleware/auth.ts, `api/client.ts`
// means frontend/src/api/client.ts. A checker that demands repo-root paths
// reports 1,511 "missing" files that all exist, gets muted, and rots. Resolve
// against the roots the codebase actually uses.
// Every root a doc plausibly writes relative to. This list was built by
// MEASURING: the first version omitted backend/scripts/, backend/src/db/,
// frontend/src/pages/, frontend/src/mobile/ and frontend/src/vendor/scm/, and
// reported ~20 files as missing that were all present. Add a root here rather
// than "fixing" a doc that was never wrong.
const ROOTS = [
  "",
  "backend/src/",
  "frontend/src/",
  "backend/",
  "frontend/",
  "backend/src/scm/",
  "backend/src/db/",
  "backend/scripts/",
  "backend/tests/",
  "frontend/src/pages/",
  "frontend/src/mobile/",
  "frontend/src/vendor/",
  "frontend/src/vendor/scm/",
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
  if (cleaned.includes("{")) return null; // brace expansion, e.g. {A,B,C}.tsx
  if (cleaned.includes("...")) return null; // deliberately elided path
  if (cleaned.includes("<") || cleaned.includes(">")) return null; // template, e.g. <name>-agent.ts
  if (cleaned.startsWith("~/")) return null; // a path in the user's home, not the repo
  if (cleaned.startsWith("src/api/")) return null; // the 2990 repo's layout, cited for comparison
  if (cleaned.startsWith("postgres/") || cleaned.startsWith("node_modules/")) return null; // a dependency
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
  if (HISTORICAL.has(rel) || PLANS.has(rel)) continue;
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);

  // Absence is judged over the citation's line and its two neighbours — no
  // wider. These docs are hard-wrapped at ~80 characters, so
  // "…`services/overdue.ts` and `services/creditors.ts`" routinely sits on the
  // line above "— three files that do not exist", and a line-only test flagged
  // exactly that sentence.
  //
  // Whole-PARAGRAPH matching was tried first and rejected on the numbers: it
  // dropped the checked population from 2,791 to 2,144, because one "removed"
  // anywhere in a long paragraph exempted every citation in it. A checker that
  // reports clean because it stopped looking is the precise failure this repo
  // spent the day on. Three lines is enough for a wrapped sentence and cheap
  // enough to be wrong about.
  const nearAbsence = (i) => {
    const win = [lines[i - 1] ?? "", lines[i] ?? "", lines[i + 1] ?? ""].join(" ");
    return ABSENCE.test(win);
  };

  lines.forEach((line, i) => {
    const declaresAbsence = nearAbsence(i);
    for (const m of line.matchAll(CITATION)) {
      const p = looksLikePath(m[1]);
      if (!p) continue;
      if (declaresAbsence) continue;
      checked++;
      perDoc.set(rel, (perDoc.get(rel) ?? 0) + 1);
      if (!resolveRef(p)) {
        findings.push({ doc: rel, line: i + 1, ref: p, dated: isDated(rel) });
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
      `${dated.length} in dated ledgers (${[...DATED, DATED_DIR].join(", ")}) — recorded, not defects`,
  );
  for (const [doc, list] of [...byDoc]
    .filter(([d]) => !isDated(d))
    .sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${doc}  (${list.length})`);
    for (const f of list) console.log(`  L${f.line}  ${f.ref}`);
  }
}

process.exit(failOnFindings && findings.some((f) => !f.dated) ? 1 : 0);
