## A refused delivery order or goods receipt edit was never sent again once its line keys were fixed [medium]

**Symptom.** After the line keys of the write-back's delivery orders and goods
receipts were filled on 2026-09-14 (the relink sweep's apply run at 13:05Z and
the DocTransfer stamp, run 34847683795), their earlier refused edits still sat
in the outbox as `skipped` with nothing queued behind them. A plan run found 3
such documents — HC-DO-2609-039, HC-GRN-2609-006 and HC-GRN-2609-028 — whose
changes had not reached AutoCount and would not until someone happened to save
them again.

**Root cause (traced).** A keyless-line refusal is written by `enqueueEdit`'s
catch as a `skipped` row with `payload: { body: {} }`, so there is nothing to
retry. Two recovery paths existed and neither covers this case:

- `backend/src/scm/lib/autocount-requeue.ts` takes no edits on purpose (its
  header: "fix the cause, save the document again");
- `backend/src/scm/lib/autocount-relink-sweep.ts` queues the keyed edit only on
  the run that itself stamped the last missing key (`completesKeying` requires
  `progressed > 0`), so a document keyed by anything else — the DocTransfer
  stamp — is already complete when the sweep sees it and gets nothing.

Two of the three also carried a row added on the receipt with no purchase line
(a stool; ten pillows), which no key will ever exist for; the sweep's
`declaresNew` would send it as a new line, but again only on a run that stamped
something.

**Fix.** `backend/scripts/requeue-keyed-conversion-edits.mjs` (workflow *Re-send
refused DO / GR edits once every line is keyed*) queues the edit through the
Worker's own `enqueueEdit` for a DO/GR whose newest keyless-line refusal has no
pending or sent edit after it and whose lines are all keyed — or whose only
keyless rows have no source line while the book snapshot shows every book line
already claimed, in which case they travel as `IsNewLine`. Plan by default,
CONFIRM on apply, verified on a fresh connection. Plan against production
2026-09-14 after the stamp: 3 documents, 0 held.

**Ref.** fix/ac-requeue-keyed-edits, 2026-09-14.
