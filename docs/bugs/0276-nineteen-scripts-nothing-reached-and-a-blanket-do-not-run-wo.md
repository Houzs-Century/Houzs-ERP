## Nineteen scripts nothing reached, and a blanket "do not run" would have been wrong for six of them [low]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** 19 of 367 scripts in `backend/scripts` were reached by nothing: no
npm script, no workflow, no doc, no import. Several had been run against
production during the June Postgres cutover. The danger is not that they are
stale — it is that the NAMES still read as runnable.

**The recommendation I gave first was wrong**, and reading them is what showed
it. A single header saying "already run, do not re-run" would have been false on
nine of the nineteen. They are three different things:

| class | count | treatment |
|---|---|---|
| one-shot migrations and backfills — `apply-pg-baseline`, `patch-drizzle-pg`, `backfill-sales-reps`, `seed-assr-cases`, … | 10 | header: ALREADY RUN — DO NOT RE-RUN, naming what it did and what a second run would do |
| spent probes — `probe-ports`, `diag-email`, `explain-hot-queries`, … | 6 | header: SPENT PROBE. Read-only, so running them is not dangerous — but they probe an environment that has moved, so the output no longer means what it says |
| **read-only reports** — `report-overpaid-purchase-invoices`, `find-wrong-country-phones`, `list-sales` | 3 | **npm scripts.** These are USEFUL and were unreachable; a gravestone on a working tool is the wrong fix |

Verified read-only before promoting: zero `insert` / `update` / `delete` /
`INSERT` / `UPDATE` / `DELETE` / `ALTER` / `DROP` in all three.

**One of the three was built for a workflow that was never created.**
`find-wrong-country-phones.mjs` emits `::notice::` annotations, which mean
nothing outside GitHub Actions. It is the same shape as the rule
`CLAUDE.md` already records — *a `workflow_dispatch` workflow is not shipped
until it has been dispatched once and reported success* — one step earlier: a
script written FOR a workflow that never landed. It gets an npm script here
rather than a new workflow, because shipping an undispatched workflow is exactly
what that rule forbids.

**Result.** 16 still unreferenced, every one of them now carrying a header that
says why it is there and what it would do if run. 3 promoted to
`audit:overpaid-pi`, `audit:phone-country`, `audit:sales-org` — reachable, and
covered by the existing `npmScriptsResolve` guard.

**Ref.** 2026-08-15.
