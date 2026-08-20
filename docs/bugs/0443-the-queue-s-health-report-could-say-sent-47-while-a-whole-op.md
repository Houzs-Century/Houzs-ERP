## The queue's health report could say `sent 47` while a whole OPERATION had never once worked [low]

**Symptom.** No incident — a blind spot found while answering the owner's
question *"SO / DO / SI / PO / GR / PI 的 create、edit、cancel 全部都可以进
AutoCount 了对吗"*. The honest answer needed a per-operation breakdown and
nothing produced one.

**Root cause.** `check-autocount-outbox-health.mjs` groups
`scm.autocount_outbox` by `status` and nothing else. `sent 47` says the queue
works; it says nothing about WHICH operations are in the 47. On 2026-08-18 the
generated coverage table recorded `edit` as never demonstrated against the live
book while forty-odd ERP call sites enqueue it, and `create_po` as never run
through its create arm — neither fact is visible in a status total, and the
status total is what an operator reads.

**Fix.** A per-op split: rows, sent / failed / skipped / pending, the last
`sent_at`, and the newest `host_built_at` behind it (migration 0304 — an
operation that last succeeded under a build nobody runs any more has not been
proven against the one that is running).

**It names the ops that have NO row at all**, which is the part that matters: an
operation the queue has never held is the strongest form of "never proven", and
a table that simply omits it reads like a clean bill. Anything in the table
outside the script's own op list is printed too, so a ninth operation cannot be
invisible to one of that table's two readers.

**Ref.** 2026-08-18.
