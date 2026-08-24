## A whole-tree TypeScript parse inside a unit test made local coverage impossible [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** `npx vitest run --coverage` in `frontend/` produced **no report at
all** on this machine — no `coverage/` directory, so the frontend coverage
ratchet could not be run locally either. Measured on untouched `origin/main`:

```
 ❯ src/api/requestCorrelationInventory.test.ts (8 tests | 1 failed) 17391ms
   × every raw fetch is one exact transport/static-asset callsite 17378ms
Error: Test timed out in 15000ms.
 Test Files  1 failed | 231 passed (232)
```

One file of 232. Bare, the same test took 3.3s. And no CLI flag could rescue
it: the budget was an inline `}, 15_000)` third argument, which **overrides**
`--testTimeout`.

**Root cause (traced).** The test TypeScript-parses the whole `frontend/src`
tree to prove that every raw `fetch` is one exact, named callsite. Profiled on
this machine, uninstrumented: 39ms to walk 891 files, ~590ms to read 15.3 MB,
and the rest — ~3.6s cold — inside `ts.createSourceFile` + the AST walk over the
321 files whose text contains the substring `fetch`. Under the v8 coverage
provider that parse is what balloons, because every call inside the TypeScript
parser is being counted. The work was never a test's work; it was a
whole-repository static check wearing a test's clothes, and the inline timeout
was the tell.

Raising the number was the answer to reject — it drifts again on the next
slower machine, and it had already been raised once.

**Fix.** The scan moved to `frontend/scripts/check-raw-fetch-inventory.mjs`,
run once per CI job in a plain node process (`npm --prefix frontend run
check:raw-fetch`, wired into `frontend-typecheck`, which the required `frontend`
roll-up covers — so it still blocks a merge). The pure rules keep unit tests in
`frontend/scripts/check-raw-fetch-inventory.test.mjs` under `node --test`, where
the alias-bypass probes cost under a millisecond each. The vitest file is gone,
and the inline timeout with it.

The pre-filter was also tightened from `text.includes("fetch")` to a word match,
which drops `refetch` / `prefetch` / `fetchBlobUrl` and takes the parse set from
321 files to 238. That is an optimisation, so it carries its own assertion: a
test parses every file the filter REJECTS with the same AST rules and fails if
any of them holds a `fetch` node. Without that, a tightened filter is exactly
the shape CLAUDE.md names — a checker that cannot match reporting a clean run.

Measured after:

| | before | after |
| --- | --- | --- |
| the scan | 17,378ms (instrumented, failed) / 3.3s bare | **782ms**, plain node |
| `vitest run --coverage` | no report written | 231 files, 2378 tests, `coverage/coverage-final.json` written, suite 75.4s (was 84.7s) |
| frontend coverage ratchet, locally | could not run — no report | `frontend/src 18.83% vs floor 13.01%, no-test 310 vs floor 351`, exit 0 |

Proved RED: planting `export const probe = () => fetch("/api/secret");` in
`frontend/src/lib/staleBuild.ts` makes the script print the drifted inventory and
exit 1.

**Ref.** perf/fetch-inventory-budget, 2026-08-21.
