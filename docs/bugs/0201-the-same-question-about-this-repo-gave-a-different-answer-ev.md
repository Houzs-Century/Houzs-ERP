## The same question about this repo gave a different answer every time it was asked [high]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom, in the owner's words (2026-08-14):** *"现在有的问题就是每次问的答案都不
一样，如果我问你这个 ai 你给我的答案都是错的"* — and, the next day, *"我问你同一个
问题问三次，你应该给出的都是同样的答案"*.

He is describing a real property of this repo, not an impression:

| the question | answers it has given |
|---|---|
| how many SCM handlers are there? | 632, then 1019 — the checker changed, not the code |
| how many route modules have no guide? | 76 of 141, then 70 of 134, **one hour apart** — one count included `.test.ts` files |
| which status checks block a merge? | `CLAUDE.md` carried a list that was wrong, twice |
| how many unscoped writes? | 0, then 20 — the matcher had been dead |
| how many lines of file-size debt? | 1,430 then 1,391, hours apart, while it was being written down |

**Root cause.** Every one of those answers was RE-DERIVED BY READING, and reading
is not repeatable. Two readers grep differently, one includes a directory the
other does not, and both write the number into a doc where it then rots. The
`audit:` generators fixed this for four artifacts; everything else was still
answered from memory or from a fresh grep.

**Fix.** `scripts/explain.mjs` — a registry of questions, each COMPUTED from the
tree. An answer is only registerable if it carries:

- a **denominator** — "76 modules have no guide" is unarguable; "76 of 141" can
  be checked
- **refs** — `file:line`, so the reader looks instead of believing
- a **`minCorpus`** — under it the question REFUSES. Three checkers here have
  reported a clean run because their pattern stopped matching, so "the scan found
  nothing" is now a different outcome from "the answer is zero", by construction.

Five questions to start, each one chosen because it is in the table above.

**The property is tested, not promised.** `scripts/explain.test.mjs` runs every
question **three times** and compares the answers BYTE FOR BYTE. Proven red: an
injected `Math.random()` in one answer fails it with
`so-statuses: run 1 and run 2 disagree`. A question that lists a directory
without sorting fails there too, which is the point.

**And the docs are wired to the same source.** A doc can hold
`<!-- explain: <id> -->…<!-- /explain -->`; `--write` fills it and `--check-docs`
fails when it drifts. That is the gap `check-docs-drift` cannot cover — it
resolves PATHS, so a doc whose file exists and whose NUMBER is wrong reads as
clean. Proven red: editing `292 files` to `999 files` in the filled block fails
`--check-docs` with exit 1.

**Its own first bug, kept as the example.** `--write` filled the EMPTY EXAMPLE
block inside `docs/EXPLAIN.md`'s ``` fence — the page teaching you to write an
empty block demonstrated a filled one. Fills now skip fenced regions, and a test
pins the example's emptiness.

**Ref.** 2026-08-15. `docs/EXPLAIN.md`. Lesson: **"the same answer every time" is
a property you can test, not a discipline you can promise** — and the test is
three runs and a byte comparison.
