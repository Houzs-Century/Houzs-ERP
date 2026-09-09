## A sofa was judged on item codes alone and the answer came out backwards [medium]

<!-- area: Sofa, fabric, variants -->
<!-- status: fixed -->

**Symptom.** Five sofa orders were reported to the owner as *"the sales order
lists arms and no seat — the sales order is probably the incomplete one"*, and
put in front of him as a decision to make. Every part of that was wrong: the
sales orders are correct, the purchase orders are correct, and there was nothing
to decide.

He answered by reading the drawing:

> 这个是1A+1A 28寸啊 你认不出？

**Root cause — the METHOD, not the data.** The comparison was made on ITEM CODES
alone. The purchase order said `9028-1S`, the sales order said
`9028-1A(LHF)` + `9028-1A(RHF)`, the multisets differed, and a story was written
to explain the difference. `Desc2` — the build specification, which sits on BOTH
documents — was never put side by side, and it settles all five in one read:

| order | `Desc2` (IDENTICAL on both documents) | the sales order's pieces | verdict |
| --- | --- | --- | --- |
| `HC-SO-012128` | `(1EL+1ER)28inch` | `1A(LHF)` + `1A(RHF)` | matches |
| `HC-SO-012729` | `30" CORNER` | `2A(LHF)` + `CNR` + `1A(RHF)` | matches |
| `HC-SO-010209` | `L shape` | `1A(LHF)` + `1NA` + `L(RHF)` | matches |
| `HC-SO-010955` | `{SIZE:2ER+C+1ER+(28")}` | `2A(LHF)` + `CNR` + `1A(RHF)` | matches |
| `HC-SO-011207` | `2L(30")` | `2A(LHF)` + `L(RHF)` | matches |

**What the purchase order actually is.** One line for the WHOLE SOFA — its
description is `HOK SOFA - 5530` / `HOK SOFA - 5536`, the supplier's model,
because a sofa is bought as a set. The cutover's item mapping gave that line a
COMPARTMENT code (`-1S`), which is the entire reason it read as a missing seat.
So the shape is **1 purchase line against N sales lines**, which no 1:1 matcher
can pair — a difference of SHAPE, not of goods. `a sofa is ONE line in the book`
is the same fact from the AutoCount side.

**Why this is worth an entry when no row changed.** Two costs, both real:

1. **It went to the owner as a decision.** He had already ruled that a purchase
   order follows the sales order, so a wrong "the sales order is incomplete"
   invited a correction to five CORRECT documents — on orders that are all
   DELIVERED, so the paperwork would have been changed to disagree with goods
   that had already shipped.
2. **The spreadsheet asked the wrong question.** A sheet headed *"沙发座位对不上
   — 要决定哪一边对"* was handed over with five rows that needed no decision.

**Fix.**

- `docs/cutover-transfer-links-2026-09-09.md` §2c carries the correction inline,
  with the old sentence quoted so the reversal is visible rather than tidied
  away.
- The owner's spreadsheet sheet was rewritten to the only question that survives
  — cosmetic, and on delivered orders: should that purchase line carry the sofa
  MODEL instead of a compartment code.
- The rule that was already written and not followed:
  **read the drawing and `Desc2` TOGETHER, and compare as a MULTISET.** Comparing
  item codes alone cannot tell a wrong build from a different DOCUMENT SHAPE, and
  those need opposite responses.

**Ref.** 2026-09-09. Found by the owner in one line, on a drawing that was
already downloaded and legible at 240px — it had been sent to him to judge rather
than read.
