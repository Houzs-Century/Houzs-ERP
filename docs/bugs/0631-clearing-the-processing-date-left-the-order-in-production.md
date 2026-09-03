## Clearing the Processing Date left the order in production [high]

<!-- area: Sales orders + pricing -->

**Symptom.** The owner cleared the Processing Date on HC-SO-013361. The field
showed `—` and the order still carried the `IN_PRODUCTION` badge.

> 「为什么我已经 remove 掉 processing data 了，还在 production？」

**Root cause — a rule that was only ever built one way, and it was recorded as
such.** His own rule is 「只要有 Processing Date, 就代表他 Proceed 了」, and
`statusAfterProcessingDateSet` implements exactly that: `CONFIRMED` + a date
appearing → `IN_PRODUCTION`. Its own header states the other half was left open:

> never moves BACKWARDS when a date is cleared. Clearing is super-admin-only and
> what the status should become then is a **separate owner decision**, not an
> inference this function is entitled to make.

So this was not a defect in the code; it was a decision nobody had made. He made
it, choosing the guarded symmetric option out of three, and said why in one line:

> 「B 其实就看有没有 date 就知道了」

**What a normal ERP does.** Odoo, NetSuite and SAP move state on an explicit
action — a Confirm or Start-production button and a matching reset — rather than
deriving it from a field. This system derives it FORWARD on the owner's own
instruction, so the symmetric backward derivation is the consistent answer here;
the guard below is what keeps it from becoming the industry's warning case.

**Fix.** `statusAfterProcessingDateCleared`: the date cleared on an order that is
`IN_PRODUCTION` takes it back to `CONFIRMED`. Three refusals, and the middle one
is the whole point of preferring option B over the plain symmetry of option A:

* **anything downstream is live** — a delivery order or a sales invoice — and the
  order is LEFT ALONE. An order already delivered is not "not in production", it
  is further along, and demoting it would hide a real document from the board the
  factory works from. Same set the forward rule refuses, for the same reason.
* only ever out of `IN_PRODUCTION`. `READY_TO_SHIP`, `DELIVERED`, `INVOICED`,
  `CANCELLED` and `DRAFT` are untouched.
* the UN-PROCEED is the TRANSITION, not the absence — an order that never carried
  a date is not un-proceeding every time somebody saves it.

`soStatusAfterProcessingDateChange` in
`backend/src/scm/lib/so-proceed-status-change.ts` is what the save calls: one
question, one answer, both directions. It lives outside `shared/` because it
reads the database, and **the downstream read is issued only when a date was
actually cleared** — every other save pays nothing, which a test asserts by
failing if the client is touched at all.

**Verified.** `backend/src/scm/lib/so-proceed-status-change.test.ts` — 12 tests:
the move, every refusal, and the no-read property on a save that changes no date.
118 tests pass across the proceed / processing-date suites (10 files). Backend
typecheck exit 0. The route file is net **0** lines: one call replaced one call.

**UNTESTED against a live save.** Proven by unit tests and by reading the save
path; no production save has been performed since the change at the time of
writing.

**Ref.** fix/clearing-the-processing-date-leaves-production, 2026-09-03.
