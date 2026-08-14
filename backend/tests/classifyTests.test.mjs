// @vitest-project light
//
// ^ NOT optional, and not a preference. This file is the classifier's own test,
// so its fixtures contain `cloudflare:test` and `env.DB` — the exact strings the
// classifier scans for. Without the declaration it classifies ITSELF into the
// workerd pool, where `fs.mkdtemp` does not exist, and the pool does not fail the
// file: it dies, and all seven tests below are reported as neither passed nor
// failed ("Test Files 15 passed (16)", measured 2026-08-14). Deleting this line
// does not turn a test red. It turns it invisible.
//
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
import { test } from 'vitest';
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
    "tests/b.node.mjs": `import { test } from 'vitest';\n`,
  });
  const { workers, light } = await classifyTests(root);
  assert.deepEqual([...workers, ...light], ["tests/a.test.ts"]);
});

/* RECORDED, NOT ENDORSED. The rule reads raw text, so a comment counts. This is
   a real cost — the serial workerd pool is the expensive one — and the fix is to
   strip comments before matching. Pinned so that fix has to change this test on
   purpose rather than silently reclassifying files. */
test("a comment mentioning env.DB is enough to exile a pure-logic file (known cost)", async () => {
  const root = await fixture({
    "tests/a.test.ts": `import { describe } from "vitest";\n// Fake env.DB. Nothing here needs workerd.\n`,
  });
  const { workers, light } = await classifyTests(root);
  assert.deepEqual(workers, ["tests/a.test.ts"], "today the comment decides");
  assert.deepEqual(light, []);
});

/* THE SELF-REFERENCE, and why an override exists at all. A content rule cannot
   classify a file whose content is ABOUT the content rule. Proven red first: with
   the declaration ignored, the fixture below lands in workers. */
test("an explicit @vitest-project declaration beats the text scan", async () => {
  const root = await fixture({
    "tests/a.test.mjs": `// @vitest-project light\nimport fs from "node:fs/promises";\nconst fx = \`import { env } from "cloudflare:test";\`;\n`,
    "tests/b.test.ts": `// @vitest-project workers\nimport { describe } from "vitest";\n`,
  });
  const { workers, light, declared } = await classifyTests(root);
  assert.deepEqual(light, ["tests/a.test.mjs"], "declared light despite the cloudflare:test fixture");
  assert.deepEqual(workers, ["tests/b.test.ts"], "declaration can also force workerd");
  assert.deepEqual(declared, ["tests/a.test.mjs", "tests/b.test.ts"]);
});

/* The hole the window closes. Without it the override is the same bug one level
   up: a fixture that CONTAINS a declaration would declare on the real file's
   behalf, and this classifier's own test is full of such fixtures. */
test("a declaration below the imports is body text, not a directive", async () => {
  const root = await fixture({
    "tests/a.test.ts": `import { describe } from "vitest";\nconst fx = \`// @vitest-project workers\`;\n`,
    "tests/b.test.ts": `import { env } from "cloudflare:test";\nconst fx = \`// @vitest-project light\`;\n`,
  });
  const { workers, light, declared } = await classifyTests(root);
  assert.deepEqual(declared, [], "nothing below the first import declares anything");
  assert.deepEqual(light, ["tests/a.test.ts"], "the text scan still decides");
  assert.deepEqual(workers, ["tests/b.test.ts"]);
});

test("the real backend tree classifies, and the split is not degenerate", async () => {
  const { workers, light, declared } = await classifyTests(backendRoot);
  assert.ok(workers.length > 0, "some files genuinely need workerd");
  assert.ok(light.length > workers.length, "the light project must be the larger half");
  /* `.mjs` as well as `.ts` since BUG-HISTORY #2180: a node:test file contributed
     nothing to the merged coverage report, so those suites became vitest files
     and the walk widened to collect them. */
  for (const p of [...workers, ...light]) assert.match(p, /\.test\.(ts|mjs)$/);
  assert.equal(new Set([...workers, ...light]).size, workers.length + light.length,
    "a file must land in exactly one project");
  /* PINNED so an override can never accumulate quietly. An override is a claim
     that no content rule can judge this file; there is exactly one such file, and
     a second one arriving should be argued for in a diff, not discovered later. */
  assert.deepEqual(declared, ["tests/classifyTests.test.mjs"],
    "only the classifier's own test may override its own rule");
});
