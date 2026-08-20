## A comment mentioning `env.DB` sent five pure-logic tests to the serial workerd pool [low]

**Symptom.** Not a failure — a cost, which is why it sat unnoticed. The backend
test suite is split in two: `test:light` runs on a plain node runner, and
`test:workers` runs in the Cloudflare pool with `fileParallelism: false` and
`maxWorkers: 1`, i.e. strictly serial. Five files that import nothing but vitest
and plain source modules were being paid for in the serial pool.

**Root cause.** `backend/scripts/lib/classify-tests.mjs` decided the pool with

```js
const NEEDS_WORKERS = /\bcloudflare:test\b|\benv\.DB\b|\benv\.DB_PARITY\b/;
… NEEDS_WORKERS.test(source)
```

applied to the file's RAW text. So prose counted. `tests/companyScopeFailClosed.test.ts`
says `// Fake env.DB.` in a comment — it BUILDS a fake — and that comment alone
routed it to workerd. Same for `adminResetLink`, `reviewHighFindings`,
`fairPnl.route` and `fairReport.route`, each matching inside a `/* */` block.

**Fix.** Blank comments before matching, with a string-aware scanner. Naive
stripping was not an option and the repo already knew it: `check-docs-drift.mjs`
deliberately does NOT strip, because `"http://x"` contains `//` and this codebase
writes mount paths like `"/products/*"` that contain the block-comment opener.
Tracking the four states (code / '…' / "…" / \`…\`) is what makes it safe, and two
tests pin exactly those two traps.

**Verified.** Workers pool 46 -> 41 files. All five relocated files pass in the
light pool (71 tests). Both suites whole afterwards: light 276 files / 4284
passed, workers 41 files / 335 passed — no test lost, none broken.

**The class, for next time.** A regex over source text cannot tell code from
prose, and a classifier is not a linter: being wrong costs time rather than
correctness, so nothing goes red and nobody looks. The behaviour had in fact been
PINNED as a known cost by `tests/classifyTests.node.mjs` a few hours earlier; that
test now pins the fix instead, which is what a pin is for.

**Ref** — 2026-08-14, PR `chore/classify-strip-comments`. No migration.
