// What decides whether a backend test file runs on a plain node runner or in
// the workerd pool, pinned.
//
// WHY THIS IS WORTH A FILE. classify-tests.mjs is a pure function of the source
// tree that nothing tested, and it is the single lever on backend CI time: the
// workerd pool runs `fileParallelism: false, maxWorkers: 1`, so every file it
// takes is paid for serially, while the light project runs the same assertions
// in a fraction of the time. A file sent to the wrong pool is invisible — it
// still passes, just slower — which is exactly the shape that never gets found
// by watching CI go green.
//
// It also records a REAL defect, measured 2026-08-14: the rule is a regex over
// the file's raw text, so a file that merely MENTIONS `env.DB` in a comment is
// exiled to the serial pool. Five of the 46 workers-pool files were there for
// that reason alone — tests/companyScopeFailClosed.test.ts ("// Fake env.DB."),
// tests/adminResetLink.test.ts, tests/reviewHighFindings.test.ts and the two
// fair-report route tests. All import only vitest and plain source modules.
// The test below states that as the current behaviour rather than asserting the
// behaviour we would prefer, so tightening the rule is a deliberate change that
// has to come here first.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { classifyTests } from "../scripts/lib/classify-tests.mjs";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A throwaway backend-shaped tree: classifyTests only reads tests/ and src/. */
async function fixture(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "classify-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, "utf8");
  }
  return root;
}

test("a file importing cloudflare:test goes to the workers pool", async () => {
  const root = await fixture({
    "tests/a.test.ts": `import { env } from "cloudflare:test";\ntest("x", () => {});\n`,
    "tests/b.test.ts": `import { describe } from "vitest";\n`,
  });
  const { workers, light } = await classifyTests(root);
  assert.deepEqual(workers, ["tests/a.test.ts"]);
  assert.deepEqual(light, ["tests/b.test.ts"]);
});

test("env.DB and env.DB_PARITY also force the workers pool", async () => {
  for (const binding of ["env.DB", "env.DB_PARITY"]) {
    const root = await fixture({ "tests/a.test.ts": `await ${binding}.prepare("select 1");\n` });
    const { workers } = await classifyTests(root);
    assert.deepEqual(workers, ["tests/a.test.ts"], `${binding} should need workerd`);
  }
});

test("both roots are walked, and suites with their own runner are skipped", async () => {
  const root = await fixture({
    "tests/a.test.ts": `import { describe } from "vitest";\n`,
    "src/scm/lib/b.test.ts": `import { describe } from "vitest";\n`,
    "tests-pg/c.test.ts": `import { env } from "cloudflare:test";\n`,
    "tests-node/d.test.ts": `import { env } from "cloudflare:test";\n`,
  });
  const { workers, light } = await classifyTests(root);
  assert.deepEqual(workers, [], "tests-pg/ and tests-node/ own their own config");
  assert.deepEqual(light, ["src/scm/lib/b.test.ts", "tests/a.test.ts"]);
});

test("output is sorted and uses forward slashes, so vitest include lists are stable", async () => {
  const root = await fixture({
    "tests/z.test.ts": `import { describe } from "vitest";\n`,
    "tests/a.test.ts": `import { describe } from "vitest";\n`,
    "src/m.test.ts": `import { describe } from "vitest";\n`,
  });
  const { light } = await classifyTests(root);
  assert.deepEqual(light, ["src/m.test.ts", "tests/a.test.ts", "tests/z.test.ts"]);
  for (const p of light) assert.ok(!p.includes("\\"), `${p} must be posix-separated`);
});

test("only .test.ts is collected; helpers and node:test files are not", async () => {
  const root = await fixture({
    "tests/a.test.ts": `import { describe } from "vitest";\n`,
    "tests/helper.ts": `export const x = 1;\n`,
    "tests/b.node.mjs": `import test from "node:test";\n`,
  });
  const { workers, light } = await classifyTests(root);
  assert.deepEqual([...workers, ...light], ["tests/a.test.ts"]);
});

/* FIXED 2026-08-14 — this test previously RECORDED the opposite, and the fix
   changed it on purpose, which is what it was pinned for.

   The rule used to run over raw text, so `// Fake env.DB.` in a comment exiled a
   pure-logic file to the serial workers pool. Five of the 46 files in that pool
   were there for that reason alone. classify-tests now blanks comments first. */
test("a comment mentioning env.DB no longer exiles a pure-logic file", async () => {
  const root = await fixture({
    "tests/a.test.ts": `import { describe } from "vitest";
// Fake env.DB. Nothing here needs workerd.
`,
    "tests/b.test.ts": `import { describe } from "vitest";
/* env.DB in a block comment too. */
`,
  });
  const { workers, light } = await classifyTests(root);
  assert.deepEqual(workers, [], "a comment must not decide the pool");
  assert.deepEqual(light, ["tests/a.test.ts", "tests/b.test.ts"]);
});

/* The stripper is string-aware, and that is the part that could eat a file.
   A naive strip breaks on "http://x" and on the mount paths this repo really
   writes, like "/products/*" — check-docs-drift declined to strip for exactly
   that reason. Real CODE must still count. */
test("a binding inside a STRING still counts, and comment-looking strings do not break it", async () => {
  const root = await fixture({
    "tests/a.test.ts": `const url = "http://x//y"; await env.DB.prepare("select 1");
`,
    "tests/b.test.ts": `const p = "/products/*"; import { describe } from "vitest";
`,
  });
  const { workers, light } = await classifyTests(root);
  assert.deepEqual(workers, ["tests/a.test.ts"], "real env.DB use still needs workerd");
  assert.deepEqual(light, ["tests/b.test.ts"], "a string containing /* must not eat the file");
});

test("the real backend tree classifies, and the split is not degenerate", async () => {
  const { workers, light } = await classifyTests(backendRoot);
  assert.ok(workers.length > 0, "some files genuinely need workerd");
  assert.ok(light.length > workers.length, "the light project must be the larger half");
  for (const p of [...workers, ...light]) assert.match(p, /\.test\.ts$/);
  assert.equal(new Set([...workers, ...light]).size, workers.length + light.length,
    "a file must land in exactly one project");
});
