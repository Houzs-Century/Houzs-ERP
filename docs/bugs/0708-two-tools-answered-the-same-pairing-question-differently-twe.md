## Two tools answered the same pairing question differently, twenty minutes apart [medium]

<!-- area: Sofa, fabric, variants -->

**白话.** 同一个问题——「这张采购单的沙发件，能不能对回销售单的沙发件？」——我们两支
程式在同一个资料库上给了**相反**的答案，前后差二十分钟。原因是它们数的东西不一样：
一支只数「还没接上」的采购行，另一支数「全部」采购行。三件的沙发若已经有一件接好了，
前者看成 2 对 3（对不上），后者看成 3 对 3（对得上）。**后者才对**。已经改成两支共用
同一段程式，并且写了测试把这个情况钉住。

**Symptom.** `HC-PO-010040 <- SO-012277`, on production, minutes apart:

```
probe  run 34204007759  the two sides hold a different NUMBER of rows  -> REFUSED
repair run 34203858897  PROVABLE at compartment grain, 2 rows          -> would write
```

Both read `scm.purchase_order_items` and `scm.mfg_sales_order_items`. Both were
written in the same session, for the same question. One of them was wrong and
"they must be looking at different moments" was the available story.

**Root cause (traced).** Not a race and not the clock. The two held SEPARATE
COPIES of the pairing rule and tallied DIFFERENT POPULATIONS:

- `probe-staff-reported-flow.mjs` built its purchase-side index from the
  **unlinked** rows only — the same list it was iterating.
- `repair-po-so-link-sofa-compartments.mjs` built its index from **every**
  purchase row carrying the AutoCount line key, linked or not.

`SO-012277`'s sofa is three compartments and one purchase row was already
dedicated. The probe therefore compared 2 against 3 and reported a count
difference; the repair compared 3 against 3, found the same set of codes on both
sides, and paired the two rows that still needed it.

**The repair's reading is the correct one**, and the reason is structural rather
than a preference: "can these two book lines be paired" is a question about the
WHOLE pair. A compartment somebody already dedicated still occupies its sales
row, so leaving it out both under-counts the purchase side and hides the very
row a collision guard needs to see.

The two also disagreed about the LABEL for a refusal, which is the same defect
seen from the other side: the probe tested membership one way only (purchase
codes absent from the sales side), so a sales-only compartment was invisible to
it and surfaced as a count difference instead of the missing piece it is.

**Fix.** One implementation, `backend/scripts/lib/sofa-po-so-pair.mjs`
(`judgeCompartmentPair`), imported by both. It takes both row lists explicitly
and its header states the contract that was violated: **pass every ERP row
carrying each key, linked rows included.** Membership is tested BOTH ways, so a
sales-only compartment is named rather than counted.

`backend/scripts/lib/sofa-po-so-pair.test.mjs`, 8 assertions, proved RED first:
the case that reproduces this bug (`THE DISAGREEMENT THIS MODULE EXISTS FOR`)
fails against the withheld-row population and passes against the whole pair. Two
more that were written expecting the old labels also failed and were corrected to
what the shared rule actually answers — including that `countsDiffer` is
DEFENSIVE and unreachable once no code is duplicated and both sides carry the
same set, which the probe's one-way membership test had been hiding.

**What it cost, and what it did not.** Nothing was written from the wrong
reading: the disagreement was found in the PLAN, before any apply. What it
would have cost is worse than a wrong row — the two numbers were about to be
reported to the owner as if both were measurements.

**The rule this is an instance of.** CLAUDE.md already says a rule with two
copies drifts, and both copies here were written within an hour of each other by
the same session. Proximity is not a defence; the second copy was drift the
moment it existed.

**Ref.** `fix/staff-reported-flow`, 2026-09-08. Probe run `34204007759`, repair
plan run `34203858897`.
