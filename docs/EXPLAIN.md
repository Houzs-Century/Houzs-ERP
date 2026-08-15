# explain — ask this repo a question and get the same answer every time

```bash
node scripts/explain.mjs             # what can be asked
node scripts/explain.mjs <id>        # answer one
node scripts/explain.mjs --all       # answer all
```

## Why it exists

Two complaints, one cause.

**"The same question gives a different answer each time."** It did. The answer
was re-derived by reading code, and reading is not repeatable: two sweeps of this
repo counted the same population as 632 and 1019; `CLAUDE.md` carried a
required-status-check list that was wrong; a route-module count taken twice in
one hour came out 76-of-141 and then 70-of-134, because one of the two counted
`.test.ts` files as route modules.

**"The docs do not match the source."** `codebase-map-facts.md` sat stale for
three weeks. This file's parent described the database as D1 SQLite for a month
after the Postgres cutover. `check-docs-drift` catches a claim whose PATH is
gone; it cannot catch a claim whose NUMBER is wrong.

An answer here is **computed from the tree, every time**, and carries two things
that make it checkable by someone who does not trust it:

- a **denominator** — "76 modules have no guide" is unarguable; "76 of 141" is
- **refs** — `file:line`, so the reader goes and looks instead of believing

## What is enforced

| property | how |
|---|---|
| the same question gives the same answer | `scripts/explain.test.mjs` runs **every question three times** and compares bytes |
| a scan that finds almost nothing REFUSES | every question declares `minCorpus`; under it, `ask()` throws instead of answering "0, all clear" |
| an answer nobody can check is rejected | no denominator, or no refs, is a hard error at registration and at answer time |
| a doc holding an answer cannot go stale | `--check-docs` recomputes every embedded block and fails when it disagrees |

That third row is the one this repo keeps paying for. Three checkers here have
reported a clean run because their pattern stopped matching. `minCorpus` makes
"the corpus is empty" a different outcome from "the answer is zero".

## Embedding an answer in a doc

Put the block in; `--write` fills it; `--check-docs` fails if it drifts.

```markdown
<!-- explain: migration-trees -->
<!-- /explain -->
```

A number inside such a block cannot go stale without a red gate, which is the
only reason to trust one.

The example above stays empty on purpose, and the tool has to leave it that way:
`--write` skips anything inside a ``` fence. That was this tool's first bug — it
filled its own example, so the instructions demonstrated the opposite of
themselves. `scripts/explain.test.mjs` pins it.

### Live examples

Both blocks below are filled by `node scripts/explain.mjs --write` and verified
by `--check-docs` on every PR. If either is wrong, the gate is broken — not the
doc.

<!-- explain: migration-trees -->
LIVE is backend/src/db/migrations-pg (292 files). backend/src/db/migrations is the D1/test tree (148 files) and production never reads it.
deploy.yml runs scripts/pg-migrate.mjs at line 212 — that is what makes the -pg tree live.
refs: .github/workflows/deploy.yml:212, backend/src/db/migrations-pg/, backend/src/db/migrations/
<!-- /explain -->

<!-- explain: route-guides -->
70 of 134 route modules are named in none of the 27 module guides.
first ten with no guide:
  backend/src/scm/routes/accounting.ts
  backend/src/scm/routes/addons.ts
  backend/src/scm/routes/amendment-mirror.ts
  backend/src/scm/routes/ar-reconciliation.ts
  backend/src/scm/routes/categories.ts
  backend/src/scm/routes/currencies.ts
  backend/src/scm/routes/customer-mirror.ts
  backend/src/scm/routes/delivery-fees.ts
  backend/src/scm/routes/delivery-messages.ts
  backend/src/scm/routes/entity-audit-log.ts
refs: docs/modules/, backend/src/scm/routes/, backend/src/routes/
<!-- /explain -->

## Adding a question

`scripts/lib/explain/questions.mjs`. Add one whenever a question costs someone a
re-read of the codebase. Each carries:

- `id`, `question` — the slug and the question in plain words
- `why` — **the wrong answer it replaces.** Not decoration: a question with no
  history of being answered wrongly is usually a question nobody asks.
- `minCorpus` — the floor under which it refuses
- `answer(root)` — computed from files under the repo root. **No network, no
  git, no clock.** Determinism is the property, and the three-run test enforces
  it: a directory listed without sorting will fail there.

## What it is not

It does not read production. Every answer is about the SOURCE — which is exactly
the distinction `CLAUDE.md` draws: source describes intent, the running system is
the fact. A question about live data belongs in a `workflow_dispatch` check
against `secrets.DATABASE_URL`, not here.
