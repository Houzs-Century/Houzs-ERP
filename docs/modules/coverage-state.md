# Coverage State ("still loading" is not an answer)

A cell whose data comes from a SECOND query (beyond the document's own lines) must never render a definite answer before that query resolves. Read this before adding a column to any document drill-down.

## Statuses and flow

Three states, never two — `frontend/src/components/coverage-state.tsx` owns all three plus `coverageStateOf(query)`, which maps a react-query pair onto them in one place:

| state | means | the cell renders |
|---|---|---|
| `ready` | the data is here, or there was genuinely none to fetch | the answer, including the honest empty one |
| `loading` | in flight | WORKING… |
| `unavailable` | the read failed | NOT LOADED |

`coverage` is a REQUIRED prop on `DocumentLinesExpansion` and `SoSourceChips` — deliberately: a parameter that decides what renders must be required, never optional, or a caller that says nothing silently keeps the old (wrong) behaviour with no compile error.

Five surfaces currently fetch a second coverage query and must pass a real `coverageStateOf(...)` result: the Purchase Orders, Goods Received and Purchase Invoices lists (`usePoSoCoverage`), and the Sales Orders list and detail (`useSoLineCoverage`). Every other drill-down runs only one query and passes the literal `coverage="ready"` EXPLICITLY — stating it in the diff, rather than getting it by omission, is the point.

This deliberately does NOT hold the whole line list back waiting on the second query — lines render the moment they arrive; only the cell that depends on the slower query shows it's still working. It also does NOT treat a failed read as an empty one — `unavailable` has its own distinct wording, since a broken connection and "genuinely nothing here" are opposite facts.

## Rules that must not break

- A value computed by an overlay must be written under the exact field name its CONSUMER reads, not just any field the overlay's own output happens to include — a healed verdict written to the wrong key is silently discarded by a `??` fallback that never fires, and the screen keeps showing the stale snapshot forever. Test the consumer's actual rendered output, not just the overlay's output shape.
- Adding a sixth coverage-consuming surface means fetching the same shape of query, passing `coverage={coverageStateOf(...)}` (never a hard-coded `"ready"`), and letting the drift test (`coverageWiring.test.ts`) fail the PR if either rule is skipped.

## Gotchas

- Arriving at the browser is not the same as being read — check that the field the RENDERER reads actually changes when new data lands, not just that the network response looks right.
- A `??`/nullish-fallback pattern is exactly how a correctly-computed value can be silently ignored — if the "default" side of the fallback is never actually null in practice, the "override" side never runs.

## Where the code is

- `frontend/src/components/coverage-state.tsx` — the three states, `coverageStateOf`.
- `frontend/src/components/coverageWiring.test.ts` — the drift test enforcing the wiring rules.
- `frontend/src/pages/scm-v2/PurchaseOrdersListV2.tsx`, `GoodsReceivedListV2.tsx`, `PurchaseInvoicesListV2.tsx`, `MfgSalesOrdersListV2.tsx`, `SalesOrderDetailV2.tsx` — the five current second-query surfaces.
