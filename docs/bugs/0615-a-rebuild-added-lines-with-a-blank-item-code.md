## A rebuild added lines with a blank item code [high]

<!-- area: AutoCount sync + write-back -->

**Symptom, and it reached the live account book.** HC-SO-013394 was re-sent as a
rebuild on 2026-09-02 and landed: the book went from ten lines to eight, matching
the ERP, with the `[ERP-CANCELLED]` line gone. **Seven of those eight lines came
back with an empty `ItemCode`.** Measured on the host, `AED_HOUZS`, minutes after
the send:

```
DtlKey  ic                     Qty  Seq
919847  []                     2    16
919848  []                     6    32
919849  []                     1    48
919850  []                     1    64
919851  []                     1    80
919852  []                     1    96
919853  []                     2    112
919854  [JM-CL JAC WP MP (Q)]  1    128
```

Quantities, sequence and Desc2 were all correct. Nothing failed, nothing warned:
the outbox recorded `sent`, the queue read `pending 0 / failed 0`, and the host
log was clean.

**Root cause (traced, two faults compounding).**

1. **`composeEdit` strips `ItemCode` from every keyed line, on purpose.** The
   reasoning is sound and still stands: the ERP's answer for the collapsed sofa
   codes is a POLICY, not a reading of the book, so sending it on an edit would
   silently re-point the 194 real book lines those two brand items hold. The
   strip is right for an EDIT — which changes a line the book already owns.
2. **A rebuild is not an edit.** It clears the details and ADDS the lines, and a
   line being added has nothing to inherit. The rebuild path reused the same
   `Lines: keyed` array, so every line arrived with no item code at all.
3. **The host swallowed it.** `Set(() => d.ItemCode = Str(it, "ItemCode"))` —
   and `Set()` swallows, by design, for fields where a failure is tolerable.
   Assigning an absent key gave `""`, silently, so the blank lines were added
   with every log line green. The one line that kept a code was the keyless one,
   which the strip never touched.

**Fix, in both halves.**

* `effOpts.rebuild` is now DERIVED and authoritative —
  `{ ...opts, rebuild: shouldRebuild(opts, docType, retired) }` — so a caller's
  explicit request is cleared when the document may not be rebuilt, and every
  reader downstream can trust one field. That mattered immediately: the line
  mapper became a third reader, and a flag meaning "asked for" rather than
  "happening" would have put an item code on a document that was not rebuilding.
* The line mapper puts the code back on a rebuild only:
  `...(effOpts.rebuild ? { ItemCode: acItemCode } : {})`. The keyed path is
  untouched, so the 194 lines stay where they are.
* `AcSyncService` no longer wraps the assignment. A new line with no item code
  now THROWS and the document is refused, because a blank line in a licensed
  ledger is worse than a refused send.

**What this cost, and the lesson.** The first verification checked the line COUNT
— eight against the ERP's eight — and stopped there. The count was the thing that
had been wrong before, so it was the thing that got checked. **A rebuild path is
a CREATE path wearing an edit's data structure**; it needed to be checked against
what a create must carry, not against what the edit was missing. The recovery is
cheap only because the ERP still holds every line: re-sending the corrected
rebuild restores the codes.

**Recovery.** UNTESTED at the time of writing — the fix is merged and the host
rebuilt, and the document is re-sent afterwards. The result is recorded in the PR
and in `tasks/HANDOFF-2026-09-02.md`.

**Verified.** `backend/src/scm/lib/autocount-requeue-edit-rebuild.test.ts` gains
"every line in a rebuild payload carries an ItemCode", proven RED first
(`line 1 would be added blank: expected '' not to be ''`), and its companion
"an ordinary keyed edit still sends no ItemCode at all" pins the half that must
not move. `backend/tests/acRebuildDetails.test.ts` pins both source shapes,
including that the host assignment is NOT inside `Set()`. 687 tests pass across
the AutoCount area. `build-local.ps1` — `COMPILES CLEAN - 110592 bytes`.

**Ref.** fix/autocount-rebuild-on-requeue, 2026-09-02.
