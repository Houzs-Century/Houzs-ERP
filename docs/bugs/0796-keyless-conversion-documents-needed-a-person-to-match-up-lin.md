## Keyless conversion documents needed a person to Match up lines, so they never reached AutoCount on their own [high]

**Symptom.** Delivery orders and goods receipts (e.g. `HC-DO-2609-020/021/022/028`,
`HC-GRN-2609-008`) sat on the AutoCount "not accepted" list as `keyless-line`.
The account book already held the document; a later edit could not sync because
the ERP lines carried no `linked_ac_dtlkey`, so sending would append a duplicate
line — which on a purchase document cannot be removed. The screen's remedy is
"Match up lines, then save again" — a person, one document at a time. With
nobody to press it, the documents stayed out of the book indefinitely.

**Root cause (traced).** Matching a line up means READING THE LIVE account book
(`/doc-read`), which only the Worker can do — `AC_SYNC_URL` / `AC_SYNC_KEY` are
Worker secrets and, correctly, are forbidden in Actions (the DB is one shared
book and the key bypasses RLS), so no `workflow_dispatch` could drive it. And
re-queuing does not help: for a conversion document requeue only ever attempts a
REBUILD, which `rebuildAllowed` refuses for conversion-built types
(`autocount-requeue.ts` `editRebuildVerdict`). The only thing that sends a keyed
edit after the keys exist is a fresh ERP save — a human action.

**Fix.** A hands-free sweep on the Worker's own 5-minute cron
(`scm/lib/autocount-relink-sweep.ts`, wired in `src/index.ts`). It ships DARK:
`scm.app_config 'scm.autocount_relink_sweep'` is `off` (unset) → no-op; `plan` →
read the book and REPORT what it would stamp/queue, writing nothing; `apply` →
stamp the book's line keys onto our rows (link, never money or stock; ambiguous
lines refused, never guessed — same guarantee as the button), then queue a KEYED
edit via `enqueueEdit` (no rebuild) that the existing drain sends. Two invariants
keep a live book safe: the keyed edit is queued only on the run that FINISHES the
keying (`stamped > 0` and no line left keyless), so a document is never
re-queued once keyed and never handed to `enqueueEdit` while a line is still
keyless (which would append). `enqueueEdit` self-gates on the write-back switch,
so both switches must be on to move anything; the relink half is the same either
way. Bounded to 25 documents per slot.

Pinned by `src/scm/lib/autocountRelinkSweep.test.ts`: off is a no-op, plan writes
nothing, apply stamps every key and queues one edit only when the run completes
the keying, an ambiguous line is refused and never queued, and a document already
fully keyed (stamped 0) is not re-queued.

**Ref.** `feat/ac-relink-sweep`, 2026-09-11. Follows the relink route's extension
to DO/GR/IV/PI (`docs/bugs/0792-match-up-lines-400-d-for-do-gr-iv-pi-so-keyless-conversions.md`);
see `docs/ac-durable-sync-fixes-plan.md`.
