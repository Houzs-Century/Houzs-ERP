## doMirror mirrored boolean-cancelled AutoCount DOs as live [medium]

Symptom: A Houzs Delivery Order that AutoCount reported as Cancelled via a boolean `true` (rather than the string "T") was mirrored into `autocount_delivery_orders` with `cancelled = 0`, so the ASSR list's DO No column showed a cancelled DO as a live one.

Root cause (traced, not guessed): `backend/src/services/doMirror.ts` line 99 hardcoded `o.Cancelled === "T" ? 1 : 0` inside `takeDoc`. AutoCount returns `Cancelled` as a real boolean on some endpoints and as the string "T"/"F" on others (documented at `acSnapshot.ts:44-45`). The canonical helper `isCancelled()` (`acSnapshot.ts:47`) normalizes every shape, and siblings `acSnapshot.ts:272` and `po.ts:311` already use it — doMirror was the lone endpoint doing a raw string compare, so any non-"T" truthy shape fell through to 0.

Fix: import `isCancelled` from `./acSnapshot` and replace the string compare with `isCancelled(o.Cancelled) ? 1 : 0`, matching the two siblings. Behaviour is identical for "T"/"F"/absent; only the previously-mishandled boolean/`1`/"true"/"1" shapes change (now correctly cancelled). Ref: (this PR / 2026-08-18).
