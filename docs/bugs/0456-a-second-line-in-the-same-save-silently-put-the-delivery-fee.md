## A second line in the SAME Save silently put the delivery fee back to 250 [high]

<!-- area: Sales orders + pricing -->

**白话.** 销售员把运费从 250 改成 125，同一次「储存」里又顺手改了沙发的数量 —— 结果
运费自己变回 250。客人拿到的报价是 125，出的单是 250，中间没有任何提示。原因是：一按
储存，系统是**同时**把每一行改动送上去的（不是一行一行送）。改沙发那一行的请求，在读
运费资料的时候，改运费那一行的请求还没写进资料库，所以它读到的还是「没有折扣」的旧数
字；等它稍后写回去的时候，就把 125 覆盖成 250。系统本来有一道「同一张单一次只准一个人
重算运费」的锁，但那道锁是在**要写的时候**才上，读的时候没上 —— 等于两个人先各自抄了
一份旧数字，再排队把旧数字写回去。现在改成：写之前先核对「我抄的那份数字现在还一样
吗」，不一样就整个重算一次再写。

**Symptom.** On the ERP Sales Order editor, reduce a `SVC-DELIVERY` line 250 -> 125
and change any other line (a sofa quantity, a description) in the SAME Save. The
fee reads 125 for a moment and then reads 250 again. Reducing the fee ALONE always
worked, which is what made it look intermittent.

**Root cause (traced, not guessed).** Read, THEN lock.

`scm.rebuild_mfg_so_delivery_lines` takes a per-doc_no `pg_advisory_xact_lock`
(migration 0214) — but it takes it when it is CALLED.
`recomputeDeliveryFeeCore` reads the `SVC-DELIVERY*` lines first
(`mfg-sales-orders.ts`, the `mfg_sales_order_items` select at the top of the
function) and calls the RPC ~170 lines later. Between those two points there is no
lock at all, and the two things the OPERATOR owns on those lines — the free-form
`SVC-DELIVERY-ADD` gross and the per-line `discount_sen` that #2490 taught the
rebuild to carry — are read in that gap.

The parallelism is not exotic, it is one ordinary Save.
`runSoLineWrites` (`frontend/src/pages/scm-v2/so-add-lines.ts:184`) hands the
dirty-line stage to `settleParallelLineWrites`, which is
`Promise.allSettled(jobs.map((job) => job.run()))` at `:124`. The ADD stage next to
it is sequential and its comment says exactly why — `POST /:docNo/items` is a
read-modify-write against the order. The UPDATE stage is the same shape and was
left parallel. Every one of those PATCHes ends in `rederiveDeliveryFee`, and the
SO edit lease does not separate them: all the PATCHes of one Save carry the same
`X-SO-Edit-Lease` token, so `requireSoLineWriteLease` passes them all.

    P_fee   writes discount_sen = 12500, reads the fee lines, derives 125
    P_sofa  reads the fee lines BEFORE that commit, derives 250 (discount 0)
    P_fee   takes the lock, writes 125
    P_sofa  takes the lock, writes 250      <- the reduction is gone

The lock made that ordering deterministic. It never made it impossible, because
serialising the WRITES does nothing for a value that was READ before the queue.

**The owner ruling this sits under, which also settles a contradiction on record.**
#2490 wrote that the typed fee number "is never read ... by design"; #2527 wrote
that it "has always been typed in". The owner: *"运费应该根据实际的价钱去填写。我们的
POS System 已经 preset 了 250，但进到 ERP 其实也只是把那个 amount 填进来而已，所以正常
来说 ERP 里是可以随意填写 amount 的"* — **in the ERP the typed amount IS the value
and stays freely editable.** The two PRs turned out to be complementary rather than
opposed: #2490 is the backend half (the reduction survives a rebuild) and
#2527/#2529 are the frontend half (where the operator types it, and what the cell
means). Neither was reverted here. What was missing is that the typed amount only
holds while nothing else is saving.

**Fix.** Migration 0314 turns read-then-lock into lock-read-compare-write. The
caller passes the operator-owned fee state it DERIVED FROM as `p_expect_state`
(`deliveryFeeStateKey`, keyed by row id so the comparison is order-free); the
function re-reads that same state AFTER its advisory lock and returns **false
without writing** when it has moved. `recomputeDeliveryFeeCore` becomes a bounded
loop over `recomputeDeliveryFeeAttempt` — re-read, re-derive, call again — and
writes nothing at all if the lines keep moving, the same fail-closed posture as the
failed header read next to it.

A boolean rather than a `RAISE`, deliberately: this RPC is also called inside
`runScmPgCommand` (tbc-update / tbc-swap / tbc-swap-sofa), where an exception would
roll back a whole save that only needed recomputing. In that path the retry is
guaranteed to converge — the advisory xact lock the first call took is held for the
rest of that transaction, so nothing can move the state under attempt two.

The write half moved out of the 12,000-line router into
`backend/src/scm/lib/so-delivery-fee-rebuild.ts`, which now owns the whole lock
contract (0214 serialisation, 0310 line reuse, 0314 staleness refusal) in one
readable place. `mfg-sales-orders.ts` got 35 lines SHORTER.

**Carried in the same migration: the grants 0305 dropped.** 0214 ended
`REVOKE ALL ... FROM PUBLIC` + `GRANT EXECUTE ... TO service_role`, with a comment
saying why (the function takes arbitrary line rows for an arbitrary doc_no). 0305
re-created it with DROP + CREATE and did not restore either statement, so since
2026-08-18 it has carried the default PUBLIC execute privilege. 0314 is another
DROP + CREATE, so restoring the 0214 posture is the same statement either way. **The
prod ACL was not queried** — this is read from the migration files, so LIKELY, not
PROVEN; restoring it returns the function to the state it ran in from 2026-07-14 to
2026-08-18 regardless.

**Proved RED first.** The three route-level cases in
`soDeliveryFeeLineIntegrity.test.ts` fail on the unfixed source with
`expected undefined to deeply equal { Object (fee-1) }` (no expectation sent) and
`expected [ { ... } ] to have a length of 2 but got 1` (no re-derivation), while the
14 pre-existing cases in that file stay green. The postgres cases in
`deliveryRebuildKeepsIdentity.pg.test.ts` run the interleave for real against
`backend-postgres` and pair `deliveryFeeStateKey` with the function's own
`jsonb_object_agg`, which is the one way this guard could be silently wrong: an
integer rendered `1.00` on one side would refuse every rebuild forever.

**One trap found while writing it.** `isDeliveryFeeServiceCode` is a PREFIX match
(`startsWith('SVC-DELIVERY')`) while the RPC names three exact codes. Built from
the prefix, the expectation would carry a hand-added `SVC-DELIVERY-BESPOKE` row
that the function never re-reads — a mismatch that never resolves, so that order
would stop re-deriving its fee FOREVER, silently. `deliveryFeeStateKey` therefore
filters on `REBUILT_DELIVERY_FEE_CODES`, the same three the RPC's own `live` CTE
and DELETE name, and a pg case plants such a row to prove both sides ignore it.

**What this does NOT cover.** Only the SVC-DELIVERY* lines are in the expectation.
A concurrent edit to a GOODS line is still read without a lock — deliberately, so
an ordinary multi-line Save does not retry n times. The delivery derivation reads
goods lines for their CATEGORY and item code, not their quantity or price, so a
qty edit cannot move the fee; a concurrent product SWAP theoretically can, and is
untested and unfixed here.

**Ref.** fix/so-fee-lock-ordering, 2026-08-20. Fourth entry of the fee chain
(#2516 -> #2527 -> #2529 -> here), and the first one that is about concurrency
rather than about the cell.
