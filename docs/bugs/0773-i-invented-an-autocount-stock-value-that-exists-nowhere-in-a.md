## I invented an AutoCount stock value that exists nowhere in AutoCount, by summing every movement instead of reading its balance [high]

**Symptom.** The owner asked the question a balance sheet turns on:
「所以我们的 stocks amount 都一样的了吗？之后我做 Balance Sheet 也可以跟 AutoCount
一样？」 I answered with a comparison:

| | qty | value |
|---|---|---|
| AutoCount | 9,916 | **RM 4,130,404** |
| ours | — | RM 2,526,475 |

and told him we were **RM 1.6M short**. He then sent a screenshot of AutoCount's
own Stock Balance screen, which totals **9,795 units and RM 1,707,331.71**.

Both of my numbers were wrong, and the direction was wrong: we are **~RM 819,000
HIGHER** than the book, not lower.

**Root cause (traced).** I computed the book's stock value as
`SUM(Qty * Cost)` over `StockDTL`, grouped by (ItemCode, Location). That is not
how AutoCount values a balance. `Cost` on an ISSUE row is the cost of that issue,
so on a FIFO item the running sum drifts from the balance's real value — and it
drifts silently, because nothing about the arithmetic fails.

The size of the drift was visible in my own output and I did not read it:
`HOK-2008(A) (K)` came out at 28 bedframes for RM 163,740 — **RM 5,848 each** —
and `DSL-8030 SOFA` at RM 19,462 a sofa. Those are impossible prices for this
business, printed in a table I had already looked at.

**What made it look right.** Eight cells I spot-checked against the screenshot
reproduced exactly, seven of them by this formula. A sample that agrees is not a
population that agrees, and the items with simple histories are exactly the ones
where a wrong formula still lands on the right answer.

**The real source, established by test rather than by reading.** The screenshot
gives 16 (item, location) cells with their exact Total Cost, which is an oracle.
Three candidates were run against it:

| candidate | reproduced |
|---|---|
| `SUM(Qty*Cost)` over `StockDTL` | 7 of 16 |
| `FIFOCost` joined to `StockDTL` | 7 of 16 (a different 7) |
| **`UTDStockCostDTL`** — AutoCount's own open cost layers | **13 of 16** |

`UTDStockCostDTL` (joined to `UTDStockCost` for item, UOM, location, batch) is
the store AutoCount keeps of the layers a balance still holds. Whole-book it
gives **RM 1,602,654** against the screen's RM 1,707,332.

**Fix.** `data/ac-stock-balance-2026-09-10.json.gz` is exported from that store,
and `check-stock-value-vs-autocount.mjs` reads it. The wrong export
(`ac-stock-value-2026-09-10.json.gz`) is DELETED rather than left in the tree:
it looks authoritative, and its number exists nowhere in AutoCount.

**What is still unexplained, and is flagged rather than absorbed.** 112 cells
hold cost layers that do not add up to their own balance — `AERO-MP (K)` KL has
one layer of 245 units against a balance of 38, and the screen values those 38 at
RM 30.0995 each where the layer says RM 30.00. Neither newest-layers-first
(RM 1,140.00) nor adding `AdjustedCost` reproduces RM 1,143.78. Those cells are
reported as UNKNOWN and excluded from the comparison. The other 961 cells —
7,605 units, RM 1,485,503 — are exact.

**Lesson.** Before quoting a number from someone else's system, find that
system's OWN screen for it and reproduce the screen. I had a stock-value figure,
a plausible method and no oracle, and the result was a RM 2.4M error delivered as
a finding. The owner supplied the oracle in one screenshot; the whole
investigation after that took four queries.

**Ref.** fix/stock-value-real-source, 2026-09-10.
