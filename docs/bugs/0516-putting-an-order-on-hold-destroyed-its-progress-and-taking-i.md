## Putting an order on hold destroyed its progress, and taking it off sent every order back to Confirmed [high]

**Symptom.** The owner, 2026-08-22, describing what a hold is FOR:
「我们的hold是给我们知道一个 order hold这的」 — it is there so people know an order
is paused. And 「take off hold也要看」 — releasing had to be looked at too.

What the system actually did, on the one document that had a working hold at all:

| action | what it wrote | what it cost |
|---|---|---|
| Put On Hold | `status = 'ON_HOLD'` | the order's real status was **overwritten**. Holding an `IN_PRODUCTION` order erased the only record that it was in production. |
| Take Off Hold | `status = 'CONFIRMED'` | every released order landed on **Confirmed**, whatever it had been. An order that had reached `READY_TO_SHIP` came back three steps earlier. |

Both lines were in `frontend/src/pages/scm-v2/row-menus.ts`, side by side, and the
second one is the first one's consequence: there was nothing to put the order back
to, so it guessed.

**Root cause (traced).** The hold was stored in the `status` column, and `status`
is the *only* place a document's progress lives. Nothing anywhere stored the
pre-hold status — the enumeration is in the PR body, and the search returns
nothing:

```
grep -rn "previous_status\|status_before\|held_from" backend/src/scm/
```

So this was not a missing `else` branch or a wrong constant. It was a **type
error in the data model**: a MARKER (a decision a person makes about a document)
was being written into a field that means PROGRESS (a fact about where the
document has got to). One field cannot hold two independent facts, and the one
that was written last won.

Three consequences that all trace to that single mistake, and are worth listing
because each one was previously read as its own separate quirk:

1. **`ON_HOLD` had to be UNRANKED** in the Sales Order transition table
   (`backend/src/scm/lib/so-lifecycle-guards.ts`). Its own comment calls the
   result a *laundry*: `DELIVERED -> DRAFT` is refused on rank, but
   `DELIVERED -> ON_HOLD -> DRAFT` passed both halves, and reaching `DRAFT` is
   what unlocks `DELETE /:docNo` and its cascade over the lines, the payments and
   the audit log. A special case had to be added for that one edge. An unranked
   member of a ranked set is a hole in the set, and it was there because a marker
   had been put in a ladder.
2. **The Delivery Order could not have a hold** without an irreversible
   `ALTER TYPE ... ADD VALUE` on `scm.do_status`. The owner asked for one on
   2026-08-21 (「再加到一个 Hold」); it was the one of the four that was missed.
3. **Three of the four "holds" that shipped on 2026-08-21 could not be reached at
   all.** Migrations 0318/0319/0320 gave the PO, the GRN and the PI the *word*
   On Hold — a tab, a pill, a detail blurb — and nothing in `frontend/src` ever
   sent that status. Those three screens rendered a state the product could not
   produce. That is what a status-shaped hold costs: a whole write path per
   document, so three of them never got written.

**Fix.** The hold becomes a FLAG beside the status (mig
`0324_scm_hold_is_a_marker_not_a_status.sql`): `on_hold` / `hold_reason` /
`held_at` / `held_by` on all five documents, plus mig
`0325_scm_so_payment_totals_view_carries_hold.sql` so the Sales Order list's view
can see it. `status` is never written by a hold in either direction, so taking the
hold off restores nothing — the order never moved. One shared server handler
(`backend/src/scm/lib/document-hold-route.ts`) and one shared client mutation
(`frontend/src/vendor/scm/lib/document-hold-queries.ts`) behind
`PATCH .../:id/hold` on all five, so the rule has one home.

`ON_HOLD` stays a legal label in all four enums for ever — Postgres has no
`DROP VALUE` — so `isDocumentHeld` reads the flag OR the retired label, and every
pill map keeps its entry.

**The half that would have failed silently, and how it was found.** Two blocks
were described in their own migration headers as coming *"for free"*, and both
stopped working the moment the hold left the status column:

- `grns.ts` `RECEIVABLE_PO_STATUSES` — mig 0318 says a held PO is not receivable
  "because grns.ts filters on an ALLOW-list of SUBMITTED / PARTIALLY_RECEIVED —
  so the block comes for free and cannot be forgotten." A held PO now reads
  SUBMITTED and sails through. Consequence: **stock received IN against a
  purchase order somebody deliberately stopped.**
- `purchase-invoices.ts` `.eq('status','POSTED')` — mig 0319 says the same of the
  billable-GRN read. Consequence: **a supplier billed for a receipt somebody
  deliberately stopped.**

Neither would have failed a type check or a test. They were found by enumerating
every ON_HOLD decision site in the backend and asking of each one *"is this still
true when a held document keeps its real status?"* — the command and its output
are in the PR body.

**Deliberately NOT given a flag term, and stated rather than left implied.** Two
sites keep their status-only exclusion: `recomputePoReceived` (`grns.ts`) and
`so-delivery-sync.ts`'s `DELIVERABLE_FROM`. Both are WRITERS that re-derive a
status from a fact, and the only reason they excluded `ON_HOLD` was that the
re-derive would have *overwritten a hold*. That risk is gone — writing `status`
cannot touch `on_hold` — and freezing a held document's received or delivered
counts would be the same lossiness this entry is about. They keep the `ON_HOLD`
literal because a LEGACY row on that label carries its hold in the status column
and nowhere else.

**Ref.** `feat/hold-is-a-marker-not-a-status`, 2026-08-22. No production row was
ever affected by the backfill, because there was nothing to back-fill: the
read-only probe `backend/scripts/check-hold-and-shipped-rows.mjs` was dispatched
at prod on 2026-08-22 (workflow run 32573160010) and reported **zero** rows on
`ON_HOLD` across all five tables. The damage was live in the CODE and had simply
not been exercised yet.
