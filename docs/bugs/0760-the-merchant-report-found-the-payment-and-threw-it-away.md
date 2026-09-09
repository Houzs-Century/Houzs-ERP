## The merchant report found the payment, threw it away, then said there was none [high]

<!-- area: Accounting + GL -->
<!-- status: open -->

**Symptom.** Owner, 2026-09-09, on a PBB report. One line read, at the same time:

> Reference 034766 matches 2990-SO-2606-046
>
> No payment in the ERP explains this money. Record the sale first — it must not
> be cleared out of in-transit without one.

"Confirm all 9 matched, across 10 reports" answered **Posted 0. 9 could not be.**
Four further lines said *"No payment recorded near …"* with their payment
sitting in the ERP.

**Nothing was wrong with the money.** Every figure, journal and balance was
correct; thirteen lines simply could not be confirmed.

**Three separate faults, one screen.** Measured on prod (`anogrigyjbduyzclzjgn`).

### 1. A ref-matched line lost its payment on the way to the screen

`matchStatement` returns a reference match as
`{ bucket: 'MATCHED', matched: [payment], candidates: [], suggested: [] }` — the
empty fields are deliberate, because there is nothing to *choose*. The batch
detail route built its response from `candidates` and `suggested` only and never
read `matched`. With the link also missing (fault 2) the row reached the screen
with no payment at all, so the UI ran its last branch — the sentence above —
directly under the clue naming the very sale it had matched. Pressing Confirm
sent an empty selection, and `confirmSettlementRow` rightly refused with
`no_payments`.

### 2. The link insert was skipped in silence

At upload, reference-matched lines are linked into `acc_settlement_matches`.
Prod held **9 rows bucketed MATCHED, each with its clue, and 0 link rows** — and
not one line had fallen back to `NEEDS_CONFIRM`, which is what the failure path
does. So the insert neither succeeded nor errored: `idByLine`, built from the
rows insert's returning-select, was empty, so every link hit its `continue`.

```
rows_total 18 | bucket_matched 9 | matches_total 0 | confirmed 0
```

A count that cannot be reconciled to the decisions is the only thing that would
have said so, so the upload now checks it and refuses, cleaning up the batch.

### 3. An exact reference was hidden by the date window

`loadPaymentCandidates` read payments **inside the acquirer's date tolerance
only**, and the reference was consulted afterwards — so a payment outside the
window was never loaded and its reference never looked at. PBB's tolerance is 3
days. Four lines:

| line | statement | ref | amount | the payment | keyed | days |
|---|---|---|---|---|---|---|
| 5 | 2026-06-01 | 058016 | 4,610.00 | SO-2606-006 | 2026-06-12 | 11 |
| 6 | 2026-06-05 | 694308 | 1,933.00 | SO-2606-001 | 2026-06-11 | 6 |
| 7 | 2026-06-06 | 906846 | 3,365.00 | SO-2606-005 | 2026-06-12 | 6 |
| 8 | 2026-06-07 | R96754 | 3,230.00 | SO-2606-004 | 2026-06-12 | 5 |

Identical reference, identical amount, sale written up late. The window is the
right instrument for *"which payments could plausibly be this amount on this
day"*; it is the wrong one for a reference, which is the acquirer's own
identifier for the swipe and does not become less true because somebody keyed
the sale a week afterwards.

**Fix.**

1. The detail falls back to `matched` for both `candidates` and `suggested`, so
   a ref-matched line always arrives carrying its payment, pre-ticked. Costs
   nothing when the link is present — a linked line is not recomputed at all.
2. The upload refuses when the rows insert returns fewer ids than decisions,
   naming both counts, and abandons the batch so the file can come in again.
3. `loadPaymentCandidates` takes the statement's own references and fetches
   them **whatever their date**, deduplicated against the window read.
   `matchStatement` then **offers** an out-of-window reference pre-ticked with
   the distance said out loud, rather than auto-taking it: a reference matching
   across two weeks is also the shape of a code mis-keyed onto a later sale, and
   this is the one path that books money without a human. Inside the tolerance
   the automatic match is unchanged.

**Verified against.** 7 new tests, each proved red on the unfixed tree and green
after — `backend/src/acc/settlement-match.test.ts` (offered not taken, the
window edge at 3 vs 4 days, and a far reference not claiming the payment away
from the line it really belongs to) and `backend/tests/settlementRoutes.test.ts`
(the prod state reproduced exactly — MATCHED bucket, link deleted — plus an
upload whose rows report no ids, and a payment keyed eleven days late).
`src/acc` and the settlement routes: 363 → 370 passing.

**The bulk button had the same fault on its own path** — see 0761.

**Not fixed here, and worth naming.** A line with genuinely nothing in the
window still offers no way to reach a payment by hand — three MBB lines on prod
have no matching amount or reference anywhere, which is the honest UNMATCHED
case, but there is no manual search for the case where the operator knows better
than the matcher.

**Status stays `open` until the fix is deployed and the owner's 13 lines
confirm.** The tag is an assertion, not a proof.

**Ref.** `backend/src/acc/settlement.ts` (`loadPaymentCandidates`),
`backend/src/acc/settlement-match.ts` (the out-of-window reference branch),
`backend/src/scm/routes/accounting-settlement.ts` (the detail fallback and the
id-count refusal).
