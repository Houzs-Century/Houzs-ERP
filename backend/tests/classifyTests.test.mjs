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
// It also recorded a REAL defect, measured 2026-08-14: the rule was a regex over
// the file's RAW text, so a file that merely MENTIONED `env.DB` in a comment was
// exiled to the serial pool — five of the then-46 workers-pool files were there
// for that reason alone.
//
// CORRECTED 2026-08-17: that is FIXED and the paragraph above is history, not
// current behaviour. `classifyTests` now scans `stripComments(source)`, and the
// three files that paragraph named by hand — companyScopeFailClosed,
// adminResetLink, reviewHighFindings — all classify LIGHT today. The split is
// 42 workers / 332 light; re-measure rather than quoting those two numbers:
//   node -e "import('./scripts/lib/classify-tests.mjs').then(async m => { const r = await m.classifyTests(process.cwd()); console.log(r.workers.length, r.light.length); })"
//
// Stripping is deliberately NOT total: it is string-aware, so `cloudflare:test`
// inside a template-literal fixture still counts, which is why this file needs
// its `@vitest-project` override above and why a gate-bearing suite can still be
// exiled by one added string. That is what the merge-gating test at the foot of
// this file guards.
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

/* ── The classification is load-bearing for MERGE PROTECTION ────────────────
   Added 2026-08-17.

   `backend-typecheck` is one of the two required contexts, and it runs
   `npm run test:light` — so a suite the classifier puts in the LIGHT project
   blocks a merge, and the same suite in the WORKERS project only blocks the
   deploy, because CLAUDE.md forbids making `backend-tests (N)` required (the
   shard index moves with the shard count, and the `backend` roll-up is
   legitimately `skipped` on a frontend-only PR).

   That distinction is currently decided by a REGEX (`NEEDS_WORKERS`) over the
   COMMENT-STRIPPED source. Nothing states which side a gate-bearing suite has to
   land on, so a single added line mentioning `cloudflare:test` or `env.DB` in
   code or in a string — a fixture, a fake env, an error message being asserted
   on — moves it to the shards and silently un-gates it. A check that stops
   running while CI stays green is the failure docs/staging-bench-rot-coe.md
   records going unnoticed for three weeks.

   (Stripping is why a COMMENT is safe. It was not always: the exile-by-prose
   defect this file's header describes was real when measured, and stripComments
   fixed it. Do not read that as "the text scan is careful now" — it is string-
   aware on purpose, so a string literal still counts.)

   This is not hypothetical in the other direction. `migrationNumbers.test.ts`
   was in the WORKERS half on 2026-08-13, which is why #2121 merged a duplicate
   `0284` four minutes into that test's own failure and production could not
   take a backend deploy for ~30 minutes. It moved to the light half the next
   day as a side effect of #2131 (`perf(ci): 565s -> 106s by not booting a
   Workers runtime for tests that never use one`) — nobody was aiming for the
   merge gate, and nobody recorded that it had been closed. CLAUDE.md still
   called it "the open item" three days later.

   So the protection is stated here rather than left to a side effect. Adding a
   suite to this list is a claim that its assertion must stop a MERGE. */
const MUST_GATE_MERGE = [
  "tests/migrationNumbers.test.ts",
  /* A bucket holding a label that is not in the enum makes the tab 500 AND its
     count fall silently to 0 — 37 delivery orders were unreachable in
     production on 2026-08-17 with every number on screen looking settled. It is
     a merge gate for the same reason the duplicate-number test is: nothing
     downstream catches it, and the deploy is perfectly healthy while the list
     lies. */
  "tests/statusBucketsEnumMembership.test.mjs",
];

test("every merge-gating suite is classified LIGHT, so a required job runs it", async () => {
  const { light, workers } = await classifyTests(backendRoot);
  const all = new Set([...light, ...workers]);
  for (const suite of MUST_GATE_MERGE) {
    /* Fail loudly if the file is renamed or deleted rather than passing
       vacuously on a name nothing matches. */
    assert.ok(all.has(suite), `${suite} is in MUST_GATE_MERGE but the classifier has never heard of it — was it renamed or deleted?`);
    assert.ok(
      light.includes(suite),
      `${suite} carries an assertion that must BLOCK A MERGE, but the classifier put it in the WORKERS project, `
      + `which runs in backend-tests (N) — not a required context. It would only fail the deploy, after the merge. `
      + `That is exactly what let #2121 land a duplicate migration number on 2026-08-13. `
      + `Find what made it look workerd-flavoured (NEEDS_WORKERS scans the comment-stripped source for cloudflare:test / env.DB — `
      + `a string literal counts, a comment does not) and remove it, or declare "// @vitest-project light" above the first import `
      + `if the suite genuinely needs neither, or move the assertion into a dependency-free script wired into backend-typecheck.`,
    );
  }
});
