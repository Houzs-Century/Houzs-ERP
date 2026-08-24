## A shebang made a test suite unparseable on Windows only, and one error was counted as two failing files [low]

**Symptom** - `npx vitest run tests/soFeeLineRepairRow.test.ts` failed on every
local (Windows) run with a bare parse error and nothing collected:

```
FAIL tests/soFeeLineRepairRow.test.ts
SyntaxError: Invalid or unexpected token
Test Files 1 failed (1) / Tests: no tests
```

CI ran the same file green on every shard (run 31597783021, shard 4/4:
`✓ tests/soFeeLineRepairRow.test.ts (7 tests) 1160ms`). A full local `npm test`
therefore ended in failures that were not real - the corrosive part, because it
teaches people that local test results are noise.

**Root cause (traced, not guessed)** - not a byte-level defect in the test file,
which was the obvious reading and the wrong one. The test file is clean: no BOM
(first bytes `2f 2f 20`), UTF-8 round-trips byte-identical, no lone surrogates,
no control characters, uniform CRLF, and its only non-ASCII bytes are em-dashes
in comments.

The parse error was in the module it imports.
`backend/scripts/repair-so-fee-line-integrity.mjs` began with
`#!/usr/bin/env node`. On Windows vitest **inlines** that module and wraps its
source in a function before `vm.runInThisContext` - the stack lands in
`VitestModuleEvaluator._runInlinedModule` - so the `#!` is no longer at byte 0
and V8 rejects it outright. Linux externalizes the same module, where node strips
the shebang itself. Toolchain versions were identical and lockfile-pinned on both
(vitest 4.1.10, vite 8.1.5, @cloudflare/vitest-pool-workers 0.18.6): the only
variable was the OS.

Two things made this read as a byte problem. It dies at **load**, so it surfaces
as a failed FILE with zero tests, no assertion and no line number - exactly what
a bad byte looks like. And a full run reported **2 failed** for this single
error: vitest counts the failed suite and, separately, the `SyntaxError` arriving
as an Unhandled Rejection, which it attributes to whichever file was running when
it landed ("This error originated in ... It doesn't mean the error was thrown
inside the file itself"). So the hunt for a second corrupted file was a hunt for
something that did not exist.

**Fix** - delete the shebang. It bought nothing: every caller runs the script
through node (`so-fee-line-integrity.yml:79`, and the script header's own APPLY
example), never as an executable, and the file carries no exec bit. A comment
where the shebang was records why, so it is not re-added by someone matching the
~200 sibling scripts that do carry one. Verified: local Windows 7/7 tests pass,
the script still imports and evaluates under plain node, and the full local suite
is **264 files / 3766 tests, zero failures** - so there was never a second file.

The import graph of all 161 backend test files was swept for modules beginning
with `#!`; this was the only one. The other test-imported `.mjs` all live in
`scripts/lib/` and carry none - that is the existing convention for a module a
test consumes - and the `scripts/*.mjs` pulled in with `?raw` are read as text,
never parsed, so their shebangs are harmless.

**Lesson** - **a green CI and a red local run on the same commit is a statement
about the environment, not about the file.** Diff the environment first
(here: the OS), and read the error's own stack - `_runInlinedModule` said the
failure was in an inlined dependency, not in the suite named in the FAIL line.
Corollary for this repo: a `.mjs` under `scripts/` that any test imports must not
carry a shebang. Second corollary: one load-time throw can be counted as two
failing files, so a failure count is not a count of broken files.

**Ref** - #2062, `fix/vitest-shebang-parse-0812`, 2026-08-12

---
