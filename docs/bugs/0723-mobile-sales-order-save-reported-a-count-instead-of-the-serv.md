## Mobile Sales Order save reported a count instead of the server's refusal, so an AutoCount-locked order told the owner to try again forever [high]

**Symptom.** The owner, on his phone, changed the fabric/colour on a Sales Order
and pressed Save. He got *"2 line change(s) did not save. Your edits are still
here; try Save again."* He retried repeatedly and it never worked:
「我是edit 要process 但是一直不能」.

**Root cause (traced).** `frontend/src/mobile/MobileNewSO.tsx` `applyLineDiff`
made three server calls in loops — a line DELETE, a POST and a PATCH — and each
was wrapped in a bare `catch { failed += 1; }` (lines 1627 / 1640 / 1646 on
`origin/main` at `5c392d4d3`). The server's refusal was discarded at the moment
it arrived, and the caller (`:2034`) built its sentence out of the count alone.

The refusal being discarded was the migrated-SO lock:
`backend/src/scm/lib/migrated-so-readonly.ts` answers **409
`so_migrated_readonly`** and carries its own operator sentence on BOTH `reason`
and `message`; `soDocNoFromPath` takes the segment after `mfg-sales-orders`, so
`/mfg-sales-orders/:docNo/items/:id` is covered too. `authedFetch` had already
humanised that body — `so_migrated_readonly` is in `SERVER_SENTENCE_WINS`
(`frontend/src/vendor/scm/lib/authed-fetch.ts`), so the server's own words win —
and had stashed `err.status`/`err.body` on the Error. Both were thrown away one
line into the client.

So every cause rendered as one sentence: a lock, a permission refusal, a
validation error, a version conflict and a dropped connection alike. That
sentence's advice — *try Save again* — is correct for a hiccup and is the wrong
instruction for a **refusal**, which is a decision that a retry cannot change.
That is what turned one refused save into an afternoon of pressing Save.

This is the repo's own named bug class (CLAUDE.md: *"a failure that reaches
nobody is worse than a crash"*) in its harder-to-see form — the failure DID reach
somebody, stripped of the only part that was actionable.
**`frontend/scripts/check-silent-mutations.mjs` does not cover this shape**: it
scans `useMutation` call sites (365 of them, 0 SILENT), and this path is a raw
`authedFetch` loop, so it was never in scope for the checker.

**Fix.** New `frontend/src/vendor/scm/lib/line-write-failures.ts` — pure, no
React, no fetch — keeps the humanised message AND the status per failed call,
states one shared cause **once** while keeping the count, and attaches retry
advice only where a retry could work (403/409 is a decision, so it says
*"Saving again will not help until this is resolved"* instead).
`applyLineDiff` now returns the reasons rather than a count.
`frontend/src/pages/scm-v2/so-add-lines.ts` — which already named each refused
line — backs onto the same module instead of keeping a second vocabulary, so the
desktop and phone surfaces cannot drift; desktop additionally gains the
shared-cause collapse.

Pinned by `frontend/src/mobile/MobileSoSaveFailureReason.test.ts` (13 tests) plus
a new case in `frontend/src/pages/scm-v2/so-add-lines.test.ts`.

**Proved RED on the unfixed tree.** Both files were copied onto a detached
`origin/main` (`5c392d4d3`) and run there:
`MobileSoSaveFailureReason.test.ts` fails to resolve
`vendor/scm/lib/line-write-failures` (the module does not exist), and the
so-add-lines case fails with main's actual behaviour — the lock sentence printed
three times:

```
Expected: "3 lines could not be saved — This order came from AutoCount and is view-only for now.."
Received: "3 lines could not be saved — SOFA-1: This order came from AutoCount and is view-only for now. · BF-2: ... · MT-3: ..."
Test Files  2 failed (2) | Tests  1 failed | 24 passed (25)
```

This PR does NOT change the lock, lift it, or change what the server allows — it
only makes the refusal legible.

**Not fixed here, same shape:** `uploadStagedPhotos` in the same file
(`catch { failed += 1; }`, then *"N line photo(s) failed to upload"*) discards
the reason identically for the photo path. Left out because it is a different
operation and `MobileNewSO.tsx` is exactly on its file-size ceiling (3748).

**Ref.** `fix/mobile-so-save-reason`, 2026-09-08.
