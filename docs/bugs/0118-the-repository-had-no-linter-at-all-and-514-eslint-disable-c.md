## The repository had no linter at all, and 514 `eslint-disable` comments addressed to one that was never there [high]

**Symptom** — not a single incident; a whole family of them. Eleven entries in
this file are defects a type-aware linter reports for free: a floating promise
that leaked a timer and skipped a production frontend release, an `as never`
that silenced a real type error, a condition that could never be false because
the value was already non-nullable. Each was found by a person, after it shipped.

**Root cause** — `git ls-tree origin/main | grep -cE "eslint\\.config|\\.eslintrc"`
returned **0**. There was no ESLint configuration anywhere in the repo, in
either app. Meanwhile `git grep -c eslint-disable` over `backend/src` and
`frontend/src` returns **514 comments across 159 files** — written over months,
addressed to a linter that has never run. They were pure decoration, and worse
than nothing: they read as evidence that a check exists.

**Fix** — type-aware ESLint 9 in both apps (`backend/eslint.config.mjs`,
`frontend/eslint.config.mjs`), sharing one rule set in
`scripts/eslint/houzs-lint-rules.mjs`, where every rule cites the BUG-HISTORY
entry it answers. Wired to CI as `lint (backend)` and `lint (frontend)`.

Every rule is `warn`, deliberately: the gate is `scripts/lint-ratchet.mjs`,
which holds a PER-FILE CEILING that may only fall. The tree starts at
`no-unnecessary-condition` 2,617 / `no-explicit-any` 989 /
`no-floating-promises` 1 / `no-restricted-syntax` 166 in the backend and
1,807 / 538 / 799 / 140 in the frontend, across 309 and 344 files. Failing the
build on 7,046 pre-existing warnings on day one is how a lint layer gets
deleted in week two; pinning them and refusing growth is how it survives. A
file absent from the manifest has a ceiling of ZERO, so a NEW file is held to
the clean standard immediately.

**Proved, not assumed** — each rule was mutation-tested: the defect from its
cited BUG-HISTORY entry was re-introduced and the rule had to fire on it.

**Class** — *a rule that lives only in prose*, docs/bug-classes.md. The
`eslint-disable` comments are the sharpest instance this repo has produced: 514
suppressions of a check that did not exist.

**Two defects in the gate itself, found while landing it** (2026-08-14) —

*The linter's own gate was a binary file.* `scripts/lint-ratchet.mjs` carried two
RAW NUL bytes, at offsets 5023 and 8650, as the separator in its
`` `${file}<NUL>${rule}` `` map keys — the exact shape
`merge-duplicate-fabric-colours.mjs` was fixed for. Git therefore classified it
binary: `git diff --numstat` answered `-` `-` for it, so the PR that introduces
this repo's first linter showed **no reviewable diff for the linter**. Caught by
`backend/tests/noNulBytesInSource.node.mjs`, which is why `backend-typecheck` was
red at 132 of 133 rather than for anything about types. Fixed by writing the
two-character escape `\0`; `` `${rel}\0${rule}` `` is the identical string at
runtime, and the file is text again.

*`--update` wrote ceilings UP.* The block wrote the current `counts` wholesale,
so re-baselining against a moved main raised every ceiling main had grown past —
measured on the merge that brought #2127 in: `categories.ts`
no-unnecessary-condition 5 -> 6, `mfg-products.ts` no-explicit-any 3 -> 4,
`sku-usage.ts` no-unnecessary-condition 1 -> 2, in a run that printed only
"wrote 319 file ceilings" and exited 0. CLAUDE.md, this file's own `_readme` and
the previous re-baseline's commit message all state that it refuses to do that;
none of them was code. It is now: `--update` names every pair that would rise,
writes nothing and exits 1. Mutation-proved — `grns.ts` forced to a ceiling of 10
against an actual 74 gives exit 1 and an unchanged file (same md5). A pair with
**no** committed ceiling still gets a starting number, and every one is now
printed by name, because that is the only direction a number may move up.

The three growths above were then fixed at source rather than absorbed. All
three were folds left over *above* an error early-return #2127 had just added —
`(refs ?? [])`, `(skus ?? [])`, `dup && dup.length` — i.e. the very
absence-reads-as-empty shape that PR removed, re-entering one line below its own
fix. The fourth was `patchMfgProductHandler = async (c: any)`, in a file that
already defines `AppContext` and already uses it; typing it surfaced the `dup &&`
fold that the `any` had been hiding from the type-aware rules.

**Ref** - `eslint-layer`, PR #2137, 2026-08-14
