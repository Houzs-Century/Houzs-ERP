#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-docs-drift.mjs — the docs make CHECKABLE claims. Check them.
//
// WHY THIS EXISTS. The owner's standing complaint is that this repo's
// documentation misleads people, and the history backs him:
//
//   · CLAUDE.md called the database "D1 SQLite" for over a month after the
//     Postgres cutover, and pointed at a migration directory production does
//     not read. It is AUTO-LOADED, so every session believed it.
//   · COEs described code that no longer existed.
//   · The audit ledger said "dead code | 12". The real number was 184; the 12
//     had never been counted.
//   · A comment in grn-queries.ts names a caller file, GoodsReceived.tsx, that
//     does not exist.
//   · frontend/tsconfig.json is a solution file, so the typecheck command
//     everyone reached for compiled ZERO files and exited 0.
//
// Every one of those was found by a human noticing, months late. Most of them
// were mechanically checkable the whole time.
//
// WHAT IT CHECKS — only claims a script can settle without judgement:
//
//   1. FILE REFERENCES     `src/scm/routes/foo.ts` -> does the file exist?
//   2. LINE REFERENCES     `foo.ts:4296` -> does the file have 4296 lines?
//   3. MIGRATION NUMBERS   "mig 0198" / "migration 0284" -> is there such a file?
//   4. PERMISSION KEYS     `scm.payment_voucher.post` -> is it in the catalogue?
//   5. NPM SCRIPTS         `npm run audit:routes` -> is it in a package.json?
//
// WHAT IT DELIBERATELY DOES NOT CHECK: whether a documented BEHAVIOUR matches
// the code. No script settles "the confirm gate requires a venue"; that needs a
// reader. This closes the half that rots silently, so a human's attention goes
// to the half that needs them.
//
// A LINE REFERENCE IS ADVISORY BY DESIGN. Line numbers move on every merge, so
// this reports a `file.ts:9999` pointing past EOF — a reference that certainly
// cannot be right — and not a reference that has merely shifted by twenty. The
// module guides already say their line numbers are indicative and point at
// docs/generated/route-locator.md. Reporting every drifted line number would
// produce hundreds of findings nobody reads, which is how a check dies.
//
// NOT A PROOF OF ABSENCE. It cannot see a claim that is wrong but well-formed:
// a doc naming a real file for the wrong reason passes here. That is what the
// prose sweep is for.
//
// Usage:
//   node backend/scripts/check-docs-drift.mjs           # report
//   node backend/scripts/check-docs-drift.mjs --strict  # exit 1 on any finding
//   node backend/scripts/check-docs-drift.mjs --json
//
// NO DEPENDENCIES (node:fs / node:path only) so it runs in a fresh worktree
// with no node_modules — the situation these checks are needed in.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const strict = process.argv.includes("--strict");
const jsonOut = process.argv.includes("--json");

/* Docs are markdown at the repo root, under docs/, and the two mandatory
   ledgers. Node_modules and generated output are excluded: docs/generated/ is
   regenerated from the tree by definition, so it cannot drift. */
function walkDocs(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "generated" || e.name === ".git") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkDocs(full, acc);
    else if (e.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

const docFiles = [
  ...walkDocs(path.join(repoRoot, "docs")),
  ...["CLAUDE.md", "BUG-HISTORY.md", "README.md"]
    .map((f) => path.join(repoRoot, f))
    .filter((f) => fs.existsSync(f)),
];

/* ── The facts the docs are checked AGAINST, read from the tree ───────────── */

const migrationNumbers = new Set();
for (const tree of ["migrations-pg", "migrations"]) {
  const dir = path.join(repoRoot, "backend", "src", "db", tree);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    const m = /^(\d{3,4})_/.exec(f);
    if (m) migrationNumbers.add(String(Number(m[1])));
  }
}

/* Gate keys, read from the TWO catalogues the routes actually gate on. Parsed
   as string literals shaped like a key rather than by importing the module —
   this script must run without node_modules and without a TS loader.

   ALL THREE files, learned twice. The first run produced 426 false positives
   from knowing only one namespace; this list then said "two" for a while and was
   still short one, so `projects.finances` — a real key `requirePageAccess` reads
   at five handlers in routes/projects.ts — was reported as unknown and a doc
   that was RIGHT nearly got "corrected" to match the checker.

   permissions.ts holds verbs (`scm.payment_voucher.post`), scm-areas.ts holds
   AREA keys (`scm.warehouse.inventory`) the area guard reads, pageAccess.ts
   holds PAGE keys (`projects.finances`, 79 of them). The docs use all three
   interchangeably, so the checker has to. */
const permKeys = new Set();
for (const p of [
  path.join(repoRoot, "backend", "src", "services", "permissions.ts"),
  path.join(repoRoot, "backend", "src", "scm", "lib", "scm-areas.ts"),
  path.join(repoRoot, "backend", "src", "services", "pageAccess.ts"),
]) {
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, "utf8");
  for (const m of src.matchAll(/['"`]([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)['"`]/g)) {
    permKeys.add(m[1]);
  }
}

const npmScripts = new Set();
for (const pkg of ["package.json", "backend/package.json", "frontend/package.json"]) {
  const p = path.join(repoRoot, pkg);
  if (!fs.existsSync(p)) continue;
  try {
    for (const k of Object.keys(JSON.parse(fs.readFileSync(p, "utf8")).scripts ?? {})) npmScripts.add(k);
  } catch { /* an unparseable package.json is not this check's business */ }
}

/* The namespace prefixes that really exist, used to tell a gate key from a
   schema.table.column reference — the two are indistinguishable by shape. */
const permPrefixes = new Set();
for (const k of permKeys) permPrefixes.add(k.slice(0, k.lastIndexOf(".") + 1));

/* A doc path may be written from the repo root OR from backend/ or frontend/ —
   the module guides and BUG-HISTORY routinely say `scripts/pg-migrate.mjs` and
   `scripts/scm-schema/2990s-full-schema.sql`, both of which live under backend/.
   Resolving only from the root called 11 correct references broken, which would
   have led to "fixing" docs that were right. Try each base and return the first
   that exists. */
const RESOLVE_BASES = ["", "backend", "frontend"];
function resolveDocPath(p) {
  for (const base of RESOLVE_BASES) {
    const rel = base ? `${base}/${p}` : p;
    if (fs.existsSync(path.join(repoRoot, rel))) return rel;
  }
  return null;
}

const lineCountCache = new Map();
function lineCount(rel) {
  if (lineCountCache.has(rel)) return lineCountCache.get(rel);
  const full = path.join(repoRoot, rel);
  let n = -1;
  try { n = fs.readFileSync(full, "utf8").split("\n").length; } catch { n = -1; }
  lineCountCache.set(rel, n);
  return n;
}

/* ── Patterns ─────────────────────────────────────────────────────────────── */

/* A path that looks like a repo file. Anchored on a known top-level directory
   so prose like "the sales order" or a bare "foo.ts" does not become a finding:
   an unanchored filename cannot be resolved to one place in a tree this size,
   and guessing produces noise. */
/* `apps/` and `packages/` are EXCLUDED. This repo has neither directory; every
   such reference is a deliberate pointer into the 2990 SOURCE repo the SCM tree
   was vendored from (apps/api, apps/pos, packages/shared), used to record where
   a rule came from. Flagging them would push a reader to delete a provenance
   note that is doing its job.

   The extension list is EXPLICIT rather than `[a-z]{2,4}`, which matched
   `costing-enabled.is` out of the prose "costing-enabled.ts is disabled".

   ORDER AND THE LOOKAHEAD BOTH MATTER, and getting it wrong is not a subtle
   failure. Alternation is first-match-wins, so `ts` before `tsx` made App.tsx
   match as App.ts and package.json as package.js — the checker then reported 72
   present files as missing. Longest alternative first, plus a trailing boundary
   so a partial extension cannot match at all.

   COMPRESSED SUFFIXES are part of the name. `ac-fidelity-so-headers.json.gz`
   matched as `.json` and was reported missing while the real file sat right
   there — the extension list stopped one dot short. `(?:\.gz)?` after the
   alternation, and the boundary below still refuses a partial match. */
const FILE_REF =
  /\b((?:backend|frontend|docs|scripts|tasks)\/[A-Za-z0-9_\-./]+\.(?:tsx|ts|mts|mjs|cjs|jsx|json|js|sql|md|yaml|yml|css|html|csv|toml)(?:\.gz)?)(?![A-Za-z0-9])(?::(\d+))?/g;
/* A file:line where the file part carries no directory — resolved only if the
   basename is unique in the tree, otherwise skipped rather than guessed. */
const BARE_LINE_REF = /\b([A-Za-z0-9_\-.]+\.(?:ts|tsx|mjs|sql|md)):(\d{2,6})\b/g;
const MIG_REF = /\b(?:mig|migration)\s+(\d{3,4})\b/gi;
const PERM_REF = /`(scm\.[a-z0-9_.]+|[a-z]+\.[a-z0-9_.]+)`/g;
const NPM_REF = /\bnpm(?:\s+--prefix\s+\S+)?\s+run\s+([A-Za-z0-9:_-]+)/g;

/* SELF-TEST. A pattern that cannot match reports a clean run, and this repo has
   produced that failure three times in one day. Assert before scanning. */
{
  const one = (re, s) => { re.lastIndex = 0; return re.exec(s); };
  const ok =
    one(FILE_REF, "see backend/src/scm/routes/foo.ts:42 now")?.[1] === "backend/src/scm/routes/foo.ts" &&
    one(FILE_REF, "see backend/src/scm/routes/foo.ts:42 now")?.[2] === "42" &&
    /* The alternation-order bug, asserted so it cannot come back: `ts` before
       `tsx` made App.tsx match as App.ts and reported 72 present files missing. */
    one(FILE_REF, "in frontend/src/App.tsx today")?.[1] === "frontend/src/App.tsx" &&
    one(FILE_REF, "in backend/package.json today")?.[1] === "backend/package.json" &&
    one(MIG_REF, "restored by mig 0198 today")?.[1] === "0198" &&
    one(MIG_REF, "see migration 0284 for the shape")?.[1] === "0284" &&
    one(NPM_REF, "run `npm --prefix frontend run typecheck`")?.[1] === "typecheck" &&
    one(PERM_REF, "gated on `scm.payment_voucher.post` now")?.[1] === "scm.payment_voucher.post" &&
    one(BARE_LINE_REF, "at sofa-build.ts:503 the round")?.[1] === "sofa-build.ts";
  if (!ok) {
    console.error("check-docs-drift: internal pattern self-test FAILED - not reporting.");
    process.exit(2);
  }
}

/* Basename -> paths, for resolving bare `foo.ts:123` references. Ambiguous
   basenames are skipped: a wrong resolution is worse than no resolution. */
const byBasename = new Map();
(function indexTree(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === ".wrangler") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) indexTree(full);
    else {
      const rel = path.relative(repoRoot, full).split(path.sep).join("/");
      const arr = byBasename.get(e.name) ?? [];
      arr.push(rel);
      byBasename.set(e.name, arr);
    }
  }
})(repoRoot);

/* ── Scan ─────────────────────────────────────────────────────────────────── */

const findings = [];
let claimsChecked = 0;

for (const file of docFiles) {
  const rel = path.relative(repoRoot, file).split(path.sep).join("/");
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    /* `advisory` splits CERTAIN from HEURISTIC, the same split every sibling
       checker makes (WRITE vs read; SILENT vs UNRESOLVED). --strict gates on the
       certain half only. A gate that fires on a guess is a gate someone turns
       off, and then the certain findings go unseen too. */
    const at = (what, detail, advisory = false) =>
      findings.push({ file: rel, line: i + 1, kind: what, detail, advisory, text: line.trim().slice(0, 120) });

    // 1 + 2. File and line references.
    for (const m of line.matchAll(FILE_REF)) {
      const p = m[1], ln = m[2] ? Number(m[2]) : null;
      /* Three shapes that are not claims about a real file, each one a false
         positive from an earlier run:
           · `backend/.../delivery-planning.ts` — `...` is ELISION in prose.
           · `migrations-pg/NNNN_foo.sql` — NNNN is a PLACEHOLDER for a number
             the author could not know yet.
           · a gitignored path like `backend/.dev.vars` — legitimately absent
             from the tree and legitimately real on a developer's machine.
         Flagging any of them pushes a reader to "fix" prose that is correct. */
      // NNNN is matched WITHOUT \b — the placeholder appears as `NNNN_foo.sql`,
      // and `_` is a word character, so \b never fires after it.
      if (p.includes("/.../") || /NNNN/.test(p) || /(^|\/)\.[A-Za-z]/.test(p)) continue;
      /* THREE MARKERS, for the three honest reasons a doc names a path that is
         not in the tree. Each one keeps the doc TRUE and tells the reader the
         same thing it tells the checker — which a silent exemption list would
         not:

           [gone]      the doc is RECORDING a deletion. BUG-HISTORY is full of
                       these by construction: an entry whose whole subject is
                       "this file was removed" must name a file that no longer
                       exists, and editing the entry to stop naming it would
                       destroy the record.
           [planned]   proposed, not yet written. `docs/modules/assistant.md`
                       says "(no guide exists yet)" in the same sentence.
           [external]  lives in the 2990 source repo this SCM tree was vendored
                       from, not here.

         The path is usually inside backticks, so the marker sits AFTER the
         closing one: `foo.ts` [gone]. Allow the delimiter through. */
      const after = line.slice(m.index + m[0].length, m.index + m[0].length + 20);
      // `-20` tolerated: docs cite RANGES (`foo.ts:16-20`) and the capture stops
      // at the first number, so the marker sits past the range's tail.
      if (/^(?:-\d+)?["'`)\]]?\s*\[(gone|planned|external)\]/.test(after)) continue;
      claimsChecked++;
      const resolved = resolveDocPath(p);
      if (!resolved) { at("missing-file", p); continue; }
      const n = lineCount(resolved);
      if (ln != null && n > 0 && ln > n) at("line-past-eof", `${p}:${ln} but ${resolved} has ${n} lines`, true);
    }
    // Bare `foo.ts:123`, resolved only when the basename is unambiguous.
    for (const m of line.matchAll(BARE_LINE_REF)) {
      const base = m[1], ln = Number(m[2]);
      const hits = byBasename.get(base);
      if (!hits || hits.length !== 1) continue;   // ambiguous or unknown: not a finding
      claimsChecked++;
      const n = lineCount(hits[0]);
      if (n > 0 && ln > n) at("line-past-eof", `${base}:${ln} but ${hits[0]} has ${n} lines`, true);
    }
    // 3. Migration numbers.
    for (const m of line.matchAll(MIG_REF)) {
      claimsChecked++;
      if (!migrationNumbers.has(String(Number(m[1])))) at("missing-migration", `mig ${m[1]} has no file in either migration tree`);
    }
    // 4. Permission keys. Only checked when the catalogue parsed at all, and
    //    only for the scm.* / dotted shape the routes gate on.
    if (permKeys.size > 0) {
      for (const m of line.matchAll(PERM_REF)) {
        const k = m[1];
        if (!/^(scm|projects|admin|fleet|hr|finance)\./.test(k)) continue;  // dotted prose is not a key
        /* `scm.<one segment>` is a TABLE — `scm` is the Postgres schema, and
           the docs name tables constantly (scm.staff, scm.mfg_sales_orders).
           A gate key always has at least two segments after the namespace. This
           single line removed most of the first run's 426 false positives. */
        if (/^scm\.[a-z0-9_]+$/.test(k)) continue;
        // `projects.ts`, `helpers.tsx` — a filename, not a key.
        if (/\.(ts|tsx|mjs|js|sql|md|json|yml|yaml)$/.test(k)) continue;
        /* `scm.mfg_sales_orders.venue` is schema.TABLE.COLUMN, which the docs
           write constantly and which shares the gate keys' exact shape. The only
           thing that separates them is VOCABULARY, so the test is: does this key
           share a namespace prefix with a key that really exists? `scm.finance.`
           does (scm.finance.accounting), so `scm.finance.view` is worth a human's
           eye. `scm.mfg_sales_orders.` does not, so it is a column and is
           skipped. This is a heuristic and is reported as ADVISORY for exactly
           that reason. */
        const prefix = k.slice(0, k.lastIndexOf(".") + 1);
        if (!permPrefixes.has(prefix)) continue;
        claimsChecked++;
        if (!permKeys.has(k)) {
          at("unknown-permission",
            `\`${k}\` is in none of permissions.ts / scm-areas.ts / pageAccess.ts` +
            ` — or it is a table.column that shares a prefix with a real key`, true);
        }
      }
    }
    // 5. npm scripts.
    for (const m of line.matchAll(NPM_REF)) {
      claimsChecked++;
      if (!npmScripts.has(m[1])) at("missing-npm-script", `npm run ${m[1]} is in no package.json`);
    }
  }
}

findings.sort((a, b) => a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file) || a.line - b.line);

if (jsonOut) {
  console.log(JSON.stringify({ docsScanned: docFiles.length, claimsChecked, findings }, null, 2));
} else {
  const certain = findings.filter((f) => !f.advisory);
  const advisory = findings.filter((f) => f.advisory);
  const kinds = (list) => {
    const m = new Map();
    for (const f of list) m.set(f.kind, (m.get(f.kind) ?? 0) + 1);
    return [...m].map(([k, n]) => `  ${String(n).padStart(4)}  ${k}`).join("\n");
  };
  console.log(
    `Scanned ${docFiles.length} markdown files, ${claimsChecked} mechanically checkable claims.\n\n` +
      `${certain.length} CERTAIN — the thing named does not exist. --strict gates on these.\n` +
      (certain.length ? kinds(certain) + "\n" : "") +
      `\n${advisory.length} ADVISORY — heuristic, read before acting.\n` +
      (advisory.length ? kinds(advisory) + "\n" : "") +
      `\nThis checks REFERENCES, not BEHAVIOUR. A doc naming a real file for the\n` +
      `wrong reason passes here — that half needs a reader.\n`,
  );
  for (const [label, list] of [["CERTAIN", certain], ["ADVISORY", advisory]]) {
    if (!list.length) continue;
    console.log(`\n=== ${label} ===`);
    let last = "";
    for (const f of list) {
      if (f.file !== last) { console.log(`\n${f.file}`); last = f.file; }
      console.log(`  L${String(f.line).padEnd(5)} ${f.kind.padEnd(18)} ${f.detail}`);
    }
  }
}

/* --strict gates on the CERTAIN half only, matching every sibling checker:
   check-company-scope gates on WRITE (not read), check-silent-mutations on
   SILENT (not UNRESOLVED), check-shared-mirrors on DIVERGED (not COSMETIC). A
   gate that fires on a heuristic is a gate someone switches off, and then the
   certain findings stop being seen too. */
process.exit(strict && findings.filter((f) => !f.advisory).length ? 1 : 0);
