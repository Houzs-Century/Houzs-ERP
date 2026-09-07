## Ten sofa builds bought every piece but dedicated only the first [medium]

**Symptom.** The sofa document-chain audit reported `piece multiset MISMATCH 29`
on SO -> PO for company 1 (run 34130736979, 2026-09-07 22:02 local; re-measured
at CAP=200 as run 34134017406, 22:38 local). Ten of the twenty-nine read as a
sofa the factory was told to build with one arm and nothing else:

```
HC-SO-011733 -> HC-PO-008783   SO  2A(LHF)+CNR+1NA+1NA+CONSOLE+1A(RHF)
                               PO  2A(LHF)
```

**Root cause (traced).** The pieces WERE bought. Every one of them is a line on
that same purchase order carrying `so_item_id IS NULL`, so the audit — which
resolves a build's purchase side through `purchase_order_items.so_item_id` —
cannot see them. The defect is a missing DEDICATION, not a missing piece and not
a disagreement about the drawing.

The chain check now separates the two causes and prints which it is, so the ten
are named rather than pooled with the nineteen where a piece really is absent.
Where the dedication came from is already recorded: AutoCount holds ONE line per
sofa, the ERP splits it into one line per compartment, and the splitter
dedicated only the line it re-coded in place.

**AutoCount cannot supply these links.** `repair-dedication-from-autocount.mjs`
against production (run 34134024060, 22:38 local, DRY-RUN) reported `WRONG
SIBLING, to re-point 0` and `MISSING, to create from AutoCount 0` against
`AutoCount states no link 453` — `PODTL.FromSODtlKey` is empty on these lines, so
the book has no dedication to copy. The repair has to be derived from the two ERP
documents, which is what `lib/po-so-dedication-plan.mjs` already does.

**Fix.** `repair-po-so-item-dedication.mjs` gained a `PAIRS` input so the ten
pairs run as one batch instead of twenty dispatches. The DECISION is unchanged:
`lib/po-so-dedication-plan.mjs` is untouched, its 14 tests still pass, and it
still assigns only where the answer is forced — one purchase line and one
unclaimed sales line in the same code-and-seat bucket. Each pair keeps its own
read, guards, transaction and fresh-connection verification, so a later pair
failing cannot roll back an earlier one and the summary names every pair already
written.

Measured against production before the write (PLAN run 34134683390, 2026-09-07
22:46 local): 19 dedications to write across the ten pairs, 6 buckets REFUSED as
not forced — two identical purchase lines against two identical sales lines,
where no pairing is forced by code and seat alone.

**NOT FIXED HERE: the six refused buckets.** They leave four builds — HC-SO-002861,
HC-SO-011733, HC-SO-012025, HC-SO-012828 — still short of a `1NA` or two after the
batch. Whether two same-code, same-seat lines are interchangeable depends on axes
the bucket does not compare, so loosening the planner is a judgement call and not
a provable defect. Reported, not guessed.

**Ref.** fix/sofa-compartment-parse, 2026-09-07.
