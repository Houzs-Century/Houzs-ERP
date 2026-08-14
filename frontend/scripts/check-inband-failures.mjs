#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-inband-failures.mjs — a 200 that CARRIES a failure, with nobody reading
// the payload.
//
// THE SHAPE, and why it needed its own checker. `check-silent-mutations.mjs`
// asks whether a mutation handles a REJECTION. These mutations RESOLVE: HTTP
// 200, no exception thrown, `onError` never fires. The write succeeded; what
// failed is something the write depends on, and the server says so IN THE BODY:
//
//     return c.json({ ok: true, ...(movementErrors.length ? { movementErrors } : {}) });
//
// If nothing on the client reads that field, the operator is told the operation
// worked. On 2026-08-13 that was the literal case: `POST /purchase-returns` had
// returned `movementErrors` since it was written, `useCreatePurchaseReturn`
// typed the response as `{id, returnNumber}`, and `PurchaseReturnNew.tsx`
// announced "Stock OUT recorded." unconditionally. A refused inventory write
// reported success for months.
//
// EIGHT backend route files return `movementErrors`. THREE frontend files read
// it. That gap is what this script measures.
//
// It is the SIXTH distinct blind spot found in this repo's checkers in one day,
// and the only one that is not a bug in a checker — it is a shape no existing
// checker was built for. The other five all made a number too small; this one
// made a number irrelevant, because the check being run was answering a
// different question.
//
// WHAT IT DOES. For each in-band failure field the backend can return, find the
// endpoints that return it, then find whether ANY frontend file reads it. A
// field with backend writers and zero frontend readers is reported.
//
// WHAT IT CANNOT SEE, stated so a clean run is not over-read:
//   - whether the reader does anything USEFUL with the field. Reading it into a
//     variable nobody renders passes here.
//   - a field read through a dynamic key or a spread. Rare here; not free to
//     detect.
//   - whether the ENDPOINT a given screen calls is the one whose field is read.
//     A field read on one page and ignored on four others counts as read. That
//     is the honest limit of a field-level check, and it is why the per-endpoint
//     counts are printed rather than just a verdict.
//
// Usage:
//   node frontend/scripts/check-inband-failures.mjs           # report
//   node frontend/scripts/check-inband-failures.mjs --strict  # exit 1 on a gap
//   node frontend/scripts/check-inband-failures.mjs --json
//
// NO DEPENDENCIES (node:fs / node:path only) so it runs in a fresh worktree.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const strict = process.argv.includes("--strict");
const jsonOut = process.argv.includes("--json");

/* The in-band failure fields this codebase actually uses. Each one means "the
   request succeeded and something it depends on did not". Extend the list when
   a new one is introduced — and if you are introducing one, that is the moment
   to wire its reader. */
const FIELDS = [
  "movementErrors",
  "cancelErrors",
  "reversalErrors",
  "recountErrors",
];

function walk(dir, exts, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, exts, acc);
    else if (exts.some((x) => e.name.endsWith(x)) && !/\.test\.tsx?$/.test(e.name)) acc.push(full);
  }
  return acc;
}

const backendFiles = walk(path.join(repoRoot, "backend", "src"), [".ts"]);
const frontendFiles = walk(path.join(repoRoot, "frontend", "src"), [".ts", ".tsx"]);

/* SELF-TEST. Five checkers in this repo have reported a plausible wrong number
   from a pattern that could not match. Assert before scanning. */
{
  const probe = "return c.json({ ok: true, movementErrors });";
  const reader = "if (res.movementErrors?.length) reportMovementErrors(res);";
  if (!probe.includes("movementErrors") || !reader.includes("movementErrors") ||
      backendFiles.length === 0 || frontendFiles.length === 0) {
    console.error("check-inband-failures: internal self-test FAILED - not reporting.");
    process.exit(2);
  }
}

const rows = [];
for (const field of FIELDS) {
  const producers = [];
  for (const f of backendFiles) {
    const src = fs.readFileSync(f, "utf8");
    /* RETURNED, not merely collected. A route that builds a local
       `movementErrors` array and never puts it in the response is a different
       bug (the backend one, already swept); this checker is about the CLIENT
       half, so only fields that reach the wire count. */
    if (!new RegExp(`c\\.json\\([^)]*${field}`).test(src) &&
        !new RegExp(`${field}[^\\n]*\\}\\s*,?\\s*\\d{3}\\s*\\)`).test(src)) continue;
    producers.push(path.relative(repoRoot, f).split(path.sep).join("/"));
  }
  if (!producers.length) continue;

  const readers = frontendFiles
    .filter((f) => fs.readFileSync(f, "utf8").includes(field))
    .map((f) => path.relative(repoRoot, f).split(path.sep).join("/"));

  rows.push({ field, producers, readers });
}

const gaps = rows.filter((r) => r.readers.length === 0);

if (jsonOut) {
  console.log(JSON.stringify({ rows, gaps }, null, 2));
} else {
  console.log(
    `${rows.length} in-band failure field(s) reach the wire.\n` +
      `${gaps.length} have NO frontend reader at all — the server reports the\n` +
      `failure and the operator is told the operation worked.\n`,
  );
  for (const r of rows) {
    const verdict = r.readers.length === 0 ? "NO READER" : `${r.readers.length} reader(s)`;
    console.log(`\n${r.field}  —  ${r.producers.length} endpoint file(s), ${verdict}`);
    for (const p of r.producers) console.log(`    produces  ${p}`);
    for (const c of r.readers) console.log(`    reads     ${c}`);
    if (r.readers.length && r.readers.length < r.producers.length) {
      console.log(
        `    NOTE: fewer readers than producers. A field-level check cannot tell\n` +
          `          WHICH screen calls WHICH endpoint, so this is a prompt to read,\n` +
          `          not a finding. It is printed because that gap is exactly where\n` +
          `          the purchase-return bug lived.`,
      );
    }
  }
  console.log(
    `\nReading the field is not the same as SHOWING it. This cannot see whether\n` +
      `the reader renders anything — that half still needs a person.`,
  );
}

process.exit(strict && gaps.length ? 1 : 0);
