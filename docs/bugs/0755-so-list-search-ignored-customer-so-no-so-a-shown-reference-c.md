## SO list search ignored customer_so_no, so a shown reference could not be found [medium]

**Symptom.** Owner, on two Sales Orders that both display reference `PG10213`
(same customer, SHARON TEOH): *"search - PG10213 时候只显示 HC-SO-010741,但是
search 客户名字时候会有两张单"* — searching the reference `PG10213` returned only
`HC-SO-010741`, but searching the customer name returned both `HC-SO-010741` and
`HC-SO-2609-017`. Both rows print `PG10213` in the REFERENCE column, so one of
them was findable by its reference and the other was not.

**Root cause (traced).** The SO list REFERENCE column displays `customerRefOf`
= `ref || customer_so_no || po_doc_no` (`frontend/src/lib/customer-ref.ts`), but
the server-side list search (`mfgSalesOrders.get('/')`, paginated branch in
`backend/src/scm/routes/mfg-sales-orders.ts`) built its `.or()` over
`doc_no / debtor_name / debtor_code / agent / sales_location / ref / branding`
+ phone — `ref` was the ONLY reference field it covered. Confirmed against the
live company DB (`anogrigyjbduyzclzjgn`, the prod Hyperdrive target):

| doc_no | ref | customer_so_no |
|---|---|---|
| HC-SO-2609-017 (created 2026-09-09, native) | `NULL` | `PG10213` |
| HC-SO-010741 (migrated) | `PG10213` | `PG10213` |

The migrated order carries `PG10213` in `ref`, so it matched. The native order's
reference lives only in `customer_so_no` (the New-SO create path left `ref`
null), which the search never touched — so its REFERENCE cell rendered `PG10213`
from the `customer_so_no` fallback yet the search could not find it. The
2026-08-18 `customer-ref` audit had treated `customer_so_no` as a mere
near-duplicate of `ref`; a native create path writing `customer_so_no` with
`ref` null made it load-bearing after that audit. Measured on prod: **21**
non-cancelled orders have a blank `ref` but a populated `customer_so_no` — every
one shows a reference it cannot be searched by.

**Fix.** Add `customer_so_no.ilike.%<term>%` to the list search `.or()` — in
BOTH the page-rows query and the money-aggregate query, which must filter the
same set or the KPI tiles disagree with the rows. `po_doc_no` is deliberately
NOT added: it is a 0%-filled dead column not even projected onto this list (and
absent from the prod view). Proved on the live DB before/after: with `ref` only,
`HC-SO-2609-017` did not match `PG10213`; with `ref` OR `customer_so_no` it does,
and `HC-SO-010741` still does. No test pins the inline `.or()` (it is built
against the live PostgREST client, not a pure function); the reason
`customer_so_no` must be searched is written beside the clause so the next author
does not trim it back to `ref`.

**Ref.** fix/so-list-search-customer-so-no-0909, 2026-09-09.
