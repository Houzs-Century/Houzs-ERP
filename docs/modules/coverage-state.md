# Coverage state — "still loading" is not an answer

**Read this before adding a column to any document drill-down.**

## The rule

A cell whose data comes from a SECOND query must never render a definite answer
before that query resolves. Three states, never two:

| state | means | the cell renders |
| --- | --- | --- |
| `ready` | the data is here, or there was none to fetch | the answer, including the honest empty one (`STOCK`, `—`) |
| `loading` | in flight | **WORKING…** (`PendingTag`) |
| `unavailable` | the read failed | **NOT LOADED** (`UnavailableTag`) |

`frontend/src/components/coverage-state.tsx` owns all three plus
`coverageStateOf(query)`, which maps a react-query pair onto them in one place.

`coverage` is a **REQUIRED prop** on `DocumentLinesExpansion` and
`SoSourceChips`. That is deliberate and it is the enforcement: CLAUDE.md's rule
that a parameter which DECIDES is required, never optional. An optional one
means every caller that says nothing keeps the old behaviour with no compile
error — which is exactly how four drill-downs came to share this bug while four
others did not.

## Why it exists

The owner, 2026-09-02, sent two screenshots of the same purchase-order
drill-down seconds apart. The first showed every line tagged **STOCK**; the
second showed the same lines carrying **HC-SO-001162 · PENDING**. Nothing had
changed but a second query arriving.

> 「这样很容易误导人，人家会以为是 stop，或者以为是 bug」 · 「我以为是 bugs」

`STOCK` is not a blank. It is a claim — *"Stock replenishment, no open Sales
Order demand is assigned to this line"* — so while the query was in flight the
screen asserted that goods bought for a named customer were unassigned stock.
The cells read the second query as `x ?? []`, collapsing "I do not know yet"
into "I know, and the answer is none".

Full trace: `docs/bugs/0603-a-drill-down-printed-stock-while-the-answer-was-still-loadin.md`.

## Which surfaces fetch a second query

A drill-down running `usePoSoCoverage(...)` or `useSoLineCoverage(...)` fills
its assignment columns separately from its lines, and must pass
`coverage={coverageStateOf(q)}`:

| surface | second query |
| --- | --- |
| `frontend/src/pages/scm-v2/PurchaseOrdersListV2.tsx` | `usePoSoCoverage("po", id)` |
| `frontend/src/pages/scm-v2/GoodsReceivedListV2.tsx` | `usePoSoCoverage("grn", id)` |
| `frontend/src/pages/scm-v2/PurchaseInvoicesListV2.tsx` | `usePoSoCoverage("pi", id)` |
| `frontend/src/pages/scm-v2/MfgSalesOrdersListV2.tsx` | `useSoLineCoverage(docNo)` |
| `frontend/src/pages/scm-v2/SalesOrderDetailV2.tsx` | `useSoLineCoverage(docNo)` |

Every other drill-down runs ONE query and passes `coverage="ready"` explicitly.
Saying it in the diff is the point — `"ready"` by omission is what this rule
exists to prevent.

## Two things it deliberately does NOT do

**It does not hold the goods list back.** The lines render the moment they
arrive; only the cell that depends on the second query says it is still working.
The owner's instruction: 「货品清单照旧马上出来（不要拖慢），只有还没算好的那几格
显示「计算中」」. Gating the whole expansion on both queries would trade one
wrong answer for a slower screen.

**It does not treat a failed read as an empty one.** `unavailable` has its own
words because a broken connection and "this line has no order" are opposite
facts — the same rule `backend/src/scm/lib/venue-binding.ts` and
`backend/src/scm/routes/autocount-relink.ts` apply on the server.

## Adding a sixth surface

1. Fetch the coverage query as the five above do.
2. Pass `coverage={coverageStateOf(covQ)}` — never the literal `"ready"`.
3. `frontend/src/components/coverageWiring.test.ts` fails the PR if a file
   running one of those hooks hard-codes `"ready"` or never calls
   `coverageStateOf`. It also fails when its own matcher finds nothing, so a
   verdict computed over an empty population cannot read as a pass.

Behaviour lives in `frontend/src/components/coverage-state.test.tsx`.
