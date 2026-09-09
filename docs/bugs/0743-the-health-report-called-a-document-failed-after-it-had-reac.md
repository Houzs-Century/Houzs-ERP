## The health report called a document failed after it had reached the book [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The owner, 2026-09-09: 「为什么算失败呢」. `HC-DO-2609-004` and
`HC-DO-2609-009` are in AED_HOUZS — the page says so — and the outbox health
report went on counting them as documents that never arrived, telling whoever
read it to go and send them again.

**Root cause — the page learned the rule and the report did not.**
`docs/bugs/0727` added `acRefusalPredatesArrival` to
`src/scm/lib/autocount-outbox-status.ts` and wired it into
`scm/routes/autocount-outbox.ts`, the PAGE. `check-autocount-outbox-health.mjs`
is the second reader of the same table and never got it, so the two answered
differently about the same row.

The report discounted exactly two kinds of failure — one already re-queued, and
one whose ERP document no longer exists. "Refused, then ARRIVED" is neither, so
it was counted.

That is the failure this very file's header warns about, happening to this file:

> two readers with two copies of the classification is how a screen and a
> workflow log start disagreeing about the same row

**A second defect, found while fixing the first.** The FAILED list is
`LIMIT 25`, the counts are whole-table, and the discount was
`failedOutstanding - failedGone.length` — a whole-table count minus a number
computed off the capped list. Correct only while there are fewer than 25
failures. The discounts are now computed over every outstanding failure.

**Fix.**

* **The rule is IMPORTED, not copied a third time.**
  `backend/scripts/lib/ac-failed-superseded.mjs` imports
  `acRefusalPredatesArrival` from the page's own module.
* **The report runs under `npx tsx`.** The canonical test asserts this script
  "runs under node against postgres.js and cannot import TypeScript" — true of
  how it was INVOKED, never of the script. `repair-address-to-forty.yml` already
  imports `src/` in Actions the same way. Measured: the script loads and reports
  `DATABASE_URL not set` under tsx, so the import chain resolves.
* **ORDER, not set membership.** A document that arrived and was THEN edited
  into a refusal is in the book AND needs attention; only the other order is
  discounted. A missing or unreadable timestamp leaves the refusal standing —
  hiding a real one costs a document, showing a stale one costs a glance.
* **The arrived-since rows are still PRINTED**, under their own heading with the
  time they reached the book, following the precedent of the deleted-document
  heading: the row is the record of an attempt and deleting the count does not
  unsay it.

**Verified.**

* `backend/tests/acFailedSuperseded.test.ts` — **11 tests**: discounted when the
  arrival follows the refusal; NOT discounted when the refusal follows the
  arrival, when the document never arrived, or when a timestamp cannot be read;
  a `SO` arrival does not clear a `DO` failure of the same number; the `Date`
  postgres.js returns is compared correctly against another `Date`; the NEWEST
  of several arrivals decides; an arrival row with no timestamp is ignored.
* `npm --prefix backend run typecheck` clean.
* `audit:release-discipline` — no new violations. `audit:swallowed-reads` — at
  the ceiling, no file gained one.
* `npm --prefix backend run test:light` — 10,025 passed. Two failures, both
  **pre-existing on `origin/main` and Windows-only**, neither touching this
  change: `specialsRecordedNeverPriced` (a transient empty read, passed on
  re-run) and `doStockLeavesOnConfirm` line 245, which searches
  `delivery-orders-mfg.ts` for a two-line anchor written with `\n` while the file
  is checked out CRLF — measured, the anchor is absent as `\n` and present at
  offset 201152 as `\r\n`, so `indexOf` returns -1 and `slice(-1)` asserts
  against a single newline. Green on Linux CI, wrong on every Windows machine;
  filed separately rather than widened into this PR.

**UNTESTED against production** — the workflow has not been dispatched under
this build, so the count those two delivery orders now produce is not yet
observed.

**Ref.** fix/the-health-report-reads-the-page-s-rule, 2026-09-09.
