## MRP told the owner to buy bedframes his own received purchase order had already delivered [high]

**Symptom.** The MRP page reported shortages on company-1 bedframe lines whose
goods were physically in the warehouse, bought on that order's own purchase order
and already received. The Sales Order list said the same line was covered. Two
engines, one order, two answers.

**Root cause (traced).** Since 2026-08-30 the STORED allocator binds a company-1
bedframe / sofa / `(SP)` mattress line exclusively to its own purchase order
(`HARD_BOUND_COMPANY_ID`, `docs/bugs/0572-*`): it lights from that PO's receipt
and never from the pool. **MRP knew none of it** — its own guide said so in as
many words — so it planned the same line against pooled stock and pooled PO
supply.

That would have been a difference of opinion rather than a wrong number, except
for the migrated data: the AutoCount stock snapshot carries NO variant, so every
imported bedframe unit sits under a BLANK variant key while its sales-order line
carries colour, gap and heights. MRP's bucket key is exact and has no fallback
(owner, 2026-08-16: 「variant 不一样的话 应该不能拿来给那个 SO 用不是吗?」), so the
typed demand looked into an empty bucket and reported a shortage — for goods that
are in the warehouse with that order's name on them. A fully received purchase
order made it worse rather than better: `left <= 0`, so it was skipped as supply
entirely.

**Fix (owner chose option 甲, company 1 only: 「甲 可是针对的是 co1 而已 目前而已」).**
MRP now honours the same binding, on both sides:

* a bound PO line is DEDICATED — it leaves the pool, because it belongs to one
  sales-order line and cannot cover anybody else's;
* a bound demand line does not read the pooled STOCK at all. Its own PO's
  received quantity covers it now; its own outstanding quantity covers it on that
  PO's ETA.

**The rule is drawn at STOCK, and only at stock.** A first version also withheld
the pooled PO queue from bound lines, and a test caught what that costs:
`po-so-coverage` — the screen that answers "who is this purchase order for" —
started reporting that an unlinked PO serves nobody. Stock is a claim on goods
that exist, and that is where the allocator's exclusivity belongs; a purchase
order is a PLAN, and one already on order for this exact bucket is a legitimate
answer to "you do not need to buy this again". So a bound line is offered its own
dedicated PO first, then the pooled queue.

Its own receipt is NOT decremented from the pooled bucket the way the allocator does it.
The allocator's pool is one shared walk across every group; here the pool IS the
bucket, and a company-1 bedframe bucket holds only bedframe demand — every line
of which is bound by the same rule and so cannot draw it. Leaving the units in
the bucket is what keeps the page honest about the migrated blank-variant stock:
it is on hand, and nothing on this plan is entitled to it.

**Sofa is excluded here, and the shared predicate is not redefined — only
narrowed at this call site.** Sofa demand never enters the general walk (section
6 skips `cat === 'SOFA'`); it is planned as colour-matched SETS in section 8,
whose supply model is its own. Pulling sofa PO lines out of the pool without
rewriting that walk would starve it.

**Company 2 (2990) is untouched** and keeps the pooled model, pinned by its own
test. When company-1 stock has grown variants and the migrated blanks have washed
out, the owner's stated plan is to switch company 1 to pooling too — that switch
is the one constant, `HARD_BOUND_COMPANY_ID`.

**Tests.** Five in `src/scm/routes/mrp.test.ts`; three of them were RED against
the unfixed tree, one per behaviour that changed:

```
× its own PO is RECEIVED: covered, even though the units landed under a blank variant
    AssertionError: expected 5 to be +0
× NO purchase order of its own: short, even with matching stock sitting in its bucket
    AssertionError: expected +0 to be 5
× another line's dedicated PO is not free supply
    AssertionError: expected 5 to be +0
```

**Ref.** feat/mrp-hard-binding-co1, 2026-08-31.
