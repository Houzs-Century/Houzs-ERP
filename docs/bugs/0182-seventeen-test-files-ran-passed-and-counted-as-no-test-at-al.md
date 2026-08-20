## Seventeen test files ran, passed, and counted as no test at all [medium]

**Symptom.** The coverage ratchet failed a docs-only PR with
`backend/scripts/lib: 17 files have NO test executing them, up from 15`. That PR
touched no file in that directory. Three other PRs were blocked behind the same
red, none of which had touched it either.

**Root cause.** The merged coverage report is built from `test:coverage:light` +
`test:coverage:workers`, both vitest. Seventeen test files ran under
`node --test` (`tests/*.node.mjs`, via `test:scale-contract` and its `pretest`),
and a `node --test` run contributes NOTHING to that report. Twelve modules in
`backend/scripts/lib` are covered only by those files — `ac-line-key-audit`,
`ac-po-line`, `ac-po-line-match`, `catalogue-series`, `classify-tests`,
`invoice-price-core`, `jsonb-bind-scan`, `po-cost-plan`, `release-discipline`,
`route-matrix-diff`, `so-line-dedication`, `swallowed-read-scan` — so the
no-test floor for that area was a number about the RUNNER, not about testing.

The gate was right and the tests were right. The measurement did not reach them.

**Fix.** The seventeen are ordinary vitest files now: `*.node.mjs` ->
`*.test.mjs`, `import test from 'node:test'` -> `import { test } from 'vitest'`,
bodies untouched — vitest runs `node:assert` unchanged, so nothing else moved.
`classify-tests.mjs`'s walk collects `*.test.mjs` alongside `*.test.ts`, which
keeps them out of TypeScript entirely. `test:scale-contract` and its `pretest`
are deleted.

**Measured.** The light suite goes 4102 -> 4361 tests. Those 259 were always
running; nothing that reads coverage could see them.

**Not re-baselined, deliberately.** Raising the floor to 17 accepts the debt and
turns a ratchet into a suggestion; exempting the area gives up on it. Both were
cheaper than the conversion and both would have left the number lying.

**What the rename then broke, and what caught it.** Nine documents and three
runners still named the old files: `check-docs-drift --strict` found the docs,
and `test:release-discipline` + two steps in `stamp-real-po-costs.yml` failed in
CI. A rename is exactly the change those gates exist for.

**What the rename broke a second time: the classifier classified itself wrong.**
`classifyTests.node.mjs` became `classifyTests.test.mjs`, so the widened walk
collected it — and sent it to the WORKERS pool. `classify-tests.mjs` decides by
regex over raw text, and that file is the classifier's own test: its fixtures
contain `cloudflare:test` and `env.DB` because that is what it tests. It also
needs a real filesystem (`fs.mkdtemp`), which workerd has none of, so the pool
did not fail the file — it died. `Worker cloudflare-pool emitted error`, and the
run read **`Test Files 15 passed (16)`**: all seven of its tests reported as
neither passed nor failed. Two assertions inside it were stale from the same
rename (`assert.match(p, /\.test\.ts$/)` against a tree that now holds `.mjs`)
and nobody saw them, because a file that never loads cannot go red.

Being exiled to workerd is a KNOWN, accepted cost for a pure-logic file — slower,
still correct, and pinned by its own test. For a file that touches `node:fs` it
is fatal. That distinction did not exist before this rename.

**Fix.** An explicit `// @vitest-project light|workers` overrides the text scan,
honoured only ABOVE the first import — a file's directive block, never its body,
so a declaration inside a fixture cannot declare on the real file's behalf. That
hole is not hypothetical: this classifier's own test is made of such fixtures.
Necessary rather than convenient — a content rule cannot judge a file whose
content is ABOUT the content rule. Overrides are returned and printed, and pinned
at exactly one file, so a second cannot arrive unnoticed.

**And the guard for it was in the wrong place first.** "Every suite on disk is
collected by some project" was written as a test in
`tests/scaleRealSchemaContract.test.mjs`, replacing the `pretest` assertion whose
arrangement this change deleted. Narrowing the walk back to `.test.ts` to prove
it red returned `No test files found` — the guard was itself one of the 18 files
that stop being collected. It would have vanished with the suites it protects and
CI would have gone green on 267 files instead of 285. It is
`backend/scripts/audit-test-projects.mjs` now, its own CI step, with a
deliberately duplicated walk so that narrowing the classifier's produces a
MISMATCH instead of two views that agree because they are the same code. It
replaces `audit:test-projects`, which had been pointing at a script deleted
weeks earlier (`gen-test-projects.mjs`, MODULE_NOT_FOUND) and was wired into no
workflow, so nothing noticed. Both failure branches proven red, exit 1.

**The conversion also imposed a 5-second budget on files that never had one.**
`node --test` has NO default timeout. vitest's is 5,000ms — a UNIT-test budget —
and moving the runner applied it silently to all seventeen.
`tests/noNulBytesInSource.test.mjs` reads EVERY tracked source file (~2,000
synchronous reads) looking for a raw NUL byte; measured on Windows it takes 3.47s
alone, 70% of the default before any contention, and in a full 288-file run it
returned `Test timed out in 5000ms` in two of six runs.

It presented as a flake in the worst possible place: a whole-tree gate that
intermittently reads as "the tree is dirty". The first hypothesis — a concurrent
write leaving a file momentarily zero-filled — was tested (10 consecutive
regenerations of the one candidate, checking `indexOf(0)` immediately after each)
and REFUTED; the failure text, once captured rather than summarised, said
`timed out` and never named an offending file. Two full runs were spent grepping
only the summary lines, which is why the wrong theory survived as long as it did.

Fixed with an explicit 60s timeout on that one test, with the reason in the file.
Raising vitest's global `testTimeout` was the wrong lever: it hands the same
slack to 288 files and hides a genuinely hung unit test. The other converted
suites were measured too — the next slowest walks the script tree at 1.65s and
the rest are under 1s, so none carries a declared timeout it does not need.

**Ref.** 2026-08-14. Lesson, and it generalises past this gate: **a measurement
can be wrong in the direction of looking rigorous.** "17 files have no test" read
as a real backlog for as long as nobody asked which runner the report came from.
Third lesson, from the timeout: **changing a runner changes the defaults the old
runner never had** — and the failure surfaced as a flake, in a gate about
something else entirely, five hours after the change that caused it.
Second lesson, from the guard that had to move: **a guard that dies with the
thing it guards is not a guard** — before trusting one, break the thing it
watches and check that the guard is still alive to complain.
