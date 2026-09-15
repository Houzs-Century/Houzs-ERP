## Cleared documents that reached AutoCount still read as not sent, and the archive script cleared unfinished ones [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The owner's screenshot of the AutoCount Sync page on 2026-09-15
showed **CLEARED 22**, and he read it as 22 documents that had not reached
AutoCount: 「Not accepted 和 Clear 这一边也是要进完」. Checked against the queue
and the book the same day, 21 of the 22 were in AutoCount.

**Root cause (traced).**

- **The script had no verdict.** `archive-ac-outbox-docs.mjs` cleared documents
  by number with no check of its own. Dispatched on 2026-09-10, it cleared
  documents whose refusal was still open, which the page's own archive refuses
  (`acArchiveVerdict`).
- **The later arrivals never joined the shelf.** Those documents reached
  AutoCount later, under new rows the page shows as live. Their old refusals
  stayed on the Cleared shelf, where the page judges them only against the
  document's other cleared rows, so they kept a refused badge.
- **Six refusals were filed under a row id.** The refusals of HC-DO-2609-019,
  -020, -021, -022, -028 and HC-PO-2609-001 were filed under the document's row
  id instead of its number (docs/bugs/0774). The page could never join them to
  the document at all.

Every figure here comes from a read-only run of the plan against production on
2026-09-15. Of the 22 cleared document keys:

- 18 were cleared by the script and had since arrived;
- 3 were cleared by a person on the page on 2026-09-08 (old test documents);
- 1 (HC-GRN-2609-008) had not arrived. It was sent later the same day, after
  0915's fix.

**Fix.**

- **The judgement.** `backend/scripts/lib/cleared-arrived-plan.mjs` imports the
  page's own `acOutboxState` and `acRefusalPredatesArrival` rather than
  restating them.
- **The restore tool.** `restore-arrived-ac-outbox-docs.mjs`, with its workflow,
  puts every script-cleared document that has arrived back on the list. It
  re-files each id-filed refusal under the document's number first. It has
  plan / confirm / verify on a fresh connection, and the verify re-reads each
  restored document by the page's rule. Documents a person cleared, and
  documents not in AutoCount, stay cleared and are listed.
- **The archive guard.** `archive-ac-outbox-docs.mjs` now skips, with the
  reason, any named document that has a waiting send or a refusal no arrival
  came after. It runs under tsx.

Pinned in `backend/tests/clearedArrivedPlan.test.mjs`, 7 tests built from the
production shapes:

- a refusal cleared and later sent;
- an id-filed refusal;
- GRN-008 refused three minutes after it arrived;
- a person's clear;
- a waiting send, a document that never arrived, and an unresolvable id;
- a re-queued refusal;
- the archive verdict.

This is a new module, so the tests were not first run on an unfixed tree.

**Ref.** fix/ac-cleared-arrived, 2026-09-15.
