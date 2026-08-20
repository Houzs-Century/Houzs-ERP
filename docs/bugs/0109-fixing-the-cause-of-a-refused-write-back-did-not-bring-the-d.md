## Fixing the cause of a refused write-back did not bring the document back [high]

**Symptom** - `HC-SO-2608-002` was refused with `MissingLocationError` and
written to `scm.autocount_outbox` as `skipped`. The owner then set the delivery
address, so the order carries `sales_location = PG WAREHOUSE` and the stated
remedy - "set the warehouse on the line, or the sales location on the document"
- was satisfied. Re-running the health check on 2026-08-13 afterwards: the same
two `skipped` rows, unchanged, nothing pending. The order was never going to
reach AutoCount, and nothing in the ERP said so.

**Root cause** - a `skipped` row is TERMINAL and no path re-asks the question.
`enqueueSoCreate` is called from exactly two places in `mfg-sales-orders.ts` -
the create itself, and the `DRAFT -> live` transition - and an ordinary edit is
neither, so re-saving the order never re-attempts the create. The obvious
fallback does not fire either: `enqueueEdit` bails on
`if (!composed.linkedAcDocNo) return false;`, because a document that never
reached AutoCount has no counterpart to edit. So the queue recorded the
divergence correctly, named the remedy correctly, and then had no way to act on
the remedy once it was applied. Both stuck documents (`HC-SO-2608-001`,
`ItemCodeError`, and `HC-SO-2608-002`) were in this state.

**Fix** - `backend/src/scm/lib/autocount-requeue.ts` +
`backend/scripts/requeue-autocount-skipped.mjs` + the *AutoCount write-back -
re-queue a refused document (DRY-RUN gated)* workflow. It re-runs the SAME
`enqueueSoCreate` / `enqueuePoCreate` the route runs, against the document as it
is now - never the stored payload, which is `{}` on a refusal and would be the
pre-fix order even when it is not. The script runs under `tsx` and imports the
real enqueue from `src/`, the same way `recompute-2990-so-allocation.mjs` and
three other workflows already reuse canonical service code, because a second
composer in `.mjs` is the one outcome that could push a document the real
composer would have refused. DRY RUN is the default and is not a prediction:
`captureWrites` runs the real enqueue and records the write instead of
performing it, so the dry run and APPLY differ only in whether the row lands.
A re-queued skip keeps status `skipped` (0277's CHECK admits four statuses and
every one would be a lie) and has its reason prefixed
`[re-queued <when> -> outbox <id>]`; the health check now reports those rows
separately so they stop reading as backlog.

**Lesson** - **a queue that records a refusal owes you a way to withdraw it.**
Every refusal in this module was designed with care - the reason is durable, it
names the remedy, and the health check prints it - and the whole chain still
dead-ended, because "the operator fixes the cause" was assumed to re-enter the
system through a door that only opens on create. When a check writes down "fix
X and try again", the "try again" is part of the feature, not the operator's
problem.

**Ref** - `feat/autocount-requeue-skipped`, 2026-08-13.

---
