## An edit refused because a line added a moment earlier had no AutoCount key yet was never sent again [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** On 2026-09-15 at 06:55Z the AutoCount Sync page showed NOT ACCEPTED 1:
HC-SO-011153.

- 06:14:33: a user added line 9, `DIVAN ONLY-(SS)`, to the order.
- 06:14:34: an edit declaring that line new was queued. It was sent at 06:15:13,
  and line 9 stored its key, 931773.
- 06:14:35: the next save was refused with `KeylessLineError`, line 9.

The refused save stayed on the page until it was re-sent by hand
(`resend-ac-document-edits`, run 34939289465, sent 07:00:28Z). The book then
held 9 lines with one DIVAN line, key 931773.

The same class hit HC-SI-2609-001 on 2026-09-14: "edited before its AutoCount
counterpart existed".

**Root cause (traced).** Both refusals are about timing, not about the document.

- The keyless refusal is written by `noteReadFailure` in
  `backend/src/scm/lib/autocount-outbox.ts`.
- The before-counterpart refusal is written by `enqueueEdit` while the
  document's conversion is still pending.

Both are `skipped` rows with `payload: { body: {} }`, so there is nothing to retry.
`dispatchOne` does store the key of a line an edit added (`persistNewLineKeys`)
and a conversion's keys (`lineIdentityGap`). Nothing then looked back at the
refusal that was waiting for exactly that. The operator had saved and moved on.
The existing re-send script (`requeue-keyed-conversion-edits.mjs`,
docs/bugs/0900) is run by hand and covers delivery orders and receipts only.

**Fix.** New module `backend/src/scm/lib/autocount-held-edit-resend.ts`.
`dispatchOne` calls `resendHeldEdits` after it marks any row sent.

It looks for a `skipped` edit of the same document (same company, not cleared)
whose reason begins with one of the two timing refusals, and is not already
re-queued. It re-sends only when both hold:

- no edit of the document is still pending;
- no edit carrying lines has been sent since the refusal. The payment's
  header-only edit (`Lines: []`) does not count: it carries the balance, not the
  refused save's lines.

When that is true it composes the document **as it is now** through the ordinary
`enqueueEdit`, then marks the old refusals `[re-queued ... -> sent again by itself
after <op> reached AutoCount]`. The page already counts that mark as history.

- An SO is composed by its number; other types by their row id, and nothing is
  queued without one.
- If the composer refuses again, the old refusal keeps its text. The new refusal
  is written as usual.
- Best effort: a failure here leaves the sent row sent and the refusal as it was.

Pinned in `backend/src/scm/lib/autocount-held-edit-resend.test.ts`, 11 tests. The
HC-SO-011153 sequence runs end to end through the real `enqueueEdit` and
`dispatchOne` with a fake host. It checks two things: the new edit carries keys
931769 and 931773, and no line is declared new. With the call in `dispatchOne`
removed, that test fails ("the refused save was not composed again"). The
controls cover:

- an edit still queued;
- an edit of the lines sent after the refusal (a payment edit does not count);
- a refusal about the document itself;
- an already re-queued row, a cleared row and another company's row;
- a second refusal from the composer.

The 41 AutoCount test files pass: 823 passed, 7 skipped.

**Not covered.** A delivery order, receipt or invoice converted before the office
host swap still arrives without line keys. Its re-composed edit is refused as
keyless and written down; stamping the keys and
`requeue-keyed-conversion-edits.mjs` remain the path until the swap.

**Ref.** fix/ac-held-edit-resend, 2026-09-15.
