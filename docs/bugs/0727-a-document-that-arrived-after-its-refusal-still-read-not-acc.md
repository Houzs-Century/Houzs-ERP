## A document that arrived after its refusal still read NOT ACCEPTED [med]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The owner, looking at the AutoCount Sync page on 2026-09-09 with
both documents visibly in the account book: 「为什么说在里面了？明明都进去了」.

The page showed **NOT ACCEPTED 2** — `HC-DO-2609-004` and `HC-DO-2609-009` —
while the same strip counted **IN AUTOCOUNT 24** out of **ALL 25**. Twenty-five
documents and chips summing to twenty-six, so one document was being counted
twice.

**And the page already knew.** The row's own re-queue answer, on screen
underneath the red badge, read:

> This document is already in AutoCount. Sending it again would put a second copy
> in the account book.
> **TO DO** Nothing. The account book already has this document under its own
> number.

Verified independently in `AED_HOUZS`: both delivery orders are there, each with
its sofa at quantity 1 and its pillows.

**Root cause.** `nAttention` was `docsIn('failed', 'skipped')` — SET MEMBERSHIP.
A document that had ever been refused counted as not accepted, no matter what
happened afterwards. The queue is append-only and one document accumulates a
send per attempt, so the original refusal sits there for ever. These two were
refused, fixed, re-composed and accepted; the old row stayed.

**This is the THIRD time the page has told the owner a document is missing while
showing it as present.** The counts block's own comment records the previous
round: two re-queued FAILED rows reported as *"2 documents need attention"* while
the rows underneath rendered Re-queued (#2220, then the counts one component
further up). Each fix caught the TRIGGER of the day — the re-queue marker — and
not the shape.

**The shape is ORDER, and that is the fix.** `acRefusalPredatesArrival` compares
the document's newest refusal against its newest arrival:

* refused, then accepted -> the refusal is **history**, and the chip and the
  badge both drop it;
* accepted, then refused -> the refusal **stands**, and both chips are right
  about that document: it IS in the book and it DOES need attention. The counts
  block already said so in words; nothing about that case changes.

Set membership cannot tell those apart, which is why a marker was needed before
and why the marker kept being the wrong thing to check.

**Fix.**

* `acRefusalPredatesArrival` in `autocount-outbox-status.ts`, the module the
  list, the chips and the health check already share.
* The counts scan carries `created_at` and builds the newest arrival and newest
  refusal per document.
* **The same rule on the ROW as on the chip, from the same map.** Two opinions
  about one document is how the badge came to disagree with the chip beside it
  and with the row's own answer. `present()` cannot decide this — it is handed
  one row and the question is about the document.
* **An unknown order leaves the refusal standing.** Hiding a real one costs a
  document; showing a stale one costs a glance.

**Verified.**

* `autocountOutboxStatus.canonical.test.ts` — six new cases, including the one
  that must keep counting (accepted, then refused) and the unreadable-timestamp
  direction.
* With `autocountOutboxRoute.test.ts` — **82 passed**.
* `npm --prefix backend run typecheck` clean.

**UNTESTED against production** — the page has not been reloaded under this build.

**The lesson.** Three fixes to one symptom, each aimed at the trigger. The
question the page answers is "is this document still not in the account book",
and every version of the code answered "has this document ever been refused"
instead. A count over a history needs to know which way time runs.

**Ref.** fix/a-failure-older-than-its-arrival-is-history, 2026-09-09. Follows
`docs/bugs/0722` and `docs/bugs/0716`.
