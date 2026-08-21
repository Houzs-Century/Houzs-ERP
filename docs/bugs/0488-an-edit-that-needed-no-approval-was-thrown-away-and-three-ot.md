## An edit that needed no approval was thrown away, and three other things around the same gate [medium]

<!-- area: Sales orders + pricing -->

**Symptom.** On a processing-locked SO (`2990-SO-2608-020`), pressing **Submit
amendment request** answered:

```
Save failed.
No changes to submit — edit a line, a date or the delivery location first, then submit the amendment.
```

That report was benign — the operator had changed nothing material. Reading the
gate to explain it turned up four defects, three of them live.

**Root cause (traced).** An edit on a locked SO has TWO halves
(`so-amendment-header.ts`): FREE fields save directly, CONTROLLED fields and
line changes ride an amendment. Both surfaces had ONE early return covering
both, and it asked only whether the AMENDMENT half had anything. Neither asked
about the DIRECT half, so each got it wrong in its own way:

- **Desktop** (`SalesOrderDetail.tsx`) returned **before** `handle.save()`, which
  lives further down the same function. An edit to only the customer name,
  phone, email or note was **discarded** — while the banner beside it promised
  those details "save straight away". In amendment mode `submitAmendment` is the
  ONLY primary button (`saveEdit` is not rendered), so there was no other way to
  save them.
- **Mobile** (`MobileNewSO.tsx`) PATCHes the direct half **before** the check, so
  the same edit landed and the operator was then told there were no changes to
  submit. Saved, reported as failed.

Two more, found in the same read:

- **Mobile 409'd every amendment on any SO with an address.**
  `withFrozenHeaderFieldsReverted` reverts each `AMENDABLE_HEADER_KEY` present in
  the patch to `original[key]`; an omitted key is `undefined`, and `outValue`
  maps that to **NULL**, not "leave it alone". Mobile collected seven keys into
  the amendment but passed only five as originals, and `soHeaderPatchFrom`
  **always** emits `address1`/`address2`. So the direct PATCH carried
  `address1: null` on a locked SO, the server saw a genuine change to a frozen
  column, and refused `so_locked_processing` — before the amendment was ever
  created, so pure line edits died too. Desktop passed all seven and was fine.
  `AmendableHeaderValues` is a `Partial`, so the compiler could not catch it.
- **A payment-only edit on mobile could never be booked.** `recordNewPayments`
  runs after the gate, so a staged payment with no other change hit "No changes
  to submit". The rows survive a failed submit, so no money was lost, but every
  retry hit the same wall.

And four pieces of copy still told the operator that address lines "save
straight away". They stopped doing so on **2026-07-27**, when the address block
and the disposal note joined the CONTROLLED set (two-lane phase 2). The policy
table says so in writing — the `address1` row's reason notes it "reverses the
earlier 'address lines save straight away'" — while both banners, both mobile
address hints and the `save()` docstring still carried the old promise.

**Fix.** `frontend/src/vendor/scm/lib/so-amendment-submit.ts` (new, pure):
`planAmendmentSubmit` answers the question both surfaces were missing —
`AMENDMENT` when lines or CONTROLLED fields moved, `DIRECT_ONLY` when only FREE
fields or staged payments did, `NOTHING` only when both halves are empty. Both
surfaces now classify through it and share one tail: `DIRECT_ONLY` skips only
the amendment creation. The banner copy and the two-lane submitted-notice moved
into the same module, because those had drifted too — desktop said a split
amendment applies "as soon as its approver signs", mobile "when its approver
signs".

Desktop gained `CustomerCardHandle.hasDirectHeaderChanges()`, computed from the
very patch `save()` would send (`directHeaderPatch`, shared with `trySave`), so
the page cannot be told "nothing to save" about a patch that would have been
sent. Mobile's revert now passes `address1`/`address2`.

Proved RED on the unfixed tree: `so-amendment-header.test.ts` asserts that an
`original` omitting a collected key nulls it — the exact shape that 409'd
mobile — and it passes against unmodified `origin/main`, which is the
demonstration. `so-amendment-submit.test.ts` executes the decision (21 tests
across both files), including that a staged payment alone is `DIRECT_ONLY` and
never downgrades a real amendment, and that the banner no longer promises
addresses save straight away.

Not fixed here, and deliberately: the CONTROLLED/FREE split itself
(`so-field-policy`, drift-tested against the backend) and the two-lane routing
are untouched.

**Ref.** fix/so-amendment-direct-half, 2026-08-21.
