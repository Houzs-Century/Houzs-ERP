## Every proceeded order sat in CONFIRMED and the IN PRODUCTION tab was empty [medium]

**Symptom.** Owner, 2026-08-31, reading the Sales Order list: **IN PRODUCTION 0**,
CONFIRMED 2599, READY TO SHIP 171. 「有 processing date 的就是都在 in production 啊，
就是他们 proceed 了，就代表进入生产，然后才 ready to ship 和 delivered。」

**Root cause.** The status is a separate column that only a TRANSITION writes.
The AutoCount import wrote the dates and wrote `CONFIRMED`, independently, and
never performed one — so the data contradicts the rule this repo's own code
pins at that transition: 「只要有 Processing Date, 就代表他 Proceed 了。」

Measured on production, plan run 33390020511 (company 1):

| | |
|---|---|
| CONFIRMED orders | 2,599 |
| **of those carrying a Processing Date** | **364** |
| past CONFIRMED with NO Processing Date (the reverse disagreement) | 4 |
| of the 364, would fail today's completeness gate if done interactively | 17 |

**Fix.** `backend/scripts/repair-proceeded-status.mjs` + its workflow. Writes
`status` only, `CONFIRMED -> IN_PRODUCTION`, only where a Processing Date is
present. No date, no line, no money, no stock, no AutoCount document — the book
has no such status, this column is ours.

Refuses to touch anything past CONFIRMED (that is a demotion, not a repair),
anything with no Processing Date (the un-released set, 2,238 orders, is the
owner's separate decision), and cancelled orders.

**It does not re-run the interactive transition's completeness gates**, and says
so rather than hiding it: the proceed already happened in AutoCount before the
import, and re-gating would refuse orders on today's rules for a decision taken
months ago. The 17 that would fail are REPORTED, so the number is visible either
way.

Plan by default, `CONFIRM="PROCEEDED MEANS IN PRODUCTION"` on apply, and the
verification re-reads **the rows it moved** on a fresh connection and asserts the
VALUES — the status text and that the date that justified the move is still there
— not a count.

**NOT APPLIED as of this entry.** The plan above is read-only. Applying moves 364
live orders onto a tab staff will see the next morning, so it waits for the
owner's word; this entry will be updated with the apply run when it happens.

**Ref.** fix/proceeded-means-in-production, 2026-08-31.
