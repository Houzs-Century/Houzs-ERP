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
      (NEEDS_WORKERS.test(source) ? workers : light).push(rel);
    }
  }
  return { workers: workers.sort(), light: light.sort() };
}
