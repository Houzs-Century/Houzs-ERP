## Special-order (SP) mattresses pooled like standard stock — owner ruled they follow hard binding [medium]

**Symptom.** Not a reported breakage — a rule gap the owner named while
adjudicating the 2026-08-29 stock-status comparison: "如果是specialorder的话
也是像bedframe这样指定的 hard binding的". A made-to-size (SP) mattress was
allocated from the pooled walk like any standard mattress, so it could light
off standard stock it can never physically be, and its own converted PO's
receipt did not light it.

**Root cause (traced).** BOUND_GROUPS in so-stock-allocation.ts held only
bedframe and sofa (the owner's 2026-08-10 scope); mattress lines always
pooled. The book's own convention marks special orders with an (SP) code
suffix — AK-BULWARK MATT (SP) and family — which the allocator never read.

**Fix.** Bound eligibility extended: a mattress line whose item code ends in
(SP) joins the bound walk — lights min(received, need) from its OWN po, and
its units are claimed out of the pool exactly like bedframe. Standard
mattresses unchanged (2026-08-10 ruling stands). Pinned by
so-stock-allocation.sp-bound.test.ts: the (SP) case proved the behaviour, and
the guard test pins that a STANDARD mattress with a received dedication and no
pooled stock stays PENDING — common stock stays common.

**Ref.** feat/sp-mattress-hard-binding, 2026-08-29.
