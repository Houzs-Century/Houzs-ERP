// Prevent a local focused test from silently shrinking the required CI suite.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const frontend = join(dirname(fileURLToPath(import.meta.url)), "..");
const roots = [join(frontend, "src"), join(frontend, "e2e")];
const extensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const focused = /\b(?:describe|it|test)\.only\s*\(/g;
const failures = [];

function walk(path) {
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    const stats = statSync(child);
    if (stats.isDirectory()) {
      if (name !== "node_modules" && name !== "dist") walk(child);
      continue;
    }
    if (!extensions.has(extname(name))) continue;
    const source = readFileSync(child, "utf8");
    for (const match of source.matchAll(focused)) {
      const line = source.slice(0, match.index).split(/\r?\n/).length;
      failures.push(`${child.slice(frontend.length + 1)}:${line}`);
    }
  }
}

for (const root of roots) walk(root);

if (failures.length) {
  console.error("[test-focus] focused tests are forbidden in required CI:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log("[test-focus] PASS: no focused tests in frontend unit or E2E suites.");
