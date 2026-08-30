## A company-1 bound line with no receipt fell through to the pooled walk and lit without a PO [high]

**Symptom.** Owner, 2026-08-30, pressing on the JAGER report: "如果你是真算的话,
他明明都没有 PO,怎么会 ready 呢？…它一定是根据 PO…Company 1 跟 Company 2
机制是不一样的" — he suspected the hard-binding rule was not actually enforced
by the engine, only claimed.

**Root cause (traced).** He was right, twice over. (1) The allocator's bound
pass (`so-stock-allocation.ts`) lit dedicated receipts first but let an
un-receipted bound line FALL THROUGH into the pooled walk — and it carried NO
company filter, so "company-1 hard binding vs company-2 pooling" existed as a
sentence, not as code. The rule only *appeared* to hold because typed variant
keys never match the blank-variant migrated stock. (2) The moment BOTH sides
are blank it fires: a read-only production census (branch-ref run 33287776781)
found HC-SO-013253 JAGER-(Q) — blank variants, processing date set, NO
purchase order anywhere — READY off the blank-variant migrated pool. 431 of
433 lit company-1 bound lines were legitimately lit by their own received PO;
the second violation (HC-SO-000870 CODY-(K)) is a stale status from that
evening's dedication re-point, cleared by the next recompute.

**Fix.** `HARD_BOUND_COMPANY_ID = 1` exported beside `isHardBoundLine`; the
pooled walk now forces PENDING for that company's bound-group lines instead of
reading the bucket — the pool is never a company-1 bound line's evidence.
Company 2 (2990) pools past the guard unchanged; sofa was already exclusive
(batch/dedication only). Switching company 1 to the pooled model later — the
owner's stated end-state once stock has variants — is that one constant.
Proved RED first in `so-stock-allocation.c1-pool.test.ts` (the exact
HC-SO-013253 shape read READY pre-fix), with guards: received dedication still
lights C1, company 2 still pools, C1 standard mattress still pools.
`check-bound-exclusivity.mjs` + workflow keep the census re-runnable — its
company-1 "LIT WITH NO PO" line must read 0 after every resync.

**Ref.** fix/c1-bound-exclusivity, 2026-08-30.
