/* Every `npm run` script points at a file that EXISTS.

   WHY THIS EXISTS. A script whose target is gone does not fail until someone
   runs it, and the ones nobody runs are exactly the ones that rot. Three were
   live in this repo on 2026-08-14, found only by tripping over them:

     · `audit:test-projects` -> `scripts/gen-test-projects.mjs`, deleted weeks
       earlier when the generated-JSON approach was abandoned. Wired into no
       workflow, so nothing noticed. It sat there as a name that looked like a
       gate and was a MODULE_NOT_FOUND.
     · `gen:test-projects` -> the same deleted file, same silence.
     · `test:scale-contract` -> sixteen `tests/*.node.mjs` files that this very
       PR renames to `*.test.mjs`. A merge resurrected the script line without
       the files.

   The last one is the shape worth naming: a MERGE brought back a deleted script
   line, and separately spliced a stale value into `audit:test-projects` —
   `node scripts/gen-test-projects.mjs --check scripts/audit-test-projects.mjs`,
   which is two versions concatenated. Neither is a syntax error, neither fails a
   typecheck, and the only symptom was a CI step exploding on a module path.

   Line-level merges do this to JSON. Nothing else in the repo checks that a
   script name still resolves to something, so this does.

   NOT a check that the script WORKS — only that the first file it names is
   there. That is the failure mode this repo produced three times in one day. */
import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every package.json that carries scripts, repo-relative. */
const MANIFESTS = ["backend/package.json", "frontend/package.json", "package.json"];

/** `node scripts/x.mjs`, `vitest run --config vitest.light.config.mts tests/y.mjs`, … */
function referencedFiles(command: string): string[] {
  const out: string[] = [];
  /* Bare relative paths with a source extension. Anything with a flag prefix,
     a glob, or an npm sub-command is skipped: this is about FILES the command
     names, not about parsing shell. */
  for (const m of command.matchAll(/(?:^|[\s=])((?:\.\/)?(?:src|tests|scripts|e2e)\/[\w./-]+\.(?:mjs|cjs|js|ts|tsx|mts|sql|json))/g)) {
    out.push(m[1].replace(/^\.\//, ""));
  }
  return out;
}

test("the scan finds real references — it cannot pass by parsing nothing", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "backend/package.json"), "utf8"));
  const all = Object.values(pkg.scripts as Record<string, string>).flatMap(referencedFiles);
  assert.ok(
    all.length > 20,
    `only ${all.length} file references parsed out of backend's scripts — the extraction is broken, not the manifests.`,
  );
});

test("no npm script names a file that does not exist", () => {
  const missing: string[] = [];
  for (const manifest of MANIFESTS) {
    const abs = path.join(ROOT, manifest);
    if (!fs.existsSync(abs)) continue;
    const dir = path.dirname(abs);
    const pkg = JSON.parse(fs.readFileSync(abs, "utf8"));
    for (const [name, command] of Object.entries((pkg.scripts ?? {}) as Record<string, string>)) {
      for (const rel of referencedFiles(command)) {
        if (!fs.existsSync(path.join(dir, rel))) missing.push(`${manifest} :: ${name} -> ${rel}`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    "these npm scripts name files that are not there. A script whose target is gone does not fail " +
      "until someone runs it, and a merge can resurrect a deleted script line or splice two versions " +
      "of one together without producing a syntax error:\n  " + missing.join("\n  "),
  );
});
