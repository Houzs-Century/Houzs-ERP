## A short-shipped sales order had nowhere to stop, only a cancel that voided the sale [medium]

**Symptom.** The case, put to the owner on 2026-08-22 — a customer orders 10 and
takes 7, or the supplier cannot supply the last 3, and the outstanding 3 should
stop being chased while the document stays, because the 7 were really sold — and
asked whether it happens here: 「有的」.

The Sales Order had no way to say that. Its only terminal decisions were
**Cancel**, which voids the whole document as if it never happened and turns any
deposit into customer credit, and nothing at all — leaving the order sitting in
a live status for ever, still counted as demand by MRP and the stock allocator,
still offering a Transfer to Delivery Order for goods nobody is going to send.
Neither is true of a sale that came up short.

**Root cause (traced).** `CLOSED` had been removed from the app's Sales Order
vocabulary the day before, on 2026-08-21, and **that removal was correct.** What
it removed was a vague lifecycle STEP ranked after `INVOICED` that nobody used;
it was proven empty first (company 1 held 0 sales orders at all, probe run
32487749630, and company 2's own tab counts summed to its total with CLOSED at
zero) and the owner narrowed the removal to exactly that one status:
「照你的流程做，只删 Closed」. The block recording it is still in
`backend/src/scm/lib/so-lifecycle-guards.ts`, kept beside the new definition
rather than deleted.

So this is not a status that was wrongly taken away. It is a DIFFERENT decision
that the system never had, which happens to want the same enum label:

| | Cancel | **Close remaining** |
|---|---|---|
| the document | VOIDED, as if it never happened | STAYS |
| what was delivered | unwound; deposit becomes credit | STANDS — really sold, really invoiced |
| what is outstanding | never existed | no longer chased |

**Fix.** `CLOSED` is back in `SO_STATUSES` with one meaning and only that
meaning: **stop chasing the remainder.**

- **UNRANKED**, alongside `CANCELLED` and `ON_HOLD` — not ranked after
  `INVOICED`. Closing happens from wherever the order had got to and most closed
  orders never reach `INVOICED`, so a rank would state something false.
- **Enterable from every live status, and NOT leavable.** This is the half that
  had to be got right: `ON_HOLD` was unranked and written as an unconditional
  pass on BOTH edges, which made it a laundry — `DELIVERED → ON_HOLD → DRAFT`
  walked an order to the one status that unlocks the cascading `DELETE`, a move
  the rank table refuses directly. An unranked `CLOSED` written the same way
  would be the same hole with a different name, so the way out is refused with
  `illegal_status_transition` (409). `CANCELLED` stays reachable — an order that
  turns out to be void entirely is the cancel guards' question.
- **No new Delivery Order and no new PO line.** `CLOSED` joins
  `SO_UNDELIVERABLE_STATUSES` (`shared/so-deliverable-states.ts`, plus its
  byte-identical vendored twin) and `SO_UNORDERABLE_STATUSES`
  (`routes/mfg-purchase-orders.ts`). One reason for both: if the rest is not
  coming, nothing more ships against the order and nothing more is bought for
  it. `duplicatedDecisionPins.test.ts` PIN 2 holds the two sets equal.
- **Commission is untouched, deliberately.** `COMMISSION_EXCLUDED_STATUSES` does
  not name `CLOSED`; the part that went out was really sold, and excluding it
  would dock a salesperson because the customer shortened his own order. The
  file's own comment asks for exactly this consideration.
- **Nothing automatic will ever write it.** No machine holds the fact that a
  remainder was given up on. It is the fourth thing a person may decide about a
  Sales Order, after Confirm, Hold and Cancel —
  `docs/modules/document-status-vocabulary.md` §1b carries the rule that decides
  that membership.
- **The menu entry is "Close remaining", not "Close".** On its own the word
  reads as *finish*, which is the opposite of what it does, and it sits two
  entries above Cancel in the same menu. It is behind a confirmation whose words
  say what happens to the money.

**No migration, in either direction.** Postgres cannot `DROP VALUE`, so `CLOSED`
never left `scm.mfg_so_status`: it is in the type's creating DDL
(`backend/scripts/scm-schema/2990s-full-schema.sql`) and mig 0305 casts to it.
Removing it from the app was a change to `SO_STATUSES` and so is putting it back.
For the same reason the label map and `SO_TERMINAL_STATES` never stopped naming
it, which is why the restoration is small.

**Proved RED first.** `backend/src/scm/lib/so-lifecycle-guards.test.ts` is new
and 17 of its 19 assertions failed on the unfixed tree (the route answered
`invalid_status` for `CLOSED`, and a `CLOSED → DRAFT` walk-back returned `null`
because an unknown `from` is allowed through). `so-tab-statuses.test.ts` asserts
the Closed tab on the MAP and not only through `soStatusesForTab`, because the
unknown-tab fall-through answers `["CLOSED"]` for a tab that does not exist and
would have passed on a tree with no tab at all.

**Not built, and it is a question for the owner rather than an omission.** The
PURCHASE side is the mirror image — the supplier who cannot supply the rest —
and the GRN already carries a `CLOSED` of its own. He was asked about the Sales
Order, so only the Sales Order changed.

**Ref.** `feat/close-stops-chasing-the-remainder`, 2026-08-22.
