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

// Suites with their own config and their own runner already.
const OWNED_ELSEWHERE = ["tests-pg/", "tests-node/"];

/**
 * Source with comments blanked out, so a MENTION of a binding cannot decide
 * where a file runs.
 *
 * WHY. The regex above was applied to raw text, so a file that merely wrote
 * `// Fake env.DB.` in a comment was sent to the workers pool — which runs
 * `fileParallelism: false, maxWorkers: 1`, i.e. the expensive serial one.
 * Measured 2026-08-14: FIVE of the 46 files in that pool were there for that
 * reason alone (adminResetLink, companyScopeFailClosed, fairPnl.route,
 * fairReport.route, reviewHighFindings) and every one of them imports nothing
 * but vitest and plain source modules.
 *
 * Blanked, not deleted: each comment becomes the same number of newlines and
 * spaces, so nothing here changes a line number if this ever grows a reporter.
 *
 * String-aware on purpose. A naive strip eats the file — `"http://x"` contains
 * `//`, and this repo has mount paths like `"/products/*"` that contain the
 * block-comment opener. The same trap is written up in
 * backend/scripts/check-docs-drift.mjs, which chose NOT to strip for exactly
 * this reason. Tracking the four states is what makes it safe here.
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (c === "/" && d === "*") {
      out += "  "; i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " "; i += 1;
      }
      out += "  "; i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c; i += 1;
      while (i < n) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

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
    else if (/\.test\.ts$/.test(entry.name)) yield full;
  }
}

/**
 * @param {string} backendRoot absolute path to backend/
 * @returns {Promise<{workers: string[], light: string[]}>} repo-relative globs,
 *          sorted, so vitest's include lists are stable run to run.
 */
export async function classifyTests(backendRoot) {
  const workers = [];
  const light = [];
  for (const root of ["tests", "src"]) {
    for await (const file of walk(path.join(backendRoot, root))) {
      const rel = path.relative(backendRoot, file).split(path.sep).join("/");
      if (OWNED_ELSEWHERE.some((p) => rel.startsWith(p))) continue;
      const source = await fs.readFile(file, "utf8");
      // Comments blanked first: a file that only MENTIONS a binding in prose
      // must not be sent to the serial workers pool. See stripComments above.
      (NEEDS_WORKERS.test(stripComments(source)) ? workers : light).push(rel);
    }
  }
  return { workers: workers.sort(), light: light.sort() };
}
