## A failed changes job skipped its dependants and the CI roll-ups read that as green [medium]

**Symptom.** Not seen in a run; found while measuring CI (docs/ci-fast-lane.md §3.3,
2026-09-15). If `ci.yml`'s `changes` job had failed, every frontend test job would
have been skipped and the required `frontend` context would still have passed.

**Root cause (traced).** Every frontend job and `backend-tests` carry
`needs: changes`. A failed `needs` makes the dependant `skipped`, and the
`frontend` / `backend` roll-ups' `ok()` accepted `success|skipped` without ever
looking at `changes`. A job skipped by `if:` also reports success to a required
check (GitHub docs, *Using conditions to control job execution*), so nothing
downstream could catch it. The same shape would have applied to the merge-queue
reuse gate added in the same PR.

**Fix.** Both roll-ups now need `changes` and call `must_succeed changes`; the jobs
gated on the queue reuse (`backend-typecheck`, `lint`, `file-size`,
`e2e-contract`) run whenever `changes` did not succeed.
`scripts/ci-queue-reuse.test.mjs` pins both; proved RED by deleting the
`must_succeed` line from one roll-up (1 failing test) and the gate from `lint`
(1 failing test).

**Ref.** chore/ci-queue-reuse, 2026-09-15.
