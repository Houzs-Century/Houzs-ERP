## A conversion reached AutoCount with no line identity, and said nothing about it [high]

**Symptom.** Thirteen goods receipts raised on 2026-09-11 between 10:25 and
11:01 sat HELD BACK with *"The ERP cannot tell which lines AutoCount already
has"* — and every one of them was keyless on **ALL** its lines (`2 of 2`,
`7 of 7`, `14 of 14`), not on one added line. The queue reported them SENT at
the time. Nobody learned there was a problem until staff edited the documents
hours later and were refused whole.

**Root cause.** Storing the DtlKeys AutoCount assigns has always been
best-effort, and every way it can fail was SILENT:

- `readConvertTargetLines` returns `undefined` on any doubt — no id, an
  unreadable table, no rows — and the drain then never calls `persistLineKeys`
  at all;
- `persistLineKeys` has five more declining branches (no lines reported, the two
  lists differ in length, the codes do not correspond, a same-code line whose
  Desc2 differs, a repeated code with no Desc2 to separate it), and each one
  `return`ed after a `console.error`;
- a per-row write failure logged `partial` and the function still returned as
  though it had succeeded.

**Every one of those goes to a Worker log this account cannot read.**
`wrangler tail` on `autocount-sync-api` is DENIED for this token — the
2026-09-11 handoff records the identical blind spot for the relink sweep. So the
mechanism that was supposed to prevent divergence reported success while
leaving the ERP and the account book unable to name the same line.

**The refusals themselves are right and are not touched.** A missing key is
refused loudly by `composeEdit`; a WRONG key is not refused at all — it silently
edits somebody else's line in a live account book on the next save. Storing by
position where the lists do not correspond is exactly that. The bug was never
the caution; it was doing it in private.

**Fix.** `persistLineKeys` returns the reason it did not store (`null` when the
keys landed), the drain writes it onto the outbox row instead of clearing
`last_error`, and the missing-`lineWriteback` case on a conversion gets a reason
of its own. A `sent` row carrying a reason is a document that IS in the book and
whose next edit will be refused — `acNeedsAttention` branches on STATUS, so the
note reports without crying wolf, which is the property the not-carried reason
already relies on at enqueue. The health workflow prints them under
**IN AUTOCOUNT, BUT WITH NO LINE IDENTITY**, naming each document and its
reason. The `console.error` lines stay: they carry detail a one-line reason
should not.

**A partial now reports.** `composeEdit` refuses a document with ANY keyless
line, so one failed row costs the whole document its next edit exactly as a
clean miss would. Returning success there was a second, quieter version of the
same bug.

**`isConvertOp` is derived, not listed.** It asks `CONVERT_TARGET`, the way
`SALES_CONVERSION` does, so a fifth conversion joins it on its own rather than
waiting for somebody to remember a second list.

**Tests.** Six in `autocount-line-keys.test.ts` — a new file; nothing covered
this function before — all RED against the unfixed tree, which returned `void`:
the keys land and every row carries its own; no lines reported; lists of
different lengths; codes that do not correspond; a repeated code with nothing to
separate it; and a partial write reporting rather than passing. `scm/lib` whole:
2284 passed. `typecheck` clean.

**Not fixed here.** WHY the keys go missing on a given conversion — whether the
host build reports no lines for `po_to_gr`, or the target read fails — is still
open. This makes the failure visible the moment it happens instead of days
later, which is what was needed before that can be diagnosed at all.

**Ref.** 2026-09-11. Repairing the documents already stuck is `docs/bugs/0812`.
