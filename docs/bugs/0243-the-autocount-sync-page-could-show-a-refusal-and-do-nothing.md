## The AutoCount Sync page could show a refusal and do nothing about it [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Owner's standing complaint about this screen, in its own subtitle:
*"re-sending a refused document is still the re-queue workflow"*. A `failed` or
`skipped` row means a document is in the ERP and not in the licensed account
book; the page named the reason and the remedy, and then the only way to ACT was
to dispatch a GitHub Action — which the owner cannot do.

**Root cause (not a defect, a deliberate omission that outlived its reason).**
`backend/src/scm/routes/autocount-outbox.ts` said so in its own header: *"There
is no re-queue here … Putting that behind a button is a separate decision the
owner has not made."* The decision has been made. The reason for the caution was
real and remains real: `AcSyncService`'s create has **no guard against a
duplicate ERP document number**, so re-sending a document AutoCount has already
accepted writes a SECOND one into a live licensed book, where a sales order
cannot simply be deleted. The workflow managed that risk by selecting `skipped`
rows only and hiding `failed` behind an `includeFailed` opt-in (#2189). Neither
of those mechanisms can protect a button, which is pointed at whatever row the
reader is looking at — including a `sent` one.

**Fix.** `POST /api/scm/autocount-outbox/:id/requeue`.

- **The ladder is SHARED, not copied.** `requeueSkipped`'s loop body was
  extracted into `requeueOneRow` and both callers climb it. Two ladders would be
  two answers to "may this document be sent again", and the looser one writes the
  duplicate.
- **A `sent` row is refused OUTRIGHT**, before the document is read or composed —
  the refusal the workflow never needed and the opt-in could not express.
  `pending` is refused too (the sweep is already going to send it), and a row id
  belonging to another company answers `row-not-found`, identically to an unknown
  id, because confirming somebody else's id exists is itself a leak.
- **Authorization is a NEW, NARROWER key.** `scm.autocount.requeue` **or**
  `settings.manage`; deliberately not `scm.autocount.read`, which is catalogued
  as the key you hand somebody so they can WATCH the queue. Company resolution
  is `requireActiveCompanyId` — the strict helper — because the lenient one
  degrades to "no predicate", which on a write means every company's rows.
- **The answer is a structured outcome, never an exception string**: `accepted`,
  a stable `code`, and a plain-English `message` shipped from the server so the
  page holds no dictionary of its own. `docs/autocount-sync-reasons.md` is the
  catalogue, pinned to the code by
  `backend/tests/autocountSyncReasonsCatalogue.test.ts` in both directions.
- **The attempt counter needed no reset code**, and the reason is worth keeping:
  a re-queue is an INSERT of a new row, not a re-open of the dead one. A `failed`
  row sits at `attempts = 6` and the drain selects `.lt('attempts',
  MAX_ATTEMPTS)`, so re-opening it would produce a `pending` row no sweep can
  ever pick up — queued, visibly waiting, and dead. The new row sets no
  `attempts`, so 0277's `DEFAULT 0` supplies it. Asserted rather than assumed.

**Ref:** this PR, 2026-08-16.
