// Which backend test files need the Workers runtime, and which do not.
//
// Computed at config time, on purpose. This was originally a generated JSON
// file with an `audit:` gate, following the repo's gen/audit convention — and
// that was the wrong shape for this particular fact. The convention exists for
// things a human authors and could get wrong (the schema snapshot, the route
// matrix); this is a pure function of the source tree, so a committed copy can
// only ever be a chance to be out of date. Within a day of shipping it, two
// unrelated PRs went red on `audit:test-projects` for the crime of adding a
// test file.
//
// The rule: a file that mentions `cloudflare:test` or a D1 binding cannot run
// anywhere but the Workers pool. Everything else is pure logic and runs on a
// plain node runner in a fraction of the time — 221 of 265 files, 6.9s against
// roughly 390s of workerd startup. See docs/ci-capacity-coe.md.

import fs from "node:fs/promises";
import path from "node:path";

const NEEDS_WORKERS = /\bcloudflare:test\b|\benv\.DB\b|\benv\.DB_PARITY\b/;

/* An explicit `// @vitest-project light|workers` OVERRIDES the text scan.
   Necessary, not a convenience: the scan matches raw text, so a test whose
   SUBJECT IS the marker necessarily contains the marker, and no content rule can
   ever get that case right. This file's own test is the instance — it carries
   `cloudflare:test` in fixtures and needs a real filesystem (fs.mkdtemp).

   That distinction is the point. Being exiled to workerd is a known, accepted
   COST for a pure-logic file (see the pinned "known cost" test): slower, still
   correct. For a file that touches node:fs it is FATAL — workerd has no
   filesystem, the pool dies with "Worker cloudflare-pool emitted error", and
   every test in the file is reported as NEITHER passed NOR failed. Measured
   2026-08-14: "Test Files 15 passed (16)", the 16th silently absent. */
const PROJECT_DECL = /^[ \t]*\/\/[ \t]*@vitest-project[ \t]+(light|workers)\b/m;

/* The declaration is only honoured ABOVE the first import — a file's directive
   block, never its body. Fixtures live below the imports, so a `@vitest-project`
   line inside a template literal cannot declare anything. Structural rather than
   a line count, and it fails SAFE: a stray "import" inside a header comment only
   SHRINKS the window, which drops the file back to the text scan. */
function declaredProject(source) {
  const firstImport = /^[ \t]*(?:import|export)\b/m.exec(source);
  const header = firstImport ? source.slice(0, firstImport.index) : source;
  return PROJECT_DECL.exec(header)?.[1] ?? null;
}

// Suites with their own config and their own runner already.
const OWNED_ELSEWHERE = ["tests-pg/", "tests-node/"];

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    /* `.test.mjs` too. A test written against node:test used to live as
       `*.node.mjs` and run under `node --test`, which contributes NOTHING to the
       merged coverage report — both halves of it come from vitest. So twelve
       genuinely-tested modules in scripts/lib read to the coverage ratchet as
       having no test at all, and its no-test floor was measuring the runner
       rather than the testing. Collected here instead; the files keep their
       `node:assert` and only swap the `test` import. */
    else if (/\.test\.(ts|mjs)$/.test(entry.name)) yield full;
  }
}

/**
 * @param {string} backendRoot absolute path to backend/
 * @returns {Promise<{workers: string[], light: string[], declared: string[]}>}
 *          repo-relative globs, sorted, so vitest's include lists are stable run
 *          to run. `declared` lists the files that overrode the text scan — an
 *          override must never be invisible, so it is returned and pinned by a
 *          test rather than left to accumulate unnoticed.
 */
export async function classifyTests(backendRoot) {
  const workers = [];
  const light = [];
  const declared = [];
  for (const root of ["tests", "src"]) {
    for await (const file of walk(path.join(backendRoot, root))) {
      const rel = path.relative(backendRoot, file).split(path.sep).join("/");
      if (OWNED_ELSEWHERE.some((p) => rel.startsWith(p))) continue;
      const source = await fs.readFile(file, "utf8");
      const decl = declaredProject(source);
      if (decl) declared.push(rel);
      const target = decl ?? (NEEDS_WORKERS.test(source) ? "workers" : "light");
      (target === "workers" ? workers : light).push(rel);
    }
  }
  return { workers: workers.sort(), light: light.sort(), declared: declared.sort() };
}
