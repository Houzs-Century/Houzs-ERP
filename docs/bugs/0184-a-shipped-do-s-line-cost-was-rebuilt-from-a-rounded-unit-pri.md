## A shipped DO's line cost was rebuilt from a ROUNDED unit price [medium]

**Symptom.** None visible. The line costs on a delivered order did not sum to
what inventory had actually booked, and no screen shows that sum, so nothing
ever said so.

**Root cause.** `delivery-orders-mfg.ts` restamped every line from its bucket
as `round(bucket_cost / bucket_qty) * line_qty`. Rounding a unit cost to the sen
is correct — the owner's rule is that money carries two decimal places and
anything finer rounds to the nearest sen. Multiplying the ROUNDED figure back
out to rebuild a total is not:

    bucket: 50 sen booked over 100 units
    unit  : round(50 / 100) = round(0.5) = 1 sen     <- correct
    line  : 1 sen x 100 units = 100 sen              <- 50 sen invented

The quieter direction is worse: 0.4 sen a unit rounds to 0, and the entire cost
disappears. Both only bite when the per-unit figure is SUB-SEN, which is what a
small freight allocation or a partly-uncosted batch looks like. This is ledger
**B5** in a second home — B5 was fixed in `recost.ts` (which now carries totals)
and this path was never touched, so the two disagreed about the same goods.

**Fix.** `backend/src/scm/lib/bucket-cost-allocation.ts` — the bucket's booked
cost is split across its lines in proportion to qty, and the LAST line takes the
remainder so the shares sum to the bucket exactly. The unit cost is then derived
from the share. Total is the authority; unit is the derivation. That is also
ordinary ERP practice: a receipt's landed cost is a total, and the per-unit
figure is what you get when you divide it.

The remainder rule matches `landed-allocation.ts:133`, which already existed —
one house pattern for "make the column sum exactly", not two.

**Test.** `bucket-cost-allocation.test.ts`, 9 cases. The first assertion in every
one is that the shares sum to the bucket; a line being a sen off its proportional
share is arithmetic, the column not summing is money appearing or disappearing.
Both directions of the defect are pinned as their own cases.

**Ref.** 2026-08-14. Two things worth carrying forward:

1. **The file-size gate reported OK on a change it could not see.** It compares
   the committed diff against the merge base, so with the work still in the
   working tree it measured `origin/main` and passed. Committing first turned it
   red immediately, which is what it should always have said. A local gate run
   before `git commit` is a check running against the wrong tree — the same
   shape as the three-week `audit:map` crash in `staging-bench-rot-coe.md`.
2. **PROVEN vs UNKNOWN.** The defect is proven in the source and in the tests.
   Whether it has ever fired on production data is UNKNOWN — it needs a bucket
   whose cost-per-unit is under one sen, and nothing here has looked for one.
