<!-- area: Frontend + mobile -->
## A drill-down printed STOCK while the answer was still loading [high]

**Symptom.** The owner sent two screenshots of the same purchase-order drill-down
seconds apart, 2026-09-02. The first showed every line tagged **STOCK**. The
second showed the same lines carrying **HC-SO-001162 · 28/09/2026 · PENDING**.
Nothing had changed but a second query arriving.

> 「你看第一张照片，应该是因为还没有 load 出来，所以显示是 stop；第二张照片 load
> 出来之后，就显示资料了。这样很容易误导人，人家会以为是 stop，或者以为是 bug ...
> 这种东西是要全套系统彻底解决掉的」 and 「我以为是 bugs」

STOCK is not a blank — it is a claim, tooltipped *"Stock replenishment — no open
Sales Order demand is assigned to this line"*. So for as long as the second
query took, the screen asserted that goods bought for a named customer were
unassigned stock.

**Root cause (traced).** A drill-down runs TWO queries: the LINES
(`usePurchaseOrderDetail`) and the COVERAGE that says which order each line was
bought for (`usePoSoCoverage`). The gate was `isLoading={detailQ.isLoading}` —
the first query only. The cells then read the second as `x ?? []`, collapsing
**"I do not know yet"** into **"I know, and the answer is none"**, which renders
`StockTag`.

Same collapse, different cell, blanked the sales order's **Incoming PO** column
to a bare dash. `docs/bugs/0596` fixed the missing FETCH there; the loading
window survived it, which is why the owner asked about that column a second time.

Measured across the eight drill-downs: **four fetch a second query and gated on
the first** — `PurchaseOrdersListV2`, `GoodsReceivedListV2`,
`PurchaseInvoicesListV2`, `MfgSalesOrdersListV2` (+ `SalesOrderDetailV2` for the
same chips). The other four run one query and were correct already.

**Fix.** `frontend/src/components/coverage-state.tsx` — three states, never two:
`ready` / `loading` / `unavailable`, with `PendingTag` ("WORKING…") and
`UnavailableTag` ("NOT LOADED"). A failed read and an empty result are opposite
facts, the same rule `scm/lib/venue-binding.ts` and `autocount-relink.ts` apply
on the server.

`coverage` is a **REQUIRED prop** on `DocumentLinesExpansion` and
`SoSourceChips` — CLAUDE.md's rule that a parameter which DECIDES is required,
never optional. Making it required is what found all seven call sites: the
compiler named each one. A surface with nothing extra to fetch passes `"ready"`
and says so in the diff.

**The goods list is NOT held back** — the lines still render immediately, and
only the cell that depends on the second query says it is still working. That
was the owner's explicit instruction: 「货品清单照旧马上出来（不要拖慢），只有还没
算好的那几格显示「计算中」」.

**Verified.** `coverage-state.test.tsx` — 7 behaviour tests (loading says
WORKING and not STOCK; ready still says STOCK; a failed read says NOT LOADED;
the lines render regardless). `coverageWiring.test.ts` — 137 assertions pinning
that no page fetching coverage may hard-code `coverage="ready"`, that the known
five are in the population, and that a matcher finding nothing fails rather than
passes. **PROVED RED on the unfixed tree: 6 wiring tests fail.** Frontend
typecheck exit 0; full frontend suite 294 files / 3,386 tests pass.

**Ref.** fix/loading-is-not-an-answer, 2026-09-02.
