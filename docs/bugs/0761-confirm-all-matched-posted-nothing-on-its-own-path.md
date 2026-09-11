## "Confirm all 9 matched" posted nothing, on its own path [high]

<!-- area: Accounting + GL -->
<!-- status: open -->

**Symptom.** Owner, 2026-09-09, testing the fix for `0760`. The detail screen now
showed the payment — document, customer, approval code and amount all present on
the row — and the bulk button still answered:

> Posted 0. 9 could not be — open the report to see why.

**Root cause — the same fault, a second path.** `0760` fixed the batch DETAIL,
which recomputes and now falls back to the matcher's `matched`.
`settlementConfirmMatched` is a different handler and builds each line's payments
from `acc_settlement_matches` alone:

```js
const links = linksByRow.get(row.id) ?? [];
const r = await confirmSettlementRow(sb, { …, payments: links.map(…) });
```

Those nine reference-matched lines had **no links** — the upload's insert was
skipped in silence (`0760` fault 2). So every one sent an empty selection and
`confirmSettlementRow` refused with `no_payments`, over lines whose payment the
screen was by then displaying. Two paths, one fixed, and the screen and the
button disagreeing about what they could see.

**Fix.** The same fallback on the bulk path: for a pending MATCHED row that has
**no link**, recompute and take the matcher's `matched`. Recomputed only for
unlinked rows, so a human's stored decision is never overridden, and
`confirmSettlementRow` writes the link on success — the data heals as he works.

**Only `matched` is rescued, never `suggested`, and that is the point.** Nobody
reads each line on this path. The button's promise is *"post every line the
unique reference already matched"*. An out-of-window reference (`0760` fault 3),
or one payment that happens to make the amount, is offered on the DETAIL screen
precisely because it needs eyes; a bulk button may not post it. Pinned by a test
that leaves such a line alone and asserts nothing was written.

**Also.** The handler now reads its batch first and answers 404 when there is
none, instead of running over an empty row set and reporting that it confirmed
nothing — an empty success and a missing document are different answers.

**Verified against.** 3 new tests in `backend/tests/settlementRoutes.test.ts` —
the prod state reproduced (MATCHED bucket, link deleted) now confirms and writes
its link back; a merely suggested payment is left alone; a missing batch is a
404. The first and third proved RED on the unfixed tree; the second is the
guard-rail and is green either way, which is what it is for. `src/acc` +
settlement + bank routes: 422 passing.

**Status stays `open` until the owner's nine lines actually post on prod.**

**Ref.** `0760` is the same bug on the detail path.
`backend/src/scm/routes/accounting-settlement.ts` (`settlementConfirmMatched`).
